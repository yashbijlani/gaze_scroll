// App entry: owns the UI state machine and wires the gaze pipeline.
//
// Per-sample flow:
//   webgazer -> tracker -> smoother (One Euro) -> fixation detector (I-DT)
//           -> confidence proxy -> logger + overlay
//
// MVP state machine:
//   camera:   idle -> requested -> granted|denied|error
//   tracking: off -> starting -> running
import { CONFIG } from './config.js';
import { supportsGetUserMedia } from './camera.js';
import { GazeTracker } from './tracker.js';
import { GazeSmoother } from './smoothing.js';
import { Overlay } from './overlay.js';
import { CalibrationFlow } from './calibration.js';
import { GazeLogger } from './logger.js';
import { WebGazerProvider } from './gaze/provider.js';
import { LandmarkerGazeProvider } from './gaze/landmarker.js';
import { GazeEventDetector } from './gaze/events.js';
import { IntentEngine } from './gaze/intent.js';
import { ScrollController, ScrollModes } from './gaze/scroll.js';
import { ReadingTracker } from './gaze/reading.js';
import { gazeTarget, textBelowRatio } from './gaze/dom.js';
import { SessionRecorder, ReplayDriver } from './gaze/session.js';
import { StandaloneFaceDetector } from './gaze/face.js';
import { LabController } from './lab.js';

const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'),
  stats: $('stats'),
  consentGate: $('consent-gate'),
  btnEnable: $('btn-enable'),
  consentError: $('consent-error'),
  btnCalibrate: $('btn-calibrate'),
  btnRecalibrate: $('btn-recalibrate'),
  btnRestart: $('btn-restart'),
  selProvider: $('sel-provider'),
  chkVideo: $('chk-video'),
  chkCursor: $('chk-cursor'),
  btnDownload: $('btn-download'),
  btnClearLog: $('btn-clear-log'),
  btnDiag: $('btn-diag'),
  logBody: $('log-body'),
  logCount: $('log-count'),
  cursor: $('gaze-cursor'),
  calLayer: $('calibration-layer'),
  calStatus: $('cal-status'),
  selMode: $('sel-mode'),
  chkAutoscroll: $('chk-autoscroll'),
  btnEstop: $('btn-estop'),
  rngSensitivity: $('rng-sensitivity'),
  sensitivityVal: $('sensitivity-val'),
  selCalPoints: $('sel-calpoints'),
  btnSkipCal: $('btn-skip-cal'),
  btnRecord: $('btn-record'),
  btnExportSession: $('btn-export-session'),
  btnClearSession: $('btn-clear-session'),
  fileReplay: $('file-replay'),
  btnReplayPlay: $('btn-replay-play'),
  btnReplayRestart: $('btn-replay-restart'),
  selReplaySpeed: $('sel-replay-speed'),
  replayProgress: $('replay-progress'),
  sessionInfo: $('session-info'),
};

const tracker = new GazeTracker(CONFIG.webgazer);
// Window-level error capture: console filters hide warnings/info, and some
// failures surface only here. Kept to the last 12, shipped with diagnostics.
const errorLog = [];
function captureError(kind, message) {
  errorLog.push({ t: new Date().toISOString(), kind, message: String(message).slice(0, 500) });
  if (errorLog.length > 12) errorLog.shift();
}
window.addEventListener('error', (e) => captureError('error', e.message || e.error?.message || e.error));
window.addEventListener('unhandledrejection', (e) =>
  captureError('unhandledrejection', e.reason?.message ?? e.reason),
);
const smoother = new GazeSmoother(CONFIG.smoothing);
const overlay = new Overlay({ cursorEl: els.cursor });
const calibration = new CalibrationFlow(tracker, CONFIG.calibration, els.calLayer);
const logger = new GazeLogger(CONFIG.logging);
// Gaze → evidence → intent → action pipeline (ARCHITECTURE.md §3).
const provider = new WebGazerProvider({ tracker, smoother });
const faceDetector = new StandaloneFaceDetector(CONFIG.face);
const activeVideo = () =>
  overlay.findWebgazerVideo() ?? document.getElementById('gaze-preview-fallback');
const landmarkerProvider = new LandmarkerGazeProvider({
  tracker,
  smoother,
  faceDetector,
  getVideo: activeVideo,
});
// Estimator choice (Controls select). Landmarker drives WebGazer's own
// ridge regression with our working landmarks; classic uses WebGazer's
// bundled detector loop. Read live at (re)start and calibration time.
function getActiveProvider() {
  return (CONFIG.gaze?.provider ?? 'landmarker') === 'webgazer' ? provider : landmarkerProvider;
}
function webgazerStoredCount() {
  try {
    return window.webgazer?.getRegression?.()?.[0]?.getData?.()?.length ?? null;
  } catch {
    return null;
  }
}
const eventDetector = new GazeEventDetector(CONFIG, null);
const intentEngine = new IntentEngine(
  { ...CONFIG.intent, edgeBandPx: CONFIG.events.edgeBandPx },
  null,
);
const readingTracker = new ReadingTracker();
const scrollController = new ScrollController(CONFIG.scroll, null);
const recorder = new SessionRecorder();
const lab = new LabController();
let replay = null;
let replaying = false;
let autoScroll = false;

