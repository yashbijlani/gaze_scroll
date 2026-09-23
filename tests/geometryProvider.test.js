import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { GeometryGazeProvider } from '../src/gaze/geometryProvider.js';
import { synthFace } from './helpers/synthFace.js';

const W = 1280;
const H = 800;
const VIDEO = { videoWidth: 640, videoHeight: 480, readyState: 4 };

// Mutable synthetic gaze the face detector "sees".
const state = { gaze: { x: 0, y: 0 }, face: true };

function gridTargets() {
  const xs = [0.1, 0.5, 0.9];
  const ys = [0.1, 0.5, 0.9];
  const out = [];
  for (const y of ys) for (const x of xs) out.push({ x: x * W, y: y * H });
  return out;
}

function makeProvider(overrides = {}) {
  const tracker = {
    calibratedCount: 0,
    async begin() {},
    end() {},
    computeConfidence: () => 0.9,
  };
  const faceDetector = {
    detect: async () =>
      state.face ? { positions: synthFace({ gaze: state.gaze }) } : null,
  };
  return new GeometryGazeProvider({
    tracker,
    faceDetector,
    getVideo: () => VIDEO,
    tickMs: 20,
    taps: 3,
    ...overrides,
  });
}

before(() => {
  global.window = { innerWidth: W, innerHeight: H, webgazer: { pause() {} } };
});
after(() => {
  delete global.window;
});

describe('GeometryGazeProvider', () => {
  beforeEach(() => {
    state.face = true;
    state.gaze = { x: 0, y: 0 };
  });

  it('predictOnce is null before calibration', async () => {
    const p = makeProvider();
    assert.equal(await p.predictOnce(), null);
    assert.equal(p.lastNullReason, 'no-prediction');
  });

  it('calibrates from landmarks and predicts near the target', async () => {
    const p = makeProvider();
    for (const t of gridTargets()) {
      state.gaze = { x: t.x / W, y: t.y / H };
      const n = await p.calibrateAt(t.x, t.y);
      assert.ok(n > 0, `stored taps at ${t.x},${t.y}`);
    }
    assert.equal(p.storedCount(), 9 * 3);
    assert.ok(p.calRms != null, 'calibration residual computed');
    // Query near a point between calibration targets.
    state.gaze = { x: 0.3, y: 0.7 };
    const pred = await p.predictOnce();
    assert.ok(pred, 'predicts after calibration');
    assert.ok(Math.abs(pred.x - 0.3 * W) < 120, `x ${pred.x} vs ${0.3 * W}`);
    assert.ok(Math.abs(pred.y - 0.7 * H) < 120, `y ${pred.y} vs ${0.7 * H}`);
    assert.ok(pred.confidence > 0 && pred.confidence <= 1, `confidence ${pred.confidence}`);
  });

  it('reports no-face and no-video failure reasons', async () => {
    const p = makeProvider();
    state.face = false;
    assert.equal(await p.predictOnce(), null);
    assert.equal(p.lastNullReason, 'no-face');
    const noVideo = makeProvider({ getVideo: () => null });
    assert.equal(await noVideo.predictOnce(), null);
    assert.equal(noVideo.lastNullReason, 'no-video');
  });

  it('emits normalized samples while running and stops', async () => {
    const p = makeProvider();
    for (const t of gridTargets()) {
      state.gaze = { x: t.x / W, y: t.y / H };
      await p.calibrateAt(t.x, t.y);
    }
    state.gaze = { x: 0.5, y: 0.5 };
    const got = [];
    p.subscribe((s) => got.push(s));
    await p.start();
    await new Promise((r) => setTimeout(r, 90));
    await p.stop();
    const n = got.length;
    assert.ok(n >= 1, 'emitted while running');
    assert.ok(Math.abs(got[0].normalizedX - 0.5) < 0.2, `nx ${got[0].normalizedX}`);
    assert.ok(got[0].confidence > 0);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(got.length, n, 'silent after stop');
  });

  it('persists and restores calibration', async () => {
    const store = {};
    global.localStorage = {
      getItem: (k) => store[k] ?? null,
      setItem: (k, v) => {
        store[k] = String(v);
      },
      removeItem: (k) => {
        delete store[k];
      },
    };
    const p1 = makeProvider();
    for (const t of gridTargets()) {
      state.gaze = { x: t.x / W, y: t.y / H };
      await p1.calibrateAt(t.x, t.y);
    }
    assert.equal(p1.save(), true);
    const p2 = makeProvider();
    const info = p2.load();
    assert.ok(info && info.restored === 27, `restored ${JSON.stringify(info)}`);
    assert.ok(p2.calRms != null, 'stats recomputed on restore');
    state.gaze = { x: 0.5, y: 0.5 };
    assert.ok(await p2.predictOnce());
    p2.reset();
    assert.equal(p2.storedCount(), 0);
    assert.equal(store['gazeScroll.geometry.v1'] ?? null, null, 'reset clears persisted copy');
    delete global.localStorage;
  });
});
