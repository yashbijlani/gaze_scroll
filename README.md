# Gaze Scroll (WebGaze)

Experimental, browser-only eye-tracking scrolling system: look toward the
lower region of a page and the system infers *intentional* downward
movement, then scrolls smoothly. Brief glances never scroll.

**Pipeline:** webcam → gaze estimation → calibration → filtering →
fixation/movement analysis → intent engine → scroll controller → webpage.
See `ARCHITECTURE.md`; heuristics and thresholds in `ALGORITHMS.md`;
comparison protocol in `EXPERIMENTS.md`; the accuracy overhaul and its
measurements in `ACCURACY_OVERHAUL.md`, `ACCURACY_ROADMAP.md`, and
`BENCHMARK_RESULTS.md`.

The default gaze estimator is **geometry** (`src/gaze/geometryProvider.js`):
normalized geometric eye/head features → a per-user two-eye affine mapping →
explicit confidence → a constant-velocity Kalman filter. The legacy
appearance-patch estimator and WebGazer classic remain selectable in Controls
for side-by-side comparison.

## Run

```bash
cd gaze_scroll
npm install
npm run dev        # http://localhost:5173
npm test           # 112 unit tests (synthetic gaze sequences + pure algorithms)
node bench/run.js  # regenerate BENCHMARK_RESULTS.md (no camera needed)
npm run build
```

Requirements:

- Chrome / Edge / Firefox / Safari with webcam access.
- A **secure context**: `localhost` or HTTPS. Do not open via `file://`
  (`getUserMedia` will refuse).
- Internet on first load: WebGazer (`cdn.jsdelivr.net/npm/webgazer@2.0.1`)
  plus MediaPipe face-mesh files (pinned CDN, configured in
  `src/config.js`). Close other tabs holding the camera.

## Use (primary experience)

1. Click **Enable camera & tracking** and allow webcam access.
2. **Calibrate**: read the guidance card, look at each dot and click it
   (5-point fast or 9-point thorough). Skippable for experimentation.
   You get a quality score (good/fair/poor) at the end.
3. **Reading mode**: pick a scroll mode (start with Smooth continuous),
   tick **Enable automatic scrolling**, and read. Sustain confident
   downward gaze to scroll; resume reading to stop; look up to go back.
4. Your wheel, arrow/space keys, or touch **always override instantly**;
   the red **Stop scrolling** button kills automation immediately.

## Developer mode (Gaze Lab)

The on-page Gaze Lab shows live gaze/normalized coords, confidence,
velocity, persistence, fixation, direction, intent + confidence with a
per-signal breakdown, scroll velocity, tracking status, calibration
quality, and gaze target — plus a raw-vs-filtered trajectory canvas, an
event stream (fixations, movements, edge dwells, tracking loss), tunable
parameters, session recording/export (JSON, numbers only), and replay
(play/pause/restart/speed) that re-drives the full pipeline **without a
webcam**. Switch modes during replay to compare strategies on identical
data.

## Privacy

- Webcam access is required; all video processing is **on-device**.
- No video frames are sent anywhere, recorded, or persisted.
- Session exports contain only anonymized gaze-derived numbers and only
  on explicit export clicks. Calibration metadata stays in localStorage.
- Stopping tracking releases the camera immediately. No analytics.

## Known limitations

- Webcam gaze error is ~100–130px in ideal conditions: the system reads
  *regions and trends*, never precise words.
- Head movement, poor lighting, and glasses reflections degrade tracking;
  recalibrate when quality drops (watch the Lab's confidence + quality).
- WebGazer loads models from a CDN: adblock or offline breaks startup
  (the UI says so explicitly rather than dying silently).

## Layout

```
index.html          UI shell (WebGazer CDN + src/main.js)
src/main.js         pipeline wiring + UI state
src/config.js       all tunable parameters
src/camera.js       getUserMedia capability check
src/tracker.js      WebGazer wrapper + confidence proxy
src/smoothing.js    One Euro gaze filter
src/fixation.js     I-DT fixation detector
src/overlay.js      camera preview + gaze cursor
src/calibration.js  guided N-point flow + quality score
src/logger.js       sample ring buffer + CSV export
src/lab.js          Gaze Lab panel controller
src/gaze/provider.js        GazeProvider / WebGazerProvider / MockProvider
src/gaze/geometryProvider.js GeometryGazeProvider (default estimator)
src/gaze/features.js        normalized geometric features + head pose
src/gaze/mapping.js         GazeMapper (affine/poly2/tiny MLP) + scaler
src/gaze/fusion.js          two-eye model (agreement / occlusion fallback)
src/gaze/confidence.js      explicit gaze confidence
src/gaze/filters.js         EMA / One Euro / Kalman
src/gaze/safeRegion.js      adaptive safe region + hysteresis + metrics
src/gaze/landmarker.js      legacy LandmarkerGazeProvider (appearance patches)
src/gaze/ridge.js           legacy ridge over grayscale eye patches
src/gaze/velocity.js        EMA velocity + direction persistence
src/gaze/events.js          fixation/movement/edge-dwell/tracking-loss events
src/gaze/intent.js          evidence-weighted intent + hysteresis
src/gaze/scroll.js          discrete/smooth/edge/reading/predictive controller
src/gaze/reading.js         reading-progression tracker
src/gaze/dom.js             elementFromPoint gaze-target classification
src/gaze/session.js         SessionRecorder + ReplayDriver
bench/                headless simulator, metrics, experiment runner
tests/                synthetic-sequence + pure-algorithm unit tests
```
