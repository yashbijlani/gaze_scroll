# WebGaze — Accuracy Overhaul

A complete pass over the gaze-accuracy pipeline: what existed, what was
measured, what was changed, and why. Numbers come from the headless benchmark
(`node bench/run.js`, full tables in `BENCHMARK_RESULTS.md`). Failed
experiments are documented, not hidden.

---

## 1. Executive summary

The old estimator mapped **raw 16×12 grayscale eye patches** (391 dims) to
screen coordinates with a **single global linear ridge** (λ = 0.1) trained
from click calibration. It was high-dimensional, head-pose confounded, had no
per-eye handling, and no real confidence. Its smoothing (One Euro with
defaults) turned out to be **effectively a no-op** (≈5% jitter reduction).

The overhaul replaces the estimator with a **normalized geometric feature**
pipeline and adds measured robustness:

```
landmarks → normalized geometric features (iris-in-eye, EAR, head pose)
          → personalized affine mapping with two-eye agreement
          → explicit confidence
          → constant-velocity Kalman filter
```

Benchmark result (synthetic simulator, 500 random gaze points with strong
head drift, 9-point × 5-tap calibration):

| | Median error | P95 error | Bottom-20% zone precision | Fit cost | Predict cost |
|---|---|---|---|---|---|
| Fixed-centre (no personalization) | 399px | 656px | 0% | — | — |
| **New: two-eye geometry + affine + Kalman** | **82px** | **194px** | **80%** | ~4ms | ~20µs |
| Legacy appearance-patch ridge (documented range) | ~100–130px | — | — | — | — |

Additional measured outcomes:

- **False-scroll: 0%** on all labelled intent sequences with dwell ≥ 450ms;
  removing dwell let a brief glance trigger (8–19%).
- **Head-pose channels** reduce median error ~10% under strong head movement
  and flatten error across head-pose magnitude — but only with a variance
  floor; without one they over-extrapolate catastrophically.
- **Model capacity does not pay off**: a 253-dim poly2 and a tiny MLP do not
  beat the affine mapper; the MLP was unstable. Feature normalization, not
  model size, was the accuracy lever.
- **Compute stays tiny**: pure JS, no GPU, no TF.js at inference; ~4ms fit,
  ~20µs/prediction, single-threaded.

---

## 2. The system as found

WebGaze is a browser-only, privacy-preserving gaze-scrolling prototype.
Architecture (unchanged by this overhaul except the estimator):

```
webcam → gaze provider → filter → event detector → intent engine
       → scroll controller → webpage
```

Estimator (`src/gaze/landmarker.js` + `src/gaze/ridge.js`):

- MediaPipe Tasks FaceLandmarker (standalone) supplies 468 landmarks.
- Each eye cropped to a box → 16×12 grayscale = 192 features/eye.
- 6 crude head-pose scalars appended (face center/size, eye-line roll, eye
  height) → **391 dims**.
- Own ridge regression `(XᵀX + λI)w = Xᵀt`, λ = 0.1, Gaussian elimination.
- Calibration: 5/9-point grid, 5 taps/point, outlier drop by L1 distance to
  the median feature vector; persisted to localStorage.

Downstream (kept, with a new confidence source and adaptive edge band):
One Euro smoothing → EMA velocity + direction persistence → I-DT fixation →
discrete events → evidence-weighted intent with hysteresis → scroll modes
(discrete/smooth/edge/reading/predictive).

---

## 3. Weaknesses identified

| # | Weakness | Evidence / consequence |
|---|---|---|
| 1 | **Appearance patches confound head pose** with eyeball rotation | The same patch means different gaze as the head moves; no 3D model. |
| 2 | **Underdetermined linear fit** (391 dims, ~45 samples, λ=0.1) | Compression toward centre; unstable weights. |
| 3 | **No per-eye handling** | A blink/reflection in one eye corrupts the whole vector. |
| 4 | **No real confidence** | Old proxy = face present + distance from screen edge; unrelated to model uncertainty. |
| 5 | **Smoothing near-no-op** | Benchmark: One Euro defaults cut ~5% of fixation jitter. |
| 6 | **Fixed edge band** (140px) | Not adapted to measured error or viewport. |
| 7 | **No quantitative accuracy benchmark** | Quality was an ad-hoc live click-error readout; no zone precision/recall, no false-scroll measurement. |
| 8 | **Head features crude and unregularized** | Face center/size/roll only; no yaw/pitch. |