let showCursor = true;
let lastGazeT = 0;
let samplesThisSecond = 0;
let lastPanelRender = 0;
let lastLabRender = 0;
// Watchdog state: WebGazer's internal rAF loop dies silently if the face
// model fails to load, so we detect "camera on, zero samples" here.
let trackingRunning = false;
let trackingStartedAt = 0;
let stallWarned = false;
let enableInFlight = false;
let wasVideoLive = false;
let sampleUnsub = null; // handleSample subscription (cleared on restart/switch)
let eventUnsub = null; // lab event-log subscription (same)let lastFaceT = 0; // last time a face was observed (either detector)
let lastLandmarks = 0; // last time face landmarks were observed
let lastFaceSource = null; // 'webgazer' | 'landmarker' | null
let lastStandaloneDetect = 0;
let faceDetectBusy = false;
// Latest pipeline snapshot for the lab (written per sample, read at 10Hz).
let latestSnapshot = null;
let lastDomFullT = 0;
let lastDomFull = { textBelow: 0.5 };
let lastScrollVel = 0;
let lastValidGaze = null; // last predicted position (holdover cursor source)
const HOLDOVER_MS = 1200; // estimated cursor survives gaps this long

function setStatus(msg) {
  els.status.textContent = msg;
}

// The consent gate covers the whole page, so a failure message written
// only to the background status panel is invisible. Mirror it into the modal.
function setConsentError(msg) {
  if (!els.consentError) return;
  if (!msg) {
    els.consentError.hidden = true;
    els.consentError.textContent = '';
  } else {
    els.consentError.textContent = msg;
    els.consentError.hidden = false;
  }
}

function setControlsEnabled(running) {
  els.btnCalibrate.disabled = !running;
  els.btnRecalibrate.disabled = !running;
  els.btnDownload.disabled = !running;
  els.btnClearLog.disabled = !running;
  if (els.btnRestart) els.btnRestart.disabled = !running;
  if (els.btnSkipCal) els.btnSkipCal.disabled = !running;
}

// Full pipeline for one normalized provider sample (live or replayed):
// events → intent → DOM/reading → scroll controller → log/overlay/lab.
// Structured so replay drives the identical path without a camera.
function handleSample(sample) {
  samplesThisSecond += 1;
  const t = sample?.timestamp ?? performance.now();
  if (sample && sample.x != null) lastGazeT = t;
  if (sample?.hasFace) lastFaceT = t;

  const analysis = eventDetector.update(sample);
  if (analysis.lost) {
    overlay.hideGaze();
    const lostIntent = intentEngine.update(sample, analysis, scrollContext());
    scrollController.updateIntent(lostIntent, analysis.edge, t);
    logPipeline(sample, analysis, lostIntent, null, null);
    return;
  }

  // Face here, gaze unknown (blink, uncalibrated model): keep an estimated
  // cursor alive briefly (holdover) so momentary gaps don't blink the UI,
  // then hide. Intent stays UNCERTAIN — holdover never drives scrolling.
  if (!sample || sample.x == null || sample.y == null) {
    const intent = intentEngine.update(sample, analysis, scrollContext());
    scrollController.updateIntent(intent, analysis.edge, t);
    logPipeline(sample, analysis, intent, null, null);
    if (
      showCursor &&
      lastValidGaze &&
      t - lastValidGaze.t < HOLDOVER_MS &&
      Number.isFinite(lastValidGaze.x)
    ) {
      overlay.drawGaze(lastValidGaze.x, lastValidGaze.y, 0.15, { state: 'unknown' });
    } else {
      overlay.hideGaze();
    }
    return;
  }
  lastValidGaze = { x: sample.x, y: sample.y, t, confidence: sample.confidence ?? 0 };

  const intent = intentEngine.update(sample, analysis, scrollContext());
  // DOM signals: cheap per-sample target + throttled text-below scan
  // (8× elementFromPoint is too heavy at full sample rate).
  const target = gazeTarget(sample.x, sample.y);
  if (t - lastDomFullT > 200) {
    lastDomFullT = t;
    lastDomFull = { textBelow: textBelowRatio(sample.x, sample.y) };
  }
  const dom = { role: target.role, onText: target.onText, textBelow: lastDomFull.textBelow };
  const reading = readingTracker.update(analysis.fixation, dom, t);

  scrollController.setReading(reading);
  scrollController.updateIntent(intent, analysis.edge, t);

  logPipeline(sample, analysis, intent, reading, dom);

  if (showCursor) overlay.drawGaze(sample.x, sample.y, sample.confidence, analysis.fixation);
  else overlay.hideGaze();

  latestSnapshot = {
    sample,
    velocity: analysis.velocity,
    fixation: analysis.fixation,
    edge: analysis.edge,
    intent,
    reading,
    dom,
    scrollVel: lastScrollVel,
    tracking: trackingLabel(sample),
    calQuality: calQualityLabel(),
    face: faceLabel(t),
  };
  lab.pushTrail(
    sample.rawX != null ? { x: sample.rawX, y: sample.rawY } : null,
    { x: sample.x, y: sample.y },
  );
}

