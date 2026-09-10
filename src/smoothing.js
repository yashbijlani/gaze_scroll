// One Euro filter (Casiez et al., CHI 2012): a first-order low-pass filter
// with an adaptive cutoff. Low speed -> low cutoff (kills jitter); high
// speed -> high cutoff (kills lag). Ideal for noisy gaze cursors.
export class OneEuroFilter {
  constructor(minCutoff = 1.0, beta = 0.0, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() {
    this.xPrev = null;
    this.dxPrev = 0;
    this.lastT = null;
  }

  static alpha(dtSeconds, cutoff) {
    const tau = 1.0 / (2.0 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / dtSeconds);
  }

  filter(x, tMs) {
    if (this.xPrev === null || this.lastT === null || tMs <= this.lastT) {
      this.xPrev = x;
      this.lastT = tMs;
      this.dxPrev = 0;
      return x;
    }
    const dt = Math.max((tMs - this.lastT) / 1000, 1e-3);
    const dAlpha = OneEuroFilter.alpha(dt, this.dCutoff);
    const dx = (x - this.xPrev) / dt;
    const dxHat = dAlpha * dx + (1 - dAlpha) * this.dxPrev;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = OneEuroFilter.alpha(dt, cutoff);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    this.dxPrev = dxHat;
    this.lastT = tMs;
    return xHat;
  }
}

// Independent One Euro filters per screen axis.
export class GazeSmoother {
  constructor({ minCutoff = 1.0, beta = 0.3, dCutoff = 1.0 } = {}) {
    this.fx = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.fy = new OneEuroFilter(minCutoff, beta, dCutoff);
  }

  filter(x, y, tMs) {
    return { x: this.fx.filter(x, tMs), y: this.fy.filter(y, tMs) };
  }

  reset() {
    this.fx.reset();
    this.fy.reset();
  }
}
