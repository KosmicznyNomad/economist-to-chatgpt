const refreshBtn = document.getElementById('refresh-btn');
const remoteBtn = document.getElementById('remote-btn');
const copyBtn = document.getElementById('copy-btn');
const clearBtn = document.getElementById('clear-btn');
const supportIdInput = document.getElementById('support-id-input');
const meta = document.getElementById('meta');
const statusEl = document.getElementById('status');
const rowsBody = document.getElementById('rows-body');

let lastEntries = [];
let autoRefreshTimer = null;
let refreshInFlight = false;
let currentSupportId = '';
let currentViewMode = 'local';

function sendRuntimeMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || 'runtime_error'));
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
    : 'problem-log-ui';
  const message = typeof rawEntry?.message === 'string' && rawEntry.message.trim()
    ? rawEntry.message.trim()
    : 'problem_log_ui_error';
  const error = typeof rawEntry?.error === 'string' ? rawEntry.error.trim() : '';
  const reason = typeof rawEntry?.reason === 'string' ? rawEntry.reason.trim() : '';
  const signature = typeof rawEntry?.signature === 'string' && rawEntry.signature.trim()
    ? rawEntry.signature.trim()
    : ['problem-log-ui', source, rawEntry?.title || '', reason, error, message].join('|');
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
    // Ignore runtime bridge errors in UI page.
  }
}

