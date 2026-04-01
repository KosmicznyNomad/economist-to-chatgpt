# Iskra

Chrome extension (Manifest V3) for running the company-analysis chain in ChatGPT, storing final responses locally, and dispatching them to Watchlist.

## Current runtime
- Company flow only. The extension no longer documents or depends on the old article-selector/portfolio UI.
- Manual source flow supports pasted text and PDF-backed runs.
- Final responses are persisted locally and exposed in `responses.html`.
- Operational state is exposed in `process-monitor.html`.
- Runtime/process diagnostics are exposed in `problem-log.html`.
- Watchlist integration uses signed HTTPS requests with retry and verify.

## Main flows

Primary analysis flow:
`popup -> RUN_ANALYSIS -> processArticles -> injectToChat -> saveResponse -> response-storage.js -> responses.html`

Stage 12 view flow:
`saved response text -> decision-contract.js -> decision-view-model.js -> responses.html / process-monitor.html`

Watchlist dispatch flow:
`saveResponse -> enqueueWatchlistDispatch -> flushWatchlistDispatchOutbox -> POST /api/v1/intake/economist-response -> POST /api/v1/intake/economist-response/verify`

Remote problem-log flow:
`problem-log.html -> POST /api/v1/intake/problem-logs/query`

## Shared core files
- `decision-contract.js` - one source of truth for Stage 12 parsing, extraction, canonical text rebuild, and status validation (`current`, `shortfall`, `legacy`, `invalid`).
- `response-storage.js` - canonical read/write, dedupe, merge and migration helpers for responses.
- `decision-view-model.js` - UI-only Stage 12 view-model builder used by `responses.js` and `process-monitor.js`.
- `watchlist-api.js` - shared signed Watchlist request builder for remote problem-log query.
- `watchlist-dispatch-shape.js` - shared normalization for `decisionRecord`, `decisionRecords[]` and related dispatch payload shape.
- `problem-log-ui-shared.js` - shared UI helper for `REPORT_PROBLEM_LOG` payloads.

## Storage
- Canonical persisted responses: `chrome.storage.local.responses`
- Transitional cache/mirror: `chrome.storage.session.responses`
- Process monitor state: `chrome.storage.local.process_monitor_state`
- Watchlist dispatch queue/history:
  - `watchlist_dispatch_outbox`
  - `watchlist_dispatch_history`

The UI reads through shared storage helpers. Migration from legacy session-only responses is handled in the worker, not in page scripts.

## Stage 12 contract
- `current`: valid 2-line contract with `PRIMARY` then `SECONDARY`; current prompt emits 17 fields including `KPI Scorecard`
- `shortfall`: valid `PRIMARY` line plus trailing `# SHORTFALL: only 1 company passed Stage 10 gates`
- `legacy`: readable old format kept for compatibility-read only
- `invalid`: malformed or non-contract output

The dashboard and monitor should build Stage 12 state from `DecisionContractUtils.validateDecisionContractText(response.text)`, not from local heuristics.

## Watchlist integration
Configured intake endpoints:
- `POST /api/v1/intake/economist-response`
- `POST /api/v1/intake/economist-response/verify`
- `POST /api/v1/intake/problem-logs/query`
- `GET /api/v1/intake/problem-logs` remains a compatibility alias

Required auth headers:
- `X-Watchlist-Key-Id`
- `X-Watchlist-Timestamp`
- `X-Watchlist-Nonce`
- `X-Watchlist-Signature`

## Main files
- `manifest.json` - permissions, commands and worker registration
- `background.js` - orchestration, save path, dispatch, verify, heartbeat/recovery
- `popup.html` / `popup.js` - start/stop/resume, manual source, Watchlist config
- `manual-source.html` / `manual-source.js` - pasted/manual PDF sources
- `resume-stage.html` / `resume-stage.js` - resume company chain from selected stage
- `responses.html` / `responses.js` - local responses UI and Stage 12 market table
- `process-monitor.html` / `process-monitor.js` - operational process monitor with Stage 12 snapshot
- `problem-log.html` / `problem-log.js` - diagnostics view including remote problem logs
- `reload-resume-monitor.html` / `reload-resume-monitor.js` - monitored reload/resume workflow
- `unfinished-processes.html` / `unfinished-processes.js` - recovery helper for incomplete runs
- `prompts-company.txt` - active company prompt chain
- `COMPANY_CHAIN_STAGE_MAP.md` - readable stage map for the company chain

## Notes
- `prompts-portfolio.txt` may still exist in the repo as a legacy artifact; it is not part of the current documented runtime flow.
- Shared helper scripts are loaded by extension pages and the worker; the manifest no longer exposes them broadly via `web_accessible_resources`.

## Quick validation
1. `Get-ChildItem -Path . -Filter *.js -Recurse | ForEach-Object { node --check $_.FullName }`
2. `Get-ChildItem -Filter test-*.js | Sort-Object Name | ForEach-Object { node $_.FullName }`
3. `python -m pytest -q tests/test_intake_api.py tests/test_storage_backend.py`
