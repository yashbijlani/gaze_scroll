// IntentEngine: evidence → intent (never gaze position → action).
//
// Intents: READING, LOOKING_UP, LOOKING_DOWN, SCANNING, IDLE, UNCERTAIN,
// TRACKING_LOST.
//
// Each directional hypothesis scores 0..1 from weighted evidence:
//   edge proximity (depth inside the edge band)
//   signed vertical velocity (normalized, ~600 px/s = full evidence)
//   direction persistence (sustained drift vs oscillation)
//   movement (1 - fixation: drifting, not parked on text)
//   tracking confidence (provider proxy)
//
// Hysteresis (the anti-flicker core): entering LOOKING_DOWN/UP needs
// score > enterThreshold sustained for minActivationMs; leaving needs
// score < exitThreshold. The band between the thresholds holds state, so
// noisy samples around the boundary cannot oscillate the output.
// Confidence gating: below minConfidence the engine answers UNCERTAIN and
// the scroll controller must not act — never scroll on a guess.

export const Intents = {
  READING: 'READING',
  LOOKING_UP: 'LOOKING_UP',
  LOOKING_DOWN: 'LOOKING_DOWN',
  SCANNING: 'SCANNING',
  IDLE: 'IDLE',
  UNCERTAIN: 'UNCERTAIN',
  TRACKING_LOST: 'TRACKING_LOST',
};

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

export class IntentEngine {
  constructor(cfg = {}, viewport = null) {
    this.cfg = cfg;
    this.viewport = viewport ?? (() => ({ w: window.innerWidth, h: window.innerHeight }));
    this.reset();
  }

  reset() {
    this.current = Intents.IDLE;
    this.currentSince = null;
    this.downEvidenceSince = null;
    this.upEvidenceSince = null;
    this.last = this.emptyResult('IDLE');
  }

  emptyResult(intent) {
    return {
      intent,
      direction: null,
      confidence: 0,
      signals: { edge: 0, velocity: 0, persistence: 0, fixation: 0, tracking: 0 },
    };
  }

  thresholds() {
    const c = this.cfg ?? {};
    return {
      enter: c.enterThreshold ?? 0.62,
      exit: c.exitThreshold ?? 0.42,
      minActivationMs: c.minActivationMs ?? 700,
      minConfidence: c.minConfidence ?? 0.35,
      edgeBandPx: c.edgeBandPx ?? 140,
    };
  }

  weights() {
    const c = this.cfg ?? {};
    return {
      wEdge: c.wEdge ?? 0.3,
      wVelocity: c.wVelocity ?? 0.3,
      wPersistence: c.wPersistence ?? 0.2,
      wFixation: c.wFixation ?? 0.1,
      wConfidence: c.wConfidence ?? 0.1,
    };
  }

