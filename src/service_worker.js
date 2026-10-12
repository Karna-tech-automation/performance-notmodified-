/**
 * Perf-Trace-Pulse — Service Worker v1.7
 * - Settle window after reload (blocks screenshots + content actions)
 * - Force param on captureScreenshot for the initial start shot
 */

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

let activeRecording = null;
let memoryInterval = null;

const SCREENSHOT_MIN_GAP_MS = 250;
const MAX_SCREENSHOTS = 500;
const MAX_BODY_BYTES = 100_000;
let lastScreenshotAt = 0;

const panelPorts = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'perf-trace-panel') return;
  panelPorts.add(port);
  port.onDisconnect.addListener(() => panelPorts.delete(port));
  try {
    port.postMessage({
      type: 'RECORDING_STATUS',
      recording: !!activeRecording,
      currentRecording: activeRecording ? { name: activeRecording.name } : null
    });
  } catch (_) {}
});

function broadcastToPanel(message) {
  for (const p of panelPorts) {
    try { p.postMessage(message); } catch (_) { panelPorts.delete(p); }
  }
}

function uuid(prefix) {
  return prefix + '-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now();
}

// ── Screenshot (with settle-window support) ───────────────────────
async function captureScreenshot(tabId, label, meta, force) {
  if (!activeRecording || !tabId) return null;

  // Block during settle window (unless force)
  if (!force && activeRecording.settleUntil && Date.now() < activeRecording.settleUntil) {
    return null;
  }

  const now = Date.now();
  const important = ['start', 'stop', 'navigate', 'error', 'dialog', 'modal', 'dropdown'].includes(label);
  if (!important && now - lastScreenshotAt < SCREENSHOT_MIN_GAP_MS) return null;
  if (activeRecording.screenshots.length >= MAX_SCREENSHOTS) return null;

  lastScreenshotAt = now;

  try {
    const { data } = await chrome.debugger.sendCommand(
      { tabId }, 'Page.captureScreenshot',
      { format: 'jpeg', quality: 50, fromSurface: true, captureBeyondViewport: false }
    );
    if (!data) return null;

    const idx = activeRecording.screenshots.length;
    const shot = {
      id: 'shot-' + String(idx).padStart(4, '0'),
      label: label,
      timestamp: now,
      relativeMs: now - activeRecording.startTime,
      url: activeRecording.url || '',
      duration: (meta && meta.duration) || 0,
      detail: (meta && meta.detail) || '',
      data: data
    };
    activeRecording.screenshots.push(shot);
    broadcastToPanel({ type: 'SHOT', count: activeRecording.screenshots.length });
    return shot;
  } catch (e) {
    console.warn('Screenshot failed:', e.message);
    return null;
  }
}

function waitForLoad(tabId, timeoutMs) {
  timeoutMs = timeoutMs || 8000;
  return new Promise((resolve) => {
    let done = false;
    const onEvent = (source, method) => {
      if (source.tabId === tabId && method === 'Page.loadEventFired') {
        if (!done) {
          done = true;
          try { chrome.debugger.onEvent.removeListener(onEvent); } catch (_) {}
          resolve(true);
        }
      }
    };
    chrome.debugger.onEvent.addListener(onEvent);
    setTimeout(() => {
      if (!done) {
        done = true;
        try { chrome.debugger.onEvent.removeListener(onEvent); } catch (_) {}
        resolve(false);
      }
    }, timeoutMs);
  });
}

