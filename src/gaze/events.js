// GazeEventDetector: lightweight discrete events over the filtered stream.
//
// Events: FIXATION_STARTED/ENDED, MOVEMENT_STARTED/ENDED,
// EDGE_DWELL_STARTED/ENDED, TRACKING_LOST/RECOVERED.
//
// Design notes:
// - Fixation/saccade come from the existing I-DT FixationDetector plus a
//   velocity gate (saccadeThresholdPxPerS): webcam noise means neither
//   signal is trustworthy alone; requiring agreement kills most chatter.
// - Edge dwell needs sustained presence (edgeDwellMs), never a single sample.
// - TRACKING_LOST fires on a no-sample gap; TRACKING_RECOVERED on resume.
//   Consumers (intent, scroller) must treat LOST as "stop everything".

import { FixationDetector } from '../fixation.js';
import { VelocityTracker } from './velocity.js';

export const GazeEvents = {
  FIXATION_STARTED: 'FIXATION_STARTED',
  FIXATION_ENDED: 'FIXATION_ENDED',
  MOVEMENT_STARTED: 'MOVEMENT_STARTED',
  MOVEMENT_ENDED: 'MOVEMENT_ENDED',
  EDGE_DWELL_STARTED: 'EDGE_DWELL_STARTED',
  EDGE_DWELL_ENDED: 'EDGE_DWELL_ENDED',
  TRACKING_LOST: 'TRACKING_LOST',
  TRACKING_RECOVERED: 'TRACKING_RECOVERED',
};

export class GazeEventDetector {
  constructor(cfg = {}, viewport = null) {
    this.fixationCfg = cfg.fixation ?? {};
    this.velocityCfg = cfg.velocity ?? {};
    this.eventsCfg = cfg.events ?? {};
    this.viewport = viewport ?? (() => ({ w: window.innerWidth, h: window.innerHeight }));
    this.subscribers = new Set();
    this.reset();
  }

  reset() {
    this.fix = new FixationDetector(this.fixationCfg);
    this.vel = new VelocityTracker(this.velocityCfg);
    this.wasFixation = false;
    this.wasMoving = false;
    this.edgeSide = null; // 'top' | 'bottom' | null
    this.edgeSince = null;
    this.edgeDwelling = null;
    this.lost = false;
    this.lastSampleT = null;
    this.lastEvent = null;
  }

  subscribe(cb) {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  #fire(type, detail = {}) {
    const evt = { type, t: detail.t ?? performance.now(), ...detail };
    this.lastEvent = evt;
    for (const cb of this.subscribers) {
      try {
        cb(evt);
      } catch (err) {
        console.error('gaze event subscriber error', err);
      }
    }
    return evt;
  }

  edgeBandPx() {
    return this.eventsCfg.edgeBandPx ?? 140;
  }

  // Returns 'top' | 'bottom' | null for the given viewport y.
  edgeZone(y) {
    const { h } = this.viewport();
    const band = this.edgeBandPx();
    if (y == null) return null;
    if (y >= h - band) return 'bottom';
    if (y <= band) return 'top';
    return null;
  }

  // Main entry: feed every normalized provider sample.
  // Null x/y with hasFace = "face here, gaze unknown" (e.g. uncalibrated
  // model or a blink) — explicitly NOT tracking loss. Only faceless nulls
  // past the gap threshold declare TRACKING_LOST.
  // Returns { fixation, velocity, edge, lost, facePresent }.
  update(sample) {
    const t = sample?.timestamp ?? performance.now();
    const gapMs = this.eventsCfg.trackingLostGapMs ?? 800;

    if (sample?.x == null || sample?.y == null) {
      if (sample?.hasFace) {
        if (this.lost) {
          this.lost = false;
          this.#fire(GazeEvents.TRACKING_RECOVERED, { t });
        }
        this.lastSampleT = t; // stream is alive; don't trip the gap timer
        this.vel.add(null, null, t); // decay velocity, re-anchor on resume
        this.#endEdge(t, 'unknown');
        return {
          fixation: { state: 'unknown' },
          velocity: this.vel.snapshot(),
          edge: null,
          lost: false,
          facePresent: true,
        };
      }
      if (this.lastSampleT != null && t - this.lastSampleT > gapMs && !this.lost) {
        this.lost = true;
        this.#fire(GazeEvents.TRACKING_LOST, { t });
      } else if (this.lastSampleT == null && !this.lost) {
        // First-ever sample is a loss marker (common at startup).
        this.lost = true;
        this.#fire(GazeEvents.TRACKING_LOST, { t });
      }
      this.#endEdge(t, 'lost');
      return {
        fixation: { state: 'lost' },
        velocity: this.vel.snapshot(),
        edge: null,
        lost: true,
        facePresent: false,
      };
    }

    if (this.lost) {
      this.lost = false;
      this.#fire(GazeEvents.TRACKING_RECOVERED, { t });
    }
    this.lastSampleT = t;

    const fixation = this.fix.add(sample.x, sample.y, t);
    const velocity = this.vel.add(sample.x, sample.y, t);
    const isFix = fixation.state === 'fixation';
    const saccadeThreshold = this.velocityCfg.saccadeThresholdPxPerS ?? 450;
    const isMoving = velocity.speed > saccadeThreshold;

    if (isFix && !this.wasFixation) this.#fire(GazeEvents.FIXATION_STARTED, { t, x: sample.x, y: sample.y });
    if (!isFix && this.wasFixation) {
      this.#fire(GazeEvents.FIXATION_ENDED, { t, durationMs: fixation.durationMs ?? 0 });
    }
    this.wasFixation = isFix;

    if (isMoving && !this.wasMoving) this.#fire(GazeEvents.MOVEMENT_STARTED, { t, speed: velocity.speed });
    if (!isMoving && this.wasMoving) this.#fire(GazeEvents.MOVEMENT_ENDED, { t });
    this.wasMoving = isMoving;

    // Edge dwell state machine.
    const side = this.edgeZone(sample.y);
    const dwellMs = this.eventsCfg.edgeDwellMs ?? 900;
    if (side !== this.edgeSide) {
      this.#endEdge(t, 'moved');
      if (side) {
        this.edgeSide = side;
        this.edgeSince = t;
      }
    } else if (side && !this.edgeDwelling && t - this.edgeSince >= dwellMs) {
      this.edgeDwelling = side;
      this.#fire(GazeEvents.EDGE_DWELL_STARTED, { t, side, dwellMs: t - this.edgeSince });
    }
    const edge = side
      ? { side, dwellMs: t - (this.edgeSince ?? t), dwelling: this.edgeDwelling === side }
      : null;

    return { fixation, velocity, edge, lost: false, facePresent: !!sample?.hasFace };
  }

  #endEdge(t, reason) {
    if (this.edgeDwelling) {
      this.#fire(GazeEvents.EDGE_DWELL_ENDED, { t, side: this.edgeDwelling, reason });
    }
    this.edgeDwelling = null;
    this.edgeSide = null;
    this.edgeSince = null;
  }
}
