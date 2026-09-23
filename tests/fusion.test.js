import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eyeFeatureView, fuseEyeEstimates, TwoEyeGazeModel } from '../src/gaze/fusion.js';
import { FEATURE_DIM, FEATURE_GROUPS } from '../src/gaze/features.js';

describe('eyeFeatureView', () => {
  it('keeps one eye + globals, zeroes the other', () => {
    const f = Array.from({ length: FEATURE_DIM }, (_, i) => i + 1);
    const l = eyeFeatureView(f, 'left');
    assert.equal(l.length, FEATURE_DIM);
    for (const i of FEATURE_GROUPS.left) assert.equal(l[i], f[i]);
    for (const i of FEATURE_GROUPS.right) assert.equal(l[i], 0);
    for (const i of FEATURE_GROUPS.global) assert.equal(l[i], f[i]);
  });
});

describe('fuseEyeEstimates', () => {
  it('agreement raises confidence, disagreement lowers it', () => {
    const agree = fuseEyeEstimates([
      { x: 100, y: 100, sigma: 30, confidence: 0.9 },
      { x: 105, y: 102, sigma: 30, confidence: 0.9 },
    ]);
    const disagree = fuseEyeEstimates([
      { x: 100, y: 100, sigma: 30, confidence: 0.9 },
      { x: 300, y: 400, sigma: 30, confidence: 0.9 },
    ]);
    assert.ok(agree.agreement > disagree.agreement);
    assert.ok(agree.confidence > disagree.confidence);
    assert.equal(agree.used, 2);
  });

  it('gracefully falls back to a single eye', () => {
    const r = fuseEyeEstimates([{ x: 10, y: 20, sigma: 40, confidence: 0.8 }, null]);
    assert.equal(r.used, 1);
    assert.equal(r.x, 10);
    assert.ok(r.confidence <= 0.8);
  });

  it('returns null estimate when nothing valid', () => {
    const r = fuseEyeEstimates([]);
    assert.equal(r.x, null);
    assert.equal(r.confidence, 0);
  });
});

describe('TwoEyeGazeModel', () => {
  it('trains three mappers and predicts from both eyes', () => {
    const m = new TwoEyeGazeModel({ model: 'affine', lambda: 1e-6 });
    for (let i = 0; i < 12; i++) {
      const f = new Array(FEATURE_DIM).fill(0);
      // Encode gaze in both eyes' irisX channels.
      f[0] = i;
      f[6] = i;
      m.addSample(f, i * 10, 400);
    }
    assert.equal(m.count, 12);
    const p = m.predict(new Array(FEATURE_DIM).fill(0).map((_, i) => (i === 0 || i === 6 ? 6 : 0)));
    assert.ok(p && Number.isFinite(p.x));
    assert.ok(Math.abs(p.x - 60) < 5, `fused x ${p.x}`);
  });
});
