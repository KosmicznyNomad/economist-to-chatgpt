const ProblemLogUiUtils = globalThis.ProblemLogUiUtils || {};
const RemoteUiSharedUtils = globalThis.RemoteUiSharedUtils || {};

function withActiveWindowContext(callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs && tabs.length > 0 ? tabs[0] : null;
    callback({
      activeTab,
      windowId: Number.isInteger(activeTab?.windowId) ? activeTab.windowId : null,
    });
  });
}

function summarizeClientErrorValue(rawValue) {
  if (typeof ProblemLogUiUtils.summarizeClientErrorValue === 'function') {
    return ProblemLogUiUtils.summarizeClientErrorValue(rawValue);
  }
  if (rawValue == null) return '';
  if (typeof rawValue === 'string') return rawValue.trim();
  if (rawValue instanceof Error) return (rawValue.stack || rawValue.message || rawValue.name || '').trim();
  try {
    return JSON.stringify(rawValue);
  } catch {
    return String(rawValue);
  }
}

function reportProblemLogFromUi(rawEntry = {}) {
  if (typeof ProblemLogUiUtils.reportProblemLogFromUi === 'function') {
    ProblemLogUiUtils.reportProblemLogFromUi(rawEntry, {
      defaultSource: 'popup-ui',
      defaultMessage: 'popup_problem',
      signatureNamespace: 'popup-ui',
      allowInfo: true
    });
    return;
  }
  const source = typeof rawEntry?.source === 'string' && rawEntry.source.trim()
    ? rawEntry.source.trim()
    : 'popup-ui';
  const message = typeof rawEntry?.message === 'string' && rawEntry.message.trim()
    ? rawEntry.message.trim()
    : 'popup_problem';
  const error = typeof rawEntry?.error === 'string' ? rawEntry.error.trim() : '';
  const reason = typeof rawEntry?.reason === 'string' ? rawEntry.reason.trim() : '';
  const signature = typeof rawEntry?.signature === 'string' && rawEntry.signature.trim()
    ? rawEntry.signature.trim()
    : ['popup-ui', source, rawEntry?.title || '', reason, error, message].join('|');
  try {
    void sendRuntimeMessage({
      type: 'REPORT_PROBLEM_LOG',
      entry: {
        level: rawEntry?.level === 'info'
          ? 'info'
          : (rawEntry?.level === 'warn' ? 'warn' : 'error'),
        source,
        title: typeof rawEntry?.title === 'string' ? rawEntry.title : '',
        status: typeof rawEntry?.status === 'string' ? rawEntry.status : '',
        reason,
        error,
        message,
        signature,
        tabId: Number.isInteger(rawEntry?.tabId) ? rawEntry.tabId : null,
        windowId: Number.isInteger(rawEntry?.windowId) ? rawEntry.windowId : null
      }
    });
  } catch {
    // Ignore runtime bridge errors in popup.
  }
}

