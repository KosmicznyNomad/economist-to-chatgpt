# Iskra

Chrome extension (Manifest V3) that extracts content from open tabs and runs multi-stage prompt chains in ChatGPT.

## What it does
- Extracts text from supported news pages, Spotify transcripts, open Gmail emails, and YouTube transcripts.
- Runs two flows:
  - `company` on all supported tabs.
  - `portfolio` on selected tabs.
- Automates ChatGPT stage-by-stage with retries and resume support.
- Saves final chain responses locally.

## Current runtime flow
`popup -> RUN_ANALYSIS -> processArticles -> injectToChat -> saveResponse -> responses.html`

## Main files
- `manifest.json` - permissions and service worker registration.
- `background.js` - core orchestration and ChatGPT automation.
- `popup.js` - run, stop, resume and navigation.
- `process-monitor.js` - process control panel.
- `problem-log.js` - diagnostics panel for runtime/process errors.
- `responses.js` - responses view, copy/clear, storage migration.
- `reload-resume-monitor.js` - monitored reload+resume workflow.
- `youtube-content.js` - transcript extraction for YouTube.
- `prompts-company.txt` / `prompts-portfolio.txt` - prompt chains.
- `COMPANY_CHAIN_STAGE_MAP.md` - readable stage contract for `prompts-company.txt` + runtime mapping.

## Storage
- Responses are written in worker to `chrome.storage.session.responses`.
- `responses.js` migrates and merges data to `chrome.storage.local.responses`.
- Process monitor snapshot is stored in `chrome.storage.local.process_monitor_state`.

## Prompt chains
- Prompt separator: `◄PROMPT_SEPARATOR►`.
- Prompt #1 is payload template with `{{articlecontent}}`.
- Remaining prompts are executed as chain in ChatGPT.
- Only final chain response is persisted.
- Company stage labels/descriptions are served from `STAGE_METADATA_COMPANY` (`background.js`) and documented in `COMPANY_CHAIN_STAGE_MAP.md`.

## Install (unpacked)
1. Open `chrome://extensions/`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select `economist-to-chatgpt` folder.

## Use
### Web tab flow
1. Open supported article/video/email tabs (for Gmail: open the specific email first).
2. Click extension icon (`Ctrl+Shift+E`).
3. Choose tabs for portfolio analysis.
4. Let both flows run.

### YouTube transcript copy (one click)
1. Open a YouTube video tab.
2. Open popup and click `Kopiuj transkrypcje (YouTube)`.
3. Transcript is copied to clipboard immediately (without running ChatGPT chain).

Transcript fetch behavior:
- Language priority: `pl` -> `en` -> next available track.
- Within preferred language, manual captions are preferred over auto-generated (`asr`) tracks.
- Fetch order: `json3` -> `srv3` -> default XML.
- If content script is missing in an already-open YouTube tab, worker attempts runtime re-injection and retries automatically.
- Short-lived transcript cache (`videoId + languages`) reduces duplicate fetches across repeated runs/copy actions.
- If a video has no captions, popup shows a controlled error instead of fallbacking to external API.

### Manual source flow
1. Open popup.
2. Open manual source dialog.
3. Paste title and text, or attach one/many PDF files.
4. Start selected number of instances.

Manual PDF mode behavior:
- If at least one PDF is selected, text field is ignored.
- Each PDF is processed as a separate run (separate ChatGPT window).
- Instances multiply each file (e.g. 2 files and 3 instances = 6 runs).
- PDF queue runs with controlled parallelism (up to 3 workers).
- Keep `Wklej zrodlo` window open during PDF queue. It provides PDF chunks to active runs.

### Responses view
- Open from popup or shortcut `Ctrl+Shift+R`.
- Copy single response or copy all by analysis type.

### Problem log view
- Open from popup (`Problem log` button).
- Review runtime/process issues with stage/status/reason context.
- Use refresh and clear controls to validate recovery after fixes.
- Use `Zdalne` to fetch remote problem logs from Watchlist intake API (HMAC auth, optional `Support ID` filter).

### Watchlist intake setup
1. Open popup -> `Watchlist intake`.
2. Set `Intake URL`, `Key ID`, `Secret`.
3. Save credentials and trigger flush.
4. Worker sends `economist.response.v1` directly over HTTPS with HMAC headers and outbox retry.

If current network blocks direct access to Watchlist HTTPS endpoint, start local SSH tunnel and use local intake URL:
- tunnel: `ssh -N -L 18080:127.0.0.1:8080 iskierka`
- intake URL: `http://127.0.0.1:18080/api/v1/intake/economist-response`

## Supported source updates
Keep these in sync when adding/removing domains:
- `manifest.json` host permissions
- `SUPPORTED_SOURCES` in `background.js`
- `extractText()` selectors for source-specific parsing

## Notes
- `background.js` is the central runtime file and contains most of automation/recovery logic.
- Keep `STAGE_NAMES_COMPANY` aligned with company prompt order/count.
- `content-script.js` is a separate Google Sheets bridge and not the main response storage path.
- Watchlist integration uses direct HTTPS intake (`POST /api/v1/intake/economist-response`) with HMAC headers and outbox/retry in extension worker.
- Process monitor uses periodic heartbeat sweep (`chrome.alarms`) with stale TTL warnings to improve near-live remote state visibility.
- YouTube transcript support is best-effort and depends on caption availability for a given video.
- On restart/restore flows, ChatGPT tabs are automatically ungrouped from Chrome tab groups to keep workflow tabs independent.

## Quick validation (before commit)
1. JS syntax:
   `Get-ChildItem -Filter *.js | ForEach-Object { node --check $_.FullName }`
2. Manifest JSON validity:
   `python -c "import json; json.load(open('manifest.json', encoding='utf-8')); print('manifest ok')"`
3. Manual smoke:
   - run one company chain and confirm response in `responses.html`
   - open `problem-log.html` and verify refresh/clear behavior


