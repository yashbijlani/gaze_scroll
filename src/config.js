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
  face: {    // Standalone MediaPipe Tasks FaceLandmarker: independent of WebGazer's
    // bundled 2021 facemesh stack. Drives the eye overlay + face presence.
    // Pinned: tasks-vision 0.10.35 ships vision_bundle.mjs + wasm/.
    enabled: true,
    detectIntervalMs: 150,
    delegate: 'GPU', // auto-retries CPU on failure
    bundleUrl: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/vision_bundle.mjs',
    wasmBase: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm',
    modelUrl:
      'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
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
    samplesPerPoint: 5, // repeated recordScreenPosition taps per point
    qualityThresholdPx: 160, // predicted-vs-target spread flagging poor cal
    persistKey: 'gazeScroll.calibration.v1',
  },
  velocity: {
    // EMA smoothing for the velocity signal itself (0..1, higher = smoother).
    emaAlpha: 0.35,
    // Above this speed the sample counts as saccade-like movement.
    saccadeThresholdPxPerS: 450,
    // Below this speed (sustained) the gaze counts as stable/reading.
    stableThresholdPxPerS: 120,
    minDtMs: 8,
    maxDtMs: 250,
  },
  events: {
    trackingLostGapMs: 800, // no-sample gap declaring TRACKING_LOST
    edgeBandPx: 140, // distance from viewport edge defining edge zone
    edgeDwellMs: 900, // sustained edge presence before EDGE_DWELL_STARTED
    movementMinDurationMs: 150,
  },
  intent: {
    // Evidence weights for the LOOKING_DOWN/UP hypotheses (sum ≈ 1).
    wEdge: 0.3,
    wVelocity: 0.3,
    wPersistence: 0.2,
    wFixation: 0.1,
    wConfidence: 0.1,
    enterThreshold: 0.62, // score needed to ENTER a directional intent
    exitThreshold: 0.42, // score below which we LEAVE it (hysteresis band)
    minActivationMs: 700, // evidence must persist this long before acting
    minConfidence: 0.35, // below this → UNCERTAIN/TRACKING_LOST, never scroll
  },
  scroll: {    mode: 'edge', // 'discrete' | 'smooth' | 'edge' | 'reading' | 'predictive' | 'off'
    maxVelocityPxPerS: 900,
    minActivationMs: 700,
    discreteChunkPx: 320, // ~one reading chunk per discrete step
    discreteCooldownMs: 1200,
    edgeProportionalGain: 2.2, // edge mode: vel = depth01 * maxVel * gain (clamped)
    accelPxPerS2: 2600, // smooth ramp up/down
    manualOverridePauseMs: 2500, // wheel/key/touch suppresses auto-scroll
    requireFixationForEdge: false,
  },
  logging: {
    bufferSize: 600,
    consoleLog: false,
    panelRows: 8,
    panelRefreshMs: 100,
  },
  gaze: {
    // Gaze estimator. 'landmarker' drives WebGazer's ridge regression with
    // eye patches cut from our own working landmarks (see gaze/landmarker.js);
    // 'webgazer' uses WebGazer's bundled detector loop (needs its model
    // files healthy). Switch takes effect on (re)start.
    provider: 'landmarker',
  },
};