function scrollContext() {
  try {
    return {
      scrollY: window.scrollY,
      maxScrollY: document.documentElement.scrollHeight - window.innerHeight,
    };
  } catch {
    return {};
  }
}

function trackingLabel(sample) {
  if (!trackingRunning && !replaying) return 'idle';
  if (eventDetector.lost) return 'lost';
  // Face visible but the model has never produced a position: the honest
  // state is "needs calibration", not any flavor of lost/broken.
  if (faceDetected() && lastGazeT === 0) return 'face detected · calibrate for gaze';
  if (faceDetected() && sample?.x == null) return 'face detected · gaze unknown';
  if ((sample?.confidence ?? 0) < (CONFIG.intent.minConfidence ?? 0.35)) return 'low confidence';
  if (!autoScroll) return 'tracking (scroll off)';
  if (scrollController.overridden()) return 'paused (manual override)';
  return 'tracking';
}

function calQualityLabel() {
  const q = calibration.lastQuality;
  if (!q) return '—';
  if (q.label === 'skipped') return `skipped (${q.points} pts)`;
  if (q.meanErrPx != null) return `${q.label} (~${q.meanErrPx}px)`;
  return q.label;
}

// Face presence from either channel (sample eye features or landmarks).
function faceDetected(t = performance.now()) {
  return t - lastFaceT < 1500 || t - lastLandmarks < 1500;
}

function faceLabel(t) {
  if (!trackingRunning && !replaying) return '—';
  if (!faceDetected(t)) return 'searching…';
  return lastFaceSource ? `detected (${lastFaceSource})` : 'detected';
}

// Face overlay from two independent sources: WebGazer's bundled landmarks
// when they exist, otherwise our standalone FaceLandmarker (throttled).
// Either source feeds presence (lastFaceT) for the pill, lab, and the
// calibration face gate. Never throws; async overlap guarded.
async function updateFaceOverlay() {
  const canvas = $('face-overlay');
  if (!canvas) return 0;
  try {
    const video =
      overlay.findWebgazerVideo() ?? document.getElementById('gaze-preview-fallback');
    if (!video || !trackingRunning) {
      overlay.hideFaceOverlay(canvas);
      return 0;
    }
    let positions = null;
    try {
      const wgPositions = window.webgazer?.getTracker?.()?.getPositions?.();
      if (wgPositions && wgPositions.length >= 100) {
        positions = wgPositions;
        lastFaceSource = 'webgazer';
      }
    } catch {
      /* fall through to standalone */
    }
    const now = performance.now();
    if (
      !positions &&
      faceDetector.enabled &&
      !faceDetectBusy &&
      now - lastStandaloneDetect >= (CONFIG.face.detectIntervalMs ?? 150)
    ) {
      faceDetectBusy = true;
      try {
        const r = await faceDetector.detect(video, now);
        if (r && r.positions.length >= 100) {
          positions = r.positions;
          lastFaceSource = 'landmarker';
        }
      } finally {
        faceDetectBusy = false;
        lastStandaloneDetect = performance.now();
      }
    }
    if (!positions || positions.length < 100) {
      overlay.hideFaceOverlay(canvas);
      return 0;
    }
    canvas.hidden = false;
    const n = overlay.renderFaceOverlay(canvas, video, positions);
    if (n > 0) {
      lastLandmarks = performance.now();
      lastFaceT = lastLandmarks;
    } else {
      overlay.hideFaceOverlay(canvas);
    }
    return n;
  } catch {
    return 0;
  }
}

function logPipeline(sample, analysis, intent, reading, dom) {
  const row = {
    t: sample?.timestamp ?? performance.now(),
    epoch: Date.now(),
    rawX: sample?.rawX ?? sample?.x ?? null,
    rawY: sample?.rawY ?? sample?.y ?? null,
    smoothX: sample?.x ?? null,
    smoothY: sample?.y ?? null,
    confidence: sample?.confidence ?? 0,
    fixationState: analysis?.fixation?.state ?? 'lost',
    fixationDurationMs: Math.round(analysis?.fixation?.durationMs ?? 0),
    hasFace: !!sample?.hasFace,
    // Extended fields: ignored by the CSV export, used by lab + sessions.
    intent: intent?.intent ?? null,
    intentConf: intent?.confidence ?? null,
    scrollVel: lastScrollVel,
    scrollMode: scrollController.mode,
  };
  logger.log(row);
  recorder.record({
    timestamp: row.t,
    x: row.smoothX,
    y: row.smoothY,
    nx: sample?.normalizedX ?? null,
    ny: sample?.normalizedY ?? null,
    confidence: row.confidence,
    hasFace: row.hasFace,
    vx: analysis?.velocity?.vx ?? 0,
    vy: analysis?.velocity?.vy ?? 0,
    speed: analysis?.velocity?.speed ?? 0,
    intent: row.intent,
    intentConf: row.intentConf,
    edge: analysis?.edge?.side ?? null,
    domRole: dom?.role ?? null,
    onText: dom?.onText ?? null,
    scrollY: scrollContext().scrollY ?? 0,
    scrollVel: lastScrollVel,
    mode: scrollController.mode,
  });
  if (latestSnapshot) latestSnapshot.scrollVel = lastScrollVel;
}

