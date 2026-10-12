/**
 * Performance TraceRecorder — Offscreen Document
 * Runs MediaRecorder for full-session tab video (MV3 service workers can't).
 */

let recorder = null;
let chunks = [];
let stream = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;

  switch (msg.type) {
    case 'START_VIDEO':
      startVideo(msg.streamId).then(sendResponse).catch((e) =>
        sendResponse({ ok: false, error: String(e) })
      );
      return true;

    case 'STOP_VIDEO':
      stopVideo().then(sendResponse).catch((e) =>
        sendResponse({ ok: false, error: String(e) })
      );
      return true;
  }
  return false;
});

async function startVideo(streamId) {
  if (recorder) return { ok: false, error: 'Already recording' };

  stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxWidth: 1920,
        maxHeight: 1080,
        maxFrameRate: 30
      }
    }
  });

  // Route audio back to speakers so user still hears the tab
  try {
    const audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(audioCtx.destination);
  } catch (_) {}

  chunks = [];
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
    ? 'video/webm;codecs=vp9'
    : 'video/webm';

  recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 2_500_000
  });

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  recorder.start(1000);
  return { ok: true, mimeType };
}

async function stopVideo() {
  if (!recorder) return { ok: false, error: 'Not recording' };

  return new Promise((resolve) => {
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const buf = await blob.arrayBuffer();
      const base64 = arrayBufferToBase64(buf);

      if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
      recorder = null;
      chunks = [];

      resolve({ ok: true, base64, mimeType: 'video/webm', sizeBytes: buf.byteLength });
    };
    recorder.stop();
  });
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}