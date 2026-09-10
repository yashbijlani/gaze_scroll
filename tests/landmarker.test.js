import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { eyeBox, buildEyeObjects, LandmarkerGazeProvider } from '../src/gaze/landmarker.js';
import { EyeIndices } from '../src/overlay.js';

// Synthetic 478-landmark cloud: tight left cluster + tight right cluster.
function fakePositions() {
  const pts = Array.from({ length: 478 }, () => [0, 0, 0]);
  EyeIndices.left.forEach((idx, k) => {
    pts[idx] = [100 + (k % 5) * 6, 100 + (k % 3) * 6, 0];
  });
  EyeIndices.right.forEach((idx, k) => {
    pts[idx] = [300 + (k % 5) * 6, 100 + (k % 3) * 6, 0];
  });
  return pts;
}

const stubGrabber = () => (x, y, w, h) => ({ stub: true, x, y, w, h });
const stubVideo = { videoWidth: 640, videoHeight: 480, readyState: 4 };

function stubReg() {
  return {
    data: [],
    addData(eyes, target) {
      this.data.push([eyes, target]);
    },
    predict() {
      return this.data.length ? { x: 640, y: 400 } : null;
    },
    getData() {
      return this.data;
    },
  };
}

describe('eyeBox / buildEyeObjects', () => {
  it('bounds an eye cluster with padding', () => {
    const box = eyeBox(EyeIndices.left, fakePositions(), 640, 480);
    assert.ok(box.w > 20 && box.h > 10, `sized box: ${JSON.stringify(box)}`);
    assert.ok(box.x >= 0 && box.y >= 0);
  });

  it('returns null for empty landmarks', () => {
    assert.equal(eyeBox(EyeIndices.left, [], 640, 480), null);
    assert.equal(buildEyeObjects([], 640, 480, stubGrabber()), null);
    assert.equal(buildEyeObjects(fakePositions().slice(0, 50), 640, 480, stubGrabber()), null);
  });

  it('builds tracker-shaped eye objects via the injected grabber', () => {
    const eyes = buildEyeObjects(fakePositions(), 640, 480, stubGrabber());
    assert.ok(eyes.left.patch.stub && eyes.right.patch.stub);
    assert.ok(eyes.left.width >= 4 && eyes.right.height >= 4);
  });

  it('returns null when the grabber fails', () => {
    assert.equal(buildEyeObjects(fakePositions(), 640, 480, () => null), null);
  });
});

describe('LandmarkerGazeProvider', () => {
  let reg;
  let tracker;

  before(() => {
    reg = stubReg();
    global.window = {
      innerWidth: 1280,
      innerHeight: 800,
      webgazer: { getRegression: () => [reg], pauseCalls: 0, pause() { this.pauseCalls++; } },
    };
    tracker = {
      began: 0,
      calibratedCount: 0,
      async begin() {
        this.began++;
      },
      end() {},
      computeConfidence: () => 0.9,
    };
  });

  after(() => {
    delete global.window;
  });

  function makeProvider(facePositions) {
    const faceDetector = { detect: async () => (facePositions ? { positions: facePositions } : null) };
    return new LandmarkerGazeProvider({
      tracker,
      smoother: { filter: (x, y) => ({ x, y }), reset() {} },
      faceDetector,
      getVideo: () => stubVideo,
      createGrabber: stubGrabber,
      tickMs: 20,
      taps: 3,
    });
  }

  it('start() begins tracking and parks WebGazer loop', async () => {
    const p = makeProvider(fakePositions());
    await p.start();
    assert.equal(tracker.began, 1);
    assert.equal(global.window.webgazer.pauseCalls, 1);
    await p.stop();
  });

  it('calibrateAt stores taps in the provider mapper; 0 without a face', async () => {
    const p = makeProvider(fakePositions());
    assert.equal(await p.calibrateAt(100, 200), 3);
    assert.equal(p.storedCount(), 3);
    assert.equal(tracker.calibratedCount, 3);
    const noFace = makeProvider(null);
    assert.equal(await noFace.calibrateAt(100, 200), 0);
    assert.equal(p.storedCount(), 3);
  });

  it('predictOnce is null before data, near target after', async () => {
    const p = makeProvider(fakePositions());
    assert.equal(await p.predictOnce(), null);
    assert.equal(p.lastNullReason, 'no-prediction');
    await p.calibrateAt(100, 200);
    const pred = await p.predictOnce();
    assert.ok(pred, 'predicts after training');
    assert.ok(Math.abs(pred.x - 100) < 60 && Math.abs(pred.y - 200) < 60,
      `near target, got ${JSON.stringify(pred)}`);
  });

  it('tick emits normalized samples; stop() halts', async () => {
    const p = makeProvider(fakePositions());
    await p.calibrateAt(100, 200);
    const got = [];
    p.subscribe((s) => got.push(s));
    await p.start();
    await new Promise((r) => setTimeout(r, 80));
    await p.stop();
    const n = got.length;
    assert.ok(n >= 1, 'emitted while running');
    const s = got[0];
    assert.ok(Math.abs(s.normalizedX - 100 / 1280) < 0.05, `nx ≈ target: ${s.normalizedX}`);
    assert.equal(s.confidence, 0.9);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(got.length, n, 'silent after stop');
  });
});

