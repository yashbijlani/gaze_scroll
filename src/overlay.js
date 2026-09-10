// Debug overlay: positions WebGazer's camera preview and renders our own
// (smoothed) gaze cursor. WebGazer's internal gaze dot stays disabled.
export class Overlay {
  constructor({ cursorEl }) {
    this.cursorEl = cursorEl;
    this.videoVisible = true;
  }

  dockCameraPreview(width, height) {
    const w = window.webgazer;
    if (w) w.setVideoViewerSize(width, height);
    const c = document.getElementById('webgazerVideoContainer');
    if (c) {
      c.style.position = 'fixed';
      c.style.top = '64px';
      c.style.right = '12px';
      c.style.left = 'auto';
      c.style.bottom = 'auto';
      c.style.zIndex = '1200';
    }
    this.applyVideoVisibility();
  }

  setVideoVisible(v) {
    this.videoVisible = v;
    this.applyVideoVisibility();
  }

  applyVideoVisibility() {
    const w = window.webgazer;
    if (!w) return;
    w.showVideo(this.videoVisible);
    w.showFaceOverlay(this.videoVisible);
    w.showFaceFeedbackBox(this.videoVisible);
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
