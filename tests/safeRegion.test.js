import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SafeRegion,
  zoneMetrics,
  recommendFraction,
  sequenceScrollMetrics,
} from '../src/gaze/safeRegion.js';

const H = 800;

describe('SafeRegion hysteresis + dwell', () => {
  it('enters deep, holds through a shallow dip, exits clearly above', () => {
    const r = new SafeRegion({ fraction: 0.2, enterMargin: 0.02, exitMargin: 0.06, dwellMs: 0, minConfidence: 0 });
    // enter boundary = 0.82*H = 656; exit boundary = 0.74*H = 592.
    assert.equal(r.update(700, H, 1, 0).inside, true, 'deep enters');
    assert.equal(r.update(600, H, 1, 100).inside, true, 'shallow dip holds (hysteresis)');
    assert.equal(r.update(500, H, 1, 200).inside, false, 'clearly above exits');
  });

  it('dwell gates intent; brief presence does not fire', () => {
    const r = new SafeRegion({ fraction: 0.2, dwellMs: 450, minConfidence: 0 });
    assert.equal(r.update(700, H, 1, 0).intent, false);
    assert.equal(r.update(700, H, 1, 200).intent, false, '200ms < 450ms dwell');
    assert.equal(r.update(700, H, 1, 500).intent, true, '500ms ≥ 450ms dwell');
  });

  it('confidence gate suppresses intent', () => {
    const r = new SafeRegion({ fraction: 0.2, dwellMs: 100, minConfidence: 0.5 });
    r.update(700, H, 0.9, 0);
    assert.equal(r.update(700, H, 0.2, 200).intent, false, 'low confidence never scrolls');
  });

  it('adaptive margin pushes the boundary deeper with error', () => {
    const a = new SafeRegion({ fraction: 0.2, sigmaK: 1.3, sigmaPx: 0 });
    const b = new SafeRegion({ fraction: 0.2, sigmaK: 1.3, sigmaPx: 100 });
    assert.ok(b.enterBoundary() > a.enterBoundary(), 'more error → deeper boundary');
  });
});

describe('zoneMetrics / recommendFraction', () => {
  it('computes precision and recall', () => {
    const pairs = [
      { predY: 700, actualY: 700, h: H }, // TP
      { predY: 700, actualY: 500, h: H }, // FP
      { predY: 500, actualY: 700, h: H }, // FN
      { predY: 500, actualY: 500, h: H }, // TN
    ];
    const m = zoneMetrics(pairs, 0.2);
    assert.equal(m.tp, 1);
    assert.equal(m.fp, 1);
    assert.equal(m.fn, 1);
    assert.equal(m.precision, 0.5);
    assert.equal(m.recall, 0.5);
  });

  it('recommends a fraction meeting a precision target', () => {
    const pairs = [];
    for (let i = 0; i < 100; i++) {
      const actual = (i / 100) * H;
      pairs.push({ predY: actual + (i % 2 ? 40 : -40), actualY: actual, h: H });
    }
    const rec = recommendFraction(pairs, { targetPrecision: 0.9, minFraction: 0.1, maxFraction: 0.4 });
    assert.ok(rec.precision >= 0.9, `precision ${rec.precision}`);
    assert.ok(rec.fraction >= 0.1 && rec.fraction <= 0.4);
  });
});

describe('sequenceScrollMetrics', () => {
  it('brief glance does not produce false scroll', () => {
    const seq = [];
    let t = 0;
    for (let i = 0; i < 40; i++) seq.push({ t: (t += 33), predY: 400, h: H, confidence: 0.9, wants: false });
    for (let i = 0; i < 6; i++) seq.push({ t: (t += 33), predY: 740, h: H, confidence: 0.9, wants: false });
    for (let i = 0; i < 40; i++) seq.push({ t: (t += 33), predY: 400, h: H, confidence: 0.9, wants: false });
    const m = sequenceScrollMetrics(seq, { fraction: 0.2, dwellMs: 450 });
    assert.equal(m.falseEpisodes, 0);
    assert.equal(m.falseScrollRate, 0);
  });

  it('sustained downward gaze satisfies a wanted scroll', () => {
    const seq = [];
    let t = 0;
    for (let i = 0; i < 60; i++) seq.push({ t: (t += 33), predY: 740, h: H, confidence: 0.9, wants: true });
    const m = sequenceScrollMetrics(seq, { fraction: 0.2, dwellMs: 450 });
    assert.equal(m.missedEpisodes, 0);
  });
});