function renderLogPanel() {
  const rows = logger.samples.slice(-CONFIG.logging.panelRows).reverse();
  if (rows.length === 0) {
    els.logBody.innerHTML = '<tr><td colspan="5" class="muted">No samples yet.</td></tr>';
  } else {
    els.logBody.innerHTML = rows
      .map((r) => {
        const raw = r.rawX == null ? '—' : `${Math.round(r.rawX)},${Math.round(r.rawY)}`;
        const sm = r.smoothX == null ? '—' : `${Math.round(r.smoothX)},${Math.round(r.smoothY)}`;
        return (
          `<tr><td>${(r.t / 1000).toFixed(1)}</td><td>${raw}</td>` +
          `<td>${sm}</td><td>${Number(r.confidence).toFixed(2)}</td>` +
          `<td>${r.fixationState}</td></tr>`
        );
      })
      .join('');
  }
  els.logCount.textContent = `${logger.count} samples (${logger.dropped} dropped)`;
}

function describeStartError(err) {
  const name = err?.name ?? '';
  const msg = err?.message ?? String(err);
  // getUserMedia failures: name the actual cause instead of a generic dump.
  if (name === 'NotAllowedError' || /permission|denied/i.test(msg)) {
    return (
      'Camera blocked: the browser denied access. Click the camera icon in ' +
      'the address bar → allow camera for localhost, close any other tab/app ' +
      'using the camera, then click “Enable camera & tracking” again.'
    );
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return (
      'Camera is busy: another tab or app is already using it (e.g. your ' +
      '“Camera Apps” tab). Close that tab/app and try again.'
    );
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return `No usable camera found (${msg}). Check the device is plugged in and not disabled.`;
  }
  if (/webgazer|CDN|neutered|setGazeListener/i.test(msg)) {
    return `Failed to start eye tracking: ${msg}`;
  }
  return (
    `Failed to start eye tracking: ${msg} ` +
    `(if the camera light came on, also check the console for MediaPipe/TF 404s — ` +
    `adblock or no network breaks model load).`
  );
}

