// Click-through N-point calibration flow with guidance + quality check.
//
// Experience: guidance card (posture, lighting, what to do) → points in a
// 5/9 grid (look at the dot, click it) → validation summary with a quality
// score → done. Skippable at any point for experimentation.
//
// Quality: after each point is clicked we take one live prediction and
// measure its distance to the target. Mean error < 120px = good,
// < 200px = fair, else poor (webcam-grade; see ALGORITHMS.md). If live
// predictions are unavailable the score reports 'unknown' instead of lying.
// State (not video, never video) persists to localStorage when configured.

export class CalibrationFlow {
  constructor(tracker, cfg, layerEl) {
    this.tracker = tracker;
    this.cfg = cfg;
    this.layer = layerEl;
    this.running = false;
    this.skipped = false;
    this.faceCheck = null; // () => bool; set by main.js (face seen recently)
    this.lastQuality = this.#load();
  }

  // Points only advance while a face is detected — otherwise WebGazer's
  // recordScreenPosition stores nothing (no eye features) and the user gets
  // a fake "complete" that trained nothing. This is the "is it doing
  // anything?" fix: the UI refuses to take a blind point.
  setFaceCheck(fn) {
    this.faceCheck = fn;
    return this;
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
    this.skipped = false;
    const ok = await this.#guidance();
    if (!ok) {
      this.#close();
      return 0;
    }
    const pts = this.positions();
    const errors = [];
    this.layer.hidden = false;
    let done = 0;
    for (const [x, y] of pts) {
      if (this.skipped) break;
      // eslint-disable-next-line no-await-in-loop
      await this.#present(x, y, done + 1, pts.length);
      if (this.skipped) break;
      done += 1;
      // Repeated taps: WebGazer's ridge regression benefits from several
      // labelled samples per target, not one.
      const taps = Math.max(1, this.cfg.samplesPerPoint ?? 5);
      for (let i = 0; i < taps; i++) this.tracker.record(x, y);
      // eslint-disable-next-line no-await-in-loop
      const errPx = await this.#liveError(x, y);
      if (errPx != null) errors.push(errPx);
      if (onProgress) onProgress(done, pts.length);
    }
    const quality = this.#score(errors, done, pts.length);
    this.lastQuality = quality;
    this.#save(quality);
    await this.#summary(quality); // eslint-disable-line no-await-in-loop
    this.#close();
    return done;
  }

  skip() {
    this.skipped = true;
    // Unblock a pending #present/#guidance promise by simulating resolve.
    this.layer.querySelector('.cal-target')?.click();
    this.layer.querySelector('[data-cal-start]')?.click();
    this.layer.querySelector('[data-cal-done]')?.click();
  }

  cancel() {
    this.skipped = true;
    this.#close();
  }

  #close() {
    this.layer.innerHTML = '';
    this.layer.hidden = true;
    this.running = false;
  }

  #guidance() {
    return new Promise((resolve) => {
      this.layer.hidden = false;
      this.layer.innerHTML =
        `<div class="cal-card"><h2>Calibrate your gaze</h2>` +
        `<p>Look at each dot and click it. Keep your head still and stay at a normal reading distance.</p>` +
        `<ul><li>Sit square to the screen, face evenly lit, no strong window behind you.</li>` +
        `<li>Glasses are fine — wipe smudges and avoid reflections if you can.</li>` +
        `<li>Don't chase the cursor; just look at each dot, then click.</li></ul>` +
        `<div class="btn-row"><button data-cal-start>Start</button>` +
        `<button data-cal-skip>Skip for now</button></div></div>`;
      this.layer.querySelector('[data-cal-start]').addEventListener(
        'click',
        () => resolve(true),
        { once: true },
      );
      this.layer.querySelector('[data-cal-skip]').addEventListener(
        'click',
        () => {
          this.skipped = true;
          resolve(false);
        },
        { once: true },
      );
    });
  }

  #present(x, y, i, n) {
    return new Promise((resolve) => {
      this.layer.innerHTML =
        `<div class="cal-hint">Look at the dot and click it (${i}/${n})</div>` +
        `<div class="cal-face-warn" hidden>⚠ No face detected — move into frame and improve lighting, then click the dot.</div>` +
        `<button class="cal-target" style="left:${x}px;top:${y}px" ` +
        `aria-label="calibration point ${i} of ${n}"></button>` +
        `<button class="cal-skip" data-cal-skip-point>Skip calibration</button>`;
      const target = this.layer.querySelector('.cal-target');
      const warn = this.layer.querySelector('.cal-face-warn');
      target.focus();
      target.addEventListener(
        'click',
        (e) => {
          e.stopPropagation();
          if (this.faceCheck && !this.faceCheck()) {
            if (warn) warn.hidden = false;
            target.focus();
            return; // stay on this point until a face is visible
          }
          resolve();
        },
      );
      this.layer.querySelector('[data-cal-skip-point]').addEventListener(
        'click',
        () => {
          this.skipped = true;
          resolve();
        },
        { once: true },
      );
    });
  }

  // One live prediction vs target; null when predictions aren't available.
  async #liveError(x, y) {
    try {
      const wg = window.webgazer;
      if (!wg || typeof wg.getCurrentPrediction !== 'function') return null;
      const pred = await Promise.race([
        Promise.resolve(wg.getCurrentPrediction()),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
      ]);
      if (!pred || !Number.isFinite(pred.x) || !Number.isFinite(pred.y)) return null;
      return Math.hypot(pred.x - x, pred.y - y);
    } catch {
      return null;
    }
  }

  #score(errors, done, total) {
    if (done < total) {
      return { label: 'skipped', meanErrPx: null, points: done, at: Date.now() };
    }
    if (errors.length === 0) {
      return { label: 'unknown', meanErrPx: null, points: done, at: Date.now() };
    }
    const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
    const label = mean < 120 ? 'good' : mean < 200 ? 'fair' : 'poor';
    return { label, meanErrPx: Math.round(mean), points: done, at: Date.now() };
  }

  #summary(quality) {
    return new Promise((resolve) => {
      const detail =
        quality.meanErrPx == null
          ? 'No live predictions were available to score against.'
          : `Mean error ≈ ${quality.meanErrPx}px.`;
      const advice =
        quality.label === 'poor'
          ? 'Try better lighting, sit still, and recalibrate.'
          : quality.label === 'fair'
            ? 'Usable. Recalibrate if scrolling feels off.'
            : 'Looks good.';
      this.layer.innerHTML =
        `<div class="cal-card"><h2>Calibration ${quality.label}</h2>` +
        `<p>${detail} ${advice}</p>` +
        `<div class="btn-row"><button data-cal-done>Done</button></div></div>`;
      const done = () => resolve();
      this.layer.querySelector('[data-cal-done]').addEventListener('click', done, { once: true });
      // Auto-dismiss so replay/mouse flows can't get stuck on the card.
      setTimeout(() => {
        if (this.running) done();
      }, 8000);
    });
  }

  #save(quality) {
    try {
      if (this.cfg.persistKey) localStorage.setItem(this.cfg.persistKey, JSON.stringify(quality));
    } catch {
      /* private mode etc. — calibration still works for the session */
    }
  }

  #load() {
    try {
      if (!this.cfg.persistKey) return null;
      const raw = localStorage.getItem(this.cfg.persistKey);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
}
