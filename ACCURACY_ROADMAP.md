# WebGaze — Accuracy Roadmap

Phased plan for the accuracy overhaul, with status. Priorities, in order:
reliable scroll intent → false-scroll prevention → calibration robustness →
gaze stability → practical accuracy → latency → CPU. See
`ACCURACY_OVERHAUL.md` for what was done and why, `BENCHMARK_RESULTS.md` for
numbers, `ALGORITHMS.md` for the heuristics.

---

## Phase A — Understand, baseline, measure (done)

- [x] Inspect the existing pipeline; identify estimator, calibration, smoothing,
      intent, scroll, tests.
- [x] Run the app/test suite; establish that the prototype works (71 tests).
- [x] Build a headless simulator + metrics (`bench/`) so algorithms can be
      compared without a camera.
- [x] Define product metrics: bottom-zone precision/recall, false-scroll rate,
      missed scrolls, jitter, step latency, fit/predict cost.

## Phase B — Estimator overhaul (done)

- [x] Replace raw appearance patches with normalized geometric features
      (roll-invariant iris-in-eye, EAR, head-pose proxies).
- [x] Add per-user affine mapping with standardization, variance floor,
      z-clip, unpenalized bias.
- [x] Two-eye model: combined primary + per-eye agreement/occlusion fallback.
- [x] Explicit confidence model.
- [x] Constant-velocity Kalman filter as default (One Euro retuned/available).
- [x] Keep legacy estimators selectable for A/B comparison.
- [x] 112 unit tests; build green.

## Phase C — Intent hardening (done, in benchmark)

- [x] Adaptive safe region (fraction + `sigmaK × error` margin) and hysteresis.
- [x] Dwell as the glance/gaze discriminator; validated zero false-scroll on
      labelled sequences.
- [x] Size the edge band from measured calibration error.

## Phase D — Real-camera validation (next, needs a person + webcam)

This is the gating step before trusting the numbers in the wild.

- [ ] Record real sessions with the new provider and export them. Extend
      `SessionRecorder` to include the 21-dim feature vector per row (opt-in,
      still numbers only, never images).
- [ ] Re-run the benchmark on recorded features (`bench/run.js` loader) and
      compare simulator predictions to reality.
- [ ] Measure real per-user calibration residual, zone precision/recall, and
      false-scroll across 3+ people, lighting, glasses, posture.
- [ ] Tune `stdFloor`, `lambda`, Kalman `q/r`, `safeRegion.fraction` from data.
- [ ] Add a within-app calibration-quality/accuracy panel backed by the
      benchmark metrics (currently the Lab shows live signals, not aggregate
      accuracy).

## Phase E — Adaptive calibration & personalization (planned)

- [ ] Closed-loop safe-region optimizer: from recorded scroll sessions,
      choose the fraction minimizing false-scroll subject to a missed-scroll
      budget (the benchmark already computes the ingredients).
- [ ] Confidence-weighted calibration samples (weight by feature quality
      instead of only dropping outliers).
- [ ] Adaptive calibration: silently refine the mapping from high-confidence
      click interactions, with a guard against drift (only accept samples that
      improve held-out residual).
- [ ] Drift detection: flag when live residual/confidence degrades vs the
      calibration baseline and prompt a targeted recalibration of the worst
      region (the calibration summary already reports the worst point).

## Phase F — Head-pose and geometry (stretch)

- [ ] Proper 3D head-pose (solvePnP / metric face model) instead of 2D proxies;
      evaluate against the current head channels on recorded data.
- [ ] Eye-region appearance model as a secondary signal fused with geometry,
      only if real-data residuals show geometry alone is insufficient.
- [ ] Investigate a lightweight learned gaze head (e.g. BlazeGaze-style) as an
      optional estimator — but only if it beats geometry at comparable compute.

## Phase G — Reading-aware scrolling (planned)

- [ ] Validate the reading-progression mode on real recordings (gaze-on-text +
      downward progression), which the benchmark does not yet simulate.
- [ ] Blend safe-region and reading modes: use progression to anticipate,
      safe region as the hard gate.

---

## Explicit non-goals

- Chasing minimum pixel error for its own sake. The product metric is reliable
  scroll intent with a low false-scroll rate.
- GPU/server inference. The system must stay on-device and cheap.
- Big models. Every capacity increase must beat affine on recorded data by a
  margin that justifies its compute.