---

## 4. Benchmark design

Because the overhaul must be *measured* and this environment has no camera, a
headless simulator generates feature vectors in the exact layout of the new
extractor (`bench/synth.js`), with:

- latent gaze → iris offset with **distance-scaled gain** and **tanh
  saturation** (nonlinear),
- **head-pose confound** (yaw leaks into iris X, pitch into iris Y),
- per-eye independent noise and **12–45% occlusion**,
- natural head drift (translation, scale, roll, yaw, pitch).

Candidate mappers train on an identical 9-point × 5-tap calibration and are
evaluated on 500 random gaze points. Metrics (`bench/metrics.js`): mean,
median, RMS, P95, per-axis, per-region, **bottom-zone precision/recall**, and
error stratified by head-pose magnitude. Intent behaviour is measured on
labelled sequences (reading, gradual, glance, noisy boundary, head move) with
**false-scroll rate** and **missed scrolls**.

**Honesty note:** this is a simulator, not a subject study. It validates the
*relative* ranking of algorithms and the *behaviour* of the intent logic. The
harness also accepts recorded sessions with a `features` array, so real data
can drive the same comparisons. Absolute errors are simulator-relative.

---

## 5. Experiments and results

Full tables: `BENCHMARK_RESULTS.md`. Highlights:

### 5.1 Mapping models

| Model | Median | P95 | Bottom-20% precision |
|---|---|---|---|
| affine, no head channels | 91px | 248px | 73% |
| affine + head, floor .05 | 82px | 263px | 79% |
| poly2 + head, floor .10 | 87px | 266px | 75% |
| tiny MLP 16-8 | 290px | 824px | 56% |
| **two-eye model, affine** | **82px** | **194px** | **80%** |
| two-eye model, poly2 | 85px | 178px | 76% |

Findings:

- **Normalized geometry is the win.** A per-eye iris offset in a roll-invariant
  local frame plus head channels reaches ~82px median vs ~100–130px for the
  old appearance ridge, and vs 399px with no personalization.
- **Head channels help under movement** (~10% median, flatter across pose),
  *if* a variance floor prevents low-excitation channels from exploding.
- **Capacity doesn't pay.** poly2/MLP add compute and instability, not accuracy.
- **Two-eye agreement is the best single change for the product**: it cuts P95
  from 263px → 194px and raises bottom-zone precision to 80%, and under heavy
  occlusion it improves median 28% and P95 15% over a combined-only mapper.

### 5.2 Temporal filters

| Filter | Jitter cut | Step latency |
|---|---|---|
| One Euro (1.0, 0.3) — old default | 5% | 33ms |
| EMA α=0.2 | 85% | 363ms |
| **Kalman q10 r150** | **83%** | **66ms** |

The old One Euro configuration barely filtered. A constant-velocity Kalman
filter is the best jitter/latency tradeoff; EMA is an acceptable cheaper
fallback.

### 5.3 Safe region and intent

- Bottom-zone membership precision/recall were swept from 10% to 35% of the
  viewport. Under the measured error distribution, ~20% is the largest zone
  that keeps **false-scroll at zero** on all labelled sequences; a 30% zone
  lets boundary noise bleed in (59% false-scroll on the noisy-boundary
  sequence).
- **Dwell is essential**: with dwell removed, a brief downward glance and
  boundary hover both triggered (8–19% false). With dwell ≥ 450ms, zero false
  scroll across every sequence.
- Hysteresis (enter deeper than exit) prevents boundary jitter oscillation.
- The adaptive margin (`sigmaK × measured error`) deepens the boundary as
  model error grows, so a prediction inside the zone is truly inside with
  higher probability.

### 5.4 Failed experiments (documented)

- **Tiny MLP (16-8)** did not converge reliably on ~45 calibration samples;
  median 290px, sometimes diverging. Rejected.
- **Full poly2** (253 dims) overfits without aggressive regularization and
  never beat affine after the intercept was left unregularized. Rejected as
  the default; kept selectable.
