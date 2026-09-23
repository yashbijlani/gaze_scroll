import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFilter,
  firstDifferenceRms,
  stepLatencyMs,
  stepResponse,
} from '../src/gaze/filters.js';

function noisyFixation(n = 200, seed = 1) {
  let a = seed;
  const rnd = () => {
    a = (a * 1664525 + 1013904223) % 4294967296;
    return a / 4294967296;
  };
  const out = [];
  for (let i = 0; i < n; i++) out.push({ x: 640 + (rnd() - 0.5) * 120, y: 400, t: i * 33 });
  return out;
}

describe('filters', () => {
  it('EMA reduces jitter on a noisy fixation', () => {
    const data = noisyFixation();
    const raw = firstDifferenceRms(data.map((p) => p.x));
    const f = createFilter('ema', { alpha: 0.3 });
    const out = data.map((p) => f.filter(p.x, p.y, p.t).x);
    const filt = firstDifferenceRms(out);
    assert.ok(filt < raw * 0.6, `ema cut jitter (${raw.toFixed(1)} → ${filt.toFixed(1)})`);
  });

  it('Kalman reduces jitter and responds faster than a laggy EMA', () => {
    const data = noisyFixation();
    const raw = firstDifferenceRms(data.map((p) => p.x));
    const k = createFilter('kalman', { processNoise: 10, measurementNoise: 150 });
    const out = data.map((p) => k.filter(p.x, p.y, p.t).x);
    const filt = firstDifferenceRms(out);
    assert.ok(filt < raw * 0.6, `kalman cut jitter (${raw.toFixed(1)} → ${filt.toFixed(1)})`);
    const kLat = stepLatencyMs(createFilter('kalman', { processNoise: 10, measurementNoise: 150 }), { step: 300 });
    const eLat = stepLatencyMs(createFilter('ema', { alpha: 0.2 }), { step: 300 });
    assert.ok(kLat <= eLat, `kalman ${kLat}ms ≤ ema ${eLat}ms`);
  });

  it('one euro tracks a step quickly', () => {
    const r = stepResponse(createFilter('oneeuro', { minCutoff: 1, beta: 0.3 }), { step: 300, samples: 40 });
    assert.ok(r > 0.9, `one euro step response ${r}`);
  });

  it('none is identity', () => {
    const f = createFilter('none');
    assert.deepEqual(f.filter(3, 4, 0), { x: 3, y: 4 });
  });
});
