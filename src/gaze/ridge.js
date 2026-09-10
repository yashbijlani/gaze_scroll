// RidgeGazeMapper: our own eye-appearance → screen regression.
//
// WebGazer's bundled regression object turned out to be a dead husk in
// practice (addData silently drops, store stays 0, predictions throw on a
// null internal canvas — see diagnostics). This replaces it with plain
// ridge regression over downsampled grayscale eye patches, no dependency:
//
//   features: 16×12 gray per eye + bias (385 dims)
//   train:    solve (XᵀX + λI) w = Xᵀt per axis (Gaussian elim, partial pivot)
//   predict:  dot product (~microseconds)
//
// Webcam-grade by design: it learns gross pupil-position structure, not
// precise gaze. All numerics are pure and unit-tested (exact recovery on
// noiseless synthetic data). Plain arrays throughout — no TF.js needed.

// Grayscale + box-downsample an eye patch to outW×outH, normalized 0..1.
// patch: { data: Uint8ClampedArray RGBA, width, height }. Pure.
export function eyeFeatures(patch, outW = 16, outH = 12) {
  const feats = new Array(outW * outH).fill(0);
  if (!patch || !patch.data || patch.width <= 0 || patch.height <= 0) return feats;
  const { data, width, height } = patch;
  for (let oy = 0; oy < outH; oy++) {
    const y0 = Math.floor((oy * height) / outH);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * height) / outH));
    for (let ox = 0; ox < outW; ox++) {
      const x0 = Math.floor((ox * width) / outW);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * width) / outW));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < Math.min(y1, height); y++) {
        for (let x = x0; x < Math.min(x1, width); x++) {
          const i = (y * width + x) * 4;
          sum += (data[i] + data[i + 1] + data[i + 2]) / 3 / 255;
          n++;
        }
      }
      feats[oy * outW + ox] = n > 0 ? sum / n : 0;
    }
  }
  return feats;
}

export function concatEyes(leftFeats, rightFeats) {
  return [...leftFeats, ...rightFeats, 1]; // trailing bias
}

// Solve (XᵀX + λI) w = Xᵀt. X: n×d rows, t: length-n targets.
// Returns weight vector length d, or null when degenerate/empty.
export function solveRidge(rows, targets, lambda = 1.0) {
  const n = rows.length;
  if (n === 0) return null;
  const d = rows[0].length;
  if (d === 0) return null;
  // Normal equations.
  const A = Array.from({ length: d }, () => new Array(d).fill(0));
  const b = new Array(d).fill(0);
  for (let i = 0; i < n; i++) {
    const row = rows[i];
    const t = targets[i];
    if (!Number.isFinite(t)) continue;
    for (let a = 0; a < d; a++) {
      b[a] += row[a] * t;
      for (let c = a; c < d; c++) A[a][c] += row[a] * row[c];
    }
  }
  for (let a = 0; a < d; a++) {
    for (let c = 0; c < a; c++) A[a][c] = A[c][a];
    A[a][a] += lambda;
  }
  // Gaussian elimination with partial pivoting.
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < d; col++) {
    let piv = col;
    for (let r = col + 1; r < d; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < d; r++) {
      if (r === col) continue;
      const f = M[r][col] / M[col][col];
      if (f === 0) continue;
      for (let c = col; c <= d; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row, i) => row[d] / M[i][i]);
}

function dot(w, x) {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i] * x[i];
  return s;
}

export class RidgeGazeMapper {
  constructor({ eyeW = 16, eyeH = 12, lambda = 0.1 } = {}) {
    this.eyeW = eyeW;
    this.eyeH = eyeH;
    this.lambda = lambda;
    this.samples = []; // { feats, x, y }
    this.wx = null;
    this.wy = null;
    this.dirty = false;
  }

  get count() {
    return this.samples.length;
  }

  get trained() {
    return !!(this.wx && this.wy && !this.dirty);
  }

