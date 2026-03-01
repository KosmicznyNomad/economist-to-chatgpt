# AGENTS.md

## Project summary
- Chrome extension (Manifest V3) that extracts article/transcript text and runs prompt chains in ChatGPT.
- Main orchestrator: `background.js` service worker.
- Two analysis modes:
  - `company` for all supported tabs.
  - `portfolio` only for tabs selected in article selector.
- Auto-restore/recovery loop is built in (every 5 minutes when enabled; default state is OFF unless explicitly enabled).

## Repo structure (current)
- `manifest.json` - extension configuration, permissions and global commands.
- `background.js` - runtime orchestration: prompt loading, extraction, ChatGPT automation, process monitor state, response save, Watchlist dispatch, auto-restore cycle.
- `popup.html` / `popup.js` - run, stop, resume, manual source, monitor/responses navigation, dispatch controls, auto-restore controls.
- `article-selector.html` / `article-selector.js` - portfolio selection.
- `manual-source.html` / `manual-source.js` - pseudo-source submission (text + manual PDF provider).
- `resume-stage.html` / `resume-stage.js` - resume company chain from selected stage.
- `process-monitor.html` / `process-monitor.js` - process panel and decisions.
- `problem-log.html` / `problem-log.js` - diagnostics panel for runtime/process issues.
- `responses.html` / `responses.js` - local responses UI with copy/clear.
- `reload-resume-monitor.html` / `reload-resume-monitor.js` - monitored reload+resume workflow.
- `youtube-content.js` - YouTube transcript capture and fetch.
- `content-script.js` - separate Google Sheets bridge.
- `prompts-company.txt` / `prompts-portfolio.txt` - prompt chains split by `◄PROMPT_SEPARATOR►`.
- `COMPANY_CHAIN_STAGE_MAP.md` - stage-by-stage readable mapping for company chain (prompt index <-> stage id/name/description).

## Runtime flows

Primary analysis flow:
`popup -> RUN_ANALYSIS -> processArticles -> injectToChat -> saveResponse -> responses.html`

Dispatch flow:
`saveResponse -> enqueueWatchlistDispatch -> flushWatchlistDispatchOutbox -> Watchlist Intake API`

Problem diagnostics flow:
`runtime/process issues -> problem log append in background -> problem-log.html`

Auto-restore flow:
`chrome.alarms(auto-restore-process-windows) -> runAutoRestoreWindowsCycle -> restoreProcessWindows -> health check -> optional scan/resume`

Process heartbeat flow (near-live Watchlist state):
`chrome.alarms(process-monitor-heartbeat) -> runProcessMonitorHeartbeatSweep -> appendProblemLog(process-monitor/process-monitor-heartbeat) -> enqueueProblemLogDispatch -> Watchlist intake`

Detailed analysis steps:
1. Worker scans supported tabs.
2. Text is extracted (`extractText` for web, `GET_TRANSCRIPT` for YouTube).
3. Prompt #1 receives `{{articlecontent}}` payload.
4. Remaining prompts are executed in ChatGPT.
5. Final chain response is saved and then dispatched to Watchlist intake queue.

Manual PDF flow:
1. `manual-source.js` sends `MANUAL_SOURCE_SUBMIT` with `mode='pdf'` and file metadata.
2. Provider keepalive port (`manual-pdf-provider:<providerId>`) is started by manual source window.
3. Worker builds queue (`files x instances`) and runs items in separate ChatGPT windows with controlled parallelism.
4. Injected `injectToChat()` requests chunks via `MANUAL_PDF_GET_CHUNK`.
5. Worker forwards to provider message `MANUAL_PDF_PROVIDER_READ_CHUNK`.
6. ChatGPT receives actual file attachment before payload send.

## Storage model
- Responses writer path (`background.js`): `chrome.storage.session.responses`.
- Responses reader path (`responses.js`): migration and merge into `chrome.storage.local.responses`.
- Process monitor state: `chrome.storage.local.process_monitor_state`.
- Watchlist dispatch queue/history:
  - `watchlist_dispatch_outbox`
  - `watchlist_dispatch_history`
- Auto-restore state:
  - enabled flag: `auto_restore_windows_enabled`
  - last diagnostics cycle: `auto_restore_windows_last_cycle`

Response fields in use:
- `text`
- `timestamp`
- `source`
- `analysisType`
- `responseId`
- optional `runId`
- optional `stage` (object; e.g. selection metadata for the saved response)
- optional `conversationUrl` (string; URL to the ChatGPT conversation)

## Prompt/stage alignment
- Separator token: `◄PROMPT_SEPARATOR►`.
- Company stage metadata is maintained in `STAGE_METADATA_COMPANY` in `background.js`.
- Backward-compatible names list is derived from it (`STAGE_NAMES_COMPANY`).
- Keep metadata order/count aligned with `prompts-company.txt` and documented map in `COMPANY_CHAIN_STAGE_MAP.md`.

## Monitor and decisions
- `process-monitor.js` subscribes to process updates and can send:
  - `PROCESS_DECISION`
  - `PROCESS_DECISION_ALL`
  - resume actions for next stage
- Needs-action reasons include send failure, timeout and invalid response.
- Problem-log UI uses:
  - `GET_PROBLEM_LOGS`
  - `CLEAR_PROBLEM_LOGS`
  - `PROBLEM_LOGS_UPDATED` push refresh

## Resume behavior
- `RESUME_STAGE_OPEN` opens stage picker.
- `RESUME_STAGE_START` resumes company chain from selected index.
- Inject path supports prompt offset and resume mode.
- Reload + resume-all path performs detect/reload/start in a deterministic two-phase sequence.

