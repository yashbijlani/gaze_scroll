// Dispersion-threshold (I-DT) fixation detector, adapted for low-rate,
// noisy webcam gaze: a rolling window of recent samples is a fixation while
// its spatial spread (bbox width + height) stays under the threshold for at
// least minDurationMs. Anything else is reported as a saccade.
export class FixationDetector {
  constructor({ windowMs = 200, dispersionThresholdPx = 40, minDurationMs = 120 } = {}) {
    this.windowMs = windowMs;
    this.dispersionThresholdPx = dispersionThresholdPx;
    this.minDurationMs = minDurationMs;
    this.bufferMs = Math.max(windowMs, minDurationMs);
    this.reset();
  }

  reset() {
    this.samples = [];
    this.state = 'unknown'; // 'unknown' | 'fixation' | 'saccade'
    this.candidateStart = null;
    this.fixationStart = null;
    this.fixationPoint = null;
  }

  add(x, y, t) {
    this.samples.push({ x, y, t });
    const keepFrom = t - this.bufferMs;
    while (this.samples.length > 0 && this.samples[0].t < keepFrom) {
      this.samples.shift();
    }

    const windowFrom = t - this.windowMs;
    const win = this.samples.filter((s) => s.t >= windowFrom);

    let dispersion = 0;
    let cx = x;
    let cy = y;
    if (win.length >= 2) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      let sx = 0;
      let sy = 0;
      for (const s of win) {
        if (s.x < minX) minX = s.x;
        if (s.x > maxX) maxX = s.x;
        if (s.y < minY) minY = s.y;
        if (s.y > maxY) maxY = s.y;
        sx += s.x;
        sy += s.y;
      }
      dispersion = maxX - minX + (maxY - minY);
      cx = sx / win.length;
      cy = sy / win.length;
    } else if (win.length === 1) {
      cx = win[0].x;
      cy = win[0].y;
    }

    const stable = dispersion <= this.dispersionThresholdPx;

    if (stable) {
      if (this.state !== 'fixation') {
        if (this.candidateStart === null) {
          this.candidateStart = win.length > 0 ? win[0].t : t;
        }
        if (t - this.candidateStart >= this.minDurationMs) {
          this.state = 'fixation';
          this.fixationStart = this.candidateStart;
        }
      }
      if (this.state === 'fixation') {
        this.fixationPoint = { x: cx, y: cy };
      }
    } else {
      this.state = 'saccade';
      this.candidateStart = null;
      this.fixationStart = null;
      this.fixationPoint = null;
    }

    if (this.state === 'fixation') {
      return {
        state: 'fixation',
        durationMs: Math.max(0, t - this.fixationStart),
        x: this.fixationPoint.x,
        y: this.fixationPoint.y,
      };
    }
    return {
      state: this.state === 'saccade' ? 'saccade' : 'unknown',
      durationMs: 0,
      x: cx,
      y: cy,
    };
  }
}
