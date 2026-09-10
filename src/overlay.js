// MediaPipe FaceMesh eye landmark indices (from the TFFacemesh tracker).
// Used to draw eye boxes from raw landmark arrays without WebGazer's DOM.
export const EyeIndices = {
  left: [466, 388, 387, 386, 385, 384, 398, 263, 249, 390, 373, 374, 380, 381, 382, 362],
  right: [246, 161, 160, 159, 158, 157, 173, 33, 7, 163, 144, 145, 153, 154, 155, 133],
};

// Pure mapping: video-pixel landmark → canvas CSS pixels. Exported for tests.
export function mapLandmarkToCanvas(x, y, videoW, videoH, canvasW, canvasH, mirrored) {
  const nx = videoW > 0 ? x / videoW : 0;
  const ny = videoH > 0 ? y / videoH : 0;
  const cx = (mirrored ? 1 - nx : nx) * canvasW;
  const cy = ny * canvasH;
  return [cx, cy];
}

function bboxOf(indices, positions, videoW, videoH, cw, ch, mirrored) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const i of indices) {
    const p = positions[i];
    if (!p) continue;
    const [cx, cy] = mapLandmarkToCanvas(p[0], p[1], videoW, videoH, cw, ch, mirrored);
    if (cx < minX) minX = cx;
    if (cy < minY) minY = cy;
    if (cx > maxX) maxX = cx;
    if (cy > maxY) maxY = cy;
  }
  if (!Number.isFinite(minX)) return null;
  const pad = 6;
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}
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

  // Draw our own face/eye overlay on a canvas placed over the preview
  // video. Independent of WebGazer's internal overlay canvases (which are
  // broken on some builds). positions: array of [x,y,z] in video pixels
  // from getTracker().getPositions(). Returns landmark count (0 = none).
  renderFaceOverlay(canvas, video, positions) {
    try {
      if (!canvas || !video) return 0;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh || !positions || positions.length < 100) return 0;
      // Match the canvas to the displayed video box.
      const rect = video.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return 0;
      if (canvas.width !== Math.round(rect.width) || canvas.height !== Math.round(rect.height)) {
        canvas.width = Math.round(rect.width);
        canvas.height = Math.round(rect.height);
      }
      canvas.style.display = this.videoVisible ? 'block' : 'none';
      if (!this.videoVisible) return positions.length;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // Position the canvas exactly over the video.
      const cs = canvas.style;
      cs.position = 'fixed';
      cs.left = `${rect.left}px`;
      cs.top = `${rect.top}px`;
      cs.zIndex = '1201';
      cs.pointerEvents = 'none';
      const mirrored = true; // both preview paths mirror the video
      // All landmarks, faint.
      ctx.fillStyle = 'rgba(50,238,219,0.5)';
      for (const p of positions) {
        if (!p) continue;
        const [cx, cy] = mapLandmarkToCanvas(p[0], p[1], vw, vh, canvas.width, canvas.height, mirrored);
        ctx.fillRect(cx, cy, 1.5, 1.5);
      }
      // Eye boxes, bright green.
      ctx.strokeStyle = '#3ddc84';
      ctx.lineWidth = 2;
      for (const side of ['left', 'right']) {
        const box = bboxOf(EyeIndices[side], positions, vw, vh, canvas.width, canvas.height, mirrored);
        if (box) ctx.strokeRect(box.x, box.y, box.w, box.h);
      }
      return positions.length;
    } catch (err) {
      console.warn('face overlay skipped', err);
      return 0;
    }
  }

  hideFaceOverlay(canvas) {
    try {
      if (canvas) {
        canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
        canvas.style.display = 'none';
      }
    } catch {
      /* ignore */
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
