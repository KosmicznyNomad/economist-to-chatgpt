# News to ChatGPT

Chrome extension (Manifest V3) that extracts content from open tabs and runs multi-stage prompt chains in ChatGPT.

## What it does
- Extracts text from supported news pages and YouTube transcripts.
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
- `responses.js` - responses view, copy/clear, storage migration.
- `youtube-content.js` - transcript extraction for YouTube.
- `prompts-company.txt` / `prompts-portfolio.txt` - prompt chains.

## Storage
- Responses are written in worker to `chrome.storage.session.responses`.
- `responses.js` migrates and merges data to `chrome.storage.local.responses`.
- Process monitor snapshot is stored in `chrome.storage.local.process_monitor_state`.

## Prompt chains
- Prompt separator: `◄PROMPT_SEPARATOR►`.
- Prompt #1 is payload template with `{{articlecontent}}`.
- Remaining prompts are executed as chain in ChatGPT.
- Only final chain response is persisted.

## Install (unpacked)
1. Open `chrome://extensions/`.
2. Enable `Developer mode`.
3. Click `Load unpacked`.
4. Select `economist-to-chatgpt` folder.

## Use
### Web tab flow
1. Open supported article/video tabs.
2. Click extension icon (`Ctrl+Shift+E`).
3. Choose tabs for portfolio analysis.
4. Let both flows run.

### Manual source flow
1. Open popup.
2. Open manual source dialog.
3. Paste title and text.
4. Start selected number of instances.

### Responses view
- Open from popup or shortcut `Ctrl+Shift+R`.
- Copy single response or copy all by analysis type.

## Supported source updates
Keep these in sync when adding/removing domains:
- `manifest.json` host permissions
- `SUPPORTED_SOURCES` in `background.js`
- `extractText()` selectors for source-specific parsing

## Notes
- `background.js` is the central runtime file and contains most of automation/recovery logic.
- Keep `STAGE_NAMES_COMPANY` aligned with company prompt order/count.
- `content-script.js` is a separate Google Sheets bridge and not the main response storage path.
- Backend and GitHub relay components were removed from this repository.
