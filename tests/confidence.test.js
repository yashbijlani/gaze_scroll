import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ConfidenceModel,
  calibrationQualityFromResidual,
  headBaseline,
  headPoseDelta,
} from '../src/gaze/confidence.js';
import { FEATURE_DIM, FEATURE_GROUPS } from '../src/gaze/features.js';

function feat(mut = {}) {
  const f = new Array(FEATURE_DIM).fill(0);
  f[12] = 0.5;
  f[13] = 0.5;
  f[14] = 0.15;
  f[15] = 0.5;
  f[16] = 0.2;
  f[18] = 1; // cosRoll
  return Object.assign(f, mut);
}

const GOOD = {
  coverage: 1,
  irisAvailable: true,
  leftVisibility: 0.9,
  rightVisibility: 0.9,
  leftEar: 0.22,
  rightEar: 0.22,
  symmetry: 0.9,
  ok: true,
};

describe('ConfidenceModel', () => {
  it('scores good input high and poor input low', () => {
    const cm = new ConfidenceModel();
    const good = cm.score({ hasFace: true, quality: GOOD, agreement: 1, used: 2, novelty: 0, headDelta: 0, calRms: 60 });
    const noFace = cm.score({ hasFace: false, quality: {}, agreement: 0, used: 0, novelty: 5, headDelta: 3, calRms: 250 });
    assert.ok(good.score > 0.7, `good ${good.score}`);
    assert.ok(noFace.score < 0.3, `noFace ${noFace.score}`);
    assert.ok(good.score > noFace.score);
  });

  it('penalizes disagreement and large model sigma', () => {
    const cm = new ConfidenceModel();
    const base = cm.score({ hasFace: true, quality: GOOD, agreement: 1, used: 2, novelty: 0, headDelta: 0, calRms: 60 });
    const split = cm.score({ hasFace: true, quality: GOOD, agreement: 0, used: 2, novelty: 0, headDelta: 0, calRms: 60 });
    const noisy = cm.score({ hasFace: true, quality: GOOD, agreement: 1, used: 2, novelty: 0, headDelta: 0, calRms: 60, sigma: 300 });
    assert.ok(split.score < base.score);
    assert.ok(noisy.score < base.score);
  });

  it('gate respects threshold', () => {
    const cm = new ConfidenceModel();
    assert.equal(cm.passes(0.5, 0.4), true);
    assert.equal(cm.passes(0.2, 0.4), false);
  });
});

describe('head pose helpers', () => {
  it('headPoseDelta is zero at baseline and grows with deviation', () => {
    const base = headBaseline([feat()]);
    assert.ok(base);
    assert.ok(headPoseDelta(feat(), base) < 1e-9, 'baseline ≈ 0');
    const far = feat({ [FEATURE_GROUPS.global[0]]: 0.9 });
    assert.ok(headPoseDelta(far, base) > 0.5, 'deviation grows');
  });

  it('calibrationQualityFromResidual is monotonic and bounded', () => {
    assert.equal(calibrationQualityFromResidual(30), 1);
    assert.ok(calibrationQualityFromResidual(250) < 0.2);
    assert.ok(calibrationQualityFromResidual(120) > calibrationQualityFromResidual(200));
  });
});