function installPopupRuntimeProblemLogging() {
  window.addEventListener('error', (event) => {
    const fileName = typeof event?.filename === 'string' ? event.filename.trim() : '';
    const lineNo = Number.isInteger(event?.lineno) ? event.lineno : null;
    const colNo = Number.isInteger(event?.colno) ? event.colno : null;
    const location = fileName
      ? `${fileName}${lineNo !== null ? `:${lineNo}` : ''}${colNo !== null ? `:${colNo}` : ''}`
      : '';
    const errorText = summarizeClientErrorValue(event?.error || event?.message || '');
    reportProblemLogFromUi({
      source: 'popup-window',
      title: 'Popup runtime error',
      reason: location || 'popup_error',
      error: errorText,
      message: typeof event?.message === 'string' && event.message.trim()
        ? event.message.trim()
        : (errorText || 'popup_runtime_error')
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reasonText = summarizeClientErrorValue(event?.reason);
    reportProblemLogFromUi({
      source: 'popup-window',
      title: 'Popup unhandled rejection',
      reason: 'unhandledrejection',
      error: reasonText,
      message: reasonText || 'popup_unhandled_rejection'
    });
  });
}

function createReloadResumeMonitorSessionId(origin = 'popup') {
  const normalizedOrigin = typeof origin === 'string' && origin.trim()
    ? origin.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-')
    : 'popup';
  return `${normalizedOrigin || 'popup'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const runStatus = document.getElementById('runStatus');
const analysisQueueStatus = document.getElementById('analysisQueueStatus');
const watchlistDispatchStatus = document.getElementById('watchlistDispatchStatus');
const watchlistCredentialsHint = document.getElementById('watchlistCredentialsHint');
const watchlistCredentialsForm = document.getElementById('watchlistCredentialsForm');
const watchlistIntakeUrlInput = document.getElementById('watchlistIntakeUrlInput');
const watchlistKeyIdInput = document.getElementById('watchlistKeyIdInput');
const watchlistSecretInput = document.getElementById('watchlistSecretInput');
const saveWatchlistTokenBtn = document.getElementById('saveWatchlistTokenBtn');
const clearWatchlistTokenBtn = document.getElementById('clearWatchlistTokenBtn');
const flushWatchlistDispatchBtn = document.getElementById('flushWatchlistDispatchBtn');
const restoreProcessWindowsBtn = document.getElementById('restoreProcessWindowsBtn');
const copyLatestInvestFinalResponseBtn = document.getElementById('copyLatestInvestFinalResponseBtn');
const copyLatestInvestFinalResponseStatus = document.getElementById('copyLatestInvestFinalResponseStatus');
const repeatLastPromptAllBtn = document.getElementById('repeatLastPromptAllBtn');
const countCompanyMessagesBtn = document.getElementById('countCompanyMessagesBtn');
const resumeAllExtendedBtn = document.getElementById('resumeAllExtendedBtn');
const resumeAllHeavyBtn = document.getElementById('resumeAllHeavyBtn');
const restoreProcessWindowsStatus = document.getElementById('restoreProcessWindowsStatus');
const autoRestoreToggleBtn = document.getElementById('autoRestoreToggleBtn');
const autoRestoreStatus = document.getElementById('autoRestoreStatus');
const unfinishedProcessesBtn = document.getElementById('unfinishedProcessesBtn');
const remoteThisDeviceIdInput = document.getElementById('remoteThisDeviceIdInput');
const remoteRunnerEnabledInput = document.getElementById('remoteRunnerEnabledInput');
const remoteRunnerNameInput = document.getElementById('remoteRunnerNameInput');
const remoteDefaultRunnerIdInput = document.getElementById('remoteDefaultRunnerIdInput');
const saveRemoteRunnerConfigBtn = document.getElementById('saveRemoteRunnerConfigBtn');
const openRemoteQueueBtn = document.getElementById('openRemoteQueueBtn');
const remoteRunnerConfigStatus = document.getElementById('remoteRunnerConfigStatus');
const remoteRunnerStatus = document.getElementById('remoteRunnerStatus');
let watchlistDispatchStatusSnapshot = null;
let dispatchButtonsBusy = false;
const WATCHLIST_DEFAULT_KEY_ID = 'extension-primary';

const POPUP_SHORTCUTS = Object.freeze({
  manualSource: '1',
  runAnalysis: '2',
  resumeStage: '3',
  resumeAll: '4',
  responses: '5',
  processPanel: '6',
  stop: '7',
  copyFinalResponse: '8',
  restoreWindows: '9',
  autoRestoreToggle: '0'
});

function buildShortcutButtonHtml(label, shortcutKey) {
  const safeLabel = typeof label === 'string' ? label.trim() : '';
  const safeShortcut = typeof shortcutKey === 'string' ? shortcutKey.trim() : '';
  if (!safeShortcut) return safeLabel;
  return `${safeLabel} <span class="shortcut">${safeShortcut}</span>`;
}

function setShortcutButtonLabel(button, label, shortcutKey) {
  if (!button) return;
  button.innerHTML = buildShortcutButtonHtml(label, shortcutKey);
}

function setStatusElement(element, text, isError = false) {
  if (!element) return;
  const safeText = typeof text === 'string' ? text.trim() : '';
  if (!safeText) {
    element.textContent = '';
    element.hidden = true;
    return;
  }
  element.hidden = false;
  element.textContent = safeText;
  element.style.color = isError ? '#b91c1c' : '#374151';
  element.style.borderColor = isError ? '#fecaca' : '#d1d5db';
  element.style.background = isError ? '#fef2f2' : '#f3f4f6';
}

function setRunStatus(text, isError = false) {
  setStatusElement(runStatus, text, isError);
}

function setAnalysisQueueStatus(text, isError = false) {
  setStatusElement(analysisQueueStatus, text, isError);
}

function setDispatchStatus(text, isError = false) {
  setStatusElement(watchlistDispatchStatus, text, isError);
}

function setCopyLatestInvestFinalResponseStatus(text, isError = false) {
  setStatusElement(copyLatestInvestFinalResponseStatus, text, isError);
}

function setWatchlistCredentialsHint(text, isError = false) {
  setStatusElement(watchlistCredentialsHint, text, isError);
}

function setRestoreProcessWindowsStatus(text, isError = false) {
  setStatusElement(restoreProcessWindowsStatus, text, isError);
}

function setAutoRestoreStatus(text, isError = false) {
  setStatusElement(autoRestoreStatus, text, isError);
}

function setRemoteRunnerConfigStatus(text, isError = false) {
  setStatusElement(remoteRunnerConfigStatus, text, isError);
}

function setRemoteRunnerStatus(text, isError = false) {
  setStatusElement(remoteRunnerStatus, text, isError);
}

function formatRemoteRunnerSummary(runner) {
  if (typeof RemoteUiSharedUtils.formatRunnerStatus === 'function') {
    return RemoteUiSharedUtils.formatRunnerStatus(runner || {});
  }
  return {
    tone: runner?.queueable ? 'success' : 'warn',
    text: runner?.runnerName || runner?.runnerId || 'Runner'
  };
}

function getAnalysisQueueUiMetrics(status) {
  const maxConcurrent = Number.isInteger(status?.maxConcurrent) ? status.maxConcurrent : 7;
  const reservedSlots = Number.isInteger(status?.reservedSlots)
    ? Math.max(0, status.reservedSlots)
    : (Number.isInteger(status?.activeSlots) ? Math.max(0, status.activeSlots) : 0);
  const liveSlots = Number.isInteger(status?.liveSlots)
    ? Math.max(0, status.liveSlots)
    : reservedSlots;
  const startingSlots = Number.isInteger(status?.startingSlots)
    ? Math.max(0, status.startingSlots)
    : Math.max(0, reservedSlots - liveSlots);
  const queueSize = Number.isInteger(status?.queueSize) ? Math.max(0, status.queueSize) : 0;
  return {
    maxConcurrent,
    reservedSlots,
    liveSlots,
    startingSlots,
    queueSize
  };
}

function formatAnalysisQueueSummary(status, options = {}) {
  const metrics = getAnalysisQueueUiMetrics(status);
  const includePrefix = options?.includePrefix !== false;
  const includeQueue = options?.includeQueue !== false;
  const parts = [];
  if (includePrefix) {
    parts.push('Kolejka analiz:');
  }
  parts.push(`sloty ${metrics.reservedSlots}/${metrics.maxConcurrent}`);
  if (metrics.startingSlots > 0) {
    parts.push(`zywe okna ${metrics.liveSlots}/${metrics.maxConcurrent}`);
    parts.push(`startujace ${metrics.startingSlots}`);
  } else {
    parts.push(`okna ${metrics.liveSlots}/${metrics.maxConcurrent}`);
  }
  if (includeQueue) {
    parts.push(`oczekuje ${metrics.queueSize}`);
  }
  return `${parts.join(', ')}.`;
}

function formatAnalysisQueueStatus(status) {
  return formatAnalysisQueueSummary(status, {
    includePrefix: true,
    includeQueue: true
  });
}

async function refreshAnalysisQueueStatus() {
  try {
    const response = await sendRuntimeMessage({ type: 'GET_ANALYSIS_QUEUE_STATUS' });
    if (response?.success === false) {
      setAnalysisQueueStatus(`Kolejka analiz: blad (${response.error || 'unknown'}).`, true);
      return;
    }
    setAnalysisQueueStatus(formatAnalysisQueueStatus(response), false);
  } catch (error) {
    setAnalysisQueueStatus(`Kolejka analiz: blad (${error?.message || String(error)}).`, true);
  }
}

async function refreshRemoteRunnerConfig() {
  try {
    const response = await sendRuntimeMessage({ type: 'GET_REMOTE_RUNNER_CONFIG' });
    if (response?.success === false) {
      setRemoteRunnerConfigStatus(`Remote config: ${response.error || 'unknown'}`, true);
      return null;
    }
    if (remoteThisDeviceIdInput) {
      remoteThisDeviceIdInput.value = typeof response?.thisDeviceId === 'string' ? response.thisDeviceId : '';
    }
    if (remoteRunnerEnabledInput) {
      remoteRunnerEnabledInput.checked = response?.remoteRunnerEnabled === true;
    }
    if (remoteRunnerNameInput) {
      remoteRunnerNameInput.value = typeof response?.remoteRunnerName === 'string' ? response.remoteRunnerName : '';
    }
    if (remoteDefaultRunnerIdInput) {
      remoteDefaultRunnerIdInput.value = typeof response?.remoteDefaultRunnerId === 'string' ? response.remoteDefaultRunnerId : '';
    }
    setRemoteRunnerConfigStatus('', false);
    return response;
  } catch (error) {
    setRemoteRunnerConfigStatus(`Remote config: ${error?.message || String(error)}`, true);
    return null;
  }
}

async function refreshRemoteRunnerStatus(showErrors = false) {
  try {
    const response = await sendRuntimeMessage({ type: 'GET_REMOTE_DEFAULT_RUNNER_STATUS' });
    if (response?.success === false) {
      if (showErrors || response?.error !== 'default_runner_missing') {
        setRemoteRunnerStatus(`Remote runner: ${response.error || 'unknown'}`, true);
      } else {
        setRemoteRunnerStatus('Remote runner: ustaw default runner id.', false);
      }
      return;
    }
    const summary = formatRemoteRunnerSummary(response?.runner || {});
    setRemoteRunnerStatus(summary.text, summary.tone === 'error');
  } catch (error) {
    setRemoteRunnerStatus(`Remote runner: ${error?.message || String(error)}`, true);
  }
}

function applyAutoRestoreUi(status) {
  const enabled = !!status?.enabled;
  const periodInMinutes = Number.isInteger(status?.periodInMinutes) && status.periodInMinutes > 0
    ? status.periodInMinutes
    : 5;
  if (autoRestoreToggleBtn) {
    setShortcutButtonLabel(
      autoRestoreToggleBtn,
      enabled ? `Auto co ${periodInMinutes} min: ON` : `Auto co ${periodInMinutes} min: OFF`,
      POPUP_SHORTCUTS.autoRestoreToggle
    );
    autoRestoreToggleBtn.dataset.enabled = enabled ? 'true' : 'false';
  }
}

const AUTO_RESTORE_ISSUE_LABELS = {
  needs_action: 'wymaga akcji',
  failed_status: 'status blad',
  missing_tab_context: 'brak kontekstu tab',
  tab_not_found: 'tab nieznaleziony',
  tab_not_chatgpt: 'tab poza ChatGPT',
  metrics_unavailable: 'brak metryk DOM',
  missing_assistant_reply: 'brak odpowiedzi assistant',
  assistant_reply_empty: 'pusta odpowiedz',
  assistant_reply_too_short: 'odpowiedz za krotka'
};

function getAutoRestoreIssueLabel(code) {
  const normalized = typeof code === 'string' ? code.trim() : '';
  if (!normalized) return '';
  return AUTO_RESTORE_ISSUE_LABELS[normalized] || normalized;
}

function formatAutoRestoreReasonCounts(reasonCounts) {
  if (!reasonCounts || typeof reasonCounts !== 'object') return '';
  const entries = Object.entries(reasonCounts)
    .filter((entry) => Number.isInteger(entry[1]) && entry[1] > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4);
  if (entries.length === 0) return '';
  return entries
    .map((entry) => `${getAutoRestoreIssueLabel(entry[0])}: ${entry[1]}`)
    .join(', ');
}

function formatAutoRestoreIssueItem(item) {
  if (!item || typeof item !== 'object') return '';
  const title = safePreview(item.title || item.runId || 'process', 'process');
  const flags = Array.isArray(item.issueFlags)
    ? item.issueFlags.map(getAutoRestoreIssueLabel).filter(Boolean)
    : [];
  const words = Number.isInteger(item.lastAssistantWordCount) ? item.lastAssistantWordCount : 0;
  const sentences = Number.isInteger(item.lastAssistantSentenceCount) ? item.lastAssistantSentenceCount : 0;
  const promptInfo = Number.isInteger(item.currentPrompt) && Number.isInteger(item.totalPrompts) && item.totalPrompts > 0
    ? `P${item.currentPrompt}/${item.totalPrompts}`
    : 'P?';
  return `${title} -> ${flags.join(', ') || 'issue'} | ${promptInfo} | odp: ${words} slow, ${sentences} zdan`;
}

function formatAutoRestoreStatus(status) {
  if (!status || status.success === false) {
    return 'Automatyzacja: blad odczytu.';
  }
  const enabled = !!status.enabled;
  const periodInMinutes = Number.isInteger(status?.periodInMinutes) && status.periodInMinutes > 0
    ? status.periodInMinutes
    : 5;
  const nextRunAt = Number.isInteger(status.nextRunAt) ? new Date(status.nextRunAt).toLocaleString() : 'brak';
  const alarmActive = !!status.alarmActive;
  if (!enabled) {
    return 'Automatyzacja: wylaczona.';
  }
  const lines = [
    `Automatyzacja: WLACZONA (co ${periodInMinutes} min). Alarm: ${alarmActive ? 'aktywny' : 'brak'}. Nastepne uruchomienie: ${nextRunAt}.`
  ];

  const lastCycle = status?.lastCycle && typeof status.lastCycle === 'object'
    ? status.lastCycle
    : null;
  if (!lastCycle) {
    return lines.join('\n');
  }

  const check = lastCycle?.check && typeof lastCycle.check === 'object'
    ? lastCycle.check
    : {};
  const restore = lastCycle?.restore && typeof lastCycle.restore === 'object'
    ? lastCycle.restore
    : {};
  const scan = lastCycle?.scan && typeof lastCycle.scan === 'object'
    ? lastCycle.scan
    : {};
  const checkedAt = Number.isInteger(check?.checkedAt)
    ? new Date(check.checkedAt).toLocaleString()
    : (Number.isInteger(lastCycle?.ts) ? new Date(lastCycle.ts).toLocaleString() : 'brak');
  const checkedProcesses = Number.isInteger(check?.checkedProcesses) ? check.checkedProcesses : 0;
  const issueProcesses = Number.isInteger(check?.issueProcesses) ? check.issueProcesses : 0;
  const totalProcesses = Number.isInteger(check?.totalActiveProcesses) ? check.totalActiveProcesses : checkedProcesses;
  const reasonSummary = formatAutoRestoreReasonCounts(check?.reasonCounts);

  lines.push(`Ostatni check: ${checkedAt}. Procesy: ${checkedProcesses}/${totalProcesses}. Braki: ${issueProcesses}.`);
  lines.push(`Restore: requested=${restore?.requested || 0}, restored=${restore?.restored || 0}, failed=${restore?.failed || 0}.`);
  if (issueProcesses > 0) {
    lines.push(`Czego brakuje: ${reasonSummary || 'szczegoly niedostepne'}.`);
    const items = Array.isArray(check?.items) ? check.items.slice(0, 3) : [];
    items.forEach((item) => {
      const line = formatAutoRestoreIssueItem(item);
      if (line) lines.push(`- ${line}`);
    });
  }

  if (scan?.triggered) {
    const scanStarted = Number.isInteger(scan?.startedTabs) ? scan.startedTabs : 0;
    const scanMatched = Number.isInteger(scan?.matchedTabs) ? scan.matchedTabs : 0;
    const scanSuccess = scan?.success === true ? 'OK' : 'BLAD';
    const scanError = typeof scan?.error === 'string' && scan.error.trim()
      ? ` (${scan.error.trim()})`
      : '';
    lines.push(`Auto-skan: ${scanSuccess}, matched=${scanMatched}, started=${scanStarted}${scanError}.`);
  }

  return lines.join('\n');
}

async function refreshAutoRestoreStatus(forceSync = false) {
  if (!autoRestoreStatus) return;
  try {
    const response = await sendRuntimeMessage({
      type: 'GET_AUTO_RESTORE_WINDOWS_STATUS',
      forceSync,
    });
    applyAutoRestoreUi(response);
    setAutoRestoreStatus(formatAutoRestoreStatus(response), response?.success === false);
  } catch (error) {
    setAutoRestoreStatus(`Automatyzacja: ${error?.message || String(error)}`, true);
  }
}

function tokenSourceLabel(source) {
  if (source === 'inline_config') return 'inline config';
  if (source === 'storage_local') return 'local storage';
  if (source === 'storage_sync') return 'sync storage';
  return 'missing';
}

function safePreview(value, fallback = 'n/a') {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return fallback;
  return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}

const DISPATCH_REASON_LABELS = {
  dispatch_disabled: 'dispatch wylaczony',
  invalid_payload: 'niepoprawny payload',
  missing_intake_url: 'brak Intake URL',
  missing_key_id: 'brak Key ID',
  missing_dispatch_credentials: 'brak sekretu HMAC',
  empty_token: 'pusty sekret',
  storage_unavailable: 'storage niedostepny',
  invalid_queue_item: 'niepoprawny wpis kolejki',
  pending_retry_window: 'oczekiwanie na okno retry',
  runtime_unavailable: 'most runtime niedostepny',
  runtime_timeout: 'timeout mostu runtime',
  flush_in_progress: 'flush juz trwa',
  save_response: 'flush po zapisie odpowiedzi',
  verify_disabled: 'weryfikacja DB wylaczona',
  missing_verify_url: 'brak URL verify',
  missing_response_id: 'brak responseId',
  materialization_pending: 'materializacja DB oczekuje',
  materialization_partial: 'materializacja DB czesciowa',
  missing_fields: 'braki danych po stronie intake',
  mismatch: 'niezgodnosc danych verify',
  ingest_failed: 'ingest zakonczony bledem',
  ingest_quarantined: 'ingest zakonczony kwarantanna',
  materialization_unavailable: 'materializacja DB niedostepna',
  timeout: 'timeout HTTP',
  dispatch_error: 'blad transportu dispatch',
  dispatch_failed: 'dispatch nieudany',
  queue_skipped: 'kolejka pominieta',
  flush_skipped: 'flush pominiety'
};

const DISPATCH_PROCESS_CODE_LABELS = {
  queue_skipped_disabled: 'kolejka pominieta (dispatch off)',
  queue_invalid_payload: 'kolejka pominieta (payload)',
  queue_queued: 'payload dodany do kolejki',
  send_skipped_disabled: 'wysylka pominieta (dispatch off)',
  send_skipped_config: 'wysylka pominieta (konfiguracja)',
  send_missing_url: 'brak URL intake',
  send_start: 'start wysylki HTTP',
  send_attempt_start: 'proba wysylki',
  send_attempt_ok: 'proba OK',
  send_switch_candidate: 'przelaczenie URL',
  send_attempt_retry: 'retry wysylki',
  send_attempt_failed: 'proba nieudana',
  send_failed_all_candidates: 'wszystkie URL nieudane',
  verify_attempt_start: 'start weryfikacji DB',
  verify_attempt_ok: 'weryfikacja DB OK',
  verify_attempt_pending: 'weryfikacja DB oczekuje',
  verify_attempt_retry: 'retry weryfikacji DB',
  verify_attempt_failed: 'weryfikacja DB nieudana',
  flush_skipped_disabled: 'flush pominiety (dispatch off)',
  flush_skipped_in_progress: 'flush pominiety (w toku)',
  flush_start: 'start flush',
  flush_empty: 'flush pustej kolejki',
  flush_item_invalid: 'pozycja kolejki niepoprawna',
  flush_item_deferred: 'pozycja odlozona',
  flush_item_verify_pending: 'pozycja czeka na zapis DB',
  flush_item_verify_failed: 'pozycja odrzucona przez verify DB',
  flush_item_failed: 'pozycja nieudana (requeue)',
  flush_budget_stop: 'osiagnieto budzet flush',
  flush_stale_lock_reset: 'reset stale lock flush',
  flush_done: 'flush zakonczony',
  flush_exception: 'wyjatek flush',
  flush_follow_up_scheduled: 'zaplanowano follow-up flush',
  flush_follow_up_failed: 'blad follow-up flush',
  pipeline_result: 'wynik pipeline zapisu'
};

function normalizeDispatchToken(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function humanizeDispatchToken(value) {
  const normalized = normalizeDispatchToken(value);
  if (!normalized) return '';
  return normalized.replace(/[_-]+/g, ' ');
}

function getDispatchReasonLabel(reasonCode) {
  const normalized = normalizeDispatchToken(reasonCode);
  if (!normalized) return '';
  if (DISPATCH_REASON_LABELS[normalized]) return DISPATCH_REASON_LABELS[normalized];
  if (normalized.startsWith('http_')) {
    const suffix = normalized.slice('http_'.length);
    return `blad HTTP (${suffix || 'unknown'})`;
  }
  return humanizeDispatchToken(normalized);
}

function getDispatchProcessCodeLabel(code) {
  const normalized = normalizeDispatchToken(code);
  if (!normalized) return 'zdarzenie';
  if (DISPATCH_PROCESS_CODE_LABELS[normalized]) return DISPATCH_PROCESS_CODE_LABELS[normalized];
  return humanizeDispatchToken(normalized);
}

function formatDispatchErrorText(rawError) {
  const text = typeof rawError === 'string' ? rawError.trim() : '';
  if (!text) return '';
  if (/^[a-z0-9_.-]+$/i.test(text)) {
    return getDispatchReasonLabel(text);
  }
  return text;
}

function formatLastDispatchFlush(lastFlush) {
  if (!lastFlush || typeof lastFlush !== 'object') return 'brak';
  const ts = Number.isInteger(lastFlush.ts) ? lastFlush.ts : null;
  const when = ts ? new Date(ts).toLocaleString() : 'n/a';
  if (lastFlush.skipped) {
    const skipReason = getDispatchReasonLabel(lastFlush.skipReason || 'unknown');
    return `skip=${skipReason || 'n/a'} @ ${when}`;
  }
  return `sent=${lastFlush.sent || 0}, failed=${lastFlush.failed || 0}, remaining=${lastFlush.remaining || 0} @ ${when}`;
}

function formatLatestDispatchProcessLog(logs) {
  const latest = Array.isArray(logs) && logs.length > 0 ? logs[0] : null;
  if (!latest || typeof latest !== 'object') return '';
  const ts = Number.isInteger(latest.ts) ? latest.ts : null;
  const when = ts ? new Date(ts).toLocaleString() : 'n/a';
  const code = typeof latest.code === 'string' && latest.code.trim() ? latest.code.trim() : 'event';
  const codeLabel = getDispatchProcessCodeLabel(code);
  const level = typeof latest.level === 'string' && latest.level.trim() ? latest.level.trim() : 'info';
  const message = typeof latest.message === 'string' && latest.message.trim()
    ? latest.message.trim()
    : 'dispatch_event';
  const compactMessage = message.length > 120 ? `${message.slice(0, 117)}...` : message;
  return ` Ostatni etap DB: ${codeLabel} [${level}] - ${compactMessage} @ ${when}.`;
}

function formatDispatchStatus(status) {
  if (!status || status.success === false) {
    const reason = getDispatchReasonLabel(status?.reason || '');
    return reason
      ? `Intake status: blad odczytu (${reason}).`
      : 'Intake status: blad odczytu.';
  }
  if (!status.enabled) {
    return 'Intake status: wylaczony.';
  }

  const queueSize = Number.isInteger(status.queueSize) ? status.queueSize : 0;
  const flushText = formatLastDispatchFlush(status.lastFlush);
  const retryText = Number.isInteger(status.nextRetryAt)
    ? ` Nastepna proba: ${new Date(status.nextRetryAt).toLocaleString()}.`
    : '';
  const errorText = status.latestOutboxError
    ? ` Ostatni blad: ${formatDispatchErrorText(status.latestOutboxError)}${status.latestOutboxErrorTrace ? ` (${status.latestOutboxErrorTrace})` : ''}.`
    : '';
  const latestProcessLogText = formatLatestDispatchProcessLog(status.recentProcessLogs);
  const supportIdText = typeof status.supportId === 'string' && status.supportId.trim()
    ? ` Support ID: ${status.supportId.trim()}.`
    : '';
  const flushInProgressAgeMs = Number.isInteger(status.flushInProgressAgeMs)
    ? Math.max(0, status.flushInProgressAgeMs)
    : 0;
  const flushInProgressSinceText = Number.isInteger(status.flushInProgressSince)
    ? new Date(status.flushInProgressSince).toLocaleString()
    : '';
  const flushInProgressReason = typeof status.flushInProgressReason === 'string'
    ? status.flushInProgressReason.trim()
    : '';
  const flushInProgressText = status.flushInProgress
    ? ` Flush aktywny: tak${flushInProgressAgeMs > 0 ? `, wiek=${Math.round(flushInProgressAgeMs / 1000)}s` : ''}${flushInProgressReason ? `, reason=${flushInProgressReason}` : ''}${flushInProgressSinceText ? `, start=${flushInProgressSinceText}` : ''}.`
    : '';
  const base = `Kolejka: ${queueSize}. Ostatni flush: ${flushText}.${flushInProgressText}${retryText}${errorText}${latestProcessLogText}${supportIdText}`;

  if (status.configured) {
    if (status.tokenSource === 'inline_config') {
      return `Intake status: skonfigurowany centralnie (inline config, bez lokalnego klucza). URL: ${safePreview(status.intakeUrl)}. Key ID: ${safePreview(status.keyId)}. ${base}`;
    }
    return `Intake status: skonfigurowany (${tokenSourceLabel(status.tokenSource)}). URL: ${safePreview(status.intakeUrl)}. Key ID: ${safePreview(status.keyId)}. ${base}`;
  }
  const reasonLabel = getDispatchReasonLabel(status.reason || '');
  if (reasonLabel) {
    return `Intake status: ${reasonLabel}. ${base}`;
  }
  return `Intake status: ${status.reason || 'nieznany'}. ${base}`;
}

function formatDispatchFlushResult(flushResult) {
  if (!flushResult || typeof flushResult !== 'object') return 'brak danych';
  if (flushResult.skipped) {
    const label = getDispatchReasonLabel(flushResult.reason || 'unknown') || 'unknown';
    const ageText = Number.isInteger(flushResult.lockAgeMs) && flushResult.lockAgeMs > 0
      ? `, lock_age=${Math.round(flushResult.lockAgeMs / 1000)}s`
      : '';
    return `skip (${label}${ageText})`;
  }
  if (flushResult.success === false) {
    return `blad (${formatDispatchErrorText(flushResult.error || 'unknown') || 'unknown'})`;
  }
  return `accepted=${flushResult.accepted || 0}, sent=${flushResult.sent || 0}, failed=${flushResult.failed || 0}, deferred=${flushResult.deferred || 0}, remaining=${flushResult.remaining || 0}`;
}

function isDispatchInlineManaged(status) {
  return !!(status && status.configured === true && status.tokenSource === 'inline_config');
}

function applyDispatchButtonsState() {
  const inlineManaged = isDispatchInlineManaged(watchlistDispatchStatusSnapshot);
  if (saveWatchlistTokenBtn) saveWatchlistTokenBtn.disabled = dispatchButtonsBusy || inlineManaged;
  if (clearWatchlistTokenBtn) clearWatchlistTokenBtn.disabled = dispatchButtonsBusy || inlineManaged;
  if (flushWatchlistDispatchBtn) flushWatchlistDispatchBtn.disabled = dispatchButtonsBusy;
}

function applyWatchlistCredentialsUi(status) {
  const inlineManaged = isDispatchInlineManaged(status);
  if (watchlistCredentialsForm) {
    watchlistCredentialsForm.hidden = inlineManaged;
  }
  if (inlineManaged) {
    setWatchlistCredentialsHint(
      'Konfiguracja centralna aktywna: lokalny Intake URL / Key ID / Secret nie sa wymagane.',
      false
    );
    return;
  }
  if (watchlistKeyIdInput && !(typeof watchlistKeyIdInput.value === 'string' && watchlistKeyIdInput.value.trim())) {
    watchlistKeyIdInput.value = WATCHLIST_DEFAULT_KEY_ID;
  }
  setWatchlistCredentialsHint('', false);
}

function applyDispatchStatusSnapshot(status) {
  watchlistDispatchStatusSnapshot = status && typeof status === 'object' ? status : null;
  if (watchlistDispatchStatusSnapshot) {
    if (watchlistIntakeUrlInput && typeof watchlistDispatchStatusSnapshot.intakeUrl === 'string' && watchlistDispatchStatusSnapshot.intakeUrl.trim()) {
      watchlistIntakeUrlInput.value = watchlistDispatchStatusSnapshot.intakeUrl.trim();
    }
    if (watchlistKeyIdInput && typeof watchlistDispatchStatusSnapshot.keyId === 'string' && watchlistDispatchStatusSnapshot.keyId.trim()) {
      watchlistKeyIdInput.value = watchlistDispatchStatusSnapshot.keyId.trim();
    } else if (watchlistKeyIdInput && !(typeof watchlistKeyIdInput.value === 'string' && watchlistKeyIdInput.value.trim())) {
      watchlistKeyIdInput.value = WATCHLIST_DEFAULT_KEY_ID;
    }
  }
  applyWatchlistCredentialsUi(watchlistDispatchStatusSnapshot);
  applyDispatchButtonsState();
}

async function refreshDispatchStatus(forceReload = false) {
  if (!watchlistDispatchStatus) return;
  try {
    const response = await sendRuntimeMessage({
      type: 'GET_WATCHLIST_DISPATCH_STATUS',
      forceReload,
    });
    applyDispatchStatusSnapshot(response);
    setDispatchStatus(formatDispatchStatus(response), response?.success === false);
  } catch (error) {
    applyDispatchStatusSnapshot(null);
    setDispatchStatus(`Intake status: ${error?.message || String(error)}`, true);
  }
}

const COMPANY_COUNT_PROCESS_ISSUE_LABELS = {
  missing_assistant_reply: 'brak odpowiedzi assistant po prompcie',
  assistant_reply_below_threshold: 'odpowiedzi ponizej progu jakosci',
  unrecognized_prompt_stage: 'nierozpoznane etapy promptow',
  sequence_issue: 'naruszona kolejnosc etapow',
  data_gap_stop: 'wykryto sygnal DATA_GAPS_STOP',
  unmatched_user_messages: 'nierozpoznane wiadomosci user'
};

function getCompanyCountProcessIssueLabel(code) {
  const normalized = typeof code === 'string' ? code.trim() : '';
  if (!normalized) return '';
  return COMPANY_COUNT_PROCESS_ISSUE_LABELS[normalized] || normalized;
}

function formatMissingReplyItem(item) {
  if (!item || typeof item !== 'object') return '';
  const index = Number.isInteger(item?.userMessageIndex) ? item.userMessageIndex : '?';
  const runId = Number.isInteger(item?.runId) ? item.runId : null;
  const promptNumber = Number.isInteger(item?.promptNumber) ? item.promptNumber : '?';
  const stageName = typeof item?.stageName === 'string' && item.stageName.trim()
    ? safePreview(item.stageName.trim(), '-')
    : '-';
  return `#${index}${runId ? `[R${runId}]` : ''}: P${promptNumber} (${stageName})`;
}

function formatLowQualityReplyItem(item) {
  if (!item || typeof item !== 'object') return '';
  const index = Number.isInteger(item?.userMessageIndex) ? item.userMessageIndex : '?';
  const runId = Number.isInteger(item?.runId) ? item.runId : null;
  const promptNumber = Number.isInteger(item?.promptNumber) ? item.promptNumber : '?';
  const words = Number.isInteger(item?.assistantReplyWordCount) ? item.assistantReplyWordCount : 0;
  const sentences = Number.isInteger(item?.assistantReplySentenceCount) ? item.assistantReplySentenceCount : 0;
  return `#${index}${runId ? `[R${runId}]` : ''}: P${promptNumber} (${words} slow, ${sentences} zdan)`;
}

function formatCompanyProcessCounterAlert(response) {
  if (!response || response.success !== true) return '';
  const totals = response?.totals && typeof response.totals === 'object' ? response.totals : {};
  const missingReplyCount = Number.isInteger(totals?.promptRepliesMissing) ? totals.promptRepliesMissing : 0;
  const lowQualityCount = Number.isInteger(totals?.promptRepliesBelowThreshold) ? totals.promptRepliesBelowThreshold : 0;
  const dataGapStopDetected = response?.dataGapStopDetected === true
    || (Number.isInteger(totals?.dataGapStopDetected) && totals.dataGapStopDetected > 0);
  const dataGapMissingInputsList = Array.isArray(response?.dataGapMissingInputsList)
    ? response.dataGapMissingInputsList.filter((item) => typeof item === 'string' && item.trim())
    : [];
  const missingReplyPromptNumbers = Array.isArray(response?.missingReplyPromptNumbers)
    ? response.missingReplyPromptNumbers
    : [];
  const lowQualityReplyPromptNumbers = Array.isArray(response?.lowQualityReplyPromptNumbers)
    ? response.lowQualityReplyPromptNumbers
    : [];

  if (missingReplyCount <= 0 && lowQualityCount <= 0 && !dataGapStopDetected) {
    return 'Licznik procesu: OK (brak brakujacych i niskiej jakosci odpowiedzi).';
  }

  const parts = [];
  if (missingReplyCount > 0) {
    const missingPromptText = missingReplyPromptNumbers.length > 0
      ? `; etapy=${missingReplyPromptNumbers.map((item) => `P${item}`).join(',')}`
      : '';
    parts.push(`brak_odpowiedzi=${missingReplyCount}${missingPromptText}`);
  }
  if (lowQualityCount > 0) {
    const lowQualityPromptText = lowQualityReplyPromptNumbers.length > 0
      ? `; etapy=${lowQualityReplyPromptNumbers.map((item) => `P${item}`).join(',')}`
      : '';
    parts.push(`jakosc_niska=${lowQualityCount}${lowQualityPromptText}`);
  }
  if (dataGapStopDetected) {
    const missingInputsText = dataGapMissingInputsList.length > 0
      ? `; missing_inputs=${dataGapMissingInputsList.join(',')}`
      : '';
    parts.push(`data_gaps_stop=1${missingInputsText}`);
  }
  return `Licznik procesu: WYMAGA AKCJI (${parts.join(' | ')}).`;
}

function formatCompanyConversationCountError(response) {
  const errorCode = typeof response?.error === 'string' ? response.error.trim() : '';
  if (!errorCode) return 'unknown_error';
  if (errorCode === 'invalid_tab_id' || errorCode === 'tab_not_found') return 'brak aktywnej karty.';
  if (errorCode === 'tab_not_chatgpt') return 'aktywna karta nie jest konwersacja ChatGPT.';
  if (errorCode === 'prompts_not_loaded') return 'prompty company nie sa zaladowane.';
  if (errorCode === 'conversation_scan_failed') return 'nie udalo sie odczytac calej konwersacji.';
  return errorCode;
}

function formatCompanyConversationCountStatus(response) {
  if (!response || response.success !== true) {
    return `Liczenie company: ${formatCompanyConversationCountError(response)}`;
  }

  const totals = response?.totals && typeof response.totals === 'object' ? response.totals : {};
  const thresholds = response?.thresholds && typeof response.thresholds === 'object' ? response.thresholds : {};
  const verification = response?.verification && typeof response.verification === 'object' ? response.verification : {};
  const stageMappingCheck = response?.stageMappingCheck && typeof response.stageMappingCheck === 'object'
    ? response.stageMappingCheck
    : {};
  const stageMapping = Array.isArray(response?.stageMapping) ? response.stageMapping : [];
  const promptCoverage = Array.isArray(response?.promptCoverage) ? response.promptCoverage : [];
  const assignmentLog = Array.isArray(response?.assignmentLog) ? response.assignmentLog : [];
  const missingPromptNumbers = Array.isArray(response?.missingPromptNumbers) ? response.missingPromptNumbers : [];
  const duplicatePromptNumbers = Array.isArray(response?.duplicatePromptNumbers) ? response.duplicatePromptNumbers : [];
  const missingReplyPromptNumbers = Array.isArray(response?.missingReplyPromptNumbers)
    ? response.missingReplyPromptNumbers
    : [];
  const lowQualityReplyPromptNumbers = Array.isArray(response?.lowQualityReplyPromptNumbers)
    ? response.lowQualityReplyPromptNumbers
    : [];
  const missingReplyRows = Array.isArray(response?.missingReplyRows) ? response.missingReplyRows : [];
  const lowQualityReplyRows = Array.isArray(response?.lowQualityReplyRows) ? response.lowQualityReplyRows : [];
  const processIssueFlags = Array.isArray(response?.processIssueFlags) ? response.processIssueFlags : [];
  const processState = typeof response?.processState === 'string'
    ? response.processState.trim().toLowerCase()
    : '';
  const unmatchedUserSamples = Array.isArray(response?.unmatchedUserSamples) ? response.unmatchedUserSamples : [];
  const sequenceIssues = Array.isArray(response?.sequenceIssues) ? response.sequenceIssues : [];
  const runResets = Array.isArray(response?.runResets) ? response.runResets : [];
  const dataGapStopDetected = response?.dataGapStopDetected === true
    || (Number.isInteger(totals?.dataGapStopDetected) && totals.dataGapStopDetected > 0);
  const dataGapMissingInputsList = Array.isArray(response?.dataGapMissingInputsList)
    ? response.dataGapMissingInputsList.filter((item) => typeof item === 'string' && item.trim())
    : [];
  const dataGapMissingInputsText = typeof response?.dataGapMissingInputs === 'string'
    ? response.dataGapMissingInputs.trim()
    : '';
  const matchedPromptMessages = Number.isInteger(totals?.matchedPromptMessages)
    ? totals.matchedPromptMessages
    : 0;
  const unmatchedUserMessages = Number.isInteger(totals?.unmatchedUserMessages)
    ? totals.unmatchedUserMessages
    : 0;
  const recognizedUniquePrompts = Number.isInteger(totals?.recognizedUniquePrompts)
    ? totals.recognizedUniquePrompts
    : 0;
  const promptCatalogCount = Number.isInteger(response?.promptCatalogCount)
    ? response.promptCatalogCount
    : 0;
  const recognitionDenominator = matchedPromptMessages + unmatchedUserMessages;
  const recognitionRate = recognitionDenominator > 0
    ? Math.round((matchedPromptMessages / recognitionDenominator) * 100)
    : 0;
  const missingReplyStageCount = Number.isInteger(totals?.missingReplyPromptCount)
    ? totals.missingReplyPromptCount
    : missingReplyPromptNumbers.length;
  const lowQualityStageCount = Number.isInteger(totals?.lowQualityReplyPromptCount)
    ? totals.lowQualityReplyPromptCount
    : lowQualityReplyPromptNumbers.length;
  const dataGapMissingInputsResolved = dataGapMissingInputsList.length > 0
    ? dataGapMissingInputsList.join(', ')
    : (dataGapMissingInputsText || 'brak');

  const lines = [];
  lines.push('[Company count]');
  lines.push('[Podsumowanie]');
  lines.push(`Konwersacja: user=${totals.totalUserMessages || 0}, assistant=${totals.totalAssistantMessages || 0}, wszystkie=${totals.totalMessages || 0}`);
  lines.push(`Rozpoznanie wiadomosci: instancje_promptow=${matchedPromptMessages}, etapy_unique=${recognizedUniquePrompts}/${promptCatalogCount}, nierozpoznane_user=${unmatchedUserMessages}, skutecznosc=${recognitionRate}%, runy=${totals.detectedRuns || 0}`);
  lines.push(`Odpowiedzi (instancje): present=${totals.promptRepliesPresent || 0}, missing=${totals.promptRepliesMissing || 0}, quality_ok=${totals.promptRepliesPassingThreshold || 0}, quality_low=${totals.promptRepliesBelowThreshold || 0} (prog: ${thresholds.minAssistantWords || 0} slow, ${thresholds.minAssistantSentences || 0} zdan)`);
  lines.push(`Odpowiedzi (etapy): missing=${missingReplyStageCount}, quality_low=${lowQualityStageCount}`);
  lines.push(`Data gaps: stop_marker=${dataGapStopDetected ? 'TAK' : 'NIE'}, missing_inputs=${dataGapStopDetected ? dataGapMissingInputsResolved : 'brak'}`);
  const resolvedProcessState = processState || (
    ((totals.promptRepliesMissing || 0) > 0 || dataGapStopDetected)
      ? 'needs_action'
      : ((totals.promptRepliesBelowThreshold || 0) > 0 ? 'warning' : 'ok')
  );
  const processStateLabel = resolvedProcessState === 'needs_action'
    ? 'WYMAGA AKCJI'
    : (resolvedProcessState === 'warning' ? 'UWAGA' : 'OK');
  lines.push(`Status procesu (licznik): ${processStateLabel}`);
  if (processIssueFlags.length > 0) {
    const processIssueText = processIssueFlags
      .map((item) => getCompanyCountProcessIssueLabel(item))
      .filter(Boolean)
      .join(', ');
    lines.push(`Alert procesu: ${processIssueText || 'wykryto problemy procesu'}`);
  }
  lines.push('');
  lines.push('[Luki i akcje]');

  const missingReplyItemsText = missingReplyRows
    .slice(0, 6)
    .map((entry) => formatMissingReplyItem(entry))
    .filter(Boolean)
    .join(' | ');
  const missingReplyStagesText = missingReplyPromptNumbers.length > 0
    ? missingReplyPromptNumbers.map((item) => `P${item}`).join(', ')
    : 'brak';
  lines.push(`Brakujace odpowiedzi (instancje): ${missingReplyItemsText || 'brak'}${missingReplyRows.length > 6 ? ' | ...' : ''}`);
  lines.push(`Brakujace odpowiedzi (etapy): ${missingReplyStagesText}`);
  if ((totals.promptRepliesMissing || 0) > 0) {
    lines.push('Akcja procesu: uruchom "Powtorz ostatni prompt (wszystkie)" albo "Wznow wszystkie".');
  }
  if (dataGapStopDetected) {
    lines.push(`Akcja data gaps: uzupelnij brakujace dane (${dataGapMissingInputsResolved}), potem wznow pipeline od etapu data-gap.`);
  }

  const lowQualityItemsText = lowQualityReplyRows
    .slice(0, 6)
    .map((entry) => formatLowQualityReplyItem(entry))
    .filter(Boolean)
    .join(' | ');
  const lowQualityStagesText = lowQualityReplyPromptNumbers.length > 0
    ? lowQualityReplyPromptNumbers.map((item) => `P${item}`).join(', ')
    : 'brak';
  lines.push(`Niska jakosc odpowiedzi (instancje): ${lowQualityItemsText || 'brak'}${lowQualityReplyRows.length > 6 ? ' | ...' : ''}`);
  lines.push(`Niska jakosc odpowiedzi (etapy): ${lowQualityStagesText}`);

  const missingText = missingPromptNumbers.length > 0 ? missingPromptNumbers.join(', ') : 'brak';
  const duplicateText = duplicatePromptNumbers.length > 0 ? duplicatePromptNumbers.join(', ') : 'brak';
  lines.push(`Brakujace prompty (nierozpoznane w konwersacji): ${missingText}${missingPromptNumbers.length > 0 ? ` (count=${missingPromptNumbers.length})` : ''}`);
  lines.push(`Duplikaty promptow: ${duplicateText}`);

  lines.push(
    `Walidacja: prompts=${verification.allPromptsDetected ? 'OK' : 'NIE'}, replies=${verification.allMatchedPromptsHaveReply ? 'OK' : 'NIE'}, quality=${verification.allMatchedRepliesPassThreshold ? 'OK' : 'NIE'}, kolejnosc=${verification.sequenceNonDecreasing ? 'OK' : 'NIE'}, data_gaps=${verification.dataGapStopDetected ? 'NIE' : 'OK'}${verification.userMetaTruncated ? ', meta_ucinane=TAK' : ''}`
  );
  lines.push('');

  const stageCount = Number.isInteger(stageMappingCheck?.stageNameCount) ? stageMappingCheck.stageNameCount : 0;
  const promptCount = Number.isInteger(stageMappingCheck?.promptCount) ? stageMappingCheck.promptCount : 0;
  const stageAligned = stageMappingCheck?.alignedByCount === true;
  const missingStageNames = Array.isArray(stageMappingCheck?.missingStageNames) ? stageMappingCheck.missingStageNames : [];
  lines.push('[Mapowanie prompt -> etap]');
  lines.push(`Liczba promptow=${promptCount}, liczba stage names=${stageCount}, align=${stageAligned ? 'TAK' : 'NIE'}`);
  if (missingStageNames.length > 0) {
    lines.push(`Brak nazw etapu dla: ${missingStageNames.join(', ')}`);
  }
  if (stageMapping.length > 0) {
    stageMapping.forEach((entry) => {
      const promptNumber = Number.isInteger(entry?.promptNumber) ? entry.promptNumber : '?';
      const stageName = typeof entry?.stageName === 'string' && entry.stageName.trim()
        ? entry.stageName.trim()
        : '-';
      lines.push(`P${promptNumber}: ${stageName}`);
    });
  } else {
    lines.push('Brak danych mapowania etapow.');
  }
  lines.push('');

  if (promptCoverage.length > 0) {
    lines.push('[Pokrycie etapow]');
    promptCoverage.forEach((entry) => {
      const promptNumber = Number.isInteger(entry?.promptNumber) ? entry.promptNumber : '?';
      const stageName = typeof entry?.stageName === 'string' && entry.stageName.trim()
        ? entry.stageName.trim()
        : '-';
      const occurrences = Number.isInteger(entry?.occurrences) ? entry.occurrences : 0;
      const repliesPresent = Number.isInteger(entry?.repliesPresent) ? entry.repliesPresent : 0;
      const repliesPassingThreshold = Number.isInteger(entry?.repliesPassingThreshold) ? entry.repliesPassingThreshold : 0;
      lines.push(`P${promptNumber} ${stageName}: occ=${occurrences}, present=${repliesPresent}, quality_ok=${repliesPassingThreshold}`);
    });
    lines.push('');
  }

  if (assignmentLog.length > 0) {
    lines.push('[Sekwencja user -> prompt]');
    const limit = 16;
    assignmentLog.slice(0, limit).forEach((entry) => {
      const index = Number.isInteger(entry?.userMessageIndex) ? entry.userMessageIndex : '?';
      const runId = Number.isInteger(entry?.runId) ? entry.runId : null;
      const assignedPrompt = typeof entry?.assignedPrompt === 'string' ? entry.assignedPrompt : '-';
      const stageName = typeof entry?.stageName === 'string' ? entry.stageName : '-';
      const method = typeof entry?.method === 'string' ? entry.method : '-';
      const score = Number.isFinite(entry?.score) ? entry.score : null;
      const signals = typeof entry?.signals === 'string' && entry.signals.trim()
        ? entry.signals.trim()
        : '';
      const assistantReply = typeof entry?.assistantReply === 'string' ? entry.assistantReply : 'no';
      const qualityPass = typeof entry?.qualityPass === 'string' ? entry.qualityPass : 'no';
      lines.push(
        `#${index}${runId ? ` [R${runId}]` : ''}: ${assignedPrompt} | ${stageName} | method=${method}${score !== null ? `, score=${score}` : ''}${signals ? `, signals=${signals}` : ''} | reply=${assistantReply}, quality=${qualityPass}`
      );
    });
    if (assignmentLog.length > limit) {
      lines.push(`... +${assignmentLog.length - limit} kolejnych wpisow`);
    }
    lines.push('');
  }

  if (runResets.length > 0) {
    lines.push('[Restarty runow]');
    runResets.slice(0, 6).forEach((item) => {
      lines.push(
        `R${item.fromRunId} -> R${item.toRunId}: #${item.fromUserMessageIndex} P${item.fromPromptNumber} -> #${item.toUserMessageIndex} P${item.toPromptNumber}`
      );
    });
    if (runResets.length > 6) {
      lines.push(`... +${runResets.length - 6} kolejnych restartow`);
    }
    lines.push('');
  }

  if (sequenceIssues.length > 0) {
    const compactSequenceIssues = sequenceIssues
      .slice(0, 4)
      .map((item) => `R${item.runId || '?'}:#${item.userMessageIndex}:P${item.previousPromptNumber}->P${item.currentPromptNumber}`)
      .join(', ');
    lines.push(`[Problemy kolejnosci] ${compactSequenceIssues}${sequenceIssues.length > 4 ? ', ...' : ''}`);
    lines.push('');
  }

  if (unmatchedUserSamples.length > 0) {
    const compactUnmatched = unmatchedUserSamples
      .slice(0, 3)
      .map((item) => `#${item.userMessageIndex}[${item.reason}]: ${safePreview(item.preview || '', '-')}`)
      .join(' | ');
    lines.push(`[Nierozpoznane user] ${compactUnmatched}${unmatchedUserSamples.length > 3 ? ' | ...' : ''}`);
  }

  return lines.join('\n');
}

async function executeCountCompanyMessagesFromPopup(button) {
  if (!button) return;

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Licze...';
  setRunStatus('Licze wszystkie wiadomosci company na aktywnej konwersacji...');

  try {
    const activeTab = await getActiveTabInCurrentWindow();
    const response = await sendRuntimeMessage({
      type: 'COUNT_COMPANY_CONVERSATION_MESSAGES',
      tabId: Number.isInteger(activeTab?.id) ? activeTab.id : null,
      origin: 'popup-company-conversation-count'
    });
    if (!response || response.success !== true) {
      const errorText = `Liczenie company: ${formatCompanyConversationCountError(response)}`;
      setRunStatus(errorText, true);
      setRestoreProcessWindowsStatus(`Licznik procesu: blad (${formatCompanyConversationCountError(response)})`, true);
      return;
    }

    const responseTotals = response?.totals && typeof response.totals === 'object' ? response.totals : {};
    const hasProcessIssue = (
      (Number.isInteger(responseTotals?.promptRepliesMissing) && responseTotals.promptRepliesMissing > 0)
      || (Number.isInteger(responseTotals?.promptRepliesBelowThreshold) && responseTotals.promptRepliesBelowThreshold > 0)
      || response?.processState === 'needs_action'
    );
    setRunStatus(formatCompanyConversationCountStatus(response), hasProcessIssue);
    setRestoreProcessWindowsStatus(formatCompanyProcessCounterAlert(response), hasProcessIssue);
  } catch (error) {
    const errorText = `Liczenie company: ${error?.message || String(error)}`;
    setRunStatus(errorText, true);
    setRestoreProcessWindowsStatus(`Licznik procesu: blad (${error?.message || String(error)})`, true);
  } finally {
    button.disabled = false;
    button.textContent = originalText || 'Policz wszystkie wiadomosci (company)';
  }
}

async function executeRunAnalysisFromPopup(button, options = {}) {
  if (!button) return;

  const originalHtml = button.innerHTML;
  button.disabled = true;
  button.textContent = 'Uruchamiam...';
  setRunStatus('Uruchamiam analizy...');

  try {
    const payload = {
      type: 'RUN_ANALYSIS',
      origin: typeof options?.origin === 'string' ? options.origin : 'popup-run-analysis',
    };
    if (Number.isInteger(options?.windowId)) {
      payload.windowId = options.windowId;
    }

    const response = await sendRuntimeMessage(payload);
    if (response?.success === false) {
      const runError = response.error || 'Nie udalo sie uruchomic analiz.';
      const runMessage = runError === 'prompts_not_loaded'
        ? 'Blad: Brak promptow company. Odswiez rozszerzenie i sprobuj ponownie.'
        : runError === 'no_supported_tabs'
          ? 'Blad: Brak otwartych kart z obslugiwanych zrodel.'
        : `Blad: ${runError}`;
      setRunStatus(runMessage, true);
      void refreshAnalysisQueueStatus();
      return;
    }

    const queuedCount = Number.isInteger(response?.queuedCount) ? response.queuedCount : 0;
    const queueSummary = formatAnalysisQueueSummary(response, {
      includePrefix: false,
      includeQueue: true
    });
    setRunStatus(`Zakolejkowano ${queuedCount} analiz. ${queueSummary}`);
    void refreshAnalysisQueueStatus();
  } catch (error) {
    setRunStatus(`Blad: ${error?.message || String(error)}`, true);
    void refreshAnalysisQueueStatus();
  } finally {
    button.disabled = false;
    button.innerHTML = originalHtml;
  }
}

function getResumeAllSummary(response) {
  const summary = response?.summary && typeof response.summary === 'object'
    ? response.summary
    : {};
  const rows = Array.isArray(response?.results) ? response.results : [];
  const scannedTabs = Number.isInteger(response?.scannedTabs)
    ? response.scannedTabs
    : Number.isInteger(response?.eligibleProcesses)
      ? response.eligibleProcesses
      : rows.length;
  const startedTabs = Number.isInteger(summary?.started)
    ? summary.started
    : Number.isInteger(response?.startedTabs)
      ? response.startedTabs
      : Number.isInteger(response?.resumedTabs)
        ? response.resumedTabs
        : 0;
  const detectFailed = Number.isInteger(summary?.detect_failed)
    ? summary.detect_failed
    : rows.filter((row) => row?.action === 'detect_failed').length;
  const skippedOutsideInvest = Number.isInteger(summary?.skipped_outside_invest)
    ? summary.skipped_outside_invest
    : rows.filter((row) => row?.action === 'skipped_outside_invest').length;
  const finalStageCompleted = Number.isInteger(summary?.final_stage_completed)
    ? summary.final_stage_completed
    : rows.filter((row) => row?.action === 'final_stage_already_sent').length;
  const startFailed = Number.isInteger(summary?.start_failed)
    ? summary.start_failed
    : rows.filter((row) => row?.action === 'start_failed').length;
  const preparedOk = rows.filter((row) => (
    (typeof row?.prepareStatus === 'string' && row.prepareStatus.trim())
    || (typeof row?.reloadMethod === 'string' && row.reloadMethod.trim())
  )).length;
  const preparedTotal = scannedTabs;
  const promptBlocks = Number.isInteger(summary?.prompt_blocks)
    ? summary.prompt_blocks
    : rows.reduce((sum, row) => sum + (Number.isInteger(row?.userMessageCount) ? row.userMessageCount : 0), 0);
  const responseBlocks = Number.isInteger(summary?.response_blocks)
    ? summary.response_blocks
    : rows.reduce((sum, row) => {
      if (Number.isInteger(row?.responseBlockCount)) return sum + row.responseBlockCount;
      if (Number.isInteger(row?.assistantMessageCount)) return sum + row.assistantMessageCount;
      return sum;
    }, 0);
  const missingRepliesDetected = Number.isInteger(summary?.missing_replies_detected)
    ? summary.missing_replies_detected
    : rows.filter((row) => row?.restartMissingAssistantReply === true).length;
  const dataGapsDetected = Number.isInteger(summary?.data_gaps_detected)
    ? summary.data_gaps_detected
    : rows.filter((row) => {
      if (row?.dataGapDetected === true) return true;
      const marker = [
        typeof row?.reason === 'string' ? row.reason : '',
        typeof row?.restartDecisionReason === 'string' ? row.restartDecisionReason : '',
        typeof row?.recognitionSummary === 'string' ? row.recognitionSummary : ''
      ].join(' ');
      return /\bdata[_\s-]?gaps?\b/i.test(marker);
    }).length;
  const detectedPrompts = Number.isInteger(summary?.detected_prompts)
    ? summary.detected_prompts
    : rows.filter((row) => Number.isInteger(row?.detectedPromptNumber)).length;
  const recognizedSavedStage = Number.isInteger(summary?.recognized_saved_stage)
    ? summary.recognized_saved_stage
    : rows.filter((row) => row?.recognitionSource === 'saved_stage_snapshot' || row?.resumeDecisionSource === 'saved_stage_snapshot').length;
  const recognizedChatDetection = Number.isInteger(summary?.recognized_chat_detection)
    ? summary.recognized_chat_detection
    : rows.filter((row) => row?.recognitionSource === 'chat_fallback_detection' || row?.resumeDecisionSource === 'chat_fallback_detection').length;
  const recognizedCounterFallback = Number.isInteger(summary?.recognized_chat_counter_fallback)
    ? summary.recognized_chat_counter_fallback
    : rows.filter((row) => row?.recognitionSource === 'chat_counter_fallback' || row?.resumeDecisionSource === 'chat_counter_fallback').length;
  const recognizedProgressFallback = Number.isInteger(summary?.recognized_progress_last_resort)
    ? summary.recognized_progress_last_resort
    : rows.filter((row) => row?.recognitionSource === 'progress_last_resort_fallback' || row?.resumeDecisionSource === 'progress_last_resort_fallback').length;
  const recognizedUnresolved = Number.isInteger(summary?.recognized_unresolved)
    ? summary.recognized_unresolved
    : rows.filter((row) => row?.action === 'detect_failed').length;

  return `Procesy: ${scannedTabs}, started: ${startedTabs}, final_completed: ${finalStageCompleted}, start_failed: ${startFailed}, detect_failed: ${detectFailed}, prepare_ok: ${preparedOk}/${preparedTotal}, skipped_outside_invest: ${skippedOutsideInvest}, prompt_bloki: ${promptBlocks}, odpowiedz_bloki: ${responseBlocks}, missing_reply_detected: ${missingRepliesDetected}, data_gaps: ${dataGapsDetected}, detected_prompts: ${detectedPrompts}, rozpoznanie[saved=${recognizedSavedStage}, chat=${recognizedChatDetection}, counter_fb=${recognizedCounterFallback}, progress_fb=${recognizedProgressFallback}, unresolved=${recognizedUnresolved}], pipeline=saved_stage->chat_extract->chat_resolution->fallback->start_dispatch`;
}

async function executeResumeAllFromPopup(button, options = {}) {
  if (!button) return;

  const origin = typeof options?.origin === 'string' ? options.origin : 'popup-resume-all';
  const composerThinkingEffort = typeof options?.composerThinkingEffort === 'string'
    ? options.composerThinkingEffort.trim().toLowerCase()
    : '';
  const hasExplicitThinkingEffort = (
    composerThinkingEffort === 'light'
    || composerThinkingEffort === 'standard'
    || composerThinkingEffort === 'extended'
    || composerThinkingEffort === 'heavy'
  );
  const effortSuffix = composerThinkingEffort ? ` (${composerThinkingEffort})` : '';
  const monitorSessionId = createReloadResumeMonitorSessionId(origin);
  const originalHtml = button.innerHTML;
  button.disabled = true;
  button.textContent = `Wznawiam${effortSuffix}...`;
  setRunStatus(
    composerThinkingEffort
      ? `Wznowienie aktywnych procesow company (INVEST), tryb: ${composerThinkingEffort}.`
      : 'Wznowienie aktywnych procesow company (INVEST)...'
  );

  try {
    const message = {
      type: 'DETECT_LAST_COMPANY_PROMPT_AND_RESUME',
      origin,
      scope: 'active_company_invest_processes',
      monitorSessionId,
      openMonitorWindow: true,
      monitorAutoCloseAfterMs: 40_000
    };
    if (hasExplicitThinkingEffort) {
      message.composerThinkingEffort = composerThinkingEffort;
    }
    const response = await sendRuntimeMessage(message);

    if (!response || Object.keys(response).length === 0) {
      setRunStatus(
        composerThinkingEffort
          ? `Polecenie wznowienia (${composerThinkingEffort}) zostalo wyslane.`
          : 'Polecenie wznowienia zostalo wyslane.'
      );
      return;
    }

    if (response.success === false) {
      setRunStatus(`Blad: ${response.error || 'Nie udalo sie wznowic procesow.'}`, true);
      return;
    }

    setRunStatus(
      composerThinkingEffort
        ? `Tryb ${composerThinkingEffort}: ${getResumeAllSummary(response)}`
        : getResumeAllSummary(response)
    );
  } catch (error) {
    setRunStatus(`Blad: ${error?.message || String(error)}`, true);
  } finally {
    button.disabled = false;
    button.innerHTML = originalHtml;
  }
}

async function executeRepeatLastPromptAllFromPopup(button, options = {}) {
  if (!button) return;

  const origin = typeof options?.origin === 'string' ? options.origin : 'popup-repeat-last-prompt-all';
  const monitorSessionId = createReloadResumeMonitorSessionId(origin);
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Powtarzam...';
  setRunStatus('Powtarzam ostatni prompt we wszystkich aktywnych procesach company...');

  try {
    const response = await sendRuntimeMessage({
      type: 'DETECT_LAST_COMPANY_PROMPT_AND_RESUME',
      origin,
      scope: 'active_company_invest_processes',
      forceRepeatLastPrompt: true,
      monitorSessionId,
      openMonitorWindow: true
    });

    if (!response || Object.keys(response).length === 0) {
      setRunStatus('Polecenie powtorzenia promptu zostalo wyslane.');
      return;
    }

    if (response.success === false) {
      setRunStatus(`Blad: ${response.error || 'Nie udalo sie powtorzyc ostatniego promptu we wszystkich procesach.'}`, true);
      return;
    }

    setRunStatus(`Powtorzanie promptu: ${getResumeAllSummary(response)}`);
  } catch (error) {
    setRunStatus(`Blad: ${error?.message || String(error)}`, true);
  } finally {
    button.disabled = false;
    button.textContent = originalText || 'Powtorz ostatni prompt (wszystkie)';
  }
}

function formatFinalStagePersistenceStatus(finalStagePersistence) {
  const sent = Number.isInteger(finalStagePersistence?.sent) ? finalStagePersistence.sent : null;
  const accepted = Number.isInteger(finalStagePersistence?.accepted) ? finalStagePersistence.accepted : null;
  const failed = Number.isInteger(finalStagePersistence?.failed) ? finalStagePersistence.failed : null;
  const pending = Number.isInteger(finalStagePersistence?.pending)
    ? finalStagePersistence.pending
    : (
      (Number.isInteger(finalStagePersistence?.deferred) ? finalStagePersistence.deferred : 0)
      + (Number.isInteger(finalStagePersistence?.remaining) ? finalStagePersistence.remaining : 0)
    );
  const queueSkipped = finalStagePersistence?.queueSkipped === true;
  const flushSkipped = finalStagePersistence?.flushSkipped === true;
  const skipReasonCode = queueSkipped
    ? (typeof finalStagePersistence?.queueSkipReason === 'string' ? finalStagePersistence.queueSkipReason : '')
    : (flushSkipped
      ? (typeof finalStagePersistence?.flushSkipReason === 'string' ? finalStagePersistence.flushSkipReason : '')
      : '');
  const skipReasonLabel = skipReasonCode ? (getDispatchReasonLabel(skipReasonCode) || skipReasonCode) : '';
  const failureStage = typeof finalStagePersistence?.failureStage === 'string'
    ? finalStagePersistence.failureStage.trim()
    : '';
  const failureReasonCodeRaw = typeof finalStagePersistence?.failureReason === 'string'
    ? finalStagePersistence.failureReason.trim()
    : '';
  const failureReasonCode = failureReasonCodeRaw || skipReasonCode;
  const failureReasonLabel = failureReasonCode
    ? (getDispatchReasonLabel(failureReasonCode) || failureReasonCode)
    : '';
  const failureStatus = Number.isInteger(finalStagePersistence?.failureStatus)
    ? finalStagePersistence.failureStatus
    : null;
  const failureRequestId = typeof finalStagePersistence?.failureRequestId === 'string'
    ? finalStagePersistence.failureRequestId.trim()
    : '';
  const failureIntakeUrl = typeof finalStagePersistence?.failureIntakeUrl === 'string'
    ? finalStagePersistence.failureIntakeUrl.trim()
    : '';
  const conversationLogCount = Number.isInteger(finalStagePersistence?.conversationLogCount)
    ? Math.max(0, finalStagePersistence.conversationLogCount)
    : null;
  const verifyState = typeof finalStagePersistence?.verifyState === 'string'
    ? finalStagePersistence.verifyState.trim()
    : '';
  const verifyEventId = typeof finalStagePersistence?.verifyEventId === 'string'
    ? finalStagePersistence.verifyEventId.trim()
    : '';
  const materializedRowCount = Number.isInteger(finalStagePersistence?.materializedRowCount)
    ? finalStagePersistence.materializedRowCount
    : null;
  const expectedMaterializedRowCount = Number.isInteger(finalStagePersistence?.expectedMaterializedRowCount)
    ? finalStagePersistence.expectedMaterializedRowCount
    : null;
  const hasConversationUrl = finalStagePersistence?.hasConversationUrl === true;
  const conversationSnapshotRefreshed = finalStagePersistence?.conversationSnapshotRefreshed === true;
  const conversationSnapshotSource = typeof finalStagePersistence?.conversationSnapshotSource === 'string'
    ? finalStagePersistence.conversationSnapshotSource.trim()
    : '';
  const diagnosticParts = [];
  if (failureStage) diagnosticParts.push(`etap=${failureStage}`);
  if (failureReasonLabel) diagnosticParts.push(`powod=${failureReasonLabel}`);
  if (failureStatus !== null) diagnosticParts.push(`http=${failureStatus}`);
  if (failureRequestId) diagnosticParts.push(`request_id=${safePreview(failureRequestId, failureRequestId)}`);
  if (failureIntakeUrl) diagnosticParts.push(`url=${safePreview(failureIntakeUrl, failureIntakeUrl)}`);
  if (accepted !== null) diagnosticParts.push(`accepted=${accepted}`);
  if (verifyState) diagnosticParts.push(`verify=${verifyState}`);
  if (verifyEventId) diagnosticParts.push(`event_id=${verifyEventId}`);
  if (materializedRowCount !== null) diagnosticParts.push(`rows=${materializedRowCount}`);
  if (expectedMaterializedRowCount !== null) diagnosticParts.push(`rows_expected=${expectedMaterializedRowCount}`);
  if (conversationLogCount !== null) diagnosticParts.push(`conv_logs=${conversationLogCount}`);
  if (hasConversationUrl) diagnosticParts.push('conv_url=1');
  if (conversationSnapshotRefreshed) diagnosticParts.push('conv_refresh=1');
  if (conversationSnapshotSource) diagnosticParts.push(`conv_source=${safePreview(conversationSnapshotSource, conversationSnapshotSource)}`);
  const diagnosticSuffix = diagnosticParts.length > 0
    ? ` Diagnostyka: ${diagnosticParts.join(', ')}.`
    : '';
  const hasNumericDispatch = sent !== null || failed !== null || pending !== null;

  if (hasNumericDispatch) {
    const safeSent = sent ?? 0;
    const safeAccepted = Math.max(safeSent, accepted ?? 0);
    const safeFailed = failed ?? 0;
    const safePending = pending ?? 0;

    if (safeSent > 0 && safePending === 0 && safeFailed === 0) {
      return `BAZA OK: zapis lokalny + wysylka potwierdzona (wyslano_do_bazy=${safeSent}).`;
    }

    if (safeSent > 0 && (safePending > 0 || safeFailed > 0)) {
      const parts = [`wyslano_do_bazy=${safeSent}`];
      if (safePending > 0) parts.push(`pending=${safePending}`);
      if (safeFailed > 0) parts.push(`bledy=${safeFailed}`);
      return `BAZA CZESCIOWO: ${parts.join(', ')}.${diagnosticSuffix}`;
    }

    if (safePending > 0 && safeSent === 0 && safeFailed === 0) {
      const reasonPart = skipReasonLabel ? `, powod=${skipReasonLabel}` : '';
      return `BAZA: zapis lokalny OK, oczekiwanie na materializacje w DB (accepted=${safeAccepted}, pending=${safePending}${reasonPart}).${diagnosticSuffix}`;
    }

    if (safeFailed > 0 && safeSent === 0) {
      const reasonPart = skipReasonLabel ? `, powod=${skipReasonLabel}` : '';
      return `BAZA: zapis lokalny OK, wysylka nieudana (bledy=${safeFailed}${reasonPart}).${diagnosticSuffix}`;
    }

    if (
      flushSkipped
      && skipReasonCode === 'flush_in_progress'
      && finalStagePersistence?.flushFollowUpScheduled === true
    ) {
      return `BAZA: zapis lokalny OK, wysylka do bazy oczekuje na aktywny flush (follow-up zaplanowany).${diagnosticSuffix}`;
    }

    const fallbackReason = skipReasonLabel ? ` (${skipReasonLabel})` : '';
    return `BAZA: zapis lokalny OK, wysylka do bazy niepotwierdzona (wyslano_do_bazy=0${fallbackReason}).${diagnosticSuffix}`;
  }

  const dispatchSummary = typeof finalStagePersistence?.dispatchSummary === 'string'
    ? finalStagePersistence.dispatchSummary.trim()
    : '';
  if (dispatchSummary) {
    return `BAZA: zapis lokalny OK, ${dispatchSummary}${diagnosticSuffix ? ` ${diagnosticSuffix.trim()}` : ''}`;
  }

  if (finalStagePersistence?.success === true) {
    return 'BAZA: zapis lokalny OK, brak danych o wysylce.';
  }
  return 'BAZA: brak potwierdzenia zapisu.';
}

function formatSmartResumeStatus(response) {
  const startPromptNumber = Number.isInteger(response?.startPromptNumber)
    ? response.startPromptNumber
    : null;
  const detectedPromptNumber = Number.isInteger(response?.detectedPromptNumber)
    ? response.detectedPromptNumber
    : null;
  const retrySamePrompt = response?.retrySamePrompt === true;
  const retryReason = typeof response?.retryReason === 'string' ? response.retryReason : '';

  if (response?.success) {
    if (response?.mode === 'final_stage_persisted') {
      const persistenceSummary = formatFinalStagePersistenceStatus(response?.finalStagePersistence);
      return `Proces zakonczony. Zapisano odpowiedz koncowa. ${persistenceSummary}`;
    }
    if (response?.mode === 'queued') {
      const queueSummary = formatAnalysisQueueSummary(response, {
        includePrefix: false,
        includeQueue: true
      });
      if (startPromptNumber && detectedPromptNumber) {
        return `Wznowienie zakolejkowane od Prompt ${startPromptNumber} (wykryto ostatni: ${detectedPromptNumber}). ${queueSummary}`;
      }
      if (startPromptNumber) {
        return `Wznowienie zakolejkowane od Prompt ${startPromptNumber}. ${queueSummary}`;
      }
      return `Wznowienie zakolejkowane. ${queueSummary}`;
    }
    if (retrySamePrompt && startPromptNumber) {
      if (retryReason === 'assistant_reply_too_short') {
        return `Wznowiono ponownie Prompt ${startPromptNumber} (odpowiedz byla za krotka).`;
      }
      return `Wznowiono ponownie Prompt ${startPromptNumber} (brak odpowiedzi po ostatnim wyslaniu).`;
    }
    if (startPromptNumber && detectedPromptNumber) {
      return `Wznowiono od Prompt ${startPromptNumber} (wykryto ostatni: ${detectedPromptNumber}).`;
    }
    if (startPromptNumber) {
      return `Wznowiono od Prompt ${startPromptNumber}.`;
    }
    return 'Wznowiono automatycznie.';
  }

  const errorCode = typeof response?.error === 'string' ? response.error : '';
  if (errorCode === 'already_at_last_prompt') {
    return 'Proces wyglada na zakonczony (brak kolejnego promptu).';
  }
  if (errorCode === 'prompts_not_loaded') {
    return 'Brak promptow company. Odswiez rozszerzenie i sprobuj ponownie.';
  }
  if (errorCode === 'chat_tab_not_found') {
    return 'Aktywna karta nie jest ChatGPT.';
  }
  if (errorCode === 'signature_not_found' || errorCode === 'empty_user_message') {
    return 'Nie wykryto etapu automatycznie. Otwieram wybor etapu...';
  }
  if (errorCode === 'run_not_found') {
    return 'Brak aktywnego procesu dla tej karty. Otwieram wybor etapu...';
  }
  return `Nie udalo sie automatycznie wznowic (${errorCode || 'unknown'}). Otwieram wybor etapu...`;
}

async function executeSmartResumeStageFromPopup(button, options = {}) {
  if (!button) return;

  const originalHtml = button.innerHTML;
  button.disabled = true;
  setShortcutButtonLabel(button, 'Wykrywam etap...', POPUP_SHORTCUTS.resumeStage);
  setRunStatus('Wykrywam etap i status odpowiedzi...');

  try {
    const response = await sendRuntimeMessage({
      type: 'PROCESS_RESUME_NEXT_STAGE',
      tabId: Number.isInteger(options?.tabId) ? options.tabId : null,
      windowId: Number.isInteger(options?.windowId) ? options.windowId : null,
      chatUrl: typeof options?.chatUrl === 'string' ? options.chatUrl : '',
      title: typeof options?.title === 'string' ? options.title : '',
      openDialogOnly: false
    });

    if (response?.success) {
      setRunStatus(formatSmartResumeStatus(response), false);
      void refreshAnalysisQueueStatus();
      return;
    }

    const statusText = formatSmartResumeStatus(response);
    const errorCode = typeof response?.error === 'string' ? response.error : '';
    const shouldFallbackToDialog = (
      errorCode === 'signature_not_found'
      || errorCode === 'empty_user_message'
      || errorCode === 'run_not_found'
    );

    if (shouldFallbackToDialog) {
      void sendRuntimeMessage({
        type: 'RESUME_STAGE_OPEN',
        tabId: Number.isInteger(options?.tabId) ? options.tabId : null,
        windowId: Number.isInteger(options?.windowId) ? options.windowId : null,
        title: typeof options?.title === 'string' ? options.title : ''
      });
      setRunStatus(statusText, true);
      void refreshAnalysisQueueStatus();
      window.close();
      return;
    }

    setRunStatus(statusText, true);
    void refreshAnalysisQueueStatus();
  } catch (error) {
    void sendRuntimeMessage({
      type: 'RESUME_STAGE_OPEN',
      tabId: Number.isInteger(options?.tabId) ? options.tabId : null,
      windowId: Number.isInteger(options?.windowId) ? options.windowId : null,
      title: typeof options?.title === 'string' ? options.title : ''
    });
    setRunStatus(`Blad auto-wznowienia: ${error?.message || String(error)}. Otwieram wybor etapu...`, true);
    void refreshAnalysisQueueStatus();
    window.close();
  } finally {
    button.disabled = false;
    button.innerHTML = originalHtml;
  }
}

async function writeTextToClipboard(text) {
  const safeText = typeof text === 'string' ? text : '';
  if (!safeText) {
    throw new Error('clipboard_text_empty');
  }

  if (navigator?.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(safeText);
      return;
    } catch (error) {
      // Fall back to execCommand below.
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = safeText;
  textarea.setAttribute('readonly', 'readonly');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } finally {
    textarea.remove();
  }

  if (!copied) {
    throw new Error('clipboard_write_failed');
  }
}

function formatCopyLatestInvestFinalResponseStatus(response) {
  const results = Array.isArray(response?.results) ? response.results : [];
  if (response?.batch === true || response?.scope === 'all_open_windows' || results.length > 1) {
    const requested = Number.isInteger(response?.requested) ? response.requested : results.length;
    const copied = Number.isInteger(response?.copied)
      ? response.copied
      : results.filter((row) => row?.success === true).length;
    const failed = Number.isInteger(response?.failed)
      ? response.failed
      : Math.max(0, requested - copied);
    const windowCount = Number.isInteger(response?.windowCount)
      ? response.windowCount
      : requested;
    const textLength = Number.isInteger(response?.textLength) ? response.textLength : 0;
    const conversationUrlCount = Number.isInteger(response?.conversationUrlCount)
      ? response.conversationUrlCount
      : results.filter((row) => typeof row?.conversationUrl === 'string' && row.conversationUrl.trim()).length;
    const persistenceAttemptedCount = Number.isInteger(response?.persistenceAttemptedCount)
      ? response.persistenceAttemptedCount
      : results.filter((row) => row?.persistence && row.persistence.attempted === true).length;
    const persistenceSuccessCount = Number.isInteger(response?.persistenceSuccessCount)
      ? response.persistenceSuccessCount
      : results.filter((row) => row?.persistence && row.persistence.attempted === true && row.persistence.success === true).length;
    const lines = [
      `Skopiowano finalne odpowiedzi z ${copied}/${requested} okien Invest.`,
      `Otwarte okna Invest: ${windowCount}. Laczna dlugosc: ${textLength} znakow.`
    ];

    if (conversationUrlCount > 0) {
      lines.push(`URL konwersacji: ${conversationUrlCount}/${Math.max(copied, 1)}.`);
    } else {
      lines.push('Brak URL konwersacji.');
    }

    if (persistenceAttemptedCount > 0) {
      lines.push(`Fallback save: ${persistenceSuccessCount}/${persistenceAttemptedCount} OK.`);
    }

    if (failed > 0) {
      const failedPreview = results
        .filter((row) => row?.success !== true)
        .slice(0, 3)
        .map((row) => {
          const label = safePreview(
            row?.title || '',
            Number.isInteger(row?.windowId) ? `W:${row.windowId}` : 'Invest'
          );
          const reason = typeof row?.error === 'string' && row.error.trim()
            ? row.error.trim()
            : 'blad';
          return `${label}: ${reason}`;
        });
      if (failedPreview.length > 0) {
        lines.push(`Nieudane: ${failed}. ${failedPreview.join(' | ')}`);
      } else {
        lines.push(`Nieudane: ${failed}.`);
      }
    }

    return lines.join('\n');
  }

  const title = safePreview(response?.title || '', 'Invest');
  const textLength = Number.isInteger(response?.textLength) ? response.textLength : 0;
  const persistence = response?.persistence && typeof response.persistence === 'object'
    ? response.persistence
    : null;
  const lines = [`Skopiowano finalna odpowiedz z: ${title}.`, `Dlugosc: ${textLength} znakow.`];

  if (typeof response?.conversationUrl === 'string' && response.conversationUrl.trim()) {
    lines.push('URL konwersacji zachowany.');
  } else {
    lines.push('Brak URL konwersacji.');
  }

  if (persistence?.attempted) {
    if (persistence.success === true) {
      lines.push('Fallback save: OK.');
    } else if (typeof persistence.reason === 'string' && persistence.reason.trim()) {
      lines.push(`Fallback save: ${persistence.reason.trim()}.`);
    } else {
      lines.push('Fallback save: nieudany.');
    }
  }

  return lines.join('\n');
}

async function executeCopyLatestInvestFinalResponseFromPopup(button) {
  if (!button) return;

  const originalHtml = button.innerHTML;
  button.disabled = true;
  setShortcutButtonLabel(button, 'Kopiuje...', POPUP_SHORTCUTS.copyFinalResponse);
  setCopyLatestInvestFinalResponseStatus('Pobieram finalne odpowiedzi ze wszystkich otwartych okien Invest...');

  try {
    const response = await sendRuntimeMessage({
      type: 'COPY_LATEST_INVEST_FINAL_RESPONSE',
      origin: 'popup-copy-latest-invest-final-response',
      scope: 'all_open_windows',
      tabReadTimeoutMs: 2600
    });

    if (response?.success === false) {
      reportProblemLogFromUi({
        source: 'popup-copy-latest-invest-final-response',
        title: 'Popup copy latest Invest final response failed',
        status: 'failed',
        reason: typeof response?.error === 'string' ? response.error : 'copy_latest_invest_final_response_failed',
        error: typeof response?.error === 'string' ? response.error : 'copy_latest_invest_final_response_failed',
        message: 'Background did not return a final response payload.',
        signature: [
          'popup-copy-latest-invest-final-response',
          'response-failed',
          response?.error || 'copy_latest_invest_final_response_failed',
          Date.now()
        ].join('|'),
        tabId: Number.isInteger(response?.tabId) ? response.tabId : null,
        windowId: Number.isInteger(response?.windowId) ? response.windowId : null
      });
      setCopyLatestInvestFinalResponseStatus(
        `Blad kopiowania: ${response.error || 'copy_latest_invest_final_response_failed'}.`,
        true
      );
      return;
    }

    const text = typeof response?.text === 'string' ? response.text.trim() : '';
    if (!text) {
      reportProblemLogFromUi({
        source: 'popup-copy-latest-invest-final-response',
        title: 'Popup copy latest Invest final response failed',
        status: 'failed',
        reason: 'clipboard_text_empty',
        error: 'clipboard_text_empty',
        message: 'Background returned success without final response text.',
        signature: ['popup-copy-latest-invest-final-response', 'empty-text', Date.now()].join('|'),
        tabId: Number.isInteger(response?.tabId) ? response.tabId : null,
        windowId: Number.isInteger(response?.windowId) ? response.windowId : null
      });
      setCopyLatestInvestFinalResponseStatus('Brak tekstu finalnej odpowiedzi.', true);
      return;
    }

    await writeTextToClipboard(text);
    setCopyLatestInvestFinalResponseStatus(formatCopyLatestInvestFinalResponseStatus(response), false);
  } catch (error) {
    reportProblemLogFromUi({
      source: 'popup-copy-latest-invest-final-response',
      title: 'Popup copy latest Invest final response failed',
      status: 'failed',
      reason: 'clipboard_write_failed',
      error: error?.message || String(error),
      message: 'Popup failed while copying the final response to clipboard.',
      signature: [
        'popup-copy-latest-invest-final-response',
        'clipboard-failed',
        error?.message || String(error),
        Date.now()
      ].join('|')
    });
    setCopyLatestInvestFinalResponseStatus(`Blad kopiowania: ${error?.message || String(error)}.`, true);
  } finally {
    button.disabled = false;
    button.innerHTML = originalHtml;
  }
}

async function getActiveTabInCurrentWindow() {
  const tabs = await new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (rows) => resolve(Array.isArray(rows) ? rows : []));
  });
  return tabs.length > 0 ? tabs[0] : null;
}