// ── Start recording ────────────────────────────────────────────────
async function startRecording(name, tabId) {
  if (activeRecording) throw new Error('Already recording');

  activeRecording = {
    id: uuid('r'),
    name: name || '',
    startTime: Date.now(),
    endedAt: null,
    debuggeeTabId: tabId || null,
    url: null,
    network: { requests: {} },
    console: { entries: [] },
    vitals: { events: [] },
    actions: { entries: [] },
    memory: { samples: [] },
    navigations: [],
    screenshots: [],
    tabs: [{ tabId: tabId, openerTabId: null, createdAt: Date.now(), event: 'root' }],
    // Block all captures until we explicitly allow them
    settleUntil: Date.now() + 600000
  };

  if (tabId) {
    try { await chrome.debugger.attach({ tabId }, '1.3'); }
    catch (e) { console.warn('Debugger attach failed:', e.message); activeRecording.debuggeeTabId = null; }

    if (activeRecording.debuggeeTabId) {
      for (const d of ['Network', 'Page', 'Runtime', 'Log', 'Performance']) {
        try { await chrome.debugger.sendCommand({ tabId }, d + '.enable'); } catch (_) {}
      }

      try {
        const res = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: '({ url: location.href, viewport: { width: innerWidth, height: innerHeight } })',
          returnByValue: true
        });
        if (res && res.result && res.result.value) {
          activeRecording.url = res.result.value.url;
          activeRecording.viewport = res.result.value.viewport;
        }
      } catch (_) {}

      broadcastToPanel({ type: 'RELOADING' });
      try {
        const loadPromise = waitForLoad(tabId, 6000);
        await chrome.debugger.sendCommand({ tabId }, 'Page.reload', { ignoreCache: false });
        await loadPromise;
        await new Promise((r) => setTimeout(r, 1200));
      } catch (e) { console.warn('Reload failed:', e.message); }

      for (const d of ['Network', 'Runtime', 'Log']) {
        try { await chrome.debugger.sendCommand({ tabId }, d + '.enable'); } catch (_) {}
      }
    }

    try { await chrome.tabs.sendMessage(tabId, { target: 'content', type: 'RECORDING_STARTED' }); } catch (_) {}
    await new Promise((r) => setTimeout(r, 300));

    // Now unblock — settle window ends after the "start" screenshot + 2s
    activeRecording.settleUntil = Date.now() + 2000;
    await captureScreenshot(tabId, 'start', { detail: 'Recording started' }, true);  // force
  }

  startMemorySampling(tabId);
  broadcastToPanel({ type: 'RECORDING_STARTED' });
  return { ok: true };
}

// ── Stop recording ─────────────────────────────────────────────────
async function stopRecording() {
  if (!activeRecording) throw new Error('Not recording');

  if (memoryInterval) { clearInterval(memoryInterval); memoryInterval = null; }
  const tabId = activeRecording.debuggeeTabId;

  // Force the stop screenshot past the settle window
  if (tabId) await captureScreenshot(tabId, 'stop', { detail: 'Recording stopped' }, true);

  if (tabId) {
    try { await chrome.tabs.sendMessage(tabId, { target: 'content', type: 'RECORDING_STOPPED' }); } catch (_) {}
    await new Promise((r) => setTimeout(r, 400));
  }
  if (tabId) { try { await chrome.debugger.detach({ tabId }); } catch (_) {} }

  activeRecording.endedAt = Date.now();
  const report = buildPerformanceReport(activeRecording);
  await chrome.storage.local.set({ lastReport: report });

  broadcastToPanel({ type: 'RECORDING_STOPPED' });
  broadcastToPanel({ type: 'REPORT_READY', reportId: report.reportId });
  activeRecording = null;
  return { ok: true, report: report };
}

async function cancelRecording() {
  if (memoryInterval) { clearInterval(memoryInterval); memoryInterval = null; }
  if (activeRecording && activeRecording.debuggeeTabId) {
    try { await chrome.debugger.detach({ tabId: activeRecording.debuggeeTabId }); } catch (_) {}
  }
  activeRecording = null;
  broadcastToPanel({ type: 'RECORDING_STOPPED' });
  return { ok: true };
}

function startMemorySampling(tabId) {
  if (memoryInterval) clearInterval(memoryInterval);
  memoryInterval = setInterval(async () => {
    if (!activeRecording || !tabId) return;
    try {
      const { metrics } = await chrome.debugger.sendCommand({ tabId }, 'Performance.getMetrics');
      const get = (n) => {
        const m = metrics.find((x) => x.name === n);
        return m ? m.value : undefined;
      };
      activeRecording.memory.samples.push({
        timestamp: Date.now(),
        relativeMs: Date.now() - activeRecording.startTime,
        jsHeapUsed: get('JSHeapUsedSize'),
        jsHeapTotal: get('JSHeapTotalSize'),
        nodes: get('Nodes'),
        documents: get('Documents'),
        layoutCount: get('LayoutCount'),
        recalcStyleCount: get('RecalcStyleCount'),
        taskDuration: get('TaskDuration')
      });
    } catch (_) {}
  }, 2000);
}

