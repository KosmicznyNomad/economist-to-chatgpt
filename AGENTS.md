# AGENTS.md

## Project summary
- Iskra is a Chrome extension (Manifest V3) that runs the company-analysis prompt chain in ChatGPT.
- The service worker in `background.js` is the main orchestrator.
- Final responses are persisted locally, rendered in local views, and dispatched to Watchlist over signed HTTPS.
- Stage 12 semantics are centralized and must stay centralized.

## Current repo structure
- `manifest.json` - extension config, permissions, commands
- `background.js` - orchestration, save path, Watchlist dispatch/verify, alarms, recovery
- `popup.html` / `popup.js` - main control surface
- `manual-source.html` / `manual-source.js` - pasted text / PDF flow
- `resume-stage.html` / `resume-stage.js` - resume chain from chosen stage
- `responses.html` / `responses.js` - responses UI and Stage 12 market table
- `process-monitor.html` / `process-monitor.js` - operational monitor for running/completed processes
- `problem-log.html` / `problem-log.js` - runtime/process diagnostics
- `reload-resume-monitor.html` / `reload-resume-monitor.js` - monitored reload/resume flow
- `unfinished-processes.html` / `unfinished-processes.js` - incomplete-process recovery helper
- `decision-contract.js` - Stage 12 parser/validator/canonicalizer shared by worker and UI
- `response-storage.js` - shared response dedupe/storage/migration helpers
- `decision-view-model.js` - shared Stage 12 UI view-model helpers
- `watchlist-api.js` - shared signed request builder for remote problem-log query
- `watchlist-dispatch-shape.js` - shared Watchlist payload normalization
- `problem-log-ui-shared.js` - shared UI problem-log payload helper
- `prompts-company.txt` - active company prompt chain
- `COMPANY_CHAIN_STAGE_MAP.md` - readable company stage mapping

## Runtime flows

Primary analysis flow:
`popup -> RUN_ANALYSIS -> processArticles -> injectToChat -> saveResponse -> response-storage.js -> responses.html`

Dispatch flow:
`saveResponse -> enqueueWatchlistDispatch -> flushWatchlistDispatchOutbox -> Watchlist intake -> verify`

Problem-log flow:
`runtime/process issue -> REPORT_PROBLEM_LOG / background append -> problem-log.html`

Remote problem-log flow:
`problem-log.html -> watchlist-api.js -> POST /api/v1/intake/problem-logs/query`

Stage 12 render flow:
`response.text -> decision-contract.js -> decision-view-model.js -> responses/process-monitor`

## Stage 12 contract
- `current`: 2 lines, current prompt emits 17 fields each with trailing `KPI Scorecard`, `PRIMARY` then `SECONDARY`
- `shortfall`: 1 valid `PRIMARY` line plus shortfall marker
- `legacy`: old format accepted for compatibility-read only
- `invalid`: malformed or non-contract output

Rules:
- Do not duplicate Stage 12 parsing in UI or worker code.
- Use `DecisionContractUtils.validateDecisionContractText(...)` as the source for current Stage 12 state.
- `response.decisionContract` is a compact storage summary, not the only source for rich UI rendering.

## Storage model
- Canonical persisted responses: `chrome.storage.local.responses`
- Transitional cache/mirror: `chrome.storage.session.responses`
- Process monitor state: `chrome.storage.local.process_monitor_state`
- Dispatch queue/history:
  - `watchlist_dispatch_outbox`
  - `watchlist_dispatch_history`

Responses should go through `response-storage.js`. Do not add page-local migration or dedupe logic back into UI files.

## Watchlist integration
- Intake endpoint: `POST /api/v1/intake/economist-response`
- Verify endpoint: `POST /api/v1/intake/economist-response/verify`
- Problem-log query endpoint: `POST /api/v1/intake/problem-logs/query`
- Compatibility alias: `GET /api/v1/intake/problem-logs`

Shared helper ownership:
- Signed problem-log query URL/body/HMAC: `watchlist-api.js`
- Dispatch `decisionRecord` / `decisionRecords[]` shape: `watchlist-dispatch-shape.js`
- UI problem-log reporting payloads: `problem-log-ui-shared.js`

## Common change points
- Prompt/stage changes:
  - `prompts-company.txt`
  - `COMPANY_CHAIN_STAGE_MAP.md`
  - Stage metadata in `background.js`
- Stage 12 contract changes:
  - `decision-contract.js`
  - `decision-view-model.js`
  - targeted tests in `test-decision-contract.js`, `test-decision-view-model.js`, `test-dashboard-decision-contract-ui.js`
- Response storage/dedupe changes:
  - `response-storage.js`
  - worker save path in `background.js`
- Watchlist transport changes:
  - `watchlist-api.js`
  - `watchlist-dispatch-shape.js`
  - dispatch code in `background.js`
- Diagnostics UI changes:
  - `problem-log-ui-shared.js`
  - `popup.js`
  - `problem-log.js`
  - `process-monitor.js`

## Manual sanity checklist
- Run one company chain and confirm the response lands in `responses.html`.
- Confirm market table rows come from Stage 12 records and show role/composite/sizing.
- Confirm response cards show Stage 12 pair summary for `current` and `shortfall`.
- Open `process-monitor.html` and verify Stage 12 summary uses records, not asymmetry.
- Open `problem-log.html` and verify local + remote log refresh works.
- Trigger Watchlist dispatch and verify queue/history updates.

## Automated quick checks
- `Get-ChildItem -Path . -Filter *.js -Recurse | ForEach-Object { node --check $_.FullName }`
- `Get-ChildItem -Filter test-*.js | Sort-Object Name | ForEach-Object { node $_.FullName }`
- `python -m pytest -q tests/test_intake_api.py tests/test_storage_backend.py`
