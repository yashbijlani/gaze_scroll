// LandmarkerGazeProvider: gaze estimation that does NOT depend on
// WebGazer's bundled (frequently blind) facemesh tracker.
//
// Idea: WebGazer's ridge regression is just math over eye-appearance
// patches — `reg.addData(eyes, [x, y])` / `reg.predict(eyes)` — where
// `eyes` is `{left: {patch, imagex, imagey, width, height}, right: {...}}`.
// We cut those patches ourselves from our own working FaceLandmarker
// landmarks (same eye-index topology) plus the live video frame, and call
// the same regression the WebGazer path uses. Calibration taps and gaze
// predictions therefore work even when WebGazer's own detector sees
// nothing. Same normalized sample contract as WebGazerProvider, so the
// entire downstream pipeline (events → intent → scroll → lab → replay)
// is untouched.
//
// Eye-box padding: landmark eye arcs are tight; a few px of context helps
// the regression. Kept small and fixed so train/predict match.

import { GazeProvider } from './provider.js';
import { EyeIndices } from '../overlay.js';
import { faceBoxOf } from './face.js';
import { RidgeGazeMapper, eyeFeatures, concatEyes, medianFeatures, l1dist } from './ridge.js';

const EYE_PAD_PX = 8;
const MIN_PATCH_PX = 4;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Head-pose proxy features from 2D landmark geometry (all normalized):
// face center (translation), face size (camera distance), eye-line roll,
// eye height within the face. Lets the linear model separate head shifts
// from eyeball rotation — the dominant real-world confound (leaning,
// distance change, head turns). Pure; tested.
export function headFeatures(positions, videoW, videoH) {
  const fallback = [0.5, 0.5, 0.25, 0.25, 0, 0.5];
  if (!Array.isArray(positions) || positions.length < 100 || videoW <= 0 || videoH <= 0) {
    return fallback;
  }
  const mean = (indices) => {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const i of indices) {
      const p = positions[i];
      if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      sx += p[0];
      sy += p[1];
      n++;
    }
    return n > 0 ? { x: sx / n, y: sy / n } : null;
  };
  const box = faceBoxOf(positions);
  const L = mean(EyeIndices.left);
  const R = mean(EyeIndices.right);
  if (!box || box.w <= 0 || box.h <= 0 || !L || !R) return fallback;
  const dx = R.x - L.x || 1;
  return [
    (box.x + box.w / 2) / videoW,
    (box.y + box.h / 2) / videoH,
    box.w / videoW,
    box.h / videoH,
    Math.atan2(R.y - L.y, dx),
    (L.y + R.y) / 2 / videoH,
  ];
}