async function onEnable() {
  if (enableInFlight || trackingRunning) return;
  enableInFlight = true;
  els.btnEnable.disabled = true;
  if (!supportsGetUserMedia()) {
    setStatus('This browser does not support webcam access (getUserMedia).');
    els.btnEnable.disabled = false;
    enableInFlight = false;
    return;
  }
  // Single camera acquisition, owned by WebGazer. (A previous version did
  // its own getUserMedia probe here and immediately stopped it before
  // tracker.begin() — that made the camera light blink on/off and risked a
  // NotReadableError race on rapid re-acquire. The browser permission prompt
  // from WebGazer's own getUserMedia call is the consent step.)
  // WebGazer startup can hang indefinitely (e.g. its internal
  // `loadeddata` wait never fires when autoplay is blocked or the device is
  // busy). Never leave the button stuck on "Starting…" — time-box it.
  setStatus('Requesting webcam permission & loading face model…');
  setConsentError(null);
  els.btnEnable.textContent = 'Starting…';
  const START_TIMEOUT_MS = 45000;
  const active = getActiveProvider();
  try {
    await Promise.race([
      active.start(),
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                'Timed out starting (45s). The camera may still be held by ' +
                  'another tab/app, or video autoplay was blocked — close ' +
                  'other camera tabs and try again.',
              ),
            ),
          START_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (err) {
    console.error('tracker.begin failed', err);
    const msg = describeStartError(err);
    setStatus(msg);
    setConsentError(msg);
    els.btnEnable.disabled = false;
    els.btnEnable.textContent = 'Enable camera & tracking';
    enableInFlight = false;
    return;
  }
  enableInFlight = false;
  setConsentError(null);

  trackingRunning = true;
  trackingStartedAt = performance.now();
  stallWarned = false;

  // Subscribe first: samples must flow even if cosmetic preview docking
  // fails below. The whole block is guarded so a preview/DOM failure can
  // never wedge the app on the consent gate (button stuck on "Starting…").
  try {
    // Restart/estimator-switch safe: never double-subscribe handleSample.
    if (sampleUnsub) {
      try {
        sampleUnsub();
      } catch {
        /* ignore */
      }
      sampleUnsub = null;
    }
    sampleUnsub = active.subscribe(handleSample);
    if (eventUnsub) {
      try {
        eventUnsub();
      } catch {
        /* ignore */
      }
      eventUnsub = null;
    }
    eventUnsub = eventDetector.subscribe((evt) => lab.logEvent(evt));
    overlay.dockCameraPreview(
      CONFIG.webgazer.videoViewerWidth,
      CONFIG.webgazer.videoViewerHeight,
    );
    // If WebGazer produced no video element, open our own preview-only
    // stream so the user can always see the camera (diagnostic + trust).
    const preview = await overlay.ensurePreview(
      CONFIG.webgazer.videoViewerWidth,
      CONFIG.webgazer.videoViewerHeight,
    );
    console.info('[gaze] preview', preview);
    if (!preview.ok) {
      console.warn('[gaze] no camera preview available', preview.error);
    }
  } catch (err) {
    console.warn('post-start UI setup issue (tracking continues)', err);
  }
  els.consentGate.style.display = 'none';
  els.btnEnable.textContent = 'Enable camera & tracking';
  setControlsEnabled(true);
  lab.setPill('tracking', 'tracking');
  // Report what actually came up: video element + stream liveness now, and
  // one probed prediction to capture the real detector error (if any) while
  // the user can still read it — not minutes later when the loop dies.
  try {
    const diag = tracker.diagnose();
    console.info('[gaze] startup diagnostics', diag);
    const v = diag.video;
    if (!v.found) {
      setStatus('Tracking started, but no camera <video> element found — predictions may still flow; check the Lab.');
    } else if (!v.live) {
      setStatus('Tracking started, but the camera track is not live yet — waiting for first frames…');
    } else {
      const [vw, vh] = v.videoSize;
      setStatus(
        `Tracking running (${vw || '?'}×${vh || '?'} video). Click “Calibrate” for better accuracy.`,
      );
    }
    tracker.probePrediction().then((probe) => {
      console.info('[gaze] prediction probe', probe);
      if (!probe.ok) {
        setStatus(
          `Camera is live but the face model isn't predicting yet: ${probe.error}. ` +
            `Face the camera in good light; if this persists, check console for MediaPipe 404s.`,
        );
      }
    });
  } catch (err) {
    console.warn('startup diagnostics skipped', err);
    setStatus('Tracking running. Click “Calibrate” for better accuracy.');
  }
}

async function onCalibrate() {
  els.btnCalibrate.disabled = true;
  lab.setPill('calibrating', 'calibrating');
  // Live-error source matches the active estimator.
  calibration.setPredictor(
    getActiveProvider() === landmarkerProvider ? () => landmarkerProvider.predictOnce() : null,
  );
  setStatus('Calibration running: look at each dot and click it.');
  const done = await calibration.start((d, n) => {
    els.calStatus.textContent = `Calibrated ${d}/${n}…`;
  });
  const q = calibration.lastQuality;
  els.calStatus.textContent =
    `Calibration ${q?.label ?? 'done'}: ${done} points recorded ` +
    `(${tracker.calibratedCount} total this session)` +
    (q?.meanErrPx != null ? `, mean error ~${q.meanErrPx}px` : '') +
    (q?.stored != null ? `, ${q.stored} eye samples in model.` : '.');
  setStatus('Calibration complete. Everyday clicks keep training the model implicitly.');
  els.btnCalibrate.disabled = false;
  lab.setPill('tracking', 'tracking');
}

async function onResetCalibration() {
  await tracker.clear();
  smoother.reset();
  eventDetector.reset();
  intentEngine.reset();
  readingTracker.reset();
  lab.clearTrail();
  els.calStatus.textContent = 'Not calibrated.';
  setStatus('Calibration data cleared. Run “Calibrate” to retrain.');
}

// Tear down the camera + pipeline without reloading the page, then run the
// normal enable flow again (consent already granted, so no second prompt).
async function onRestartCamera() {
  if (enableInFlight) return;
  setStatus('Restarting camera…');
  stallWarned = false;
  try {
    await provider.stop();
  } catch (err) {
    console.warn('camera stop during restart', err);
  }
  try {
    await landmarkerProvider.stop();
  } catch (err) {
    console.warn('landmarker stop during restart', err);
  }
  trackingRunning = false;
  lastGazeT = 0;
  lastValidGaze = null;
  latestSnapshot = null;
  eventDetector.reset();
  intentEngine.reset();
  readingTracker.reset();
  smoother.reset();
  lab.clearTrail();
  overlay.hideGaze();
  overlay.releaseFallbackPreview();
  faceDetector.resetFailure();
  await onEnable();
}

// --- Scroll controls: mode, enable, e-stop, sensitivity. ---

function bindScrollControls() {
  scrollController.setMode(CONFIG.scroll.mode ?? 'smooth');
  if (els.selMode) {
    els.selMode.value = scrollController.mode;
    els.selMode.addEventListener('change', (e) => {
      scrollController.setMode(e.target.value);
      setStatus(`Scroll mode: ${e.target.value}.`);
    });
  }
  if (els.chkAutoscroll) {
    els.chkAutoscroll.addEventListener('change', (e) => {
      autoScroll = e.target.checked;
      scrollController.setEnabled(autoScroll);
      setStatus(autoScroll ? 'Automatic scrolling enabled.' : 'Automatic scrolling off.');
      updatePill();
    });
  }
  if (els.btnEstop) {
    els.btnEstop.addEventListener('click', () => {
      autoScroll = false;
      scrollController.setEnabled(false);
      if (els.chkAutoscroll) els.chkAutoscroll.checked = false;
      setStatus('Automatic scrolling stopped. Re-enable it above when ready.');
      updatePill();
    });
  }
  if (els.rngSensitivity) {
    const apply = () => {
      const v = Number(els.rngSensitivity.value);
      CONFIG.scroll.maxVelocityPxPerS = v;
      if (els.sensitivityVal) els.sensitivityVal.textContent = `${v} px/s`;
    };
    els.rngSensitivity.addEventListener('input', apply);
    apply();
  }
  if (els.selCalPoints) {
    els.selCalPoints.value = String(CONFIG.calibration.points ?? 9);
    els.selCalPoints.addEventListener('change', (e) => {
      CONFIG.calibration.points = Number(e.target.value);
    });
  }
  if (els.selProvider) {
    els.selProvider.value = CONFIG.gaze?.provider ?? 'landmarker';
    els.selProvider.addEventListener('change', (e) => {
      CONFIG.gaze.provider = e.target.value;
      setStatus(
        trackingRunning
          ? `Estimator → ${e.target.value}. Takes effect on “Restart camera”.`
          : `Estimator → ${e.target.value}.`,
      );
    });
  }
  if (els.btnSkipCal) {
    els.btnSkipCal.addEventListener('click', () => {
      els.calStatus.textContent = 'Calibration skipped — tracking without a personal mapping.';
      setStatus('Calibration skipped. You can calibrate later for better accuracy.');
    });
  }
}

// rAF loop advancing the scroll controller; velocity feeds the lab.
let lastRafT = null;
function startScrollLoop() {
  const frame = (t) => {
    if (lastRafT != null) {
      const dtS = (t - lastRafT) / 1000;
      lastScrollVel = scrollController.velocity;
      scrollController.tick(dtS, t);
      lastScrollVel = scrollController.velocity;
    }
    lastRafT = t;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function updatePill() {
  if (!trackingRunning && !replaying) {
    lab.hidePill();
    return;
  }
  const s = latestSnapshot?.sample;
  const conf = s?.confidence ?? 0;
  if (eventDetector.lost) return lab.setPill('lost', 'tracking lost');
  if (!faceDetected()) return lab.setPill('low', 'no face detected');
  if (lastGazeT === 0) return lab.setPill('paused', 'face ok · calibrate for gaze');
  if (conf < (CONFIG.intent.minConfidence ?? 0.35)) return lab.setPill('low', 'low confidence');
  if (!autoScroll) return lab.setPill('paused', 'tracking · scroll off');
  if (scrollController.overridden()) return lab.setPill('paused', 'paused · you scrolled');
  if (calibration.running) return lab.setPill('calibrating', 'calibrating');
  lab.setPill('tracking', `tracking · ${scrollController.mode}`);
}

// --- Lab: parameters, sessions, replay. ---

function bindLabControls() {
  const num = (el, fn) => {
    if (!el) return;
    el.addEventListener('change', () => {
      const v = Number(el.value);
      if (Number.isFinite(v)) fn(v);
    });
  };
  num($('prm-minconf'), (v) => {
    CONFIG.intent.minConfidence = v;
  });
  num($('prm-velthresh'), (v) => {
    CONFIG.velocity.saccadeThresholdPxPerS = v;
    eventDetector.velocityCfg.saccadeThresholdPxPerS = v;
  });
  num($('prm-fixthresh'), (v) => {
    CONFIG.fixation.dispersionThresholdPx = v;
    eventDetector.fixationCfg.dispersionThresholdPx = v;
  });
  num($('prm-beta'), (v) => {
    CONFIG.smoothing.beta = v;
    smoother.fx.beta = v;
    smoother.fy.beta = v;
  });
  num($('prm-history'), (v) => {
    CONFIG.logging.bufferSize = v;
    logger.bufferSize = v;
  });

  if (els.btnRecord) {
    els.btnRecord.addEventListener('click', () => {
      if (!recorder.recording) {
        recorder.start();
        els.btnRecord.textContent = 'Stop';
        setStatus('Recording gaze session (numbers only, no video).');
      } else {
        const n = recorder.stop();
        els.btnRecord.textContent = 'Record';
        if (els.btnExportSession) els.btnExportSession.disabled = n === 0;
        if (els.sessionInfo) els.sessionInfo.textContent = `${n} rows recorded`;
        setStatus(`Recording stopped: ${n} rows. Export it as JSON when ready.`);
      }
    });
  }
  if (els.btnExportSession) {
    els.btnExportSession.addEventListener('click', () => {
      recorder.download(null, {
        scrollMode: scrollController.mode,
        config: snapshotConfig(),
        calibration: calibration.lastQuality,
      });
    });
  }
  if (els.btnClearSession) {
    els.btnClearSession.addEventListener('click', () => {
      recorder.clear();
      if (els.btnExportSession) els.btnExportSession.disabled = true;
      if (els.sessionInfo) els.sessionInfo.textContent = '0 rows recorded';
    });
  }
  if (els.fileReplay) {
    els.fileReplay.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const session = JSON.parse(await file.text());
        SessionRecorder.validate(session);
        replay = new ReplayDriver(session, {
          onSample: (row) => handleSample(ReplayDriver.toSample(row)),
          onProgress: (p, i, n) => {
            if (els.replayProgress) els.replayProgress.style.width = `${Math.round(p * 100)}%`;
            if (els.sessionInfo) els.sessionInfo.textContent = `Replaying ${i}/${n}`;
          },
          onDone: () => {
            replaying = false;
            if (els.btnReplayPlay) els.btnReplayPlay.textContent = 'Play';
            setStatus('Replay finished.');
            updatePill();
          },
        });
        replay.setSpeed(Number(els.selReplaySpeed?.value ?? 1));
        if (els.btnReplayPlay) {
          els.btnReplayPlay.disabled = false;
          els.btnReplayPlay.textContent = 'Play';
        }
        if (els.btnReplayRestart) els.btnReplayRestart.disabled = false;
        setStatus(`Replay loaded: ${replay.length} rows. Press Play — no webcam needed.`);
      } catch (err) {
        setStatus(`Could not load replay: ${err.message}`);
      }
    });
  }
  if (els.btnReplayPlay) {
    els.btnReplayPlay.addEventListener('click', () => {
      if (!replay) return;
      if (replaying) {
        replay.pause();
        replaying = false;
        els.btnReplayPlay.textContent = 'Play';
      } else {
        if (replay.idx >= replay.length) replay.idx = 0;
        replaying = true;
        replay.play();
        els.btnReplayPlay.textContent = 'Pause';
        lab.setPill('tracking', 'replaying');
      }
    });
  }
  if (els.btnReplayRestart) {
    els.btnReplayRestart.addEventListener('click', () => {
      if (!replay) return;
      eventDetector.reset();
      intentEngine.reset();
      readingTracker.reset();
      replaying = true;
      replay.restart();
      if (els.btnReplayPlay) els.btnReplayPlay.textContent = 'Pause';
    });
  }
  if (els.selReplaySpeed) {
    els.selReplaySpeed.addEventListener('change', (e) => replay?.setSpeed(Number(e.target.value)));
  }
}