const runBtn = document.getElementById('runBtn');
if (runBtn) {
  runBtn.addEventListener('click', () => {
    withActiveWindowContext(({ windowId }) => {
      void executeRunAnalysisFromPopup(runBtn, {
        windowId,
        origin: 'popup-run-analysis',
      });
    });
  });
}

const resumeAllBtn = document.getElementById('resumeAllBtn');
if (resumeAllBtn) {
  resumeAllBtn.addEventListener('click', () => {
    void executeResumeAllFromPopup(resumeAllBtn, {
      origin: 'popup-resume-all',
    });
  });
}

if (resumeAllExtendedBtn) {
  resumeAllExtendedBtn.addEventListener('click', () => {
    void executeResumeAllFromPopup(resumeAllExtendedBtn, {
      origin: 'popup-resume-all-extended',
      composerThinkingEffort: 'extended',
    });
  });
}

if (resumeAllHeavyBtn) {
  resumeAllHeavyBtn.addEventListener('click', () => {
    void executeResumeAllFromPopup(resumeAllHeavyBtn, {
      origin: 'popup-resume-all-heavy',
      composerThinkingEffort: 'heavy',
    });
  });
}

if (repeatLastPromptAllBtn) {
  repeatLastPromptAllBtn.addEventListener('click', () => {
    void executeRepeatLastPromptAllFromPopup(repeatLastPromptAllBtn, {
      origin: 'popup-repeat-last-prompt-all',
    });
  });
}