// Pixel bbox of one eye's landmarks, padded + clamped to the frame.
// Returns { x, y, w, h } ints or null when degenerate.
export function eyeBox(indices, positions, videoW, videoH, pad = EYE_PAD_PX) {
  if (!Array.isArray(positions) || positions.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const i of indices) {
    const p = positions[i];
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  if (!Number.isFinite(minX)) return null;
  const x = clamp(Math.round(minX - pad), 0, Math.max(0, videoW - 1));
  const y = clamp(Math.round(minY - pad), 0, Math.max(0, videoH - 1));
  const w = clamp(Math.round(maxX + pad), x + 1, videoW) - x;
  const h = clamp(Math.round(maxY + pad), y + 1, videoH) - y;
  if (w < MIN_PATCH_PX || h < MIN_PATCH_PX) return null;
  return { x, y, w, h };
}

// Build the WebGazer-shaped eye object from landmarks.
// grabPatch(x, y, w, h) => ImageData-like (injected: canvas in prod, stub in tests).
// Returns { left, right } or null when either eye is unusable.
export function buildEyeObjects(positions, videoW, videoH, grabPatch) {
  if (!positions || positions.length < 100 || typeof grabPatch !== 'function') return null;
  const boxes = {
    left: eyeBox(EyeIndices.left, positions, videoW, videoH),
    right: eyeBox(EyeIndices.right, positions, videoW, videoH),
  };
  if (!boxes.left || !boxes.right) return null;
  try {
    const eyes = {};
    for (const side of ['left', 'right']) {
      const b = boxes[side];
      const patch = grabPatch(b.x, b.y, b.w, b.h);
      if (!patch) return null;
      eyes[side] = { patch, imagex: b.x, imagey: b.y, width: b.w, height: b.h };
    }
    return eyes;
  } catch {
    return null;
  }
}

export class LandmarkerGazeProvider extends GazeProvider {
  constructor({
    tracker,
    smoother,
    faceDetector,
    getVideo,
    createGrabber = null, // (video) => (x,y,w,h) => ImageData; default canvas impl
    tickMs = 66,
    taps = 5,
  }) {
    super('landmarker');
    this.tracker = tracker;
    this.smoother = smoother;
    this.faceDetector = faceDetector;
    this.getVideo = getVideo;
    this.createGrabber = createGrabber ?? defaultGrabber;
    this.tickMs = tickMs;
    this.taps = taps;
    this.mapper = new RidgeGazeMapper();
    this.timer = null;
    this.busy = false;
    this.lastT = 0;
    this.lastFaceT = 0;
    this.frameCanvas = null;
    // Last failure reason ('no-video' | 'no-face' | 'no-eyes' |
    // 'no-prediction' | null on success). Surfaced in the UI so a dead
    // calibration point can say WHY instead of just repeating.
    this.lastNullReason = null;
  }

  storedCount() {
    return this.mapper.count;
  }

  reset() {
    this.mapper.clear();
    this.smoother.reset();
    this.clearPersisted();
  }

  // Full feature vector: eye appearance + head-pose proxies. Returns null
  // when the eyes are unusable (caller sets the reason).
  fullFeats(positions, video) {
    const eyes = buildEyeObjects(
      positions,
      video.videoWidth,
      video.videoHeight,
      this.createGrabber(video, this),
    );
    if (!eyes) return null;
    return {
      eyes,
      feats: [
        ...concatEyes(
          eyeFeatures(eyes.left.patch, this.mapper.eyeW, this.mapper.eyeH),
          eyeFeatures(eyes.right.patch, this.mapper.eyeW, this.mapper.eyeH),
        ),
        ...headFeatures(positions, video.videoWidth, video.videoHeight),
      ],
    };
  }

  // --- Calibration persistence (mapper only — features, never images). ---

  persistKey() {
    return 'gazeScroll.landmarker.v1';
  }

  save() {
    try {
      if (this.mapper.count === 0) return false;
      localStorage.setItem(
        this.persistKey(),
        JSON.stringify({
          savedAt: Date.now(),
          viewport: { w: window.innerWidth, h: window.innerHeight },
          map: this.mapper.toJSON(),
        }),
      );
      return true;
    } catch {
      return false; // private mode / quota — session still works
    }
  }

  // Returns { restored, savedAt, viewport } or null. Called at start when
  // the mapper is empty so a returning user skips calibration.
  load() {
    try {
      if (this.mapper.count > 0) return null;
      const raw = localStorage.getItem(this.persistKey());
      if (!raw) return null;
      const json = JSON.parse(raw);
      if (!json || !json.map) return null;
      const map = RidgeGazeMapper.fromJSON(json.map);
      if (map.count === 0) return null;
      this.mapper = map;
      return { restored: map.count, savedAt: json.savedAt ?? null, viewport: json.viewport ?? null };
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

  async start() {
    if (this.running) return;
    // tracker's begin() acquires the camera + regression objects. WebGazer's
    // own prediction loop is then parked: it burns CPU on a broken detector
    // and its nulls would pollute nothing (we don't subscribe to it), but
    // pausing keeps the machine quiet for our loop.
    await this.tracker.begin();
    try {
      window.webgazer?.pause?.();
    } catch {
      /* optional */
    }
    // Returning user? Restore persisted mapping so gaze works immediately.
    this.restoredInfo = null;
    try {
      this.restoredInfo = this.load();
      if (this.restoredInfo) {
        console.info(
          `[landmarker] restored ${this.restoredInfo.restored} samples ` +
            `from ${new Date(this.restoredInfo.savedAt).toLocaleString()}`,
        );
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

  // Single sense→predict pass shared by the loop, calibration, and probes.
  // Returns { x, y } or null. Never throws. Records lastNullReason.
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
      // Face observed (even if the model can't predict yet — e.g.
      // uncalibrated). Without this, hasFace is never true and
      // face-present nulls are indistinguishable from a dead camera.
      this.lastFaceT = performance.now();
      const full = this.fullFeats(r.positions, video);
      if (!full) {
        this.lastNullReason = 'no-eyes';
        return null;
      }
      const pred = this.mapper.predictFeats(full.feats);
      if (!pred) {
        this.lastNullReason = 'no-prediction';
        return null;
      }
      this.lastNullReason = null;
      return pred;
    } catch {
      this.lastNullReason = 'no-prediction';
      return null;
    }
  }

  // Calibration write path: returns taps actually stored (0 = nothing
  // recorded). Verifies via getData() delta — some builds silently drop
  // malformed eye objects instead of throwing, and counting unstored taps
  // is the fake-complete trap.
  // Calibration write path: returns taps actually stored (0 = nothing
  // recorded). Robust: collects up to taps+2 observations, drops outliers
  // by distance to the median feature vector (blinks, mid-saccade frames),
  // keeps the best `taps`. Our own store pushes unconditionally, so a 0
  // here means the eye data itself was unusable.
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
        const full = this.fullFeats(r.positions, video);
        if (!full) continue;
        sawEyes = true;
        candidates.push({ feats: full.feats });
        if (candidates.length >= attempts) break;
      }
      if (candidates.length < 3) {
        this.lastNullReason = !sawFace ? 'no-face' : !sawEyes ? 'no-eyes' : 'partial';
        return 0;
      }
      const med = medianFeatures(candidates.map((c) => c.feats));
      candidates.sort((a, b) => l1dist(a.feats, med) - l1dist(b.feats, med));
      const kept = candidates.slice(0, this.taps);
      const before = this.mapper.count;
      for (const c of kept) this.mapper.addFeatureSample(c.feats, x, y);
      const delta = this.mapper.count - before;
      if (delta <= 0) {
        this.lastNullReason = 'no-eyes';
        return 0;
      }
      if (this.tracker && Number.isFinite(this.tracker.calibratedCount)) {
        this.tracker.calibratedCount += delta;
      }
      this.lastNullReason = null;
      return delta;
    } catch (err) {
      this.lastNullReason = 'no-eyes';
      console.warn('[landmarker] calibrateAt failed', err);
      return 0;
    }
  }

  // WebGazer-style implicit training: people usually look where they
  // click. Single tap, best-effort — never throws, never blocks the click.
  async observeClick(x, y) {
    try {
      if (!this.running) return false;
      const video = this.getVideo?.();
      if (!video || video.videoWidth <= 0 || video.readyState < 2) return false;
      const r = await this.faceDetector.detect(video, performance.now());
      if (!r || !r.positions || r.positions.length < 100) return false;
      const full = this.fullFeats(r.positions, video);
      if (!full) return false;
      return this.mapper.addFeatureSample(full.feats, x, y);
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
      if (t - this.lastT > 500) this.smoother.reset();
      this.lastT = t;
      const sm = this.smoother.filter(p.x, p.y, t);
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
        confidence: this.tracker.computeConfidence({ x: p.x, y: p.y, hasFace: true }),
        hasFace: true,
      });
    } finally {
      this.busy = false;
    }
  }
}

// Default frame grabber: draws the live video into a reused offscreen
// canvas and slices ImageData patches out of it. (document touched only
// when called, so module import stays node-safe for tests.)
function defaultGrabber(video, provider) {
  let canvas = provider.frameCanvas;
  if (!canvas) {
    canvas = document.createElement('canvas');
    provider.frameCanvas = canvas;
  }
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return (x, y, w, h) => ctx.getImageData(x, y, w, h);
}
