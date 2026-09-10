import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VelocityTracker } from '../src/gaze/velocity.js';

function seqTracker(points, dtMs = 33) {
  const v = new VelocityTracker();
  let t = 1000;
  let last;
  for (const [x, y] of points) {
    last = v.add(x, y, t);
    t += dtMs;
  }
  return last;
}

describe('VelocityTracker', () => {
  it('stable center gaze stays slow', () => {
    const pts = Array.from({ length: 30 }, (_, i) => [640 + Math.sin(i) * 3, 400 + Math.cos(i) * 3]);
    const s = seqTracker(pts);
    assert.ok(s.speed < 120, `expected slow, got ${s.speed}`);
  });

  it('steady downward drift yields +vy and high persistence', () => {
    const pts = Array.from({ length: 30 }, (_, i) => [640, 300 + i * 8]);
    const s = seqTracker(pts);
    assert.ok(s.vy > 100, `expected +vy, got ${s.vy}`);
    assert.ok(s.persistence > 0.8, `expected persistence, got ${s.persistence}`);
  });

  it('brief glance spike does not dominate (EMA smoothing)', () => {
    const v = new VelocityTracker();
    let t = 1000;
    for (let i = 0; i < 20; i++) {
      v.add(640, 400, t);
      t += 33;
    }
    v.add(640, 700, t); // single jump
    t += 33;
    const s = v.add(640, 400, t);
    assert.ok(s.speed < 2000, `single-sample spike should not explode: ${s.speed}`);
  });

  it('long gap resets instead of synthesizing a fling', () => {
    const v = new VelocityTracker();
    v.add(100, 100, 1000);
    const s = v.add(900, 900, 1000 + 5000);
    assert.equal(s.speed, 0);
  });

  it('null samples decay velocity', () => {
    const v = new VelocityTracker();
    let t = 1000;
    for (let i = 0; i < 10; i++) {
      v.add(100 + i * 20, 100, t);
      t += 33;
    }
    const fast = v.snapshot().speed;
    v.add(null, null, t);
    assert.ok(v.snapshot().speed < fast);
  });
});
