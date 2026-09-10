// LabController: the Gaze Lab developer panel + floating status pill.
//
// High-frequency rule: the gaze pipeline calls lab.update() at most ~10Hz
// (main.js throttles). Canvas trail drawing is incremental and bounded;
// no framework, no per-sample DOM framework churn.

const fmt = (v, d = 0) => (v == null || !Number.isFinite(v) ? '—' : Number(v).toFixed(d));

export class LabController {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.els = {
      pill: $('tracking-pill'),
      gaze: $('lab-gaze'),
      norm: $('lab-norm'),
      conf: $('lab-conf'),
      vel: $('lab-vel'),
      persist: $('lab-persist'),
      fix: $('lab-fix'),
      dir: $('lab-dir'),
      intent: $('lab-intent'),
      intentconf: $('lab-intentconf'),
      scrollvel: $('lab-scrollvel'),
      tracking: $('lab-tracking'),
      calq: $('lab-calq'),
      target: $('lab-target'),
      sigEdge: $('sig-edge'),
      sigVel: $('sig-vel'),
      sigPersist: $('sig-persist'),
      sigFix: $('sig-fix'),
      sigTrack: $('sig-track'),
      trail: $('trail'),
      eventLog: $('event-log'),
    };
    this.trailRaw = [];
    this.trailFiltered = [];
    this.maxTrail = 120;
  }

  setPill(state, text) {
    const el = this.els.pill;
    if (!el) return;
    el.hidden = false;
    el.dataset.state = state;
    el.textContent = `👁 ${text}`;
  }

  hidePill() {
    if (this.els.pill) this.els.pill.hidden = true;
  }

  pushTrail(raw, filtered) {
    if (raw) {
      this.trailRaw.push(raw);
      if (this.trailRaw.length > this.maxTrail) this.trailRaw.shift();
    }
    if (filtered) {
      this.trailFiltered.push(filtered);
      if (this.trailFiltered.length > this.maxTrail) this.trailFiltered.shift();
    }
    this.#drawTrail();
  }

  clearTrail() {
    this.trailRaw = [];
    this.trailFiltered = [];
    this.#drawTrail();
  }

  #drawTrail() {
    const c = this.els.trail;
    if (!c) return;
    const ctx = c.getContext('2d');
    const W = c.width;
    const H = c.height;
    ctx.clearRect(0, 0, W, H);
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    const path = (pts, style) => {
      if (pts.length < 2) return;
      ctx.strokeStyle = style;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      pts.forEach((p, i) => {
        const x = Math.min(W, Math.max(0, (p.x / vw) * W));
        const y = Math.min(H, Math.max(0, (p.y / vh) * H));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };
    path(this.trailRaw, 'rgba(120,130,150,0.55)');
    path(this.trailFiltered, 'rgba(77,163,255,0.95)');
  }

  logEvent(evt) {
    const ul = this.els.eventLog;
    if (!ul) return;
    const placeholder = ul.querySelector('.muted');
    if (placeholder) placeholder.remove();
    const li = document.createElement('li');
    li.textContent = `${(evt.t / 1000).toFixed(1)}s ${evt.type}${evt.side ? ` ${evt.side}` : ''}`;
    ul.prepend(li);
    while (ul.children.length > 8) ul.lastChild.remove();
  }

  // snapshot: { sample, velocity, fixation, edge, intent, reading, dom,
  //             scrollVel, tracking, calQuality }
  update(s) {
    const e = this.els;
    if (!s) return;
    if (e.gaze) e.gaze.textContent = s.sample && s.sample.x != null ? `${Math.round(s.sample.x)}, ${Math.round(s.sample.y)}` : '—';
    if (e.norm) e.norm.textContent = s.sample && s.sample.normalizedX != null ? `${fmt(s.sample.normalizedX, 3)}, ${fmt(s.sample.normalizedY, 3)}` : '—';
    if (e.conf) e.conf.textContent = s.sample ? fmt(s.sample.confidence, 2) : '—';
    if (e.vel) e.vel.textContent = s.velocity ? `${fmt(s.velocity.vx)}, ${fmt(s.velocity.vy)} · ${fmt(s.velocity.speed)}` : '—';
    if (e.persist) e.persist.textContent = s.velocity ? fmt(s.velocity.persistence, 2) : '—';
    if (e.fix) e.fix.textContent = s.fixation ? `${s.fixation.state}${s.fixation.durationMs ? ` ${Math.round(s.fixation.durationMs)}ms` : ''}` : '—';
    if (e.dir) {
      const d = s.velocity ? (s.velocity.vy > 25 ? 'down' : s.velocity.vy < -25 ? 'up' : '—') : '—';
      e.dir.textContent = d;
    }
    if (e.intent) e.intent.textContent = s.intent ? s.intent.intent : '—';
    if (e.intentconf) e.intentconf.textContent = s.intent ? fmt(s.intent.confidence, 2) : '—';
    if (e.scrollvel) e.scrollvel.textContent = fmt(s.scrollVel, 0);
    if (e.tracking) e.tracking.textContent = s.tracking ?? '—';
    if (e.calq) e.calq.textContent = s.calQuality ?? '—';
    if (e.target) e.target.textContent = s.dom ? `${s.dom.role}${s.reading ? (s.reading.onText ? ' · on-text' : ' · off-text') : ''}` : '—';
    const sig = s.intent?.signals;
    if (sig) {
      if (e.sigEdge) e.sigEdge.textContent = fmt(sig.edge, 2);
      if (e.sigVel) e.sigVel.textContent = fmt(sig.velocity, 2);
      if (e.sigPersist) e.sigPersist.textContent = fmt(sig.persistence, 2);
      if (e.sigFix) e.sigFix.textContent = fmt(sig.fixation, 2);
      if (e.sigTrack) e.sigTrack.textContent = fmt(sig.tracking, 2);
    }
  }
}
