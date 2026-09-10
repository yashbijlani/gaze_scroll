// Debug overlay: positions WebGazer's camera preview and renders our own
// (smoothed) gaze cursor. WebGazer's internal gaze dot stays disabled.
//
// Two preview paths:
// 1. WebGazer's own <video> element (preferred — same stream, no second
//    camera open). Located directly in the DOM instead of trusting
//    WebGazer's setVideoViewerSize, which throws `... reading 'style'` on
//    builds whose internal refs are null.
// 2. Fallback: our own preview-only getUserMedia stream, used only when
//    WebGazer never produced a video element. Doubles as a diagnostic:
//    if this succeeds while WebGazer's is missing, the device is fine and
//    WebGazer's init is at fault; if it fails, the device is busy/gone.
// Preview is display-only: muted, never recorded, tracks released on stop.
export class Overlay {
  constructor({ cursorEl }) {
    this.cursorEl = cursorEl;
    this.videoVisible = true;
    this.fallbackStream = null;
  }

  findWebgazerVideo() {
    try {
      return (
        document.getElementById(window.webgazer?.params?.videoElementId ?? 'webgazerVideoFeed') ??
        document.querySelector('#webgazerVideoContainer video') ??
        [...document.querySelectorAll('video')].find(
          (v) => v.id !== 'gaze-preview-fallback' && v.srcObject,
        ) ??
        null
      );
    } catch {
      return null;
    }
  }

  // Cosmetic only: must never throw.
  dockCameraPreview(width, height) {
    try {
      const video = this.findWebgazerVideo();
      if (video) {
        video.muted = true;
        try {
          const p = video.play();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch {
          /* autoplay needs a gesture; the enable click usually covers it */
        }
        video.style.display = 'block';
        video.style.opacity = '1';
        video.style.width = `${width}px`;
        video.style.height = `${height}px`;
      }
      const c = document.getElementById(
        window.webgazer?.params?.videoContainerId ?? 'webgazerVideoContainer',
      );
      if (c && c.style) {
        c.style.display = 'block';
        c.style.opacity = '1';
        c.style.position = 'fixed';
        c.style.top = '64px';
        c.style.right = '12px';
        c.style.left = 'auto';
        c.style.bottom = 'auto';
        c.style.zIndex = '1200';
      }
    } catch (err) {
      console.warn('camera preview docking skipped', err);
    }
    this.applyVideoVisibility();
  }

  // Open our own preview stream when WebGazer has no video element.
  // Returns { ok, mode } — mode is 'webgazer' | 'fallback' | 'none'.
  async ensurePreview(width, height) {
    if (this.findWebgazerVideo()) {
      this.dockCameraPreview(width, height);
      return { ok: true, mode: 'webgazer' };
    }
    if (this.fallbackStream) return { ok: true, mode: 'fallback' };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false,
      });
      this.fallbackStream = stream;
      let video = document.getElementById('gaze-preview-fallback');
      if (!video) {
        video = document.createElement('video');
        video.id = 'gaze-preview-fallback';
        document.body.appendChild(video);
      }
      video.srcObject = stream;
      video.muted = true;
      video.setAttribute('playsinline', '');
      video.style.position = 'fixed';
      video.style.top = '64px';
      video.style.right = '12px';
      video.style.zIndex = '1200';
      video.style.width = `${width}px`;
      video.style.height = `${height}px`;
      video.style.display = this.videoVisible ? 'block' : 'none';
      video.style.transform = 'scaleX(-1)'; // mirror like a selfie preview
      await video.play().catch(() => {});
      return { ok: true, mode: 'fallback' };
    } catch (err) {
      console.warn('fallback preview failed', err);
      return { ok: false, mode: 'none', error: String(err?.message ?? err) };
    }
  }

  releaseFallbackPreview() {
    try {
      for (const t of this.fallbackStream?.getTracks?.() ?? []) {
        try {
          t.stop();
        } catch {
          /* already stopped */
        }
      }
    } finally {
      this.fallbackStream = null;
      document.getElementById('gaze-preview-fallback')?.remove();
    }
  }

  setVideoVisible(v) {
    this.videoVisible = v;
    const fb = document.getElementById('gaze-preview-fallback');
    if (fb) fb.style.display = v ? 'block' : 'none';
    this.applyVideoVisibility();
  }

  applyVideoVisibility() {
    try {
      const w = window.webgazer;
      if (!w) return;
      if (typeof w.showVideo === 'function') w.showVideo(this.videoVisible);
      if (typeof w.showFaceOverlay === 'function') w.showFaceOverlay(this.videoVisible);
      if (typeof w.showFaceFeedbackBox === 'function') w.showFaceFeedbackBox(this.videoVisible);
    } catch (err) {
      console.warn('video visibility skipped', err);
    }
  }

  drawGaze(x, y, confidence, fixation) {
    const el = this.cursorEl;
    el.hidden = false;
    el.style.transform =
      `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`;
    el.style.opacity = String(0.3 + 0.65 * confidence);
    const size = 14 + 18 * (1 - confidence);
    el.style.width = `${size.toFixed(0)}px`;
    el.style.height = `${size.toFixed(0)}px`;
    el.dataset.state = fixation?.state ?? 'unknown';
    el.title =
      `gaze (${Math.round(x)}, ${Math.round(y)}) · ` +
      `conf ${confidence.toFixed(2)} · ${fixation?.state ?? '?'}`;
  }

  hideGaze() {
    this.cursorEl.hidden = true;
  }
}