// ── CDP event listeners ────────────────────────────────────────────
chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (!activeRecording) return;
  const tabId = source.tabId;

  switch (method) {
    case 'Network.requestWillBeSent':
      activeRecording.network.requests[params.requestId] = {
        id: params.requestId, url: params.request.url, method: params.request.method,
        requestHeaders: params.request.headers,
        postData: params.request.postData,
        startTime: params.timestamp * 1000,
        epoch: Date.now(),
        relativeMs: Date.now() - activeRecording.startTime,
        tabId: tabId, type: params.type
      };
      break;

    case 'Network.responseReceived': {
      const req = activeRecording.network.requests[params.requestId];
      if (req) {
        req.status = params.response.status;
        req.statusText = params.response.statusText;
        req.mimeType = params.response.mimeType;
        req.responseHeaders = params.response.headers;
        req.timing = params.response.timing;
        req.fromCache = params.response.fromDiskCache || params.response.fromServiceWorker;
        req.protocol = params.response.protocol;
      }
      break;
    }

    case 'Network.loadingFinished': {
      const req = activeRecording.network.requests[params.requestId];
      if (req) {
        req.endTime = params.timestamp * 1000;
        req.encodedDataLength = params.encodedDataLength;
        req.durationMs = Math.round(req.endTime - req.startTime);

        const mt = req.mimeType || '';
        const wantBody = (mt.indexOf('json') !== -1 || mt.indexOf('text/plain') !== -1 || mt.indexOf('xml') !== -1)
                         && mt.indexOf('javascript') === -1 && mt.indexOf('css') === -1 && mt.indexOf('html') === -1;
        if (wantBody && (params.encodedDataLength || 0) < MAX_BODY_BYTES) {
          try {
            const body = await chrome.debugger.sendCommand(source, 'Network.getResponseBody', {
              requestId: params.requestId
            });
            if (body && body.body && body.body.length < MAX_BODY_BYTES) {
              req.responseBody = body.base64Encoded ? '[base64]' : body.body;
            }
          } catch (_) {}
        }
      }
      break;
    }

    case 'Network.loadingFailed': {
      const req = activeRecording.network.requests[params.requestId];
      if (req) { req.failed = true; req.errorText = params.errorText; req.blockedReason = params.blockedReason; }
      activeRecording.console.entries.push({
        id: uuid('c'), level: 'network-error',
        message: 'NETWORK FAILED: ' + params.errorText + ' (' + ((req && req.url) || 'unknown') + ')',
        timestamp: Date.now(),
        relativeMs: Date.now() - activeRecording.startTime,
        tabId: tabId
      });
      break;
    }

    case 'Runtime.consoleAPICalled': {
      const message = params.args.map((a) => {
        if (a.value !== undefined) return String(a.value);
        if (a.description) return a.description;
        try { return JSON.stringify(a.preview || a); } catch (e) { return '[Unserializable]'; }
      }).join(' ');
      activeRecording.console.entries.push({
        id: uuid('c'), level: params.type, message: message.slice(0, 2000),
        timestamp: Date.now(), relativeMs: Date.now() - activeRecording.startTime, tabId: tabId
      });
      break;
    }

    case 'Runtime.exceptionThrown': {
      const d = params.exceptionDetails;
      activeRecording.console.entries.push({
        id: uuid('e'), level: 'uncaught',
        message: (d.exception && d.exception.description) || d.text,
        stack: d.stackTrace && d.stackTrace.callFrames ?
          d.stackTrace.callFrames.map((f) =>
            (f.functionName || '(anon)') + ' @ ' + f.url + ':' + (f.lineNumber + 1) + ':' + f.columnNumber
          ).join('\n') : '',
        timestamp: Date.now(), relativeMs: Date.now() - activeRecording.startTime, tabId: tabId
      });
      if (tabId) captureScreenshot(tabId, 'error', { detail: 'Uncaught: ' + (d.text || '') });
      break;
    }

    case 'Log.entryAdded': {
      activeRecording.console.entries.push({
        id: uuid('c'), level: params.entry.level, message: params.entry.text,
        source: params.entry.source, timestamp: Date.now(),
        relativeMs: Date.now() - activeRecording.startTime, tabId: tabId
      });
      break;
    }

    case 'Page.javascriptDialogOpening': {
      activeRecording.console.entries.push({
        id: uuid('d'), level: 'dialog',
        message: '[' + params.type + '] ' + params.message,
        timestamp: Date.now(), relativeMs: Date.now() - activeRecording.startTime, tabId: tabId
      });
      if (tabId) captureScreenshot(tabId, 'dialog', { detail: '[' + params.type + '] ' + (params.message || '').slice(0, 80) });
      break;
    }
  }
});

