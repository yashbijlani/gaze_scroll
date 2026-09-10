# Gaze Scroll — Experiments

How to compare scroll strategies scientifically. Recordings contain only
anonymized gaze-derived numbers (never video).

## Protocol

1. Calibrate (note points mode + quality label from the summary card).
2. In the Gaze Lab, press **Record**, read naturally for 1–2 minutes
   (include: steady reading, a skim, a glance at the clock/edges, one
   manual wheel override).
3. **Export JSON**. Filename convention:
   `subjNN_mode_attemptN.json`, e.g. `subj01_reading_attempt2.json`.
4. Replay the same file under each mode (smooth / discrete / edge /
   reading / predictive) at 1×. Note false positives (scrolled when you
   wouldn't want it) and false negatives (didn't scroll when you would).
5. Log conditions: lighting, glasses, posture, viewport size, calibration
   score — all affect results as much as the algorithm.

## What to record per run

| Field | Example |
|---|---|
| subject/setup | subj01, office light, glasses, 1280×800 |
| calibration | 9-pt, fair (~150px) |
| mode + params | reading, maxVel 900, minConf 0.35 |
| false positives | 2 (glance at bottom link scrolled) |
| false negatives | 1 (slow finish at section end didn't reveal) |
| notes | edge dwell fired during skim |

## Session file format (v1)

`{ version: 1, exportedAt, meta: { viewport, userAgent, scrollMode,
config, calibration }, rows: [...] }` — rows carry timestamp, x/y,
normalized coords, confidence, velocity, intent + confidence, edge side,
DOM role, scroll position/velocity, mode. Enough to re-drive
filter → events → intent → scroll without a camera.

## Results log

| Date | Session | Mode | FP | FN | Notes |
|---|---|---|---|---|---|
| — | — | — | — | — | (no runs yet — fill in as you experiment) |

## Synthetic baselines (automated, `npm test`)

SEQ1 stable center → READING/IDLE, no scroll. SEQ2 drift + dwell →
LOOKING_DOWN then scroll. SEQ3 brief glance → no scroll. SEQ4 threshold
noise → no oscillation. SEQ5 confidence collapse → motion stops. SEQ6
manual scroll → controller yields. Replay determinism via MockProvider.
