/**
 * Perf-Trace-Pulse — Side Panel logic
 * - Recording name is optional; prompted at download time if missing
 * - Download blocked while recording
 */

'use strict';

const recordBtn = document.getElementById('recordBtn');
const statusBadge = document.getElementById('statusBadge');
const recordingNameInput = document.getElementById('recordingName');
const outputDiv = document.getElementById('output');
const liveStats = document.getElementById('liveStats');
const downloadZipBtn = document.getElementById('downloadZipBtn');

let port = null;
let timer = null;
let startTime = 0;

// ── Port connection to service worker ──────────────────────────────
function connectToServiceWorker() {
  port = chrome.runtime.connect({ name: 'perf-trace-panel' });
  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    setTimeout(connectToServiceWorker, 1000);
  });
}

function onPortMessage(message) {
  switch (message.type) {
    case 'RECORDING_STATUS':
      applyStatus(message.recording, message.currentRecording);
      break;
    case 'RECORDING_STARTED':
      applyStatus(true);
      addLog('Recording started');
      startTimer();
      break;
    case 'RECORDING_STOPPED':
      applyStatus(false);
      addLog('Recording stopped');
      stopTimer();
      downloadZipBtn.classList.remove('hidden');
      break;
    case 'REPORT_READY':
      addLog('Report ready: ' + message.reportId);
      break;
  }
}

// ── UI helpers ─────────────────────────────────────────────────────
function applyStatus(recording, currentRecording) {
  if (recording) {
    statusBadge.textContent = currentRecording
      ? 'Recording: ' + (currentRecording.name || '(unnamed)') : 'Recording…';
    statusBadge.className = 'status status-recording';
    recordBtn.textContent = 'Stop Recording';
    recordBtn.className = 'btn btn-stop';
    recordingNameInput.disabled = true;
    liveStats.classList.remove('hidden');
    downloadZipBtn.classList.add('hidden');
  } else {
    statusBadge.textContent = 'Idle';
    statusBadge.className = 'status status-idle';
    recordBtn.textContent = 'Start Recording';
    recordBtn.className = 'btn btn-record';
    recordingNameInput.disabled = false;
  }
}

function addLog(message) {
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.textContent = new Date().toLocaleTimeString() + ' ' + message;
  outputDiv.appendChild(entry);
  outputDiv.scrollTop = outputDiv.scrollHeight;
}

// ── Timer & live stats ─────────────────────────────────────────────
function startTimer() {
  startTime = Date.now();
  timer = setInterval(() => {
    const s = Math.floor((Date.now() - startTime) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    document.getElementById('statDuration').textContent = mm + ':' + ss;

    chrome.runtime.sendMessage({ type: 'GET_LIVE_STATS' }, (res) => {
      if (res && res.ok) {
        document.getElementById('statActions').textContent = res.actions;
        document.getElementById('statRequests').textContent = res.requests;
        document.getElementById('statErrors').textContent = res.errors;
        document.getElementById('statShots').textContent = res.screenshots || 0;
      }
    });
  }, 1000);
}

function stopTimer() {
  clearInterval(timer);
  timer = null;
}

// ── Name-prompt modal ──────────────────────────────────────────────
function askForName(defaultVal) {
  return new Promise((resolve) => {
    const modal = document.getElementById('nameModal');
    const input = document.getElementById('nameModalInput');
    const okBtn = document.getElementById('nameModalOk');
    const cancelBtn = document.getElementById('nameModalCancel');
    const backdrop = document.getElementById('nameModalBackdrop');

    if (!modal) { resolve(null); return; }

    input.value = defaultVal || 'perf-report';
    modal.classList.remove('hidden');
    setTimeout(() => { input.focus(); input.select(); }, 30);

    function cleanup() {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      backdrop.removeEventListener('click', onCancel);
      input.removeEventListener('keydown', onKey);
    }
    function onOk() {
      const v = input.value.trim();
      cleanup();
      resolve(v || null);
    }
    function onCancel() {
      cleanup();
      resolve(null);
    }
    function onKey(e) {
      if (e.key === 'Enter') onOk();
      else if (e.key === 'Escape') onCancel();
    }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    backdrop.addEventListener('click', onCancel);
    input.addEventListener('keydown', onKey);
  });
}

// ── Record button ──────────────────────────────────────────────────
recordBtn.addEventListener('click', async () => {
  const status = await chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATUS' });
  if (status && status.recording) {
    await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
  } else {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    // Allow empty name — modal will prompt at download time
    const name = recordingNameInput.value.trim();
    const res = await chrome.runtime.sendMessage({
      type: 'START_RECORDING', name: name, tabId: tab.id
    });
    if (!res || !res.ok) addLog('Error: ' + ((res && res.error) || 'unknown'));
  }
});

// ── Download ZIP ───────────────────────────────────────────────────
downloadZipBtn.addEventListener('click', async () => {
  const status = await chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATUS' });
  if (status && status.recording) {
    addLog('Stop the recording first, then download.');
    return;
  }

  downloadZipBtn.disabled = true;
  downloadZipBtn.textContent = '⏳ Building ZIP… (may take 10–30s)';
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_LAST_REPORT' });
    if (!res || !res.ok) throw new Error((res && res.error) || 'No report');
    const report = res.report;

    // No name given? Ask now.
    if (!report.meta.name || !report.meta.name.trim()) {
      const chosen = await askForName('perf-report');
      if (!chosen) {
        downloadZipBtn.disabled = false;
        downloadZipBtn.textContent = '📦 Download Report (.zip)';
        addLog('Download cancelled.');
        return;
      }
      report.meta.name = chosen;
      try { await chrome.storage.local.set({ lastReport: report }); } catch (_) {}
    }

    await window.downloadZipReport(report);
    addLog('Downloaded: ' + report.meta.name + '.zip');
    downloadZipBtn.textContent = '✅ Downloaded';
    setTimeout(() => {
      downloadZipBtn.textContent = '📦 Download Report (.zip)';
      downloadZipBtn.disabled = false;
    }, 2500);
  } catch (e) {
    console.error(e);
    addLog('ZIP error: ' + e.message);
    downloadZipBtn.textContent = '❌ ' + e.message;
    setTimeout(() => {
      downloadZipBtn.textContent = '📦 Download Report (.zip)';
      downloadZipBtn.disabled = false;
    }, 3000);
  }
});

// ── Init ───────────────────────────────────────────────────────────
connectToServiceWorker();
chrome.runtime.sendMessage({ type: 'GET_RECORDING_STATUS' }, (res) => {
  if (res && res.recording) {
    applyStatus(true, res.currentRecording);
    startTimer();
  }
});