if (countCompanyMessagesBtn) {
  countCompanyMessagesBtn.addEventListener('click', () => {
    void executeCountCompanyMessagesFromPopup(countCompanyMessagesBtn);
  });
}

const stopBtn = document.getElementById('stopBtn');
if (stopBtn) {
  stopBtn.addEventListener('click', () => {
    withActiveWindowContext(async ({ windowId }) => {
      await sendRuntimeMessage({
        type: 'STOP_PROCESS',
        windowId,
        origin: 'popup-stop',
      });
      window.close();
    });
  });
}

if (copyLatestInvestFinalResponseBtn) {
  copyLatestInvestFinalResponseBtn.addEventListener('click', () => {
    void executeCopyLatestInvestFinalResponseFromPopup(copyLatestInvestFinalResponseBtn);
  });
}

const manualSourceBtn = document.getElementById('manualSourceBtn');
if (manualSourceBtn) {
  manualSourceBtn.addEventListener('click', () => {
    withActiveWindowContext(({ activeTab }) => {
      const title = activeTab?.title || '';
      const url = activeTab?.url || '';
      const params = new URLSearchParams();
      if (title) params.set('title', title);
      if (url) params.set('url', url);
      const targetUrl = chrome.runtime.getURL(`manual-source.html${params.toString() ? `?${params.toString()}` : ''}`);

      chrome.windows.create({
        url: targetUrl,
        type: 'popup',
        width: 800,
        height: 600,
      });
      window.close();
    });
  });
}