describe('LandmarkerGazeProvider failure reasons', () => {
  function baseProvider(overrides = {}) {
    const reg = stubReg();
    global.window = global.window ?? { innerWidth: 1280, innerHeight: 800, webgazer: {} };
    const tracker = {
      calibratedCount: 0,
      async begin() {},
      end() {},
      computeConfidence: () => 0.9,
    };
    return new LandmarkerGazeProvider({
      tracker,
      smoother: { filter: (x, y) => ({ x, y }), reset() {} },
      faceDetector: { detect: async () => ({ positions: fakePositions() }) },
      getVideo: () => stubVideo,
      createGrabber: stubGrabber,
      ...overrides,
    });
  }

  it('names each failure stage', async () => {    // no-video
    const noVideo = baseProvider({ getVideo: () => null });
    assert.equal(await noVideo.predictOnce(), null);
    assert.equal(noVideo.lastNullReason, 'no-video');

    // no-face
    const noFace = baseProvider({ faceDetector: { detect: async () => null } });
    assert.equal(await noFace.predictOnce(), null);
    assert.equal(noFace.lastNullReason, 'no-face');

    // no-eyes (grabber fails)
    const noEyes = baseProvider({ createGrabber: () => () => null });
    assert.equal(await noEyes.predictOnce(), null);
    assert.equal(noEyes.lastNullReason, 'no-eyes');

    // untrained mapper → no-prediction (own store, no external reg needed)
    const untrained = baseProvider();
    assert.equal(await untrained.predictOnce(), null);
    assert.equal(untrained.lastNullReason, 'no-prediction');
    assert.ok((await untrained.calibrateAt(10, 10)) > 0, 'own mapper always stores');
    assert.ok(untrained.storedCount() > 0);

    // success clears the reason
    const ok = baseProvider();
    ok.lastNullReason = 'stale';
    await ok.calibrateAt(100, 200);
    assert.ok(await ok.predictOnce());
    assert.equal(ok.lastNullReason, null);
  });

  it('own mapper stores verifiably — counters only count stored taps', async () => {
    const tracker = {
      calibratedCount: 0,
      async begin() {},
      end() {},
      computeConfidence: () => 0.9,
    };
    const p = new LandmarkerGazeProvider({
      tracker,
      smoother: { filter: (x, y) => ({ x, y }), reset() {} },
      faceDetector: { detect: async () => ({ positions: fakePositions() }) },
      getVideo: () => stubVideo,
      createGrabber: stubGrabber,
      taps: 5,
    });
    assert.equal(await p.calibrateAt(100, 200), 5);
    assert.equal(p.storedCount(), 5);
    assert.equal(tracker.calibratedCount, 5);
  });
});
