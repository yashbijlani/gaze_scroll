// Two-eye fusion.
//
// The previous estimator concatenated both eyes into one feature vector, so
// a blink, glasses reflection, or bad landmark in *one* eye corrupted the
// whole prediction. Here each eye gets its own mapper (trained on that eye's
// features plus the shared head-pose channels) and the two estimates are
// fused with inverse-variance weighting:
//
//   - both agree  → confidence up, estimate is the weighted mean
//   - they disagree → agreement drops, the more confident eye wins,
//                     and overall confidence is reduced (never scroll on a
//                     split vote)
//   - one eye lost → graceful single-eye fallback with reduced confidence
//
// Pure and unit-tested. No DOM.

import { FEATURE_GROUPS, FEATURE_DIM, NEUTRAL_FEATURES } from './features.js';
import { GazeMapper } from './mapping.js';

// Full-length vector with one eye's channels + all global channels.
export function eyeFeatureView(features, side) {
  const out = NEUTRAL_FEATURES.slice();
  for (const i of FEATURE_GROUPS[side]) out[i] = features[i] ?? 0;
  for (const i of FEATURE_GROUPS.global) out[i] = features[i] ?? 0;
  return out;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

// Pure fusion of per-eye estimates.
// estimates: [{ x, y, sigma, confidence }] (0..2 entries; nulls allowed)
// opts.agreeScalePx: distance at which agreement falls to ~0.37.
export function fuseEyeEstimates(estimates, { agreeScalePx = 120 } = {}) {
  const valid = (estimates ?? []).filter(
    (e) => e && Number.isFinite(e.x) && Number.isFinite(e.y),
  );
  if (valid.length === 0) {
    return { x: null, y: null, sigma: null, confidence: 0, agreement: 0, used: 0 };
  }
  if (valid.length === 1) {
    const e = valid[0];
    return {
      x: e.x,
      y: e.y,
      sigma: e.sigma ?? null,
      confidence: clamp01((e.confidence ?? 0.5) * 0.75),
      agreement: 0,
      used: 1,
    };
  }
  const [a, b] = valid;
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  const agreement = Math.exp(-d / agreeScalePx);
  const wA = (a.confidence ?? 0.5) / ((a.sigma ?? 50) ** 2 + 1);
  const wB = (b.confidence ?? 0.5) / ((b.sigma ?? 50) ** 2 + 1);
  const wsum = wA + wB || 1;
  const x = (a.x * wA + b.x * wB) / wsum;
  const y = (a.y * wA + b.y * wB) / wsum;
  // Disagreement shrinks confidence hard (a split vote must not scroll).
  const base = Math.max(a.confidence ?? 0, b.confidence ?? 0);
  const confidence = clamp01(base * (0.35 + 0.65 * agreement));
  const sigma = Math.max(a.sigma ?? 0, b.sigma ?? 0) / Math.sqrt(2) + d * (1 - agreement);
  return { x, y, sigma, confidence, agreement, used: 2 };
}

// Trains three mappers (combined, left-only, right-only) on the same
// calibration samples and fuses their predictions.
export class TwoEyeGazeModel {
  constructor(mapperOpts = {}) {
    this.opts = mapperOpts;
    this.combined = new GazeMapper(mapperOpts);
    this.left = new GazeMapper(mapperOpts);
    this.right = new GazeMapper(mapperOpts);
  }

  get count() {
    return this.combined.count;
  }

  addSample(features, x, y, weight = 1) {
    const a = this.combined.addSample(features, x, y, weight);
    this.left.addSample(eyeFeatureView(features, 'left'), x, y, weight);
    this.right.addSample(eyeFeatureView(features, 'right'), x, y, weight);
    return a;
  }

  clear() {
    this.combined.clear();
    this.left.clear();
    this.right.clear();
  }

  fit() {
    const r = this.combined.fit();
    this.left.fit();
    this.right.fit();
    return r;
  }

  // perEye: { left: confidence, right: confidence } from feature quality.
  // Primary estimate comes from the *combined* mapper, which cancels
  // common-mode head pose using both eyes. Per-eye estimates are used to
  // measure agreement and, under strong disagreement (one eye occluded /
  // bad landmarks), to fall back to the more confident single eye — with a
  // confidence penalty so a split vote cannot drive scrolling.
  // Returns { x, y, sigma, confidence, agreement, used, perEye, novelty } | null.
  predict(features, perEye = {}) {
    if (!this.combined.fit()) return null;
    const combined = this.combined.predict(features);
    if (!combined) return null;
    const l = this.left.predict(eyeFeatureView(features, 'left'));
    const r = this.right.predict(eyeFeatureView(features, 'right'));
    const estimates = [];
    if (l) estimates.push({ ...l, confidence: perEye.left ?? 0.7 });
    if (r) estimates.push({ ...r, confidence: perEye.right ?? 0.7 });
    const fused = fuseEyeEstimates(estimates);

    const lc = perEye.left ?? 0.7;
    const rc = perEye.right ?? 0.7;
    // Only override the combined estimate when one eye is *clearly* degraded
    // (low landmark/EAR quality) — disagreement from model error alone must
    // not replace a better combined estimate, only lower confidence.
    const oneEyeDegraded = Math.min(lc, rc) < 0.5 && Math.max(lc, rc) > 0.7;

    let x = combined.x;
    let y = combined.y;
    let sigma = combined.sigma;
    let confidence = 0.6;
    if (fused.used === 2 && fused.agreement >= 0.5) {
      // Eyes agree: combined is trustworthy.
      confidence = 0.55 + 0.45 * fused.agreement;
    } else if (fused.used === 2 && oneEyeDegraded) {
      // One eye occluded: prefer the good eye, but keep confidence low.
      const pick = lc >= rc ? l : r;
      if (pick) {
        x = pick.x;
        y = pick.y;
        sigma = pick.sigma;
      }
      confidence = 0.4;
    } else if (fused.used === 2) {
      // Eyes disagree without a clear culprit: keep combined, distrust it.
      confidence = 0.3 + 0.4 * fused.agreement;
    } else if (fused.used === 1) {
      confidence = 0.45; // single-eye fallback
    }
    return {
      x,
      y,
      sigma,
      confidence,
      agreement: fused.agreement,
      used: fused.used,
      perEye: { left: l ?? null, right: r ?? null },
      novelty: combined.novelty,
      combined,
    };
  }

  toJSON() {
    return { combined: this.combined.toJSON(), left: this.left.toJSON(), right: this.right.toJSON() };
  }

  static fromJSON(json) {
    const m = new TwoEyeGazeModel({ model: json?.combined?.model ?? 'poly2' });
    if (json?.combined) m.combined = GazeMapper.fromJSON(json.combined);
    if (json?.left) m.left = GazeMapper.fromJSON(json.left);
    if (json?.right) m.right = GazeMapper.fromJSON(json.right);
    return m;
  }
}