chrome.debugger.onDetach.addListener(async (source) => {
  if (!activeRecording) return;
  if (source.tabId && source.tabId === activeRecording.debuggeeTabId) {
    setTimeout(async () => {
      try {
        await chrome.debugger.attach({ tabId: source.tabId }, '1.3');
        for (const d of ['Network', 'Page', 'Runtime', 'Log', 'Performance']) {
          try { await chrome.debugger.sendCommand({ tabId: source.tabId }, d + '.enable'); } catch (_) {}
        }
      } catch (_) {}
    }, 300);
  }
});

// ── Tab lifecycle ──────────────────────────────────────────────────
chrome.tabs.onCreated.addListener((tab) => {
  if (!activeRecording) return;
  activeRecording.tabs.push({
    tabId: tab.id, openerTabId: tab.openerTabId, createdAt: Date.now(),
    url: tab.pendingUrl || tab.url, event: 'created'
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!activeRecording) return;
  const t = activeRecording.tabs.find((x) => x.tabId === tabId && !x.closedAt);
  if (t) t.closedAt = Date.now();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!activeRecording || tabId !== activeRecording.debuggeeTabId) return;

  if (changeInfo.status === 'loading') {
    activeRecording.navigations.push({
      id: uuid('n'), tabId: tabId, url: tab.url, event: 'start',
      timestamp: Date.now(), relativeMs: Date.now() - activeRecording.startTime
    });
    activeRecording.url = tab.url;
  } else if (changeInfo.status === 'complete') {
    activeRecording.url = tab.url;
    activeRecording.navigations.push({
      id: uuid('n'), tabId: tabId, url: tab.url, event: 'complete',
      timestamp: Date.now(), relativeMs: Date.now() - activeRecording.startTime
    });

    // Skip navigate screenshot during settle window
    if (activeRecording.settleUntil && Date.now() < activeRecording.settleUntil) return;

    const tabIdSnap = tabId;
    const urlSnap = tab.url;
    await waitForLoad(tabIdSnap, 5000);
    await new Promise((r) => setTimeout(r, 700));
    if (activeRecording && activeRecording.debuggeeTabId === tabIdSnap) {
      captureScreenshot(tabIdSnap, 'navigate', {
        detail: 'Navigated to ' + (urlSnap || '').slice(0, 90)
      });
    }
  }
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (!activeRecording || details.tabId !== activeRecording.debuggeeTabId) return;
  activeRecording.navigations.push({
    id: uuid('n'), tabId: details.tabId, url: details.url,
    transitionType: details.transitionType, event: 'committed',
    timestamp: Date.now(), relativeMs: Date.now() - activeRecording.startTime
  });
});

