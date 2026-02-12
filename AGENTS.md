# AGENTS.md

## Project summary
- Chrome extension that sends news articles and YouTube transcripts to ChatGPT using prompt chains and saves responses.
- Optional backend (Flask + SQLite) for remote storage and market data.
- Dual analysis modes: company (`prompts-company.txt`) and portfolio (`prompts-portfolio.txt`).
- Stage-based prompt flow with resume-from-stage (company flow) and in-ChatGPT progress overlay.

## Repo layout (top level)
- `manifest.json` - extension config, permissions, shortcuts, web resources.
- `background.js` - service worker and main orchestrator (prompt chain, ChatGPT UI automation, storage, cloud upload).
- `popup.html` / `popup.js` - main entry UI (run, manual source, resume stage, decision panel, responses).
- `prompt-dialog.html` / `prompt-dialog.js` - prompt chain selection UI.
- `article-selector.html` / `article-selector.js` - choose which tabs also run portfolio analysis.
- `manual-source.html` / `manual-source.js` - paste custom text and title.
- `responses.html` / `responses.js` - response viewer + copy/clear + market table.
- `process-monitor.html` / `process-monitor.js` - decision panel and run progress.
- `resume-stage.html` / `resume-stage.js` - restart from a chosen prompt stage.
- `chatgpt-monitor.js` - extra monitoring helpers for ChatGPT tabs.
- `youtube-content.js` - extracts YouTube transcripts.
- `content-script.js` - Google Sheets integration (separate from response storage).
- `prompts-company.txt` - company prompt chain (separator token inside file).
- `prompts-portfolio.txt` - portfolio prompt chain.
- `backend/` - optional Flask backend (remote storage + market data).
- `ARCHITECTURE_OVERVIEW.md`, `KEY_FILES_REFERENCE.md`, `CHATGPT_DOM_STRUCTURE.md` - deeper technical docs.

