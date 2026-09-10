import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizedToPixels, faceBoxOf, StandaloneFaceDetector } from '../src/gaze/face.js';

describe('normalizedToPixels', () => {
  it('scales normalized landmarks to video pixels', () => {
    const out = normalizedToPixels([{ x: 0.5, y: 0.25, z: 0 }], 640, 480);
    assert.deepEqual(out, [[320, 120, 0]]);
  });

  it('returns [] for degenerate input', () => {
    assert.deepEqual(normalizedToPixels(null, 640, 480), []);
    assert.deepEqual(normalizedToPixels([{ x: 0.5, y: 0.5 }], 0, 0), []);
  });
});

describe('faceBoxOf', () => {
  it('bounds the landmark cloud', () => {
    const box = faceBoxOf([
      [10, 20, 0],
      [110, 20, 0],
      [10, 220, 0],
      [110, 220, 0],
    ]);
    assert.deepEqual(box, { x: 10, y: 20, w: 100, h: 200 });
  });

  it('returns null for empty/invalid input', () => {
    assert.equal(faceBoxOf([]), null);
    assert.equal(faceBoxOf(null), null);
    assert.equal(faceBoxOf([[Number.NaN, 1, 0]]), null);
  });
});

describe('StandaloneFaceDetector', () => {
  it('starts idle and detect() degrades to null without a video', async () => {
    const d = new StandaloneFaceDetector({ enabled: true });
    assert.equal(d.state, 'idle');
    assert.equal(await d.detect(null, 0), null);
  });

  it('disabled detector reports disabled and never loads', async () => {
    const d = new StandaloneFaceDetector({ enabled: false });
    assert.equal(d.state, 'disabled');
    assert.equal(await d.detect({ videoWidth: 640, readyState: 4 }, 1000), null);
  });
});
