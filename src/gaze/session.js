// Session recording + replay: anonymized gaze-derived data only.
// NEVER webcam frames, NEVER video. A session holds everything needed to
// re-drive filter → events → intent → scroll without the camera:
//   rows: timestamp, x, y, nx, ny, confidence, hasFace, vx, vy, speed,
//         intent, intentConf, scrollY, scrollVel, mode, event (optional)
// Metadata (viewport, UA, mode, config snapshot, calibration score) keeps
// experiments comparable. Export is always an explicit user action.

export class SessionRecorder {
  constructor({ maxRows = 20000 } = {}) {
    this.maxRows = maxRows;
    this.recording = false;
    this.rows = [];
    this.startedAt = null;
  }

  start() {
    this.rows = [];
    this.startedAt = Date.now();
    this.recording = true;
  }

  stop() {
    this.recording = false;
    return this.rows.length;
  }

  clear() {
    this.rows = [];
  }

  record(row) {
    if (!this.recording) return;
    this.rows.push(row);
    if (this.rows.length > this.maxRows) {
      this.rows.splice(0, this.rows.length - this.maxRows);
    }
  }

  toSession(meta = {}) {
    return {
      version: 1,
      exportedAt: new Date().toISOString(),
      meta: {
        viewport: { w: window.innerWidth, h: window.innerHeight },
        userAgent: navigator.userAgent,
        ...meta,
      },
      rows: this.rows,
    };
  }

  download(filename = null, meta = {}) {
    const session = this.toSession(meta);
    const blob = new Blob([JSON.stringify(session)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename ?? `gaze-session-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
    return session;
  }

  static validate(session) {
    if (!session || session.version !== 1 || !Array.isArray(session.rows)) {
      throw new Error('Not a gaze-session v1 file (rows missing).');
    }
    return session;
  }
}

// ReplayDriver: re-emits recorded rows as provider samples on a timer with
// play/pause/restart/speed. The consumer pipeline (filter→events→intent→
// scroll) is identical to live; only the source differs. Deterministic:
// same session + same config + same algorithm = same intent sequence
// (asserted in tests via MockProvider.playAll; timing here is wall-clock
// scaled, so intent *sequence* is deterministic even if pacing varies).
export class ReplayDriver {
  constructor(session, { onSample, onProgress, onDone } = {}) {
    SessionRecorder.validate(session);
    this.rows = session.rows;
    this.onSample = onSample;
    this.onProgress = onProgress;
    this.onDone = onDone;
    this.speed = 1;
    this.idx = 0;
    this.playing = false;
    this.timer = null;
  }

  get length() {
    return this.rows.length;
  }

  get progress() {
    return this.rows.length === 0 ? 0 : this.idx / this.rows.length;
  }

  play() {
    if (this.playing || this.idx >= this.rows.length) return;
    this.playing = true;
    this.#schedule();
  }

  pause() {
    this.playing = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  restart() {
    this.pause();
    this.idx = 0;
    this.play();
  }

  setSpeed(s) {
    this.speed = Math.min(4, Math.max(0.25, s));
    if (this.playing) {
      this.pause();
      this.play();
    }
  }

  #schedule() {
    if (!this.playing) return;
    if (this.idx >= this.rows.length) {
      this.playing = false;
      this.onDone?.();
      return;
    }
    const row = this.rows[this.idx];
    const next = this.rows[this.idx + 1];
    const gapMs = next ? Math.max(4, (next.timestamp - row.timestamp) / this.speed) : 0;
    this.timer = setTimeout(() => {
      if (!this.playing) return;
      this.onSample?.(row, this.idx);
      this.idx++;
      this.onProgress?.(this.progress, this.idx, this.rows.length);
      this.#schedule();
    }, Math.min(gapMs, 500));
  }

  // Provider-shaped sample for the row (nulls preserved for tracking-loss).
  static toSample(row) {
    return {
      timestamp: row.timestamp,
      x: row.x,
      y: row.y,
      normalizedX: row.nx,
      normalizedY: row.ny,
      confidence: row.confidence ?? 0,
      hasFace: !!row.hasFace,
    };
  }
}
