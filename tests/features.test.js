import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractGazeFeatures,
  headPose,
  FEATURE_DIM,
  FEATURE_GROUPS,
} from '../src/gaze/features.js';
import { synthFace } from './helpers/synthFace.js';

const W = 1280;
const H = 800;

describe('extractGazeFeatures', () => {
  it('returns a fixed-length vector with quality flags', () => {
    const f = extractGazeFeatures(synthFace(), W, H);
    assert.equal(f.vector.length, FEATURE_DIM);
    assert.equal(f.quality.ok, true);
    assert.equal(f.quality.irisAvailable, true);
    assert.ok(f.quality.coverage === 1);
  });

  it('falls back safely for too few landmarks', () => {
    const f = extractGazeFeatures([], W, H);
    assert.equal(f.vector.length, FEATURE_DIM);
    assert.equal(f.quality.ok, false);
    assert.ok(f.vector.every((v) => v === 0));
  });

  it('iris features respond to gaze direction', () => {
    const center = extractGazeFeatures(synthFace({ gaze: { x: 0, y: 0 } }), W, H);
    const right = extractGazeFeatures(synthFace({ gaze: { x: 1, y: 0 } }), W, H);
    const down = extractGazeFeatures(synthFace({ gaze: { x: 0, y: 1 } }), W, H);
    // Left (image-right) eye: gaze right moves iris toward outer → irisX down.
    assert.ok(right.vector[0] < center.vector[0], 'left irisX decreases looking right');
    // Right (image-left) eye: gaze right moves iris toward inner → irisX up.
    assert.ok(right.vector[6] > center.vector[6], 'right irisX increases looking right');
    // Vertical: at least one eye's irisY changes with downward gaze.
    assert.ok(
      Math.abs(down.vector[1] - center.vector[1]) > 0.05 ||
        Math.abs(down.vector[7] - center.vector[7]) > 0.05,
      'vertical iris changes with gaze',
    );
  });

  it('normalizes in-plane roll: iris offsets are roll-invariant', () => {
    const a = extractGazeFeatures(synthFace({ gaze: { x: 0.6, y: 0.3 } }), W, H);
    const b = extractGazeFeatures(synthFace({ gaze: { x: 0.6, y: 0.3 }, roll: 0.15 }), W, H);
    assert.ok(Math.abs(a.vector[0] - b.vector[0]) < 0.05, `left irisX roll-invariant (${a.vector[0]} vs ${b.vector[0]})`);
    assert.ok(Math.abs(a.vector[1] - b.vector[1]) < 0.08, 'left irisY roll-invariant');
    // Roll channel detects the rotation (exact angle is aspect-corrected, so
    // only assert it moved and is in the right direction).
    assert.ok(Math.abs(b.vector[17]) > 0.05, 'roll channel reflects rotation');
    assert.ok(b.vector[17] > a.vector[17], 'positive roll → positive sinRoll');
  });

  it('head pose proxies move with face translation and nose offset', () => {
    const base = extractGazeFeatures(synthFace(), W, H);
    const moved = extractGazeFeatures(synthFace({ fcx: 0.6, fcy: 0.45 }), W, H);
    assert.ok(moved.head.faceCx > base.head.faceCx, 'faceCx follows translation');
    const yawed = extractGazeFeatures(synthFace({ nose: { x: 0.05, y: 0.07 } }), W, H);
    assert.ok(yawed.head.yaw !== base.head.yaw, 'yaw responds to nose offset');
  });

  it('reports iris unavailable when iris landmarks are absent', () => {
    const lm = synthFace();
    // Blank the iris + ring landmarks.
    for (const i of [468, 469, 470, 471, 472, 473, 474, 475, 476, 477]) lm[i] = { x: NaN, y: NaN };
    const f = extractGazeFeatures(lm, W, H);
    assert.equal(f.quality.irisAvailable, false);
    assert.equal(f.quality.ok, true, 'still usable from lid/corner geometry');
    assert.equal(f.vector[FEATURE_GROUPS.left[0]], 0, 'irisX zeroed when unavailable');
  });

  it('headPose is safe on empty input', () => {
    const hp = headPose([], null, null, W, H);
    assert.ok(Number.isFinite(hp.faceCx) && Number.isFinite(hp.yaw));
  });
});