// Stall triage: tell "camera track died" apart from "model dead", because
// the fixes differ (restart camera vs unblock model files / show face).
async function diagnoseStall(prefix) {
  let video = null;
  try {
    video = tracker.videoState();
  } catch {
    video = null;
  }
  if (video && video.found && !video.live) {
    setStatus(
      `${prefix} The camera track itself ended (OS/browser/another tab took it). ` +
        `Press “Restart camera” in Controls.`,
    );
    lab.setPill('lost', 'camera stopped');
    return;
  }
  setStatus(`${prefix} Checking the face model… (see console for details)`);
  try {
    const probe = await tracker.probePrediction();
    console.info('[gaze] stall probe', probe, video);
    if (!probe.ok) {
      setStatus(
        `${prefix} Camera looks live but the detector says: ${probe.error}. ` +
          `Face the camera in good light; if it persists, check console for MediaPipe 404s/adblock, ` +
          `or press “Restart camera”.`,
      );
    } else {
      setStatus(
        `${prefix} The detector answers when asked, so the prediction loop likely died on a ` +
          `transient error — press “Restart camera”.`,
      );
    }
  } catch (err) {
    console.warn('stall probe failed', err);
    setStatus(`${prefix} Press “Restart camera”. (Probe error in console.)`);
  }
  lab.setPill('lost', 'tracking stalled');
}

