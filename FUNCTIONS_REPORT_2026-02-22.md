# Functions Report (2026-02-22)

## Scope
Report covers functions added or materially extended in current implementation cycle for:
- resume/recovery and auto-restore,
- popup integration and shortcut UX,
- manual PDF provider keepalive,
- command wiring.

Files covered:
- `background.js`
- `popup.js`
- `manual-source.js`
- `manifest.json` (commands wiring)

## New functions

| File | Function | Purpose |
|---|---|---|
| `background.js` | `extractManualPdfProviderIdFromPort(port)` | Extract provider id from keepalive port name (`manual-pdf-provider:<id>`). |
| `background.js` | `waitForManualPdfProviderPort(providerId, timeoutMs)` | Wait for PDF provider keepalive connection before queue run. |
| `background.js` | `readAutoRestoreWindowsLastCycle()` | Read last auto-restore diagnostics cycle from storage. |
| `background.js` | `writeAutoRestoreWindowsLastCycle(record)` | Persist last auto-restore diagnostics cycle. |
| `background.js` | `notifyAutoRestoreStatusUpdated(payload)` | Push runtime event to popup after cycle completion. |
| `background.js` | `collectTabConversationMetricsForAutoRestore(tabId)` | Collect DOM metrics from ChatGPT tab: user/assistant blocks, words, sentences, previews. |
| `background.js` | `collectAutoRestoreProcessHealthSnapshot(options)` | Compute process health snapshot and issue reasons for all active processes. |
| `popup.js` | `buildShortcutButtonHtml(label, shortcutKey)` | Build consistent button label with shortcut badge. |
| `popup.js` | `setShortcutButtonLabel(button, label, shortcutKey)` | Set dynamic button states without losing shortcut badge. |
| `popup.js` | `getAutoRestoreIssueLabel(code)` | Human-readable labels for auto-restore issue codes. |
| `popup.js` | `formatAutoRestoreReasonCounts(reasonCounts)` | Compact issue summary renderer for popup status. |
| `popup.js` | `formatAutoRestoreIssueItem(item)` | Detailed one-line process issue formatter for popup. |
| `popup.js` | `resolvePopupShortcutKey(event)` | Normalize digit shortcuts from `DigitX` and `NumpadX`. |
| `manual-source.js` | `startProviderKeepalive()` | Open runtime keepalive port from manual PDF window. |
| `manual-source.js` | `stopProviderKeepalive()` | Cleanly stop runtime keepalive port. |

## Materially extended functions

| File | Function | Extension |
|---|---|---|
| `background.js` | `extractLastUserMessageFromTab(tabId)` | Added assistant block count in extraction payload. |
| `background.js` | `runResetScanStartAllTabs(options)` | Added reload-first flow, fallback resume start, final-stage completion marking, richer summary metrics (`prompt_blocks`, `response_blocks`, etc.). |
| `background.js` | `getAutoRestoreWindowsEnabled()` | Default behavior changed to ON when unset/error. |
| `background.js` | `getAutoRestoreWindowsStatus(options)` | Includes `lastCycle` diagnostics payload. |
| `background.js` | `runAutoRestoreWindowsCycle(options)` | Orchestration expanded to `restore -> health check -> optional scan -> persist cycle -> popup notify`. |
| `background.js` | `runManualPdfAnalysisQueue(...)` | Waits for provider keepalive; emits operator warning when missing. |
| `background.js` | `injectToChat(...)` | Added resume-offset baseline metrics accounting for prompt/response blocks. |
| `background.js` | `chrome.commands.onCommand` listener | Added handler for `open_process_monitor`. |
| `popup.js` | `applyAutoRestoreUi(status)` | Dynamic period label and stable shortcut badge handling. |
| `popup.js` | `formatAutoRestoreStatus(status)` | Added last-cycle diagnostics rendering, missing-item details, scan summary. |
| `popup.js` | `refreshAutoRestoreStatus(forceSync)` | Extended to consume richer status payload. |
| `popup.js` | keyboard handler | Expanded from `1-7` to `1-0`, added numpad support and `Esc` close behavior. |
| `popup.js` | `getResumeAllSummary(response)` | Extended with richer scan/reload/prompt/response counters. |

## Commands and shortcuts

### Global commands
- `Ctrl+Shift+E`: open extension popup action
- `Ctrl+Shift+R`: open responses (`open_responses`)
- `Ctrl+Shift+M`: open process monitor (`open_process_monitor`)

### Popup numeric shortcuts
- `1`: manual source
- `2`: run analysis
- `3`: resume from stage
- `4`: reload + resume all
- `5`: open responses
- `6`: open process panel
- `7`: stop in current window
- `8`: copy YouTube transcript
- `9`: restore process windows
- `0`: toggle auto-restore
- `Esc`: close popup

## Auto-restore cycle rules implemented
- Alarm period set to 5 minutes.
- Auto mode defaults to ON unless explicitly disabled by user.
- Health check thresholds:
  - minimum assistant words: 35
  - minimum assistant sentences: 2
- If issues detected, automatic scan/resume is triggered and cycle result is persisted under `auto_restore_windows_last_cycle`.
- Popup status is refreshed by both polling and push event (`AUTO_RESTORE_STATUS_UPDATED`).
