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

const EYE_PAD_PX = 8;
const MIN_PATCH_PX = 4;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
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
    regIndex = 0,
    tickMs = 66,
    taps = 5,
  }) {
    super('landmarker');
    this.tracker = tracker;
    this.smoother = smoother;
    this.faceDetector = faceDetector;
    this.getVideo = getVideo;
    this.createGrabber = createGrabber ?? defaultGrabber;
    this.regIndex = regIndex;
    this.tickMs = tickMs;
    this.taps = taps;
    this.timer = null;
    this.busy = false;
    this.lastT = 0;
    this.lastFaceT = 0;
    this.frameCanvas = null;
  }

  reg() {
    try {
      return window.webgazer?.getRegression?.()?.[this.regIndex] ?? null;
    } catch {
      return null;
    }
  }

  storedCount() {
    try {
      return this.reg()?.getData?.()?.length ?? null;
    } catch {
      return null;
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
  // Returns { x, y } or null. Never throws.
  async predictOnce() {
    try {
      const video = this.getVideo?.();
      if (!video || video.videoWidth <= 0 || video.readyState < 2) return null;
      const r = await this.faceDetector.detect(video, performance.now());
      if (!r || !r.positions || r.positions.length < 100) return null;
      this.lastFaceT = performance.now();
      const eyes = buildEyeObjects(
        r.positions,
        video.videoWidth,
        video.videoHeight,
        this.createGrabber(video, this),
      );
      if (!eyes) return null;
      const pred = this.reg()?.predict?.(eyes);
      if (!pred || !Number.isFinite(pred.x) || !Number.isFinite(pred.y)) return null;
      return { x: pred.x, y: pred.y };
    } catch {
      return null;
    }
  }

  // Calibration write path: returns taps stored (0 = nothing recorded).
  async calibrateAt(x, y) {
    try {
      const reg = this.reg();
      if (!reg || typeof reg.addData !== 'function') {
        console.warn('[landmarker] regression addData() missing — cannot record');
        return 0;
      }
      const video = this.getVideo?.();
      if (!video || video.videoWidth <= 0 || video.readyState < 2) return 0;
      const r = await this.faceDetector.detect(video, performance.now());
      if (!r || !r.positions || r.positions.length < 100) return 0;
      const eyes = buildEyeObjects(
        r.positions,
        video.videoWidth,
        video.videoHeight,
        this.createGrabber(video, this),
      );
      if (!eyes) return 0;
      for (let i = 0; i < this.taps; i++) reg.addData(eyes, [x, y]);
      if (this.tracker && Number.isFinite(this.tracker.calibratedCount)) {
        this.tracker.calibratedCount += this.taps;
      }
      return this.taps;
    } catch (err) {
      console.warn('[landmarker] calibrateAt failed', err);
      return 0;
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
