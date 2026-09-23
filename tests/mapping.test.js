import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GazeMapper, FeatureScaler, designVector } from '../src/gaze/mapping.js';

function fit(mapper, rows) {
  for (const r of rows) mapper.addSample(r.f, r.x, r.y);
  return mapper.fit();
}

describe('GazeMapper / ridge', () => {
  it('recovers an exact affine map', () => {
    const m = new GazeMapper({ model: 'affine', lambda: 1e-6 });
    const rows = [];
    for (let i = 0; i < 8; i++) {
      const f = [i - 3, (i % 3) - 1];
      rows.push({ f, x: 3 * f[0] + 2 * f[1] + 5, y: -1 * f[0] + 4 * f[1] - 2 });
    }
    fit(m, rows);
    const p = m.predict([2, 1]);
    assert.ok(Math.abs(p.x - (3 * 2 + 2 * 1 + 5)) < 1e-6, `x ${p.x}`);
    assert.ok(Math.abs(p.y - (-1 * 2 + 4 * 1 - 2)) < 1e-6, `y ${p.y}`);
  });

  it('poly2 fits a product interaction affine cannot', () => {
    const affine = new GazeMapper({ model: 'affine', lambda: 1e-6 });
    const poly = new GazeMapper({ model: 'poly2', lambda: 1e-6 });
    const rows = [];
    for (let i = 0; i < 25; i++) {
      const a = (i % 5) - 2;
      const b = Math.floor(i / 5) - 2;
      rows.push({ f: [a, b], x: a * b, y: a + b });
    }
    fit(affine, rows);
    fit(poly, rows);
    assert.ok(poly.residualRms < affine.residualRms, `poly ${poly.residualRms} < affine ${affine.residualRms}`);
    assert.ok(poly.residualRms < 1e-4, 'poly fits product near-exactly');
  });

  it('returns null before any data', () => {
    const m = new GazeMapper();
    assert.equal(m.predict([1, 2]), null);
    assert.equal(m.fit(), null);
  });

  it('tiny MLP learns a linear map', () => {
    const m = new GazeMapper({ model: 'mlp', hidden: [12, 6], mlpEpochs: 600, mlpLr: 0.03 });
    const rows = [];
    for (let i = 0; i < 30; i++) {
      const a = (i % 6) / 5 - 0.5;
      const b = Math.floor(i / 6) / 4 - 0.5;
      rows.push({ f: [a, b], x: a * 200 + 640, y: b * 200 + 400 });
    }
    fit(m, rows);
    const p = m.predict([0.4, -0.3]);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
    assert.ok(Math.abs(p.x - (0.4 * 200 + 640)) < 60, `x ${p.x}`);
  });

  it('scaler floors variance and clips z', () => {
    const s = new FeatureScaler({ floor: 0.1, clipZ: 3 });
    s.fit([[1, 5], [1, 5.1], [1, 4.9]]);
    const z = s.transform([1, 50]);
    assert.ok(Math.abs(z[0]) <= 3, 'constant dim clipped');
    assert.ok(Math.abs(z[1]) <= 3, 'outlier clipped');
  });

  it('persists and restores through JSON', () => {
    const m = new GazeMapper({ model: 'affine', lambda: 0.5 });
    fit(m, [
      { f: [0, 0], x: 10, y: 20 },
      { f: [1, 0], x: 20, y: 20 },
      { f: [0, 1], x: 10, y: 30 },
      { f: [1, 1], x: 20, y: 30 },
    ]);
    const before = m.predict([0.5, 0.5]);
    const m2 = GazeMapper.fromJSON(JSON.parse(JSON.stringify(m.toJSON())));
    const after = m2.predict([0.5, 0.5]);
    assert.ok(Math.abs(before.x - after.x) < 1e-6 && Math.abs(before.y - after.y) < 1e-6);
  });

  it('designVector shapes', () => {
    assert.equal(designVector([1, 2], 'affine').length, 3);
    // 1 + d + d(d+1)/2 = 1 + 2 + 3 = 6
    assert.equal(designVector([1, 2], 'poly2').length, 6);
  });
});
