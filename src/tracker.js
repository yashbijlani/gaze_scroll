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

  // --- Diagnostics: distinguish "camera track died" from "model dead". ---

  videoElementId() {
    try {
      return window.webgazer?.params?.videoElementId ?? 'webgazerVideoFeed';
    } catch {
      return 'webgazerVideoFeed';
    }
  }

  getVideoElement() {
    try {
      const byId = document.getElementById(this.videoElementId());
      if (byId) return byId;
      const inContainer = document.querySelector('#webgazerVideoContainer video');
      if (inContainer) return inContainer;
      // Last resort: any video element carrying a live camera stream.
      const videos = [...document.querySelectorAll('video')];
      return videos.find((v) => v.srcObject) ?? null;
    } catch {
      return null;
    }
  }

  // Liveness of the actual camera path (element + MediaStreamTracks).
  videoState() {
    const video = this.getVideoElement();
    if (!video) return { found: false };
    let tracks = [];
    try {
      tracks = video.srcObject?.getVideoTracks?.() ?? [];
    } catch {
      tracks = [];
    }
    return {
      found: true,
      readyState: video.readyState,
      videoSize: [video.videoWidth, video.videoHeight],
      paused: video.paused,
      ended: video.ended,
      tracks: tracks.map((t) => ({ readyState: t.readyState, muted: t.muted })),
      live: tracks.some((t) => t.readyState === 'live'),
    };
  }

  // One live prediction outside the rAF loop, capturing the REAL detector
  // error (404/403 model URLs, no-face nulls) instead of guessing.
  async probePrediction(timeoutMs = 10000) {
    try {
      const wg = window.webgazer;
      if (!wg || typeof wg.getCurrentPrediction !== 'function') {
        return { ok: false, error: 'getCurrentPrediction() missing in this build' };
      }
      const pred = await Promise.race([
        Promise.resolve(wg.getCurrentPrediction()),
        new Promise((_, reject) => setTimeout(() => reject(new Error('prediction timeout')), timeoutMs)),
      ]);
      if (!pred || !Number.isFinite(pred.x)) {
        return { ok: false, error: 'prediction null (model not ready or no face in frame)' };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  diagnose() {
    let keys = [];
    let paramInfo = null;
    try {
      const wg = window.webgazer;
      keys = wg ? Object.keys(wg).sort() : [];
      if (wg?.params) {
        paramInfo = {
          faceMeshSolutionPath: wg.params.faceMeshSolutionPath ?? null,
          videoElementId: wg.params.videoElementId ?? null,
          videoContainerId: wg.params.videoContainerId ?? null,
        };
      }
    } catch (err) {
      paramInfo = { error: String(err?.message ?? err) };
    }
    return { keys, params: paramInfo, video: this.videoState() };
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
