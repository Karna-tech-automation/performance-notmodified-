/**
 * Perf-Trace-Pulse — DevTools Panel registration
 */

'use strict';

chrome.devtools.panels.create(
  'Perf-Trace-Pulse',
  '',
  'src/panel.html',
  (panel) => {
    console.log('Perf-Trace-Pulse DevTools panel created');
  }
);