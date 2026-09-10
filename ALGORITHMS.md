# Gaze Scroll — Algorithms

How the pipeline turns noisy webcam gaze into scroll motion, and why each
threshold exists. All tunable numbers live in `src/config.js`.

## 0. What webcam gaze is (and isn't)
WebGazer reports ~100–130px error in ideal conditions (Papoutsaki et al.
2016, IJCAI; see ARCHITECTURE.md §1). There is no true head-pose model, no
model confidence, and ~15–30Hz async samples. Every stage below assumes the
input is a *region hint*, never a precise point. The design rule: **no
single sample ever causes motion** — every action needs sustained,
multi-signal evidence.

## 0.5 Face detection — dual stack (`gaze/face.js`, `overlay.js`)

WebGazer 2.0.1's bundled facemesh stack (2021 tfjs-models + MediaPipe
solution files) fails silently on modern hosting: hung fetches, 404s, and
async rejections that kill its loop without logging. Since every downstream
stage (calibration taps, predictions, confidence) needs face data, a blind
bundled detector used to wedge the whole app with no visible cause.

So face *presence* no longer depends on it. A standalone MediaPipe Tasks
FaceLandmarker (pinned `tasks-vision@0.10.35`, GPU with CPU fallback) runs
on the visible preview video at ~7Hz, entirely for detection + overlay:
amber face bounding box, green eye boxes from the FaceMesh eye index sets
(first 468 landmarks share FaceMesh topology), faint landmark dots. Either
source (bundled or standalone) feeds presence for the pill, Lab face row,
and the calibration face gate. The detector loads lazily, never throws
into the app loop, and reports `idle → loading → ready | failed: reason`
in diagnostics. WebGazer still owns gaze regression for now; if its
predictions stay null while landmarks flow, the estimator itself is the
next replacement target (see provider abstraction).

## 1. Smoothing — One Euro filter (`smoothing.js`)

Casiez et al. 2012 (CHI). Adaptive low-pass: low cutoff at rest (kills
jitter), high cutoff during fast movement (kills lag). Defaults
`minCutoff 1.0, beta 0.3, dCutoff 1.0` — carried over from Phase 0; retune
from recorded sessions (ROADMAP Phase 1). The filter re-acquires after any
>500ms gap so it never drags across tracking loss.

## 2. Velocity — EMA of finite differences (`gaze/velocity.js`)

Raw per-sample velocity from 30Hz jittery data is spiky garbage, so the
velocity *vector itself* is EMA-smoothed (`emaAlpha 0.35`). Guards:

- `minDtMs 8`: ignore degenerate same-tick pairs.
- `maxDtMs 250`: long gaps (tab switch, model stall) reset to zero instead
  of synthesizing a fling.
- Null samples decay velocity toward zero.
- Sign deadband ±25px/s: sub-deadband drift doesn't vote on direction.

`persistence` (0..1) = fraction of the last 8 samples agreeing on the
dominant vertical sign. This is the primary anti-jitter signal: sustained
reading drift scores ~1, oscillation scores ~0.5.

## 3. Fixation — I-DT (`fixation.js`)

Salvucci & Goldberg 2000, dispersion-threshold variant. A 200ms rolling
window is a fixation while bbox spread (width+height) stays under 40px for
≥120ms. Generous thresholds are deliberate: at 100px sensor noise, strict
lab-grade thresholds would never fire. Anything else is `saccade`.

## 4. Events (`gaze/events.js`)

| Event | Rule |
|---|---|
| FIXATION_STARTED/ENDED | I-DT state flips |
| MOVEMENT_STARTED/ENDED | speed crosses `saccadeThresholdPxPerS` (450) |
| EDGE_DWELL_STARTED | gaze stays in the 140px edge band ≥900ms |
| EDGE_DWELL_ENDED | leaves band / tracking lost |
| TRACKING_LOST | no-sample gap >800ms |
| TRACKING_RECOVERED | first sample after loss |

The edge dwell duration (900ms) is the "glance vs. gaze" discriminator: a
200ms glance at the clock never fires it.

## 5. Intent (`gaze/intent.js`)

Directional hypotheses score 0..1 from five weighted evidence channels
(defaults `wEdge .3, wVelocity .3, wPersistence .2, wFixation .1,
wConfidence .1`):

- **edge**: depth 0..1 inside the 140px band (per direction).
- **velocity**: signed speed, deadbanded at 80px/s, full weight ~600px/s.
- **persistence**: sustained drift vs oscillation (see §2).
- **fixation**: movement score (parked on text weakens directional claim).
- **tracking**: provider confidence proxy.

**Hysteresis**: enter at score > 0.62 sustained for 700ms; hold until
score < 0.42. The band between holds state — the mechanism that passed the
SEQ4 no-oscillation test. Document limits veto direction (no intent to
scroll past the end).

**Confidence gating**: below `minConfidence` (0.35) the answer is
UNCERTAIN; on gaps, TRACKING_LOST. The scroller treats both as zero
velocity. Reading (fixated, slow) and Scanning (>900px/s) and Idle
(<120px/s) cover the non-directional cases.

## 6. Scroll strategies (`gaze/scroll.js`)

| Mode | Law |
|---|---|
| smooth | `target = dir · maxVel · conf`, accel-limited ramp (2600px/s²) |
| discrete | one 320px chunk per 1200ms cooldown on held intent |
| edge | `vel = depth01 · maxVel · 2.2`, depth ramps over ~1s of dwell |
| reading | smooth × 0.6, gated on gaze-on-text AND (progressing OR near-end) |
| predictive | smooth × 0.45, starts when text-below < 0.35 (pre-reveal) |
| off | always 0 |

Shared invariants: 700ms intent persistence before any motion, instant
zero on tracking loss / manual override (wheel, scroll keys, touch →
2.5s suppression), e-stop zeroes velocity immediately.

## 7. Reading awareness (`gaze/reading.js`, `gaze/dom.js`)

`document.elementFromPoint` classifies the gaze target into paragraph /
heading / nav / image / code / whitespace / outside — the browser already
knows where text is, so no OCR. `textBelowRatio` samples 8 points down the
gaze column: the "anything left to read?" proxy. `ReadingTracker` keeps the
last 10 on-text fixations; net downward drift ≥30px with limited
regressions (≤⅓ of steps) counts as *progressing* — re-reading lines is
normal and tolerated. The anti-gimmick rule lives here: **downward gaze
at whitespace/chrome never scrolls in reading mode.**

## 8. Calibration

5-point (fast) or 9-point (thorough) grid at 10% viewport margins, 5 taps
per point (ridge regression wants repeated labelled samples). Quality =
mean live-prediction error at click time: <120px good, <200px fair, else
poor; `unknown` when predictions are unavailable rather than a fake
number. State (score only, never images) persists to localStorage.
