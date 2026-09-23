// GeometryGazeProvider: the accuracy-overhaul estimator.
//
// Pipeline:
//   landmarks → normalized geometric features (features.js)
//             → two-eye personalized mapping (fusion.js + mapping.js)
//             → explicit confidence (confidence.js)
//             → constant-velocity Kalman filter (filters.js)
//
// It deliberately does NOT use WebGazer's bundled detector or regression
// (both proved unreliable) and does NOT use raw grayscale eye patches
// (head-pose confounded, high-dimensional, overfit). It shares the
// StandaloneFaceDetector with the overlay, so landmark inference stays
// single-flight and cheap.
//
// Same normalized sample contract as the other providers, so events →
// intent → scroll → lab → replay are untouched. Pure helpers live in the
// feature/mapping/fusion/confidence modules and are unit-tested; this file
// is the browser glue.

import { GazeProvider } from './provider.js';
import { extractGazeFeatures } from './features.js';
import { TwoEyeGazeModel } from './fusion.js';
import { ConfidenceModel, headBaseline, headPoseDelta } from './confidence.js';
import { createFilter } from './filters.js';
import { medianFeatures, l1dist } from './ridge.js';

const DEFAULT_MAPPER = { model: 'affine', lambda: 1.0, stdFloor: 0.05, clipZ: 4 };

export class GeometryGazeProvider extends GazeProvider {
  constructor({
    tracker,
    faceDetector,
    getVideo,
    tickMs = 66,
    taps = 5,
    mapperOpts = DEFAULT_MAPPER,
    filterKind = 'kalman',
    filterOpts = { processNoise: 10, measurementNoise: 150 },
  }) {
    super('geometry');
    this.tracker = tracker;
    this.faceDetector = faceDetector;
    this.getVideo = getVideo;
    this.tickMs = tickMs;
    this.taps = taps;
    this.model = new TwoEyeGazeModel(mapperOpts);
    this.mapperOpts = mapperOpts;
    this.confidenceModel = new ConfidenceModel();
    this.filter = createFilter(filterKind, filterOpts);
    this.filterKind = filterKind;
    this.filterOpts = filterOpts;
    this.headBase = null;
    this.calRms = null;
    this.timer = null;
    this.busy = false;
    this.lastT = 0;
    this.lastFaceT = 0;
    this.lastNullReason = null;
    this.restoredInfo = null;
  }

  storedCount() {
    return this.model.count;
  }

  persistKey() {
    return 'gazeScroll.geometry.v1';
  }

  reset() {
    this.model.clear();
    this.filter.reset();
    this.headBase = null;
    this.calRms = null;
    this.lastNullReason = null;
    this.clearPersisted();
  }

  // Recompute head baseline + calibration residual from the trained model.
  refreshCalibrationStats() {
    const samples = this.model.combined.samples;
    if (samples.length === 0) {
      this.headBase = null;
      this.calRms = null;
      return;
    }
    this.headBase = headBaseline(samples.map((s) => s.f));
    this.calRms = this.model.combined.residualRms;
  }

  async start() {
    if (this.running) return;
    await this.tracker.begin();
    try {
      window.webgazer?.pause?.();
    } catch {
      /* optional */
    }
    this.restoredInfo = null;
    try {
      this.restoredInfo = this.load();
      if (this.restoredInfo) {
        this.refreshCalibrationStats();
        console.info(`[geometry] restored ${this.restoredInfo.restored} calibration samples`);
      }
    } catch {
      /* fresh start */
    }
    this.running = true;
    this.timer = setInterval(() => this.#tick(), this.tickMs);
  }

  async stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.busy = false;
    this.tracker.end();
  }

