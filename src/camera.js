// Webcam capability detection + explicit permission request.
// WebGazer acquires its own stream later via begin(); this module is the
// explicit consent/permissions gate so the prompt happens as its own step.
export function supportsGetUserMedia() {
  return !!(
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function'
  );
}

export async function requestPermission() {
  if (!supportsGetUserMedia()) {
    throw new Error('getUserMedia is not supported in this browser.');
  }
  return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
}

export function stopStream(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}
