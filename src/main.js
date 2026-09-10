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
import { FixationDetector } from './fixation.js';
import { Overlay } from './overlay.js';
import { CalibrationFlow } from './calibration.js';
import { GazeLogger } from './logger.js';

const $ = (id) => document.getElementById(id);

const els = {
  status: $('status'),
  stats: $('stats'),
  consentGate: $('consent-gate'),
  btnEnable: $('btn-enable'),
  consentError: $('consent-error'),
  btnCalibrate: $('btn-calibrate'),
  btnRecalibrate: $('btn-recalibrate'),
  chkVideo: $('chk-video'),
  chkCursor: $('chk-cursor'),
  btnDownload: $('btn-download'),
  btnClearLog: $('btn-clear-log'),
  logBody: $('log-body'),
  logCount: $('log-count'),
  cursor: $('gaze-cursor'),
  calLayer: $('calibration-layer'),
  calStatus: $('cal-status'),
};

const tracker = new GazeTracker(CONFIG.webgazer);
const smoother = new GazeSmoother(CONFIG.smoothing);
const fixDetector = new FixationDetector(CONFIG.fixation);
const overlay = new Overlay({ cursorEl: els.cursor });
const calibration = new CalibrationFlow(tracker, CONFIG.calibration, els.calLayer);
const logger = new GazeLogger(CONFIG.logging);

let showCursor = true;
let lastGazeT = 0;
let samplesThisSecond = 0;
let lastPanelRender = 0;
// Watchdog state: WebGazer's internal rAF loop dies silently if the face
// model fails to load, so we detect "camera on, zero samples" here.
let trackingRunning = false;
let trackingStartedAt = 0;
let stallWarned = false;
let enableInFlight = false;

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
}

function onGazeSample(sample) {
  samplesThisSecond += 1;
  if (!sample) {
    overlay.hideGaze();
    logger.log({
      t: performance.now(),
      epoch: Date.now(),
      rawX: null,
      rawY: null,
      smoothX: null,
      smoothY: null,
      confidence: 0,
      fixationState: 'lost',
      fixationDurationMs: 0,
      hasFace: false,
    });
    return;
  }
  // Re-acquire the filter after a gap so it does not drag across it.
  if (sample.t - lastGazeT > 500) smoother.reset();
  lastGazeT = sample.t;

  const sm = smoother.filter(sample.x, sample.y, sample.t);
  const confidence = tracker.computeConfidence(sample);
  const fix = fixDetector.add(sm.x, sm.y, sample.t);

  logger.log({
    t: sample.t,
    epoch: Date.now(),
    rawX: sample.x,
    rawY: sample.y,
    smoothX: sm.x,
    smoothY: sm.y,
    confidence,
    fixationState: fix.state,
    fixationDurationMs: Math.round(fix.durationMs),
    hasFace: sample.hasFace,
  });

  if (showCursor) overlay.drawGaze(sm.x, sm.y, confidence, fix);
  else overlay.hideGaze();
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
  try {
    await Promise.race([
      tracker.begin(),
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

  overlay.dockCameraPreview(
    CONFIG.webgazer.videoViewerWidth,
    CONFIG.webgazer.videoViewerHeight,
  );
  tracker.subscribe(onGazeSample);
  els.consentGate.style.display = 'none';
  setControlsEnabled(true);
  setStatus('Tracking running. Click “Calibrate” for better accuracy.');
}

async function onCalibrate() {
  els.btnCalibrate.disabled = true;
  setStatus('Calibration running: look at each dot and click it.');
  const done = await calibration.start((d, n) => {
    els.calStatus.textContent = `Calibrated ${d}/${n}…`;
  });
  els.calStatus.textContent =
    `Calibration complete: ${done} points recorded ` +
    `(${tracker.calibratedCount} total this session).`;
  setStatus('Calibration complete. Everyday clicks keep training the model implicitly.');
  els.btnCalibrate.disabled = false;
}

async function onResetCalibration() {
  await tracker.clear();
  smoother.reset();
  fixDetector.reset();
  els.calStatus.textContent = 'Not calibrated.';
  setStatus('Calibration data cleared. Run “Calibrate” to retrain.');
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
  els.btnEnable.addEventListener('click', onEnable);
  els.btnCalibrate.addEventListener('click', onCalibrate);
  els.btnRecalibrate.addEventListener('click', onResetCalibration);
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
  logger.subscribe(() => {
    const now = performance.now();
    if (now - lastPanelRender < CONFIG.logging.panelRefreshMs) return;
    lastPanelRender = now;
    renderLogPanel();
  });
  setInterval(() => {
    els.stats.textContent =
      `${samplesThisSecond} samples/s · calibration points: ${tracker.calibratedCount}`;
    samplesThisSecond = 0;
    if (!trackingRunning) return;
    const now = performance.now();
    const flowing = lastGazeT !== 0 && now - lastGazeT < 3000;
    if (flowing) {
      stallWarned = false;
      return;
    }
    if (stallWarned) return;
    if (lastGazeT === 0 && now - trackingStartedAt > 8000) {
      stallWarned = true;
      setStatus(
        'Camera is on but no gaze samples yet — the face model may still be ' +
          'loading, or model files were blocked (check console for 404s / ' +
          'adblock / CSP).',
      );
    } else if (lastGazeT !== 0 && now - lastGazeT > 3000) {
      stallWarned = true;
      setStatus(
        'Tracking stalled: camera is on but samples stopped. Reload and ' +
          'check the console for MediaPipe errors; disable adblock for this site.',
      );
    }
  }, 1000);
  setStatus('Idle. Click “Enable camera & tracking” to begin.');
}

init();