## Auto-restore and health check behavior
- Alarm period: 5 minutes.
- Default state: OFF (unless explicitly enabled in storage).
- Each cycle:
  - restores missing process windows/tabs,
  - checks active process tabs for response health,
  - counts user/assistant blocks and validates latest assistant response,
  - triggers scan/resume-all when issues are detected.
- Health thresholds:
  - minimum assistant words: 35
  - minimum assistant sentences: 2
- Popup receives:
  - periodic status pull,
  - push refresh message (`AUTO_RESTORE_STATUS_UPDATED`) after cycle completion.

## Manual PDF message types
- `MANUAL_SOURCE_SUBMIT` (`mode='text' | 'pdf'`)
- `MANUAL_PDF_GET_CHUNK`
- `MANUAL_PDF_PROVIDER_READ_CHUNK`
- `MANUAL_PDF_PROVIDER_STATUS`
- `MANUAL_PDF_PROVIDER_RELEASE`

## Integrations currently in repo
- Google Sheets bridge in `content-script.js` remains independent from main response pipeline.
- Direct Watchlist dispatch is handled in `background.js`:
  - queue key: `watchlist_dispatch_outbox` in `chrome.storage.local`
  - trigger: after `saveResponse()` stores final chain output
  - transport: direct HTTPS intake (`POST /api/v1/intake/economist-response`)
  - auth: HMAC headers (`X-Watchlist-Key-Id`, `X-Watchlist-Timestamp`, `X-Watchlist-Nonce`, `X-Watchlist-Signature`)
  - periodic retry: `chrome.alarms` (`watchlist-dispatch-flush`)
  - credentials: inline config or `chrome.storage.local/sync` keys for URL, key id and secret
  - optional localhost tunnel fallback URL support for local development
- There is no separate DB ingest/upload path in extension runtime.
- External handoff is dispatch-only; downstream processing happens in Watchlist intake + worker.

## Recent update (Watchlist near-live process state)
- Added process heartbeat alarm in worker:
  - alarm name: `process-monitor-heartbeat`
  - period: every 1 minute
  - setup points: boot/onInstalled/onStartup
- Added sweep routine `runProcessMonitorHeartbeatSweep(origin)`:
  - scans active (non-closed) entries from `processRegistry`
  - touches `timestamp` for active runs when no fresh update arrived in `PROCESS_STREAM_HEARTBEAT_MS` (30s)
  - emits stale warning when no process update arrives for `staleTtlMs` (90s)
- Added stale warning event in problem log:
  - source: `process-monitor-heartbeat`
  - reason: `heartbeat_stale`
  - category: `process_state`
  - cooldown dedupe per run: `staleWarnCooldownMs` (60s)
- Updated process stream categorization:
  - non-closed progress remains `process_stream`
  - closed/final process entries are now emitted as `process_state`
- Practical effect:
  - remote Watchlist problem logs can be used as "near-live last known state" of running/stale processes,
  - without adding any new backend endpoint.

## Keyboard shortcuts

Popup numeric shortcuts:
- `1` manual source
- `2` run analysis
- `3` resume from stage
- `4` reload + resume all
- `5` open responses
- `6` open process panel
- `7` stop in current window
- `8` copy YouTube transcript
- `9` restore process windows
- `0` toggle auto-restore
- `Esc` close popup

Global commands (`manifest.json`):
- `Ctrl+Shift+E` open popup action
- `Ctrl+Shift+R` open responses page
- `Ctrl+Shift+M` open process monitor page

## Common change points
- GPT targets: `CHAT_URL`, `CHAT_URL_PORTFOLIO` in `background.js`.
- Source support updates:
  - `manifest.json` host permissions
  - `SUPPORTED_SOURCES` in `background.js`
  - `extractText()` selectors
- Prompt updates:
  - prompt files
  - `STAGE_NAMES_COMPANY` alignment
- Dispatch behavior:
  - `normalizeWatchlistDispatchPayload()`
  - `sendWatchlistDispatch()`
  - `flushWatchlistDispatchOutbox()`
- Auto-restore behavior:
  - `collectAutoRestoreProcessHealthSnapshot()`
  - `runAutoRestoreWindowsCycle()`
  - popup format/render helpers in `popup.js`
- Problem log behavior:
  - message handlers in `background.js` (`GET_PROBLEM_LOGS`, `CLEAR_PROBLEM_LOGS`)
  - UI render/refresh logic in `problem-log.js`
- Heartbeat/state monitoring behavior:
  - `ensureProcessMonitorHeartbeatAlarm()`
  - `runProcessMonitorHeartbeatSweep()`
  - `appendProcessHeartbeatStaleWarning()`

## Manual sanity checklist
- Run company flow and verify final response in `responses.html`.
- Run portfolio flow and verify `analysisType=portfolio` entries.
- Verify dispatch status in popup after `saveResponse` (`queued/sent/failed` counters).
- Trigger timeout/invalid case and verify panel decision handling.
- Verify session->local response migration in responses UI.
- Verify auto-restore toggle and status details in popup.
- Verify problem-log page shows new runtime issues and clear action works.
- Verify popup shortcuts `1-0` and global commands (`Ctrl+Shift+R`, `Ctrl+Shift+M`).

## Automated quick checks
- JS parse check: `Get-ChildItem -Filter *.js | ForEach-Object { node --check $_.FullName }`
- Manifest JSON check: `python -c "import json; json.load(open('manifest.json', encoding='utf-8')); print('manifest ok')"`