function buildRemoteQueueWindowUrl(params = null) {
  const query = params instanceof URLSearchParams && params.toString()
    ? `?${params.toString()}`
    : '';
  return chrome.runtime.getURL(`remote-queue.html${query}`);
}

function openRemoteQueueWindow(params = null) {
  chrome.windows.create({
    url: buildRemoteQueueWindowUrl(params),
    type: 'popup',
    width: 840,
    height: 760,
  });
  window.close();
}

function formatRemoteQueueErrorMessage(error = '') {
  const normalizedError = typeof error === 'string' ? error.trim() : '';
  if (normalizedError === 'remote_pdf_not_supported_yet') {
    return 'Remote queue: PDF-y trzeba najpierw zamienic na tekst na tym komputerze.';
  }
  if (normalizedError === 'article_text_unavailable') {
    return 'Remote queue: nie udalo sie wyciagnac tekstu z aktywnej karty.';
  }
  return `Remote queue: ${normalizedError || 'remote_prefill_failed'}`;
}

async function openPreparedRemoteQueueFromTab(activeTab) {
  try {
    const sourceTab = activeTab && typeof activeTab === 'object'
      ? {
        id: Number.isInteger(activeTab?.id) ? activeTab.id : null,
        title: typeof activeTab?.title === 'string' ? activeTab.title : '',
        url: typeof activeTab?.url === 'string' ? activeTab.url : '',
        windowId: Number.isInteger(activeTab?.windowId) ? activeTab.windowId : null
      }
      : null;
    setRemoteRunnerStatus('Remote queue: przygotowuje tekst artykulu...', false);
    const response = await sendRuntimeMessage({
      type: 'PREPARE_REMOTE_QUEUE_PREFILL',
      sourceTab
    });
    if (response?.success !== true || !response?.prefillId) {
      setRemoteRunnerStatus(formatRemoteQueueErrorMessage(response?.error), true);
      return;
    }
    const params = new URLSearchParams();
    params.set('prefillId', response.prefillId);
    openRemoteQueueWindow(params);
  } catch (error) {
    setRemoteRunnerStatus(formatRemoteQueueErrorMessage(error?.message || String(error)), true);
  }
}

