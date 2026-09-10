import { CONFIG } from './config.js';

// WebGazer is loaded as a CDN global (UMD). This wrapper owns init,
// the gaze subscription, manual calibration recording, and a confidence
// proxy (WebGazer exposes no model confidence — see ARCHITECTURE.md §3.4).
function waitForWebgazer(timeoutMs) {
  return new Promise((resolve, reject) => {
    if (window.webgazer) {
      resolve(window.webgazer);
      return;
    }
    const started = performance.now();
    const id = setInterval(() => {
      if (window.webgazer) {
        clearInterval(id);
        resolve(window.webgazer);
      } else if (performance.now() - started > timeoutMs) {
        clearInterval(id);
        reject(new Error('WebGazer failed to load (CDN unreachable?).'));
      }
    }, 100);
  });
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

export class GazeTracker {
  constructor(cfg = CONFIG.webgazer) {
    this.cfg = cfg;
    this.started = false;
    this.subscribers = new Set();
    this.calibratedCount = 0;
  }

  async begin() {
    if (this.started) return;
    const webgazer = await waitForWebgazer(this.cfg.loadTimeoutMs);
    if (!webgazer || typeof webgazer.begin !== 'function') {
      throw new Error(
        'Loaded window.webgazer is not a usable build (missing begin(); ' +
          `keys: ${webgazer ? Object.keys(webgazer).join(',') : 'null'}). ` +
          'Adblock or a stale CDN cache may have replaced webgazer.min.js.',
      );
    }
    // Optional vs required API: some CDN builds / adblock-neutered copies
    // lack individual setters. Required calls throw a descriptive error;
    // optional tuning calls only warn so tracking can still start.
    const optional = (name, ...args) => {
      if (typeof webgazer[name] === 'function') return webgazer[name](...args);
      console.warn(`webgazer.${name}() missing in loaded build — skipping.`);
      return undefined;
    };
    // Must be set BEFORE begin(): TFFacemesh.init() reads it when the
    // detector is lazily created on the first video frame. The stock
    // default ('./mediapipe/face_mesh') 404s unless the host app self-hosts
    // the MediaPipe solution files, which rejects the first prediction and
    // silently kills WebGazer's rAF loop after ~1s of live video.
    try {
      if (this.cfg.faceMeshSolutionPath && webgazer.params) {
        webgazer.params.faceMeshSolutionPath = this.cfg.faceMeshSolutionPath;
      }
    } catch (err) {
      console.warn('could not set faceMeshSolutionPath', err);
    }
    optional('saveDataAcrossSessions', !!this.cfg.saveDataAcrossSessions);
    optional('setTracker', this.cfg.tracker);
    optional('setRegression', this.cfg.regression);
    optional('applyKalmanFilter', !!this.cfg.applyKalmanFilter);
    optional('showPredictionPoints', false); // we render our own smoothed cursor
    if (typeof webgazer.setGazeListener !== 'function') {
      throw new Error('Loaded WebGazer build lacks setGazeListener().');
    }
    webgazer.setGazeListener((data) => this.#notify(data));
    const ret = webgazer.begin();
    if (ret && typeof ret.then === 'function') await ret;
    this.started = true;
  }

  #notify(data) {
    const t = performance.now();
    let sample = null;
    if (data && Number.isFinite(data.x) && Number.isFinite(data.y)) {
      const ef = data.eyeFeatures;
      sample = {
        x: data.x,
        y: data.y,
        t,
        hasFace: !!(ef && ef.left && ef.right),
      };
    }
    for (const cb of this.subscribers) {
      try {
        cb(sample);
      } catch (err) {
        console.error('gaze subscriber error', err);
      }
    }
  }

  subscribe(cb) {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  record(x, y) {
    if (!this.started) return 0;
    window.webgazer.recordScreenPosition(x, y);
    this.calibratedCount += 1;
    return this.calibratedCount;
  }

  async clear() {
    if (window.webgazer) await window.webgazer.clearData();
    this.calibratedCount = 0;
  }

  pause() {
    window.webgazer?.pause();
  }

  resume() {
    window.webgazer?.resume();
  }

  end() {
    window.webgazer?.end();
    this.started = false;
  }

  // Heuristic 0–1 score: face features present + distance from viewport edge.
  // NOT a model confidence — a placeholder until the estimator provides one.
  computeConfidence(sample) {
    if (!sample) return 0;
    const margin = 60;
    const dx = Math.min(sample.x, window.innerWidth - sample.x);
    const dy = Math.min(sample.y, window.innerHeight - sample.y);
    const edge = clamp01(Math.min(dx, dy) / margin);
    return clamp01(0.25 + 0.35 * (sample.hasFace ? 1 : 0) + 0.4 * edge);
  }
}
