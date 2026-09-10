# Gaze Scroll — Architecture

An experimental, browser-only system that estimates where a user is looking using a
laptop webcam and scrolls the page from inferred intent. Pipeline:

```
webcam → gaze provider → filter → event detector → intent engine
       → scroll controller → webpage (with DOM-awareness feedback)
```

Phase 0 (MVP: track + calibrate + log, no auto-scroll) is complete; this
document covers the full experimental system. Heuristics live in
ALGORITHMS.md, comparison protocol in EXPERIMENTS.md.

---

## 1. Research Summary

### 1.1 WebGazer.js — capabilities and limitations

**WebGazer.js** (Brown HCI, since 2016) is the de-facto open-source, client-side
webcam eye-tracking library. Key facts:

| Property | Detail |
|---|---|
| Runtime | 100% client-side JS; no video leaves the browser |
| Input | `getUserMedia` webcam stream |
| Tracker (default) | MediaPipe FaceMesh (`TFFacemesh`) for face/eye landmarks |
| Regression models | `ridge`, `weightedRidge`, `threadedRidge` |
| Calibration | Self-calibrating from clicks + cursor moves; manual points via `recordScreenPosition` |
| Built-in smoothing | Kalman filter (`applyKalmanFilter`) + 4-frame rolling mean |
| Persistence | `localforage` (IndexedDB) via `saveDataAcrossSessions` |
| Output | `setGazeListener(cb)` → `{x, y, eyeFeatures}`, viewport pixels |
| License | LGPL-3.0 |

**Limitations (important for our design):**

- **Accuracy** — roughly **100–130 px error** in ideal conditions (the original paper
  reports ~130 px with clmtrackr; ~4 cm on screen in later studies). Good enough to
  detect *region* of gaze, not precise reading position.
- **Head-movement sensitivity** — the default regression maps eye *appearance* → screen
  position with no true 3D head-pose model. Moving closer/left/right degrades the
  mapping (WebGazerImproved / WebEyeTrack both target this).
- **No native confidence score** — `data` is either present or `null`. We must derive a
  confidence proxy (see §3.4).
- **Lighting & glasses** — performance degrades in low light, strong backlight, and with
  reflective glasses.
- **Bundler friction** — distributed as UMD/CommonJS; simplest to load as a
  `<script>` global (our approach) rather than through Vite's module graph.
- **Resolution/perf trade-off** — higher camera resolution = more accurate but slower.
- **Async frame loop** — `getPrediction()` is async; effectively ~15–30 Hz on a laptop.

### 1.2 Webcam gaze estimation in modern browsers

- **Appearance/regression (WebGazer)**: eye patch → ridge regression → screen point.
  Simple, fast, but sensitive to geometry changes.
