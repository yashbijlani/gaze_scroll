// Standalone face-landmark detector (MediaPipe Tasks FaceLandmarker).
//
// Why a second detector? WebGazer 2.0.1 bundles a 2021 facemesh stack whose
// model fetches silently hang or 404 on modern hosting, leaving zero face
// data with zero errors. This detector is independent, actively maintained,
// and observable: load/detect failures surface as messages instead of
// silence. It drives the eye overlay, face-presence gating, and the Lab
// face row. WebGazer still owns gaze regression (for now).
//
// Loaded lazily via dynamic import so an offline/blocked CDN degrades to
// "detector unavailable" instead of breaking startup. detect() never
// throws — it returns null and records the failure reason.
// Output positions match the overlay contract: [[x, y, z], ...] in VIDEO
// pixels, first 468 entries following FaceMesh topology (so the existing
// eye-landmark index sets apply).

// Normalized ({x,y,z} in 0..1) landmarks → video-pixel positions. Pure.
export function normalizedToPixels(landmarks, videoW, videoH) {
  if (!Array.isArray(landmarks) || videoW <= 0 || videoH <= 0) return [];
  return landmarks.map((p) => [p.x * videoW, p.y * videoH, p.z ?? 0]);
}

// Pixel-space face box {x, y, w, h} over a positions array. Pure.
export function faceBoxOf(positions) {
  if (!Array.isArray(positions) || positions.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of positions) {
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export class StandaloneFaceDetector {
  constructor(cfg = {}) {
    this.cfg = cfg;
    this.landmarker = null;
    this.loading = null;
    this.failed = null;
    this.delegate = cfg.delegate ?? 'GPU';
  }

  get enabled() {
    return this.cfg.enabled !== false;
  }

  get state() {
    if (!this.enabled) return 'disabled';
    if (this.failed) return `failed: ${this.failed}`;
    if (this.landmarker) return 'ready';
    if (this.loading) return 'loading';
    return 'idle';
  }

  resetFailure() {
    this.failed = null;
  }

  async ensure() {
    if (!this.enabled) throw new Error('standalone face detector disabled in config');
    if (this.landmarker) return this.landmarker;
    if (this.failed) throw new Error(this.failed);
    if (!this.loading) this.loading = this.#load();
    return this.loading;
  }

  async #load() {
    try {
      const vision = await import(/* @vite-ignore */ this.cfg.bundleUrl);
      const resolver = await vision.FilesetResolver.forVisionTasks(this.cfg.wasmBase);
      const options = {
        baseOptions: { modelAssetPath: this.cfg.modelUrl, delegate: this.delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
      };
      try {
        this.landmarker = await vision.FaceLandmarker.createFromOptions(resolver, options);
      } catch (err) {
        // GPU delegate fails on some Linux/browser combos — CPU always works.
        console.warn('[face] GPU delegate failed, retrying CPU', err);
        options.baseOptions.delegate = 'CPU';
        this.landmarker = await vision.FaceLandmarker.createFromOptions(resolver, options);
        this.delegate = 'CPU';
      }
      console.info(`[face] landmarker ready (delegate ${this.delegate})`);
      return this.landmarker;
    } catch (err) {
      this.failed = String(err?.message ?? err).slice(0, 300);
      console.warn('[face] landmarker load failed', err);
      throw new Error(this.failed);
    } finally {
      this.loading = null;
    }
  }

  // Returns { positions, faceBox, count } or null (no face / not ready /
  // failed). Never throws. Caller throttles (see CONFIG.face interval).
  async detect(video, timestampMs) {
    try {
      if (!this.enabled || this.failed) return null;
      if (!video || video.videoWidth <= 0 || video.readyState < 2) return null;
      const landmarker = await this.ensure();
      const result = landmarker.detectForVideo(video, Math.max(0, Math.round(timestampMs)));
      const landmarks = result?.faceLandmarks?.[0];
      if (!landmarks || landmarks.length < 100) return null;
      const positions = normalizedToPixels(landmarks, video.videoWidth, video.videoHeight);
      return { positions, faceBox: faceBoxOf(positions), count: positions.length };
    } catch (err) {
      // detectForVideo throws on timestamp or state issues — log once in a
      // while, never spam, never propagate into the app loop.
      if (!this._warnedAt || performance.now() - this._warnedAt > 10000) {
        this._warnedAt = performance.now();
        console.warn('[face] detect failed', err);
      }
      return null;
    }
  }
}
