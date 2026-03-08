function withActiveWindowContext(callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs && tabs.length > 0 ? tabs[0] : null;
    callback({
      activeTab,
      windowId: Number.isInteger(activeTab?.windowId) ? activeTab.windowId : null,
    });
  });
}

function sendRuntimeMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        const message = chrome.runtime.lastError.message || 'runtime_error';
        if (message.includes('before a response was received')) {
          resolve({});
          return;
        }
        reject(new Error(message));
        return;
      }
      resolve(response && typeof response === 'object' ? response : {});
    });
  });
}

function summarizeClientErrorValue(rawValue) {
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
    chrome.runtime.sendMessage({
      type: 'REPORT_PROBLEM_LOG',
      entry: {
        level: rawEntry?.level === 'warn' ? 'warn' : 'error',
        source,
        title: typeof rawEntry?.title === 'string' ? rawEntry.title : '',
        reason,
        error,
        message,
        signature
      }
    }, () => {});
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

function openReloadResumeMonitorWindow(sessionId, options = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return;
  const params = new URLSearchParams();
  params.set('sessionId', sessionId.trim());
  params.set('openedAt', String(Date.now()));
  if (typeof options?.origin === 'string' && options.origin.trim()) {
    params.set('origin', options.origin.trim());
  }
  if (typeof options?.composerThinkingEffort === 'string' && options.composerThinkingEffort.trim()) {
    params.set('composerThinkingEffort', options.composerThinkingEffort.trim());
  }
  if (Number.isInteger(options?.autoCloseAfterMs) && options.autoCloseAfterMs > 0) {
    params.set('autoCloseAfterMs', String(options.autoCloseAfterMs));
  }
  const targetUrl = chrome.runtime.getURL(`reload-resume-monitor.html?${params.toString()}`);
  chrome.windows.create({
    url: targetUrl,
    type: 'popup',
    width: 1280,
    height: 900,
    focused: true
  });
}

const runStatus = document.getElementById('runStatus');
const watchlistDispatchStatus = document.getElementById('watchlistDispatchStatus');
const watchlistCredentialsHint = document.getElementById('watchlistCredentialsHint');
const watchlistCredentialsForm = document.getElementById('watchlistCredentialsForm');
const watchlistIntakeUrlInput = document.getElementById('watchlistIntakeUrlInput');
const watchlistKeyIdInput = document.getElementById('watchlistKeyIdInput');
const watchlistSecretInput = document.getElementById('watchlistSecretInput');
const saveWatchlistTokenBtn = document.getElementById('saveWatchlistTokenBtn');
const clearWatchlistTokenBtn = document.getElementById('clearWatchlistTokenBtn');
const flushWatchlistDispatchBtn = document.getElementById('flushWatchlistDispatchBtn');
const remoteRunnerTransportModeInput = document.getElementById('remoteRunnerTransportModeInput');
const remoteRunnerBaseUrlInput = document.getElementById('remoteRunnerBaseUrlInput');
const remoteRunnerNameInput = document.getElementById('remoteRunnerNameInput');
const remoteTargetRunnerIdInput = document.getElementById('remoteTargetRunnerIdInput');
const remoteRunnerToggleBtn = document.getElementById('remoteRunnerToggleBtn');
const copySupportIdBtn = document.getElementById('copySupportIdBtn');
const checkRemoteRunnerBtn = document.getElementById('checkRemoteRunnerBtn');
const runRemoteBtn = document.getElementById('runRemoteBtn');
const runRemoteResumeAllBtn = document.getElementById('runRemoteResumeAllBtn');
const remoteRunnerStatus = document.getElementById('remoteRunnerStatus');
const remoteRunnerJobStatus = document.getElementById('remoteRunnerJobStatus');
const remoteTransferCard = document.getElementById('remoteTransferCard');
const remoteTransferKicker = document.getElementById('remoteTransferKicker');
const remoteTransferSourceName = document.getElementById('remoteTransferSourceName');
const remoteTransferSourceSubtitle = document.getElementById('remoteTransferSourceSubtitle');
const remoteTransferTargetName = document.getElementById('remoteTransferTargetName');
const remoteTransferTargetSubtitle = document.getElementById('remoteTransferTargetSubtitle');
const remoteTransferSourceCount = document.getElementById('remoteTransferSourceCount');
const remoteTransferCharCount = document.getElementById('remoteTransferCharCount');
const remoteTransferPhase = document.getElementById('remoteTransferPhase');
const remoteTransferNote = document.getElementById('remoteTransferNote');
const remoteTransferList = document.getElementById('remoteTransferList');
const remoteTransferFooter = document.getElementById('remoteTransferFooter');
const restoreProcessWindowsBtn = document.getElementById('restoreProcessWindowsBtn');
const repeatLastPromptAllBtn = document.getElementById('repeatLastPromptAllBtn');
const countCompanyMessagesBtn = document.getElementById('countCompanyMessagesBtn');
const resumeAllNoReloadBtn = document.getElementById('resumeAllNoReloadBtn');
const resumeAllExtendedBtn = document.getElementById('resumeAllExtendedBtn');
const resumeAllHeavyBtn = document.getElementById('resumeAllHeavyBtn');
const restoreProcessWindowsStatus = document.getElementById('restoreProcessWindowsStatus');
const autoRestoreToggleBtn = document.getElementById('autoRestoreToggleBtn');
const autoRestoreStatus = document.getElementById('autoRestoreStatus');
const unfinishedProcessesBtn = document.getElementById('unfinishedProcessesBtn');
let watchlistDispatchStatusSnapshot = null;
let dispatchButtonsBusy = false;
let remoteRunnerStatusSnapshot = null;

const REMOTE_RUNNER_TRANSPORT_LOCAL = 'local';
const REMOTE_RUNNER_TRANSPORT_WATCHLIST = 'watchlist';

const POPUP_SHORTCUTS = Object.freeze({
  manualSource: '1',
  runAnalysis: '2',
  runRemote: 'z',
  resumeStage: '3',
  resumeAll: '4',
  resumeAllNoReload: '8',
  responses: '5',
  processPanel: '6',
  stop: '7',
  restoreWindows: '9',
  autoRestoreToggle: '0',
  unfinishedProcesses: 'n',
  problemLogs: 'l',
  repeatLastPromptAll: 'r',
  countCompanyMessages: 'c',
  resumeAllExtended: 'e',
  resumeAllHeavy: 'h'
});

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatShortcutDisplay(shortcutKey) {
  const safeShortcut = typeof shortcutKey === 'string' ? shortcutKey.trim() : '';
  return safeShortcut ? safeShortcut.toUpperCase() : '';
}

function buildShortcutButtonHtml(label, shortcutKey, detail = '') {
  const safeLabel = typeof label === 'string' ? label.trim() : '';
  const safeShortcut = formatShortcutDisplay(shortcutKey);
  const safeDetail = typeof detail === 'string' ? detail.trim() : '';
  const shortcutHtml = safeShortcut ? `<span class="shortcut">${escapeHtml(safeShortcut)}</span>` : '';
  const detailHtml = safeDetail ? `<span class="btn-detail">${escapeHtml(safeDetail)}</span>` : '';
  return `<span class="btn-copy"><span class="btn-label">${escapeHtml(safeLabel)}</span>${detailHtml}</span>${shortcutHtml}`;
}

function setShortcutButtonLabel(button, label, shortcutKey = null, detail = null) {
  if (!button) return;
  const resolvedShortcut = typeof shortcutKey === 'string' && shortcutKey.trim()
    ? shortcutKey.trim()
    : (typeof button.dataset?.shortcutKey === 'string' ? button.dataset.shortcutKey : '');
  const resolvedDetail = typeof detail === 'string'
    ? detail
    : (typeof button.dataset?.shortcutDetail === 'string' ? button.dataset.shortcutDetail : '');
  button.innerHTML = buildShortcutButtonHtml(label, resolvedShortcut, resolvedDetail);
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

function setDispatchStatus(text, isError = false) {
  setStatusElement(watchlistDispatchStatus, text, isError);
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

function setRemoteRunnerStatus(text, isError = false) {
  setStatusElement(remoteRunnerStatus, text, isError);
}

function setRemoteRunnerJobStatus(text, isError = false) {
  setStatusElement(remoteRunnerJobStatus, text, isError);
}

function applyAutoRestoreUi(status) {
  const enabled = !!status?.enabled;
  const periodInMinutes = Number.isInteger(status?.periodInMinutes) && status.periodInMinutes > 0
    ? status.periodInMinutes
    : 5;
  if (autoRestoreToggleBtn) {
    autoRestoreToggleBtn.dataset.shortcutDetail = `Co ${periodInMinutes} min: restore okien, health check i reload+resume`;
    setShortcutButtonLabel(
      autoRestoreToggleBtn,
      enabled ? 'Auto ON' : 'Auto OFF',
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

function formatCompactInteger(value) {
  const safeValue = Number.isFinite(value) ? Number(value) : 0;
  return new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 0 }).format(safeValue);
}

function formatRemoteTransferCharCount(value) {
  const safeValue = Number.isFinite(value) ? Number(value) : 0;
  if (safeValue >= 1000) {
    return `${formatCompactInteger(Math.round(safeValue / 1000))}k znak.`;
  }
  return `${formatCompactInteger(safeValue)} znak.`;
}

function deriveRemotePreviewHostLabel(sourceUrl, sourceName) {
  const safeUrl = typeof sourceUrl === 'string' ? sourceUrl.trim() : '';
  if (safeUrl) {
    if (safeUrl.startsWith('manual://')) return 'manual';
    try {
      const parsed = new URL(safeUrl);
      const hostname = String(parsed.hostname || '').trim().replace(/^www\./i, '');
      if (hostname) return hostname;
    } catch (_) {
      // Ignore invalid URLs in popup preview.
    }
  }
  return safePreview(sourceName || 'source', 'source');
}

function normalizeRemoteTransferPreview(rawPreview) {
  if (!rawPreview || typeof rawPreview !== 'object') return null;
  const rawItems = Array.isArray(rawPreview.items) ? rawPreview.items : [];
  const items = rawItems
    .filter((item) => item && typeof item === 'object')
    .slice(0, 6)
    .map((item, index) => {
      const title = typeof item.title === 'string' && item.title.trim()
        ? item.title.trim()
        : `Artykul ${index + 1}`;
      const sourceUrl = typeof item.sourceUrl === 'string'
        ? item.sourceUrl.trim()
        : (typeof item.source_url === 'string' ? item.source_url.trim() : '');
      const sourceName = typeof item.sourceName === 'string'
        ? item.sourceName.trim()
        : (typeof item.source_name === 'string' ? item.source_name.trim() : '');
      const hostLabel = typeof item.hostLabel === 'string' && item.hostLabel.trim()
        ? item.hostLabel.trim()
        : deriveRemotePreviewHostLabel(sourceUrl, sourceName);
      const charCount = Number.isInteger(item.charCount)
        ? item.charCount
        : (typeof item.text === 'string' ? item.text.trim().length : 0);
      return {
        title: safePreview(title, `Artykul ${index + 1}`),
        sourceUrl,
        sourceName,
        hostLabel,
        charCount: Math.max(0, charCount),
      };
    });
  const sourceCount = Number.isInteger(rawPreview.sourceCount)
    ? rawPreview.sourceCount
    : items.length;
  const totalChars = Number.isInteger(rawPreview.totalChars)
    ? rawPreview.totalChars
    : items.reduce((sum, item) => sum + item.charCount, 0);
  const hiddenCount = Number.isInteger(rawPreview.hiddenCount)
    ? rawPreview.hiddenCount
    : Math.max(0, sourceCount - items.length);
  return {
    sourceCount: Math.max(items.length, sourceCount),
    totalChars,
    hiddenCount,
    sourceMode: typeof rawPreview.sourceMode === 'string' ? rawPreview.sourceMode.trim() : '',
    usesRunnerPrompts: rawPreview.usesRunnerPrompts === true,
    items,
  };
}

function buildRemoteTransferPreviewFromJob(job) {
  if (!job || typeof job !== 'object') return null;
  const directPreview = normalizeRemoteTransferPreview(job.transferPreview);
  if (directPreview) return directPreview;
  const payload = job.requestPayload && typeof job.requestPayload === 'object' ? job.requestPayload : null;
  const preparedSources = Array.isArray(payload?.preparedSources) ? payload.preparedSources : [];
  if (preparedSources.length === 0) return null;
  return normalizeRemoteTransferPreview({
    sourceCount: preparedSources.length,
    totalChars: preparedSources.reduce((sum, item) => sum + (typeof item?.text === 'string' ? item.text.trim().length : 0), 0),
    usesRunnerPrompts: payload?.usesRunnerPrompts === true || payload?.uses_runner_prompts === true,
    sourceMode: typeof job.sourceMode === 'string' ? job.sourceMode : '',
    items: preparedSources.slice(0, 6).map((item) => ({
      title: typeof item?.title === 'string' ? item.title : '',
      sourceUrl: typeof item?.source_url === 'string' ? item.source_url : (typeof item?.sourceUrl === 'string' ? item.sourceUrl : ''),
      sourceName: typeof item?.source_name === 'string' ? item.source_name : (typeof item?.sourceName === 'string' ? item.sourceName : ''),
      charCount: typeof item?.text === 'string' ? item.text.trim().length : 0,
    })),
  });
}

function resolveRemoteTransferPhase(status) {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (normalized === 'queued') {
    return { tone: 'sending', kicker: 'Transfer w toku', phaseLabel: 'Wyslane' };
  }
  if (normalized === 'claimed' || normalized === 'received') {
    return { tone: 'sending', kicker: 'Drugi laptop odebral paczke', phaseLabel: 'Odebrane' };
  }
  if (normalized === 'started' || normalized === 'running') {
    return { tone: 'sending', kicker: 'Proces ruszyl na drugim laptopie', phaseLabel: 'Uruchomione' };
  }
  if (normalized === 'completed') {
    return { tone: 'success', kicker: 'Transfer i start zakonczone', phaseLabel: 'Zakonczone' };
  }
  if (normalized === 'completed_with_errors') {
    return { tone: 'error', kicker: 'Zakonczone z bledami', phaseLabel: 'Z bledami' };
  }
  if (normalized === 'failed' || normalized === 'cancelled' || normalized === 'canceled') {
    return { tone: 'error', kicker: 'Transfer przerwany', phaseLabel: 'Blad' };
  }
  return { tone: 'sending', kicker: 'Przygotowanie transferu', phaseLabel: 'Przygotowanie' };
}

function renderRemoteTransferCard(view = null) {
  if (!remoteTransferCard) return;
  if (!view || view.visible !== true) {
    remoteTransferCard.hidden = true;
    remoteTransferCard.className = 'remote-transfer-card';
    if (remoteTransferList) remoteTransferList.innerHTML = '';
    return;
  }

  remoteTransferCard.hidden = false;
  remoteTransferCard.className = `remote-transfer-card is-${view.tone || 'sending'}`;
  if (remoteTransferKicker) remoteTransferKicker.textContent = view.kicker || 'Transfer';
  if (remoteTransferSourceName) remoteTransferSourceName.textContent = view.sourceName || 'Ten laptop';
  if (remoteTransferSourceSubtitle) remoteTransferSourceSubtitle.textContent = view.sourceSubtitle || 'wybor artykulow';
  if (remoteTransferTargetName) remoteTransferTargetName.textContent = view.targetName || 'Drugi laptop';
  if (remoteTransferTargetSubtitle) remoteTransferTargetSubtitle.textContent = view.targetSubtitle || 'uruchomienie procesu';
  if (remoteTransferSourceCount) remoteTransferSourceCount.textContent = formatCompactInteger(view.sourceCount || 0);
  if (remoteTransferCharCount) remoteTransferCharCount.textContent = formatRemoteTransferCharCount(view.totalChars || 0);
  if (remoteTransferPhase) remoteTransferPhase.textContent = view.phaseLabel || '-';
  if (remoteTransferNote) remoteTransferNote.textContent = view.note || 'Wysylany jest tylko tekst artykulow. Prompty sa lokalne na drugim laptopie.';
  if (remoteTransferFooter) remoteTransferFooter.textContent = view.footer || '';
  if (remoteTransferList) {
    const items = Array.isArray(view.items) ? view.items : [];
    remoteTransferList.innerHTML = items.map((item) => `
      <div class="remote-transfer-item">
        <div class="remote-transfer-item-top">
          <span class="remote-transfer-item-title">${escapeHtml(item.title || 'Artykul')}</span>
          <span class="remote-transfer-item-size">${escapeHtml(formatRemoteTransferCharCount(item.charCount || 0))}</span>
        </div>
        <div class="remote-transfer-item-subtitle">${escapeHtml(item.hostLabel || item.sourceName || 'source')}</div>
      </div>
    `).join('');
  }
}

function buildRemoteTransferCardView(status, override = {}) {
  const controllerJob = status?.controllerJob && typeof status.controllerJob === 'object' ? status.controllerJob : null;
  const runnerJob = status?.runnerJob && typeof status.runnerJob === 'object' ? status.runnerJob : null;
  const job = runnerJob || controllerJob || null;
  const preview = normalizeRemoteTransferPreview(override.preview)
    || buildRemoteTransferPreviewFromJob(job)
    || buildRemoteTransferPreviewFromJob(controllerJob);
  const explicitError = typeof override.error === 'string' ? override.error.trim() : '';

  if (!preview && !explicitError && override.forceVisible !== true) {
    return null;
  }

  const lifecycle = explicitError
    ? { tone: 'error', kicker: 'Transfer nieudany', phaseLabel: 'Blad' }
    : resolveRemoteTransferPhase(override.status || job?.status || '');
  const targetRunner = override.runner && typeof override.runner === 'object'
    ? override.runner
    : (status?.targetRunner && typeof status.targetRunner === 'object' ? status.targetRunner : null);
  const targetName = typeof targetRunner?.runnerName === 'string' && targetRunner.runnerName.trim()
    ? targetRunner.runnerName.trim()
    : safePreview(targetRunner?.runnerId || '', 'drugi laptop');
  const sourceMode = preview?.sourceMode || override.sourceMode || '';
  const sourceModeLabel = sourceMode === 'manual_text' ? 'tekst reczny' : 'otwarte artykuly';
  const hiddenCount = preview?.hiddenCount || 0;
  const footerParts = [];
  if (job?.jobId) footerParts.push(`Job: ${safePreview(job.jobId)}`);
  footerParts.push(`Tryb: ${sourceModeLabel}`);
  if (preview?.usesRunnerPrompts === true) footerParts.push('Prompty zostaja na drugim laptopie');
  if (hiddenCount > 0) footerParts.push(`+${hiddenCount} kolejne pozycje`);
  if (explicitError) footerParts.push(`Blad: ${formatRemoteRunnerError(explicitError)}`);

  return {
    visible: true,
    tone: lifecycle.tone,
    kicker: lifecycle.kicker,
    phaseLabel: lifecycle.phaseLabel,
    sourceName: 'Ten laptop',
    sourceSubtitle: 'wybor i wysylka tekstu',
    targetName,
    targetSubtitle: lifecycle.tone === 'success'
      ? 'proces uruchomiony'
      : (lifecycle.tone === 'error' ? 'wymaga uwagi' : 'odbior i start procesu'),
    sourceCount: preview?.sourceCount || 0,
    totalChars: preview?.totalChars || 0,
    note: explicitError
      ? `Wysylka nie doszla do skutku. ${formatRemoteRunnerError(explicitError)}.`
      : 'Wysylamy tylko tekst artykulow. Prompty sa lokalne na drugim laptopie.',
    footer: footerParts.join(' | '),
    items: Array.isArray(preview?.items) ? preview.items : [],
  };
}

function normalizeRemoteRunnerTransportMode(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === REMOTE_RUNNER_TRANSPORT_LOCAL
    ? REMOTE_RUNNER_TRANSPORT_LOCAL
    : REMOTE_RUNNER_TRANSPORT_WATCHLIST;
}

function isLocalRunnerIpv4(hostname) {
  const text = typeof hostname === 'string' ? hostname.trim() : '';
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!match) return false;
  const octets = match.slice(1).map((item) => Number.parseInt(item, 10));
  if (octets.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return false;
  const [a, b] = octets;
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isLocalRunnerIpv6(hostname) {
  const text = typeof hostname === 'string' ? hostname.trim().toLowerCase() : '';
  if (!text) return false;
  if (text === '::1' || text === '[::1]') return true;
  const normalized = text.replace(/^\[/, '').replace(/\]$/, '');
  return normalized.startsWith('fc')
    || normalized.startsWith('fd')
    || normalized.startsWith('fe8')
    || normalized.startsWith('fe9')
    || normalized.startsWith('fea')
    || normalized.startsWith('feb');
}

function isSafeLocalRunnerHostname(hostname) {
  const text = typeof hostname === 'string' ? hostname.trim().toLowerCase() : '';
  if (!text) return false;
  if (text === 'localhost') return true;
  if (text.endsWith('.local') || text.endsWith('.lan') || text.endsWith('.home.arpa') || text.endsWith('.ts.net')) {
    return true;
  }
  return isLocalRunnerIpv4(text) || isLocalRunnerIpv6(text);
}

function normalizeLocalRemoteRunnerBaseUrl(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  try {
    const parsed = new URL(text);
    const protocol = String(parsed.protocol || '').toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') return '';
    const hostname = String(parsed.hostname || '').toLowerCase();
    if (!isSafeLocalRunnerHostname(hostname)) return '';
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function buildOriginPatternFromBaseUrl(baseUrl) {
  const normalized = normalizeLocalRemoteRunnerBaseUrl(baseUrl);
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    return `${parsed.protocol}//${parsed.host}/*`;
  } catch {
    return '';
  }
}

async function ensureRemoteRunnerBaseUrlPermission(baseUrl) {
  const pattern = buildOriginPatternFromBaseUrl(baseUrl);
  if (!pattern || !chrome?.permissions?.contains || !chrome?.permissions?.request) {
    return { success: true };
  }
  const contains = await chrome.permissions.contains({ origins: [pattern] });
  if (contains) return { success: true };
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) {
    return { success: false, error: 'remote_runner_origin_permission_denied' };
  }
  return { success: true };
}

function formatRemoteRunnerStateLabel(status) {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (normalized === 'ready') return 'gotowy';
  if (normalized === 'busy') return 'zajety';
  if (normalized === 'stale') return 'nieaktywny';
  if (normalized === 'online') return 'online';
  return normalized || 'offline';
}

function formatRemoteJobStateLabel(status) {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (normalized === 'queued') return 'w kolejce';
  if (normalized === 'claimed') return 'przyjete';
  if (normalized === 'received') return 'odebrane';
  if (normalized === 'started') return 'uruchomione';
  if (normalized === 'running') return 'w toku';
  if (normalized === 'completed') return 'zakonczone';
  if (normalized === 'completed_with_errors') return 'zakonczone z bledami';
  if (normalized === 'failed') return 'blad';
  if (normalized === 'cancelled' || normalized === 'canceled') return 'anulowane';
  return normalized || 'brak';
}

function formatRemoteRunnerError(error) {
  const normalized = typeof error === 'string' ? error.trim().toLowerCase() : '';
  if (!normalized) return 'blad zdalnego startu';
  if (normalized === 'runner_id_missing') return 'brak wybranego komputera';
  if (normalized === 'local_runner_requires_manual_runner_id') return 'w trybie lokalnym wpisz ID komputera recznie';
  if (normalized === 'local_runner_base_url_missing') return 'brak adresu relay w trybie lokalnym';
  if (normalized === 'local_runner_base_url_invalid') return 'adres relay musi wskazywac localhost / LAN / Tailscale';
  if (normalized === 'remote_runner_origin_permission_denied') return 'brak zgody na polaczenie z adresem relay';
  if (normalized === 'local_runner_unreachable') return 'relay lokalny nie odpowiada';
  if (normalized === 'local_runner_client_not_allowed') return 'relay lokalny odrzucil polaczenie spoza localhost/LAN';
  if (normalized === 'controller_not_allowed') return 'ten komputer sterujacy nie jest na liscie relay';
  if (normalized === 'runner_id_matches_current_device') return 'wybrano ten sam komputer';
  if (normalized === 'no_remote_runner_discovered') return 'brak drugiego komputera z odbiorem zdalnym';
  if (normalized === 'multiple_remote_runners_detected') return 'wykryto wiele komputerow, wpisz ID recznie';
  if (normalized === 'runner_not_found') return 'wybrany komputer nie zostal znaleziony';
  if (normalized === 'remote_runner_list_failed') return 'blad pobierania listy komputerow';
  if (normalized === 'remote_runner_status_failed') return 'blad odczytu stanu komputera';
  if (normalized === 'remote_job_create_failed') return 'blad tworzenia zdalnego zadania';
  if (normalized === 'remote_start_failed') return 'zdalny start nie udal sie';
  if (normalized === 'run_remote_reload_resume_failed') return 'nie udalo sie wyslac zdalnego restartu + wznowienia';
  if (normalized === 'remote_reload_resume_failed') return 'zdalne restart + wznow nie udalo sie';
  if (normalized === 'remote_runner_command_not_supported') return 'runner nie obsluguje tego polecenia';
  if (normalized === 'set_remote_runner_settings_failed') return 'nie udalo sie zapisac ustawien zdalnego startu';
  if (normalized === 'http_413' || normalized === 'payload_too_large') return 'payload jest za duzy dla serwera';
  if (normalized === 'remote_batch_prepare_failed') return 'nie udalo sie przygotowac paczki artykulow';
  if (normalized === 'prompts_not_loaded') return 'prompty company nie sa zaladowane';
  if (normalized.startsWith('runner_')) {
    return `komputer ${normalized.slice('runner_'.length).replace(/_/g, ' ')}`;
  }
  return normalized;
}

function formatRemoteRunnerUiErrorText(rawError) {
  const candidate = typeof rawError === 'string'
    ? rawError.trim()
    : (typeof rawError?.message === 'string'
      ? rawError.message.trim()
      : String(rawError || '').trim());
  if (!candidate) return 'Zdalny start: blad.';
  if (/^[a-z0-9_:-]+$/i.test(candidate)) {
    return `Zdalny start: ${formatRemoteRunnerError(candidate)}.`;
  }
  return `Zdalny start: ${candidate}`;
}

function formatRemoteRunnerSummary(record, fallbackId = '') {
  if (!record || typeof record !== 'object') {
    return fallbackId ? `Komputer ${safePreview(fallbackId)}: offline.` : 'Komputer: brak danych.';
  }
  const runnerId = typeof record.runnerId === 'string' && record.runnerId.trim()
    ? record.runnerId.trim()
    : fallbackId;
  const runnerName = typeof record.runnerName === 'string' && record.runnerName.trim()
    ? record.runnerName.trim()
    : '';
  const label = formatRemoteRunnerStateLabel(record.status);
  const parts = [`Komputer ${runnerName ? `${runnerName} ` : ''}(${safePreview(runnerId, 'n/a')}): ${label}.`];
  if (record.promptsLoaded === false) parts.push('Prompty: brak.');
  if (record.chatgptReady === false) parts.push('ChatGPT: niegotowy.');
  if (typeof record.activeJobId === 'string' && record.activeJobId.trim()) {
    parts.push(
      `Aktywne zadanie: ${safePreview(record.activeJobId)}${
        record.activeJobStatus ? ` (${formatRemoteJobStateLabel(record.activeJobStatus)})` : ''
      }.`
    );
  }
  if (Number.isInteger(record.lastSeenAgeSeconds)) {
    parts.push(`Ostatni sygnal: ${record.lastSeenAgeSeconds}s temu.`);
  }
  return parts.join(' ');
}

function getRemoteJobCommandType(job) {
  const payload = job?.requestPayload && typeof job.requestPayload === 'object' ? job.requestPayload : null;
  const direct = typeof job?.commandType === 'string' && job.commandType.trim()
    ? job.commandType.trim().toLowerCase()
    : '';
  if (direct) return direct;
  if (typeof payload?.commandType === 'string' && payload.commandType.trim()) {
    return payload.commandType.trim().toLowerCase();
  }
  if (typeof payload?.command_type === 'string' && payload.command_type.trim()) {
    return payload.command_type.trim().toLowerCase();
  }
  return '';
}

function getRemoteJobKind(job) {
  const commandType = getRemoteJobCommandType(job);
  if (commandType) return 'command';
  const directJobKind = typeof job?.jobKind === 'string' && job.jobKind.trim()
    ? job.jobKind.trim().toLowerCase()
    : '';
  if (directJobKind === 'command' || directJobKind === 'analysis') return directJobKind;
  const payload = job?.requestPayload && typeof job.requestPayload === 'object' ? job.requestPayload : null;
  const preparedSources = Array.isArray(payload?.preparedSources) ? payload.preparedSources : [];
  if (preparedSources.length > 0) return 'analysis';
  const jobType = typeof job?.jobType === 'string' && job.jobType.trim()
    ? job.jobType.trim().toLowerCase()
    : (typeof payload?.jobType === 'string' && payload.jobType.trim()
      ? payload.jobType.trim().toLowerCase()
      : (typeof payload?.job_type === 'string' && payload.job_type.trim() ? payload.job_type.trim().toLowerCase() : ''));
  if (jobType === 'command' || jobType === 'analysis') return jobType;
  return '';
}

function getRemoteJobDisplayLabel(job) {
  const commandType = getRemoteJobCommandType(job);
  if (commandType === 'reload_resume_active_company_processes') {
    return 'restart + wznow';
  }
  const jobKind = getRemoteJobKind(job);
  if (jobKind === 'analysis') return 'analiza';
  if (jobKind === 'command') return 'polecenie runnera';
  return 'zadanie';
}

function formatRemoteCommandResultSummary(resultPayload) {
  if (!resultPayload || typeof resultPayload !== 'object') return '';
  const parts = [];
  if (Number.isInteger(resultPayload.scannedTabs)) parts.push(`skan=${resultPayload.scannedTabs}`);
  if (Number.isInteger(resultPayload.startedTabs)) parts.push(`start=${resultPayload.startedTabs}`);
  if (Number.isInteger(resultPayload.resumedTabs)) parts.push(`wznowione=${resultPayload.resumedTabs}`);
  const summary = resultPayload.summary && typeof resultPayload.summary === 'object' ? resultPayload.summary : null;
  if (summary) {
    const issues = (
      (Number.isInteger(summary.detect_failed) ? summary.detect_failed : 0)
      + (Number.isInteger(summary.reload_failed) ? summary.reload_failed : 0)
      + (Number.isInteger(summary.start_failed) ? summary.start_failed : 0)
    );
    if (issues > 0) parts.push(`problemy=${issues}`);
  }
  return parts.length > 0 ? `Procesy: ${parts.join(', ')}.` : '';
}

function formatRemoteJobSummary(job, fallbackLabel = 'Zadanie') {
  if (!job || typeof job !== 'object') return `${fallbackLabel}: brak.`;
  const jobId = typeof job.jobId === 'string' && job.jobId.trim() ? job.jobId.trim() : 'n/a';
  const status = formatRemoteJobStateLabel(job.status);
  const staleText = job.isStale === true ? ', nieaktualne' : '';
  const jobLabel = getRemoteJobDisplayLabel(job);
  const parts = [`${fallbackLabel}: ${jobLabel}, ${status}${staleText} (${safePreview(jobId)}).`];
  if (typeof job.error === 'string' && job.error.trim()) {
    parts.push(`Blad: ${safePreview(job.error, job.error)}.`);
  }
  const resultPayload = job.resultPayload && typeof job.resultPayload === 'object' ? job.resultPayload : null;
  if (resultPayload) {
    if (getRemoteJobKind(job) === 'command') {
      const commandSummary = formatRemoteCommandResultSummary(resultPayload);
      if (commandSummary) {
        parts.push(commandSummary);
      }
    } else {
      const successCount = Number.isInteger(resultPayload.successCount) ? resultPayload.successCount : null;
      const failureCount = Number.isInteger(resultPayload.failureCount) ? resultPayload.failureCount : null;
      if (successCount !== null || failureCount !== null) {
        parts.push(`Wynik: OK=${successCount ?? 0}, bledy=${failureCount ?? 0}.`);
      }
    }
  }
  return parts.join(' ');
}

function applyRemoteRunnerUi(status) {
  remoteRunnerStatusSnapshot = status && typeof status === 'object' ? status : null;
  const settings = remoteRunnerStatusSnapshot?.settings && typeof remoteRunnerStatusSnapshot.settings === 'object'
    ? remoteRunnerStatusSnapshot.settings
    : {};
  if (remoteRunnerTransportModeInput && document.activeElement !== remoteRunnerTransportModeInput) {
    remoteRunnerTransportModeInput.value = normalizeRemoteRunnerTransportMode(settings.transportMode);
  }
  if (remoteRunnerBaseUrlInput && document.activeElement !== remoteRunnerBaseUrlInput) {
    remoteRunnerBaseUrlInput.value = typeof settings.localBaseUrl === 'string' ? settings.localBaseUrl : '';
  }
  if (remoteRunnerNameInput && document.activeElement !== remoteRunnerNameInput) {
    remoteRunnerNameInput.value = typeof settings.runnerName === 'string' ? settings.runnerName : '';
  }
  if (remoteTargetRunnerIdInput && document.activeElement !== remoteTargetRunnerIdInput) {
    remoteTargetRunnerIdInput.value = typeof settings.controllerRunnerId === 'string'
      ? settings.controllerRunnerId
      : '';
  }
  if (remoteRunnerToggleBtn) {
    remoteRunnerToggleBtn.dataset.enabled = settings.enabled === true ? 'true' : 'false';
    remoteRunnerToggleBtn.textContent = settings.enabled === true ? 'Ten komputer: ON' : 'Ten komputer: OFF';
  }
}

function formatRemoteRunnerStatusView(status) {
  if (!status || status.success === false) {
    return `Zdalny start: ${formatRemoteRunnerError(status?.error || 'blad statusu')}.`;
  }
  const lines = [];
  const transportMode = normalizeRemoteRunnerTransportMode(status?.settings?.transportMode);
  const localBaseUrl = typeof status?.settings?.localBaseUrl === 'string'
    ? status.settings.localBaseUrl.trim()
    : '';
  const supportId = typeof status.supportId === 'string' && status.supportId.trim() ? status.supportId.trim() : '';
  lines.push(
    transportMode === REMOTE_RUNNER_TRANSPORT_LOCAL
      ? `Polaczenie: relay lokalny${localBaseUrl ? ` (${safePreview(localBaseUrl, localBaseUrl)})` : ''}.`
      : 'Polaczenie: Watchlist API.'
  );
  lines.push(`ID tego komputera: ${safePreview(supportId, 'brak ID')}.`);
  if (status?.settings?.enabled === true) {
    lines.push('Odbior zadan na tym komputerze: wlaczony.');
    lines.push(formatRemoteRunnerSummary(status.localRunner, supportId));
  } else {
    lines.push('Odbior zadan na tym komputerze: wylaczony.');
  }
  const targetRunnerId = typeof status?.settings?.controllerRunnerId === 'string'
    ? status.settings.controllerRunnerId.trim()
    : '';
  const discoveredRunners = Array.isArray(status.discoveredRunners) ? status.discoveredRunners : [];
  const resolvedTargetSource = typeof status.resolvedTargetSource === 'string'
    ? status.resolvedTargetSource
    : '';
  if (status.targetRunner) {
    const targetLabel = resolvedTargetSource.startsWith('auto')
      ? 'Wybrany komputer (auto)'
      : 'Wybrany komputer';
    const targetId = typeof status?.targetRunner?.runnerId === 'string' && status.targetRunner.runnerId.trim()
      ? status.targetRunner.runnerId.trim()
      : targetRunnerId;
    lines.push(`${targetLabel}: ${formatRemoteRunnerSummary(status.targetRunner, targetId)}`);
  } else if (targetRunnerId) {
    if (status.targetRunnerError) {
      lines.push(`Wybrany komputer: ${safePreview(targetRunnerId)} -> ${formatRemoteRunnerError(status.targetRunnerError)}.`);
    } else {
      lines.push(`Wybrany komputer: ${safePreview(targetRunnerId)}.`);
    }
  } else if (transportMode === REMOTE_RUNNER_TRANSPORT_LOCAL) {
    lines.push('Tryb lokalny: wpisz ID drugiego komputera i adres relay.');
  } else if (discoveredRunners.length === 1) {
    lines.push(`Auto-wybor: ${formatRemoteRunnerSummary(discoveredRunners[0], discoveredRunners[0].runnerId || '')}`);
  } else if (discoveredRunners.length > 1) {
    lines.push(`Auto-wybor: wykryto ${discoveredRunners.length} komputerow.`);
    discoveredRunners.slice(0, 3).forEach((runner, index) => {
      lines.push(`Komputer ${index + 1}: ${formatRemoteRunnerSummary(runner, runner?.runnerId || '')}`);
    });
  } else if (status.discoveredRunnersError) {
    lines.push(`Auto-wybor: ${formatRemoteRunnerError(status.discoveredRunnersError)}.`);
  } else {
    lines.push('Auto-wybor: brak drugiego komputera.');
  }
  if (status.promptsLoaded === false) {
    lines.push('Prompty company nie sa wczytane.');
  }
  return lines.join('\n');
}

function formatRemoteRunnerJobStatusView(status) {
  if (!status || status.success === false) return '';
  const lines = [];
  if (status.controllerJob) {
    lines.push(formatRemoteJobSummary(status.controllerJob, 'Zadanie wysylajace'));
  } else if (status.controllerJobError) {
    lines.push(`Zadanie wysylajace: ${status.controllerJobError}.`);
  }
  if (status.runnerJob) {
    lines.push(formatRemoteJobSummary(status.runnerJob, 'Zadanie na drugim komputerze'));
  } else if (status.runnerJobError) {
    lines.push(`Zadanie na drugim komputerze: ${status.runnerJobError}.`);
  }
  return lines.join('\n');
}

async function refreshRemoteRunnerStatus(forceSync = false) {
  if (!remoteRunnerStatus) return;
  try {
    const response = await sendRuntimeMessage({
      type: 'GET_REMOTE_RUNNER_STATUS',
      forceSync,
    });
    applyRemoteRunnerUi(response);
    setRemoteRunnerStatus(formatRemoteRunnerStatusView(response), response?.success === false);
    const jobText = formatRemoteRunnerJobStatusView(response);
    setRemoteRunnerJobStatus(jobText, false);
    renderRemoteTransferCard(buildRemoteTransferCardView(response));
  } catch (error) {
    applyRemoteRunnerUi(null);
    setRemoteRunnerStatus(formatRemoteRunnerUiErrorText(error), true);
    setRemoteRunnerJobStatus('', false);
    renderRemoteTransferCard(null);
  }
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
  flush_skipped_disabled: 'flush pominiety (dispatch off)',
  flush_skipped_in_progress: 'flush pominiety (w toku)',
  flush_start: 'start flush',
  flush_empty: 'flush pustej kolejki',
  flush_item_invalid: 'pozycja kolejki niepoprawna',
  flush_item_deferred: 'pozycja odlozona',
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
  return `sent=${flushResult.sent || 0}, failed=${flushResult.failed || 0}, deferred=${flushResult.deferred || 0}, remaining=${flushResult.remaining || 0}`;
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
    lines.push('Akcja procesu: uruchom "Powtorz ostatni prompt (wszystkie)" albo "Reload + wznow wszystkie".');
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

  const originalHtml = button.innerHTML;
  button.disabled = true;
  setShortcutButtonLabel(button, 'Licze...');
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
    button.innerHTML = originalHtml;
  }
}

async function executeRunAnalysisFromPopup(button, options = {}) {
  if (!button) return;

  const originalHtml = button.innerHTML;
  button.disabled = true;
  setShortcutButtonLabel(button, 'Uruchamiam...');
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
        : `Blad: ${runError}`;
      setRunStatus(runMessage, true);
      return;
    }

    setRunStatus('Uruchomiono analizy.');
  } catch (error) {
    setRunStatus(`Blad: ${error?.message || String(error)}`, true);
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
  const reloadBeforeResume = response?.reloadBeforeResume !== false;
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
  const reloadFailed = Number.isInteger(summary?.reload_failed)
    ? summary.reload_failed
    : rows.filter((row) => row?.action === 'reload_failed').length;
  const skippedOutsideInvest = Number.isInteger(summary?.skipped_outside_invest)
    ? summary.skipped_outside_invest
    : rows.filter((row) => row?.action === 'skipped_outside_invest').length;
  const finalStageCompleted = Number.isInteger(summary?.final_stage_completed)
    ? summary.final_stage_completed
    : rows.filter((row) => row?.action === 'final_stage_already_sent').length;
  const startFailed = Number.isInteger(summary?.start_failed)
    ? summary.start_failed
    : rows.filter((row) => row?.action === 'start_failed').length;
  const reloadOk = Number.isInteger(summary?.reload_ok)
    ? summary.reload_ok
    : rows.filter((row) => typeof row?.reloadMethod === 'string' && row.reloadMethod.trim()).length;
  const reloadTotal = Number.isInteger(summary?.reload_total)
    ? summary.reload_total
    : rows.length;
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
  const modePart = reloadBeforeResume
    ? `reload_ok: ${reloadOk}/${reloadTotal}`
    : 'tryb: bez_reloadu';

  return `Procesy: ${scannedTabs}, started: ${startedTabs}, final_completed: ${finalStageCompleted}, start_failed: ${startFailed}, detect_failed: ${detectFailed}, reload_failed: ${reloadFailed}, ${modePart}, skipped_outside_invest: ${skippedOutsideInvest}, prompt_bloki: ${promptBlocks}, odpowiedz_bloki: ${responseBlocks}, missing_reply_detected: ${missingRepliesDetected}, data_gaps: ${dataGapsDetected}, detected_prompts: ${detectedPrompts}, rozpoznanie[saved=${recognizedSavedStage}, chat=${recognizedChatDetection}, counter_fb=${recognizedCounterFallback}, progress_fb=${recognizedProgressFallback}, unresolved=${recognizedUnresolved}], pipeline=saved_stage->chat_extract->chat_resolution->fallback->start_dispatch`;
}

async function executeResumeAllFromPopup(button, options = {}) {
  if (!button) return;

  const origin = typeof options?.origin === 'string' ? options.origin : 'popup-resume-all';
  const reloadBeforeResume = options?.reloadBeforeResume !== false;
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
  setShortcutButtonLabel(
    button,
    reloadBeforeResume
      ? `Restart + wznawiam${effortSuffix}...`
      : `Wznawiam bez reloadu${effortSuffix}...`
  );
  setRunStatus(
    reloadBeforeResume
      ? (
        composerThinkingEffort
          ? `Restart/reload + wznowienie aktywnych procesow company (INVEST): stop -> reload -> detekcja etapu -> start, tryb: ${composerThinkingEffort}.`
          : 'Restart/reload + wznowienie aktywnych procesow company (INVEST): stop -> reload -> detekcja etapu -> start.'
      )
      : (
        composerThinkingEffort
          ? `Wznowienie aktywnych procesow company (INVEST) bez reloadu: stop -> detekcja etapu -> start, tryb: ${composerThinkingEffort}.`
          : 'Wznowienie aktywnych procesow company (INVEST) bez reloadu: stop -> detekcja etapu -> start.'
      )
  );
  openReloadResumeMonitorWindow(monitorSessionId, {
    origin,
    composerThinkingEffort,
    autoCloseAfterMs: 40_000
  });

  try {
    const message = {
      type: 'DETECT_LAST_COMPANY_PROMPT_AND_RESUME',
      origin,
      scope: 'active_company_invest_processes',
      monitorSessionId,
      reloadBeforeResume
    };
    if (hasExplicitThinkingEffort) {
      message.composerThinkingEffort = composerThinkingEffort;
    }
    const response = await sendRuntimeMessage(message);

    if (!response || Object.keys(response).length === 0) {
      setRunStatus(
        reloadBeforeResume
          ? (
            composerThinkingEffort
              ? `Polecenie reload + wznowienia (${composerThinkingEffort}) zostalo wyslane.`
              : 'Polecenie reload + wznowienia zostalo wyslane.'
          )
          : (
            composerThinkingEffort
              ? `Polecenie wznowienia bez reloadu (${composerThinkingEffort}) zostalo wyslane.`
              : 'Polecenie wznowienia bez reloadu zostalo wyslane.'
          )
      );
      return;
    }

    if (response.success === false) {
      setRunStatus(
        `Blad: ${response.error || (reloadBeforeResume ? 'Nie udalo sie wykonac reload + wznowienia procesow.' : 'Nie udalo sie wykonac wznowienia bez reloadu.')}`,
        true
      );
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

async function executeCheckRemoteRunnerFromPopup(button) {
  if (!button) return;
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Sprawdzam...';
  setRemoteRunnerStatus('Sprawdzam drugi komputer do zdalnego startu...', false);

  try {
    await saveRemoteRunnerSettingsFromPopup();
    const runnerId = typeof remoteTargetRunnerIdInput?.value === 'string'
      ? remoteTargetRunnerIdInput.value.trim()
      : '';
    const response = await sendRuntimeMessage(runnerId
      ? {
          type: 'CHECK_REMOTE_RUNNER',
          runnerId
        }
      : {
          type: 'CHECK_REMOTE_RUNNER'
        });
    if (response?.success === false) {
      setRemoteRunnerStatus(formatRemoteRunnerUiErrorText(response.error || 'blad sprawdzenia runnera'), true);
      return;
    }
    await refreshRemoteRunnerStatus(true);
  } catch (error) {
    setRemoteRunnerStatus(formatRemoteRunnerUiErrorText(error), true);
  } finally {
    button.disabled = false;
    button.textContent = originalText || 'Sprawdz cel';
  }
}

async function executeRunRemoteAnalysisFromPopup(button) {
  if (!button) return;
  const originalHtml = button.innerHTML;
  button.disabled = true;
  setShortcutButtonLabel(button, 'Wysylam...', POPUP_SHORTCUTS.runRemote);
  setRunStatus('Przygotowuje artykuly i wysylam je na drugi komputer...');
  renderRemoteTransferCard(buildRemoteTransferCardView(null, {
    forceVisible: true,
    status: 'queued',
    preview: {
      sourceCount: 0,
      totalChars: 0,
      items: [],
      hiddenCount: 0,
    },
  }));

  try {
    await saveRemoteRunnerSettingsFromPopup();
    const runnerId = typeof remoteTargetRunnerIdInput?.value === 'string'
      ? remoteTargetRunnerIdInput.value.trim()
      : '';
    const response = await sendRuntimeMessage(runnerId
      ? {
          type: 'RUN_REMOTE_ANALYSIS',
          runnerId,
          origin: 'popup-run-remote-analysis'
        }
      : {
          type: 'RUN_REMOTE_ANALYSIS',
          origin: 'popup-run-remote-analysis'
        });
    if (response?.success === false) {
      setRunStatus(formatRemoteRunnerUiErrorText(response.error || 'remote_start_failed'), true);
      renderRemoteTransferCard(buildRemoteTransferCardView(remoteRunnerStatusSnapshot, {
        forceVisible: true,
        error: response.error || 'remote_start_failed',
      }));
      await refreshRemoteRunnerStatus(true);
      return;
    }
    const runnerLabel = typeof response?.runner?.runnerName === 'string' && response.runner.runnerName.trim()
      ? response.runner.runnerName.trim()
      : safePreview(response?.runner?.runnerId || '', 'runner');
    setRunStatus(
      `Wyslano analize do ${runnerLabel}. Zadanie=${safePreview(response?.job?.jobId || '', 'n/a')}, artykuly=${response?.preparedSourceCount || 0}, pominiete=${response?.skippedSourceCount || 0}.`,
      false
    );
    renderRemoteTransferCard(buildRemoteTransferCardView({
      controllerJob: response?.job || null,
      runnerJob: null,
      targetRunner: response?.runner || null,
    }, {
      status: response?.job?.status || 'queued',
      preview: response?.transferPreview || null,
      runner: response?.runner || null,
      sourceMode: response?.sourceMode || '',
      forceVisible: true,
    }));
    await refreshRemoteRunnerStatus(true);
  } catch (error) {
    setRunStatus(formatRemoteRunnerUiErrorText(error), true);
    renderRemoteTransferCard(buildRemoteTransferCardView(remoteRunnerStatusSnapshot, {
      forceVisible: true,
      error: error?.message || String(error),
    }));
  } finally {
    button.disabled = false;
    button.innerHTML = originalHtml;
  }
}

async function executeRunRemoteResumeAllFromPopup(button) {
  if (!button) return;
  const originalHtml = button.innerHTML;
  button.disabled = true;
  setShortcutButtonLabel(button, 'Wysylam polecenie...');
  setRunStatus('Wysylam na drugi komputer polecenie restart + wznow...');

  try {
    await saveRemoteRunnerSettingsFromPopup();
    const runnerId = typeof remoteTargetRunnerIdInput?.value === 'string'
      ? remoteTargetRunnerIdInput.value.trim()
      : '';
    const response = await sendRuntimeMessage(runnerId
      ? {
          type: 'RUN_REMOTE_RELOAD_RESUME',
          runnerId,
          origin: 'popup-run-remote-reload-resume'
        }
      : {
          type: 'RUN_REMOTE_RELOAD_RESUME',
          origin: 'popup-run-remote-reload-resume'
        });
    if (response?.success === false) {
      setRunStatus(formatRemoteRunnerUiErrorText(response.error || 'run_remote_reload_resume_failed'), true);
      await refreshRemoteRunnerStatus(true);
      return;
    }

    const runnerLabel = typeof response?.runner?.runnerName === 'string' && response.runner.runnerName.trim()
      ? response.runner.runnerName.trim()
      : safePreview(response?.runner?.runnerId || '', 'runner');
    setRunStatus(
      `Wyslano polecenie restart + wznow do ${runnerLabel}. Zadanie=${safePreview(response?.job?.jobId || '', 'n/a')}.`,
      false
    );
    await refreshRemoteRunnerStatus(true);
  } catch (error) {
    setRunStatus(formatRemoteRunnerUiErrorText(error), true);
  } finally {
    button.disabled = false;
    button.innerHTML = originalHtml;
  }
}

async function saveRemoteRunnerSettingsFromPopup(patch = {}) {
  const transportMode = normalizeRemoteRunnerTransportMode(
    typeof remoteRunnerTransportModeInput?.value === 'string'
      ? remoteRunnerTransportModeInput.value
      : ''
  );
  const localBaseUrlRaw = typeof remoteRunnerBaseUrlInput?.value === 'string'
    ? remoteRunnerBaseUrlInput.value.trim()
    : '';
  const localBaseUrl = transportMode === REMOTE_RUNNER_TRANSPORT_LOCAL
    ? normalizeLocalRemoteRunnerBaseUrl(localBaseUrlRaw)
    : '';
  if (transportMode === REMOTE_RUNNER_TRANSPORT_LOCAL && localBaseUrlRaw && !localBaseUrl) {
    throw new Error('local_runner_base_url_invalid');
  }
  if (transportMode === REMOTE_RUNNER_TRANSPORT_LOCAL && localBaseUrl) {
    const permissionResult = await ensureRemoteRunnerBaseUrlPermission(localBaseUrl);
    if (!permissionResult.success) {
      throw new Error(permissionResult.error || 'remote_runner_origin_permission_denied');
    }
  }
  const runnerName = typeof remoteRunnerNameInput?.value === 'string'
    ? remoteRunnerNameInput.value.trim()
    : '';
  const controllerRunnerId = typeof remoteTargetRunnerIdInput?.value === 'string'
    ? remoteTargetRunnerIdInput.value.trim()
    : '';
  const response = await sendRuntimeMessage({
    type: 'SET_REMOTE_RUNNER_SETTINGS',
    transportMode,
    localBaseUrl,
    runnerName,
    controllerRunnerId,
    ...patch
  });
  if (response?.success === false) {
    throw new Error(response.error || 'set_remote_runner_settings_failed');
  }
  return response;
}

async function executeRepeatLastPromptAllFromPopup(button, options = {}) {
  if (!button) return;

  const origin = typeof options?.origin === 'string' ? options.origin : 'popup-repeat-last-prompt-all';
  const monitorSessionId = createReloadResumeMonitorSessionId(origin);
  const originalHtml = button.innerHTML;
  button.disabled = true;
  setShortcutButtonLabel(button, 'Powtarzam...');
  setRunStatus('Powtarzam ostatni prompt we wszystkich aktywnych procesach company...');
  openReloadResumeMonitorWindow(monitorSessionId, {
    origin,
    forceRepeatLastPrompt: true
  });

  try {
    const response = await sendRuntimeMessage({
      type: 'DETECT_LAST_COMPANY_PROMPT_AND_RESUME',
      origin,
      scope: 'active_company_invest_processes',
      forceRepeatLastPrompt: true,
      monitorSessionId
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
    button.innerHTML = originalHtml;
  }
}

function formatFinalStagePersistenceStatus(finalStagePersistence) {
  const sent = Number.isInteger(finalStagePersistence?.sent) ? finalStagePersistence.sent : null;
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
      return `BAZA: zapis lokalny OK, wysylka do bazy w kolejce (pending=${safePending}${reasonPart}).${diagnosticSuffix}`;
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
  setRunStatus('Wykrywam etap aktywnej karty i sprawdzam, czy powtorzyc ten sam czy uruchomic kolejny prompt...');

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
      chrome.runtime.sendMessage({
        type: 'RESUME_STAGE_OPEN',
        tabId: Number.isInteger(options?.tabId) ? options.tabId : null,
        windowId: Number.isInteger(options?.windowId) ? options.windowId : null,
        title: typeof options?.title === 'string' ? options.title : ''
      });
      setRunStatus(statusText, true);
      window.close();
      return;
    }

    setRunStatus(statusText, true);
  } catch (error) {
    chrome.runtime.sendMessage({
      type: 'RESUME_STAGE_OPEN',
      tabId: Number.isInteger(options?.tabId) ? options.tabId : null,
      windowId: Number.isInteger(options?.windowId) ? options.windowId : null,
      title: typeof options?.title === 'string' ? options.title : ''
    });
    setRunStatus(`Blad auto-wznowienia: ${error?.message || String(error)}. Otwieram wybor etapu...`, true);
    window.close();
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

async function fallbackCopyText(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'readonly');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    const copied = document.execCommand('copy');
    if (!copied) throw new Error('execCommand_copy_failed');
  } finally {
    textarea.remove();
  }
}

async function copyTextToClipboard(text) {
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  await fallbackCopyText(text);
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

if (remoteRunnerToggleBtn) {
  remoteRunnerToggleBtn.addEventListener('click', async () => {
    const enabledNow = remoteRunnerToggleBtn.dataset.enabled === 'true';
    const nextEnabled = !enabledNow;
    const originalText = remoteRunnerToggleBtn.textContent;
    remoteRunnerToggleBtn.disabled = true;
    remoteRunnerToggleBtn.textContent = nextEnabled ? 'Ten komputer: ON...' : 'Ten komputer: OFF...';
    try {
      await saveRemoteRunnerSettingsFromPopup({ enabled: nextEnabled });
      await refreshRemoteRunnerStatus(true);
    } catch (error) {
      setRemoteRunnerStatus(formatRemoteRunnerUiErrorText(error), true);
      remoteRunnerToggleBtn.textContent = originalText || 'Ten komputer';
    } finally {
      remoteRunnerToggleBtn.disabled = false;
    }
  });
}

if (copySupportIdBtn) {
  copySupportIdBtn.addEventListener('click', async () => {
    try {
      const status = remoteRunnerStatusSnapshot?.supportId
        ? remoteRunnerStatusSnapshot
        : await sendRuntimeMessage({ type: 'GET_REMOTE_RUNNER_STATUS', forceSync: false });
      const supportId = typeof status?.supportId === 'string' ? status.supportId.trim() : '';
      if (!supportId) {
        setRemoteRunnerStatus('Zdalny start: brak ID tego komputera.', true);
        return;
      }
      await copyTextToClipboard(supportId);
      setRemoteRunnerStatus(`Skopiowano ID tego komputera: ${supportId}`, false);
    } catch (error) {
      setRemoteRunnerStatus(formatRemoteRunnerUiErrorText(error), true);
    }
  });
}

if (checkRemoteRunnerBtn) {
  checkRemoteRunnerBtn.addEventListener('click', () => {
    void executeCheckRemoteRunnerFromPopup(checkRemoteRunnerBtn);
  });
}

if (runRemoteBtn) {
  runRemoteBtn.addEventListener('click', () => {
    void executeRunRemoteAnalysisFromPopup(runRemoteBtn);
  });
}

if (runRemoteResumeAllBtn) {
  runRemoteResumeAllBtn.addEventListener('click', () => {
    void executeRunRemoteResumeAllFromPopup(runRemoteResumeAllBtn);
  });
}

if (remoteRunnerNameInput) {
  remoteRunnerNameInput.addEventListener('change', () => {
    void saveRemoteRunnerSettingsFromPopup().then(() => refreshRemoteRunnerStatus(false)).catch((error) => {
      setRemoteRunnerStatus(formatRemoteRunnerUiErrorText(error), true);
    });
  });
}

if (remoteRunnerTransportModeInput) {
  remoteRunnerTransportModeInput.addEventListener('change', () => {
    void saveRemoteRunnerSettingsFromPopup().then(() => refreshRemoteRunnerStatus(false)).catch((error) => {
      setRemoteRunnerStatus(formatRemoteRunnerUiErrorText(error), true);
    });
  });
}

if (remoteRunnerBaseUrlInput) {
  remoteRunnerBaseUrlInput.addEventListener('change', () => {
    void saveRemoteRunnerSettingsFromPopup().then(() => refreshRemoteRunnerStatus(false)).catch((error) => {
      setRemoteRunnerStatus(formatRemoteRunnerUiErrorText(error), true);
    });
  });
}

if (remoteTargetRunnerIdInput) {
  remoteTargetRunnerIdInput.addEventListener('change', () => {
    void saveRemoteRunnerSettingsFromPopup().then(() => refreshRemoteRunnerStatus(false)).catch((error) => {
      setRemoteRunnerStatus(formatRemoteRunnerUiErrorText(error), true);
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

if (resumeAllNoReloadBtn) {
  resumeAllNoReloadBtn.addEventListener('click', () => {
    void executeResumeAllFromPopup(resumeAllNoReloadBtn, {
      origin: 'popup-resume-all-no-reload',
      reloadBeforeResume: false,
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
    withActiveWindowContext(({ windowId }) => {
      chrome.runtime.sendMessage(
        {
          type: 'STOP_PROCESS',
          windowId,
          origin: 'popup-stop',
        },
        () => {
          window.close();
        }
      );
    });
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
  [POPUP_SHORTCUTS.runRemote]: () => clickIfEnabled(runRemoteBtn),
  [POPUP_SHORTCUTS.resumeStage]: () => clickIfEnabled(resumeStageBtn),
  [POPUP_SHORTCUTS.resumeAll]: () => clickIfEnabled(resumeAllBtn),
  [POPUP_SHORTCUTS.resumeAllNoReload]: () => clickIfEnabled(resumeAllNoReloadBtn),
  [POPUP_SHORTCUTS.responses]: () => clickIfEnabled(responsesBtn),
  [POPUP_SHORTCUTS.processPanel]: () => clickIfEnabled(decisionPanelBtn),
  [POPUP_SHORTCUTS.stop]: () => clickIfEnabled(stopBtn),
  [POPUP_SHORTCUTS.restoreWindows]: () => clickIfEnabled(restoreProcessWindowsBtn),
  [POPUP_SHORTCUTS.autoRestoreToggle]: () => clickIfEnabled(autoRestoreToggleBtn),
  [POPUP_SHORTCUTS.unfinishedProcesses]: () => clickIfEnabled(unfinishedProcessesBtn),
  [POPUP_SHORTCUTS.problemLogs]: () => clickIfEnabled(problemLogsBtn),
  [POPUP_SHORTCUTS.repeatLastPromptAll]: () => clickIfEnabled(repeatLastPromptAllBtn),
  [POPUP_SHORTCUTS.countCompanyMessages]: () => clickIfEnabled(countCompanyMessagesBtn),
  [POPUP_SHORTCUTS.resumeAllExtended]: () => clickIfEnabled(resumeAllExtendedBtn),
  [POPUP_SHORTCUTS.resumeAllHeavy]: () => clickIfEnabled(resumeAllHeavyBtn),
};

function resolvePopupShortcutKey(event) {
  if (!event) return '';
  const key = typeof event.key === 'string' ? event.key.trim() : '';
  if (/^[0-9]$/.test(key)) return key;
  if (/^[a-z]$/i.test(key)) return key.toLowerCase();

  const code = typeof event.code === 'string' ? event.code.trim() : '';
  const digitMatch = code.match(/^Digit([0-9])$/);
  if (digitMatch) return digitMatch[1];
  const keyMatch = code.match(/^Key([A-Z])$/);
  if (keyMatch) return keyMatch[1].toLowerCase();
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
  refreshRemoteRunnerStatus(true),
]);

setInterval(() => {
  void refreshAutoRestoreStatus(false);
  void refreshRemoteRunnerStatus(false);
}, 15000);