const remoteQueueBtn = document.getElementById('remoteQueueBtn');
if (remoteQueueBtn) {
  remoteQueueBtn.addEventListener('click', () => {
    withActiveWindowContext(({ activeTab }) => {
      void openPreparedRemoteQueueFromTab(activeTab);
    });
  });
}

if (openRemoteQueueBtn) {
  openRemoteQueueBtn.addEventListener('click', () => {
    openRemoteQueueWindow();
  });
}

const resumeStageBtn = document.getElementById('resumeStageBtn');
if (resumeStageBtn) {
  resumeStageBtn.addEventListener('click', () => {
    withActiveWindowContext(({ activeTab, windowId }) => {
      void executeSmartResumeStageFromPopup(resumeStageBtn, {
        tabId: Number.isInteger(activeTab?.id) ? activeTab.id : null,
        windowId: Number.isInteger(windowId) ? windowId : null,
        chatUrl: typeof activeTab?.url === 'string' ? activeTab.url : '',
        title: typeof activeTab?.title === 'string' ? activeTab.title : ''
      });
    });
  });
}

const decisionPanelBtn = document.getElementById('decisionPanelBtn');
if (decisionPanelBtn) {
  decisionPanelBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('process-monitor.html') });
    window.close();
  });
}

if (unfinishedProcessesBtn) {
  unfinishedProcessesBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('unfinished-processes.html') });
    window.close();
  });
}