function installProblemLogRuntimeProblemLogging() {
  window.addEventListener('error', (event) => {
    const fileName = typeof event?.filename === 'string' ? event.filename.trim() : '';
    const lineNo = Number.isInteger(event?.lineno) ? event.lineno : null;
    const colNo = Number.isInteger(event?.colno) ? event.colno : null;
    const location = fileName
      ? `${fileName}${lineNo !== null ? `:${lineNo}` : ''}${colNo !== null ? `:${colNo}` : ''}`
      : '';
    const errorText = summarizeClientErrorValue(event?.error || event?.message || '');
    reportProblemLogFromUi({
      source: 'problem-log-window',
      title: 'Problem log page runtime error',
      reason: location || 'problem_log_page_error',
      error: errorText,
      message: typeof event?.message === 'string' && event.message.trim()
        ? event.message.trim()
        : (errorText || 'problem_log_runtime_error')
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reasonText = summarizeClientErrorValue(event?.reason);
    reportProblemLogFromUi({
      source: 'problem-log-window',
      title: 'Problem log page unhandled rejection',
      reason: 'unhandledrejection',
      error: reasonText,
      message: reasonText || 'problem_log_unhandled_rejection'
    });
  });
}

function setStatus(text, isError = false) {
  const safeText = typeof text === 'string' ? text.trim() : '';
  if (!safeText) {
    statusEl.hidden = true;
    statusEl.textContent = '';
    statusEl.classList.remove('error');
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = safeText;
  statusEl.classList.toggle('error', !!isError);
}

function formatDateTime(ts) {
  if (!Number.isInteger(ts) || ts <= 0) return '-';
  try {
    return new Date(ts).toLocaleString();
  } catch (error) {
    return '-';
  }
}

function formatPrompt(entry) {
  if (!entry || typeof entry !== 'object') return '-';
  const current = Number.isInteger(entry.currentPrompt) ? entry.currentPrompt : null;
  const total = Number.isInteger(entry.totalPrompts) ? entry.totalPrompts : null;
  if (current === null && total === null) return '-';
  return `${current ?? '?'}${total !== null ? `/${total}` : ''}`;
}

function formatStage(entry) {
  if (!entry || typeof entry !== 'object') return '-';
  const stageName = typeof entry.stageName === 'string' ? entry.stageName.trim() : '';
  const stageIndex = Number.isInteger(entry.stageIndex) ? entry.stageIndex : null;
  if (stageName && stageIndex !== null) return `${stageName} (#${stageIndex})`;
  if (stageName) return stageName;
  if (stageIndex !== null) return `#${stageIndex}`;
  return '-';
}

function formatTabWindow(entry) {
  if (!entry || typeof entry !== 'object') return '-';
  const tab = Number.isInteger(entry.tabId) ? entry.tabId : '-';
  const windowId = Number.isInteger(entry.windowId) ? entry.windowId : '-';
  return `T:${tab} W:${windowId}`;
}

function formatReason(entry) {
  if (!entry || typeof entry !== 'object') return '-';
  const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
  const category = typeof entry.category === 'string' ? entry.category.trim() : '';
  if (category && reason) return `${category} | ${reason}`;
  if (category) return category;
  if (reason) return reason;
  return '-';
}

function renderMeta(entries, total) {
  const safeEntries = Array.isArray(entries) ? entries : [];
  const safeTotal = Number.isInteger(total) ? total : safeEntries.length;
  const errorCount = safeEntries.filter((entry) => entry?.level === 'error').length;
  const warnCount = safeEntries.filter((entry) => entry?.level === 'warn').length;
  const infoCount = safeEntries.filter((entry) => entry?.level === 'info').length;
  const categoryCounts = safeEntries.reduce((acc, entry) => {
    const category = typeof entry?.category === 'string' ? entry.category.trim() : '';
    if (!category) return acc;
    acc[category] = (acc[category] || 0) + 1;
    return acc;
  }, {});
  const categorySummary = Object.entries(categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => `${name}=${count}`)
    .join(', ');
  const newest = safeEntries.length > 0 ? safeEntries[0] : null;
  const oldest = safeEntries.length > 0 ? safeEntries[safeEntries.length - 1] : null;
  const modeLabel = currentViewMode === 'remote' ? 'zdalny' : 'lokalny';
  meta.textContent = [
    `Support ID: ${currentSupportId || '-'}`,
    `Widok: ${modeLabel}, ${safeEntries.length} wpisow (bufor: ${safeTotal})`,
    `Level: error=${errorCount}, warn=${warnCount}, info=${infoCount}`,
    `Kategoria: ${categorySummary || '-'}`,
    `Najnowszy: ${newest ? formatDateTime(newest.timestamp) : '-'}`,
    `Najstarszy w widoku: ${oldest ? formatDateTime(oldest.timestamp) : '-'}`
  ].join('\n');
}

function appendCell(row, value, className = '') {
  const cell = document.createElement('td');
  cell.textContent = typeof value === 'string' && value.trim() ? value : '-';
  if (className) cell.className = className;
  row.appendChild(cell);
}

function renderRows(entries) {
  rowsBody.innerHTML = '';
  const safeEntries = Array.isArray(entries) ? entries : [];
  if (safeEntries.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 11;
    cell.className = 'placeholder';
    cell.textContent = 'Brak wpisow problemowych.';
    row.appendChild(cell);
    rowsBody.appendChild(row);
    return;
  }

  safeEntries.forEach((entry) => {
    const row = document.createElement('tr');
    const levelClass = entry?.level === 'error'
      ? 'level-error'
      : (entry?.level === 'warn' ? 'level-warn' : 'level-info');

    appendCell(row, formatDateTime(entry?.timestamp));
    appendCell(row, entry?.level || 'info', levelClass);
    appendCell(row, entry?.runId || '');
    appendCell(row, entry?.title || '');
    appendCell(row, formatStage(entry));
    appendCell(row, entry?.status || '');
    appendCell(row, formatReason(entry));
    appendCell(row, entry?.error || '');
    appendCell(row, entry?.message || '');
    appendCell(row, formatPrompt(entry));
    appendCell(row, formatTabWindow(entry));
    rowsBody.appendChild(row);
  });
}

function entriesToText(entries) {
  const safeEntries = Array.isArray(entries) ? entries : [];
  const header = `Support ID: ${currentSupportId || '-'}`;
  if (safeEntries.length === 0) return `${header}\nBrak wpisow problemowych.`;
  return `${header}\n\n${safeEntries.map((entry) => {
    const ts = formatDateTime(entry?.timestamp);
    const level = entry?.level || 'info';
    const runId = entry?.runId || '-';
    const title = entry?.title || '-';
    const stage = formatStage(entry);
    const status = entry?.status || '-';
    const reason = formatReason(entry);
    const error = entry?.error || '-';
    const message = entry?.message || '-';
    const prompt = formatPrompt(entry);
    const tabWindow = formatTabWindow(entry);
    return `[${ts}] ${level.toUpperCase()} run=${runId} title="${title}" stage="${stage}" status=${status} reason=${reason} error=${error} prompt=${prompt} ${tabWindow}\n${message}`;
  }).join('\n\n')}`;
}

async function copyText(text) {
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'readonly');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const ok = document.execCommand('copy');
  textarea.remove();
  if (!ok) throw new Error('copy_failed');
}

async function refreshProblemLogs(options = {}) {
  if (refreshInFlight && !options.force) return;
  refreshInFlight = true;
  try {
    const response = await sendRuntimeMessage({
      type: 'GET_PROBLEM_LOGS',
      limit: 250
    });
    if (response?.success === false) {
      throw new Error(response?.error || 'problem_logs_fetch_failed');
    }
    const entries = Array.isArray(response?.entries) ? response.entries : [];
    currentViewMode = 'local';
    currentSupportId = typeof response?.supportId === 'string' ? response.supportId : '';
    if (supportIdInput && !supportIdInput.value.trim() && currentSupportId) {
      supportIdInput.value = currentSupportId;
    }
    lastEntries = entries;
    renderMeta(entries, Number.isInteger(response?.total) ? response.total : entries.length);
    renderRows(entries);
    if (options?.silent !== true) {
      setStatus(`Odswiezono logi (${entries.length}).`, false);
    }
  } catch (error) {
    setStatus(`Blad odczytu logow: ${error?.message || String(error)}`, true);
  } finally {
    refreshInFlight = false;
  }
}

async function refreshRemoteProblemLogs(options = {}) {
  if (refreshInFlight && !options.force) return;
  refreshInFlight = true;
  try {
    const requestedSupportId = typeof supportIdInput?.value === 'string'
      ? supportIdInput.value.trim()
      : '';
    const response = await sendRuntimeMessage({
      type: 'GET_REMOTE_PROBLEM_LOGS',
      limit: 250,
      minutes: 24 * 60,
      supportId: requestedSupportId
    });
    if (response?.success === false) {
      throw new Error(response?.error || 'problem_logs_remote_fetch_failed');
    }
    const entries = Array.isArray(response?.entries) ? response.entries : [];
    currentViewMode = 'remote';
    currentSupportId = typeof response?.supportId === 'string' ? response.supportId : requestedSupportId;
    if (supportIdInput && currentSupportId) {
      supportIdInput.value = currentSupportId;
    }
    lastEntries = entries;
    renderMeta(entries, Number.isInteger(response?.total) ? response.total : entries.length);
    renderRows(entries);
    if (options?.silent !== true) {
      const sourceUrl = typeof response?.intakeUrl === 'string' ? response.intakeUrl : '';
      setStatus(`Pobrano zdalne logi (${entries.length}).${sourceUrl ? ` Endpoint: ${sourceUrl}` : ''}`, false);
    }
  } catch (error) {
    setStatus(`Blad odczytu zdalnych logow: ${error?.message || String(error)}`, true);
  } finally {
    refreshInFlight = false;
  }
}

async function clearProblemLogs() {
  try {
    const response = await sendRuntimeMessage({ type: 'CLEAR_PROBLEM_LOGS' });
    if (response?.success === false) {
      throw new Error(response?.error || 'problem_logs_clear_failed');
    }
    setStatus('Wyczyszczono logi problemowe.', false);
    await refreshProblemLogs({ force: true, silent: true });
  } catch (error) {
    setStatus(`Blad czyszczenia logow: ${error?.message || String(error)}`, true);
  }
}

if (refreshBtn) {
  refreshBtn.addEventListener('click', () => {
    void refreshProblemLogs({ force: true });
  });
}

if (remoteBtn) {
  remoteBtn.addEventListener('click', () => {
    void refreshRemoteProblemLogs({ force: true });
  });
}

if (copyBtn) {
  copyBtn.addEventListener('click', async () => {
    try {
      await copyText(entriesToText(lastEntries));
      setStatus('Skopiowano logi do schowka.', false);
    } catch (error) {
      setStatus(`Blad kopiowania: ${error?.message || String(error)}`, true);
    }
  });
}

if (clearBtn) {
  clearBtn.addEventListener('click', () => {
    void clearProblemLogs();
  });
}

if (chrome?.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'PROBLEM_LOGS_UPDATED') return;
    if (currentViewMode === 'remote') return;
    void refreshProblemLogs({ silent: true });
  });
}

installProblemLogRuntimeProblemLogging();

autoRefreshTimer = setInterval(() => {
  if (currentViewMode === 'remote') {
    void refreshRemoteProblemLogs({ silent: true });
  } else {
    void refreshProblemLogs({ silent: true });
  }
}, 15000);

window.addEventListener('beforeunload', () => {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
});

void refreshProblemLogs({ force: true, silent: true });
