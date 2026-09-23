// GazeMapper: features → screen coordinates, with selectable model family.
//
// The previous estimator used a single global linear ridge over raw eye
// patches. That is underdetermined (391 dims, ~45 calibration samples) and
// cannot express the eye-rotation × head-pose × distance interactions that
// dominate webcam error. This module provides, behind one interface:
//
//   'affine'  — linear + bias (ridge-regularized). Cheap baseline.
//   'poly2'   — full second-order polynomial (squares + pairwise products).
//               Captures the interactions; still a linear solve, no GPU.
//   'mlp'     — tiny MLP (input → 16 → 8 → 2), trained with Adam on CPU.
//               ~500 parameters; a few hundred epochs on calibration data.
//
// Shared machinery: feature standardization, sample weights, L2
// regularization, lazy refit, and an uncertainty estimate (residual RMS ×
// novelty distance) used by the confidence model and safe-region gating.
//
// Everything is pure JS with plain arrays — no dependencies, no TF.js.
// Numerics are deterministic (seeded RNG) and unit-tested.

import { solveRidge } from './ridge.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Per-dimension standardization with a variance floor and z-clipping.
//
// The floor matters: head-pose channels can be almost constant during a
// still calibration, giving a near-zero std. Without a floor, a tiny
// head movement at run time becomes a huge z-score and the linear model
// extrapolates wildly. The floor + clip bound that, so unmodelled head
// movement degrades gracefully instead of exploding.
export class FeatureScaler {
  constructor({ floor = 0.02, clipZ = 10 } = {}) {
    this.mean = null;
    this.std = null;
    this.floor = floor;
    this.clipZ = clipZ;
  }

  fit(rows) {
    if (!rows.length) return this;
    const d = rows[0].length;
    const mean = new Array(d).fill(0);
    for (const r of rows) for (let i = 0; i < d; i++) mean[i] += r[i];
    for (let i = 0; i < d; i++) mean[i] /= rows.length;
    const std = new Array(d).fill(0);
    for (const r of rows) for (let i = 0; i < d; i++) std[i] += (r[i] - mean[i]) ** 2;
    for (let i = 0; i < d; i++) {
      std[i] = Math.max(Math.sqrt(std[i] / rows.length), this.floor);
    }
    this.mean = mean;
    this.std = std;
    return this;
  }

  transform(row) {
    if (!this.mean) return row.slice();
    const z = new Array(row.length);
    for (let i = 0; i < row.length; i++) {
      const v = (row[i] - this.mean[i]) / this.std[i];
      z[i] = Math.max(-this.clipZ, Math.min(this.clipZ, v));
    }
    return z;
  }

  toJSON() {
    return { mean: this.mean, std: this.std };
  }

  static fromJSON(j) {
    const s = new FeatureScaler();
    s.mean = j?.mean ?? null;
    s.std = j?.std ?? null;
    return s;
  }
}

// Expand a standardized feature row into the model's design vector.
export function designVector(z, model) {
  if (model === 'poly2') {
    const out = [1, ...z];
    for (let i = 0; i < z.length; i++) {
      for (let j = i; j < z.length; j++) out.push(z[i] * z[j]);
    }
    return out;
  }
  return [1, ...z]; // affine / ridge
}

// Weighted ridge via normal equations. rows: design vectors, targets, weights.
// The bias term (index 0) is NOT regularized — penalizing it would shrink
// predictions toward zero as lambda grows instead of toward the target mean.
function solveWeightedRidge(rows, targets, weights, lambda, { regularizeBias = false } = {}) {
  const n = rows.length;
  if (n === 0) return null;
  const d = rows[0].length;
  const A = Array.from({ length: d }, () => new Float64Array(d));
  const b = new Float64Array(d);
  for (let i = 0; i < n; i++) {
    const w = weights ? weights[i] : 1;
    if (!Number.isFinite(w) || w <= 0) continue;
    const row = rows[i];
    const t = targets[i] * w;
    for (let a = 0; a < d; a++) {
      b[a] += row[a] * t;
      const ra = row[a] * w;
      for (let c = a; c < d; c++) A[a][c] += ra * row[c];
    }
  }
  for (let a = 0; a < d; a++) {
    for (let c = 0; c < a; c++) A[a][c] = A[c][a];
    if (regularizeBias || a > 0) A[a][a] += lambda;
  }
  // Gaussian elimination with partial pivoting.
  const M = Array.from({ length: d }, (_, i) => {
    const r = new Float64Array(d + 1);
    r.set(A[i]);
    r[d] = b[i];
    return r;
  });
  for (let col = 0; col < d; col++) {
    let piv = col;
    for (let r = col + 1; r < d; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    const tmp = M[col];
    M[col] = M[piv];
    M[piv] = tmp;
    for (let r = 0; r < d; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= d; c++) M[r][c] -= f * M[col][c];
    }
  }
  const w = new Array(d);
  for (let i = 0; i < d; i++) w[i] = M[i][d] / M[i][i];
  return w;
}

