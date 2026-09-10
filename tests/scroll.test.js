import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ScrollController, ScrollModes } from '../src/gaze/scroll.js';
import { Intents } from '../src/gaze/intent.js';

function fakeIO() {
  return {
    deltas: [],
    y: 500,
    scrollBy(dx, dy) {
      this.deltas.push(dy);
      this.y += dy;
    },
    scrollY() {
      return this.y;
    },
    maxScrollY() {
      return 5000;
    },
    t: 1000,
    now() {
      return this.t;
    },
  };
}

function downIntent(conf = 0.9) {
  return { intent: Intents.LOOKING_DOWN, direction: 'down', confidence: conf, signals: {}, since: 0 };
}

describe('ScrollController', () => {
  it('never reacts to a single sample (minActivationMs)', () => {
    const io = fakeIO();
    const sc = new ScrollController({ minActivationMs: 700, maxVelocityPxPerS: 900 }, io);
    sc.updateIntent(downIntent(), null, io.now());
    assert.equal(sc.targetVelocity(io.now()), 0);
    io.t += 800;
    assert.ok(sc.targetVelocity(io.now()) > 0);
  });

  it('SEQ5: confidence-gated intents produce zero velocity', () => {
    const io = fakeIO();
    const sc = new ScrollController({ minActivationMs: 0 }, io);
    sc.updateIntent({ intent: Intents.UNCERTAIN, confidence: 0.4, signals: {} }, null, io.now());
    assert.equal(sc.targetVelocity(io.now()), 0);
    sc.updateIntent({ intent: Intents.TRACKING_LOST, confidence: 1, signals: {} }, null, io.now());
    assert.equal(sc.targetVelocity(io.now()), 0);
  });

  it('smooth mode ramps with accel limit and decays to stop', () => {
    const io = fakeIO();
    const sc = new ScrollController(
      { minActivationMs: 0, maxVelocityPxPerS: 900, accelPxPerS2: 2600 },
      io,
    );
    sc.updateIntent(downIntent(), null, io.now());
    const v1 = sc.tick(1 / 60, io.now()).valueOf();
    assert.ok(sc.velocity > 0 && sc.velocity <= 2600 / 60 + 1, `ramp limited: ${sc.velocity}`);
    // Hold intent: velocity approaches max.
    for (let i = 0; i < 120; i++) {
      io.t += 16;
      sc.tick(1 / 60, io.now());
    }
    assert.ok(sc.velocity > 800, `reached cruise: ${sc.velocity}`);
    // Intent disappears → smooth stop, no teleport.
    sc.updateIntent({ intent: Intents.READING, confidence: 0.8, signals: {} }, null, io.now());
    const before = sc.velocity;
    io.t += 16;
    sc.tick(1 / 60, io.now());
    assert.ok(sc.velocity < before, 'decelerates');
    assert.ok(Math.abs(sc.velocity - before) <= 2600 / 60 + 1, 'decel limited');
    assert.ok(v1 !== undefined);
  });

  it('SEQ6: manual override yields immediately and suppresses', () => {
    const io = fakeIO();
    const sc = new ScrollController({ minActivationMs: 0, manualOverridePauseMs: 2500 }, io);
    sc.updateIntent(downIntent(), null, io.now());
    io.t += 16;
    sc.tick(1 / 60, io.now());
    assert.ok(sc.velocity > 0);
    sc.manualOverride();
    assert.equal(sc.velocity, 0);
    assert.equal(sc.targetVelocity(io.now()), 0);
    io.t += 3000;
    assert.ok(sc.targetVelocity(io.now()) > 0, 'resumes after pause');
  });

  it('discrete mode steps one chunk per cooldown, not per frame', () => {
    const io = fakeIO();
    const sc = new ScrollController(
      { minActivationMs: 0, discreteChunkPx: 320, discreteCooldownMs: 1200 },
      io,
    );
    sc.setMode(ScrollModes.DISCRETE);
    sc.updateIntent(downIntent(), null, io.now());
    let total = 0;
    for (let i = 0; i < 120; i++) {
      io.t += 16;
      total += sc.tick(1 / 60, io.now());
    }
    assert.ok(total >= 320 && total <= 640, `stepped discretely: ${total}`);
    assert.deepEqual(io.deltas.filter((d) => d !== 320 && d !== 0), [], 'only full chunks');
  });

  it('emergency disable stops instantly', () => {
    const io = fakeIO();
    const sc = new ScrollController({ minActivationMs: 0 }, io);
    sc.updateIntent(downIntent(), null, io.now());
    io.t += 16;
    sc.tick(1 / 60, io.now());
    sc.setEnabled(false);
    assert.equal(sc.velocity, 0);
    assert.equal(sc.targetVelocity(io.now()), 0);
  });
});
