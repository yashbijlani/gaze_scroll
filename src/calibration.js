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
    this.lastDetail = null; // reason string from the last record attempt
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

  // Async record hook: (x, y) => taps stored (0 = nothing recorded → the
  // point repeats instead of advancing). Defaults to the legacy
  // tracker.record fire-and-forget path.
  setRecorder(fn) {
    this.recorder = fn;
    return this;
  }

  // Async live-prediction hook for the quality score. Defaults to
  // WebGazer's getCurrentPrediction.
  setPredictor(fn) {
    this.predictor = fn;
    return this;
  }

  // () => total eye samples in the model (or null when unknowable), shown
  // in the summary so "calibrated" is always backed by a number.
  setCounter(fn) {
    this.counter = fn;
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
    let i = 0;
    while (i < pts.length) {
      if (this.skipped) break;
      const [x, y] = pts[i];
      // eslint-disable-next-line no-await-in-loop
      await this.#present(x, y, i + 1, pts.length);
      if (this.skipped) break;
      // eslint-disable-next-line no-await-in-loop
      const stored = await this.#recordPoint(x, y);
      console.info('[cal] record result', { point: `${i + 1}/${pts.length}`, stored, detail: this.lastDetail });
      if (stored <= 0) {
        // Nothing reached the model (no usable eye data at click time):
        // repeat the SAME point with an explanation instead of advancing.
        const why = this.lastDetail ? ` (reason: ${this.lastDetail})` : '';
        // eslint-disable-next-line no-await-in-loop
        this.#note(
          'Point not recorded — no usable eye data at click time' +
            `${why}. Keep looking at the dot and click again. If this repeats, ` +
            'check the preview is live with green eye boxes, then ' +
            'press “Restart camera” in Controls.',
        );
        continue;
      }
      i += 1;
      done += 1;
      // eslint-disable-next-line no-await-in-loop
      const errPx = await this.#liveError(x, y);
      if (errPx != null) errors.push({ i: done, err: errPx });
      if (onProgress) onProgress(done, pts.length);
    }
    const quality = this.#score(errors, done, pts.length);
    try {
      quality.stored = this.counter ? this.counter() : null;
    } catch {
      quality.stored = null;
    }
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
            console.info('[cal] click rejected by face gate (no recent face)');
            if (warn) warn.hidden = false;
            target.focus();
            return; // stay on this point until a face is visible
          }
          console.info('[cal] click accepted, recording point', `${i}/${n}`);
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
      const pred = await Promise.race([
        this.predictor ? Promise.resolve(this.predictor()) : this.#webgazerPrediction(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);
      if (!pred || !Number.isFinite(pred.x) || !Number.isFinite(pred.y)) return null;
      return Math.hypot(pred.x - x, pred.y - y);
    } catch {
      return null;
    }
  }

  async #webgazerPrediction() {
    const wg = window.webgazer;
    if (!wg || typeof wg.getCurrentPrediction !== 'function') return null;
    return wg.getCurrentPrediction();
  }

  async #recordPoint(x, y) {
    try {
      // Recorder may return a bare count or { stored, detail }.
      if (this.recorder) {
        const r = await this.recorder(x, y);
        if (r != null && typeof r === 'object') {
          this.lastDetail = r.detail ?? null;
          return r.stored ?? 0;
        }
        this.lastDetail = null;
        return r ?? 0;
      }
      // Legacy path: repeated taps through the tracker (fire-and-forget).
      const taps = Math.max(1, this.cfg.samplesPerPoint ?? 5);
      for (let i = 0; i < taps; i++) this.tracker.record(x, y);
      this.lastDetail = null;
      return taps;
    } catch {
      this.lastDetail = 'exception (see console)';
      return 0;
    }
  }

  // Transient note inside the calibration layer (reused warn slot).
  #note(text) {
    try {
      let el = this.layer.querySelector('.cal-face-warn');
      if (!el) {
        el = document.createElement('div');
        el.className = 'cal-face-warn';
        this.layer.appendChild(el);
      }
      el.textContent = text;
      el.hidden = false;
    } catch {
      /* best effort */
    }
  }

  #score(errors, done, total) {
    if (done < total) {
      return { label: 'skipped', meanErrPx: null, points: done, at: Date.now() };
    }
    if (errors.length === 0) {
      return { label: 'unknown', meanErrPx: null, points: done, at: Date.now() };
    }
    const mean = errors.reduce((a, b) => a + b.err, 0) / errors.length;
    const worst = errors.reduce((a, b) => (b.err > a.err ? b : a), errors[0]);
    const label = mean < 120 ? 'good' : mean < 200 ? 'fair' : 'poor';
    return {
      label,
      meanErrPx: Math.round(mean),
      worstPoint: worst.i,
      worstErrPx: Math.round(worst.err),
      points: done,
      at: Date.now(),
    };
  }

  #summary(quality) {
    return new Promise((resolve) => {
      const detail =
        quality.meanErrPx == null
          ? 'No live predictions were available to score against.'
          : `Mean error ≈ ${quality.meanErrPx}px` +
            (quality.worstPoint != null
              ? ` (worst: point ${quality.worstPoint} ≈ ${quality.worstErrPx}px — redo that corner if scrolling feels off there).`
              : '.');
      const stored =
        quality.stored == null
          ? ''
          : quality.stored > 0
            ? ` ${quality.stored} eye samples stored in the model.`
            : ` WARNING: 0 eye samples reached the model — gaze will not work until points record successfully.`;
      const advice =
        quality.stored === 0
          ? 'Nothing reached the model — gaze cannot work yet. Recalibrate with steady light and a still head, or try the other Estimator.'
          : quality.label === 'poor'
            ? 'Try better lighting, sit still, and recalibrate.'
            : quality.label === 'fair'
              ? 'Usable. Recalibrate if scrolling feels off.'
              : quality.label === 'unknown'
                ? 'Recorded, but no live check was available.'
                : 'Looks good.';
      this.layer.innerHTML =
        `<div class="cal-card"><h2>Calibration ${quality.label}</h2>` +
        `<p>${detail}${stored} ${advice}</p>` +
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