function dot(w, x) {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i] * x[i];
  return s;
}

// Tiny fully-connected MLP, tanh hidden / linear output, Adam optimizer.
class TinyMLP {
  constructor(inputDim, hidden = [16, 8], seed = 1337) {
    this.sizes = [inputDim, ...hidden, 2];
    this.rand = mulberry32(seed);
    this.W = [];
    this.b = [];
    for (let l = 0; l < this.sizes.length - 1; l++) {
      const fanIn = this.sizes[l];
      const fanOut = this.sizes[l + 1];
      const scale = Math.sqrt(2 / fanIn);
      const W = [];
      for (let o = 0; o < fanOut; o++) {
        const row = new Array(fanIn);
        for (let i = 0; i < fanIn; i++) row[i] = (this.rand() * 2 - 1) * scale;
        W.push(row);
      }
      this.W.push(W);
      this.b.push(new Array(fanOut).fill(0));
    }
  }

  forward(x) {
    let a = x;
    this._cache = [];
    for (let l = 0; l < this.W.length; l++) {
      const W = this.W[l];
      const b = this.b[l];
      const isLast = l === this.W.length - 1;
      const out = new Array(W.length);
      for (let o = 0; o < W.length; o++) {
        let s = b[o];
        const row = W[o];
        for (let i = 0; i < row.length; i++) s += row[i] * a[i];
        out[o] = isLast ? s : Math.tanh(s);
      }
      this._cache.push({ a, out });
      a = out;
    }
    return a;
  }

  train(rows, targets, { epochs = 300, lr = 0.03, l2 = 1e-4 } = {}) {
    const n = rows.length;
    if (n === 0) return;
    const mW = this.W.map((M) => M.map((r) => r.map(() => 0)));
    const vW = this.W.map((M) => M.map((r) => r.map(() => 0)));
    const mb = this.b.map((r) => r.map(() => 0));
    const vb = this.b.map((r) => r.map(() => 0));
    const beta1 = 0.9;
    const beta2 = 0.999;
    const eps = 1e-8;
    let step = 0;
    for (let epoch = 0; epoch < epochs; epoch++) {
      for (let s = 0; s < n; s++) {
        const y = this.forward(rows[s]);
        const t = targets[s];
        // Output-layer delta (linear output, MSE).
        let deltas = [y[0] - t[0], y[1] - t[1]];
        const gradsW = new Array(this.W.length);
        const gradsb = new Array(this.b.length);
        for (let l = this.W.length - 1; l >= 0; l--) {
          const { a, out } = this._cache[l];
          gradsW[l] = this.W[l].map((row, o) => row.map((_, i) => deltas[o] * a[i]));
          gradsb[l] = deltas.slice();
          if (l > 0) {
            const prev = new Array(a.length).fill(0);
            for (let o = 0; o < this.W[l].length; o++) {
              for (let i = 0; i < a.length; i++) prev[i] += deltas[o] * this.W[l][o][i];
            }
            // tanh' = 1 - out^2 on the previous layer's activations.
            const prevOut = this._cache[l - 1].out;
            deltas = prev.map((v, i) => v * (1 - prevOut[i] * prevOut[i]));
          }
        }
        step++;
        const b1t = 1 - beta1 ** step;
        const b2t = 1 - beta2 ** step;
        for (let l = 0; l < this.W.length; l++) {
          for (let o = 0; o < this.W[l].length; o++) {
            for (let i = 0; i < this.W[l][o].length; i++) {
              const g = gradsW[l][o][i] + l2 * this.W[l][o][i];
              mW[l][o][i] = beta1 * mW[l][o][i] + (1 - beta1) * g;
              vW[l][o][i] = beta2 * vW[l][o][i] + (1 - beta2) * g * g;
              this.W[l][o][i] -= (lr * (mW[l][o][i] / b1t)) / (Math.sqrt(vW[l][o][i] / b2t) + eps);
            }
            const gb = gradsb[l][o];
            mb[l][o] = beta1 * mb[l][o] + (1 - beta1) * gb;
            vb[l][o] = beta2 * vb[l][o] + (1 - beta2) * gb * gb;
            this.b[l][o] -= (lr * (mb[l][o] / b1t)) / (Math.sqrt(vb[l][o] / b2t) + eps);
          }
        }
      }
    }
  }

