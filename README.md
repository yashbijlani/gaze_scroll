# Gaze Scroll (MVP)

Experimental, browser-only prototype that estimates where the user is looking
with a normal laptop webcam.

**Scope of this milestone:** camera permission → eye tracking → gaze cursor →
calibration → gaze logging. The page does **not** scroll automatically.

See `ARCHITECTURE.md` (research + design), `ROADMAP.md` (phased plan),
`TODO.md` (task list).

## Run

```bash
cd gaze_scroll
npm install
npm run dev        # http://localhost:5173
```

Requirements:

- Chrome / Edge / Firefox / Safari with webcam access.
- A **secure context**: `localhost` or HTTPS. Do not open via `file://`
  (`getUserMedia` will refuse).
- Internet access on first load: WebGazer is loaded from a CDN
  (`https://cdn.jsdelivr.net/npm/webgazer@2.0.1/dist/webgazer.min.js`).

## Use

1. Click **Enable camera & tracking** and allow webcam access.
   All video processing stays on-device; no frames leave the page.
2. A gaze cursor should appear and roughly follow your eyes.
3. Click **Calibrate**, then look at each dot and click it (9 points).
4. Watch the log panel: raw/smoothed coordinates, confidence proxy,
   fixation state.

## Layout

```
index.html          UI shell (loads WebGazer CDN script + src/main.js)
src/main.js         app state machine + wiring
src/config.js       all tunable parameters
src/camera.js       getUserMedia capability + permission request
src/tracker.js      WebGazer wrapper + confidence proxy
src/smoothing.js    One Euro gaze filter
src/fixation.js     dispersion-threshold (I-DT) fixation detector
src/overlay.js      camera preview placement + gaze cursor
src/calibration.js  N-point click-through calibration flow
src/logger.js       sample ring buffer + CSV export
src/style.css       styles
```