function snapshotConfig() {
  return {
    gaze: { ...CONFIG.gaze },
    intent: { ...CONFIG.intent },
    scroll: { ...CONFIG.scroll, mode: scrollController.mode },
    velocity: { ...CONFIG.velocity },
    fixation: { ...CONFIG.fixation },
    events: { ...CONFIG.events },
  };
}

function buildDiagnostics() {
  let webgazer = null;
  try {
    webgazer = tracker.diagnose();
  } catch (err) {
    webgazer = { error: String(err?.message ?? err) };
  }
  return {
    when: new Date().toISOString(),
    page: window.location.href,
    userAgent: navigator.userAgent,
    secureContext: window.isSecureContext,
    tracking: {
      trackingRunning,
      replaying,
      samples: logger.count,
      dropped: logger.dropped,
      lastSampleAgeMs: lastGazeT ? Math.round(performance.now() - lastGazeT) : null,
      wasVideoLive,
    },
    webgazer,
    previewFallback: !!overlay.fallbackStream,
    face: { state: faceDetector.state, source: lastFaceSource },
    estimator: CONFIG.gaze?.provider ?? 'landmarker',
    errors: errorLog.slice(-12),
    calibration: calibration.lastQuality,
    scroll: { mode: scrollController.mode, autoScroll, velocity: lastScrollVel },
    config: snapshotConfig(),
  };
}

