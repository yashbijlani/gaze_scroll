// GazeProvider abstraction: a swappable source of normalized gaze samples.
//
// Normalized sample shape (the contract every provider fulfills):
//   { timestamp, x, y, normalizedX, normalizedY, confidence, hasFace }
//
// - x, y: viewport pixels (smoothed by the provider when applicable)
// - normalizedX/Y: 0..1 fractions of viewport (viewport-resize safe)
// - confidence: 0..1 (provider-local proxy; never treated as ground truth)
// - hasFace: bool du jour from the underlying estimator
//
// Concrete providers:
//   WebGazerProvider — wraps the existing GazeTracker + GazeSmoother.
//   MockProvider     — scripted/synthetic samples; used by tests and replay,
//                      no camera required.

export class GazeProvider {
  constructor(name = 'base') {
    this.name = name;
    this.subscribers = new Set();
    this.running = false;
  }

  subscribe(cb) {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  emit(sample) {
    for (const cb of this.subscribers) {
      try {
        cb(sample);
      } catch (err) {
        console.error(`gaze provider (${this.name}) subscriber error`, err);
      }
    }
  }

  async start() {
    this.running = true;
  }

  async stop() {
    this.running = false;
  }

  getStatus() {
    return { name: this.name, running: this.running };
  }
}

// WebGazer-backed provider. Owns begin()/end() on the shared tracker so the
// camera lifecycle stays in one place; smoothing + confidence match Phase 0.
export class WebGazerProvider extends GazeProvider {
  constructor({ tracker, smoother }) {
    super('webgazer');
    this.tracker = tracker;
    this.smoother = smoother;
    this.lastT = 0;
    this.unsub = null;
  }

  async start() {
    if (this.running) return;
    await this.tracker.begin();
    this.unsub = this.tracker.subscribe((raw) => this.#onRaw(raw));
    this.running = true;
  }

  #onRaw(raw) {
    const t = raw?.t ?? performance.now();
    if (!raw) {
      this.emit({
        timestamp: t,
        x: null,
        y: null,
        normalizedX: null,
        normalizedY: null,
        confidence: 0,
        hasFace: false,
      });
      return;
    }
    if (t - this.lastT > 500) this.smoother.reset(); // gap re-acquire
    this.lastT = t;
    const sm = this.smoother.filter(raw.x, raw.y, raw.t);
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    this.emit({
      timestamp: t,
      x: sm.x,
      y: sm.y,
      normalizedX: sm.x / vw,
      normalizedY: sm.y / vh,
      rawX: raw.x,
      rawY: raw.y,
      confidence: this.tracker.computeConfidence(raw),
      hasFace: !!raw.hasFace,
    });
  }

  async stop() {
    this.unsub?.();
    this.unsub = null;
    this.tracker.end(); // releases loop + DOM; camera track stops via end()
    this.running = false;
  }
}

// Scripted provider for tests, replay, and camera-less development.
export class MockProvider extends GazeProvider {
  constructor(samples = []) {
    super('mock');
    this.samples = samples;
  }

  push(sample) {
    this.emit(sample);
  }

  // Synchronously re-emit the script (deterministic; used by replay + tests).
  playAll(mapFn) {
    for (const s of this.samples) this.emit(mapFn ? mapFn(s) : s);
    return this.samples.length;
  }
}
