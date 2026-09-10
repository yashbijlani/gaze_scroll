import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapLandmarkToCanvas, EyeIndices } from '../src/overlay.js';

describe('mapLandmarkToCanvas', () => {
  it('scales video pixels to canvas pixels', () => {
    // Center of a 640×480 feed onto a 240×180 preview.
    assert.deepEqual(mapLandmarkToCanvas(320, 240, 640, 480, 240, 180, false), [120, 90]);
  });

  it('mirrors horizontally when the preview is mirrored', () => {
    const [unmirrored] = mapLandmarkToCanvas(160, 240, 640, 480, 240, 180, false);
    const [mirrored] = mapLandmarkToCanvas(160, 240, 640, 480, 240, 180, true);
    assert.equal(unmirrored, 60);
    assert.equal(mirrored, 180); // flips around the vertical axis
  });

  it('guards zero-size video without NaN', () => {
    const [x, y] = mapLandmarkToCanvas(10, 10, 0, 0, 240, 180, false);
    assert.ok(Number.isFinite(x) && Number.isFinite(y));
  });

  it('eye index sets cover both eyes', () => {
    assert.ok(EyeIndices.left.length >= 16);
    assert.ok(EyeIndices.right.length >= 16);
    for (const i of [...EyeIndices.left, ...EyeIndices.right]) {
      assert.ok(Number.isInteger(i) && i >= 0 && i < 478, `landmark ${i} in range`);
    }
  });
});