  // --- Persistence (features only, never images) ---
  save() {
    try {
      if (this.model.count === 0) return false;
      localStorage.setItem(
        this.persistKey(),
        JSON.stringify({
          savedAt: Date.now(),
          viewport: { w: window.innerWidth, h: window.innerHeight },
          mapperOpts: this.mapperOpts,
          model: this.model.toJSON(),
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  load() {
    try {
      if (this.model.count > 0) return null;
      const raw = localStorage.getItem(this.persistKey());
      if (!raw) return null;
      const json = JSON.parse(raw);
      if (!json?.model) return null;
      const model = TwoEyeGazeModel.fromJSON(json.model);
      if (model.count === 0) return null;
      this.model = model;
      this.model.fit();
      this.refreshCalibrationStats();
      return { restored: model.count, savedAt: json.savedAt ?? null, viewport: json.viewport ?? null };
    } catch {
      return null;
    }
  }

  clearPersisted() {
    try {
      localStorage.removeItem(this.persistKey());
    } catch {
      /* ignore */
    }
  }

  // Single sense→predict pass. Returns an enriched prediction or null.
  async predictOnce() {
    try {
      const video = this.getVideo?.();
      if (!video || video.videoWidth <= 0 || video.readyState < 2) {
        this.lastNullReason = 'no-video';
        return null;
      }
      const r = await this.faceDetector.detect(video, performance.now());
      if (!r || !r.positions || r.positions.length < 100) {
        this.lastNullReason = 'no-face';
        return null;
      }
      this.lastFaceT = performance.now();
      const feat = extractGazeFeatures(r.positions, video.videoWidth, video.videoHeight);
      if (!feat.quality.ok) {
        this.lastNullReason = 'no-eyes';
        return null;
      }
      const pred = this.model.predict(feat.vector, {
        left: feat.quality.leftVisibility,
        right: feat.quality.rightVisibility,
      });
      if (!pred) {
        this.lastNullReason = 'no-prediction';
        return null;
      }
      const headDelta = headPoseDelta(feat.vector, this.headBase);
      const conf = this.confidenceModel.score({
        hasFace: true,
        quality: feat.quality,
        agreement: pred.agreement,
        used: pred.used,
        novelty: pred.novelty,
        headDelta,
        calRms: this.calRms,
        sigma: pred.sigma,
      });
      this.lastNullReason = null;
      return {
        x: pred.x,
        y: pred.y,
        sigma: pred.sigma,
        confidence: conf.score,
        factors: conf.factors,
        agreement: pred.agreement,
        quality: feat.quality,
        features: feat.vector,
        novelty: pred.novelty,
      };
    } catch (err) {
      this.lastNullReason = 'no-prediction';
      console.warn('[geometry] predict failed', err);
      return null;
    }
  }

  // Calibration: collect taps+2 observations, drop blink/outlier frames by
  // distance to the median feature vector, keep the best `taps`.
  async calibrateAt(x, y) {
    try {
      const video = this.getVideo?.();
      if (!video || video.videoWidth <= 0 || video.readyState < 2) {
        this.lastNullReason = 'no-video';
        return 0;
      }
      const candidates = [];
      let sawFace = false;
      let sawEyes = false;
      const attempts = this.taps + 2;
      for (let a = 0; a < attempts; a++) {
        // eslint-disable-next-line no-await-in-loop
        const r = await this.faceDetector.detect(video, performance.now());
        if (!r || !r.positions || r.positions.length < 100) continue;
        sawFace = true;
        const feat = extractGazeFeatures(r.positions, video.videoWidth, video.videoHeight);
        if (!feat.quality.ok) continue;
        sawEyes = true;
        candidates.push({ f: feat.vector });
        if (candidates.length >= attempts) break;
      }
      if (candidates.length < 3) {
        this.lastNullReason = !sawFace ? 'no-face' : !sawEyes ? 'no-eyes' : 'partial';
        return 0;
      }
      const med = medianFeatures(candidates.map((c) => c.f));
      candidates.sort((a, b) => l1dist(a.f, med) - l1dist(b.f, med));
      const kept = candidates.slice(0, this.taps);
      const before = this.model.count;
      for (const c of kept) this.model.addSample(c.f, x, y);
      const delta = this.model.count - before;
      if (delta <= 0) {
        this.lastNullReason = 'no-eyes';
        return 0;
      }
      this.model.fit();
      this.refreshCalibrationStats();
      if (this.tracker && Number.isFinite(this.tracker.calibratedCount)) {
        this.tracker.calibratedCount += delta;
      }
      this.lastNullReason = null;
      return delta;
    } catch (err) {
      this.lastNullReason = 'no-eyes';
      console.warn('[geometry] calibrateAt failed', err);
      return 0;
    }
  }

  async observeClick(x, y) {
    try {
      if (!this.running) return false;
      const video = this.getVideo?.();
      if (!video || video.videoWidth <= 0 || video.readyState < 2) return false;
      const r = await this.faceDetector.detect(video, performance.now());
      if (!r || !r.positions || r.positions.length < 100) return false;
      const feat = extractGazeFeatures(r.positions, video.videoWidth, video.videoHeight);
      if (!feat.quality.ok) return false;
      const ok = this.model.addSample(feat.vector, x, y);
      if (ok) {
        this.model.fit();
        this.refreshCalibrationStats();
      }
      return ok;
    } catch {
      return false;
    }
  }

  async #tick() {
    if (!this.running || this.busy) return;
    this.busy = true;
    const t = performance.now();
    try {
      const p = await this.predictOnce();
      if (!p) {
        const freshFace = t - this.lastFaceT < 1500;
        this.emit({
          timestamp: t,
          x: null,
          y: null,
          normalizedX: null,
          normalizedY: null,
          rawX: null,
          rawY: null,
          confidence: 0,
          hasFace: freshFace,
        });
        return;
      }
      if (t - this.lastT > 500) this.filter.reset();
      this.lastT = t;
      const sm = this.filter.filter(p.x, p.y, t);
      const vw = window.innerWidth || 1;
      const vh = window.innerHeight || 1;
      this.emit({
        timestamp: t,
        x: sm.x,
        y: sm.y,
        normalizedX: sm.x / vw,
        normalizedY: sm.y / vh,
        rawX: p.x,
        rawY: p.y,
        confidence: p.confidence,
        sigma: p.sigma,
        agreement: p.agreement,
        hasFace: true,
      });
    } finally {
      this.busy = false;
    }
  }
}
