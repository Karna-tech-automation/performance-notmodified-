# Perf-Trace-Pulse

An open-source-inspired browser performance recorder that captures web performance metrics, analyzes traces, and generates downloadable reports.

Perf-Trace-Pulse captures everything a QA engineer or web performance tester needs in a single recording session — user actions, network requests, console errors, Web Vitals, screenshots, and video — and exports it all as a self-contained ZIP report that anyone can open.

## Features

- **User actions** — clicks, inputs, changes, submissions, scrolls, SPA route changes, keypresses, drags
- **Network capture** — every request with method, status, headers, body, timing breakdown
- **Console & errors** — logs, warnings, uncaught exceptions, native dialogs, network failures
- **Web Vitals** — LCP, FCP, CLS, INP, TTFB with color-coded verdicts
- **Memory & CPU** — sampled every 2 seconds via Chrome DevTools Protocol
- **Screenshots** — automatic capture on actions, navigation, errors, and modals
- **Frame player** — scrub through the session frame by frame with play/pause/speed controls
- **Timeline view** — chronological stream of every event with millisecond precision
- **Network detail panel** — expand any request to see headers, body, and timing bars
- **Zoomable attachments** — lightbox viewer with zoom, pan, and keyboard shortcuts

## Export Format

Each recording produces a `.zip` file containing:

- `report.html` — self-contained interactive report (open in any browser)
- `report.json` — raw structured data for automation
- `report.har` — network-only HAR for Chrome DevTools import
- `summary.txt` — plain-text summary
- `video.webm` — full session recording
- `screenshots/` — all captured frames as JPEGs
- `README.txt` — how-to-open instructions

Recipients just unzip and double-click `report.html`. No install, no internet, no extension required.

## Installation

1. Clone this repository
2. Open `chrome://extensions/`
3. Enable **Developer mode**
4. Click **Load unpacked** → select the project folder

## Usage

1. Click the Perf-Trace-Pulse icon → side panel opens
2. Type a name for the recording
3. Click **Start Recording** — the page reloads for a clean baseline
4. Interact with the page as a normal user
5. Click **Stop Recording**
6. Click **📦 Download Report (.zip)** → share the ZIP with anyone

## License

Apache License 2.0 — see the `LICENSE` file for details.

## Acknowledgments

This project was inspired by the architecture and design patterns of [Playwright Trace Recorder Crx](https://github.com/GeorgeSutaru/Playwright-Trace-Recorder-Crx) (Apache 2.0). The core Chrome extension structure, side panel layout, and debugger attachment flow were informed by that project. All performance-specific features — Web Vitals capture, timeline view, frame player, network detail panel, screenshot system, ZIP export, and report viewer — were built from scratch for this tool.