// ── Messages ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === 'offscreen') return false;
  handleMessage(msg, sender).then(sendResponse).catch((e) =>
    sendResponse({ ok: false, error: String(e) })
  );
  return true;
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case 'START_RECORDING': return startRecording(msg.name, msg.tabId);
    case 'STOP_RECORDING': return stopRecording();
    case 'CANCEL_RECORDING': return cancelRecording();

    case 'GET_RECORDING_STATUS':
      return {
        recording: !!activeRecording,
        currentRecording: activeRecording ? { name: activeRecording.name } : null
      };

    case 'CONTENT_BATCH': {
      if (!activeRecording) return { ok: false };

      // Drop everything during settle window
      if (activeRecording.settleUntil && Date.now() < activeRecording.settleUntil) {
        return { ok: true };
      }

      const { actions, vitals } = msg.payload || { actions: [], vitals: [] };

      // Take ONE screenshot per interactive action (not two)
      if (actions.length > 0 && activeRecording.debuggeeTabId) {
        const interactive = actions.find((a) =>
          ['CLICK','SUBMIT','DBLCLICK','CHANGE','SPA_ROUTE_CHANGE','NAV_BACK'].indexOf(a.type) !== -1);
        if (interactive) {
          const first = interactive;
          const target = (first.target && (first.target.text || first.target.selector)) || '';
          const tabIdSnap = activeRecording.debuggeeTabId;
          const label = 'action-' + first.type.toLowerCase();
          const detail = first.type + ' -> ' + target.slice(0, 70);
          setTimeout(() => {
            if (activeRecording && activeRecording.debuggeeTabId === tabIdSnap) {
              captureScreenshot(tabIdSnap, label, {
                duration: first.duration || 0, detail: detail
              });
            }
          }, 500);
        }
      }

      for (let i = 0; i < actions.length; i++) {
        actions[i].frameUrl = sender.url;
        activeRecording.actions.entries.push(actions[i]);
      }
      for (let i = 0; i < vitals.length; i++) {
        vitals[i].frameUrl = sender.url;
        activeRecording.vitals.events.push(vitals[i]);
      }

      if (activeRecording.actions.entries.length > 10000)
        activeRecording.actions.entries = activeRecording.actions.entries.slice(-10000);
      return { ok: true };
    }

    case 'MUTATION_ALERT': {
      if (!activeRecording || !activeRecording.debuggeeTabId) return { ok: false };
      if (activeRecording.settleUntil && Date.now() < activeRecording.settleUntil) {
        return { ok: true };
      }
      const tabIdSnap = activeRecording.debuggeeTabId;
      const kind = msg.kind || 'change';
      const detail = msg.detail || '';
      setTimeout(() => {
        if (activeRecording && activeRecording.debuggeeTabId === tabIdSnap) {
          captureScreenshot(tabIdSnap, kind, { detail: detail });
        }
      }, 300);
      return { ok: true };
    }

    case 'GET_LAST_REPORT': {
      const { lastReport } = await chrome.storage.local.get('lastReport');
      if (!lastReport) return { ok: false, error: 'No report' };
      return { ok: true, report: lastReport };
    }

    case 'GET_LIVE_STATS': {
      if (!activeRecording) return { ok: false };
      return {
        ok: true,
        actions: activeRecording.actions.entries.length,
        requests: Object.keys(activeRecording.network.requests).length,
        errors: activeRecording.console.entries.filter((c) =>
          c.level === 'error' || c.level === 'uncaught').length,
        duration: Date.now() - activeRecording.startTime,
        screenshots: activeRecording.screenshots.length
      };
    }
  }
  return { ok: false, error: 'Unknown message type' };
}

// ── Build report ───────────────────────────────────────────────────
function buildPerformanceReport(s) {
  const requests = Object.values(s.network.requests);
  const failedRequests = requests.filter((r) => r.failed || (r.status && r.status >= 400));
  const errors = s.console.entries.filter((c) => c.level === 'error' || c.level === 'uncaught');

  const vitalsByName = {};
  for (const v of s.vitals.events) {
    if (v.name === 'LCP') vitalsByName.LCP = v.value;
    else if (v.name === 'FCP') vitalsByName.FCP = v.value;
    else if (v.name === 'CLS') vitalsByName.CLS = v.value;
    else if (v.name === 'TTFB') vitalsByName.TTFB = v.value;
    else if (v.name === 'INP_EVENT') vitalsByName.INP = Math.max(vitalsByName.INP || 0, v.value);
  }

  const durations = requests.map((r) => r.durationMs).filter(Boolean).sort((a, b) => a - b);
  const pct = (p) => durations.length ? durations[Math.floor(durations.length * p)] : 0;

  return {
    reportId: s.id,
    meta: {
      name: s.name || '',
      url: s.url || (s.tabs[0] && s.tabs[0].url) || 'unknown',
      startedAt: s.startTime, endedAt: s.endedAt,
      durationMs: s.endedAt - s.startTime,
      extensionVersion: '1.7.0'
    },
    summary: {
      totalActions: s.actions.entries.length,
      totalRequests: requests.length,
      failedRequests: failedRequests.length,
      totalTransferBytes: requests.reduce((a, r) => a + (r.encodedDataLength || 0), 0),
      lcp: vitalsByName.LCP, fcp: vitalsByName.FCP, cls: vitalsByName.CLS,
      inp: vitalsByName.INP, ttfb: vitalsByName.TTFB,
      p50: pct(0.5), p90: pct(0.9), p95: pct(0.95), p99: pct(0.99),
      totalErrors: errors.length,
      screenshotsCount: (s.screenshots || []).length
    },
    tabs: s.tabs,
    actions: s.actions.entries,
    network: requests,
    console: s.console.entries,
    navigations: s.navigations,
    webVitals: vitalsByName,
    vitalsEvents: s.vitals.events,
    memory: s.memory.samples,
    screenshots: s.screenshots || []
  };
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('Perf-Trace-Pulse v1.7.0 installed');
});