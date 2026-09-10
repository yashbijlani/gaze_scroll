import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockProvider } from '../src/gaze/provider.js';

describe('MockProvider', () => {
  it('replays scripted samples deterministically', () => {
    const script = [
      { timestamp: 1, x: 10, y: 20, normalizedX: 0.1, normalizedY: 0.2, confidence: 0.9, hasFace: true },
      { timestamp: 2, x: 30, y: 40, normalizedX: 0.3, normalizedY: 0.4, confidence: 0.8, hasFace: true },
    ];
    const p = new MockProvider(script);
    const got = [];
    p.subscribe((s) => got.push(s));
    assert.equal(p.playAll(), 2);
    assert.deepEqual(got, script);
    // Second play is identical → replay determinism.
    got.length = 0;
    p.playAll();
    assert.deepEqual(got, script);
  });
});
