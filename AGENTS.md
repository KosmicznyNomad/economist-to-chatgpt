# AGENTS.md

## Project summary
- Chrome extension (Manifest V3) that extracts article/transcript text and runs prompt chains in ChatGPT.
- Main orchestrator: `background.js` service worker.
- Two analysis modes:
  - `company` for all supported tabs.
  - `portfolio` only for tabs selected in article selector.

## Repo structure (current)
- `manifest.json` - extension configuration and permissions.
- `background.js` - runtime orchestration: prompt loading, extraction, ChatGPT automation, process monitor state, local save.
- `popup.html` / `popup.js` - run, stop, resume, manual source, monitor and responses navigation.
- `article-selector.html` / `article-selector.js` - portfolio selection.
- `manual-source.html` / `manual-source.js` - pseudo-source submission.
- `resume-stage.html` / `resume-stage.js` - resume company chain from selected stage.
- `process-monitor.html` / `process-monitor.js` - process panel and decisions.
- `responses.html` / `responses.js` - local responses UI with copy/clear.
- `youtube-content.js` - YouTube transcript capture and fetch.
- `content-script.js` - separate Google Sheets bridge.
- `prompts-company.txt` / `prompts-portfolio.txt` - prompt chains split by `◄PROMPT_SEPARATOR►`.

## Runtime flow
`popup -> RUN_ANALYSIS -> processArticles -> injectToChat -> saveResponse -> responses.html`

Detailed:
1. Worker scans supported tabs.
2. Text is extracted (`extractText` for web, `GET_TRANSCRIPT` for YouTube).
3. Prompt #1 receives `{{articlecontent}}` payload.
4. Remaining prompts are executed in ChatGPT.
5. Final chain response is stored as result.

## Storage model
- Writer path (`background.js`): `chrome.storage.session.responses`.
- Reader path (`responses.js`): migration and merge into `chrome.storage.local.responses`.
- Process monitor state: `chrome.storage.local.process_monitor_state`.

Response fields in use:
- `text`
- `timestamp`
- `source`
- `analysisType`
- `responseId`
- optional `runId`

## Prompt/stage alignment
- Separator token: `◄PROMPT_SEPARATOR►`.
- Company stage names are maintained in `STAGE_NAMES_COMPANY` in `background.js` and must stay aligned with `prompts-company.txt`.

## Monitor and decisions
- `process-monitor.js` subscribes to process updates and can send:
  - `PROCESS_DECISION`
  - `PROCESS_DECISION_ALL`
  - resume actions for next stage
- Needs-action reasons include send failure, timeout and invalid response.

## Resume behavior
- `RESUME_STAGE_OPEN` opens stage picker.
- `RESUME_STAGE_START` resumes company chain from selected index.
- Inject path supports prompt offset and resume mode.

## Integrations currently in repo
- Google Sheets bridge in `content-script.js` remains independent from main response pipeline.
- Direct Watchlist dispatch is handled in `background.js`:
  - queue key: `watchlist_dispatch_outbox` in `chrome.storage.local`
  - trigger: after `saveResponse()` stores final chain output
  - transport: GitHub `repository_dispatch` (`economist_response`)
  - periodic retry: `chrome.alarms` (`watchlist-dispatch-flush`)
  - one-time credential: `WATCHLIST_DISPATCH.token` in `background.js`

## Common change points
- GPT targets: `CHAT_URL`, `CHAT_URL_PORTFOLIO` in `background.js`.
- Source support updates:
  - `manifest.json` host permissions
  - `SUPPORTED_SOURCES` in `background.js`
  - `extractText()` selectors
- Prompt updates:
  - prompt files
  - `STAGE_NAMES_COMPANY` alignment
- Storage behavior:
  - `saveResponse()` in `background.js`
  - migration and rendering in `responses.js`

## Manual sanity checklist
- Run company flow and verify final response in `responses.html`.
- Run portfolio flow and verify `analysisType=portfolio` entries.
- Trigger timeout/invalid case and verify panel decision handling.
- Verify session->local response migration in responses UI.
