// ScrollController: intent → motion, with safety as the primary feature.
//
// Strategies (selectable via setMode):
//   discrete — on newly-activated LOOKING_DOWN/UP, jump one reading chunk.
//   smooth   — ramp velocity toward an intent-driven target (accel-limited).
//   edge     — velocity proportional to edge depth (sustained dwell only).
//   reading / predictive — refined by DOM signals in M3; smooth fallback here.
//   off      — never scroll (debug/manual).
//
// Invariants (tested):
// - never reacts to a single sample: intent must persist minActivationMs.
// - low confidence / TRACKING_LOST / UNCERTAIN → target velocity 0.
// - manual wheel/key/touch input suppresses auto-scroll for overridePauseMs.
// - accel-limited ramps: no teleports, smooth stop when intent disappears.
// - emergency stop: setEnabled(false) zeroes velocity immediately.

import { Intents } from './intent.js';

export const ScrollModes = {
  DISCRETE: 'discrete',
  SMOOTH: 'smooth',
  EDGE: 'edge',
  READING: 'reading',
  PREDICTIVE: 'predictive',
  OFF: 'off',
};

export class ScrollController {
  constructor(cfg = {}, io = null) {
    this.cfg = cfg;
    // IO seam: { scrollBy(dx,dy), scrollY(), maxScrollY(), now() }.
    // Defaults to the real window; tests inject a fake.
    this.io = io ?? {
      scrollBy: (dx, dy) => window.scrollBy(dx, dy),
      scrollY: () => window.scrollY,
      maxScrollY: () => document.documentElement.scrollHeight - window.innerHeight,
      now: () => performance.now(),
    };
    this.mode = cfg.mode ?? ScrollModes.SMOOTH;
    this.enabled = true;
    this.velocity = 0; // current px/s, signed (+down)
    this.lastTick = null;
    this.overrideUntil = 0;
    this.lastDiscreteAt = 0;
    this.activeIntent = null;
    this.intentSince = null;
    this.latest = null;
    this.latestEdge = null;
    this.reading = null; // { onText, textBelow, progressing, nearEnd } (M3)
    this.listeners = new Set();
    this.#bindManualOverride();
  }