  toJSON() {
    return { sizes: this.sizes, W: this.W, b: this.b };
  }

  static fromJSON(j) {
    const m = Object.create(TinyMLP.prototype);
    m.sizes = j.sizes;
    m.W = j.W;
    m.b = j.b;
    m.rand = mulberry32(1);
    return m;
  }
}

export class GazeMapper {
  constructor({
    model = 'poly2',
    lambda = 1.0,
    standardize = true,
    hidden = [16, 8],
    mlpEpochs = 300,
    mlpLr = 0.03,
    seed = 1337,
    stdFloor = 0.02,
    clipZ = 3,
  } = {}) {
    this.model = model;
    this.lambda = lambda;
    this.standardize = standardize;
    this.hidden = hidden;
    this.mlpEpochs = mlpEpochs;
    this.mlpLr = mlpLr;
    this.seed = seed;
    this.stdFloor = stdFloor;
    this.clipZ = clipZ;
    this.scaler = new FeatureScaler({ floor: stdFloor, clipZ });
    this.samples = []; // { f, x, y, w }
    this.wx = null;
    this.wy = null;
    this.mlp = null;
    this.dirty = false;
    this.residualRms = null;
    this.tyMean = null;
    this.tyStd = null;
    this._centroid = null;
    this._centroidStd = null;
  }

  get count() {
    return this.samples.length;
  }

  get trained() {
    return !!(this.trainedInternal && !this.dirty);
  }

  get trainedInternal() {
    return this.model === 'mlp' ? !!this.mlp : !!(this.wx && this.wy);
  }

  addSample(features, x, y, weight = 1) {
    if (!Array.isArray(features) || features.length === 0) return false;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (this.samples.length > 0 && features.length !== this.samples[0].f.length) return false;
    if (this.samples.length >= 4000) this.samples.shift();
    this.samples.push({ f: features.slice(), x, y, w: Number.isFinite(weight) && weight > 0 ? weight : 1 });
    this.dirty = true;
    return true;
  }

  clear() {
    this.samples = [];
    this.wx = null;
    this.wy = null;
    this.mlp = null;
    this.dirty = false;
    this.residualRms = null;
    this.scaler = new FeatureScaler({ floor: this.stdFloor, clipZ: this.clipZ });
    this.tyMean = null;
    this.tyStd = null;
    this._centroid = null;
    this._centroidStd = null;
  }

