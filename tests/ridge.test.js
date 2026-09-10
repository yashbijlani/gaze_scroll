import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eyeFeatures, solveRidge, RidgeGazeMapper, medianFeatures, l1dist } from '../src/gaze/ridge.js';

function solidPatch(v, w = 40, h = 30) {
  const data = new Uint8ClampedArray(w * h * 4);
  const g = Math.max(0, Math.min(255, Math.round(v * 255)));
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = g;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = g;
    data[i * 4 + 3] = 255;
  }
  return { data, width: w, height: h };
}

describe('eyeFeatures', () => {
  it('downsamples to outW×outH normalized values', () => {
    const f = eyeFeatures(solidPatch(0.5, 8, 6), 16, 12);
    assert.equal(f.length, 192);
    for (const v of f) assert.ok(Math.abs(v - 0.5) < 0.01, `≈0.5, got ${v}`);
  });

  it('preserves spatial structure (bright left, dark right)', () => {
    const w = 8;
    const h = 4;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const g = x < w / 2 ? 255 : 0;
        const i = (y * w + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = g;
        data[i + 3] = 255;
      }
    }
    const f = eyeFeatures({ data, width: w, height: h }, 4, 2);
    assert.ok(f[0] > 0.99 && f[3] < 0.01, `gradient preserved: ${f.slice(0, 4)}`);
  });
});

describe('solveRidge', () => {
  it('recovers exact weights on noiseless data', () => {
    const w = solveRidge(
      [[1, 0], [0, 1], [1, 1], [2, 1]],
      [2, 3, 5, 7],
      1e-9,
    );
    assert.ok(Math.abs(w[0] - 2) < 1e-6 && Math.abs(w[1] - 3) < 1e-6, `got ${w}`);
  });

  it('returns null when empty', () => {
    assert.equal(solveRidge([], [], 1), null);
  });
});

describe('RidgeGazeMapper', () => {
  it('predicts null until trained; learns a linear map', () => {
    const m = new RidgeGazeMapper();
    assert.equal(m.predict(solidPatch(0.2), solidPatch(0.3)), null);
    const levels = [0.15, 0.3, 0.45, 0.6, 0.75];
    const pts = levels.map((l, i) => {
      const r = 0.85 - i * 0.12;
      return { l, r, x: 200 + 800 * l, y: 150 + 500 * (0.85 - r) };
    });
    for (const p of pts) {
      assert.ok(m.addSample(solidPatch(p.l), solidPatch(p.r), p.x, p.y));
    }
    assert.equal(m.count, 5);
    let err = 0;
    for (const p of pts) {
      const pred = m.predict(solidPatch(p.l), solidPatch(p.r));
      assert.ok(pred, 'predicts after training');
      err += Math.hypot(pred.x - p.x, pred.y - p.y);
    }
    assert.ok(err / pts.length < 100, `mean training err ${err / pts.length}`);
  });

  it('rejects non-finite targets and clears', () => {
    const m = new RidgeGazeMapper();
    assert.equal(m.addSample(solidPatch(0.2), solidPatch(0.2), NaN, 100), false);
    assert.equal(m.count, 0);
    m.addSample(solidPatch(0.2), solidPatch(0.2), 100, 100);
    m.clear();
    assert.equal(m.count, 0);
    assert.equal(m.predict(solidPatch(0.2), solidPatch(0.2)), null);
  });
});

describe('persistence + robust stats', () => {
  it('toJSON/fromJSON round-trips the mapping', () => {
    const m = new RidgeGazeMapper();
    m.addSample(solidPatch(0.2), solidPatch(0.7), 100, 200);
    m.addSample(solidPatch(0.6), solidPatch(0.3), 500, 600);
    const m2 = RidgeGazeMapper.fromJSON(JSON.parse(JSON.stringify(m.toJSON())));
    assert.equal(m2.count, 2);
    const a = m.predict(solidPatch(0.2), solidPatch(0.7));
    const b = m2.predict(solidPatch(0.2), solidPatch(0.7));
    assert.ok(Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1, 'restored model agrees');
  });

  it('fromJSON rejects garbage', () => {
    assert.throws(() => RidgeGazeMapper.fromJSON(null));
    assert.throws(() => RidgeGazeMapper.fromJSON({ version: 99, samples: [] }));
    const m = RidgeGazeMapper.fromJSON({ version: 1, samples: [{ f: [1], x: 0, y: 0 }] });
    assert.equal(m.count, 0, 'wrong-dim rows skipped');
  });

  it('median + l1 identify the outlier', () => {
    const good = [[1, 1], [1.1, 0.9], [0.9, 1.1]];
    const bad = [10, 10];
    const med = medianFeatures([...good, bad]);
    assert.ok(Math.abs(med[0] - 1) < 0.2 && Math.abs(med[1] - 1) < 0.2);
    assert.ok(l1dist(bad, med) > l1dist(good[0], med) * 5);
  });
});
