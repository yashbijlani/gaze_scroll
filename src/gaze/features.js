// Normalized gaze features from MediaPipe FaceLandmarker landmarks.
//
// This replaces raw grayscale eye *appearance* patches (the previous
// estimator's features) with **geometric, face-normalized** measurements:
//
//   per eye: iris offset inside the eye (roll-invariant local frame),
//            eye aspect ratio, eye size relative to inter-ocular distance,
//            iris diameter relative to eye width.
//   global:  face position/scale, eye-line roll, and yaw/pitch proxies
//            from nose-vs-eye geometry.
//
// Why this matters for accuracy: raw patches confound eyeball rotation with
// head pose and distance (the model sees a different patch when the head
// moves even if the gaze is fixed). Geometric features are normalized by the
// user's own face geometry, so a small head movement no longer looks like a
// gaze shift — the head-pose channels let the mapper subtract it explicitly.
//
// All functions are pure and unit-tested. Landmarks may be MediaPipe
// normalized ({x,y,z} in 0..1) or pixel triples; pass videoW/videoH the same
// way for both (normalized: 1,1 is acceptable for scale-free features, but
// always pass real pixel dims in the browser so roll is aspect-correct).
//
// Iris landmarks (468..477) exist only when the FaceLandmarker is created
// with refineLandmarks:true. When absent the iris channels are 0 and
// quality.irisAvailable is false; the mapper degrades to lid/eye geometry.

import { EyeIndices } from '../overlay.js';

// MediaPipe FaceMesh indices (first 468 share FaceMesh topology).
// Naming follows the existing EyeIndices convention: `.left` is the
// MediaPipe-left eye (image right), `.right` is the MediaPipe-right eye.
export const EYE_GEOMETRY = {
  left: { outer: 263, inner: 362, upper: 386, lower: 374, iris: 473, ring: [474, 475, 476, 477] },
  right: { outer: 33, inner: 133, upper: 159, lower: 145, iris: 468, ring: [469, 470, 471, 472] },
};
const NOSE_TIP = 1;

export const PER_EYE_FEATURES = ['irisX', 'irisY', 'ear', 'eyeW', 'eyeH', 'irisD'];
export const GLOBAL_FEATURES = [
  'faceCx', 'faceCy', 'scaleX', 'eyeMidY', 'eyeSepH',
  'sinRoll', 'cosRoll', 'yaw', 'pitch',
];
export const FEATURE_NAMES = [
  ...PER_EYE_FEATURES.map((n) => `left_${n}`),
  ...PER_EYE_FEATURES.map((n) => `right_${n}`),
  ...GLOBAL_FEATURES,
];
export const FEATURE_DIM = FEATURE_NAMES.length; // 21

// Feature-index groups used by two-eye fusion.
export const FEATURE_GROUPS = {
  left: [0, 1, 2, 3, 4, 5],
  right: [6, 7, 8, 9, 10, 11],
  global: [12, 13, 14, 15, 16, 17, 18, 19, 20],
};

