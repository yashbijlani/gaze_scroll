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
import { GazeEventDetector } from './gaze/events.js';
import { IntentEngine } from './gaze/intent.js';
import { ScrollController, ScrollModes } from './gaze/scroll.js';
import { ReadingTracker } from './gaze/reading.js';
import { gazeTarget, textBelowRatio } from './gaze/dom.js';
import { SessionRecorder, ReplayDriver } from './gaze/session.js';
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
  chkVideo: $('chk-video'),
  chkCursor: $('chk-cursor'),
  btnDownload: $('btn-download'),
  btnClearLog: $('btn-clear-log'),
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
const smoother = new GazeSmoother(CONFIG.smoothing);
const overlay = new Overlay({ cursorEl: els.cursor });
const calibration = new CalibrationFlow(tracker, CONFIG.calibration, els.calLayer);
const logger = new GazeLogger(CONFIG.logging);
// Gaze → evidence → intent → action pipeline (ARCHITECTURE.md §3).
const provider = new WebGazerProvider({ tracker, smoother });
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
// Latest pipeline snapshot for the lab (written per sample, read at 10Hz).
let latestSnapshot = null;
let lastDomFullT = 0;
let lastDomFull = { textBelow: 0.5 };
let lastScrollVel = 0;

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
  if (els.btnSkipCal) els.btnSkipCal.disabled = !running;
}

// Full pipeline for one normalized provider sample (live or replayed):
// events → intent → DOM/reading → scroll controller → log/overlay/lab.
// Structured so replay drives the identical path without a camera.
function handleSample(sample) {
  samplesThisSecond += 1;
  const t = sample?.timestamp ?? performance.now();
  if (sample && sample.x != null) lastGazeT = t;

  const analysis = eventDetector.update(sample);
  if (analysis.lost) {
    overlay.hideGaze();
    const lostIntent = intentEngine.update(sample, analysis, scrollContext());
    scrollController.updateIntent(lostIntent, analysis.edge, t);
    logPipeline(sample, analysis, lostIntent, null, null);
    return;
  }

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
  if (analysis_lost()) return 'lost';
  if ((sample?.confidence ?? 0) < (CONFIG.intent.minConfidence ?? 0.35)) return 'low confidence';
  if (!autoScroll) return 'tracking (scroll off)';
  if (scrollController.overridden()) return 'paused (manual override)';
  return 'tracking';
}

function analysis_lost() {
  return latestSnapshot == null && !trackingRunning ? false : eventDetector.lost;
}

function calQualityLabel() {
  const q = calibration.lastQuality;
  if (!q) return '—';
  if (q.label === 'skipped') return `skipped (${q.points} pts)`;
  if (q.meanErrPx != null) return `${q.label} (~${q.meanErrPx}px)`;
  return q.label;
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
  try {
    await Promise.race([
      provider.start(),
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
  provider.subscribe(handleSample);
  eventDetector.subscribe((evt) => lab.logEvent(evt));
  els.consentGate.style.display = 'none';
  setControlsEnabled(true);
  lab.setPill('tracking', 'tracking');
  setStatus('Tracking running. Click “Calibrate” for better accuracy.');
}

async function onCalibrate() {
  els.btnCalibrate.disabled = true;
  lab.setPill('calibrating', 'calibrating');
  setStatus('Calibration running: look at each dot and click it.');
  const done = await calibration.start((d, n) => {
    els.calStatus.textContent = `Calibrated ${d}/${n}…`;
  });
  const q = calibration.lastQuality;
  els.calStatus.textContent =
    `Calibration ${q?.label ?? 'done'}: ${done} points recorded ` +
    `(${tracker.calibratedCount} total this session)` +
    (q?.meanErrPx != null ? `, mean error ~${q.meanErrPx}px.` : '.');
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

function snapshotConfig() {
  return {
    intent: { ...CONFIG.intent },
    scroll: { ...CONFIG.scroll, mode: scrollController.mode },
    velocity: { ...CONFIG.velocity },
    fixation: { ...CONFIG.fixation },
    events: { ...CONFIG.events },
  };
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
    if (latestSnapshot) lab.update(latestSnapshot);
    updatePill();
  }, 100);
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