## Core logic (high level flow)
1. User opens popup and triggers analysis.
2. `background.js` loads both prompt files, collects supported tabs, and opens article selection.
3. For each article:
   - Extract text from the page (site selectors) or YouTube transcript.
   - Build payload from prompt #1 by replacing `{{articlecontent}}` with article text.
   - Open ChatGPT tab/window and inject payload + prompt chain.
   - Run prompt chain (prompt #2..N) and advance stage-by-stage.
   - Only the LAST response from the chain is saved as the primary output.
4. Two parallel flows can run:
   - Company flow always runs for supported tabs (`prompts-company.txt`, `CHAT_URL`).
   - Portfolio flow runs only for tabs selected in article selector (`prompts-portfolio.txt`, `CHAT_URL_PORTFOLIO`).
5. Responses are stored locally and optionally uploaded to backend.
6. `responses.html` renders saved responses in real time.

Flow (short):
`popup -> runAnalysis -> processArticles -> injectToChat -> saveResponse -> responses UI`

## Storage model
- Responses live under `chrome.storage.local` key `responses` (with migration from session).
- Response object fields: `text`, `timestamp`, `source`, `analysisType`, optional `runId`, `stage`.
- Process monitoring state is stored in `chrome.storage.local` key `process_monitor_state`.
- `analysisType` values used in practice: `company` and `portfolio`.

## Prompt chain & stages (core mechanics)
- Prompts are loaded on extension start from `prompts-company.txt` and `prompts-portfolio.txt`.
- Prompts are split by the literal token `PROMPT_SEPARATOR` wrapped in arrow markers in prompt files.
- `STAGE_NAMES_COMPANY` in `background.js` must match the order/count of prompts.
- Prompt #1 is the payload template and includes `{{articlecontent}}`; the article text is inserted and sent first.
- Prompt chain = prompts #2..N; stage index in company flow is aligned with `STAGE_NAMES_COMPANY`.
- Stage history is tracked in `injectToChat`:
  - per-stage duration, word count, and label are computed.
  - summaries are shown in the floating counter's stage panel (toggle inside ChatGPT).
  - counter is draggable/minimizable; position is persisted in `localStorage`.
  - stage responses are sent with `SAVE_STAGE_RESPONSE` (saved locally, upload skipped).

## Resume from stage (end-to-end flow)
- Scope: company prompt chain only (`GET_COMPANY_PROMPTS` + `GET_STAGE_NAMES`).
- Popup -> `RESUME_STAGE_OPEN` -> `resume-stage.html` (dropdown populated from `GET_COMPANY_PROMPTS` + `GET_STAGE_NAMES`).
- UI lists prompts starting from #2 because prompt #1 contains `{{articlecontent}}`.
- On Start, `RESUME_STAGE_START` sends the selected 0-based index to `background.js`.
- `resumeFromStage()` requires the ACTIVE tab to be ChatGPT; it aborts with an alert if the active tab is not `chatgpt.com`.
- It slices prompts from `startIndex`, removes `{{articlecontent}}` from the first prompt, and uses an EMPTY payload.
- `injectToChat()` receives `payload=''` + `startIndex` and treats it as resume mode (skips sending payload).
- If ChatGPT is already generating or editor is blocked, resume stops and asks the user to wait/stop manually.
- Remaining prompts are pasted and sent sequentially; responses are generated stage-by-stage like normal runs.

## ChatGPT UI paste + response generation (wklejanie i generowanie)
- `injectToChat()` runs inside the ChatGPT tab and owns the stage counter overlay + stage panel.
- `sendPrompt()` does the paste flow:
  - waits for UI readiness (no active generation),
  - finds the contenteditable editor (or textarea fallback),
  - clears it, inserts the prompt (innerHTML + `<br>` for newlines), and fires input events,
  - waits for an enabled Send button and clicks it,
  - verifies send by detecting a Stop button or the new user message in the DOM.
- `waitForResponse()` waits for generation to finish, validates minimum length, and triggers the wait/skip overlay when needed.
- After each stage:
  - stage metrics + text are recorded,
  - stage response is saved via `SAVE_STAGE_RESPONSE`,
  - only the last prompt's response is saved as the primary response.

## ChatGPT UI automation (critical path)
- DOM selectors and retry logic live in `background.js` (see `injectToChat`, `sendPrompt`, `waitForResponse`, `getLastResponseText`).
- Selector details are documented in `CHATGPT_DOM_STRUCTURE.md`.
- Error handling includes Edit+Resend and Retry logic when ChatGPT fails.

## Decision panel (process monitor)
- UI: `process-monitor.html` / `process-monitor.js`.
- Data source: `process_monitor_state` in `chrome.storage.local`.
- `background.js` emits process lifecycle events:
  - `PROCESS_STARTED`, `PROCESS_PROGRESS`, `PROCESS_NEEDS_ACTION`, `PROCESS_DECISION`.
- Panel shows per-run status, current stage, and needs-action events (manual continue/skip decisions).
- Needs-action is triggered when a response is too short or times out:
  - ChatGPT overlay shows buttons: wait or skip,
  - panel buttons send `PROCESS_DECISION` to resolve the same wait/skip promise.
- Process history is bounded:
  - up to 30 runs stored,
  - up to 120 messages per run,
  - long messages are chunked (6k) and truncated (60k) before reassembly.

## Copying & responses UI
- UI: `responses.html` / `responses.js`.
- Copy All joins raw response texts with newlines (good for Sheets).
- Individual response blocks have copy buttons.
- Clear All wipes stored responses.
- If a response contains stage metadata, the stage line is shown and content can be toggled (Rozwin/Ukryj).
- If text matches the Four-Gate semicolon format, it is rendered as a numbered table and copied in that formatted form.

## Debugging & observability
- `background.js` logs are verbose for:
  - prompt loading and stage progression,
  - DOM extraction (`getLastResponseText`),
  - response storage verification,
  - cloud upload attempts.
- `responses.js` logs render and storage updates.
- `process-monitor.js` logs panel updates and filtering of active processes.
- Recommended debug flow:
  - Reproduce, then check `background.js` console (service worker logs).
  - Verify storage state in `chrome.storage.local`.
  - Use `responses.html` to validate saved output.
  - Use decision panel to inspect per-stage messages and check for truncation flags.

## External integrations
- Cloud upload: configured in `background.js` (`CLOUD_UPLOAD`).
- Backend market data: `responses.js` uses `MARKET_API_URL` for `/market/daily`.
- Google Sheets: `content-script.js` posts to a script URL with `AUTH_TOKEN`.

## Backend (optional)
- Location: `backend/` (Flask + SQLite).
- Env vars:
  - `API_KEY` (optional auth for POST /responses)
  - `DB_PATH` (default `data/responses.db`)
  - `TWELVEDATA_API_KEY` (for `/market/daily`)
- Run local:
  - `python -m venv .venv`
  - `.\.venv\Scripts\Activate.ps1`
  - `pip install -r requirements.txt`
  - `python app.py`

## Supported sources
- Update BOTH `manifest.json` and `SUPPORTED_SOURCES` in `background.js` when adding/removing domains.
- For new domains add extract selectors in `extractText()`.

## Common change points
- Change GPT target: update `CHAT_URL` and `CHAT_URL_PORTFOLIO` in `background.js`.
- Edit prompt stages: update prompt files; when company stage count/order changes, update `STAGE_NAMES_COMPANY`.
- Response storage behavior: `saveResponse()` and `responses.js`.
- UI flows: `popup.js`, `prompt-dialog.js`, `article-selector.js`, `manual-source.js`, `resume-stage.js`, `process-monitor.js`.

## Generated/local data
- `backend/data/responses.db` is local DB output.
- `.venv/` directories are local environments.

## Manual testing checklist
- Load unpacked extension and open supported article.
- Run analysis and verify: prompt dialog -> ChatGPT automation -> response saved.
- Open responses UI and confirm new entry appears.
- If backend enabled, confirm POST /responses and market table load.
- Trigger a timeout/short response and confirm decision panel + ChatGPT overlay show wait/skip.
- Verify stage panel shows per-stage summaries and stage responses are logged.