  addSample(leftPatch, rightPatch, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    return this.addFeatureSample(
      concatEyes(
        eyeFeatures(leftPatch, this.eyeW, this.eyeH),
        eyeFeatures(rightPatch, this.eyeW, this.eyeH),
      ),
      x,
      y,
    );
  }

  // Direct feature-vector write (provider appends head-pose features).
  addFeatureSample(feats, x, y) {
    if (!Array.isArray(feats) || feats.length === 0) return false;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (this.samples.length > 0 && feats.length !== this.samples[0].feats.length) return false;
    this.samples.push({ feats: feats.slice(), x, y });
    if (this.samples.length > 2000) this.samples.shift();
    this.dirty = true;
    return true;
  }

  ensureTrained() {
    if (!this.dirty || this.samples.length === 0) return this.trained;
    const rows = this.samples.map((s) => s.feats);
    this.wx = solveRidge(rows, this.samples.map((s) => s.x), this.lambda);
    this.wy = solveRidge(rows, this.samples.map((s) => s.y), this.lambda);
    this.dirty = false;
    return !!(this.wx && this.wy);
  }

  // { x, y } or null when untrained/degenerate.
  predict(leftPatch, rightPatch) {
    return this.predictFeats(
      concatEyes(
        eyeFeatures(leftPatch, this.eyeW, this.eyeH),
        eyeFeatures(rightPatch, this.eyeW, this.eyeH),
      ),
    );
  }

  // Predict from a prebuilt feature vector (e.g. eyes + head pose).
  predictFeats(feats) {
    if (!this.ensureTrained()) return null;
    if (!Array.isArray(feats) || this.samples.length === 0) return null;
    if (feats.length !== this.samples[0].feats.length) return null;
    const x = dot(this.wx, feats);
    const y = dot(this.wy, feats);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  }

  clear() {
    this.samples = [];
    this.wx = null;
    this.wy = null;
    this.dirty = false;
  }

  // Persist/restore the learned mapping (features + targets, not images).
  // v2: feature vectors may include head-pose terms, so featDim is stored
  // explicitly; v1 payloads (eye-only dims) are rejected → one
  // recalibration after upgrade. Floats rounded to 4dp (~150KB/session).
  toJSON() {
    return {
      version: 2,
      eyeW: this.eyeW,
      eyeH: this.eyeH,
      lambda: this.lambda,
      featDim: this.samples.length > 0 ? this.samples[0].feats.length : null,
      samples: this.samples.map((s) => ({
        f: s.feats.map((v) => Math.round(v * 1e4) / 1e4),
        x: Math.round(s.x * 10) / 10,
        y: Math.round(s.y * 10) / 10,
      })),
    };
  }

  static fromJSON(json) {
    if (!json || json.version !== 2 || !Array.isArray(json.samples)) {
      throw new Error('not a ridge-mapper v2 payload');
    }
    const m = new RidgeGazeMapper({ eyeW: json.eyeW ?? 16, eyeH: json.eyeH ?? 12, lambda: json.lambda ?? 0.1 });
    for (const s of json.samples) {
      if (!Array.isArray(s.f)) continue;
      if (json.featDim != null && s.f.length !== json.featDim) continue;
      if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
      if (m.samples.length > 0 && s.f.length !== m.samples[0].feats.length) continue;
      m.samples.push({ feats: s.f.slice(), x: s.x, y: s.y });
    }
    m.dirty = m.samples.length > 0;
    return m;
  }
}

// Median feature vector over candidates (robust center for outlier drop).
export function medianFeatures(list) {
  if (list.length === 0) return null;
  const d = list[0].length;
  const med = new Array(d);
  for (let i = 0; i < d; i++) {
    const col = list.map((v) => v[i]).sort((a, b) => a - b);
    med[i] = col[Math.floor(col.length / 2)];
  }
  return med;
}

export function l1dist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s;
}
