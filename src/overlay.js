// Debug overlay: positions WebGazer's camera preview and renders our own
// (smoothed) gaze cursor. WebGazer's internal gaze dot stays disabled.
export class Overlay {
  constructor({ cursorEl }) {
    this.cursorEl = cursorEl;
    this.videoVisible = true;
  }

  // Cosmetic only: must never throw. WebGazer's setVideoViewerSize
  // dereferences its internal video/overlay elements without null checks,
  // so on builds where begin() resolves before that DOM exists it throws
  // `Cannot read properties of null (reading 'style')`. Catch and continue
  // without a preview — tracking works fine without it.
  dockCameraPreview(width, height) {
    try {
      const w = window.webgazer;
      if (w && typeof w.setVideoViewerSize === 'function') {
        w.setVideoViewerSize(width, height);
      }
    } catch (err) {
      console.warn('camera preview sizing skipped', err);
    }
    try {
      const c = document.getElementById('webgazerVideoContainer');
      if (c && c.style) {
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

  setVideoVisible(v) {
    this.videoVisible = v;
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
