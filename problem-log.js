const refreshBtn = document.getElementById('refresh-btn');
const copyBtn = document.getElementById('copy-btn');
const clearBtn = document.getElementById('clear-btn');
const meta = document.getElementById('meta');
const statusEl = document.getElementById('status');
const rowsBody = document.getElementById('rows-body');

let lastEntries = [];
let autoRefreshTimer = null;
let refreshInFlight = false;

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

function renderMeta(entries, total) {
  const safeEntries = Array.isArray(entries) ? entries : [];
  const safeTotal = Number.isInteger(total) ? total : safeEntries.length;
  const errorCount = safeEntries.filter((entry) => entry?.level === 'error').length;
  const warnCount = safeEntries.filter((entry) => entry?.level === 'warn').length;
  const infoCount = safeEntries.filter((entry) => entry?.level === 'info').length;
  const newest = safeEntries.length > 0 ? safeEntries[0] : null;
  const oldest = safeEntries.length > 0 ? safeEntries[safeEntries.length - 1] : null;
  meta.textContent = [
    `Widok: ${safeEntries.length} wpisow (bufor: ${safeTotal})`,
    `Level: error=${errorCount}, warn=${warnCount}, info=${infoCount}`,
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
    appendCell(row, entry?.reason || '');
    appendCell(row, entry?.error || '');
    appendCell(row, entry?.message || '');
    appendCell(row, formatPrompt(entry));
    appendCell(row, formatTabWindow(entry));
    rowsBody.appendChild(row);
  });
}

function entriesToText(entries) {
  const safeEntries = Array.isArray(entries) ? entries : [];
  if (safeEntries.length === 0) return 'Brak wpisow problemowych.';
  return safeEntries.map((entry) => {
    const ts = formatDateTime(entry?.timestamp);
    const level = entry?.level || 'info';
    const runId = entry?.runId || '-';
    const title = entry?.title || '-';
    const stage = formatStage(entry);
    const status = entry?.status || '-';
    const reason = entry?.reason || '-';
    const error = entry?.error || '-';
    const message = entry?.message || '-';
    const prompt = formatPrompt(entry);
    const tabWindow = formatTabWindow(entry);
    return `[${ts}] ${level.toUpperCase()} run=${runId} title="${title}" stage="${stage}" status=${status} reason=${reason} error=${error} prompt=${prompt} ${tabWindow}\n${message}`;
  }).join('\n\n');
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
    void refreshProblemLogs({ silent: true });
  });
}

autoRefreshTimer = setInterval(() => {
  void refreshProblemLogs({ silent: true });
}, 15000);

window.addEventListener('beforeunload', () => {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
});

void refreshProblemLogs({ force: true, silent: true });
