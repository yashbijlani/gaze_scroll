import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { IntentEngine, Intents } from '../src/gaze/intent.js';

const VP = () => ({ w: 1280, h: 800 });
const BASE_CFG = {
  enterThreshold: 0.62,
  exitThreshold: 0.42,
  minActivationMs: 700,
  minConfidence: 0.35,
  edgeBandPx: 140,
  wEdge: 0.3,
  wVelocity: 0.3,
  wPersistence: 0.2,
  wFixation: 0.1,
  wConfidence: 0.1,
};

function sample(x, y, t, confidence = 0.9) {
  return { timestamp: t, x, y, normalizedX: x / 1280, normalizedY: y / 800, confidence, hasFace: true };
}
// Sustained downward drift analysis (as the event detector would report).
function driftAnalysis(vy = 400, persistence = 1) {
  return {
    fixation: { state: 'saccade', durationMs: 0 },
    velocity: { vx: 0, vy, speed: Math.abs(vy), dirX: 0, dirY: 1, persistence },
    edge: null,
    lost: false,
  };
}
function stillAnalysis() {
  return {
    fixation: { state: 'fixation', durationMs: 500 },
    velocity: { vx: 0, vy: 0, speed: 10, dirX: 0, dirY: 0, persistence: 0 },
    edge: null,
    lost: false,
  };
}

describe('IntentEngine', () => {
  it('SEQ1: stable center gaze → READING/IDLE, never directional', () => {
    const eng = new IntentEngine(BASE_CFG, VP);
    let last;
    for (let i = 0; i < 40; i++) {
      last = eng.update(sample(640, 400, 1000 + i * 33), stillAnalysis(), { scrollY: 500, maxScrollY: 5000 });
    }
    assert.ok([Intents.READING, Intents.IDLE].includes(last.intent), `got ${last.intent}`);
  });

  it('SEQ2: gradual move to bottom + dwell → eventually LOOKING_DOWN', () => {
    const eng = new IntentEngine(BASE_CFG, VP);
    let t = 1000;
    let last;
    for (let i = 0; i < 30; i++) {
      const y = 400 + i * 12; // drift down into the edge band
      last = eng.update(sample(640, Math.min(y, 760), t), driftAnalysis(400, 1), { scrollY: 500, maxScrollY: 5000 });
      t += 33;
    }
    // Keep dwelling at the bottom with downward evidence.
    for (let i = 0; i < 40; i++) {
      last = eng.update(sample(640, 760, t), driftAnalysis(250, 1), { scrollY: 500, maxScrollY: 5000 });
      t += 33;
    }
    assert.equal(last.intent, Intents.LOOKING_DOWN);
  });

  it('SEQ3: brief glance at bottom → no directional intent', () => {
    const eng = new IntentEngine(BASE_CFG, VP);
    let t = 1000;
    let last;
    for (let i = 0; i < 20; i++) {
      last = eng.update(sample(640, 400, t), stillAnalysis(), { scrollY: 500, maxScrollY: 5000 });
      t += 33;
    }
    for (let i = 0; i < 6; i++) {
      // 200ms glance: too short for minActivationMs=700.
      last = eng.update(sample(640, 760, t), driftAnalysis(500, 0.5), { scrollY: 500, maxScrollY: 5000 });
      t += 33;
    }
    assert.notEqual(last.intent, Intents.LOOKING_DOWN);
  });

  it('SEQ4: noisy gaze around threshold → no rapid oscillation', () => {
    const eng = new IntentEngine(BASE_CFG, VP);
    const seen = [];
    let t = 1000;
    // Alternate just inside/outside the edge band with weak velocity.
    for (let i = 0; i < 90; i++) {
      const y = i % 2 === 0 ? 655 : 675;
      const r = eng.update(sample(640, y, t), driftAnalysis(i % 2 === 0 ? 60 : -60, 0.4), { scrollY: 500, maxScrollY: 5000 });
      seen.push(r.intent);
      t += 33;
    }
    const flips = seen.slice(1).filter((v, i) => v !== seen[i]).length;
    assert.ok(flips <= 3, `oscillated ${flips}x: ${[...new Set(seen)]}`);
    assert.ok(!seen.includes(Intents.LOOKING_DOWN), 'noise must not trigger scroll intent');
  });

  it('SEQ5: confidence collapse → UNCERTAIN/TRACKING_LOST, never directional', () => {
    const eng = new IntentEngine(BASE_CFG, VP);
    let t = 1000;
    let last;
    for (let i = 0; i < 20; i++) {
      last = eng.update(sample(640, 760, t, 0.9), driftAnalysis(400, 1), { scrollY: 500, maxScrollY: 5000 });
      t += 33;
    }
    for (let i = 0; i < 10; i++) {
      last = eng.update(sample(640, 760, t, 0.05), driftAnalysis(400, 1), { scrollY: 500, maxScrollY: 5000 });
      t += 33;
    }
    assert.ok([Intents.UNCERTAIN, Intents.TRACKING_LOST].includes(last.intent), `got ${last.intent}`);
    const lost = eng.update({ timestamp: t, x: null, y: null, confidence: 0 }, { lost: true });
    assert.equal(lost.intent, Intents.TRACKING_LOST);
  });

  it('at document bottom → no LOOKING_DOWN (nowhere to go)', () => {
    const eng = new IntentEngine(BASE_CFG, VP);
    let t = 1000;
    let last;
    for (let i = 0; i < 60; i++) {
      last = eng.update(sample(640, 760, t), driftAnalysis(400, 1), { scrollY: 5000, maxScrollY: 5000 });
      t += 33;
    }
    assert.notEqual(last.intent, Intents.LOOKING_DOWN);
  });
});
