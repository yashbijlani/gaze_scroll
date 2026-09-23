// Synthetic webcam-gaze simulator for headless algorithm comparison.
//
// WHY: the overhaul must be measured, but this environment has no camera.
// This module generates *feature vectors* — in the exact layout produced by
// src/gaze/features.js — from a latent gaze + head-pose model, with noise,
// per-eye occlusion, and nonlinear interactions (distance-scaled gain,
// tanh saturation). Candidate mappers are then trained/evaluated on
// identical data, and the intent/safe-region stages are driven by known
// ground-truth "wants to scroll" labels.
//
// HONESTY NOTE: this is a simulator, not a subject study. It validates the
// *relative* ranking of algorithms and the *behaviour* of the intent logic
// under controlled conditions. Absolute pixel errors are simulator-relative;
// real validation requires recorded sessions (bench/run.js also accepts
// session JSON with a `features` array per row).

import { FEATURE_GROUPS, FEATURE_DIM } from '../src/gaze/features.js';

export function makeRng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// Forward-model constants (tuned so per-eye error lands near real webcam
// regression error at typical viewport sizes).
const MODEL = {
  gainX: 0.62, // iris offset per unit centered gaze (before head coupling)
  gainY: 0.68,
  yawToIrisX: 1.25, // head yaw leaks into iris X (the main confound)
  pitchToIrisY: 1.05,
  scaleGain: 0.55, // gaze effect grows with camera distance (interaction)
  irisNoise: 0.028, // per-eye per-frame feature noise
  globalNoise: 0.006,
  occludeEvery: 0.12, // fraction of frames one eye is degraded
  occludeNoiseX: 5, // noise multiplier for the degraded eye
};

export class GazeSimulator {
  constructor(opts = {}) {
    this.opts = { ...MODEL, ...opts };
    this.rng = makeRng(opts.seed ?? 42);
    this.head = { yaw: 0, pitch: 0, roll: 0, faceCx: 0.5, faceCy: 0.48, scale: 1 };
  }

  // Slow bounded random walk of head pose — models natural drift/posture.
  walkHead(strength = 1) {
    const o = this.opts;
    const step = 0.012 * strength;
    const g = this.rng;
    this.head.yaw = clamp(this.head.yaw + (g() * 2 - 1) * step, -0.16, 0.16);
    this.head.pitch = clamp(this.head.pitch + (g() * 2 - 1) * step, -0.13, 0.13);
    this.head.roll = clamp(this.head.roll + (g() * 2 - 1) * step * 0.7, -0.12, 0.12);
    this.head.faceCx = clamp(this.head.faceCx + (g() * 2 - 1) * step * 0.5, 0.42, 0.58);
    this.head.faceCy = clamp(this.head.faceCy + (g() * 2 - 1) * step * 0.5, 0.38, 0.6);
    this.head.scale = clamp(this.head.scale + (g() * 2 - 1) * step, 0.82, 1.18);
    return this.head;
  }

  setHead(h) {
    this.head = { ...this.head, ...h };
    return this.head;
  }

  // gaze: {x, y} normalized 0..1; head: optional override.
  // Returns { vector, perEye, actual, head }.
  sample(gaze, head = this.head, viewport = { w: 1280, h: 800 }) {
    const o = this.opts;
    const rng = this.rng;
    const gx = gaze.x - 0.5;
    const gy = gaze.y - 0.5;
    const scale = head.scale;
    const gazeGain = 1 + o.scaleGain * (scale - 1);

    const right = this.#eye(-1, -1, gx, gy, gazeGain, head, rng); // image-left eye
    const left = this.#eye(1, -1, gx, gy, gazeGain, head, rng); // image-right eye

    const vector = new Array(FEATURE_DIM).fill(0);
    const put = (base, e) => {
      vector[base + 0] = e.irisX;
      vector[base + 1] = e.irisY;
      vector[base + 2] = e.ear;
      vector[base + 3] = e.eyeW;
      vector[base + 4] = e.eyeH;
      vector[base + 5] = e.irisD;
    };
    put(FEATURE_GROUPS.left[0], left);
    put(FEATURE_GROUPS.right[0], right);

    vector[12] = head.faceCx + gaussian(rng) * o.globalNoise;
    vector[13] = head.faceCy + gaussian(rng) * o.globalNoise;
    vector[14] = 0.15 * scale + gaussian(rng) * o.globalNoise;
    vector[15] = head.faceCy;
    vector[16] = vector[14] * (viewport.w / viewport.h);
    vector[17] = Math.sin(head.roll);
    vector[18] = Math.cos(head.roll);
    vector[19] = head.yaw + gaussian(rng) * o.globalNoise;
    vector[20] = head.pitch + gaussian(rng) * o.globalNoise;

    return {
      vector,
      perEye: {
        left: { visibility: left.visibility, ear: left.ear },
        right: { visibility: right.visibility, ear: right.ear },
      },
      actual: { x: gaze.x * viewport.w, y: gaze.y * viewport.h },
      head: { ...head },
    };
  }