- **Landmark + geometry (MediaPipe FaceMesh iris)**: the 478-landmark face mesh includes
  iris landmarks; projects iris offset inside the eye + head-pose compensation to a
  direction (e.g. `@framefind/core` GazeDetector, WebEyeTrack's BlazeGaze). More
  robust to head movement; more integration work.
- **On-device DL (TensorFlow.js)**: e.g. BlazeGaze, iTracker-style CNNs converted to TF.js.
  Higher accuracy, heavier models, needs model hosting.
- All approaches run under `getUserMedia`, which **requires a secure context** (HTTPS or
  `localhost`). This is why the prototype must be served, not opened via `file://`.

**Decision:** start with WebGazer (fewest moving parts, self-calibrating). Keep the gaze
pipeline behind an interface so a MediaPipe/geometry-based estimator can be swapped in later.

### 1.3 Calibration techniques

- **Implicit/self-calibration** (WebGazer default): every click and throttled cursor move
  is assumed to be the gaze point; feeds the regression continuously.
- **Explicit N-point grid** (5/9/16 points): user looks at each target; `recordScreenPosition`
  stores a labelled sample. More accurate up-front, still benefits from implicit updates.
- **Blind-spot / card-sliding** (WebGazerImproved): first establish pixels-per-mm and eye
  geometry to combat head movement. Out of MVP scope.
- **Best practice:** combine both — run the explicit grid once, keep implicit
  click/move calibration enabled, and persist per-user across sessions.

### 1.4 Gaze smoothing / filtering

- **One Euro filter** — adaptive low-pass; low lag at high speed, low jitter at low speed.
  The recommended default for gaze cursors (and what we implement in `smoothing.js`).
- **Kalman filter** — WebGazer applies one internally already.
- **Exponential moving average (EMA) / rolling mean** — simple, but fixed lag.
- **Moving median** — robust to blink/outlier spikes.

### 1.5 Fixation vs saccade detection

Gaze is a sequence of **fixations** (stable, ~180–300 ms, informational) and **saccades**
(rapid jumps between fixations, ~20–40 ms, no visual intake). Main algorithms:

- **I-VT** (velocity threshold): classify by point-to-point velocity. Simple, needs sample rate.
- **I-DT** (dispersion threshold): a sliding window is a fixation if its spatial
  dispersion stays under a threshold for a minimum duration. Most robust at low,
  noisy sample rates → **our choice**.
- Adaptive/markovian variants (K-ratio), Bayesian (I-BDT) — later refinements.

For webcam-grade data (~15–30 Hz, 100 px noise), I-DT with generous thresholds
(~40–60 px dispersion, ~100–200 ms minimum) is the pragmatic starting point.

### 1.6 Scroll intent detection (design only — not in MVP)

Prior work (Kumar et al. 2007 "Gaze-enhanced Scrolling", the 2023 mobile gaze-scrolling
study, the `US8643680B2` patent, GazeRecorder's GazeScroll extension) defines several
strategies:

- **Edge-zone / dwell**: gaze resting in a top/bottom "scroll zone" for a dwell time
  triggers scrolling; scroll speed maps to distance from center.
- **Gaze marker + page-down**: on page-down, re-anchor the scrolled content under the
  previous gaze point (a "GazeMarker").
- **Reading-speed implicit**: infer reading speed from fixation/regression pattern and
  advance content automatically.
- **Gesture/pursuit**: follow a moving target or swipe gaze bottom→top to trigger a page turn.

For us the core signal is: **sustained fixation near the viewport edge** (dwell) with a
"glance vs. gaze" discriminator (a brief edge glance must NOT scroll). This is the
subject of the first post-MVP milestone.

### 1.7 Browser scrolling APIs

- `window.scrollTo({top, behavior: 'smooth'})` / `window.scrollBy({top, behavior})` —
  absolute and relative scroll.
- `element.scrollTop` / `element.scrollTo` / `element.scrollBy` — scroll a container.
- `requestAnimationFrame` loop — for custom speed/easing (native `smooth` has no speed
  control and had Chromium multi-scroll bugs; a rAF-driven velocity loop is more robust
  for gaze control).
- Scroll must target the actual scrolling element (`document.scrollingElement`) and be
  interruptible when the user starts scrolling manually (detect wheel/touch to hand back control).

### 1.8 Privacy implications

- Gaze data is **biometric** (can re-identify individuals) and can leak health, fatigue,
  and interest. Under GDPR it is a *special category* (Art. 9) needing **explicit consent**.
- WebGazer keeps all pixels on-device; only coordinates leave the processing pipeline.
  This is the single most important architectural property to preserve.
- Mitigations we adopt now: opt-in camera gate, visible indicator when the camera is live,
  on-device-only processing, no server, no analytics, easy "off" switch, and session-only
  data (no cross-session persistence by default).
- Never silently ship raw frames anywhere; keep the debug overlay clearly labelled and
  let the user hide it.

---

## 2. System goals (current)

1. Request webcam permission behind an explicit consent gate.
2. Initialize eye tracking behind a swappable `GazeProvider` interface.
3. Show camera/debug overlay + floating tracking pill.
4. Guided calibration (5/9-pt) with a quality score, skippable.
5. Filter (One Euro) → velocity/persistence → discrete gaze events.
6. Intent engine: evidence-weighted states with hysteresis + confidence.
7. Scroll controller: discrete/smooth/edge/reading/predictive modes with
   manual override and emergency stop.
8. Gaze Lab: live signals, trajectory, events, parameters, recording.
9. Session record/export/replay driving the identical pipeline, no camera.
10. Privacy: on-device only, no frames stored or sent, explicit exports.

---

## 3. Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                            index.html                              │
│  consent gate · status · controls · content · log · scrollctl      │
│  gaze lab (signals, trajectory, params, sessions, replay) · pill   │
└───────────────────────────────┬────────────────────────────────────┘
                                │ module graph (ESM)
        ┌───────────────────────┼───────────────────────────────────┐
        ▼                       ▼                                   ▼
┌───────────────┐     ┌───────────────────┐     ┌───────────────────────┐
│   main.js     │     │    overlay.js     │     │     calibration.js    │
│  app/state +  │     │  camera preview   │     │  guided N-point flow  │
│  pipeline     │     │  gaze cursor      │     │  quality + skip       │
│  wiring       │     │                   │     │                       │
└──────┬────────┘     └───────────────────┘     └───────────┬───────────┘
       │                                                   │
       ▼                                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       gaze/provider.js                               │
│  GazeProvider → WebGazerProvider (tracker + smoother + confidence,   │
│  normalized {timestamp,x,y,normalizedX,normalizedY,confidence})       │
│               → MockProvider (scripted; tests + replay, no camera)    │
└──────────────┬───────────────────────────────────────────────────────┘
               │ smoothed sample
               ▼
        ┌───────────────┐         ┌───────────────┐
        │ gaze/velocity │         │  fixation.js  │
        │ EMA + persist │         │  I-DT         │
        └───────┬───────┘         └───────┬───────┘
                │                         │
                ▼                         ▼
        ┌─────────────────────────────────────────┐
        │              gaze/events.js             │
        │  FIXATION_*/MOVEMENT_*/EDGE_DWELL_*/    │
        │  TRACKING_LOST/RECOVERED                │
        └──────────────┬──────────────────────────┘
                       │ analysis {fixation, velocity, edge}
                       ▼
        ┌─────────────────────────────────────────┐
        │              gaze/intent.js             │◄── scroll position,
        │  READING/LOOKING_UP/DOWN/SCANNING/      │    viewport, document
        │  IDLE/UNCERTAIN/TRACKING_LOST +         │    limits
        │  hysteresis + confidence gating         │
        └──────────────┬──────────────────────────┘
                       │ {intent, direction, confidence, signals}
                       ▼
        ┌─────────────────────────────────────────┐
        │  gaze/dom.js + gaze/reading.js          │◄── elementFromPoint,
        │  gaze target role · on-text ·           │    text-below scan
        │  progression · near-end                 │
        └──────────────┬──────────────────────────┘
                       ▼
        ┌─────────────────────────────────────────┐
        │             gaze/scroll.js              │
        │  discrete/smooth/edge/reading/          │
        │  predictive/off · accel ramps ·         │
        │  manual override · e-stop               │
        └──────────────┬──────────────────────────┘
                       │ scroll deltas
                       ▼
        ┌─────────────────────────────────────────┐
        │  logger.js + gaze/session.js + lab.js   │
        │  ring buffer/CSV · session JSON export  │
        │  ReplayDriver → (same pipeline, no cam) │
        └─────────────────────────────────────────┘
```

### 3.1 Modules

| File | Responsibility |
|---|---|
| `src/config.js` | All tunable parameters (smoothing, fixation, velocity, events, intent, scroll, calibration). |
| `src/camera.js` | `getUserMedia` capability detection. |
| `src/tracker.js` | WebGazer wrapper: init, gaze subscription, calibration recording, confidence proxy. |
| `src/gaze/provider.js` | `GazeProvider` abstraction: `WebGazerProvider` (normalized stream) + `MockProvider` (tests/replay). |
| `src/gaze/landmarker.js` | `LandmarkerGazeProvider`: own eye patches + own ridge map (default estimator). |
| `src/gaze/ridge.js` | `RidgeGazeMapper`: grayscale eye features, ridge train/predict, pure + tested. |
| `src/gaze/velocity.js` | EMA velocity/speed + direction persistence. |
| `src/smoothing.js` | One Euro filter (per-axis) for low-lag jitter reduction. |
| `src/fixation.js` | Dispersion-threshold (I-DT) fixation/saccade classifier. |
| `src/gaze/events.js` | Discrete gaze events (fixation/movement/edge-dwell/tracking-loss). |
| `src/gaze/intent.js` | Evidence-weighted intent + hysteresis + confidence gating. |
| `src/gaze/dom.js` | `elementFromPoint` gaze-target roles + text-below scan. |
| `src/gaze/reading.js` | Reading-progression tracker (fixation steps through text). |
| `src/gaze/scroll.js` | Scroll strategies, accel ramps, override, e-stop. |
| `src/gaze/session.js` | Session record/export + replay driver (no camera). |
| `src/overlay.js` | Repositions WebGazer's camera preview; renders our own gaze cursor. |
| `src/calibration.js` | Guided N-point flow with quality score, skip, persistence. |
| `src/lab.js` | Gaze Lab panel: signals, trajectory canvas, events, params. |
| `src/logger.js` | In-memory ring buffer of samples; console + downloadable export. |
| `src/main.js` | Bootstraps everything; owns the pipeline + UI state machine. |

### 3.2 Data flow (per gaze sample)

```
webgazer.setGazeListener(data => {
  if (data == null) { overlay.setGaze(null); return; }

  raw = { x: data.x, y: data.y, t: performance.now(),
          hasFace: !!data.eyeFeatures }

  smooth = oneEuroX(raw.x, t), oneEuroY(raw.y, t)

  conf = tracker.computeConfidence(raw)      // heuristic proxy

  fixation.add(smooth.x, smooth.y, t)        // → {isFixation, durationMs}

  logger.log({ raw, smooth, confidence: conf, fixation })

  overlay.drawGaze(smooth.x, smooth.y, conf, fixation)
})
```

### 3.3 Tracked state (event emitter on `main.js`)

```
state:
  camera:    'idle' | 'requested' | 'granted' | 'denied' | 'error'
  tracking:  'off' | 'starting' | 'running' | 'paused'
  calibrated: number        // count of recorded calibration points
  overlay:   { video: boolean, cursor: boolean, log: boolean }
```

### 3.4 Confidence proxy

WebGazer provides no model confidence. We synthesize a 0–1 score from:

- **Presence** — prediction exists (`data != null`).
- **Face/eye features present** — `data.eyeFeatures.left/right` are set.
- **Edge factor** — distance of the point from the viewport edge (points flying far
  off-screen are unreliable).

This is a *heuristic*, documented as such, and is the hook for a future real confidence
value from a geometry/ML estimator.

### 3.5 Explicit non-goals (MVP)

- No automatic scrolling of any kind.
- No scroll-intent engine.
- No server / backend; no data leaves the page.
- No cross-session persistence of calibration by default.

---

## 4. Tech choices

- **Plain ES modules + Vite** for a zero-config dev server with HMR.
- **WebGazer 2.x loaded as a CDN `<script>` global** to avoid UMD/bundler friction
  (`https://cdn.jsdelivr.net/npm/webgazer@2.0.1/dist/webgazer.min.js`).
- **No framework** — vanilla DOM is enough for the MVP surface area.
- Secure context required → always run via `npm run dev` (localhost), never `file://`.

## 5. Running

```bash
cd gaze_scroll
npm install
npm run dev      # http://localhost:5173
```

## 6. References

- WebGazer: https://webgazer.cs.brown.edu/ · source: github.com/brownhci/WebGazer
- Papoutsaki et al. 2016, "WebGazer: Scalable Webcam Eye Tracking Using User Interactions" (IJCAI).
- WebEyeTrack (2025): headpose-aware on-device gaze for the browser (arXiv:2508.19544).
- Casiez et al. 2012, "1€ Filter" (CHI).
- Salvucci & Goldberg 2000, fixation identification (I-VT/I-DT).
- Kumar et al. 2007, "Gaze-enhanced Scrolling Techniques" (Stanford HCI).
- Kumar et al. 2018, "Gaze-based Scrolling Techniques" (mobile, dwell/pursuit/gesture).
- GDPR Art. 4(14)/9 & EDPB Guidelines 3/2019 — biometric data.
- MDN: `Window.scrollTo/scrollBy`, `Element.scrollTo`, `requestAnimationFrame`.
