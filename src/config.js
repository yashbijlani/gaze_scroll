// Central configuration for the gaze-scroll MVP.
// Tune these after collecting real gaze logs (see ROADMAP.md Phase 1).
export const CONFIG = {
  webgazer: {
    tracker: 'TFFacemesh',
    regression: 'ridge', // 'ridge' | 'weightedRidge' | 'threadedRidge'
    applyKalmanFilter: true,
    saveDataAcrossSessions: false, // keep MVP session-only (privacy)
    videoViewerWidth: 240,
    videoViewerHeight: 180,
    loadTimeoutMs: 20000,
    // WebGazer 2.x TFFacemesh loads MediaPipe solution files (wasm + model)
    // relative to `faceMeshSolutionPath`. The bundled default is
    // './mediapipe/face_mesh', which 404s on any site that does not self-host
    // those files — the detector then rejects on the first frame and
    // WebGazer's rAF loop dies silently ("camera opens for a second, then
    // stops"). Point it at a pinned CDN copy instead. Pin the patch version:
    // @mediapipe/face_mesh@0.4.165... had a broken WASM build, so stay on
    // the known-good 0.4.1633559619 until WebGazer moves runtimes.
    faceMeshSolutionPath:
      'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh@0.4.1633559619',
  },
  smoothing: {
    // One Euro filter params: minCutoff (jitter at rest), beta (lag vs speed).
    minCutoff: 1.0,
    beta: 0.3,
    dCutoff: 1.0,
  },
  fixation: {
    // I-DT detector: samples inside a rolling window count as a fixation
    // while their spatial spread stays under dispersionThresholdPx.
    windowMs: 200,
    dispersionThresholdPx: 40,
    minDurationMs: 120,
  },
  calibration: {
    points: 9, // 9 (3x3 grid) or 5 (corners + center)
    gridMargin: 0.1, // fraction of viewport inset from edges
  },
  logging: {
    bufferSize: 600,
    consoleLog: false,
    panelRows: 8,
    panelRefreshMs: 100,
  },
};
