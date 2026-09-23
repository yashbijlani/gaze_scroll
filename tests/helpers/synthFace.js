// Synthetic 478-landmark face for tests. Places the eye corners/lids, iris
// rings, and nose tip at the indices features.js reads, in normalized image
// coordinates (0..1). `gaze` shifts the iris within each eye; `roll` rotates
// the whole face. Enough to exercise geometry features and the provider.
import { EYE_GEOMETRY } from '../../src/gaze/features.js';

export function synthFace({
  fcx = 0.5,
  fcy = 0.5,
  eyeSep = 0.14,
  eyeW = 0.055,
  eyeH = 0.02,
  roll = 0,
  gaze = { x: 0, y: 0 },
  irisGain = 0.45,
  nose = { x: 0, y: 0.07 },
} = {}) {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const cos = Math.cos(roll);
  const sin = Math.sin(roll);
  const place = (lx, ly) => ({ x: fcx + lx * cos - ly * sin, y: fcy + lx * sin + ly * cos, z: 0 });
  const set = (i, lx, ly) => {
    lm[i] = place(lx, ly);
  };

  const rC = -eyeSep / 2; // MediaPipe-right eye (image left)
  const lC = eyeSep / 2; // MediaPipe-left eye (image right)

  // Right eye: outer 33 (image left), inner 133, upper 159, lower 145, iris 468.
  set(EYE_GEOMETRY.right.outer, rC - eyeW / 2, 0);
  set(EYE_GEOMETRY.right.inner, rC + eyeW / 2, 0);
  set(EYE_GEOMETRY.right.upper, rC, -eyeH / 2);
  set(EYE_GEOMETRY.right.lower, rC, eyeH / 2);
  // Looking right moves both irises toward image-right. irisX is measured
  // toward the inner corner, so the signs differ per eye.
  const rIrisX = rC + gaze.x * irisGain * (eyeW / 2);
  const rIrisY = gaze.y * irisGain * (eyeH / 2);
  set(EYE_GEOMETRY.right.iris, rIrisX, rIrisY);
  EYE_GEOMETRY.right.ring.forEach((idx, k) => {
    const a = (k / 4) * Math.PI * 2;
    set(idx, rIrisX + Math.cos(a) * eyeW * 0.18, rIrisY + Math.sin(a) * eyeW * 0.18);
  });

  // Left eye: outer 263 (image right), inner 362, upper 386, lower 374, iris 473.
  set(EYE_GEOMETRY.left.outer, lC + eyeW / 2, 0);
  set(EYE_GEOMETRY.left.inner, lC - eyeW / 2, 0);
  set(EYE_GEOMETRY.left.upper, lC, -eyeH / 2);
  set(EYE_GEOMETRY.left.lower, lC, eyeH / 2);
  const lIrisX = lC + gaze.x * irisGain * (eyeW / 2);
  const lIrisY = gaze.y * irisGain * (eyeH / 2);
  set(EYE_GEOMETRY.left.iris, lIrisX, lIrisY);
  EYE_GEOMETRY.left.ring.forEach((idx, k) => {
    const a = (k / 4) * Math.PI * 2;
    set(idx, lIrisX + Math.cos(a) * eyeW * 0.18, lIrisY + Math.sin(a) * eyeW * 0.18);
  });

  set(1, nose.x, nose.y); // nose tip
  return lm;
}
