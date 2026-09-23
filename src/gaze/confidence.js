// Explicit gaze confidence.
//
// The old pipeline had a placeholder "confidence" (face present + distance
// from the screen edge). This model combines the signals that actually
// predict whether a prediction is trustworthy:
//
//   presence      face detected this frame
//   landmarks     eye-landmark coverage + iris availability
//   eyesOpen      eyelid visibility (blinks / occlusion)
//   agreement     two-eye agreement (from fusion)
//   novelty       distance from the calibration feature distribution
//   head          head-pose deviation from the calibrated baseline
//   calibration   calibration fit quality (residual RMS)
//
// Low confidence MUST disable automatic scrolling; the scroll controller
// already gates on intent confidence, and this feeds it. Pure and tested.

import { FEATURE_GROUPS } from './features.js';

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// Mean head-pose feature vector over calibration samples (the "neutral"
// pose). features: array of feature vectors.
export function headBaseline(sampleVectors) {
  if (!sampleVectors || sampleVectors.length === 0) return null;
  const idx = FEATURE_GROUPS.global;
  const base = new Array(idx.length).fill(0);
  for (const f of sampleVectors) {
    idx.forEach((fi, k) => {
      base[k] += f[fi] ?? 0;
    });
  }
  return base.map((v) => v / sampleVectors.length);
}

// Normalized deviation of a feature vector's head channels from baseline.
// 0 = at baseline, ~1 = about one typical inter-ocular unit of movement.
export function headPoseDelta(features, baseline) {
  if (!features || !baseline) return 0;
  const idx = FEATURE_GROUPS.global;
  let s = 0;
  idx.forEach((fi, k) => {
    const scale = k === 5 || k === 6 ? 1 : 0.15; // roll sin/cos vs positions
    const d = ((features[fi] ?? 0) - baseline[k]) / scale;
    s += d * d;
  });
  return Math.sqrt(s / idx.length);
}

// Residual RMS (px) → 0..1 calibration quality.
export function calibrationQualityFromResidual(rmsPx) {
  if (!Number.isFinite(rmsPx)) return 0.5;
  if (rmsPx <= 60) return 1;
  if (rmsPx >= 220) return 0.1;
  return clamp01(1 - (rmsPx - 60) / 200);
}

const WEIGHTS = {
  presence: 0.12,
  landmarks: 0.18,
  eyesOpen: 0.18,
  agreement: 0.2,
  novelty: 0.14,
  head: 0.1,
  calibration: 0.08,
};

export class ConfidenceModel {
  constructor(cfg = {}) {
    this.cfg = cfg;
  }

  // inputs: {
  //   hasFace, quality (features.js), agreement, used,
  //   novelty, headDelta, calRms, sigma
  // }
  // Returns { score: 0..1, factors }.
  score(inputs = {}) {
    const q = inputs.quality ?? {};
    const visibility =
      Number.isFinite(q.leftVisibility) && Number.isFinite(q.rightVisibility)
        ? (q.leftVisibility + q.rightVisibility) / 2
        : clamp01(((q.leftEar ?? 0) + (q.rightEar ?? 0)) / 2 / 0.2);

    const factors = {
      presence: inputs.hasFace ? 1 : 0.05,
      landmarks: clamp01((q.coverage ?? 0) * (q.irisAvailable ? 1 : 0.7)) || 0.05,
      eyesOpen: clamp01(0.1 + 0.9 * visibility),
      agreement: inputs.used >= 2 ? clamp01(0.4 + 0.6 * (inputs.agreement ?? 0)) : 0.55,
      novelty: 1 / (1 + Math.max(0, (inputs.novelty ?? 0) - 0.5)),
      head: 1 / (1 + (inputs.headDelta ?? 0)),
      calibration: calibrationQualityFromResidual(inputs.calRms),
    };

    let logSum = 0;
    let wSum = 0;
    for (const [k, w] of Object.entries(WEIGHTS)) {
      logSum += w * Math.log(Math.max(1e-4, factors[k]));
      wSum += w;
    }
    let score = clamp01(Math.exp(logSum / wSum));
    // Extra penalty when the model itself reports a large uncertainty.
    if (Number.isFinite(inputs.sigma) && inputs.sigma > 0) {
      score = clamp01(score * clamp01(140 / inputs.sigma, 0.25, 1));
    }
    return { score, factors };
  }

  // Boolean gate used by the scroll pipeline.
  passes(score, minConfidence = 0.35) {
    return score >= minConfidence;
  }
}
