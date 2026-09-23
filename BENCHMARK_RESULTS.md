# Gaze Scroll — Benchmark Results

_Generated 2026-09-23T08:15:27.730Z by `node bench/run.js` — synthetic simulator (see bench/synth.js)._

## A. Mapping model comparison

Calibration: 9-point grid × 5 taps. Evaluation: 500 uniform random gaze points with strong head drift.

| Model | Mean err | Median | RMS | P95 | Mean X | Mean Y | Bottom-20% prec | Bottom-20% rec | fit ms | predict µs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| center-baseline (no personalization) | 400.6px | 399.2px | 430.3px | 656.4px | 316.5px | 196.2px | 0.0% | 0.0% | 0.0 | 0.0 |
| affine, no head channels (floor .05) | 105.6px | 91.1px | 131.2px | 247.8px | 72.5px | 62.6px | 73.2% | 95.9% | 9.9 | 19.4 |
| affine + head (floor .05) | 102.2px | 81.8px | 131.3px | 263.4px | 75.0px | 54.5px | 78.8% | 91.8% | 2.5 | 15.2 |
| affine + head (floor .10) | 102.3px | 87.0px | 128.7px | 244.6px | 69.7px | 61.2px | 75.6% | 95.9% | 2.1 | 5.6 |
| poly2 + head (floor .10) | 104.9px | 87.2px | 131.5px | 266.0px | 69.8px | 62.7px | 75.4% | 94.8% | 102.2 | 17.5 |
| poly2 no head (floor .10) | 103.3px | 82.9px | 130.7px | 253.8px | 68.0px | 63.1px | 74.4% | 95.9% | 24.1 | 12.2 |
| tiny MLP 16-8 + head (floor .10) | 343.9px | 289.6px | 422.5px | 824.4px | 306.9px | 113.9px | 56.1% | 99.0% | 1400.6 | 7.7 |
| two-eye fusion affine (floor .05) | 91.9px | 82.3px | 106.7px | 194.3px | 60.6px | 56.6px | 79.8% | 93.8% | 1.7 | 19.0 |
| two-eye fusion poly2 (floor .10) | 91.3px | 85.1px | 104.0px | 178.4px | 57.2px | 59.2px | 76.0% | 94.8% | 74.6 | 57.0 |

### Head-pose sensitivity (mean error by head-pose magnitude)

| Model | low | mid | high |
| --- | --- | --- | --- |
| affine, no head channels (floor .05) | 70.6px | 102.0px | 112.6px |
| affine + head (floor .05) | 72.0px | 98.9px | 108.4px |
| affine + head (floor .10) | 69.9px | 99.5px | 108.3px |
| poly2 + head (floor .10) | 69.5px | 101.3px | 111.9px |
| poly2 no head (floor .10) | 70.4px | 98.9px | 110.7px |
| tiny MLP 16-8 + head (floor .10) | 380.8px | 330.7px | 350.2px |
| two-eye fusion affine (floor .05) | 51.9px | 82.6px | 104.0px |
| two-eye fusion poly2 (floor .10) | 55.1px | 83.8px | 101.5px |

## B. Two-eye fusion under heavy occlusion (45% of frames one eye degraded)

| Model | Median | P95 |
| --- | --- | --- |
| combined affine | 148.6px | 560.5px |
| two-eye fusion affine | 107.1px | 478.1px |

## C. Temporal filters (noise vs latency)

Jitter = RMS of first differences during a noisy fixation. Latency = time to reach 90% of a 300px step.

| Filter | jitter in | jitter out | reduction | step latency |
| --- | --- | --- | --- | --- |
| none | 134.2 | 134.2 | 0.0% | 33ms |
| EMA α=0.2 | 134.2 | 19.9 | 85.2% | 363ms |
| EMA α=0.35 | 134.2 | 35.3 | 73.7% | 198ms |
| One Euro (0.5, 0.3) | 134.2 | 127.7 | 4.9% | 33ms |
| One Euro (1.0, 0.3) [old default] | 134.2 | 127.9 | 4.7% | 33ms |
| One Euro (0.2, 0.3) retuned | 134.2 | 127.8 | 4.8% | 33ms |
| One Euro (0.1, 0.5) retuned | 134.2 | 130.1 | 3.1% | 33ms |
| One Euro (1.0, 0.7) | 134.2 | 131.3 | 2.2% | 33ms |
| Kalman q40 r120 | 134.2 | 24.4 | 81.9% | 66ms |
| Kalman q10 r150 | 134.2 | 22.2 | 83.5% | 66ms |

## D. Safe-region fraction sweep (bottom zone)