  setMode(mode) {
    if (!Object.values(ScrollModes).includes(mode)) throw new Error(`unknown scroll mode: ${mode}`);
    this.mode = mode;
    this.velocity = 0;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) this.velocity = 0; // emergency stop is instant
  }

  // DOM/reading snapshot from ReadingTracker (M3). Null = no DOM info.
  setReading(reading) {
    this.reading = reading ?? null;
  }

  onVelocity(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  // Call on every intent update. Pure apart from reading the clock.
  updateIntent(result, edge = null, t = null) {
    const now = t ?? this.io.now();
    if (result && result.intent !== this.activeIntent) {
      this.activeIntent = result.intent;
      this.intentSince = now;
    } else if (result && this.intentSince == null) {
      this.intentSince = now;
    }
    this.latest = result ?? null;
    this.latestEdge = edge ?? null;
  }

  intentHeldMs(t = null) {
    const now = t ?? this.io.now();
    return this.intentSince == null ? 0 : now - this.intentSince;
  }

  manualOverride() {
    this.overrideUntil = this.io.now() + (this.cfg.manualOverridePauseMs ?? 2500);
    this.velocity = 0; // yield immediately, not after the pause
  }

  overridden(t = null) {
    return (t ?? this.io.now()) < this.overrideUntil;
  }

  // Pure target-velocity computation (no scrolling side effects) — the
  // unit under test. Returns signed px/s.
  targetVelocity(t = null) {
    const now = t ?? this.io.now();
    if (!this.enabled || this.mode === ScrollModes.OFF) return 0;
    if (this.overridden(now)) return 0;
    const r = this.latest;
    if (!r) return 0;
    if (r.intent === Intents.TRACKING_LOST || r.intent === Intents.UNCERTAIN) return 0;
    const minAct = this.cfg.minActivationMs ?? 700;
    if (this.intentHeldMs(now) < minAct) return 0; // never 1-sample reactions
    const maxVel = this.cfg.maxVelocityPxPerS ?? 900;
    const dir = r.intent === Intents.LOOKING_DOWN ? 1 : r.intent === Intents.LOOKING_UP ? -1 : 0;
    if (dir === 0) return 0;

    if (this.mode === ScrollModes.DISCRETE) return 0; // discrete scrolls in tick()
    if (this.mode === ScrollModes.EDGE) {
      const depth = this.#edgeDepth();
      if (depth <= 0) return 0;
      const gain = this.cfg.edgeProportionalGain ?? 2.2;
      const v = Math.min(maxVel, depth * maxVel * gain);
      return dir * v * Math.max(0.25, r.confidence ?? 1);
    }
    if (this.mode === ScrollModes.READING) {
      // Genuine reading flow only: gaze on text AND progressing downward
      // through it (or at the last lines). A downward glance at
      // whitespace/chrome never scrolls here — the core anti-gimmick rule.
      const rd = this.reading;
      if (!rd || !rd.onText) return 0;
      if (!rd.progressing && !rd.nearEnd) return 0;
      return dir * maxVel * 0.6 * Math.max(0.3, r.confidence ?? 1);
    }
    if (this.mode === ScrollModes.PREDICTIVE) {
      // Pre-reveal: start gently once readable content below runs thin,
      // before the user hits the viewport edge.
      const rd = this.reading;
      if (!rd || !rd.onText) return 0;
      if (!rd.revealSoon && !rd.nearEnd) return 0;
      return dir * maxVel * 0.45 * Math.max(0.3, r.confidence ?? 1);
    }
    // smooth: intent-driven ramped core.
    return dir * maxVel * Math.max(0.25, r.confidence ?? 1);
  }

  // Advance the controller by dt seconds. Call from requestAnimationFrame.
  // Returns the applied scroll delta (px, signed) for the lab + recording.
  tick(dtS, t = null) {
    const now = t ?? this.io.now();
    if (dtS <= 0 || dtS > 0.25) {
      this.lastTick = now;
      return 0;
    }
    let delta = 0;
    if (this.mode === ScrollModes.DISCRETE) {
      delta = this.#tickDiscrete(now);
    } else {
      const target = this.targetVelocity(now);
      const accel = this.cfg.accelPxPerS2 ?? 2600;
      const dv = target - this.velocity;
      const step = Math.sign(dv) * Math.min(Math.abs(dv), accel * dtS);
      this.velocity += step;
      if (Math.abs(this.velocity) < 1 && target === 0) this.velocity = 0;
      delta = this.velocity * dtS;
      if (delta !== 0) this.io.scrollBy(0, delta);
    }
    this.lastTick = now;
    for (const cb of this.listeners) {
      try {
        cb(this.velocity, delta);
      } catch (err) {
        console.error('scroll listener error', err);
      }
    }
    return delta;
  }

  #tickDiscrete(now) {
    const r = this.latest;
    if (!this.enabled || this.overridden(now) || !r) return 0;
    if (r.intent !== Intents.LOOKING_DOWN && r.intent !== Intents.LOOKING_UP) return 0;
    const minAct = this.cfg.minActivationMs ?? 700;
    const cooldown = this.cfg.discreteCooldownMs ?? 1200;
    if (this.intentHeldMs(now) < minAct) return 0;
    if (now - this.lastDiscreteAt < cooldown) return 0;
    const chunk = this.cfg.discreteChunkPx ?? 320;
    const delta = r.intent === Intents.LOOKING_DOWN ? chunk : -chunk;
    this.lastDiscreteAt = now;
    this.io.scrollBy(0, delta);
    return delta;
  }

  #edgeDepth() {
    const e = this.latestEdge;
    if (!e || !e.dwelling) return 0;
    // dwellMs ramps 0→1 over ~1s of sustained dwell for a gentle onset.
    return Math.min(1, (e.dwellMs ?? 0) / 1000);
  }

  #bindManualOverride() {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    const yield_ = () => this.manualOverride();
    // Capturing wheel/touch/keys: user input always wins over gaze.
    window.addEventListener('wheel', yield_, { passive: true, capture: true });
    window.addEventListener('touchstart', yield_, { passive: true, capture: true });
    window.addEventListener('keydown', (e) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) yield_();
    }, { capture: true });
  }
}
