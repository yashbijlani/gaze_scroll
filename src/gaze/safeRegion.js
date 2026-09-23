// Adaptive safe region + hysteresis.
//
// Product discovery: for scrolling we do NOT need exact gaze pixels — we
// need "is the user reliably looking at the lower safe region?". A brief
// glance must not scroll; jitter at the boundary must not oscillate.
//
// This module makes the lower zone a first-class, measured concept:
//
//   - nominal fraction (default bottom 20%) is configurable;
//   - the *margin* is adaptive: with a ±sigma pixel error estimate, the
//     effective enter boundary is pushed deeper by k·sigma so that a
//     prediction inside the zone is actually inside with high probability;
//   - separate enter/exit boundaries give hysteresis (enter deep, leave
//     shallower) so boundary jitter cannot toggle scrolling;
//   - a dwell timer is the glance-vs-gaze discriminator;
//   - confidence gates intent: uncertain gaze never scrolls.
//
// Metrics (zone precision/recall, false-scroll, missed-scroll) are pure and
// used by the benchmark to choose the fraction from data rather than
// assuming 20%.

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export const DEFAULT_REGION = {
  side: 'bottom',
  fraction: 0.2, // nominal: bottom 20% of the viewport
  enterMargin: 0.02, // extra depth before entering
  exitMargin: 0.06, // how far you must rise to leave (hysteresis)
  dwellMs: 450, // sustained presence before intent
  minConfidence: 0.4,
  sigmaK: 1.3, // adaptive margin = sigmaK · sigmaPx
  sigmaPx: 0, // live model error estimate (px)
};

export class SafeRegion {
  constructor(cfg = {}) {
    this.cfg = { ...DEFAULT_REGION, ...cfg };
    this.reset();
  }

  setSigma(sigmaPx) {
    if (Number.isFinite(sigmaPx)) this.cfg.sigmaPx = sigmaPx;
  }

  // Boundary as a normalized y (0 top .. 1 bottom).
  enterBoundary() {
    const margin = (this.cfg.sigmaK * (this.cfg.sigmaPx ?? 0)) / this._h();
    if (this.cfg.side === 'top') {
      return this.cfg.fraction - this.cfg.enterMargin - margin;
    }
    return 1 - this.cfg.fraction + this.cfg.enterMargin + margin;
  }

  exitBoundary() {
    const margin = (this.cfg.sigmaK * (this.cfg.sigmaPx ?? 0)) / this._h();
    if (this.cfg.side === 'top') {
      return this.cfg.fraction + this.cfg.exitMargin + margin;
    }
    return 1 - this.cfg.fraction - this.cfg.exitMargin - margin;
  }

  _h() {
    return this._viewportH ?? 800;
  }

  reset() {
    this.inside = false;
    this.since = null;
    this._viewportH = 800;
    this.last = this.#snapshot(0, false);
  }

  #snapshot(dwellMs, intent) {
    return {
      side: this.cfg.side,
      inside: this.inside,
      dwellMs,
      intent,
      direction: this.cfg.side === 'bottom' ? 'down' : 'up',
      confidence: 0,
    };
  }

  // y: predicted gaze y (px); h: viewport height; confidence: 0..1.
  update(y, h, confidence, t) {
    if (h > 0) this._viewportH = h;
    const norm = y / this._h();
    const confOk = (confidence ?? 1) >= this.cfg.minConfidence;
    const enter = this.enterBoundary();
    const exit = this.exitBoundary();
    const inZone = this.cfg.side === 'top' ? norm <= enter : norm >= enter;
    const outZone = this.cfg.side === 'top' ? norm >= exit : norm <= exit;

    if (!this.inside && inZone) {
      this.inside = true;
      this.since = t;
    } else if (this.inside && outZone) {
      this.inside = false;
      this.since = null;
    }
    const dwellMs = this.inside && this.since != null ? t - this.since : 0;
    const intent = this.inside && dwellMs >= this.cfg.dwellMs && confOk;
    this.last = {
      ...this.#snapshot(dwellMs, intent),
      confidence: confidence ?? 0,
    };
    return this.last;
  }
}

// --- Metrics (pure) ---

// Zone membership metrics over predicted/actual pairs.
// pairs: [{ predY, actualY, h, confidence? }]
export function zoneMetrics(pairs, fraction, { side = 'bottom', minConfidence = 0 } = {}) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const p of pairs) {
    if (p.predY == null || p.actualY == null || !(p.h > 0)) continue;
    if ((p.confidence ?? 1) < minConfidence) continue;
    const inZone = (y) =>
      side === 'top' ? y <= fraction * p.h : y >= (1 - fraction) * p.h;
    const pred = inZone(p.predY);
    const act = inZone(p.actualY);
    if (pred && act) tp++;
    else if (pred && !act) fp++;
    else if (!pred && act) fn++;
    else tn++;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, tp, fp, fn, tn, n: tp + fp + fn + tn };
}

// Sweep candidate fractions and pick one meeting a precision target with the
// best recall. This is how the safe region is chosen from measured error
// instead of hard-coding 20%.
export function recommendFraction(
  pairs,
  { side = 'bottom', targetPrecision = 0.9, minFraction = 0.1, maxFraction = 0.35, step = 0.01, minConfidence = 0 } = {},
) {
  let best = null;
  for (let f = minFraction; f <= maxFraction + 1e-9; f += step) {
    const m = zoneMetrics(pairs, f, { side, minConfidence });
    if (m.n === 0) continue;
    if (m.precision >= targetPrecision) {
      if (!best || m.recall > best.recall) best = { fraction: round2(f), ...m };
    }
  }
  return best ?? { fraction: maxFraction, ...zoneMetrics(pairs, maxFraction, { side, minConfidence }) };
}

// Run the SafeRegion state machine over a labelled sequence.
// seq: [{ t, predY, h, confidence, wants }] where wants = ground truth.
export function sequenceScrollMetrics(seq, regionCfg = {}) {
  const region = new SafeRegion(regionCfg);
  let falseIntentMs = 0;
  let notWantMs = 0;
  let falseEpisodes = 0;
  let missedEpisodes = 0;
  let prevIntent = false;
  let wantActive = false;
  let satisfied = false;
  let prevT = null;
  for (const s of seq) {
    const r = region.update(s.predY, s.h, s.confidence, s.t);
    if (s.wants) {
      if (!wantActive) {
        wantActive = true;
        satisfied = false;
      }
      if (r.intent) satisfied = true;
    } else {
      if (wantActive) {
        if (!satisfied) missedEpisodes++;
        wantActive = false;
      }
      notWantMs += prevT == null ? 0 : s.t - prevT;
      if (r.intent) {
        falseIntentMs += prevT == null ? 0 : s.t - prevT;
        if (!prevIntent) falseEpisodes++;
      }
    }
    prevIntent = r.intent;
    prevT = s.t;
  }
  if (wantActive && !satisfied) missedEpisodes++;
  return {
    falseScrollRate: notWantMs > 0 ? falseIntentMs / notWantMs : 0,
    falseEpisodes,
    missedEpisodes,
    falseIntentMs,
    notWantMs,
  };
}

function round2(v) {
  return Math.round(v * 100) / 100;
}