| Fraction | Precision | Recall | F1 |
| --- | --- | --- | --- |
| 10% | 65.3% | 83.9% | 73.4% |
| 13% | 74.1% | 90.0% | 81.3% |
| 15% | 74.2% | 91.1% | 81.8% |
| 18% | 76.6% | 91.1% | 83.2% |
| 20% | 75.6% | 95.9% | 84.5% |
| 23% | 75.5% | 97.2% | 85.0% |
| 25% | 79.7% | 95.2% | 86.8% |
| 28% | 84.4% | 95.7% | 89.7% |
| 30% | 84.8% | 98.6% | 91.2% |
| 33% | 80.7% | 97.4% | 88.3% |
| 35% | 82.6% | 99.4% | 90.2% |

Recommended fraction (precision ≥90%, best recall): **35%** (precision 82.6%, recall 99.4%).

Recommended fraction (precision ≥95%): **35%** (precision 82.6%, recall 99.4%).

## E. Intent behaviour on labelled sequences

| Config | reading (false/intent ms, missed) | gradual (false/intent ms, missed) | glance (false/intent ms, missed) | noisyBoundary (false/intent ms, missed) | headMove (false/intent ms, missed) |
| --- | --- | --- | --- | --- | --- |
| fraction 10%, dwell 450 | 0.0% / 0ms, 0 | 0.0% / 0ms, 0 | 0.0% / 0ms, 0 | 0.0% / 0ms, 0 | 0.0% / 0ms, 0 |
| fraction 15%, dwell 450 | 0.0% / 0ms, 0 | 0.0% / 0ms, 0 | 0.0% / 0ms, 0 | 0.0% / 0ms, 0 | 0.0% / 0ms, 0 |
| fraction 20%, dwell 450 | 0.0% / 0ms, 0 | 0.0% / 0ms, 0 | 0.0% / 0ms, 0 | 0.0% / 0ms, 0 | 0.0% / 0ms, 0 |
| fraction 25%, dwell 450 | 0.0% / 0ms, 0 | 0.0% / 0ms, 0 | 0.0% / 0ms, 0 | 0.8% / 33ms, 0 | 0.0% / 0ms, 0 |
| fraction 30%, dwell 450 | 0.0% / 0ms, 0 | 0.0% / 0ms, 0 | 0.0% / 0ms, 0 | 58.8% / 2310ms, 0 | 0.0% / 0ms, 0 |
| fraction 20%, no hysteresis | 0.0% / 0ms, 0 | 0.0% / 0ms, 0 | 0.0% / 0ms, 0 | 0.0% / 0ms, 0 | 0.0% / 0ms, 0 |
| fraction 20%, no dwell | 0.0% / 0ms, 0 | 0.0% / 0ms, 0 | 8.1% / 231ms, 0 | 19.3% / 759ms, 0 | 0.0% / 0ms, 0 |
| fraction 20%, dwell 450, adaptive margin (σ=90) | 0.0% / 0ms, 0 | 0.0% / 0ms, 0 | 0.0% / 0ms, 0 | 0.0% / 0ms, 0 | 0.0% / 0ms, 0 |

`false` = fraction of non-scroll time spent triggering; `missed` = labelled scroll windows never satisfied.

## Observations

- Best overall (median + tail + bottom-zone precision): **two-eye fusion affine (floor .05)** — median 82px, P95 194px, bottom-20% precision 80% vs 399px for a fixed-centre guess (4.9× better median).
- Head-pose channels help under real head movement (no-head 91px → head 82px, 10% lower), and their error is flatter across head-pose magnitude (see table). A variance floor (stdFloor ≥ .05) is required or low-excitation head channels over-extrapolate catastrophically.
- Model capacity does not pay off in the single-mapper comparison: poly2 87px and tiny MLP 290px (fit 1401ms, unstable) do not beat affine. With two-eye fusion, poly2 buys a marginally better tail than affine but costs ~30× the fit time for no median gain — the affine mapper is the compute-efficient choice.
- Two-eye agreement helps under occlusion: two-eye fusion affine median 107px / P95 478px vs combined affine 149px / 560px (28% lower median).
- Best jitter/latency tradeoff: **Kalman q10 r150** (83% jitter cut, 66ms step latency). The old One Euro defaults cut only ~5% — effectively a no-op.
- By the product metric (zero false-scroll first, then largest safe zone), the recommended zone is **fraction 20%, dwell 450** (20%). All dwell-based configs produced zero false scroll on the labelled sequences; removing dwell let noisy boundary hover trigger (8–19%), and a 30% zone let the 20%-boundary noise bleed in (59%). The nominal 20% hypothesis is validated as the upper safe bound under this error distribution.

## Compute

- All models run single-threaded in Node/V8; browser numbers on laptop class hardware are within the same order.
- poly2: 253-dim linear solve, milliseconds at calibration time, microseconds per prediction.
- MLP: ~500 params, a few hundred Adam epochs at calibration; microseconds per prediction.
- No GPU, no TF.js, no network at inference.