export const NEUTRAL_FEATURES = new Array(FEATURE_DIM).fill(0);

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function px(lm, i, W, H) {
  const p = lm?.[i];
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return { x: p.x * W, y: p.y * H };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// One eye → local, roll-invariant measurements. Returns null when the
// required corners/lids are missing.
function eyeGeometry(lm, geo, W, H) {
  const outer = px(lm, geo.outer, W, H);
  const inner = px(lm, geo.inner, W, H);
  const upper = px(lm, geo.upper, W, H);
  const lower = px(lm, geo.lower, W, H);
  if (!outer || !inner || !upper || !lower) return null;

  const mid = { x: (outer.x + inner.x) / 2, y: (outer.y + inner.y) / 2 };
  const ax = { x: inner.x - outer.x, y: inner.y - outer.y };
  const width = Math.hypot(ax.x, ax.y) || 1e-6;
  const ux = { x: ax.x / width, y: ax.y / width };
  const uy = { x: -ux.y, y: ux.x }; // perpendicular (points "up" for a level eye)
  // Eye opening measured perpendicular to the corner axis (roll-invariant).
  const vOpen = { x: lower.x - upper.x, y: lower.y - upper.y };
  const height = Math.abs(vOpen.x * uy.x + vOpen.y * uy.y) || 1e-6;

  const irisP = px(lm, geo.iris, W, H);
  let irisX = 0;
  let irisY = 0;
  let irisD = 0;
  let irisAvailable = false;
  if (irisP) {
    const d = { x: irisP.x - mid.x, y: irisP.y - mid.y };
    irisX = (d.x * ux.x + d.y * ux.y) / (width / 2); // -1 outer .. +1 inner
    irisY = (d.x * uy.x + d.y * uy.y) / (height / 2); // -1 low .. +1 high
    irisAvailable = true;
    // Iris ring diameter from the 4 perimeter points (robust max pair).
    const ring = (geo.ring ?? [])
      .map((i) => px(lm, i, W, H))
      .filter(Boolean);
    let diam = 0;
    for (let i = 0; i < ring.length; i++) {
      for (let j = i + 1; j < ring.length; j++) diam = Math.max(diam, dist(ring[i], ring[j]));
    }
    irisD = diam / width;
  }
  return {
    mid,
    irisX,
    irisY,
    irisAvailable,
    ear: height / width,
    width,
    height,
    irisD,
    // Iris pushed far up/down or eye nearly closed → lid occlusion risk.
    visibility: clamp((height / width) / 0.18, 0, 1),
  };
}

// Head-pose proxies from 2D geometry. yaw/pitch are nose-relative-to-eye
// displacement normalized by inter-ocular distance: cheap, monotonic, and
// enough for the mapper to separate head shifts from eyeball rotation.
export function headPose(lm, leftMid, rightMid, W, H) {
  const nose = px(lm, NOSE_TIP, W, H);
  const eyeMid = leftMid && rightMid
    ? { x: (leftMid.x + rightMid.x) / 2, y: (leftMid.y + rightMid.y) / 2 }
    : null;
  const inter = leftMid && rightMid ? dist(leftMid, rightMid) : null;
  if (!nose || !eyeMid || !inter) {
    return { faceCx: 0.5, faceCy: 0.5, scaleX: 0.15, eyeMidY: 0.5, eyeSepH: 0.1, roll: 0, yaw: 0, pitch: 0 };
  }
  // Roll of the eye line, measured from the image-left eye to the image-right
  // eye (positive = clockwise in image coords). `leftMid` is the MediaPipe
  // left eye (image right), so the image-left→right vector is leftMid - rightMid.
  const roll = leftMid && rightMid ? Math.atan2(leftMid.y - rightMid.y, leftMid.x - rightMid.x) : 0;
  return {
    faceCx: eyeMid.x / W,
    faceCy: eyeMid.y / H,
    scaleX: inter / W,
    eyeMidY: eyeMid.y / H,
    eyeSepH: inter / H,
    roll,
    yaw: (nose.x - eyeMid.x) / inter,
    pitch: (nose.y - eyeMid.y) / inter,
  };
}

// Full fixed-length feature vector + per-eye quality diagnostics.
export function extractGazeFeatures(landmarks, videoW = 1, videoH = 1) {
  const W = videoW > 0 ? videoW : 1;
  const H = videoH > 0 ? videoH : 1;
  const vector = new Array(FEATURE_DIM).fill(0);
  const fallback = {
    vector,
    names: FEATURE_NAMES,
    perEye: { left: null, right: null },
    head: headPose([], null, null, W, H),
    quality: { coverage: 0, irisAvailable: false, leftEar: 0, rightEar: 0, symmetry: 0, ok: false },
  };
  if (!Array.isArray(landmarks) || landmarks.length < 100) return fallback;

  const L = eyeGeometry(landmarks, EYE_GEOMETRY.left, W, H);
  const R = eyeGeometry(landmarks, EYE_GEOMETRY.right, W, H);
  const head = headPose(landmarks, L?.mid, R?.mid, W, H);

  const put = (base, g) => {
    if (!g) return;
    vector[base + 0] = g.irisX;
    vector[base + 1] = g.irisY;
    vector[base + 2] = g.ear;
    vector[base + 3] = head.scaleX > 0 ? g.width / (head.scaleX * W || 1) : 0;
    vector[base + 4] = head.scaleX > 0 ? g.height / (head.scaleX * W || 1) : 0;
    vector[base + 5] = g.irisD;
  };
  put(0, L);
  put(6, R);

  vector[12] = head.faceCx;
  vector[13] = head.faceCy;
  vector[14] = head.scaleX;
  vector[15] = head.eyeMidY;
  vector[16] = head.eyeSepH;
  vector[17] = Math.sin(head.roll);
  vector[18] = Math.cos(head.roll);
  vector[19] = head.yaw;
  vector[20] = head.pitch;

  const coverage = [L, R].filter(Boolean).length / 2;
  const irisAvailable = !!(L?.irisAvailable && R?.irisAvailable);
  const symmetry = L && R ? 1 - clamp(Math.abs(L.width - R.width) / (L.width + R.width || 1), 0, 1) : 0;
  return {
    vector,
    names: FEATURE_NAMES,
    perEye: { left: L, right: R },
    head,
    quality: {
      coverage,
      irisAvailable,
      leftEar: L?.ear ?? 0,
      rightEar: R?.ear ?? 0,
      leftVisibility: L?.visibility ?? 0,
      rightVisibility: R?.visibility ?? 0,
      symmetry,
      ok: coverage === 1,
    },
  };
}
