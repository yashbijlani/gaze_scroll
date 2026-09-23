// Temporal filter suite for gaze signals, behind one interface.
//
//   ema      — exponential moving average (fixed lag, dead simple)
//   oneeuro  — One Euro adaptive low-pass (low lag when moving)
//   kalman   — constant-velocity Kalman (smooth + predictive, more compute)
//
// Each filter exposes filter(x, y, tMs) -> {x, y} and reset(). The
// benchmark (bench/run.js) measures jitter vs. step-response latency for
// every filter on identical data, because "smoothest" is not the goal —
// stable-at-rest AND responsive-when-moving is.

import { OneEuroFilter } from '../smoothing.js';

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export class EMA2D {
  constructor({ alpha = 0.3 } = {}) {
    this.alpha = alpha;
    this.reset();
  }

  reset() {
    this.x = null;
    this.y = null;
  }

  filter(x, y) {
    if (this.x == null) {
      this.x = x;
      this.y = y;
    } else {
      this.x = this.alpha * x + (1 - this.alpha) * this.x;
      this.y = this.alpha * y + (1 - this.alpha) * this.y;
    }
    return { x: this.x, y: this.y };
  }
}

export class OneEuro2D {
  constructor({ minCutoff = 1.0, beta = 0.3, dCutoff = 1.0 } = {}) {
    this.opts = { minCutoff, beta, dCutoff };
    this.reset();
  }

  reset() {
    this.fx = new OneEuroFilter(this.opts.minCutoff, this.opts.beta, this.opts.dCutoff);
    this.fy = new OneEuroFilter(this.opts.minCutoff, this.opts.beta, this.opts.dCutoff);
  }

  filter(x, y, t) {
    return { x: this.fx.filter(x, t), y: this.fy.filter(y, t) };
  }
}

// Scalar constant-velocity Kalman filter.
export class KalmanAxis {
  constructor({ processNoise = 40, measurementNoise = 120 } = {}) {
    this.q = processNoise;
    this.r = measurementNoise;
    this.reset();
  }

  reset() {
    this.pos = null;
    this.vel = 0;
    this.p00 = 1000;
    this.p01 = 0;
    this.p11 = 1000;
    this.lastT = null;
  }

  update(z, t) {
    if (this.pos == null || this.lastT == null) {
      this.pos = z;
      this.vel = 0;
      this.lastT = t;
      return this.pos;
    }
    const dt = clamp((t - this.lastT) / 1000, 1e-3, 0.25);
    this.lastT = t;
    // Predict: pos += vel*dt.
    this.pos += this.vel * dt;
    const q = this.q;
    this.p00 += dt * (2 * this.p01 + dt * this.p11) + q * dt;
    this.p01 += dt * this.p11;
    this.p11 += q * dt;
    // Update.
    const s = this.p00 + this.r;
    const k0 = this.p00 / s;
    const k1 = this.p01 / s;
    const y = z - this.pos;
    this.pos += k0 * y;
    this.vel += k1 * y;
    const p00 = this.p00;
    const p01 = this.p01;
    this.p00 = (1 - k0) * p00;
    this.p01 = (1 - k0) * p01;
    this.p11 = this.p11 - k1 * p01;
    return this.pos;
  }
}

export class Kalman2D {
  constructor(opts = {}) {
    this.opts = opts;
    this.reset();
  }

  reset() {
    this.kx = new KalmanAxis(this.opts);
    this.ky = new KalmanAxis(this.opts);
  }

  filter(x, y, t) {
    return { x: this.kx.update(x, t), y: this.ky.update(y, t) };
  }
}

export function createFilter(kind, opts = {}) {
  switch (kind) {
    case 'none':
      return { filter: (x, y) => ({ x, y }), reset() {} };
    case 'ema':
      return new EMA2D(opts);
    case 'kalman':
      return new Kalman2D(opts);
    case 'oneeuro':
    default:
      return new OneEuro2D(opts);
  }
}

// --- Metric helpers (used by the benchmark) ---

// RMS of first differences: a simple, scale-relative jitter measure.
export function firstDifferenceRms(values) {
  if (values.length < 2) return 0;
  let s = 0;
  for (let i = 1; i < values.length; i++) s += (values[i] - values[i - 1]) ** 2;
  return Math.sqrt(s / (values.length - 1));
}

// Fraction of a step reached after N samples of a fixed step input.
export function stepResponse(filter, { step = 300, samples = 30, dtMs = 33 } = {}) {
  filter.reset();
  let out = 0;
  for (let i = 0; i < samples; i++) {
    const r = filter.filter(i === 0 ? 0 : step, i === 0 ? 0 : 0, i * dtMs);
    out = r.x;
  }
  return out / step; // ~1 = fully tracked the step within the window
}

// Time (ms) to reach 90% of a step, capped at maxMs.
export function stepLatencyMs(filter, { step = 300, dtMs = 33, maxMs = 1500 } = {}) {
  filter.reset();
  const n = Math.ceil(maxMs / dtMs);
  for (let i = 0; i < n; i++) {
    const r = filter.filter(i === 0 ? 0 : step, 0, i * dtMs);
    if (r.x >= 0.9 * step) return i * dtMs;
  }
  return maxMs;
}