  // Lazy refit. Returns { rms, n } or null when untrainable.
  fit() {
    if (!this.dirty && this.trainedInternal) return { rms: this.residualRms, n: this.count };
    if (this.samples.length < 2) return null;
    const rows = this.samples.map((s) => s.f);
    const weights = this.samples.map((s) => s.w);
    const tx = this.samples.map((s) => s.x);
    const ty = this.samples.map((s) => s.y);

    if (this.standardize) this.scaler.fit(rows);
    const z = rows.map((r) => this.scaler.transform(r));

    if (this.model === 'mlp') {
      this.mlp = new TinyMLP(z[0].length, this.hidden, this.seed);
      // Standardize targets: pixel-scale outputs otherwise dominate the
      // output-layer gradients and the net barely learns.
      const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
      const std = (a, m) => Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length) || 1;
      this.tyMean = [mean(tx), mean(ty)];
      this.tyStd = [std(tx, this.tyMean[0]), std(ty, this.tyMean[1])];
      const targets = z.map((_, i) => [
        (tx[i] - this.tyMean[0]) / this.tyStd[0],
        (ty[i] - this.tyMean[1]) / this.tyStd[1],
      ]);
      this.mlp.train(z, targets, { epochs: this.mlpEpochs, lr: this.mlpLr });
      this.wx = null;
      this.wy = null;
    } else {
      const X = z.map((r) => designVector(r, this.model));
      this.wx = solveWeightedRidge(X, tx, weights, this.lambda);
      this.wy = solveWeightedRidge(X, ty, weights, this.lambda);
      this.mlp = null;
      if (!this.wx || !this.wy) {
        this.dirty = false;
        return null;
      }
    }
    this.dirty = false;
    this.residualRms = this.#computeResidualRms();
    this.#computeCentroid(z);
    return { rms: this.residualRms, n: this.count };
  }

  #computeCentroid(z) {
    const d = z[0].length;
    const c = new Array(d).fill(0);
    for (const r of z) for (let i = 0; i < d; i++) c[i] += r[i];
    for (let i = 0; i < d; i++) c[i] /= z.length;
    const s = new Array(d).fill(0);
    for (const r of z) for (let i = 0; i < d; i++) s[i] += (r[i] - c[i]) ** 2;
    for (let i = 0; i < d; i++) s[i] = Math.sqrt(s[i] / z.length) || 1;
    this._centroid = c;
    this._centroidStd = s;
  }

  #computeResidualRms() {
    let se = 0;
    for (const s of this.samples) {
      const p = this.predictRaw(s.f);
      if (!p) continue;
      se += (p.x - s.x) ** 2 + (p.y - s.y) ** 2;
    }
    return Math.sqrt(se / (2 * this.samples.length));
  }

  predictRaw(features) {
    if (!this.trainedInternal) return null;
    if (this.samples.length > 0 && features.length !== this.samples[0].f.length) return null;
    const z = this.standardize ? this.scaler.transform(features) : features.slice();
    if (this.model === 'mlp') {
      const out = this.mlp.forward(z);
      const x = out[0] * this.tyStd[0] + this.tyMean[0];
      const y = out[1] * this.tyStd[1] + this.tyMean[1];
      return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    }
    const dv = designVector(z, this.model);
    const x = dot(this.wx, dv);
    const y = dot(this.wy, dv);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }

  // { x, y, sigma, novelty } or null. sigma grows with novelty so the
  // confidence model can down-weight out-of-distribution gaze.
  predict(features) {
    const fit = this.fit();
    if (!fit) return null;
    const p = this.predictRaw(features);
    if (!p) return null;
    const z = this.standardize ? this.scaler.transform(features) : features.slice();
    const novelty = this.#novelty(z);
    const sigma = (this.residualRms ?? 50) * (1 + 0.5 * novelty);
    return { x: p.x, y: p.y, sigma, novelty };
  }

  #novelty(z) {
    if (!this._centroid) return 0;
    let s = 0;
    for (let i = 0; i < z.length; i++) {
      const dz = (z[i] - this._centroid[i]) / (this._centroidStd[i] || 1);
      s += dz * dz;
    }
    return Math.sqrt(s / z.length);
  }

  toJSON() {
    return {
      version: 3,
      model: this.model,
      lambda: this.lambda,
      standardize: this.standardize,
      hidden: this.hidden,
      featDim: this.samples.length > 0 ? this.samples[0].f.length : null,
      scaler: this.scaler.toJSON(),
      samples: this.samples.map((s) => ({
        f: s.f.map((v) => Math.round(v * 1e4) / 1e4),
        x: Math.round(s.x * 10) / 10,
        y: Math.round(s.y * 10) / 10,
        w: s.w,
      })),
    };
  }

  static fromJSON(json) {
    if (!json || (json.version !== 3 && json.version !== 2) || !Array.isArray(json.samples)) {
      throw new Error('not a gaze-mapper payload');
    }
    const m = new GazeMapper({
      model: json.model ?? 'affine',
      lambda: json.lambda ?? 1.0,
      standardize: json.standardize ?? true,
      hidden: json.hidden ?? [16, 8],
    });
    for (const s of json.samples) {
      if (!Array.isArray(s.f)) continue;
      if (json.featDim != null && s.f.length !== json.featDim) continue;
      if (m.samples.length > 0 && s.f.length !== m.samples[0].f.length) continue;
      if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
      m.samples.push({ f: s.f.slice(), x: s.x, y: s.y, w: s.w ?? 1 });
    }
    m.dirty = m.samples.length > 0;
    if (json.scaler) m.scaler = FeatureScaler.fromJSON(json.scaler);
    return m;
  }
}