  // sample: normalized provider sample; analysis: { fixation, velocity, edge }
  // from GazeEventDetector.update(); ctx: { scrollY, maxScrollY } (optional).
  update(sample, analysis, ctx = {}) {
    const t = sample?.timestamp ?? performance.now();
    const th = this.thresholds();

    if (!sample || sample.x == null || sample.y == null || analysis?.lost) {
      // Face present but no position (blink, uncalibrated model): the
      // honest answer is UNCERTAIN — hold scroll state, never claim loss.
      if (analysis && !analysis.lost && sample?.hasFace) {
        return this.#transition(Intents.UNCERTAIN, null, 0.3, t, this.last.signals);
      }
      return this.#transition(Intents.TRACKING_LOST, null, 1, t, this.last.signals);
    }
    const confidence = sample.confidence ?? 0;
    if (confidence < th.minConfidence) {
      return this.#transition(Intents.UNCERTAIN, null, 1 - confidence, t, this.last.signals);
    }

    const { h } = this.viewport();
    const band = th.edgeBandPx;
    const y = sample.y;
    // Depth 0..1 inside each edge band (0 outside). Bottom band drives DOWN.
    const downDepth = clamp01(((y - (h - band)) / band));
    const upDepth = clamp01(((band - y) / band));
    const vy = analysis?.velocity?.vy ?? 0;
    const speed = analysis?.velocity?.speed ?? 0;
    const persistence = analysis?.velocity?.persistence ?? 0;
    const isFix = analysis?.fixation?.state === 'fixation';
    // Signed velocity evidence, deadbanded: full weight at ~600 px/s.
    const downVel = clamp01((vy - 80) / 520);
    const upVel = clamp01((-vy - 80) / 520);
    const moving = isFix ? 0 : clamp01(speed / 300);
    const w = this.weights();
    const trackW = confidence; // already 0..1

    const downSignals = {
      edge: downDepth,
      velocity: downVel,
      persistence: analysis?.velocity && vy > 25 ? persistence : 0,
      fixation: moving,
      tracking: trackW,
    };
    const upSignals = {
      edge: upDepth,
      velocity: upVel,
      persistence: analysis?.velocity && vy < -25 ? persistence : 0,
      fixation: moving,
      tracking: trackW,
    };
    const score = (s) =>
      w.wEdge * s.edge +
      w.wVelocity * s.velocity +
      w.wPersistence * s.persistence +
      w.wFixation * s.fixation +
      w.wConfidence * s.tracking;
    const downScore = score(downSignals);
    const upScore = score(upSignals);

    // Sustained-evidence timers: each direction must hold above `enter`
    // for minActivationMs before it can take over. Never act on 1 sample.
    if (downScore >= th.enter) {
      this.downEvidenceSince ??= t;
    } else if (downScore < th.exit) {
      this.downEvidenceSince = null;
    }
    if (upScore >= th.enter) {
      this.upEvidenceSince ??= t;
    } else if (upScore < th.exit) {
      this.upEvidenceSince = null;
    }
    const downReady = this.downEvidenceSince != null && t - this.downEvidenceSince >= th.minActivationMs;
    const upReady = this.upEvidenceSince != null && t - this.upEvidenceSince >= th.minActivationMs;

    // At document limits there is nowhere to go: don't claim intent to
    // scroll further (prevents pressing against the bottom/top forever).
    const atBottom = ctx.maxScrollY != null && ctx.scrollY != null && ctx.scrollY >= ctx.maxScrollY - 2;
    const atTop = ctx.scrollY != null && ctx.scrollY <= 2;
    const downAllowed = !atBottom;
    const upAllowed = !atTop;

    const holdingDown = this.current === Intents.LOOKING_DOWN;
    const holdingUp = this.current === Intents.LOOKING_UP;

    if (downReady && downScore >= upScore && downAllowed) {
      return this.#transition(Intents.LOOKING_DOWN, 'down', downScore, t, downSignals);
    }
    if (upReady && upScore > downScore && upAllowed) {
      return this.#transition(Intents.LOOKING_UP, 'up', upScore, t, upSignals);
    }
    // Hysteresis hold: stay in the directional state while its score is
    // above the (lower) exit threshold, even if the enter timer lapsed.
    if (holdingDown && downScore >= th.exit && downAllowed) {
      return this.#transition(Intents.LOOKING_DOWN, 'down', downScore, t, downSignals);
    }
    if (holdingUp && upScore >= th.exit && upAllowed) {
      return this.#transition(Intents.LOOKING_UP, 'up', upScore, t, upSignals);
    }

    // Non-directional states from cheap, explainable rules.
    if (speed > 900) {
      return this.#transition(Intents.SCANNING, null, clamp01(speed / 1600), t, downScore >= upScore ? downSignals : upSignals);
    }
    if (isFix) {
      const fixDur = analysis.fixation.durationMs ?? 0;
      return this.#transition(Intents.READING, null, clamp01(0.5 + Math.min(fixDur, 1000) / 2000), t, downSignals);
    }
    if (speed < 120) {
      return this.#transition(Intents.IDLE, null, 0.5, t, downSignals);
    }
    return this.#transition(Intents.UNCERTAIN, null, 0.4, t, downSignals);
  }

  #transition(intent, direction, confidence, t, signals) {
    if (intent !== this.current) {
      this.current = intent;
      this.currentSince = t;
    }
    this.last = { intent, direction, confidence: clamp01(confidence), signals, since: this.currentSince ?? t };
    return this.last;
  }
}
