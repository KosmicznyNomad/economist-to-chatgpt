# Key Files Reference

Quick navigation for the current Iskra architecture.

## Core runtime
- `manifest.json` - extension config, commands, worker registration
- `background.js` - orchestration, ChatGPT automation, save path, dispatch, verify, recovery
- `prompts-company.txt` - active company prompt chain
- `COMPANY_CHAIN_STAGE_MAP.md` - readable stage map for the company chain

## Shared core
- `decision-contract.js`
  - Stage 12 line parsing
  - record extraction
  - canonical text rebuild
  - current-contract validation
  - status scoring (`current`, `shortfall`, `legacy`, `invalid`)
- `response-storage.js`
  - canonical response read/write
  - dedupe identity
  - merge rules
  - session -> local migration
- `decision-view-model.js`
  - validated Stage 12 state for UI
  - market table rows (`1 row per record`)
  - pair summary for response cards
- `watchlist-api.js`
  - signed request builder for remote problem-log query
- `watchlist-dispatch-shape.js`
  - normalized dispatch shape for `decisionRecord` and `decisionRecords[]`
- `problem-log-ui-shared.js`
  - shared `REPORT_PROBLEM_LOG` payload builder for UI pages

## Main UI surfaces
- `popup.html` / `popup.js` - start/stop/resume, manual source, Watchlist config
- `manual-source.html` / `manual-source.js` - pasted/manual PDF source input
- `resume-stage.html` / `resume-stage.js` - resume from selected company stage
- `responses.html` / `responses.js` - responses view and Stage 12 market table
- `process-monitor.html` / `process-monitor.js` - operational monitor with Stage 12 snapshot
- `problem-log.html` / `problem-log.js` - diagnostics and remote problem-log query
- `reload-resume-monitor.html` / `reload-resume-monitor.js` - monitored reload/resume workflow
- `unfinished-processes.html` / `unfinished-processes.js` - incomplete-run recovery helper

## Canonical flows

Primary save flow:
`background.js -> saveResponse() -> response-storage.js -> chrome.storage.local.responses`

Stage 12 render flow:
`response.text -> decision-contract.js -> decision-view-model.js -> responses.js / process-monitor.js`

Dispatch flow:
`background.js -> watchlist-dispatch-shape.js -> POST /api/v1/intake/economist-response -> POST /api/v1/intake/economist-response/verify`

Remote problem-log flow:
`problem-log.js / audit-problem-logs.js -> watchlist-api.js -> POST /api/v1/intake/problem-logs/query`

## Storage keys
- `responses` in `chrome.storage.local` - canonical persisted responses
- `responses` in `chrome.storage.session` - transitional mirror/cache
- `process_monitor_state` in `chrome.storage.local`
- `watchlist_dispatch_outbox` in `chrome.storage.local`
- `watchlist_dispatch_history` in `chrome.storage.local`

## Stage 12 status meanings
- `current` - valid 2-line contract
- `shortfall` - valid 1-line contract with shortfall marker
- `legacy` - old readable format, compatibility-read only
- `invalid` - malformed/non-contract response

## Current Watchlist endpoints
- `POST /api/v1/intake/economist-response`
- `POST /api/v1/intake/economist-response/verify`
- `POST /api/v1/intake/problem-logs/query`
- `GET /api/v1/intake/problem-logs` as compatibility alias

## Tests worth opening first
- `test-decision-contract.js`
- `test-response-storage.js`
- `test-decision-view-model.js`
- `test-dashboard-decision-contract-ui.js`
- `test-watchlist-api.js`
- `test-watchlist-dispatch-shape.js`
- `test-watchlist-dispatch-decision-contract.js`
- `../tests/test_intake_api.py`
- `../tests/test_storage_backend.py`

## Legacy notes
- `prompts-portfolio.txt` may still exist in the repo, but it is not part of the current documented runtime.
- Old references such as `article-selector.*`, `youtube-content.js`, `ARCHITECTURE_OVERVIEW.md` and `RESPONSE_SAVING_FLOWCHART.md` are not part of the current active architecture and should not be reintroduced in docs without restoring real runtime support.
