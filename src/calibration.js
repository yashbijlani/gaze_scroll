// Click-through N-point calibration flow. Each target: user looks at the dot
// and clicks it; the point is recorded as a labelled sample for WebGazer's
// regression via tracker.record(). Implicit click/move calibration stays on.
export class CalibrationFlow {
  constructor(tracker, cfg, layerEl) {
    this.tracker = tracker;
    this.cfg = cfg;
    this.layer = layerEl;
    this.running = false;
  }

  positions() {
    const m = this.cfg.gridMargin ?? 0.1;
    const xs = [m, 0.5, 1 - m].map((f) => Math.round(f * window.innerWidth));
    const ys = [m, 0.5, 1 - m].map((f) => Math.round(f * window.innerHeight));
    if ((this.cfg.points ?? 9) === 5) {
      return [
        [xs[0], ys[0]],
        [xs[2], ys[0]],
        [xs[1], ys[1]],
        [xs[0], ys[2]],
        [xs[2], ys[2]],
      ];
    }
    const pts = [];
    for (const y of ys) for (const x of xs) pts.push([x, y]);
    return pts;
  }

  async start(onProgress) {
    if (this.running) return 0;
    this.running = true;
    const pts = this.positions();
    this.layer.hidden = false;
    let done = 0;
    for (const [x, y] of pts) {
      // eslint-disable-next-line no-await-in-loop
      await this.#present(x, y, done + 1, pts.length);
      done += 1;
      if (onProgress) onProgress(done, pts.length);
    }
    this.layer.innerHTML = '';
    this.layer.hidden = true;
    this.running = false;
    return done;
  }

  #present(x, y, i, n) {
    return new Promise((resolve) => {
      this.layer.innerHTML =
        `<div class="cal-hint">Look at the dot and click it (${i}/${n})</div>` +
        `<button class="cal-target" style="left:${x}px;top:${y}px" ` +
        `aria-label="calibration point ${i} of ${n}"></button>`;
      const target = this.layer.querySelector('.cal-target');
      target.focus();
      target.addEventListener(
        'click',
        (e) => {
          e.stopPropagation();
          this.tracker.record(x, y);
          resolve();
        },
        { once: true },
      );
    });
  }

  cancel() {
    this.layer.innerHTML = '';
    this.layer.hidden = true;
    this.running = false;
  }
}