async function copyDiagnostics() {
  const text = JSON.stringify(buildDiagnostics(), null, 2);
  console.info('[gaze] diagnostics', text);
  try {
    await navigator.clipboard.writeText(text);
    setStatus('Diagnostics copied to clipboard — paste it back here.');
  } catch {
    // Clipboard API needs focus/permission; fall back to a selectable box.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '8px';
      ta.style.left = '8px';
      ta.style.zIndex = '3000';
      ta.rows = 12;
      ta.cols = 60;
      document.body.appendChild(ta);
      ta.select();
      setStatus('Clipboard blocked — diagnostics are in the text box at top-left; copy them manually.');
    } catch (err) {
      setStatus(`Could not copy diagnostics: ${err.message}. It is also in the console.`);
    }
  }
}

function init() {
  if (window.isSecureContext === false) {
    setStatus(
      'Not a secure context: getUserMedia requires localhost or HTTPS. ' +
        'Run via `npm run dev`, do not open this file directly.',
    );
    return;
  }
  setControlsEnabled(false);
  calibration.setFaceCheck(() => faceDetected());
  calibration.setRecorder(async (x, y) => {
    // Landmarker: verified write through our own eye patches.
    if (getActiveProvider() === landmarkerProvider) return landmarkerProvider.calibrateAt(x, y);
    // Classic: legacy taps, then verify the store actually grew (it stays
    // flat when WebGazer's own detector is blind — the fake-complete trap).
    const before = webgazerStoredCount();
    const taps = Math.max(1, CONFIG.calibration.samplesPerPoint ?? 5);
    for (let i = 0; i < taps; i++) tracker.record(x, y);
    const after = webgazerStoredCount();
    if (before == null || after == null) return taps; // unknowable → trust
    return Math.max(0, after - before);
  });
  calibration.setPredictor(null); // default: WebGazer's own prediction
  calibration.setCounter(() => {
    if (getActiveProvider() === landmarkerProvider) return landmarkerProvider.storedCount();
    return webgazerStoredCount();
  });
  els.btnEnable.addEventListener('click', onEnable);
  els.btnCalibrate.addEventListener('click', onCalibrate);
  els.btnRecalibrate.addEventListener('click', onResetCalibration);
  if (els.btnRestart) els.btnRestart.addEventListener('click', onRestartCamera);
  els.chkVideo.addEventListener('change', (e) => overlay.setVideoVisible(e.target.checked));
  els.chkCursor.addEventListener('change', (e) => {
    showCursor = e.target.checked;
    if (!showCursor) overlay.hideGaze();
  });
  els.btnDownload.addEventListener('click', () => logger.download());
  els.btnClearLog.addEventListener('click', () => {
    logger.clear();
    renderLogPanel();
  });
  if (els.btnDiag) els.btnDiag.addEventListener('click', copyDiagnostics);
  bindScrollControls();
  bindLabControls();
  startScrollLoop();
  logger.subscribe(() => {
    const now = performance.now();
    if (now - lastPanelRender < CONFIG.logging.panelRefreshMs) return;
    lastPanelRender = now;
    renderLogPanel();
  });
  // Lab refresh at 10Hz — never at sample frequency (perf rule).
  setInterval(() => {
    const now = performance.now();
    if (now - lastLabRender < 100) return;
    lastLabRender = now;
    updateFaceOverlay();
    if (latestSnapshot) {
      latestSnapshot.face = faceLabel(now);
      lab.update(latestSnapshot);
    }
    updatePill();
  }, 100);
  setInterval(() => {
    els.stats.textContent =
      `${samplesThisSecond} samples/s · calibration points: ${tracker.calibratedCount}`;
    samplesThisSecond = 0;
    if (!trackingRunning) return;
    // Track-death tripwire: hook onended once, plus a live→dead poll for
    // browsers that end tracks without firing the event.
    try {
      tracker.hookTrackEnd(() => {
        if (!stallWarned) {
          stallWarned = true;
          diagnoseStall('The camera track ended mid-session.');
        }
      });
      const live = !!tracker.videoState().live;
      if (wasVideoLive && !live && !stallWarned) {
        stallWarned = true;
        diagnoseStall('The camera went dark mid-session.');
      }
      wasVideoLive = live;
    } catch (err) {
      console.warn('video liveness check skipped', err);
    }
    const now = performance.now();
    const flowing = lastGazeT !== 0 && now - lastGazeT < 3000;
    if (flowing) {
      stallWarned = false;
      return;
    }
    if (stallWarned) return;
    if (lastGazeT === 0 && now - trackingStartedAt > 8000) {
      stallWarned = true;
      diagnoseStall('Camera is on but no gaze samples yet.');
    } else if (lastGazeT !== 0 && now - lastGazeT > 3000) {
      stallWarned = true;
      diagnoseStall('Tracking stalled: camera was producing samples, then stopped.');
    }
  }, 1000);
  setStatus('Idle. Click “Enable camera & tracking” to begin.');
}

init();
