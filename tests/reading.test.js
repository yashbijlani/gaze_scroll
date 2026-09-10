import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ReadingTracker } from '../src/gaze/reading.js';
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

function downIntent() {
  return { intent: Intents.LOOKING_DOWN, direction: 'down', confidence: 0.9, signals: {} };
}

describe('ReadingTracker', () => {
  it('downward fixation steps through text count as progressing', () => {
    const rt = new ReadingTracker();
    let t = 1000;
    let snap;
    for (let i = 0; i < 6; i++) {
      snap = rt.update(
        { state: 'fixation', x: 640, y: 300 + i * 25 },
        { onText: true, textBelow: 0.5 },
        t,
      );
      t += 200;
    }
    assert.equal(snap.progressing, true);
  });

  it('scanning (up/down jumps) is not progression', () => {
    const rt = new ReadingTracker();
    let t = 1000;
    let snap;
    const ys = [400, 500, 380, 520, 390, 410]; // jumps, no net progress
    for (const y of ys) {
      snap = rt.update({ state: 'fixation', x: 640, y }, { onText: true, textBelow: 0.5 }, t);
      t += 200;
    }
    assert.equal(snap.progressing, false);
  });
});

describe('reading-aware scroll gating', () => {
  it('READING mode ignores downward intent on whitespace', () => {
    const io = fakeIO();
    const sc = new ScrollController({ minActivationMs: 0 }, io);
    sc.setMode(ScrollModes.READING);
    sc.updateIntent(downIntent(), null, io.now());
    sc.setReading({ onText: false, textBelow: 0.5, progressing: false, nearEnd: false });
    assert.equal(sc.targetVelocity(io.now()), 0);
  });

  it('READING mode scrolls when progressing through text', () => {
    const io = fakeIO();
    const sc = new ScrollController({ minActivationMs: 0 }, io);
    sc.setMode(ScrollModes.READING);
    sc.updateIntent(downIntent(), null, io.now());
    sc.setReading({ onText: true, textBelow: 0.4, progressing: true, nearEnd: false });
    assert.ok(sc.targetVelocity(io.now()) > 0);
  });

  it('PREDICTIVE mode pre-reveals when content below runs thin', () => {
    const io = fakeIO();
    const sc = new ScrollController({ minActivationMs: 0 }, io);
    sc.setMode(ScrollModes.PREDICTIVE);
    sc.updateIntent(downIntent(), null, io.now());
    sc.setReading({ onText: true, textBelow: 0.3, progressing: false, nearEnd: false, revealSoon: true });
    assert.ok(sc.targetVelocity(io.now()) > 0);
    // Plenty of text left → hold still even with down intent.
    sc.setReading({ onText: true, textBelow: 0.8, progressing: false, nearEnd: false, revealSoon: false });
    assert.equal(sc.targetVelocity(io.now()), 0);
  });
});