const problemLogsBtn = document.getElementById('problemLogsBtn');
if (problemLogsBtn) {
  problemLogsBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('problem-log.html') });
    window.close();
  });
}

const responsesBtn = document.getElementById('responsesBtn');
if (responsesBtn) {
  responsesBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('responses.html') });
    window.close();
  });
}

if (restoreProcessWindowsBtn) {
  restoreProcessWindowsBtn.addEventListener('click', async () => {
    const originalHtml = restoreProcessWindowsBtn.innerHTML;
    restoreProcessWindowsBtn.disabled = true;
    setShortcutButtonLabel(restoreProcessWindowsBtn, 'Przywracam...', POPUP_SHORTCUTS.restoreWindows);
    setRestoreProcessWindowsStatus('Przywracam aktywne procesy na ekran...');

    try {
      const response = await sendRuntimeMessage({
        type: 'RESTORE_PROCESS_WINDOWS',
        origin: 'popup-restore-process-windows',
      });

      if (response?.success === false) {
        setRestoreProcessWindowsStatus(
          `Blad przywracania: ${response.error || response.reason || 'unknown'}.`,
          true
        );
        return;
      }

      const requested = Number.isInteger(response?.requested) ? response.requested : 0;
      const restored = Number.isInteger(response?.restored) ? response.restored : 0;
      const opened = Number.isInteger(response?.opened) ? response.opened : 0;
      const failed = Number.isInteger(response?.failed) ? response.failed : 0;
      const skipped = Number.isInteger(response?.skipped) ? response.skipped : 0;

      setRestoreProcessWindowsStatus(
        `Gotowe. Strony: ${requested}, przywrocone: ${restored}, otwarte: ${opened}, pominiete: ${skipped}, bledy: ${failed}.`,
        failed > 0
      );
    } catch (error) {
      setRestoreProcessWindowsStatus(`Blad przywracania: ${error?.message || String(error)}.`, true);
    } finally {
      restoreProcessWindowsBtn.disabled = false;
      restoreProcessWindowsBtn.innerHTML = originalHtml;
    }
  });
}