- **Naïve two-eye averaging** (average the two per-eye predictions) hurt under
  head drift, because each single-eye mapper loses the common-mode head-pose
  cancellation the combined mapper gets for free. Fixed by using the combined
  estimate as primary and per-eye estimates only for agreement/occlusion.
- **Regularizing the bias term** shrank predictions toward zero as λ grew;
  fixed by leaving the intercept unpenalized.
- **No variance floor** let near-constant head channels produce huge z-scores
  and astronomically wrong predictions. Fixed with a std floor + z-clip.

---

## 6. Final chosen architecture

```
                CAMERA (getUserMedia, on-device)
                   │
                   ▼
        MediaPipe FaceLandmarker (478 pts, iris, GPU→CPU)
                   │
                   ▼
   features.js: normalized geometric features (21 dims)
     per eye: iris-in-eye (roll-invariant), EAR, eye size, iris diameter
     global:  face pos/scale, eye-line roll, yaw/pitch proxies
                   │
                   ▼
   mapping.js: per-user affine ridge (unpenalized bias, standardized,
               std-floor + z-clip)  +  fusion.js two-eye model
     combined mapper (primary) + per-eye mappers (agreement/occlusion)
                   │
                   ▼
   confidence.js: landmark/eye/agreement/novelty/head/calibration → 0..1
                   │
                   ▼
   filters.js: constant-velocity Kalman (low lag, high jitter cut)
                   │
                   ▼
   events → intent → adaptive safe region → scroll controller
     (existing pipeline; edge band sized from measured error)
```

Module map:

| Module | Role |
|---|---|
| `src/gaze/features.js` | Pure geometric feature extraction + head pose. |
| `src/gaze/mapping.js` | `GazeMapper` (affine/poly2/MLP), scaler, robust ridge, uncertainty. |
| `src/gaze/fusion.js` | Two-eye model: combined primary, agreement/occlusion fallback. |
| `src/gaze/confidence.js` | Explicit confidence from quality/agreement/novelty/head/cal. |
| `src/gaze/filters.js` | EMA / One Euro / Kalman behind one interface + metrics. |
| `src/gaze/safeRegion.js` | Adaptive zone, hysteresis, dwell, zone/scroll metrics. |
| `src/gaze/geometryProvider.js` | Browser glue: landmarks → features → model → confidence → filter → samples. |
| `bench/` | Simulator, metrics, experiment runner, report. |

The legacy estimators (`landmarker`, `webgazer`) remain selectable in Controls
for comparison; `geometry` is the default.

---

## 7. Compute

- **Inference**: pure JS typed/plain arrays; no GPU, no TF.js, no network.
  ~20µs per fused prediction; the landmarker inference is the dominant cost
  and is shared with the overlay (single-flight).
- **Calibration fit**: ~4ms (affine), lazy on first prediction.
- **Model size**: 3 affine maps (≈22 weights each) + a 21-dim scaler. Bytes.
- **Filter**: O(1) per sample.
- **Memory**: calibration samples are feature vectors only (≈27 samples × 21
  floats), persisted to localStorage as rounded numbers; never images.

This meets the hard requirement: ordinary laptop, no dedicated GPU.

---

## 8. Known limitations

- All absolute numbers are simulator-relative. **Real-camera validation is the
  next step** (record sessions with features, re-run `bench/run.js`).
- The simulator's head confound is additive-in-tanh; real appearance effects
  (glasses reflections, lighting, extreme pose) are richer and will reduce the
  achievable accuracy.
- Iris features require `refineLandmarks: true`; without it the mapper degrades
  to lid/corner geometry (documented fallback, not measured here).
- The adaptive safe-region fraction is currently driven by calibration
  residual; a full closed-loop optimizer over recorded scroll sessions is
  future work.
- Confidence is a designed composite, not a calibrated probability.

---

## 9. Reproduce

```bash
cd gaze_scroll
npm test          # 112 tests, incl. new features/mapping/fusion/confidence/
                  # filters/safeRegion/geometryProvider suites
node bench/run.js # regenerates bench/results.json + BENCHMARK_RESULTS.md
npm run dev       # http://localhost:5173 (webcam; default estimator: geometry)
```

In the app: enable the camera, calibrate, then watch the Gaze Lab. Controls →
Estimator switches between `geometry` (new default), `landmarker` (legacy
patches), and `webgazer` classic, so the improvement is directly comparable
on the same hardware.
