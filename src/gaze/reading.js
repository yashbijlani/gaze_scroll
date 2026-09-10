// ReadingTracker: "is the user actually reading?" from gaze + DOM geometry.
//
// Signals:
//   onText      — current gaze lands on a text role (paragraph/heading/code)
//   textBelow   — fraction of viewport below gaze that is text (room to read)
//   progressing — recent on-text fixations trend downward (reading order)
//   nearEnd     — little readable content left below (reveal more soon)
//
// The key discriminator: a downward glance at whitespace/chrome is NOT
// reading progression; fixations stepping down through text lines IS.
// Progression uses a small ring of recent fixation points, so one stray
// sample cannot fake it.

export class ReadingTracker {
  constructor({ windowSize = 10, minProgressPx = 30 } = {}) {
    this.windowSize = windowSize;
    this.minProgressPx = minProgressPx;
    this.fixations = []; // { x, y, t }
  }

  reset() {
    this.fixations = [];
  }

  // fixation: { state, x, y } from the event detector; dom: { onText }.
  // Returns the current reading snapshot (always safe defaults).
  update(fixation, dom, t) {
    if (fixation?.state === 'fixation' && Number.isFinite(fixation.x)) {
      this.fixations.push({ x: fixation.x, y: fixation.y, t });
      if (this.fixations.length > this.windowSize) this.fixations.shift();
    }
    return this.snapshot(dom);
  }

  snapshot(dom = {}) {
    const onText = !!dom.onText;
    const textBelow = dom.textBelow ?? 0.5;
    return {
      onText,
      textBelow,
      progressing: this.#progressing(),
      nearEnd: textBelow < 0.2 && onText,
      revealSoon: textBelow < 0.35 && onText,
    };
  }

  #progressing() {
    const f = this.fixations;
    if (f.length < 3) return false;
    // Net downward movement with bounded horizontal wandering: reading,
    // not scanning. Require monotonic-ish trend, not strict monotonicity
    // (regressions — re-reading a line — are normal).
    const dy = f[f.length - 1].y - f[0].y;
    if (dy < this.minProgressPx) return false;
    let regressions = 0;
    for (let i = 1; i < f.length; i++) {
      if (f[i].y < f[i - 1].y - 12) regressions++;
    }
    return regressions <= Math.floor(f.length / 3);
  }
}