  #eye(signX, signY, gx, gy, gazeGain, head, rng) {
    const o = this.opts;
    const occluded = rng() < o.occludeEvery;
    const noiseMul = occluded ? o.occludeNoiseX : 1;
    const irisX =
      Math.tanh(o.gainX * signX * gx * gazeGain + o.yawToIrisX * head.yaw) +
      gaussian(rng) * o.irisNoise * noiseMul;
    const irisY =
      Math.tanh(o.gainY * signY * gy * gazeGain + o.pitchToIrisY * head.pitch) +
      gaussian(rng) * o.irisNoise * noiseMul;
    const ear = clamp(0.22 + gaussian(rng) * 0.015, 0.05, 0.35);
    const visibility = occluded ? clamp(0.25 + gaussian(rng) * 0.1, 0, 1) : clamp(0.9 + gaussian(rng) * 0.08, 0, 1);
    return { irisX, irisY, ear, eyeW: 0.5 + gaussian(rng) * 0.01, eyeH: 0.11 + gaussian(rng) * 0.01, irisD: 0.4, visibility };
  }
}

// Calibration grid targets (normalized 0..1) — matches the app's 5/9 grid.
export function gridTargets(points = 9, margin = 0.1) {
  const xs = [margin, 0.5, 1 - margin];
  const ys = [margin, 0.5, 1 - margin];
  if (points === 5) {
    return [
      { x: xs[0], y: ys[0] },
      { x: xs[2], y: ys[0] },
      { x: xs[1], y: ys[1] },
      { x: xs[0], y: ys[2] },
      { x: xs[2], y: ys[2] },
    ];
  }
  const out = [];
  for (const y of ys) for (const x of xs) out.push({ x, y });
  return out;
}

// Build a labelled calibration set (small natural head drift, repeated taps
// per point). Head drift during calibration is essential: without it the
// head-pose channels have no variance and their weights are unidentifiable.
export function calibrationSet(sim, { points = 9, taps = 5, margin = 0.1, viewport = { w: 1280, h: 800 }, jitter = 0.004, headDrift = 0.35 } = {}) {
  const rows = [];
  for (const target of gridTargets(points, margin)) {
    for (let i = 0; i < taps; i++) {
      sim.walkHead(headDrift);
      const gaze = { x: clamp(target.x + gaussian(sim.rng) * jitter, 0, 1), y: clamp(target.y + gaussian(sim.rng) * jitter, 0, 1) };
      const s = sim.sample(gaze, sim.head, viewport);
      rows.push({ features: s.vector, target: s.actual, head: s.head, perEye: s.perEye });
    }
  }
  return rows;
}

// Dense evaluation set: uniform random gaze + head drift, so error is
// measured across the whole screen, not just the calibration grid.
export function evaluationSet(sim, { n = 400, viewport = { w: 1280, h: 800 }, headDrift = 0.6 } = {}) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    if (i % 10 === 0) sim.walkHead(headDrift);
    const gaze = { x: sim.rng(), y: sim.rng() };
    const s = sim.sample(gaze, sim.head, viewport);
    rows.push({ features: s.vector, target: s.actual, head: s.head, perEye: s.perEye });
  }
  return rows;
}

// A labelled reading-style sequence for intent/safe-region tests.
// Phases: read (centre, small saccades), gradual_down (legitimate scroll),
// glance_down (brief false trigger), noisy_boundary (jitter), head_move.
export function intentSequences(sim, { viewport = { w: 1280, h: 800 }, sampleMs = 33 } = {}) {
  const seqs = {};
  const build = (phases) => {
    const out = [];
    let t = 0;
    for (const ph of phases) {
      for (let i = 0; i < ph.n; i++) {
        const gaze = ph.gaze(i, ph.n);
        const want = ph.want ? ph.want(i, ph.n) : false;
        if (ph.head) sim.setHead(ph.head);
        else if (i % 8 === 0) sim.walkHead(0.4);
        const s = sim.sample(gaze, sim.head, viewport);
        out.push({
          t,
          pred: s.actual, // simulator's exact gaze; mapping error added later
          actual: s.actual,
          features: s.vector,
          perEye: s.perEye,
          head: s.head,
          h: viewport.h,
          wants: !!want,
        });
        t += sampleMs;
      }
    }
    return out;
  };
  const yAt = (frac) => (i) => ({ x: 0.5 + Math.sin(i / 7) * 0.02, y: frac });

  // 1. Stable reading near vertical centre — must never scroll.
  seqs.reading = build([
    { n: 60, gaze: (i) => ({ x: 0.5, y: 0.42 + Math.sin(i / 9) * 0.03 }), want: () => false },
  ]);
  // 2. Gradual downward reading progression that should scroll once deep.
  seqs.gradual = build([
    { n: 20, gaze: (i) => ({ x: 0.5, y: 0.4 + i * 0.01 }), want: () => false },
    {
      n: 60,
      gaze: (i) => ({ x: 0.5, y: Math.min(0.95, 0.6 + i * 0.012) }),
      want: (i) => i > 10,
    },
  ]);
  // 3. Brief glance to the bottom then back — must NOT scroll.
  seqs.glance = build([
    { n: 40, gaze: () => ({ x: 0.5, y: 0.45 }), want: () => false },
    { n: 7, gaze: () => ({ x: 0.5, y: 0.93 }), want: () => false },
    { n: 40, gaze: () => ({ x: 0.5, y: 0.45 }), want: () => false },
  ]);
  // 4. Noisy boundary hovering — must not oscillate into scroll.
  seqs.noisyBoundary = build([
    { n: 120, gaze: (i) => ({ x: 0.5, y: 0.8 + Math.sin(i / 2) * 0.03 }), want: () => false },
  ]);
  // 5. Head movement without eye movement — must not scroll.
  seqs.headMove = build([
    { n: 90, gaze: () => ({ x: 0.5, y: 0.45 }), want: () => false, head: { yaw: 0.12, pitch: 0.08, faceCx: 0.55, scale: 1.1 } },
  ]);
  return seqs;
}
