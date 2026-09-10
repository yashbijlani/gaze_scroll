# TODO

## Now (MVP scaffold)

- [x] Repository inspected; research complete (`ARCHITECTURE.md` §1).
- [x] `ARCHITECTURE.md`, `ROADMAP.md`, `TODO.md` written.
- [x] Project scaffold: `package.json`, `index.html`, `src/*`, `style.css`, `README.md`.
- [ ] `npm install` + `npm run dev`, then smoke-test on `localhost`:
  - [ ] Camera consent gate appears and requests permission.
  - [ ] Gaze cursor appears once tracking starts.
  - [ ] Calibration flow records points and improves tracking.
  - [ ] Log panel shows raw/smoothed coordinates + confidence.
- [ ] Verify the scaffold does **not** perform any scrolling.

## Next (post-MVP, see ROADMAP.md Phase 1)

- [ ] Collect gaze logs across users/lighting/posture.
- [ ] Tune One Euro filter params from data.
- [ ] Tune fixation (I-DT) thresholds.
- [ ] Validate confidence proxy against ground-truth tasks.
- [ ] Add diagnostics view (raw vs smoothed, fixations, FPS).

## Later (Phases 2–5)

- [ ] Scroll-intent model (dwell + glance/gaze discriminator), visual only.
- [ ] Controlled scrolling with manual-takeover detection.
- [ ] GazeMarker page-down mode.
- [ ] Blink suppression, head-movement compensation, calibration persistence.
- [ ] User study + privacy review.

## Known open questions

- Confidence proxy is a heuristic; investigate a real model confidence later.
- WebGazer default regression is head-movement sensitive; benchmark MediaPipe/BlazeGaze.
- Dwell threshold needs per-user calibration (experiment in Phase 2).
