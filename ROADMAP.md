# Gaze Scroll — Roadmap

Phased plan. Each phase is a shippable, testable increment. We do **not** build the
whole system at once.

---

## Phase 0 — Research & scaffold (current)

**Status: done.**

- [x] Inspect repository, confirm empty target directory.
- [x] Research WebGazer.js, webcam gaze estimation, calibration, smoothing,
      fixation/saccade, scroll intent, scrolling APIs, privacy.
- [x] Write `ARCHITECTURE.md`, `ROADMAP.md`, `TODO.md`.
- [x] Create minimal project scaffold implementing the MVP (camera, tracking,
      overlay, gaze cursor, calibration, logging — **no scrolling**).

**Exit criteria:** the app runs on `localhost`, requests the camera, tracks gaze,
shows a cursor, runs calibration, and logs samples.

---

## Phase 1 — Signal quality & tuning

Goal: make the raw tracking trustworthy enough to reason about.

- [ ] Collect real gaze logs across multiple users/lighting/posture.
- [ ] Tune One Euro filter params (`minCutoff`, `beta`) against logged jitter/lag.
- [ ] Tune I-DT dispersion threshold + min-duration for webcam noise levels.
- [ ] Calibrate the **confidence proxy** against ground-truth (cursor-on-target tasks).
- [ ] Add a small diagnostics view: raw vs smoothed trace, fixation overlay, FPS.
- [ ] Evaluate head-movement degradation; decide whether to explore MediaPipe/BlazeGaze.

**Exit criteria:** mean error measured on a click-target task, documented; filter and
fixation params chosen from data rather than defaults.

---

## Phase 2 — Scroll-intent model (no scrolling yet)

Goal: reliably *detect* the intent to scroll, without performing it.

- [ ] Define scroll zones (top/bottom edge bands) and center dead-zone.
- [ ] Implement dwell timer + "glance vs. gaze" discriminator (min dwell ~350–500 ms).
- [ ] Derive an intent score: `f(fixation location, dwell time, fixation state, confidence)`.
- [ ] Surface intent as a *visual indicator only* (edge glow / arrow), no motion.
- [ ] Validate false-positive rate against natural reading behavior.

**Exit criteria:** an on-screen intent indicator that fires correctly when a user
fixates near an edge for the dwell threshold, and stays quiet during normal reading.

---

## Phase 3 — Controlled scrolling

Goal: scroll *when intended*, in a way that feels safe and interruptible.

- [ ] Implement a rAF-driven scroll velocity controller (speed mapped to gaze distance
      past the edge threshold; not native `behavior:'smooth'`).
- [ ] Add manual-takeover detection (wheel/touch/keyboard cancels auto-scroll).
- [ ] Scroll the correct target (`document.scrollingElement`) and support container scrolling.
- [ ] Add rate limiting / hysteresis to avoid oscillation at the threshold.
- [ ] Explore "GazeMarker" page-down mode (re-anchor content under the previous gaze point).

**Exit criteria:** users can read a page hands-free with stable, interruptible scrolling;
no runaway scroll on false positives.

---

## Phase 4 — Robustness & UX polish

- [ ] Handle blinks (EAR-style suppression) and low-confidence gaps.
- [ ] Better head-movement compensation (geometry estimator swap if Phase 1 justified it).
- [ ] Per-user calibration persistence (explicit opt-in storage).
- [ ] Accessibility: keyboard fallback, reduced-motion respect, easy off switch.
- [ ] Performance: lower camera resolution, Web Worker for filtering, pause when tab hidden.

---

## Phase 5 — Evaluation & product questions

- [ ] User study comparing gaze-scroll vs. traditional scroll (comfort, error, speed).
- [ ] Privacy review: data retention, consent UX, GDPR/biometric compliance.
- [ ] Decide viability for a real feature vs. research-only prototype.
