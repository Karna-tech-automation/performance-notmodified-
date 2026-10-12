/**
 * Perf-Trace-Pulse - ZIP Report Builder v2.3
 * - Health verdict with clickable risk drill-down
 * - Attachments tab (video + screenshots)
 * - Show-more button on tables (20 rows default)
 * - Console tab includes warnings (amber) alongside errors (red)
 */

(function () {
  'use strict';

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function base64ToUint8Array(base64) {
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function utf8ToBase64(str) {
    var bytes = new TextEncoder().encode(str);
    var binary = '';
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function safeJSONBase64(obj) { return utf8ToBase64(JSON.stringify(obj)); }

  function safeFilenameStem(rawName) {
    var name = String(rawName == null ? '' : rawName).trim();
    if (!name) name = 'recording';
    name = name.replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    if (!name) name = 'recording';
    if (name.length > 60) name = name.slice(0, 60);
    return name;
  }

  // ============================================================
  //  HEALTH SCORE — includes per-factor data for drill-down
  // ============================================================
  function computeHealth(report) {
    var s = report.summary || {};
    var memory = report.memory || [];
    var net = report.network || [];
    var console_ = report.console || [];
    var vitalsEvents = report.vitalsEvents || [];

    var score = 100;
    var factors = [];
    var recommendations = [];

    // ── 1. Web Vitals ────────────────────────────────────────
    var vitalsIssues = 0;
    var vitalsVerdict = 'good';
    function vital(name, val, good, warn) {
      if (val == null) return null;
      if (val > warn) { vitalsIssues += 2; vitalsVerdict = 'bad'; return 'bad'; }
      if (val > good) { vitalsIssues += 1; if (vitalsVerdict !== 'bad') vitalsVerdict = 'warn'; return 'warn'; }
      return 'good';
    }
    var vitalData = [
      { name: 'LCP',  value: s.lcp,  unit: 'ms', good: 2500, warn: 4000, verdict: vital('LCP', s.lcp, 2500, 4000) },
      { name: 'FCP',  value: s.fcp,  unit: 'ms', good: 1800, warn: 3000, verdict: vital('FCP', s.fcp, 1800, 3000) },
      { name: 'CLS',  value: s.cls,  unit: '',   good: 0.1,  warn: 0.25, verdict: vital('CLS', s.cls, 0.1, 0.25) },
      { name: 'INP',  value: s.inp,  unit: 'ms', good: 200,  warn: 500,  verdict: vital('INP', s.inp, 200, 500) },
      { name: 'TTFB', value: s.ttfb, unit: 'ms', good: 800,  warn: 1800, verdict: vital('TTFB', s.ttfb, 800, 1800) }
    ];

    if (vitalsIssues >= 4) score -= 30;
    else if (vitalsIssues >= 2) score -= 15;
    else if (vitalsIssues === 1) score -= 6;

    factors.push({
      id: 'vitals',
      name: 'Web Vitals',
      verdict: vitalsVerdict,
      detail: vitalsIssues === 0 ? 'All in good range' : vitalsIssues + ' metric' + (vitalsIssues > 1 ? 's' : '') + ' outside target',
      weight: vitalsIssues >= 2 ? 'HIGH' : vitalsIssues === 1 ? 'AVERAGE' : 'GOOD',
      data: vitalData
    });
    if (vitalsIssues > 0) recommendations.push('Improve ' + (s.lcp > 2500 ? 'LCP' : '') + (s.fcp > 1800 ? (s.lcp > 2500 ? ', ' : '') + 'FCP' : '') + ' — target under 2.5s / 1.8s');

    // ── 2. Slow APIs ─────────────────────────────────────────
    var slowAPIs = net.filter(function (r) { return r.durationMs >= 1000; })
      .sort(function (a, b) { return b.durationMs - a.durationMs; });
    var slow1s = slowAPIs.filter(function (r) { return r.durationMs < 2000; }).length;
    var slow2s = slowAPIs.filter(function (r) { return r.durationMs >= 2000; }).length;
    var slowTotal = slow1s + slow2s;
    var apiVerdict = 'good';
    var apiRisk = 'GOOD';

    if (slow2s >= 3) { score -= 25; apiVerdict = 'bad'; apiRisk = 'CRITICAL'; }
    else if (slow2s >= 1) { score -= 15; apiVerdict = 'bad'; apiRisk = 'HIGH'; }
    else if (slow1s >= 5) { score -= 15; apiVerdict = 'warn'; apiRisk = 'HIGH'; }
    else if (slow1s >= 2) { score -= 8; apiVerdict = 'warn'; apiRisk = 'AVERAGE'; }
    else if (slow1s === 1) { score -= 3; apiVerdict = 'warn'; apiRisk = 'AVERAGE'; }

    factors.push({
      id: 'apiSpeed',
      name: 'API Response Time',
      verdict: apiVerdict,
      detail: slowTotal === 0 ? 'No slow calls detected' : slowTotal + ' call' + (slowTotal > 1 ? 's' : '') + ' over 1s' + (slow2s ? ' (' + slow2s + ' over 2s)' : ''),
      weight: apiRisk,
      data: slowAPIs.slice(0, 30)
    });
    if (slow2s > 0 && slowAPIs[0]) recommendations.push('Investigate ' + shortPath(slowAPIs[0].url) + ' — takes ' + slowAPIs[0].durationMs + ' ms');

    // ── 3. Network Failures ─────────────────────────────────
    var failedList = net.filter(function (r) { return r.failed || (r.status && r.status >= 400); });
    var failed = failedList.length;
    var failVerdict = 'good';
    var failRisk = 'GOOD';
    if (failed >= 5) { score -= 30; failVerdict = 'bad'; failRisk = 'CRITICAL'; }
    else if (failed >= 2) { score -= 20; failVerdict = 'bad'; failRisk = 'HIGH'; }
    else if (failed === 1) { score -= 10; failVerdict = 'warn'; failRisk = 'AVERAGE'; }

    factors.push({
      id: 'failures',
      name: 'Network Failures',
      verdict: failVerdict,
      detail: failed === 0 ? 'No failed requests' : failed + ' request' + (failed > 1 ? 's' : '') + ' failed (4xx/5xx)',
      weight: failRisk,
      data: failedList
    });
    if (failed > 0) recommendations.push('Fix ' + failed + ' failing API' + (failed > 1 ? 's' : '') + ' — see drill-down');

    // ── 4. Console Errors ───────────────────────────────────
    var errList = console_.filter(function (c) { return c.level === 'error' || c.level === 'uncaught'; });
    var errs = errList.length;
    var errVerdict = 'good';
    var errRisk = 'GOOD';
    if (errs >= 10) { score -= 25; errVerdict = 'bad'; errRisk = 'CRITICAL'; }
    else if (errs >= 4) { score -= 15; errVerdict = 'bad'; errRisk = 'HIGH'; }
    else if (errs >= 1) { score -= 6; errVerdict = 'warn'; errRisk = 'AVERAGE'; }

    factors.push({
      id: 'console',
      name: 'Console Errors',
      verdict: errVerdict,
      detail: errs === 0 ? 'Clean console' : errs + ' error' + (errs > 1 ? 's' : '') + ' logged',
      weight: errRisk,
      data: errList.slice(0, 30)
    });
    if (errs > 0) recommendations.push('Review ' + errs + ' console error' + (errs > 1 ? 's' : ''));

    // ── 5. Memory ───────────────────────────────────────────
    var peakHeapMB = 0;
    if (memory.length) peakHeapMB = Math.max.apply(null, memory.map(function (m) { return m.jsHeapUsed || 0; })) / 1048576;
    var memVerdict = 'good';
    var memRisk = 'GOOD';
    if (peakHeapMB >= 200) { score -= 20; memVerdict = 'bad'; memRisk = 'HIGH'; }
    else if (peakHeapMB >= 100) { score -= 10; memVerdict = 'warn'; memRisk = 'AVERAGE'; }
    else if (peakHeapMB >= 50) { score -= 4; memVerdict = 'warn'; memRisk = 'AVERAGE'; }

    factors.push({
      id: 'memory',
      name: 'Memory Usage',
      verdict: memVerdict,
      detail: peakHeapMB > 0 ? 'Peak: ' + peakHeapMB.toFixed(1) + ' MB JS heap' : 'Not sampled',
      weight: memRisk,
      data: memory.map(function (m) {
        return { timestamp: m.timestamp, heapMB: (m.jsHeapUsed || 0) / 1048576, nodes: m.nodes, documents: m.documents };
      })
    });
    if (peakHeapMB >= 100) recommendations.push('Memory peak is high (' + peakHeapMB.toFixed(0) + ' MB) — check for leaks');

    // ── 6. DOM Complexity ───────────────────────────────────
    var peakNodes = 0;
    if (memory.length) peakNodes = Math.max.apply(null, memory.map(function (m) { return m.nodes || 0; }));
    var domVerdict = 'good';
    var domRisk = 'GOOD';
    if (peakNodes >= 5000) { score -= 12; domVerdict = 'bad'; domRisk = 'HIGH'; }
    else if (peakNodes >= 3000) { score -= 6; domVerdict = 'warn'; domRisk = 'AVERAGE'; }
    else if (peakNodes >= 1500) { score -= 2; domVerdict = 'warn'; domRisk = 'AVERAGE'; }

    factors.push({
      id: 'dom',
      name: 'DOM Complexity',
      verdict: domVerdict,
      detail: peakNodes > 0 ? 'Peak: ' + peakNodes.toLocaleString() + ' nodes' : 'Not sampled',
      weight: domRisk,
      data: memory.map(function (m) {
        return { timestamp: m.timestamp, nodes: m.nodes, documents: m.documents };
      })
    });
    if (peakNodes >= 5000) recommendations.push('Page has ' + peakNodes.toLocaleString() + ' DOM nodes — consider virtualization');

    // ── 7. Long Tasks ───────────────────────────────────────
    var longTaskList = vitalsEvents.filter(function (v) { return v.name === 'LONGTASK'; })
      .sort(function (a, b) { return b.value - a.value; });
    var longestTask = 0;
    if (longTaskList.length) longestTask = longTaskList[0].value;
    var ltVerdict = 'good';
    var ltRisk = 'GOOD';
    if (longestTask >= 500) { score -= 15; ltVerdict = 'bad'; ltRisk = 'HIGH'; }
    else if (longestTask >= 200) { score -= 6; ltVerdict = 'warn'; ltRisk = 'AVERAGE'; }

    factors.push({
      id: 'longTasks',
      name: 'Long Tasks',
      verdict: ltVerdict,
      detail: longTaskList.length === 0 ? 'None detected' : longTaskList.length + ' task' + (longTaskList.length > 1 ? 's' : '') + ' (>50 ms); longest ' + Math.round(longestTask) + ' ms',
      weight: ltRisk,
      data: longTaskList.slice(0, 30).map(function (t) {
        return { timestamp: t.timestamp, epoch: t.epoch, duration: t.value };
      })
    });
    if (longestTask >= 200) recommendations.push('Main thread blocked for ' + Math.round(longestTask) + ' ms — break up long tasks');

    // ── Final verdict ───────────────────────────────────────
    if (score < 0) score = 0;
    if (score > 100) score = 100;

    var verdictClass, verdictLabel;
    if (score >= 85) { verdictClass = 'healthy'; verdictLabel = 'HEALTHY'; }
    else if (score >= 65) { verdictClass = 'average'; verdictLabel = 'AVERAGE'; }
    else if (score >= 40) { verdictClass = 'high'; verdictLabel = 'HIGH RISK'; }
    else { verdictClass = 'critical'; verdictLabel = 'CRITICAL'; }

    var criticalCount = factors.filter(function (f) { return f.weight === 'CRITICAL'; }).length;
    var highCount = factors.filter(function (f) { return f.weight === 'HIGH'; }).length;
    var avgCount = factors.filter(function (f) { return f.weight === 'AVERAGE'; }).length;
    var issueCount = criticalCount + highCount + avgCount;

    var sentence;
    if (verdictClass === 'healthy') sentence = 'All monitored factors are within healthy thresholds. This session passed the performance sanity check.';
    else if (verdictClass === 'average') sentence = issueCount + ' minor issue' + (issueCount > 1 ? 's' : '') + ' detected. No user-facing impact, but worth monitoring.';
    else if (verdictClass === 'high') sentence = issueCount + ' significant issue' + (issueCount > 1 ? 's' : '') + ' affect user experience. Fix before release.';
    else sentence = issueCount + ' critical issue' + (issueCount > 1 ? 's' : '') + ' found. This session does not meet performance targets.';

    return {
      score: score,
      verdict: verdictClass,
      verdictClass: verdictClass,
      verdictLabel: verdictLabel,
      sentence: sentence,
      factors: factors,
      recommendations: recommendations.slice(0, 8),
      counts: { critical: criticalCount, high: highCount, average: avgCount }
    };
  }

  function shortPath(u) {
    try { var url = new URL(u); return url.pathname.split('/').slice(-2).join('/'); }
    catch (e) { return u; }
  }

  // ---- Frame player ----
  function buildPlayerHTML(report) {
    var shots = report.screenshots || [];
    if (!shots.length) return '<p style="color:#8b95a5">No frames captured.</p>';

    var frames = shots.map(function (s) {
      return {
        src: 'data:image/jpeg;base64,' + s.data,
        label: s.label, detail: s.detail || '',
        duration: s.duration || 0, time: s.timestamp, rel: s.relativeMs || 0
      };
    });
    var framesB64 = safeJSONBase64(frames);
    var idSuffix = Math.random().toString(36).slice(2, 8);

    var html = '';
    html += '<div class="player" data-player="' + idSuffix + '">';
    html += '  <div class="player-stage">';
    html += '    <img class="player-img" alt="frame" />';
    html += '    <div class="player-overlay">';
    html += '      <div class="player-label"></div>';
    html += '      <div class="player-detail"></div>';
    html += '    </div>';
    html += '  </div>';
    html += '  <div class="player-controls">';
    html += '    <button class="player-btn player-prev" type="button">&#9198;</button>';
    html += '    <button class="player-btn player-btn-primary player-play" type="button">&#9654;</button>';
    html += '    <button class="player-btn player-next" type="button">&#9197;</button>';
    html += '    <input class="player-scrubber" type="range" min="0" max="' + (frames.length - 1) + '" value="0" step="1" />';
    html += '    <span class="player-counter">1 / ' + frames.length + '</span>';
    html += '    <label class="player-speed">Speed: <select class="player-speed-sel">';
    html += '      <option value="0.25">0.25x</option><option value="0.5">0.5x</option>';
    html += '      <option value="1" selected>1x</option><option value="2">2x</option><option value="4">4x</option>';
    html += '    </select></label>';
    html += '    <span class="player-time"></span>';
    html += '  </div>';
    html += '</div>';
    html += '<div class="frames-data" data-b64="' + framesB64 + '" style="display:none"></div>';

    html += '<script>';
    html += '(function(){';
    html += '  try {';
    html += '    var player = document.querySelector(".player[data-player=\\"' + idSuffix + '\\"]");';
    html += '    if (!player) return;';
    html += '    var dataEl = player.nextElementSibling;';
    html += '    var b64 = dataEl.getAttribute("data-b64");';
    html += '    var bin = atob(b64); var bytes = new Uint8Array(bin.length);';
    html += '    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);';
    html += '    var frames = JSON.parse(new TextDecoder().decode(bytes));';
    html += '    var img = player.querySelector(".player-img");';
    html += '    var labelEl = player.querySelector(".player-label");';
    html += '    var detailEl = player.querySelector(".player-detail");';
    html += '    var btnPlay = player.querySelector(".player-play");';
    html += '    var idx = 0, playing = false, timer = null;';
    html += '    function render() {';
    html += '      var f = frames[idx]; if (!f) return;';
    html += '      img.src = f.src;';
    html += '      labelEl.textContent = f.label + (f.duration ? " - " + f.duration + " ms" : "");';
    html += '      detailEl.textContent = f.detail || "";';
    html += '      player.querySelector(".player-counter").textContent = (idx+1) + " / " + frames.length;';
    html += '      player.querySelector(".player-scrubber").value = idx;';
    html += '      player.querySelector(".player-time").textContent = new Date(f.time).toLocaleTimeString();';
    html += '      document.querySelectorAll(".thumb").forEach(function(t){ t.classList.remove("current"); });';
    html += '      var cur = document.querySelector(".thumb[data-idx=\\"" + idx + "\\"]");';
    html += '      if (cur) cur.classList.add("current");';
    html += '    }';
    html += '    function next() { if (idx < frames.length - 1) { idx++; render(); return true; } return false; }';
    html += '    function prev() { if (idx > 0) { idx--; render(); return true; } return false; }';
    html += '    function scheduleNext() {';
    html += '      var sp = parseFloat(player.querySelector(".player-speed-sel").value) || 1;';
    html += '      timer = setTimeout(function(){ if (!playing) return; if (next()) scheduleNext(); else stop(); }, 800 / sp);';
    html += '    }';
    html += '    function play() { if (playing) return; if (idx === frames.length - 1) idx = 0; playing = true; btnPlay.textContent = "||"; render(); scheduleNext(); }';
    html += '    function stop() { playing = false; btnPlay.textContent = "\\u25B6"; if (timer) { clearTimeout(timer); timer = null; } }';
    html += '    btnPlay.addEventListener("click", function(){ playing ? stop() : play(); });';
    html += '    player.querySelector(".player-prev").addEventListener("click", function(){ stop(); prev(); });';
    html += '    player.querySelector(".player-next").addEventListener("click", function(){ stop(); next(); });';
    html += '    player.querySelector(".player-scrubber").addEventListener("input", function(e){ stop(); idx = parseInt(e.target.value, 10); render(); });';
    html += '    player.querySelector(".player-speed-sel").addEventListener("change", function(){ if (playing) { clearTimeout(timer); scheduleNext(); } });';
    html += '    window.__jumpToFrame = function(i){ stop(); idx = i; render(); };';
    html += '    render();';
    html += '  } catch (e) { console.error("Player init failed:", e); }';
    html += '})();';
    html += '</script>';
    return html;
  }

  // ---- Screenshots grid ----
  function buildScreenshotsGridHTML(report) {
    var shots = report.screenshots || [];
    if (!shots.length) return '<p style="color:#8b95a5">No screenshots captured.</p>';

    var html = '';
    html += '<div class="attachments-grid">';
    shots.forEach(function (s, i) {
      html += '<div class="thumb" data-idx="' + i + '" data-src="data:image/jpeg;base64,' + s.data + '" title="' + escapeHtml(s.detail || s.label) + '">';
      html += '  <img src="data:image/jpeg;base64,' + s.data + '" alt="' + escapeHtml(s.label) + '" loading="lazy" />';
      html += '  <div class="thumb-info">';
      html += '    <div class="thumb-label">' + escapeHtml(s.label) + '</div>';
      html += '    <div class="thumb-time">' + new Date(s.timestamp).toLocaleTimeString() + '</div>';
      html += '  </div>';
      html += '</div>';
    });
    html += '</div>';
    return html;
  }

  function buildLightboxHTML() {
    var html = '';
    html += '<div id="lightbox" class="lightbox" aria-hidden="true">';
    html += '  <div class="lightbox-bar">';
    html += '    <span id="lb-title" class="lightbox-title"></span>';
    html += '    <span class="lightbox-spacer"></span>';
    html += '    <button class="lb-btn" id="lb-zoom-out" type="button">-</button>';
    html += '    <span id="lb-zoom-label" class="lb-zoom-label">100%</span>';
    html += '    <button class="lb-btn" id="lb-zoom-in" type="button">+</button>';
    html += '    <button class="lb-btn" id="lb-zoom-reset" type="button">0</button>';
    html += '    <button class="lb-btn" id="lb-prev" type="button">&#9198;</button>';
    html += '    <button class="lb-btn" id="lb-next" type="button">&#9197;</button>';
    html += '    <button class="lb-btn lb-close" id="lb-close" type="button">x</button>';
    html += '  </div>';
    html += '  <div id="lb-stage" class="lightbox-stage"><img id="lb-img" alt="" draggable="false" /></div>';
    html += '</div>';
    return html;
  }

  function buildLightboxScript() {
    var s = '<script>';
    s += '(function(){';
    s += '  try {';
    s += '    var thumbs = Array.prototype.slice.call(document.querySelectorAll(".thumb"));';
    s += '    var lb = document.getElementById("lightbox");';
    s += '    var lbStage = document.getElementById("lb-stage");';
    s += '    var lbImg = document.getElementById("lb-img");';
    s += '    var lbTitle = document.getElementById("lb-title");';
    s += '    var lbZoomLabel = document.getElementById("lb-zoom-label");';
    s += '    var current = 0, scale = 1, panX = 0, panY = 0, dragging = false, dragStart = null;';
    s += '    function applyTransform() { lbImg.style.transform = "translate(" + panX + "px," + panY + "px) scale(" + scale + ")"; lbZoomLabel.textContent = Math.round(scale * 100) + "%"; }';
    s += '    function openAt(i) {';
    s += '      current = i; var t = thumbs[i]; if (!t) return;';
    s += '      lbImg.src = t.dataset.src;';
    s += '      var lbl = t.querySelector(".thumb-label"), tm = t.querySelector(".thumb-time");';
    s += '      lbTitle.textContent = (lbl ? lbl.textContent : "") + " - " + (tm ? tm.textContent : "");';
    s += '      scale = 1; panX = 0; panY = 0; applyTransform();';
    s += '      lb.classList.add("open"); lb.setAttribute("aria-hidden", "false");';
    s += '      if (window.__jumpToFrame) window.__jumpToFrame(i);';
    s += '    }';
    s += '    function close() { lb.classList.remove("open"); lb.setAttribute("aria-hidden", "true"); lbImg.src = ""; }';
    s += '    function zoom(d) { scale = Math.max(0.1, Math.min(8, scale + d)); applyTransform(); }';
    s += '    function reset() { scale = 1; panX = 0; panY = 0; applyTransform(); }';
    s += '    function goNext() { if (current < thumbs.length - 1) openAt(current + 1); }';
    s += '    function goPrev() { if (current > 0) openAt(current - 1); }';
    s += '    thumbs.forEach(function(t, i){ t.addEventListener("click", function(){ openAt(i); }); });';
    s += '    document.getElementById("lb-close").addEventListener("click", close);';
    s += '    document.getElementById("lb-zoom-in").addEventListener("click", function(){ zoom(0.25); });';
    s += '    document.getElementById("lb-zoom-out").addEventListener("click", function(){ zoom(-0.25); });';
    s += '    document.getElementById("lb-zoom-reset").addEventListener("click", reset);';
    s += '    document.getElementById("lb-prev").addEventListener("click", goPrev);';
    s += '    document.getElementById("lb-next").addEventListener("click", goNext);';
    s += '    lbStage.addEventListener("wheel", function(e){ if (!lb.classList.contains("open")) return; e.preventDefault(); zoom(e.deltaY < 0 ? 0.15 : -0.15); }, { passive: false });';
    s += '    lbImg.addEventListener("mousedown", function(e){ if (scale <= 1) return; dragging = true; dragStart = { x: e.clientX - panX, y: e.clientY - panY }; lbImg.style.cursor = "grabbing"; });';
    s += '    window.addEventListener("mousemove", function(e){ if (!dragging) return; panX = e.clientX - dragStart.x; panY = e.clientY - dragStart.y; applyTransform(); });';
    s += '    window.addEventListener("mouseup", function(){ dragging = false; lbImg.style.cursor = scale > 1 ? "grab" : "default"; });';
    s += '    document.addEventListener("keydown", function(e){';
    s += '      if (!lb.classList.contains("open")) return;';
    s += '      if (e.key === "Escape") close();';
    s += '      else if (e.key === "+" || e.key === "=") zoom(0.25);';
    s += '      else if (e.key === "-" || e.key === "_") zoom(-0.25);';
    s += '      else if (e.key === "0") reset();';
    s += '      else if (e.key === "ArrowRight") goNext();';
    s += '      else if (e.key === "ArrowLeft") goPrev();';
    s += '    });';
    s += '    lbStage.addEventListener("click", function(e){ if (e.target === lbStage) close(); });';
    s += '  } catch (e) { console.error("Lightbox init failed:", e); }';
    s += '})();';
    s += '</script>';
    return s;
  }

  // ---- Health section (with clickable risk cards) ----
  function buildHealthHTML(health) {
    var h = '';
    h += '<div class="health-hero ' + health.verdictClass + '">';
    h += '  <div class="health-score-wrap">';
    h += '    <div class="health-score">' + health.score + '</div>';
    h += '    <div class="health-score-max">/100</div>';
    h += '  </div>';
    h += '  <div class="health-info">';
    h += '    <div class="health-verdict ' + health.verdictClass + '">' + health.verdictLabel + '</div>';
    h += '    <p class="health-sentence">' + escapeHtml(health.sentence) + '</p>';
    h += '    <div class="health-counts">';
    h += '      <span class="count crit">' + health.counts.critical + ' critical</span>';
    h += '      <span class="count high">' + health.counts.high + ' high</span>';
    h += '      <span class="count avg">' + health.counts.average + ' average</span>';
    h += '    </div>';
    h += '  </div>';
    h += '</div>';

    h += '<h2>Risk Factors</h2>';
    h += '<p style="color:#8b95a5;font-size:12px;margin-bottom:12px">Click any card to see the details behind the verdict.</p>';
    h += '<div class="risk-grid">';
    health.factors.forEach(function (f) {
      h += '<div class="risk-card ' + f.verdict + '" data-factor="' + f.id + '">';
      h += '  <div class="risk-header">';
      h += '    <span class="risk-name">' + escapeHtml(f.name) + '</span>';
      h += '    <span class="risk-weight ' + f.weight.toLowerCase() + '">' + f.weight + '</span>';
      h += '  </div>';
      h += '  <div class="risk-detail">' + escapeHtml(f.detail) + '</div>';
      h += '  <div class="risk-hint">Click to see details</div>';
      h += '</div>';
    });
    h += '</div>';

    health.factors.forEach(function (f) {
      h += '<div class="risk-drill" id="drill-' + f.id + '" hidden>';
      h += '  <div class="risk-drill-inner">';
      h += '    <div class="risk-drill-header">';
      h += '      <h3>' + escapeHtml(f.name) + ' — details</h3>';
      h += '      <button class="risk-drill-close" type="button">Close</button>';
      h += '    </div>';
      h += '    <div class="risk-drill-body">' + buildFactorDetail(f) + '</div>';
      h += '  </div>';
      h += '</div>';
    });

    if (health.recommendations.length) {
      h += '<h2>Recommendations</h2>';
      h += '<ol class="recommendations">';
      health.recommendations.forEach(function (r) { h += '<li>' + escapeHtml(r) + '</li>'; });
      h += '</ol>';
    }

    return h;
  }

  function buildFactorDetail(f) {
    var data = f.data || [];
    var h = '';

    if (f.id === 'vitals') {
      h += '<table><thead><tr><th>Metric</th><th>Value</th><th>Target</th><th>Verdict</th></tr></thead><tbody>';
      data.forEach(function (v) {
        var cls = v.verdict === 'good' ? 'good' : v.verdict === 'warn' ? 'warn' : 'bad';
        var label = v.verdict === 'good' ? 'GOOD' : v.verdict === 'warn' ? 'WARN' : 'POOR';
        h += '<tr>';
        h += '<td><strong>' + v.name + '</strong></td>';
        h += '<td class="' + cls + '" style="font-family:ui-monospace,monospace;font-weight:600">' + (v.value == null ? '-' : (Math.round(v.value * 100) / 100) + v.unit) + '</td>';
        h += '<td style="color:#8b95a5;font-size:11px">≤ ' + v.good + v.unit + '</td>';
        h += '<td><span class="badge ' + (v.verdict === 'good' ? 'ok' : 'err') + '">' + label + '</span></td>';
        h += '</tr>';
      });
      h += '</tbody></table>';
    } else if (f.id === 'apiSpeed') {
      if (!data.length) { h += '<p class="empty-note">No API calls exceeded 1 second.</p>'; }
      else {
        h += '<p style="color:#8b95a5;font-size:12px;margin-bottom:10px">Showing the ' + data.length + ' slowest API call' + (data.length > 1 ? 's' : '') + ':</p>';
        h += '<table><thead><tr><th>Duration</th><th>Method</th><th>Status</th><th>URL</th><th>Size</th></tr></thead><tbody>';
        data.forEach(function (n) {
          var badge = n.failed ? '<span class="badge err">FAIL</span>' : (n.status >= 400 ? '<span class="badge err">' + n.status + '</span>' : '<span class="badge ok">' + (n.status || '-') + '</span>');
          var rowCls = n.durationMs > 2000 ? 'style="background:rgba(239,68,68,.06)"' : (n.durationMs > 1000 ? 'style="background:rgba(245,158,11,.06)"' : '');
          h += '<tr ' + rowCls + '>';
          h += '<td class="' + (n.durationMs > 1000 ? 'warn' : '') + '" style="font-family:ui-monospace,monospace;font-weight:600">' + n.durationMs + ' ms</td>';
          h += '<td>' + escapeHtml(n.method) + '</td>';
          h += '<td>' + badge + '</td>';
          h += '<td style="font-size:11px;word-break:break-all"><a href="' + escapeHtml(n.url) + '" target="_blank" rel="noopener" style="color:#4f8ef7;text-decoration:none">' + escapeHtml(shortPath(n.url)) + '</a></td>';
          h += '<td style="font-size:11px;color:#8b95a5">' + Math.round((n.encodedDataLength || 0) / 1024) + ' KB</td>';
          h += '</tr>';
        });
        h += '</tbody></table>';
      }
    } else if (f.id === 'failures') {
      if (!data.length) { h += '<p class="empty-note">No failed requests.</p>'; }
      else {
        h += '<table><thead><tr><th>Time</th><th>Status</th><th>URL</th><th>Error</th></tr></thead><tbody>';
        data.forEach(function (n) {
          var badge = '<span class="badge err">' + (n.failed ? 'FAIL' : n.status) + '</span>';
          h += '<tr>';
          h += '<td class="time">' + new Date(n.epoch).toLocaleTimeString() + '</td>';
          h += '<td>' + badge + '</td>';
          h += '<td style="font-size:11px;word-break:break-all">' + escapeHtml(shortPath(n.url)) + '</td>';
          h += '<td style="font-size:11px;color:#fca5a5">' + escapeHtml(n.errorText || n.statusText || '-') + '</td>';
          h += '</tr>';
        });
        h += '</tbody></table>';
      }
    } else if (f.id === 'console') {
      if (!data.length) { h += '<p class="empty-note">No console errors.</p>'; }
      else {
        h += '<table><thead><tr><th>Time</th><th>Level</th><th>Message</th></tr></thead><tbody>';
        data.forEach(function (c) {
          h += '<tr>';
          h += '<td class="time">' + new Date(c.timestamp).toLocaleTimeString() + '</td>';
          h += '<td><span class="badge err">' + escapeHtml(c.level) + '</span></td>';
          h += '<td style="font-family:monospace;font-size:11px;word-break:break-word">' + escapeHtml((c.message || '').slice(0, 300)) + '</td>';
          h += '</tr>';
        });
        h += '</tbody></table>';
      }
    } else if (f.id === 'memory') {
      if (!data.length) { h += '<p class="empty-note">No memory samples.</p>'; }
      else {
        h += '<table><thead><tr><th>Time</th><th>JS Heap (MB)</th><th>Nodes</th><th>Documents</th></tr></thead><tbody>';
        data.slice(-30).forEach(function (m) {
          var cls = m.heapMB > 100 ? 'bad' : m.heapMB > 50 ? 'warn' : 'good';
          h += '<tr>';
          h += '<td class="time">' + new Date(m.timestamp).toLocaleTimeString() + '</td>';
          h += '<td class="' + cls + '" style="font-family:ui-monospace,monospace;font-weight:600">' + m.heapMB.toFixed(1) + '</td>';
          h += '<td>' + (m.nodes || '-') + '</td>';
          h += '<td>' + (m.documents || '-') + '</td>';
          h += '</tr>';
        });
        h += '</tbody></table>';
        h += '<p class="empty-note" style="margin-top:8px">Showing last 30 samples.</p>';
      }
    } else if (f.id === 'dom') {
      if (!data.length) { h += '<p class="empty-note">No DOM samples.</p>'; }
      else {
        h += '<table><thead><tr><th>Time</th><th>Nodes</th><th>Documents</th></tr></thead><tbody>';
        data.slice(-30).forEach(function (m) {
          var cls = m.nodes > 5000 ? 'bad' : m.nodes > 3000 ? 'warn' : 'good';
          h += '<tr>';
          h += '<td class="time">' + new Date(m.timestamp).toLocaleTimeString() + '</td>';
          h += '<td class="' + cls + '" style="font-family:ui-monospace,monospace;font-weight:600">' + (m.nodes || 0).toLocaleString() + '</td>';
          h += '<td>' + (m.documents || '-') + '</td>';
          h += '</tr>';
        });
        h += '</tbody></table>';
      }
    } else if (f.id === 'longTasks') {
      if (!data.length) { h += '<p class="empty-note">No long tasks detected.</p>'; }
      else {
        h += '<table><thead><tr><th>Time</th><th>Duration</th><th>Severity</th></tr></thead><tbody>';
        data.forEach(function (t) {
          var cls = t.duration > 500 ? 'bad' : t.duration > 200 ? 'warn' : '';
          var sev = t.duration > 500 ? 'HIGH' : t.duration > 200 ? 'AVERAGE' : 'LOW';
          h += '<tr>';
          h += '<td class="time">' + new Date(t.timestamp).toLocaleTimeString() + '</td>';
          h += '<td class="' + cls + '" style="font-family:ui-monospace,monospace;font-weight:600">' + Math.round(t.duration) + ' ms</td>';
          h += '<td><span class="badge ' + (cls === 'bad' ? 'err' : cls === 'warn' ? 'redirect' : 'ok') + '">' + sev + '</span></td>';
          h += '</tr>';
        });
        h += '</tbody></table>';
      }
    } else {
      h += '<p class="empty-note">No details available.</p>';
    }

    return h;
  }

  // ---- Main HTML ----
  function buildSelfContainedHTML(report, health) {
    var embedded = {};
    for (var k in report) {
      if (k !== 'screenshots') embedded[k] = report[k];
    }
    embedded.health = health;
    var dataB64 = safeJSONBase64(embedded);
    var shots = report.screenshots || [];
    var recName = (report.meta && report.meta.name) || 'recording';

    var head = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />';
    head += '<title>Perf-Trace-Pulse Report - ' + escapeHtml(recName) + '</title>';
    head += '<style>';
    head += '*{box-sizing:border-box;margin:0;padding:0}';
    head += 'body{font-family:Inter,-apple-system,sans-serif;background:#0a0d12;color:#e6edf3;padding:24px;line-height:1.5}';
    head += 'h1{font-size:24px;margin-bottom:6px;background:linear-gradient(90deg,#4f8ef7,#a855f7);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}';
    head += 'h2{font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#8b95a5;margin:28px 0 12px;font-weight:600}';
    head += '.meta{color:#8b95a5;font-size:13px;margin-bottom:16px}';
    head += '#diag{background:#12171f;border-left:3px solid #4f8ef7;padding:10px 14px;border-radius:4px;font-family:ui-monospace,monospace;font-size:12px;color:#8b95a5;margin-bottom:20px;white-space:pre-wrap;word-break:break-all}';
    head += '#diag.err{border-left-color:#ef4444;color:#fca5a5}#diag.ok{border-left-color:#22c55e;color:#86efac}';

    head += '.health-hero{display:grid;grid-template-columns:auto 1fr;gap:24px;align-items:center;padding:24px;border-radius:14px;margin-bottom:20px;border:2px solid;position:relative;overflow:hidden}';
    head += '.health-hero::before{content:"";position:absolute;inset:0;opacity:.12;background:radial-gradient(circle at top right,currentColor,transparent 60%)}';
    head += '.health-hero.healthy{border-color:#22c55e;background:linear-gradient(135deg,rgba(34,197,94,.08),rgba(34,197,94,.02));color:#22c55e}';
    head += '.health-hero.average{border-color:#4f8ef7;background:linear-gradient(135deg,rgba(79,142,247,.08),rgba(79,142,247,.02));color:#4f8ef7}';
    head += '.health-hero.high{border-color:#f59e0b;background:linear-gradient(135deg,rgba(245,158,11,.08),rgba(245,158,11,.02));color:#f59e0b}';
    head += '.health-hero.critical{border-color:#ef4444;background:linear-gradient(135deg,rgba(239,68,68,.08),rgba(239,68,68,.02));color:#ef4444}';
    head += '.health-score-wrap{display:flex;align-items:baseline;position:relative;z-index:1}';
    head += '.health-score{font-size:64px;font-weight:800;line-height:1;font-family:ui-monospace,monospace;color:inherit}';
    head += '.health-score-max{font-size:18px;margin-left:6px;color:#8b95a5;font-family:ui-monospace,monospace}';
    head += '.health-info{position:relative;z-index:1}';
    head += '.health-verdict{font-size:28px;font-weight:800;letter-spacing:1px;color:inherit;margin-bottom:6px}';
    head += '.health-sentence{color:#e6edf3;font-size:14px;margin-bottom:12px;max-width:600px}';
    head += '.health-counts{display:flex;gap:8px;flex-wrap:wrap}';
    head += '.count{display:inline-block;padding:4px 10px;border-radius:5px;font-size:11px;font-weight:600}';
    head += '.count.crit{background:#7f1d1d;color:#fca5a5}.count.high{background:#78350f;color:#fcd34d}.count.avg{background:#1e3a8a;color:#93c5fd}';

    head += '.risk-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-bottom:8px}';
    head += '.risk-card{background:#12171f;border:1px solid #1f2632;border-radius:10px;padding:14px;border-left:4px solid #4f8ef7;transition:transform .12s,border-color .15s;cursor:pointer}';
    head += '.risk-card:hover{transform:translateY(-2px);border-color:#4f8ef7}';
    head += '.risk-card.good{border-left-color:#22c55e}.risk-card.warn{border-left-color:#f59e0b}.risk-card.bad{border-left-color:#ef4444}';
    head += '.risk-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:8px}';
    head += '.risk-name{font-size:13px;font-weight:600;color:#e6edf3}';
    head += '.risk-weight{font-size:9px;font-weight:700;letter-spacing:.5px;padding:2px 7px;border-radius:3px}';
    head += '.risk-weight.good{background:#14532d;color:#86efac}.risk-weight.average{background:#1e3a8a;color:#93c5fd}';
    head += '.risk-weight.high{background:#78350f;color:#fcd34d}.risk-weight.critical{background:#7f1d1d;color:#fca5a5}';
    head += '.risk-detail{color:#8b95a5;font-size:12px}';
    head += '.risk-hint{margin-top:8px;font-size:10px;color:#4f8ef7;opacity:.7;font-weight:600;letter-spacing:.5px;text-transform:uppercase}';
    head += '.risk-card:hover .risk-hint{opacity:1}';

    head += '.risk-drill{margin-top:16px;background:#12171f;border:1px solid #1f2632;border-radius:10px;padding:18px}';
    head += '.risk-drill-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #1f2632}';
    head += '.risk-drill-header h3{font-size:15px;color:#e6edf3;font-weight:600}';
    head += '.risk-drill-close{background:#1f2632;color:#e6edf3;border:none;border-radius:6px;padding:6px 14px;font-size:12px;cursor:pointer;font-family:inherit}';
    head += '.risk-drill-close:hover{background:#2a3444}';
    head += '.empty-note{color:#8b95a5;font-style:italic;font-size:12px}';

    head += '.show-more-row td{text-align:center;padding:16px;background:transparent;border-bottom:none}';
    head += '.show-more-btn{background:#1f2632;color:#e6edf3;border:1px solid #2a3444;border-radius:6px;padding:8px 20px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;transition:background .15s,border-color .15s}';
    head += '.show-more-btn:hover{background:#2a3444;border-color:#4f8ef7;color:#4f8ef7}';

    head += '.recommendations{background:#12171f;border:1px solid #1f2632;border-radius:10px;padding:16px 16px 16px 36px}';
    head += '.recommendations li{color:#e6edf3;font-size:13px;padding:6px 0;line-height:1.5}';
    head += '.recommendations li::marker{color:#4f8ef7;font-weight:700}';

    head += '.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}';
    head += '.card{background:#12171f;border:1px solid #1f2632;border-radius:10px;padding:16px}';
    head += '.card .label{font-size:11px;color:#8b95a5;text-transform:uppercase;letter-spacing:.5px}';
    head += '.card .value{font-size:22px;font-weight:700;margin-top:6px;font-family:ui-monospace,monospace}';
    head += '.good{color:#22c55e}.warn{color:#f59e0b}.bad{color:#ef4444}';

    head += 'table{width:100%;border-collapse:collapse;font-size:13px}';
    head += 'th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #1a1f2a}';
    head += 'th{color:#8b95a5;font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap}';
    head += 'tr:hover td{background:#12171f}';
    head += 'td.time{white-space:nowrap;font-family:ui-monospace,monospace;font-size:12px;color:#8b95a5}';
    head += '.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600}';
    head += '.badge.ok{background:#14532d;color:#86efac}.badge.err{background:#7f1d1d;color:#fca5a5}';
    head += '.badge.redirect{background:#78350f;color:#fcd34d}.badge.info{background:#1e3a8a;color:#93c5fd}';

    head += '.tabs{display:flex;gap:4px;margin-bottom:14px;flex-wrap:wrap;border-bottom:1px solid #1f2632;padding-bottom:10px}';
    head += '.tab{padding:8px 16px;background:transparent;border:1px solid #1f2632;border-radius:6px;cursor:pointer;font-size:12px;user-select:none;color:#8b95a5;transition:all .15s}';
    head += '.tab:hover{background:#12171f;color:#e6edf3}';
    head += '.tab.active{background:#4f8ef7;border-color:#4f8ef7;color:#fff;font-weight:600}';
    head += '.tab-content{display:none}.tab-content.active{display:block}';
    head += '.footer{margin-top:48px;color:#4a5568;font-size:11px;text-align:center}';

    head += 'pre{background:#0a0d12;padding:16px;border-radius:8px;overflow:auto;max-height:600px;font-size:12px;border:1px solid #1f2632}';

    head += 'tr.net-row{cursor:pointer}tr.net-row.expanded td{background:#12171f}';
    head += 'tr.net-row td:first-child::before{content:"\\25B8 ";color:#4f8ef7;font-size:10px;margin-right:4px}';
    head += 'tr.net-row.expanded td:first-child::before{content:"\\25BE "}';
    head += 'tr.net-detail-row > td{padding:0;border-bottom:1px solid #1f2632}';
    head += 'tr.action-row{cursor:pointer}tr.action-row.expanded td{background:#12171f}';
    head += 'tr.action-row td:first-child::before{content:"\\25B8 ";color:#4f8ef7;font-size:10px;margin-right:4px}';
    head += 'tr.action-row.expanded td:first-child::before{content:"\\25BE "}';
    head += 'tr.action-detail-row > td{padding:0;border-bottom:1px solid #1f2632}';

    head += '.net-detail,.action-detail{background:#0a0d12;padding:18px;font-size:12px;line-height:1.6}';
    head += '.net-detail h4,.action-detail h4{font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:#8b95a5;margin:14px 0 8px;font-weight:600}';
    head += '.net-detail h4:first-child,.action-detail h4:first-child{margin-top:0}';
    head += '.net-detail pre,.action-detail pre{background:#12171f;border:1px solid #1f2632;padding:12px;border-radius:6px;max-height:280px;font-size:11px;font-family:ui-monospace,monospace;white-space:pre-wrap;word-break:break-all}';
    head += '.net-detail .kv,.action-detail .kv{display:grid;grid-template-columns:150px 1fr;gap:8px;font-size:12px;margin-bottom:8px}';
    head += '.net-detail .kv .k,.action-detail .kv .k{color:#8b95a5}';
    head += '.net-detail .kv .v,.action-detail .kv .v{font-family:ui-monospace,monospace;word-break:break-all}';
    head += '.net-actions,.action-actions{margin-top:14px;display:flex;gap:8px;flex-wrap:wrap}';
    head += '.net-actions a,.net-actions button,.action-actions a,.action-actions button{background:#4f8ef7;color:#fff;padding:8px 16px;border:none;border-radius:6px;text-decoration:none;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;display:inline-block;transition:background .15s}';
    head += '.net-actions a:hover,.net-actions button:hover{background:#3b7be0}';
    head += '.net-actions .secondary,.action-actions .secondary{background:#1f2632;color:#e6edf3}';
    head += '.net-actions .secondary:hover{background:#2a3444}';
    head += '.net-actions .curl,.action-actions .curl{background:#16a34a}';
    head += '.net-actions .curl:hover{background:#15803d}';
    head += '.timing-bar{height:22px;background:#1f2632;border-radius:4px;overflow:hidden;display:flex;margin:8px 0}';
    head += '.timing-bar > div{height:100%}.timing-bar .wait{background:#ef4444}.timing-bar .other{background:#4f8ef7}';

    head += '.linked-api{display:grid;grid-template-columns:auto auto auto 1fr auto;gap:12px;align-items:center;padding:10px 12px;background:#12171f;border:1px solid #1f2632;border-radius:6px;margin-bottom:8px;cursor:pointer;transition:all .15s}';
    head += '.linked-api:hover{border-color:#4f8ef7;background:#161e2c}';
    head += '.linked-api-time{font-family:ui-monospace,monospace;font-size:11px;color:#8b95a5}';
    head += '.linked-api-method{font-weight:600;font-size:11px;color:#e6edf3}';
    head += '.linked-api-url{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#4f8ef7}';
    head += '.linked-api-dur{font-family:ui-monospace,monospace;font-size:11px;color:#8b95a5;text-align:right}';
    head += '.linked-api-dur.slow{color:#f59e0b;font-weight:600}';
    head += '.no-apis{color:#8b95a5;font-style:italic;font-size:12px}';
    head += '.api-count{display:inline-block;background:#1e3a8a;color:#93c5fd;padding:2px 8px;border-radius:4px;font-size:10px;font-weight:600}';
    head += '.api-count.none{background:#1f2632;color:#8b95a5}';

    head += '.player{background:#0a0d12;border:1px solid #1f2632;border-radius:12px;overflow:hidden}';
    head += '.player-stage{position:relative;background:#000;display:flex;align-items:center;justify-content:center;min-height:360px;max-height:70vh}';
    head += '.player-stage img{max-width:100%;max-height:70vh;display:block}';
    head += '.player-overlay{position:absolute;top:12px;left:12px;right:12px;pointer-events:none;display:flex;flex-direction:column;gap:4px}';
    head += '.player-label{display:inline-block;align-self:flex-start;background:rgba(79,142,247,.92);color:#fff;font-size:12px;font-weight:600;padding:5px 12px;border-radius:6px;font-family:ui-monospace,monospace}';
    head += '.player-detail{display:inline-block;align-self:flex-start;background:rgba(10,13,18,.9);color:#e6edf3;font-size:12px;padding:5px 12px;border-radius:6px;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}';
    head += '.player-controls{display:flex;align-items:center;gap:8px;padding:12px 14px;background:#12171f;flex-wrap:wrap}';
    head += '.player-btn{background:#1f2632;color:#e6edf3;border:none;border-radius:6px;padding:8px 14px;font-size:14px;cursor:pointer;font-family:inherit;transition:background .15s}';
    head += '.player-btn:hover{background:#2a3444}.player-btn-primary{background:#4f8ef7;color:#fff;min-width:52px}';
    head += '.player-btn-primary:hover{background:#3b7be0}';
    head += '.player-scrubber{flex:1;min-width:180px;accent-color:#4f8ef7}';
    head += '.player-counter{font-family:ui-monospace,monospace;font-size:12px;color:#8b95a5;min-width:70px;text-align:right}';
    head += '.player-speed{font-size:12px;color:#8b95a5;display:flex;align-items:center;gap:6px}';
    head += '.player-speed select{background:#0a0d12;color:#e6edf3;border:1px solid #1f2632;padding:4px 8px;border-radius:6px;font-size:12px}';
    head += '.player-time{font-family:ui-monospace,monospace;font-size:11px;color:#8b95a5}';

    head += '.attachments-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px}';
    head += '.thumb{background:#12171f;border:1px solid #1f2632;border-radius:10px;overflow:hidden;cursor:zoom-in;transition:border-color .15s,transform .12s}';
    head += '.thumb:hover{border-color:#4f8ef7;transform:translateY(-2px)}';
    head += '.thumb.current{border-color:#4f8ef7;box-shadow:0 0 0 2px rgba(79,142,247,.35)}';
    head += '.thumb img{width:100%;aspect-ratio:16/10;object-fit:cover;display:block;background:#000}';
    head += '.thumb-info{padding:8px 10px;font-size:11px}';
    head += '.thumb-label{font-weight:600;color:#e6edf3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}';
    head += '.thumb-time{color:#8b95a5;font-family:ui-monospace,monospace;font-size:10px;margin-top:2px}';

    head += '.lightbox{display:none;position:fixed;inset:0;background:rgba(0,0,0,.95);z-index:9999;flex-direction:column}';
    head += '.lightbox.open{display:flex}';
    head += '.lightbox-bar{display:flex;align-items:center;gap:6px;padding:12px 16px;background:#12171f;border-bottom:1px solid #1f2632}';
    head += '.lightbox-title{font-size:12px;color:#e6edf3;font-family:ui-monospace,monospace;max-width:40%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}';
    head += '.lightbox-spacer{flex:1}';
    head += '.lb-btn{background:#1f2632;color:#e6edf3;border:none;border-radius:6px;padding:8px 14px;font-size:14px;cursor:pointer;min-width:42px;transition:background .15s}';
    head += '.lb-btn:hover{background:#2a3444}';
    head += '.lb-close{background:#7f1d1d;color:#fca5a5}.lb-close:hover{background:#991b1b}';
    head += '.lb-zoom-label{font-family:ui-monospace,monospace;font-size:12px;color:#8b95a5;min-width:52px;text-align:center}';
    head += '.lightbox-stage{flex:1;overflow:hidden;display:flex;align-items:center;justify-content:center;padding:20px}';
    head += '.lightbox-stage img{max-width:100%;max-height:100%;user-select:none;transform-origin:center center;transition:transform .12s ease}';

    head += '.api-modal{display:none;position:fixed;inset:0;z-index:10000;align-items:center;justify-content:center;padding:24px}';
    head += '.api-modal.open{display:flex}';
    head += '.api-modal-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.9)}';
    head += '.api-modal-dialog{position:relative;background:#0a0d12;border:1px solid #1f2632;border-radius:12px;width:100%;max-width:920px;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.8)}';
    head += '.api-modal-bar{display:flex;align-items:center;gap:8px;padding:12px 16px;background:#12171f;border-bottom:1px solid #1f2632;border-radius:12px 12px 0 0}';
    head += '.api-modal-title{font-size:13px;font-weight:600;color:#e6edf3}';
    head += '.api-modal-spacer{flex:1}';
    head += '.api-modal-body{overflow:auto;background:#0a0d12;border-radius:0 0 12px 12px}';

    head += '.toast{position:fixed;bottom:32px;left:50%;transform:translateX(-50%) translateY(20px);background:#16a34a;color:#fff;padding:12px 24px;border-radius:8px;font-size:13px;font-weight:600;z-index:20000;opacity:0;transition:all .2s;pointer-events:none;box-shadow:0 8px 30px rgba(0,0,0,.5)}';
    head += '.toast.show{opacity:1;transform:translateX(-50%) translateY(0)}';
    head += '</style></head><body>';

    var body = '';
    body += '<h1>Perf-Trace-Pulse Report</h1>';
    body += '<p id="meta" class="meta"></p>';
    body += '<div id="diag">Loading report data...</div>';
    body += buildHealthHTML(health);

    body += '<h2>Web Vitals</h2><div class="cards" id="vitals"></div>';
    body += '<h2>Summary</h2><div class="cards" id="summary"></div>';

    body += '<div class="tabs" id="tabs" style="margin-top:32px">';
    body += '  <div class="tab active" data-tab="timeline">Timeline</div>';
    body += '  <div class="tab" data-tab="actions">Actions</div>';
    body += '  <div class="tab" data-tab="network">Network</div>';
    body += '  <div class="tab" data-tab="console">Console</div>';
    body += '  <div class="tab" data-tab="memory">Memory</div>';
    body += '  <div class="tab" data-tab="attachments">Attachments</div>';
    body += '  <div class="tab" data-tab="raw">Raw JSON</div>';
    body += '</div>';

    body += '<div id="tab-timeline" class="tab-content active">';
    body += '  <p style="color:#8b95a5;font-size:12px;margin-bottom:10px">Chronological view of every action, navigation, request, error in time order.</p>';
    body += '  <table><thead><tr><th>Time</th><th>Rel</th><th>Kind</th><th>Details</th><th>Duration</th></tr></thead><tbody id="timeline-body"></tbody></table>';
    body += '</div>';

    body += '<div id="tab-actions" class="tab-content">';
    body += '  <p style="color:#8b95a5;font-size:12px;margin-bottom:10px">Click any row to see the APIs it triggered. Click an API for full detail with Copy as cURL.</p>';
    body += '  <table><thead><tr><th>Time</th><th>Rel</th><th>Duration</th><th>Type</th><th>Target</th><th>APIs</th></tr></thead><tbody id="actions-body"></tbody></table>';
    body += '</div>';

    body += '<div id="tab-network" class="tab-content">';
    body += '<p style="color:#8b95a5;font-size:12px;margin-bottom:10px">Click any row to expand. Use Copy as cURL to reproduce in Postman.</p>';
    body += '<table><thead><tr><th>Time</th><th>Rel</th><th>Duration</th><th>Method</th><th>Status</th><th>URL</th><th>Size</th></tr></thead><tbody id="network-body"></tbody></table>';
    body += '</div>';

    body += '<div id="tab-console" class="tab-content">';
    body += '<p style="color:#8b95a5;font-size:12px;margin-bottom:10px">All errors and warnings captured during the session.</p>';
    body += '<table><thead><tr><th>Time</th><th>Rel</th><th>Level</th><th>Message</th></tr></thead><tbody id="console-body"></tbody></table>';
    body += '</div>';

    body += '<div id="tab-memory" class="tab-content"><table><thead><tr><th>Time</th><th>Rel</th><th>JS Heap (MB)</th><th>Nodes</th><th>Documents</th></tr></thead><tbody id="memory-body"></tbody></table></div>';

    body += '<div id="tab-attachments" class="tab-content">';
    body += '  <p style="color:#8b95a5;font-size:12px;margin-bottom:14px">Video evidence player and every captured screenshot. Click a thumbnail to zoom.</p>';
    body += '  <h2 style="margin-top:0">Video Evidence</h2>';
    body += buildPlayerHTML(report);
    body += '  <h2>All Screenshots (' + shots.length + ')</h2>';
    body += buildScreenshotsGridHTML(report);
    body += '</div>';

    body += '<div id="tab-raw" class="tab-content"><pre id="raw-json"></pre></div>';
    body += '<div class="footer">Generated by Perf-Trace-Pulse v2.3.0 - Apache 2.0</div>';

    body += '<div id="apiModal" class="api-modal">';
    body += '  <div id="apiModalBackdrop" class="api-modal-backdrop"></div>';
    body += '  <div class="api-modal-dialog">';
    body += '    <div class="api-modal-bar">';
    body += '      <span class="api-modal-title">API detail</span>';
    body += '      <span class="api-modal-spacer"></span>';
    body += '      <button id="apiModalClose" class="lb-btn lb-close" type="button">x</button>';
    body += '    </div>';
    body += '    <div id="apiModalBody" class="api-modal-body"></div>';
    body += '  </div>';
    body += '</div>';

    body += buildLightboxHTML();
    body += '<div id="toast" class="toast"></div>';
    body += '<div id="report-data" data-b64="' + dataB64 + '" style="display:none"></div>';

    body += '<script>';
    body += 'window.__perfDiag = function(msg, kind) { var el = document.getElementById("diag"); if (!el) return; el.textContent = String(msg); el.classList.remove("err","ok"); if (kind === "err") el.classList.add("err"); else if (kind === "ok") el.classList.add("ok"); };';
    body += 'window.__toast = function(msg) { var t = document.getElementById("toast"); if (!t) return; t.textContent = msg; t.classList.add("show"); setTimeout(function(){ t.classList.remove("show"); }, 1800); };';
    body += 'window.addEventListener("error", function(e) { try { window.__perfDiag("RUNTIME ERROR: " + (e.message || "unknown") + (e.lineno ? " (line " + e.lineno + ")" : ""), "err"); } catch (_) {} });';
    body += '</script>';

    var ms = '<script>';
    ms += '(function(){';
    ms += '  "use strict";';
    ms += '  function diag(m,k){ try { window.__perfDiag(m,k); } catch(_) {} }';
    ms += '  function toast(m){ try { window.__toast(m); } catch(_) {} }';

    // Tabs
    ms += '  try {';
    ms += '    document.querySelectorAll(".tab").forEach(function(t){';
    ms += '      t.addEventListener("click", function(){';
    ms += '        document.querySelectorAll(".tab").forEach(function(x){ x.classList.remove("active"); });';
    ms += '        document.querySelectorAll(".tab-content").forEach(function(x){ x.classList.remove("active"); });';
    ms += '        t.classList.add("active");';
    ms += '        var tgt = document.getElementById("tab-" + t.getAttribute("data-tab"));';
    ms += '        if (tgt) tgt.classList.add("active");';
    ms += '      });';
    ms += '    });';
    ms += '  } catch (e) {}';

    // Parse
    ms += '  var r = null;';
    ms += '  try {';
    ms += '    var holder = document.getElementById("report-data");';
    ms += '    var b64 = holder.getAttribute("data-b64");';
    ms += '    if (!b64) { diag("No report data", "err"); return; }';
    ms += '    var bin = atob(b64); var bytes = new Uint8Array(bin.length);';
    ms += '    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);';
    ms += '    r = JSON.parse(new TextDecoder().decode(bytes));';
    ms += '    var ac = (r.actions && r.actions.length) || 0;';
    ms += '    var nc = (r.network && r.network.length) || 0;';
    ms += '    var rn = (r.meta && r.meta.name) ? r.meta.name : "";';
    ms += '    var hv = (r.health && r.health.verdictLabel) || "UNKNOWN";';
    ms += '    diag("OK - " + (rn ? "["+rn+"] " : "") + ac + " actions, " + nc + " requests - verdict: " + hv, "ok");';
    ms += '  } catch (e) { diag("Failed: " + e.message, "err"); return; }';
    ms += '  if (!r) return;';
    ms += '  var START = (r.meta && r.meta.startedAt) || Date.now();';

    ms += '  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"\']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","\'":"&#39;"}[c]; }); }';
    ms += '  function wallClock(ms) { if (!ms) return "-"; var d = new Date(ms); return String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0")+":"+String(d.getSeconds()).padStart(2,"0")+"."+String(d.getMilliseconds()).padStart(3,"0"); }';
    ms += '  function relTime(ms) { if (!ms) return "-"; var d = ms - START; if (d < 0) return "-"; if (d < 1000) return "+"+d+"ms"; if (d < 60000) return "+"+(d/1000).toFixed(2)+"s"; return "+"+Math.floor(d/60000)+"m"+((d%60000)/1000).toFixed(1)+"s"; }';
    ms += '  function shortUrl(u) { try { var url = new URL(u); return url.host + "/" + url.pathname.split("/").slice(-2).join("/"); } catch (e) { return u; } }';
    ms += '  function fmtBytes(b) { if (!b) return "0 B"; if (b < 1024) return b + " B"; if (b < 1048576) return (b/1024).toFixed(1) + " KB"; return (b/1048576).toFixed(2) + " MB"; }';

    // Correlation
    ms += '  function isApiRequest(req){ var t = (req.type || "").toLowerCase(); if (t === "xhr" || t === "fetch" || t === "document") return true; if (req.mimeType && req.mimeType.indexOf("json") !== -1) return true; return false; }';
    ms += '  function correlateActions(actions, requests){ var map = {}; var sorted = actions.slice().sort(function(a,b){ return a.epoch - b.epoch; }); var apiReqs = requests.filter(isApiRequest); for (var ai = 0; ai < sorted.length; ai++) { var a = sorted[ai]; var nextEpoch = (ai+1 < sorted.length) ? sorted[ai+1].epoch : (a.epoch + 5000); var stopAt = Math.min(a.epoch + 3000, nextEpoch); var matched = []; for (var ri = 0; ri < apiReqs.length; ri++) { var req = apiReqs[ri]; if (req.epoch >= a.epoch && req.epoch < stopAt) matched.push(req); } map[a.id] = matched; } return map; }';
    ms += '  var actionAPIs = correlateActions(r.actions || [], r.network || []);';

    // Show-more helper
    ms += '  var DEFAULT_LIMIT = 20;';
    ms += '  function renderWithLimit(tbodyId, items, limit, colspan, label) {';
    ms += '    var tbody = document.getElementById(tbodyId);';
    ms += '    if (!tbody) return;';
    ms += '    tbody.innerHTML = "";';
    ms += '    var show = Math.min(limit, items.length);';
    ms += '    for (var i = 0; i < show; i++) tbody.insertAdjacentHTML("beforeend", items[i]);';
    ms += '    if (items.length > limit) {';
    ms += '      var remaining = items.length - limit;';
    ms += '      var tr = document.createElement("tr");';
    ms += '      tr.className = "show-more-row";';
    ms += '      tr.innerHTML = "<td colspan=\\"" + colspan + "\\"><button type=\\"button\\" class=\\"show-more-btn\\">Show " + remaining + " more " + label + " (" + items.length + " total)</button></td>";';
    ms += '      tbody.appendChild(tr);';
    ms += '      tr.querySelector("button").addEventListener("click", function() {';
    ms += '        for (var j = limit; j < items.length; j++) {';
    ms += '          tr.insertAdjacentHTML("beforebegin", items[j]);';
    ms += '        }';
    ms += '        tr.remove();';
    ms += '      });';
    ms += '    }';
    ms += '  }';

    // Meta
    ms += '  try {';
    ms += '    var metaName = (r.meta && r.meta.name) ? r.meta.name : "";';
    ms += '    document.getElementById("meta").textContent = (metaName ? metaName + " - " : "") + ((r.meta && r.meta.url) || "unknown") + " - " + (r.meta ? new Date(r.meta.startedAt).toLocaleString() : "") + " - " + (r.meta ? Math.round(r.meta.durationMs/1000) : 0) + "s";';
    ms += '    document.title = "Perf-Trace-Pulse Report - " + (metaName || "recording");';
    ms += '  } catch (e) {}';

    // Vitals
    ms += '  try {';
    ms += '    var s = r.summary || {};';
    ms += '    var v = [{n:"LCP",v:s.lcp,g:2500,w:4000,u:"ms"},{n:"FCP",v:s.fcp,g:1800,w:3000,u:"ms"},{n:"CLS",v:s.cls,g:0.1,w:0.25,u:""},{n:"INP",v:s.inp,g:200,w:500,u:"ms"},{n:"TTFB",v:s.ttfb,g:800,w:1800,u:"ms"}];';
    ms += '    document.getElementById("vitals").innerHTML = v.map(function(x){';
    ms += '      var c = x.v == null ? "" : x.v <= x.g ? "good" : x.v <= x.w ? "warn" : "bad";';
    ms += '      var vt = x.v == null ? "-" : x.v <= x.g ? "GOOD" : x.v <= x.w ? "WARN" : "POOR";';
    ms += '      var val = x.v == null ? "-" : (Math.round(x.v*100)/100) + x.u;';
    ms += '      return "<div class=\\"card\\"><div class=\\"label\\">"+x.n+"</div><div class=\\"value "+c+"\\">"+val+"</div><div style=\\"font-size:11px;margin-top:6px\\" class=\\""+c+"\\">"+vt+"</div></div>";';
    ms += '    }).join("");';
    ms += '  } catch (e) {}';

    // Summary
    ms += '  try {';
    ms += '    var s2 = r.summary || {};';
    ms += '    document.getElementById("summary").innerHTML = [';
    ms += '      {l:"Actions",v:s2.totalActions||0},{l:"Requests",v:s2.totalRequests||0},{l:"Failed",v:s2.failedRequests||0},';
    ms += '      {l:"Transfer",v:fmtBytes(s2.totalTransferBytes)},{l:"Errors",v:s2.totalErrors||0},{l:"Frames",v:s2.screenshotsCount||0},';
    ms += '      {l:"p50",v:(s2.p50||0)+" ms"},{l:"p95",v:(s2.p95||0)+" ms"}';
    ms += '    ].map(function(x){ return "<div class=\\"card\\"><div class=\\"label\\">"+x.l+"</div><div class=\\"value\\">"+x.v+"</div></div>"; }).join("");';
    ms += '  } catch (e) {}';

    // Risk drilldown
    ms += '  try {';
    ms += '    document.querySelectorAll(".risk-card").forEach(function(card){';
    ms += '      card.addEventListener("click", function(){';
    ms += '        var id = card.getAttribute("data-factor");';
    ms += '        var drill = document.getElementById("drill-" + id);';
    ms += '        if (!drill) return;';
    ms += '        var wasHidden = drill.hasAttribute("hidden");';
    ms += '        document.querySelectorAll(".risk-drill").forEach(function(d){ d.setAttribute("hidden", ""); });';
    ms += '        if (wasHidden) { drill.removeAttribute("hidden"); drill.scrollIntoView({ behavior: "smooth", block: "nearest" }); }';
    ms += '      });';
    ms += '    });';
    ms += '    document.querySelectorAll(".risk-drill-close").forEach(function(btn){';
    ms += '      btn.addEventListener("click", function(){';
    ms += '        var drill = btn.closest(".risk-drill");';
    ms += '        if (drill) drill.setAttribute("hidden", "");';
    ms += '      });';
    ms += '    });';
    ms += '  } catch (e) {}';

    // Timeline
    ms += '  try {';
    ms += '    var events = [];';
    ms += '    (r.navigations || []).forEach(function(n){ events.push({t:n.timestamp,kind:"nav-"+n.event,badge:"info",detail:n.url,duration:0}); });';
    ms += '    (r.actions || []).forEach(function(a){ events.push({t:a.epoch,kind:a.type,badge:"",detail:((a.target&&(a.target.text||a.target.selector))||"").slice(0,100),duration:a.duration||0}); });';
    ms += '    (r.network || []).forEach(function(n){ events.push({t:n.epoch,kind:"NET "+(n.method||""),badge:(n.failed||n.status>=400)?"err":"ok",detail:(n.status||"")+" "+shortUrl(n.url),duration:n.durationMs||0}); });';
    ms += '    (r.console || []).forEach(function(c){ if (c.level!=="error"&&c.level!=="uncaught"&&c.level!=="dialog"&&c.level!=="network-error"&&c.level!=="warning"&&c.level!=="warn") return; var b = (c.level==="warning"||c.level==="warn") ? "redirect" : "err"; events.push({t:c.timestamp,kind:"CONSOLE "+c.level,badge:b,detail:(c.message||"").slice(0,120),duration:0}); });';
    ms += '    events.sort(function(a,b){ return a.t - b.t; });';
    ms += '    var timelineItems = events.slice(0,800).map(function(e){';
    ms += '      var badge = e.badge ? "<span class=\\"badge "+e.badge+"\\">"+esc(e.kind)+"</span>" : esc(e.kind);';
    ms += '      return "<tr><td class=\\"time\\">"+wallClock(e.t)+"</td><td class=\\"time\\">"+relTime(e.t)+"</td><td>"+badge+"</td><td>"+esc(e.detail)+"</td><td>"+(e.duration?"<span class=\\""+(e.duration>1000?"warn":"")+"\\">"+e.duration+" ms</span>":"-")+"</td></tr>";';
    ms += '    });';
    ms += '    if (timelineItems.length === 0) {';
    ms += '      document.getElementById("timeline-body").innerHTML = "<tr><td colspan=\\"5\\" style=\\"color:#8b95a5\\">No events</td></tr>";';
    ms += '    } else {';
    ms += '      renderWithLimit("timeline-body", timelineItems, DEFAULT_LIMIT, 5, "events");';
    ms += '    }';
    ms += '  } catch (e) {}';

    // buildActionDetail
    ms += '  function buildActionDetail(a, apis){';
    ms += '    var h = "<div class=\\"action-detail\\">";';
    ms += '    h += "<h4>Action</h4>";';
    ms += '    h += "<div class=\\"kv\\"><span class=\\"k\\">Type</span><span class=\\"v\\">"+esc(a.type)+"</span></div>";';
    ms += '    h += "<div class=\\"kv\\"><span class=\\"k\\">Time</span><span class=\\"v\\">"+wallClock(a.epoch)+" ("+relTime(a.epoch)+")</span></div>";';
    ms += '    if (a.duration) h += "<div class=\\"kv\\"><span class=\\"k\\">Duration</span><span class=\\"v\\">"+a.duration+" ms</span></div>";';
    ms += '    if (a.target && a.target.selector) h += "<div class=\\"kv\\"><span class=\\"k\\">Selector</span><span class=\\"v\\">"+esc(a.target.selector)+"</span></div>";';
    ms += '    if (a.target && a.target.text) h += "<div class=\\"kv\\"><span class=\\"k\\">Text</span><span class=\\"v\\">"+esc(a.target.text)+"</span></div>";';
    ms += '    if (a.target && a.target.value) h += "<div class=\\"kv\\"><span class=\\"k\\">Value</span><span class=\\"v\\">"+esc(a.target.value)+"</span></div>";';
    ms += '    h += "<h4>APIs triggered by this action ("+apis.length+")</h4>";';
    ms += '    if (!apis.length) { h += "<p class=\\"no-apis\\">No API calls detected within 3 seconds after this action.</p>"; }';
    ms += '    else { apis.sort(function(x,y){ return x.epoch - y.epoch; }); apis.forEach(function(req, i){';
    ms += '      var durCls = req.durationMs > 1000 ? " slow" : "";';
    ms += '      var sb = req.failed ? "<span class=\\"badge err\\">FAIL</span>" : (req.status >= 400 ? "<span class=\\"badge err\\">"+req.status+"</span>" : (req.status >= 300 ? "<span class=\\"badge redirect\\">"+req.status+"</span>" : "<span class=\\"badge ok\\">"+req.status+"</span>"));';
    ms += '      h += "<div class=\\"linked-api\\" data-idx=\\""+i+"\\"><span class=\\"linked-api-time\\">"+wallClock(req.epoch)+"</span><span class=\\"linked-api-method\\">"+esc(req.method)+"</span>"+sb+"<span class=\\"linked-api-url\\" title=\\""+esc(req.url)+"\\">"+esc(req.url)+"</span><span class=\\"linked-api-dur"+durCls+"\\">"+(req.durationMs||0)+" ms</span></div>";';
    ms += '    }); }';
    ms += '    h += "</div>"; return h;';
    ms += '  }';

    // Actions
    ms += '  try {';
    ms += '    var actions = (r.actions || []).slice().sort(function(a,b){ return a.epoch - b.epoch; }).slice(0,300);';
    ms += '    var actionItems = [];';
    ms += '    actions.forEach(function(a, ai){';
    ms += '      var apis = actionAPIs[a.id] || [];';
    ms += '      var apiBadge = apis.length ? ("<span class=\\"api-count\\">"+apis.length+" API"+(apis.length>1?"s":"")+"</span>") : "<span class=\\"api-count none\\">-</span>";';
    ms += '      var pair = "<tr class=\\"action-row\\" data-aidx=\\""+ai+"\\"><td class=\\"time\\">"+wallClock(a.epoch)+"</td><td class=\\"time\\">"+relTime(a.epoch)+"</td><td class=\\""+(a.duration>1000?"warn":"")+"\\">"+(a.duration?a.duration+" ms":"-")+"</td><td>"+esc(a.type)+"</td><td>"+esc((a.target&&(a.target.text||a.target.selector))||"")+"</td><td>"+apiBadge+"</td></tr>";';
    ms += '      pair += "<tr class=\\"action-detail-row\\" data-adetail=\\""+ai+"\\" hidden><td colspan=\\"6\\">"+buildActionDetail(a, apis)+"</td></tr>";';
    ms += '      actionItems.push(pair);';
    ms += '    });';
    ms += '    if (actionItems.length === 0) {';
    ms += '      document.getElementById("actions-body").innerHTML = "<tr><td colspan=\\"6\\" style=\\"color:#8b95a5\\">No actions</td></tr>";';
    ms += '    } else {';
    ms += '      renderWithLimit("actions-body", actionItems, DEFAULT_LIMIT, 6, "actions");';
    ms += '    }';
    ms += '  } catch (e) {}';

    // buildNetDetail
    ms += '  function buildNetDetail(n) {';
    ms += '    try {';
    ms += '      var t = n.timing || {};';
    ms += '      var dns = t.dnsEnd && t.dnsStart ? Math.round((t.dnsEnd - t.dnsStart) * 1000) : 0;';
    ms += '      var connect = t.connectEnd && t.connectStart ? Math.round((t.connectEnd - t.connectStart) * 1000) : 0;';
    ms += '      var wait = n.durationMs ? Math.round(n.durationMs * 0.9) : 0;';
    ms += '      var download = Math.max(0, (n.durationMs || 0) - wait);';
    ms += '      var total = n.durationMs || 1;';
    ms += '      var reqHeaders = n.requestHeaders ? Object.keys(n.requestHeaders).map(function(k){ return k + ": " + n.requestHeaders[k]; }).join("\\n") : "(none)";';
    ms += '      var resHeaders = n.responseHeaders ? Object.keys(n.responseHeaders).map(function(k){ return k + ": " + n.responseHeaders[k]; }).join("\\n") : "(none)";';
    ms += '      var curlParts = [];';
    ms += '      curlParts.push("curl -X " + (n.method || "GET"));';
    ms += '      curlParts.push("\\"" + (n.url || "") + "\\"");';
    ms += '      if (n.requestHeaders) { Object.keys(n.requestHeaders).forEach(function(k){ var skip = ["content-length","host","connection","accept-encoding"]; if (skip.indexOf(k.toLowerCase()) !== -1) return; var v = String(n.requestHeaders[k]); if (v.indexOf(":") === 0) v = v.slice(1).trim(); curlParts.push("-H \\"" + k + ": " + v + "\\""); }); }';
    ms += '      if (n.postData) { curlParts.push("--data-raw \\"" + String(n.postData).replace(/"/g, "\\\\\\"") + "\\""); }';
    ms += '      var curlCmd = curlParts.join(" \\\\\\n  ");';
    ms += '      var bodyBlock = "";';
    ms += '      if (n.responseBody) {';
    ms += '        var display = n.responseBody;';
    ms += '        try { display = JSON.stringify(JSON.parse(n.responseBody), null, 2); } catch (_) {}';
    ms += '        bodyBlock = "<h4>Response body</h4><pre>" + esc(display.slice(0, 20000)) + "</pre>";';
    ms += '      } else if (n.mimeType && n.mimeType.indexOf("json") === -1 && n.mimeType.indexOf("text") === -1) {';
    ms += '        bodyBlock = "<h4>Response body</h4><pre style=\\"color:#8b95a5\\">Binary (" + esc(n.mimeType) + ") - not captured</pre>";';
    ms += '      } else {';
    ms += '        bodyBlock = "<h4>Response body</h4><pre style=\\"color:#8b95a5\\">(not captured - may be empty)</pre>";';
    ms += '      }';
    ms += '      var h = "<div class=\\"net-detail\\">";';
    ms += '      h += "<h4>Request</h4>";';
    ms += '      h += "<div class=\\"kv\\"><span class=\\"k\\">Method</span><span class=\\"v\\">"+esc(n.method)+"</span></div>";';
    ms += '      h += "<div class=\\"kv\\"><span class=\\"k\\">Full URL</span><span class=\\"v\\" style=\\"user-select:all\\">"+esc(n.url)+"</span></div>";';
    ms += '      h += "<div class=\\"kv\\"><span class=\\"k\\">Type</span><span class=\\"v\\">"+esc(n.type||"-")+"</span></div>";';
    ms += '      h += "<h4>Request headers</h4><pre>"+esc(reqHeaders)+"</pre>";';
    ms += '      if (n.postData) h += "<h4>Request body</h4><pre>"+esc(n.postData.slice(0, 10000))+"</pre>";';
    ms += '      h += "<h4>Response</h4>";';
    ms += '      h += "<div class=\\"kv\\"><span class=\\"k\\">Status code</span><span class=\\"v\\">"+(n.status||"-")+" "+esc(n.statusText||"")+"</span></div>";';
    ms += '      h += "<div class=\\"kv\\"><span class=\\"k\\">MIME type</span><span class=\\"v\\">"+esc(n.mimeType||"-")+"</span></div>";';
    ms += '      h += "<div class=\\"kv\\"><span class=\\"k\\">Transfer size</span><span class=\\"v\\">"+fmtBytes(n.encodedDataLength)+"</span></div>";';
    ms += '      h += "<div class=\\"kv\\"><span class=\\"k\\">Cached</span><span class=\\"v\\">"+(n.fromCache?"yes":"no")+"</span></div>";';
    ms += '      if (n.failed) h += "<div class=\\"kv\\"><span class=\\"k\\">Error</span><span class=\\"v\\" style=\\"color:#ef4444\\">"+esc(n.errorText||"failed")+"</span></div>";';
    ms += '      h += "<h4>Response headers</h4><pre>"+esc(resHeaders)+"</pre>";';
    ms += '      h += bodyBlock;';
    ms += '      h += "<h4>Timing ("+(n.durationMs||0)+" ms total)</h4>";';
    ms += '      h += "<div class=\\"timing-bar\\"><div class=\\"other\\" style=\\"width:"+((dns+connect)/total*100)+"%\\"></div><div class=\\"wait\\" style=\\"width:"+(wait/total*100)+"%\\"></div><div class=\\"other\\" style=\\"width:"+(download/total*100)+"%\\"></div></div>";';
    ms += '      h += "<div style=\\"display:flex;justify-content:space-between;font-size:11px;color:#8b95a5\\"><span>DNS+Connect: "+(dns+connect)+" ms</span><span>Waiting: "+wait+" ms</span><span>Download: "+download+" ms</span></div>";';
    ms += '      h += "<div class=\\"net-actions\\">";';
    ms += '      h += "<button type=\\"button\\" class=\\"curl\\" data-curl=\\""+esc(curlCmd)+"\\">Copy as cURL (Postman)</button>";';
    ms += '      h += "<button type=\\"button\\" class=\\"secondary copy-url\\" data-url=\\""+esc(n.url)+"\\">Copy URL</button>";';
    ms += '      h += "<a href=\\""+esc(n.url)+"\\" target=\\"_blank\\" rel=\\"noopener\\" class=\\"secondary\\">Open in browser</a>";';
    ms += '      h += "</div>";';
    ms += '      h += "<p style=\\"color:#f59e0b;font-size:11px;margin-top:12px;border-left:3px solid #f59e0b;padding-left:10px\\"><strong>Note:</strong> If Postman returns a different status code (e.g. 401), the session has expired. Copy current cookies from DevTools into Postman, or re-run while logged in.</p>";';
    ms += '      h += "</div>"; return h;';
    ms += '    } catch (e) { return "<div class=\\"net-detail\\" style=\\"color:#ef4444\\">Error: " + esc(e.message) + "</div>"; }';
    ms += '  }';

    // Network
    ms += '  try {';
    ms += '    var nets = (r.network || []).slice().sort(function(a,b){ return (b.durationMs||0)-(a.durationMs||0); }).slice(0,400);';
    ms += '    var netItems = [];';
    ms += '    nets.forEach(function(n, i){';
    ms += '      var badge = n.failed ? "<span class=\\"badge err\\">FAIL</span>" : (n.status >= 400 ? "<span class=\\"badge err\\">"+n.status+"</span>" : (n.status >= 300 ? "<span class=\\"badge redirect\\">"+n.status+"</span>" : (n.status >= 200 ? "<span class=\\"badge ok\\">"+n.status+"</span>" : "<span class=\\"badge\\">-</span>")));';
    ms += '      var pair = "<tr class=\\"net-row\\" data-nidx=\\""+i+"\\"><td class=\\"time\\">"+wallClock(n.epoch)+"</td><td class=\\"time\\">"+relTime(n.epoch)+"</td><td class=\\""+(n.durationMs>1000?"warn":"")+"\\">"+(n.durationMs||0)+" ms</td><td>"+esc(n.method)+"</td><td>"+badge+"</td><td style=\\"font-size:12px\\">"+esc(shortUrl(n.url))+"</td><td>"+fmtBytes(n.encodedDataLength)+"</td></tr>";';
    ms += '      pair += "<tr class=\\"net-detail-row\\" data-ndetail=\\""+i+"\\" hidden><td colspan=\\"7\\">"+buildNetDetail(n)+"</td></tr>";';
    ms += '      netItems.push(pair);';
    ms += '    });';
    ms += '    if (netItems.length === 0) {';
    ms += '      document.getElementById("network-body").innerHTML = "<tr><td colspan=\\"7\\" style=\\"color:#8b95a5\\">No requests</td></tr>";';
    ms += '    } else {';
    ms += '      renderWithLimit("network-body", netItems, DEFAULT_LIMIT, 7, "requests");';
    ms += '    }';
    ms += '  } catch (e) {}';

    // Copy handlers
    ms += '  document.addEventListener("click", function(e){';
    ms += '    var cb = e.target.closest ? e.target.closest("[data-curl]") : null;';
    ms += '    if (cb) { e.preventDefault(); e.stopPropagation(); navigator.clipboard.writeText(cb.getAttribute("data-curl")).then(function(){ toast("cURL copied"); }).catch(function(){ toast("Copy failed"); }); return; }';
    ms += '    var ub = e.target.closest ? e.target.closest(".copy-url") : null;';
    ms += '    if (ub) { e.preventDefault(); e.stopPropagation(); navigator.clipboard.writeText(ub.getAttribute("data-url")).then(function(){ toast("URL copied"); }).catch(function(){ toast("Copy failed"); }); return; }';
    ms += '  });';

    // Delegated row click for action / network / linked-api
    ms += '  document.addEventListener("click", function(e){';
    ms += '    var linked = e.target.closest ? e.target.closest(".linked-api") : null;';
    ms += '    if (linked) {';
    ms += '      e.stopPropagation();';
    ms += '      var rowL = linked.closest(".action-detail-row"); if (!rowL) return;';
    ms += '      var aiL = rowL.getAttribute("data-adetail");';
    ms += '      var aL = (r.actions||[]).slice().sort(function(x,y){ return x.epoch - y.epoch; })[parseInt(aiL,10)];';
    ms += '      if (!aL) return;';
    ms += '      var apisL = actionAPIs[aL.id] || [];';
    ms += '      var idxL = parseInt(linked.getAttribute("data-idx"), 10);';
    ms += '      var reqL = apisL[idxL]; if (!reqL) return;';
    ms += '      document.getElementById("apiModalBody").innerHTML = buildNetDetail(reqL);';
    ms += '      document.getElementById("apiModal").classList.add("open");';
    ms += '      return;';
    ms += '    }';
    ms += '    var actionRow = e.target.closest ? e.target.closest("tr.action-row") : null;';
    ms += '    if (actionRow) {';
    ms += '      var idxA = actionRow.getAttribute("data-aidx");';
    ms += '      var detailA = document.querySelector("tr.action-detail-row[data-adetail=\\""+idxA+"\\"]");';
    ms += '      if (!detailA) return;';
    ms += '      if (detailA.hasAttribute("hidden")) { detailA.removeAttribute("hidden"); actionRow.classList.add("expanded"); } else { detailA.setAttribute("hidden", ""); actionRow.classList.remove("expanded"); }';
    ms += '      return;';
    ms += '    }';
    ms += '    var netRow = e.target.closest ? e.target.closest("tr.net-row") : null;';
    ms += '    if (netRow) {';
    ms += '      if (e.target.closest && e.target.closest("button")) return;';
    ms += '      var idxN = netRow.getAttribute("data-nidx");';
    ms += '      var detailN = document.querySelector("tr.net-detail-row[data-ndetail=\\""+idxN+"\\"]");';
    ms += '      if (!detailN) return;';
    ms += '      if (detailN.hasAttribute("hidden")) { detailN.removeAttribute("hidden"); netRow.classList.add("expanded"); } else { detailN.setAttribute("hidden", ""); netRow.classList.remove("expanded"); }';
    ms += '      return;';
    ms += '    }';
    ms += '  });';

    // Modal close
    ms += '  try {';
    ms += '    var mc = document.getElementById("apiModalClose");';
    ms += '    if (mc) mc.addEventListener("click", function(){ document.getElementById("apiModal").classList.remove("open"); });';
    ms += '    var mb = document.getElementById("apiModalBackdrop");';
    ms += '    if (mb) mb.addEventListener("click", function(){ document.getElementById("apiModal").classList.remove("open"); });';
    ms += '    document.addEventListener("keydown", function(e){ if (e.key === "Escape") { var m = document.getElementById("apiModal"); if (m) m.classList.remove("open"); } });';
    ms += '  } catch (e) {}';

    // Console (now includes warnings)
    ms += '  try {';
    ms += '    var cons = (r.console||[]).filter(function(c){ return c.level==="error"||c.level==="uncaught"||c.level==="network-error"||c.level==="dialog"||c.level==="warning"||c.level==="warn"; }).slice(0,300);';
    ms += '    if (cons.length === 0) {';
    ms += '      document.getElementById("console-body").innerHTML = "<tr><td colspan=\\"4\\" style=\\"color:#8b95a5\\">No errors or warnings</td></tr>";';
    ms += '    } else {';
    ms += '      var consoleItems = cons.map(function(c){';
    ms += '        var cls = "err";';
    ms += '        if (c.level === "warning" || c.level === "warn") cls = "redirect";';
    ms += '        else if (c.level === "dialog") cls = "info";';
    ms += '        return "<tr><td class=\\"time\\">"+wallClock(c.timestamp)+"</td><td class=\\"time\\">"+relTime(c.timestamp)+"</td><td><span class=\\"badge "+cls+"\\">"+esc(c.level)+"</span></td><td style=\\"font-family:monospace;font-size:12px\\">"+esc((c.message||"").slice(0,500))+"</td></tr>";';
    ms += '      });';
    ms += '      renderWithLimit("console-body", consoleItems, DEFAULT_LIMIT, 4, "messages");';
    ms += '    }';
    ms += '  } catch (e) {}';

    // Memory
    ms += '  try {';
    ms += '    var mem = (r.memory||[]).slice(-200);';
    ms += '    if (mem.length === 0) {';
    ms += '      document.getElementById("memory-body").innerHTML = "<tr><td colspan=\\"5\\" style=\\"color:#8b95a5\\">No samples</td></tr>";';
    ms += '    } else {';
    ms += '      var memItems = mem.map(function(m){ return "<tr><td class=\\"time\\">"+wallClock(m.timestamp)+"</td><td class=\\"time\\">"+relTime(m.timestamp)+"</td><td>"+(m.jsHeapUsed?(m.jsHeapUsed/1048576).toFixed(1):"-")+"</td><td>"+(m.nodes||"-")+"</td><td>"+(m.documents||"-")+"</td></tr>"; });';
    ms += '      renderWithLimit("memory-body", memItems, DEFAULT_LIMIT, 5, "samples");';
    ms += '    }';
    ms += '  } catch (e) {}';

    ms += '  try { document.getElementById("raw-json").textContent = JSON.stringify(r, null, 2); } catch (e) {}';
    ms += '})();';
    ms += '</script>';

    return head + body + ms + buildLightboxScript() + '</body></html>';
  }

  // ---- summary.txt / README / HAR ----
  function buildSummaryTxt(r, health) {
    var s = r.summary || {};
    var recName = (r.meta && r.meta.name) || 'recording';
    function fmt(v, u, g, w) {
      if (v == null) return '-- (not captured)';
      return (Math.round(v * 100) / 100) + u + '  [' + (v <= g ? 'GOOD' : v <= w ? 'WARN' : 'POOR') + ']';
    }
    var lines = [
      'Perf-Trace-Pulse - Summary', '='.repeat(56), '',
      'Recording: ' + recName,
      'URL:       ' + ((r.meta && r.meta.url) || 'unknown'),
      'Started:   ' + (r.meta ? new Date(r.meta.startedAt).toLocaleString() : ''),
      'Duration:  ' + (r.meta ? Math.round(r.meta.durationMs / 1000) : 0) + ' seconds', '',
      '============================================================',
      'HEALTH VERDICT: ' + health.verdictLabel + '  (Score: ' + health.score + '/100)',
      '============================================================',
      health.sentence, '',
      'Risk factors:'
    ];
    health.factors.forEach(function (f) {
      lines.push('  [' + (f.weight + '        ').slice(0, 8) + ']  ' + f.name + ': ' + f.detail);
    });
    lines.push('');
    if (health.recommendations.length) {
      lines.push('Recommendations:');
      health.recommendations.forEach(function (rc) { lines.push('  - ' + rc); });
      lines.push('');
    }
    lines.push(
      '-- Web Vitals --------------------------------------',
      'LCP:  ' + fmt(s.lcp, 'ms', 2500, 4000),
      'FCP:  ' + fmt(s.fcp, 'ms', 1800, 3000),
      'CLS:  ' + fmt(s.cls, '', 0.1, 0.25),
      'INP:  ' + fmt(s.inp, 'ms', 200, 500),
      'TTFB: ' + fmt(s.ttfb, 'ms', 800, 1800), '',
      '-- Summary -----------------------------------------',
      'Actions:          ' + (s.totalActions || 0),
      'Requests:         ' + (s.totalRequests || 0),
      'Failed requests:  ' + (s.failedRequests || 0),
      'Total transfer:   ' + ((s.totalTransferBytes || 0) / 1024).toFixed(1) + ' KB',
      'Console errors:   ' + (s.totalErrors || 0),
      'Frames captured:  ' + (s.screenshotsCount || 0), '',
      'Open report.html for the full interactive report.'
    );
    return lines.join('\n');
  }

  function buildReadme() {
    return 'Perf-Trace-Pulse Report\n' +
      '=======================\n\n' +
      'Contents\n--------\n' +
      '  report.html        <- Open this first.\n' +
      '  report.json        <- Raw data + health verdict.\n' +
      '  report.har         <- Network-only.\n' +
      '  summary.txt        <- Plain-text summary with health verdict.\n' +
      '  screenshots/       <- Frames as JPEGs.\n' +
      '  README.txt         <- This file.\n\n' +
      'Highlights\n----------\n' +
      '  Health verdict    Automated Healthy / Average / High / Critical score.\n' +
      '  Risk drill-down   Click any risk card to see the offending rows.\n' +
      '  Attachments tab   Video + screenshots in one view.\n' +
      '  Actions tab       Click an action -> see APIs it triggered.\n' +
      '  Console tab       Errors and warnings with color-coded levels.\n' +
      '  Show more         Tables default to 20 rows; click for full list.\n' +
      '  Copy as cURL      Paste into Postman to reproduce.\n\n' +
      'License: Apache 2.0\n';
  }

  function buildHAR(report) {
    var entries = (report.network || []).map(function (r) {
      return {
        startedDateTime: new Date(r.epoch).toISOString(),
        time: r.durationMs || 0,
        request: {
          method: r.method, url: r.url, httpVersion: 'HTTP/1.1',
          headers: Object.keys(r.requestHeaders || {}).map(function (k) { return { name: k, value: String(r.requestHeaders[k]) }; }),
          queryString: [], cookies: [], headersSize: -1,
          bodySize: r.postData ? r.postData.length : -1,
          postData: r.postData ? { mimeType: '', text: r.postData } : undefined
        },
        response: {
          status: r.status || 0, statusText: r.statusText || '',
          httpVersion: r.protocol || 'HTTP/1.1',
          headers: Object.keys(r.responseHeaders || {}).map(function (k) { return { name: k, value: String(r.responseHeaders[k]) }; }),
          cookies: [],
          content: { size: r.encodedDataLength || 0, mimeType: r.mimeType || '', text: r.responseBody || '' },
          redirectURL: '', headersSize: -1, bodySize: r.encodedDataLength || -1
        },
        cache: {},
        timings: {
          blocked: -1,
          dns: r.timing && r.timing.dnsEnd && r.timing.dnsStart ? Math.round((r.timing.dnsEnd - r.timing.dnsStart) * 1000) : -1,
          connect: r.timing && r.timing.connectEnd && r.timing.connectStart ? Math.round((r.timing.connectEnd - r.timing.connectStart) * 1000) : -1,
          send: 0, wait: r.durationMs ? Math.round(r.durationMs * 0.9) : -1, receive: 0, ssl: -1
        },
        pageref: 'page_1'
      };
    });

    return {
      log: {
        version: '1.2',
        creator: { name: 'Perf-Trace-Pulse', version: '2.3.0' },
        pages: [{
          startedDateTime: new Date((report.meta && report.meta.startedAt) || Date.now()).toISOString(),
          id: 'page_1',
          title: (report.meta && report.meta.url) || 'unknown',
          pageTimings: {
            onContentLoad: (report.summary && report.summary.fcp) || -1,
            onLoad: (report.meta && report.meta.durationMs) || -1
          }
        }],
        entries: entries
      }
    };
  }

  async function downloadZipReport(report) {
    if (typeof JSZip === 'undefined') throw new Error('JSZip not loaded');

    var health = computeHealth(report);
    var zip = new JSZip();
    var recName = (report.meta && report.meta.name) || 'recording';
    var safeName = safeFilenameStem(recName);

    zip.file('report.html', buildSelfContainedHTML(report, health));

    var jsonReport = JSON.parse(JSON.stringify(report));
    jsonReport.health = health;
    zip.file('report.json', JSON.stringify(jsonReport, null, 2));

    zip.file('report.har', JSON.stringify(buildHAR(report), null, 2));
    zip.file('summary.txt', buildSummaryTxt(report, health));
    zip.file('README.txt', buildReadme());

    var shots = report.screenshots || [];
    if (shots.length) {
      var folder = zip.folder('screenshots');
      shots.forEach(function (s) {
        folder.file(s.id + '.jpg', base64ToUint8Array(s.data), { binary: true });
      });
    }

    var blob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 }
    });

    var url = URL.createObjectURL(blob);
    var filename = safeName + '.zip';
    await chrome.downloads.download({ url: url, filename: filename, saveAs: true });
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
    return { ok: true, filename: filename };
  }

  window.downloadZipReport = downloadZipReport;
})();