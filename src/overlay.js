// Debug overlay: positions WebGazer's camera preview and renders our own
// (smoothed) gaze cursor. WebGazer's internal gaze dot stays disabled.
export class Overlay {
  constructor({ cursorEl }) {
    this.cursorEl = cursorEl;
    this.videoVisible = true;
  }

  // Cosmetic only: must never throw. Finds WebGazer's own <video>
  // element directly and makes it visible + playing, instead of trusting
  // WebGazer's setVideoViewerSize — on some builds that touches internal
  // refs that are still null and throws `... reading 'style'`.
  dockCameraPreview(width, height) {
    try {
      const video =
        document.getElementById(window.webgazer?.params?.videoElementId ?? 'webgazerVideoFeed') ??
        document.querySelector('#webgazerVideoContainer video') ??
        [...document.querySelectorAll('video')].find((v) => v.srcObject) ??
        null;
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
      } else {
        console.warn('camera preview: no video element found yet');
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
