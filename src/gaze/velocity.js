// VelocityTracker: per-sample speed / direction from filtered gaze points.
//
// Webcam gaze is jittery (~100px noise), so raw finite differences are
// spiky. We EMA-smooth the velocity vector itself: responsive enough to
// catch intentional drifts (~200-600 px/s) while ignoring single-sample
// jumps. Direction persistence (fraction of recent samples agreeing on the
// vertical sign) is the key anti-jitter signal for the intent engine.

export class VelocityTracker {
  constructor({
    emaAlpha = 0.35,
    minDtMs = 8,
    maxDtMs = 250,
    persistenceWindow = 8,
  } = {}) {
    this.emaAlpha = emaAlpha;
    this.minDtMs = minDtMs;
    this.maxDtMs = maxDtMs;
    this.persistenceWindow = persistenceWindow;
    this.reset();
  }

  reset() {
    this.prevX = null;
    this.prevY = null;
    this.prevT = null;
    this.vx = 0;
    this.vy = 0;
    this.speed = 0;
    this.signHistory = []; // recent Math.sign(vy) values (+1/-1/0)
  }

  // Returns { vx, vy, speed, dirX, dirY, persistence } — all EMA-smoothed
  // except persistence, which is computed over the sign history window.
  // Null positions (tracking loss) decay the velocity toward zero.
  add(x, y, t) {
    if (x == null || y == null) {
      this.vx *= 1 - this.emaAlpha;
      this.vy *= 1 - this.emaAlpha;
      this.speed = Math.hypot(this.vx, this.vy);
      this.prevX = null;
      this.prevY = null;
      this.prevT = t;
      return this.snapshot();
    }
    if (this.prevX == null || this.prevT == null || t - this.prevT < this.minDtMs) {
      if (this.prevX == null) {
        this.prevX = x;
        this.prevY = y;
        this.prevT = t;
      }
      return this.snapshot();
    }
    let dtMs = t - this.prevT;
    if (dtMs > this.maxDtMs) {
      // Long gap (tab switch, model stall): don't synthesize a huge fling.
      this.prevX = x;
      this.prevY = y;
      this.prevT = t;
      this.vx = 0;
      this.vy = 0;
      this.speed = 0;
      return this.snapshot();
    }
    const dtS = dtMs / 1000;
    const ivx = (x - this.prevX) / dtS;
    const ivy = (y - this.prevY) / dtS;
    const a = this.emaAlpha;
    this.vx = a * ivx + (1 - a) * this.vx;
    this.vy = a * ivy + (1 - a) * this.vy;
    this.speed = Math.hypot(this.vx, this.vy);
    this.prevX = x;
    this.prevY = y;
    this.prevT = t;

    const s = this.vy > 25 ? 1 : this.vy < -25 ? -1 : 0; // deadband vs jitter
    this.signHistory.push(s);
    if (this.signHistory.length > this.persistenceWindow) this.signHistory.shift();
    return this.snapshot();
  }

  snapshot() {
    const mag = Math.hypot(this.vx, this.vy) || 1;
    return {
      vx: this.vx,
      vy: this.vy,
      speed: this.speed,
      dirX: this.vx / mag,
      dirY: this.vy / mag,
      persistence: this.persistence(),
    };
  }

  // 0..1: fraction of the recent window agreeing with the dominant vertical
  // direction. 1 = sustained drift, ~0.5 = oscillation/noise.
  persistence() {
    if (this.signHistory.length === 0) return 0;
    const plus = this.signHistory.filter((s) => s === 1).length;
    const minus = this.signHistory.filter((s) => s === -1).length;
    return Math.max(plus, minus) / this.signHistory.length;
  }

  dominantVertical() {
    if (this.signHistory.length === 0) return 0;
    const plus = this.signHistory.filter((s) => s === 1).length;
    const minus = this.signHistory.filter((s) => s === -1).length;
    if (plus === minus) return 0;
    return plus > minus ? 1 : -1;
  }
}
