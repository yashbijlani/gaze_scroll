import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GazeEventDetector, GazeEvents } from '../src/gaze/events.js';

const VP = () => ({ w: 1280, h: 800 });

function feed(det, points, dtMs = 33, conf = 0.9) {
  let t = 1000;
  for (const [x, y] of points) {
    det.update({ timestamp: t, x, y, normalizedX: x / 1280, normalizedY: y / 800, confidence: conf, hasFace: true });
    t += dtMs;
  }
  return t;
}

describe('GazeEventDetector', () => {
  it('stable gaze fires FIXATION_STARTED', () => {
    const det = new GazeEventDetector(
      { fixation: { windowMs: 200, dispersionThresholdPx: 40, minDurationMs: 120 } },
      VP,
    );
    const seen = [];
    det.subscribe((e) => seen.push(e.type));
    feed(det, Array.from({ length: 30 }, () => [640, 400]));
    assert.ok(seen.includes(GazeEvents.FIXATION_STARTED), `saw: ${seen}`);
  });

  it('sustained bottom gaze fires EDGE_DWELL_STARTED, brief glance does not', () => {
    const det = new GazeEventDetector(
      { events: { edgeBandPx: 140, edgeDwellMs: 900 } },
      VP,
    );
    const seen = [];
    det.subscribe((e) => seen.push(e.type));
    // Brief glance: 300ms in the edge band.
    feed(det, Array.from({ length: 9 }, () => [640, 750]), 33);
    assert.ok(!seen.includes(GazeEvents.EDGE_DWELL_STARTED), 'brief glance must not dwell');
    // Sustained: 1.5s in the edge band.
    feed(det, Array.from({ length: 50 }, () => [640, 750]), 33);
    assert.ok(seen.includes(GazeEvents.EDGE_DWELL_STARTED), `saw: ${seen}`);
  });

  it('leaving the edge fires EDGE_DWELL_ENDED', () => {
    const det = new GazeEventDetector(
      { events: { edgeBandPx: 140, edgeDwellMs: 300 } },
      VP,
    );
    const seen = [];
    det.subscribe((e) => seen.push(e.type));
    feed(det, Array.from({ length: 30 }, () => [640, 750]), 33);
    feed(det, Array.from({ length: 5 }, () => [640, 400]), 33);
    assert.ok(seen.includes(GazeEvents.EDGE_DWELL_ENDED));
  });

  it('null gap fires TRACKING_LOST then TRACKING_RECOVERED', () => {
    const det = new GazeEventDetector({ events: { trackingLostGapMs: 200 } }, VP);
    const seen = [];
    det.subscribe((e) => seen.push(e.type));
    let t = feed(det, [[640, 400]]);
    det.update({ timestamp: t + 500, x: null, y: null, confidence: 0, hasFace: false });
    assert.ok(seen.includes(GazeEvents.TRACKING_LOST));
    det.update({ timestamp: t + 600, x: 640, y: 400, confidence: 0.9, hasFace: true });
    assert.ok(seen.includes(GazeEvents.TRACKING_RECOVERED));
  });
});