if (autoRestoreToggleBtn) {
  autoRestoreToggleBtn.addEventListener('click', async () => {
    const currentlyEnabled = autoRestoreToggleBtn.dataset.enabled === 'true';
    const nextEnabled = !currentlyEnabled;
    const originalHtml = autoRestoreToggleBtn.innerHTML;
    autoRestoreToggleBtn.disabled = true;
    setShortcutButtonLabel(
      autoRestoreToggleBtn,
      nextEnabled ? 'Wlaczam auto...' : 'Wylaczam auto...',
      POPUP_SHORTCUTS.autoRestoreToggle
    );
    setAutoRestoreStatus(nextEnabled ? 'Wlaczam automatyzacje...' : 'Wylaczam automatyzacje...');

    try {
      const response = await sendRuntimeMessage({
        type: 'SET_AUTO_RESTORE_WINDOWS_ENABLED',
        enabled: nextEnabled,
        origin: 'popup-auto-restore-toggle',
      });
      if (response?.success === false) {
        setAutoRestoreStatus(`Automatyzacja: ${response.error || response.reason || 'unknown'}.`, true);
      } else {
        applyAutoRestoreUi(response);
        setAutoRestoreStatus(formatAutoRestoreStatus(response), false);
      }
    } catch (error) {
      setAutoRestoreStatus(`Automatyzacja: ${error?.message || String(error)}`, true);
    } finally {
      autoRestoreToggleBtn.disabled = false;
      if (!autoRestoreToggleBtn.dataset.enabled) {
        autoRestoreToggleBtn.innerHTML = originalHtml;
      }
    }
  });
}

function isTextEntryElement(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = (target.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

function clickIfEnabled(button) {
  if (!button || button.disabled) return;
  button.click();
}

const popupShortcutHandlers = {
  [POPUP_SHORTCUTS.manualSource]: () => clickIfEnabled(manualSourceBtn),
  [POPUP_SHORTCUTS.runAnalysis]: () => clickIfEnabled(runBtn),
  [POPUP_SHORTCUTS.resumeStage]: () => clickIfEnabled(resumeStageBtn),
  [POPUP_SHORTCUTS.resumeAll]: () => clickIfEnabled(resumeAllBtn),
  [POPUP_SHORTCUTS.responses]: () => clickIfEnabled(responsesBtn),
  [POPUP_SHORTCUTS.processPanel]: () => clickIfEnabled(decisionPanelBtn),
  [POPUP_SHORTCUTS.stop]: () => clickIfEnabled(stopBtn),
  [POPUP_SHORTCUTS.copyFinalResponse]: () => clickIfEnabled(copyLatestInvestFinalResponseBtn),
  [POPUP_SHORTCUTS.restoreWindows]: () => clickIfEnabled(restoreProcessWindowsBtn),
  [POPUP_SHORTCUTS.autoRestoreToggle]: () => clickIfEnabled(autoRestoreToggleBtn),
};

function resolvePopupShortcutKey(event) {
  if (!event) return '';
  const key = typeof event.key === 'string' ? event.key.trim() : '';
  if (/^[0-9]$/.test(key)) return key;

  const code = typeof event.code === 'string' ? event.code.trim() : '';
  const digitMatch = code.match(/^Digit([0-9])$/);
  if (digitMatch) return digitMatch[1];
  const numpadMatch = code.match(/^Numpad([0-9])$/);
  if (numpadMatch) return numpadMatch[1];

  return '';
}

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.repeat) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (isTextEntryElement(event.target)) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    window.close();
    return;
  }

  const shortcutKey = resolvePopupShortcutKey(event);
  if (!shortcutKey) return;
  const handler = popupShortcutHandlers[shortcutKey];
  if (!handler) return;

  event.preventDefault();
  handler();
});

function setDispatchButtonsDisabled(disabled) {
  dispatchButtonsBusy = !!disabled;
  applyDispatchButtonsState();
}

if (saveWatchlistTokenBtn) {
  saveWatchlistTokenBtn.addEventListener('click', async () => {
    if (isDispatchInlineManaged(watchlistDispatchStatusSnapshot)) {
      setDispatchStatus('Intake status: konfiguracja centralna aktywna - lokalny klucz nie jest wymagany.', false);
      return;
    }
    const intakeUrl = typeof watchlistIntakeUrlInput?.value === 'string' ? watchlistIntakeUrlInput.value.trim() : '';
    const keyId = typeof watchlistKeyIdInput?.value === 'string' ? watchlistKeyIdInput.value.trim() : '';
    const secret = typeof watchlistSecretInput?.value === 'string' ? watchlistSecretInput.value.trim() : '';
    if (!intakeUrl || !keyId || !secret) {
      setDispatchStatus('Intake status: podaj Intake URL, Key ID i Secret przed zapisem.', true);
      return;
    }

    setDispatchButtonsDisabled(true);
    const originalText = saveWatchlistTokenBtn.textContent;
    saveWatchlistTokenBtn.textContent = 'Zapis...';

    try {
      const response = await sendRuntimeMessage({
        type: 'SET_WATCHLIST_DISPATCH_TOKEN',
        credentials: {
          intakeUrl,
          keyId,
          secret,
        },
      });
      if (response?.success === false) {
        setDispatchStatus(`Intake status: blad zapisu (${response.reason || response.error || 'unknown'}).`, true);
        return;
      }

      if (watchlistSecretInput) {
        watchlistSecretInput.value = '';
      }

      const statusPayload = response?.status && typeof response.status === 'object'
        ? { success: true, ...response.status }
        : response;
      applyDispatchStatusSnapshot(statusPayload);
      setDispatchStatus(formatDispatchStatus(statusPayload), false);
    } catch (error) {
      setDispatchStatus(`Intake status: ${error?.message || String(error)}`, true);
    } finally {
      saveWatchlistTokenBtn.textContent = originalText;
      setDispatchButtonsDisabled(false);
    }
  });
}

if (saveRemoteRunnerConfigBtn) {
  saveRemoteRunnerConfigBtn.addEventListener('click', async () => {
    const originalText = saveRemoteRunnerConfigBtn.textContent;
    saveRemoteRunnerConfigBtn.textContent = 'Zapis...';
    saveRemoteRunnerConfigBtn.disabled = true;
    try {
      const response = await sendRuntimeMessage({
        type: 'SET_REMOTE_RUNNER_CONFIG',
        remoteRunnerEnabled: remoteRunnerEnabledInput?.checked === true,
        remoteRunnerName: remoteRunnerNameInput?.value || '',
        remoteDefaultRunnerId: remoteDefaultRunnerIdInput?.value || ''
      });
      if (response?.success === false) {
        setRemoteRunnerConfigStatus(`Remote config: ${response.error || 'unknown'}`, true);
        return;
      }
      if (remoteThisDeviceIdInput) {
        remoteThisDeviceIdInput.value = typeof response?.thisDeviceId === 'string' ? response.thisDeviceId : '';
      }
      setRemoteRunnerConfigStatus('Remote config zapisany.', false);
      void refreshRemoteRunnerStatus(true);
    } catch (error) {
      setRemoteRunnerConfigStatus(`Remote config: ${error?.message || String(error)}`, true);
    } finally {
      saveRemoteRunnerConfigBtn.textContent = originalText;
      saveRemoteRunnerConfigBtn.disabled = false;
    }
  });
}

if (clearWatchlistTokenBtn) {
  clearWatchlistTokenBtn.addEventListener('click', async () => {
    if (isDispatchInlineManaged(watchlistDispatchStatusSnapshot)) {
      setDispatchStatus('Intake status: konfiguracja centralna aktywna - brak lokalnego klucza do czyszczenia.', false);
      return;
    }
    setDispatchButtonsDisabled(true);
    const originalText = clearWatchlistTokenBtn.textContent;
    clearWatchlistTokenBtn.textContent = 'Czyszcze...';

    try {
      const response = await sendRuntimeMessage({ type: 'CLEAR_WATCHLIST_DISPATCH_TOKEN' });
      if (response?.success === false) {
        setDispatchStatus(`Intake status: blad czyszczenia (${response.error || 'unknown'}).`, true);
        return;
      }

      if (watchlistIntakeUrlInput) watchlistIntakeUrlInput.value = '';
      if (watchlistKeyIdInput) watchlistKeyIdInput.value = '';
      if (watchlistSecretInput) watchlistSecretInput.value = '';

      const statusPayload = response?.status && typeof response.status === 'object'
        ? { success: true, ...response.status }
        : response;
      applyDispatchStatusSnapshot(statusPayload);
      setDispatchStatus(formatDispatchStatus(statusPayload), false);
    } catch (error) {
      setDispatchStatus(`Intake status: ${error?.message || String(error)}`, true);
    } finally {
      clearWatchlistTokenBtn.textContent = originalText;
      setDispatchButtonsDisabled(false);
    }
  });
}

if (flushWatchlistDispatchBtn) {
  flushWatchlistDispatchBtn.addEventListener('click', async () => {
    setDispatchButtonsDisabled(true);
    const originalText = flushWatchlistDispatchBtn.textContent;
    flushWatchlistDispatchBtn.textContent = 'Flush...';

    try {
      const response = await sendRuntimeMessage({
        type: 'FLUSH_WATCHLIST_DISPATCH',
        reason: 'popup_manual_flush',
        forceReload: true,
      });
      if (response?.success === false) {
        setDispatchStatus(`Intake status: blad flush (${response.error || 'unknown'}).`, true);
        return;
      }

      const statusPayload = response?.status && typeof response.status === 'object'
        ? { success: true, ...response.status }
        : response;
      applyDispatchStatusSnapshot(statusPayload);
      const flushSummary = formatDispatchFlushResult(response?.flushResult);
      const baseStatus = formatDispatchStatus(statusPayload);
      setDispatchStatus(`${baseStatus} Flush: ${flushSummary}.`, false);
    } catch (error) {
      setDispatchStatus(`Intake status: ${error?.message || String(error)}`, true);
    } finally {
      flushWatchlistDispatchBtn.textContent = originalText;
      setDispatchButtonsDisabled(false);
    }
  });
}

if (chrome?.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'AUTO_RESTORE_STATUS_UPDATED') return;
    void refreshAutoRestoreStatus(false);
  });
}

installPopupRuntimeProblemLogging();

void Promise.all([
  refreshDispatchStatus(true),
  refreshAutoRestoreStatus(true),
  refreshAnalysisQueueStatus(),
  refreshRemoteRunnerConfig(),
  refreshRemoteRunnerStatus(false),
]);

setInterval(() => {
  void refreshAutoRestoreStatus(false);
  void refreshAnalysisQueueStatus();
  void refreshRemoteRunnerStatus(false);
}, 15000);
