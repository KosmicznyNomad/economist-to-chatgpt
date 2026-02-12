// process-monitor.js - UI dla centralnego okna monitoringu
const processList = document.getElementById('process-list');
const emptyState = document.getElementById('empty-state');
const detailsEmpty = document.getElementById('details-empty');
const detailsContainer = document.getElementById('process-details');
const historyToggle = document.getElementById('history-toggle');
const historyList = document.getElementById('history-list');
const resumeAllBtn = document.getElementById('resume-all-btn');
const detectResumeBtn = document.getElementById('detect-resume-btn');
const detectResults = document.getElementById('detect-results');
const processSummary = document.getElementById('process-summary');

let selectedProcessId = null;
let currentProcesses = [];
let allProcessesCache = [];
let lastSignature = '';
let lastHistorySignature = '';
let historyOpen = false;
const processCardMap = new Map();
const processSeenAt = new Map();
let stageNamesCompany = [];
let stageNamesLoaded = false;

console.log('🔍 Monitor procesów uruchomiony');

async function loadStageNames() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_STAGE_NAMES' }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[panel] GET_STAGE_NAMES failed:', chrome.runtime.lastError.message || chrome.runtime.lastError);
        resolve([]);
        return;
      }
      const names = Array.isArray(response?.stageNames)
        ? response.stageNames.filter((name) => typeof name === 'string')
        : [];
      stageNamesCompany = names;
      stageNamesLoaded = true;
      resolve(names);
    });
  });
}

async function initializeMonitor() {
  await loadStageNames();
  await refreshProcesses();
}

// Pobierz procesy przy starcie
void initializeMonitor();

// Nasłuchuj na aktualizacje
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'PROCESSES_UPDATE') {
    applyProcessesUpdate(message.processes);
  }
});

// Odświeżaj co 6s jako backup
setInterval(refreshProcesses, 3000);

if (historyToggle && historyList) {
  historyToggle.addEventListener('click', () => {
    historyOpen = !historyOpen;
    historyList.style.display = historyOpen ? 'flex' : 'none';
  });
}

if (resumeAllBtn) {
  resumeAllBtn.addEventListener('click', () => {
    void resumeAllProcesses();
  });
}

if (detectResumeBtn) {
  detectResumeBtn.addEventListener('click', () => {
    void detectLastPromptAndResume();
  });
}

const reasonLabels = {
  send_failed: 'Blad wysylania promptu',
  timeout: 'Timeout odpowiedzi',
  invalid_response: 'Za krotka odpowiedz',
  auto_recovery_send_failed: 'Auto-recovery po bledzie wysylania',
  auto_recovery_timeout: 'Auto-recovery po timeout',
  auto_recovery_invalid_response: 'Auto-recovery po niepoprawnej odpowiedzi'
};
const RESPONSE_STORAGE_KEY = 'responses';

function getNormalizedStatus(process) {
  if (!process || typeof process.status !== 'string') return '';
  return process.status.trim().toLowerCase();
}

function isFailedStatus(status) {
  return status === 'failed' || status === 'error';
}

function isCompletedStatus(status) {
  return status === 'completed';
}

function getProgressPercent(currentPrompt, totalPrompts) {
  if (!Number.isInteger(totalPrompts) || totalPrompts <= 0) return 0;
  const current = Number.isInteger(currentPrompt) ? currentPrompt : 0;
  const bounded = Math.min(Math.max(current, 0), totalPrompts);
  return Math.round((bounded / totalPrompts) * 100);
}

function formatRelativeTime(timestamp) {
  if (!Number.isInteger(timestamp) || timestamp <= 0) return 'n/a';
  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 1000) return 'teraz';
  const sec = Math.floor(deltaMs / 1000);
  if (sec < 60) return `${sec}s temu`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m temu`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h temu`;
  const days = Math.floor(hrs / 24);
  return `${days}d temu`;
}

function formatClock(timestamp) {
  if (!Number.isInteger(timestamp) || timestamp <= 0) return 'n/a';
  const date = new Date(timestamp);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function buildStatusCounts(processes) {
  const counts = {};
  (Array.isArray(processes) ? processes : []).forEach((process) => {
    const status = getNormalizedStatus(process) || 'unknown';
    counts[status] = (counts[status] || 0) + 1;
  });
  return counts;
}

function dedupeProcessesById(processes) {
  const items = Array.isArray(processes) ? processes : [];
  const byId = new Map();

  items.forEach((process) => {
    if (!process || typeof process !== 'object') return;
    const processId = process.id ? String(process.id) : '';
    if (!processId) return;
    const existing = byId.get(processId);
    if (!existing) {
      byId.set(processId, process);
      return;
    }
    const existingTs = Number.isInteger(existing.timestamp) ? existing.timestamp : 0;
    const nextTs = Number.isInteger(process.timestamp) ? process.timestamp : 0;
    if (nextTs >= existingTs) {
      byId.set(processId, process);
    }
  });

  return Array.from(byId.values());
}

function ensureCountConsistency(allItems, activeItems, historyItems) {
  const issues = [];
  if ((activeItems.length + historyItems.length) !== allItems.length) {
    issues.push('partition_mismatch');
  }

  const activeIds = new Set(
    activeItems
      .map((process) => (process?.id ? String(process.id) : ''))
      .filter(Boolean)
  );

  const activeClosed = activeItems.filter((process) => isProcessClosed(process));
  if (activeClosed.length > 0) {
    issues.push('closed_in_active');
  }

  const activeNeedsAction = activeItems.filter((process) => !!process?.needsAction).length;
  // Count needsAction only on the same active partition (by id),
  // otherwise stale/non-visible items in history can cause false mismatches.
  const partitionNeedsAction = allItems.filter((process) => {
    if (!process?.needsAction) return false;
    const processId = process?.id ? String(process.id) : '';
    return !!processId && activeIds.has(processId);
  }).length;
  if (activeNeedsAction !== partitionNeedsAction) {
    issues.push('needs_action_mismatch');
  }

  return issues;
}

function updateSummaryPanels(allProcesses, activeProcesses, historyProcesses) {
  const allItems = Array.isArray(allProcesses) ? allProcesses : [];
  const activeItems = Array.isArray(activeProcesses) ? activeProcesses : [];
  const historyItems = Array.isArray(historyProcesses) ? historyProcesses : [];

  const activeCount = activeItems.length;
  const needsActionCount = activeItems.filter((process) => !!process?.needsAction).length;
  const completedCount = allItems.filter((process) => isCompletedStatus(getNormalizedStatus(process))).length;
  const failedCount = allItems.filter((process) => isFailedStatus(getNormalizedStatus(process))).length;
  const totalCount = allItems.length;
  const consistencyIssues = ensureCountConsistency(allItems, activeItems, historyItems);
  const activeProgress = activeItems
    .map((process) => getProgressPercent(process?.currentPrompt, process?.totalPrompts))
    .filter((value) => Number.isInteger(value));
  const avgProgress = activeProgress.length > 0
    ? Math.round(activeProgress.reduce((sum, value) => sum + value, 0) / activeProgress.length)
    : 0;
  const oldestActiveTs = activeItems.reduce((oldest, process) => {
    const ts = Number.isInteger(process?.startedAt)
      ? process.startedAt
      : (Number.isInteger(process?.timestamp) ? process.timestamp : null);
    if (!Number.isInteger(ts)) return oldest;
    if (!Number.isInteger(oldest)) return ts;
    return Math.min(oldest, ts);
  }, null);
  const stageInfo = stageNamesLoaded ? `Etapy: ${stageNamesCompany.length}` : 'Etapy: ladowanie...';

  if (processSummary) {
    let summary = `Aktywne: ${activeCount} | Wymaga akcji: ${needsActionCount} | Zakonczone: ${completedCount} | Blad: ${failedCount} | Wszystkie: ${totalCount}`;
    summary += ` | Sredni postep aktywnych: ${avgProgress}%`;
    summary += ` | Najstarszy aktywny: ${formatRelativeTime(oldestActiveTs)}`;
    summary += ` | ${stageInfo}`;
    if (consistencyIssues.length > 0) {
      summary += ` | Korekta: ${consistencyIssues.join(',')}`;
      console.warn('[panel] Wykryto niespojnosc licznikow procesow', {
        issues: consistencyIssues,
        statusCounts: buildStatusCounts(allItems),
        activeCount,
        historyCount: historyItems.length,
        totalCount
      });
    }
    processSummary.textContent = summary;
  }
}

function getStorageAreas() {
  return {
    local: chrome.storage?.local || null,
    session: chrome.storage?.session || null
  };
}

function makeResponseKey(response) {
  if (!response || typeof response !== 'object') return '';
  const timestamp = Number.isInteger(response.timestamp) ? response.timestamp : 0;
  const runId = typeof response.runId === 'string' ? response.runId : '';
  const analysisType = response.analysisType || '';
  const source = response.source || '';
  const text = response.text || '';
  return `${timestamp}|${runId}|${analysisType}|${source}|${text.length}`;
}

function mergeResponses(primary, secondary) {
  const merged = [];
  const seen = new Set();

  const add = (response) => {
    const key = makeResponseKey(response);
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(response);
  };

  (Array.isArray(primary) ? primary : []).forEach(add);
  (Array.isArray(secondary) ? secondary : []).forEach(add);
  return merged;
}

async function readResponsesFromStorage() {
  const { local, session } = getStorageAreas();

  if (local && session) {
    const [localResult, sessionResult] = await Promise.all([
      local.get([RESPONSE_STORAGE_KEY]),
      session.get([RESPONSE_STORAGE_KEY])
    ]);
    return mergeResponses(localResult.responses || [], sessionResult.responses || []);
  }

  if (local) {
    const result = await local.get([RESPONSE_STORAGE_KEY]);
    return result.responses || [];
  }

  if (session) {
    const result = await session.get([RESPONSE_STORAGE_KEY]);
    return result.responses || [];
  }

  return [];
}

function isProcessCompleted(process) {
  if (!process) return false;
  return isCompletedStatus(getNormalizedStatus(process));
}

function findCompletedResponseForProcess(process, responses) {
  if (!process || !Array.isArray(responses) || responses.length === 0) return null;

  const sorted = responses
    .filter((response) => response && typeof response === 'object')
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  const processId = typeof process.id === 'string' ? process.id : String(process.id || '');
  if (processId) {
    const byRunId = sorted.find((response) => typeof response.runId === 'string' && response.runId === processId);
    if (byRunId) return byRunId;
  }

  // Fallback for older responses saved without runId.
  const analysisType = process.analysisType || 'company';
  const source = process.title || '';
  const startedAt = Number.isInteger(process.startedAt) ? process.startedAt : null;
  const finishedAt = Number.isInteger(process.finishedAt) ? process.finishedAt : null;

  const byMetadata = sorted.filter((response) => {
    if ((response.analysisType || 'company') !== analysisType) return false;
    if (source && (response.source || '') !== source) return false;
    const ts = Number.isInteger(response.timestamp) ? response.timestamp : 0;
    if (startedAt && ts < startedAt - 10 * 60 * 1000) return false;
    if (finishedAt && ts > finishedAt + 10 * 60 * 1000) return false;
    return true;
  });

  if (byMetadata.length > 0) return byMetadata[0];
  return null;
}

function extractResponseText(response) {
  if (!response || typeof response !== 'object') return '';
  const candidates = [
    response.text,
    response.formattedText,
    response.formatted_text
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
  }

  return '';
}

function extractCompletedTextFromProcess(process) {
  if (!process || typeof process !== 'object') return '';

  if (typeof process.completedResponseText === 'string' && process.completedResponseText.trim().length > 0) {
    return process.completedResponseText;
  }

  const messages = Array.isArray(process.messages) ? process.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'assistant') continue;
    const text = typeof message.text === 'string' ? message.text : '';
    if (text.trim().length > 0) {
      return text;
    }
  }

  return '';
}

async function copyCompletedResponse(process, button) {
  if (!process || !button) return;

  const originalText = button.dataset.originalText || button.textContent || 'Skopiuj skonczona odpowiedz';
  button.dataset.originalText = originalText;
  button.disabled = true;

  try {
    const responses = await readResponsesFromStorage();
    const match = findCompletedResponseForProcess(process, responses);
    const textFromStorage = extractResponseText(match);
    const textFromProcess = extractCompletedTextFromProcess(process);
    const text = (textFromStorage || textFromProcess || '').trim();

    if (!text) {
      throw new Error('Brak zapisanej skonczonej odpowiedzi dla tego procesu');
    }

    await navigator.clipboard.writeText(text);
    console.log('[panel] Copied completed response', {
      processId: process?.id,
      source: textFromStorage ? 'responses' : 'process_fallback',
      length: text.length
    });
    button.textContent = '✓ Skopiowano';
  } catch (error) {
    console.warn('[panel] Nie udalo sie skopiowac skonczonej odpowiedzi:', error?.message || error);
    button.textContent = '✕ Brak odpowiedzi';
  }

  setTimeout(() => {
    button.textContent = originalText;
    button.disabled = !isProcessCompleted(process);
  }, 1800);
}

function resolveStageLabel(process) {
  const currentPrompt = Number.isInteger(process?.currentPrompt) && process.currentPrompt > 0
    ? process.currentPrompt
    : null;
  const promptFromStageIndex = Number.isInteger(process?.stageIndex) && process.stageIndex >= 0
    ? (process.stageIndex + 1)
    : null;
  const normalizedPrompt = Math.max(currentPrompt || 0, promptFromStageIndex || 0);

  const rawStageName = typeof process?.stageName === 'string' ? process.stageName.trim() : '';
  const analysisType = (process?.analysisType || '').toLowerCase();
  const companyStageName = normalizedPrompt > 0
    ? stageNamesCompany[normalizedPrompt - 1]
    : '';

  if (rawStageName) {
    const promptMatch = rawStageName.match(/^Prompt\s+(\d+)$/i);
    if (promptMatch && normalizedPrompt > 0) {
      const stagePrompt = Number.parseInt(promptMatch[1], 10);
      if (Number.isInteger(stagePrompt) && stagePrompt !== normalizedPrompt) {
        if (analysisType === 'company' && companyStageName) {
          return `${companyStageName} (Prompt ${normalizedPrompt})`;
        }
        return `Prompt ${normalizedPrompt}`;
      }
      if (analysisType === 'company' && companyStageName) {
        return `${companyStageName} (Prompt ${normalizedPrompt})`;
      }
    }
    return rawStageName;
  }

  if (normalizedPrompt > 0) {
    if (analysisType === 'company' && companyStageName) {
      return `${companyStageName} (Prompt ${normalizedPrompt})`;
    }
    return `Prompt ${normalizedPrompt}`;
  }
  return 'Start';
}

function normalizeUrl(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function isChatUrl(url) {
  if (!url) return false;
  return url.includes('chatgpt.com') || url.includes('chat.openai.com');
}

function resolveChatUrl(process) {
  const chatUrl = normalizeUrl(process?.chatUrl);
  if (chatUrl) return chatUrl;
  const sourceUrl = normalizeUrl(process?.sourceUrl);
  if (sourceUrl && isChatUrl(sourceUrl)) return sourceUrl;
  return '';
}

function getProcessSortKey(process) {
  if (!process) return 0;
  if (Number.isInteger(process.startedAt)) return process.startedAt;
  if (processSeenAt.has(process.id)) return processSeenAt.get(process.id);
  const fallback = Number.isInteger(process.timestamp) ? process.timestamp : Date.now();
  processSeenAt.set(process.id, fallback);
  return fallback;
}

function buildProcessCard() {
  const card = document.createElement('div');
  card.className = 'process-card';

  const header = document.createElement('div');
  header.className = 'process-header';

  const title = document.createElement('div');
  title.className = 'process-title';

  const type = document.createElement('div');
  type.className = 'process-type';

  header.appendChild(title);
  header.appendChild(type);

  const status = document.createElement('div');
  status.className = 'process-status';

  const statusLine = document.createElement('span');
  statusLine.className = 'status-line';

  const statusBadge = document.createElement('span');
  statusBadge.className = 'status-badge';

  status.appendChild(statusLine);
  status.appendChild(statusBadge);

  const progressBar = document.createElement('div');
  progressBar.className = 'progress-bar';

  const progressFill = document.createElement('div');
  progressFill.className = 'progress-fill';
  progressBar.appendChild(progressFill);

  const stageMeta = document.createElement('div');
  stageMeta.className = 'meta stage-meta';

  const statusMeta = document.createElement('div');
  statusMeta.className = 'meta status-meta';

  const timingMeta = document.createElement('div');
  timingMeta.className = 'meta timing-meta';

  const locationMeta = document.createElement('div');
  locationMeta.className = 'meta location-meta';

  const reason = document.createElement('div');
  reason.className = 'reason';

  const actions = document.createElement('div');
  actions.className = 'actions';

  const waitBtn = document.createElement('button');
  waitBtn.className = 'action-btn action-wait';
  waitBtn.dataset.action = 'wait';
  waitBtn.textContent = 'Czekaj';

  const skipBtn = document.createElement('button');
  skipBtn.className = 'action-btn action-skip';
  skipBtn.dataset.action = 'skip';
  skipBtn.textContent = 'Kontynuuj';

  actions.appendChild(waitBtn);
  actions.appendChild(skipBtn);

  const hint = document.createElement('div');
  hint.className = 'hint';

  card.appendChild(header);
  card.appendChild(status);
  card.appendChild(progressBar);
  card.appendChild(stageMeta);
  card.appendChild(statusMeta);
  card.appendChild(timingMeta);
  card.appendChild(locationMeta);
  card.appendChild(reason);
  card.appendChild(actions);
  card.appendChild(hint);

  const entry = {
    card,
    refs: {
      title,
      type,
      statusLine,
      statusBadge,
      progressFill,
      stageMeta,
      statusMeta,
      timingMeta,
      locationMeta,
      reason,
      actions,
      waitBtn,
      skipBtn,
      hint
    }
  };

  card.addEventListener('click', () => {
    const process = card.__process;
    if (!process) return;
    if (selectedProcessId !== process.id) {
      selectedProcessId = process.id;
      updateUI(currentProcesses, { force: true });
    }
    void openProcessWindow(process);
  });

  const handleDecisionClick = async (event, decision) => {
    event.stopPropagation();
    const process = card.__process;
    if (!process) return;
    waitBtn.disabled = true;
    skipBtn.disabled = true;
    const sent = await sendDecision(process, decision);
    if (!sent) {
      restoreDecisionButtons(waitBtn, skipBtn);
      return;
    }
    scheduleDecisionButtonRecovery(process.id, waitBtn, skipBtn);
  };

  waitBtn.addEventListener('click', (event) => {
    void handleDecisionClick(event, 'wait');
  });

  skipBtn.addEventListener('click', (event) => {
    void handleDecisionClick(event, 'skip');
  });

  return entry;
}

function updateProcessCard(entry, process, isSelected) {
  if (!entry || !process) return;
  const { card, refs } = entry;
  card.__process = process;
  card.id = `process-${process.id}`;

  if (!card.classList.contains('process-card')) {
    card.classList.add('process-card');
  }
  card.classList.toggle('needs-action', !!process.needsAction);
  card.classList.toggle('selected', !!isSelected);

  refs.title.textContent = process.title || 'Bez tytulu';
  refs.type.textContent = process.analysisType || 'company';

  const currentPrompt = Number.isInteger(process.currentPrompt) ? process.currentPrompt : 0;
  const totalPrompts = Number.isInteger(process.totalPrompts) ? process.totalPrompts : 0;
  const progress = getProgressPercent(currentPrompt, totalPrompts);
  const startedAt = Number.isInteger(process.startedAt) ? process.startedAt : null;
  const updatedAt = Number.isInteger(process.timestamp) ? process.timestamp : startedAt;
  const tabLabel = Number.isInteger(process.tabId) ? String(process.tabId) : '-';
  const windowLabel = Number.isInteger(process.windowId) ? String(process.windowId) : '-';

  refs.statusLine.textContent = `Prompt ${currentPrompt} / ${totalPrompts} (${progress}%)`;

  const status = getNormalizedStatus(process);
  let statusBadgeText = 'W trakcie';
  let statusBadgeClass = 'status-running';
  if (process.needsAction) {
    statusBadgeText = 'WYMAGA AKCJI';
    statusBadgeClass = 'status-needs-action';
  } else if (isCompletedStatus(status)) {
    statusBadgeText = 'Zakonczono';
    statusBadgeClass = 'status-completed';
  } else if (isFailedStatus(status)) {
    statusBadgeText = 'Blad';
    statusBadgeClass = 'status-failed';
  }

  refs.statusBadge.textContent = statusBadgeText;
  refs.statusBadge.className = `status-badge ${statusBadgeClass}`;

  refs.progressFill.style.width = `${progress}%`;

  const stageLabel = resolveStageLabel(process);
  refs.stageMeta.textContent = `Etap: ${stageLabel}`;

  const statusLine = process.statusText ? String(process.statusText) : '';
  if (statusLine || updatedAt) {
    const statusChunk = statusLine ? statusLine : 'brak statusText';
    refs.statusMeta.textContent = `Status: ${statusChunk} | Aktualizacja: ${formatRelativeTime(updatedAt)}`;
    refs.statusMeta.style.display = 'block';
  } else {
    refs.statusMeta.textContent = '';
    refs.statusMeta.style.display = 'none';
  }

  refs.timingMeta.textContent = `Start: ${formatClock(startedAt)} | Ostatni update: ${formatClock(updatedAt)} (${formatRelativeTime(updatedAt)})`;
  refs.locationMeta.textContent = `Tab: ${tabLabel} | Okno: ${windowLabel} | ID: ${process.id || '-'}`;

  let reasonText = null;
  if (process.reason) {
    reasonText = reasonLabels[process.reason] || process.reason;
  } else if (isFailedStatus(status) && process.error) {
    reasonText = process.error;
  }

  if (reasonText) {
    refs.reason.textContent = `Powod: ${reasonText}`;
    refs.reason.style.display = 'block';
  } else {
    refs.reason.textContent = '';
    refs.reason.style.display = 'none';
  }

  const needsAction = !!process.needsAction;
  refs.actions.style.display = needsAction ? 'flex' : 'none';
  if (!needsAction) {
    refs.waitBtn.disabled = false;
    refs.skipBtn.disabled = false;
  }

  refs.hint.textContent = needsAction
    ? 'Wybierz akcje ponizej (Kontynuuj = nastepny prompt) lub kliknij aby przejsc do okna'
    : 'Kliknij aby zobaczyc okno';
}

function openChatTab(process) {
  const chatUrl = resolveChatUrl(process);
  if (!chatUrl) return false;
  chrome.tabs.create({ url: chatUrl });
  return true;
}

const CLOSED_STATUSES = new Set([
  'completed',
  'failed',
  'closed',
  'error',
  'cancelled',
  'canceled',
  'aborted',
  'stopped',
  'interrupted'
]);
const MAX_ORPHAN_ACTIVE_AGE_MS = 45000;
const STATUS_CACHE_TTL_MS = 2500;
const tabStatusCache = new Map();
const windowStatusCache = new Map();
let updateSequence = 0;

function isProcessClosed(process) {
  if (!process) return true;
  const status = getNormalizedStatus(process);
  return CLOSED_STATUSES.has(status);
}

function readStatusCache(cache, id) {
  const cached = cache.get(id);
  if (!cached) return null;
  if (Date.now() - cached.checkedAt > STATUS_CACHE_TTL_MS) {
    cache.delete(id);
    return null;
  }
  return cached.exists;
}

function writeStatusCache(cache, id, exists) {
  cache.set(id, { exists, checkedAt: Date.now() });
}

async function checkTabExists(tabId) {
  if (!Number.isInteger(tabId)) return null;
  const cached = readStatusCache(tabStatusCache, tabId);
  if (cached !== null) return cached;
  const exists = await getTabExists(tabId);
  if (exists !== null) {
    writeStatusCache(tabStatusCache, tabId, exists);
  }
  return exists;
}

async function checkWindowExists(windowId) {
  if (!Number.isInteger(windowId)) return null;
  const cached = readStatusCache(windowStatusCache, windowId);
  if (cached !== null) return cached;
  const exists = await getWindowExists(windowId);
  if (exists !== null) {
    writeStatusCache(windowStatusCache, windowId, exists);
  }
  return exists;
}

async function filterActiveProcesses(processes) {
  const items = Array.isArray(processes) ? processes.slice() : [];
  const active = items.filter((process) => !isProcessClosed(process));
  if (active.length === 0) return [];

  const decisions = await Promise.all(active.map(async (process) => {
    const tabId = Number.isInteger(process.tabId) ? process.tabId : null;
    const windowId = Number.isInteger(process.windowId) ? process.windowId : null;

    if (!tabId && !windowId) {
      const lastSeenAt = Number.isInteger(process.timestamp)
        ? process.timestamp
        : (Number.isInteger(process.startedAt) ? process.startedAt : null);
      if (!Number.isInteger(lastSeenAt)) {
        return { process, keep: false, reason: 'orphan_missing_timestamp' };
      }
      const keep = (Date.now() - lastSeenAt) <= MAX_ORPHAN_ACTIVE_AGE_MS;
      return { process, keep, reason: keep ? 'orphan_recent' : 'orphan_expired' };
    }

    if (tabId) {
      const tabExists = await checkTabExists(tabId);
      if (tabExists !== false) {
        return { process, keep: true, reason: tabExists === true ? 'tab_exists' : 'tab_unknown' };
      }
      if (windowId) {
        const windowExists = await checkWindowExists(windowId);
        const keep = windowExists !== false;
        return { process, keep, reason: keep ? (windowExists === true ? 'window_exists_tab_missing' : 'window_unknown_tab_missing') : 'tab_window_missing' };
      }
      return { process, keep: false, reason: 'tab_missing' };
    }

    const windowExists = await checkWindowExists(windowId);
    const keep = windowExists !== false;
    return { process, keep, reason: keep ? (windowExists === true ? 'window_exists' : 'window_unknown') : 'window_missing' };
  }));

  return decisions
    .filter((decision) => decision.keep)
    .map((decision) => decision.process);
}

function getTabExists(tabId) {
  return new Promise((resolve) => {
    if (!Number.isInteger(tabId)) {
      resolve(null);
      return;
    }
    try {
      chrome.tabs.get(tabId, (tab) => {
        const error = chrome.runtime.lastError;
        if (error) {
          const message = error.message || '';
          if (message.includes('No tab with id')) {
            resolve(false);
          } else {
            resolve(null);
          }
          return;
        }
        resolve(!!tab);
      });
    } catch (error) {
      resolve(null);
    }
  });
}

function getWindowExists(windowId) {
  return new Promise((resolve) => {
    if (!Number.isInteger(windowId)) {
      resolve(null);
      return;
    }
    try {
      chrome.windows.get(windowId, (windowInfo) => {
        const error = chrome.runtime.lastError;
        if (error) {
          const message = error.message || '';
          if (message.includes('No window with id')) {
            resolve(false);
          } else {
            resolve(null);
          }
          return;
        }
        resolve(!!windowInfo);
      });
    } catch (error) {
      resolve(null);
    }
  });
}

async function applyProcessesUpdate(processes, options = {}) {
  const requestId = ++updateSequence;
  const items = dedupeProcessesById(Array.isArray(processes) ? processes.slice() : []);
  allProcessesCache = items.slice();
  try {
    const active = await filterActiveProcesses(items);
    if (requestId !== updateSequence) return;
    const activeIds = new Set(active.map((process) => process.id));
    const history = items.filter((process) => !activeIds.has(process.id));
    updateSummaryPanels(items, active, history);
    updateUI(active, options);
    updateHistory(history);
  } catch (error) {
    console.warn('[panel] Nie udalo sie odswiezyc procesow:', error);
    if (requestId !== updateSequence) return;
    updateSummaryPanels(items, items, []);
    updateUI(items, options);
    updateHistory([]);
  }
}

function getTabSafe(tabId) {
  return new Promise((resolve) => {
    if (!Number.isInteger(tabId)) {
      resolve(null);
      return;
    }
    try {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(tab || null);
      });
    } catch (error) {
      resolve(null);
    }
  });
}

function getWindowSafe(windowId) {
  return new Promise((resolve) => {
    if (!Number.isInteger(windowId)) {
      resolve(null);
      return;
    }
    try {
      chrome.windows.get(windowId, (windowInfo) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(windowInfo || null);
      });
    } catch (error) {
      resolve(null);
    }
  });
}

function updateWindowSafe(windowId, updateInfo) {
  return new Promise((resolve) => {
    if (!Number.isInteger(windowId)) {
      resolve(false);
      return;
    }
    try {
      chrome.windows.update(windowId, updateInfo, () => {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        resolve(true);
      });
    } catch (error) {
      resolve(false);
    }
  });
}

function updateTabSafe(tabId, updateInfo) {
  return new Promise((resolve) => {
    if (!Number.isInteger(tabId)) {
      resolve(false);
      return;
    }
    try {
      chrome.tabs.update(tabId, updateInfo, () => {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        resolve(true);
      });
    } catch (error) {
      resolve(false);
    }
  });
}

async function focusProcessWindow(process) {
  if (!process) return false;
  const tabId = Number.isInteger(process.tabId) ? process.tabId : null;
  const fallbackWindowId = Number.isInteger(process.windowId) ? process.windowId : null;

  const tabInfo = await getTabSafe(tabId);
  const windowId = tabInfo?.windowId ?? fallbackWindowId;

  let windowFocused = false;
  if (windowId) {
    const windowInfo = await getWindowSafe(windowId);
    const updateInfo = windowInfo?.state === 'minimized'
      ? { state: 'normal', focused: true }
      : { focused: true };
    windowFocused = await updateWindowSafe(windowId, updateInfo);
  }

  let tabFocused = false;
  if (tabId) {
    tabFocused = await updateTabSafe(tabId, { active: true });
  }

  if (!windowFocused && !tabFocused) {
    console.warn('[panel] Unable to focus process window', { tabId, windowId });
  }

  return windowFocused || tabFocused;
}

async function openProcessWindow(process) {
  if (!process) return false;
  const focused = await focusProcessWindow(process);
  if (focused) return true;
  if (openChatTab(process)) return true;
  return false;
}

function refreshProcesses() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_PROCESSES' }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[panel] GET_PROCESSES failed:', chrome.runtime.lastError.message || chrome.runtime.lastError);
        resolve([]);
        return;
      }
      const processes = Array.isArray(response?.processes) ? response.processes : [];
      applyProcessesUpdate(processes);
      resolve(processes);
    });
  });
}

function sendDecision(process, decision) {
  return new Promise((resolve) => {
    if (!process || !process.id) {
      resolve(false);
      return;
    }
    chrome.runtime.sendMessage({
      type: 'PROCESS_DECISION',
      runId: process.id,
      decision,
      origin: 'panel',
      tabId: Number.isInteger(process.tabId) ? process.tabId : null,
      windowId: Number.isInteger(process.windowId) ? process.windowId : null
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[panel] PROCESS_DECISION failed:', chrome.runtime.lastError.message || chrome.runtime.lastError);
        resolve(false);
        return;
      }
      resolve(!!response?.success);
    });
  });
}

function sendDecisionAll(decision) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'PROCESS_DECISION_ALL',
      decision,
      origin: 'panel'
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[panel] PROCESS_DECISION_ALL failed:', chrome.runtime.lastError.message || chrome.runtime.lastError);
        resolve({ success: false, matched: 0, delivered: 0 });
        return;
      }

      resolve({
        success: !!response?.success,
        matched: Number.isInteger(response?.matched) ? response.matched : 0,
        delivered: Number.isInteger(response?.delivered) ? response.delivered : 0
      });
    });
  });
}

function sendProcessResumeNextStage(process, options = {}) {
  return new Promise((resolve) => {
    if (!process || !process.id) {
      resolve({ success: false, error: 'missing_process_id' });
      return;
    }

    chrome.runtime.sendMessage({
      type: 'PROCESS_RESUME_NEXT_STAGE',
      runId: process.id,
      tabId: Number.isInteger(process.tabId) ? process.tabId : null,
      windowId: Number.isInteger(process.windowId) ? process.windowId : null,
      chatUrl: resolveChatUrl(process),
      title: process?.title || '',
      analysisType: process?.analysisType || '',
      openDialogOnly: !!options.openDialogOnly
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[panel] PROCESS_RESUME_NEXT_STAGE failed:', chrome.runtime.lastError.message || chrome.runtime.lastError);
        resolve({
          success: false,
          error: chrome.runtime.lastError.message || 'runtime_error'
        });
        return;
      }

      resolve({
        success: !!response?.success,
        error: typeof response?.error === 'string' ? response.error : '',
        mode: typeof response?.mode === 'string' ? response.mode : '',
        startIndex: Number.isInteger(response?.startIndex) ? response.startIndex : null,
        startPromptNumber: Number.isInteger(response?.startPromptNumber) ? response.startPromptNumber : null,
        detectedPromptNumber: Number.isInteger(response?.detectedPromptNumber) ? response.detectedPromptNumber : null,
        detectedMethod: typeof response?.detectedMethod === 'string' ? response.detectedMethod : ''
      });
    });
  });
}

async function resumeNextStageFromPanel(process, button, options = {}) {
  if (!process) return false;
  const openDialogOnly = !!options.openDialogOnly;
  const originalText = (button?.dataset?.originalText || button?.textContent || (openDialogOnly ? 'Wznow od kolejnego etapu' : 'Resume next stage')).trim();
  if (button) {
    button.dataset.originalText = originalText;
    button.disabled = true;
    button.textContent = openDialogOnly ? 'Wykrywam etap...' : 'Wznawiam...';
  }

  try {
    const response = await sendProcessResumeNextStage(process, { openDialogOnly });
    if (response.success) {
      if (button) {
        if (openDialogOnly) {
          const promptText = Number.isInteger(response.startPromptNumber) ? `Prompt ${response.startPromptNumber}` : 'wybrany prompt';
          button.textContent = `Otwarto dialog (${promptText})`;
        } else {
          const promptText = Number.isInteger(response.startPromptNumber) ? `Prompt ${response.startPromptNumber}` : 'kolejny etap';
          button.textContent = `Wznowiono: ${promptText}`;
        }
      }
      await refreshProcesses();
      return true;
    }

    console.warn('[panel] Resume next stage error', {
      processId: process?.id,
      error: response.error,
      detectedPromptNumber: response.detectedPromptNumber,
      detectedMethod: response.detectedMethod
    });

    if (button) {
      if (response.error === 'already_at_last_prompt') {
        button.textContent = 'Brak kolejnego etapu';
      } else {
        button.textContent = 'Nie udalo sie wznowic';
      }
    }
    return false;
  } catch (error) {
    console.warn('[panel] Resume next stage exception:', error);
    if (button) {
      button.textContent = 'Blad wznowienia';
    }
    return false;
  } finally {
    if (button) {
      setTimeout(() => {
        button.textContent = originalText;
        button.disabled = false;
      }, 2200);
    }
  }
}

function sendDetectLastPromptAndResume() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'DETECT_LAST_COMPANY_PROMPT_AND_RESUME'
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[panel] DETECT_LAST_COMPANY_PROMPT_AND_RESUME failed:', chrome.runtime.lastError.message || chrome.runtime.lastError);
        resolve({
          success: false,
          scannedTabs: 0,
          matchedTabs: 0,
          resumedTabs: 0,
          passCount: 0,
          pendingAfterLoop: 0,
          results: [],
          error: chrome.runtime.lastError.message || 'runtime_error'
        });
        return;
      }

      resolve({
        success: !!response?.success,
        scannedTabs: Number.isInteger(response?.scannedTabs) ? response.scannedTabs : 0,
        matchedTabs: Number.isInteger(response?.matchedTabs) ? response.matchedTabs : 0,
        resumedTabs: Number.isInteger(response?.resumedTabs) ? response.resumedTabs : 0,
        passCount: Number.isInteger(response?.passCount) ? response.passCount : 0,
        pendingAfterLoop: Number.isInteger(response?.pendingAfterLoop) ? response.pendingAfterLoop : 0,
        results: Array.isArray(response?.results) ? response.results : [],
        error: typeof response?.error === 'string' ? response.error : ''
      });
    });
  });
}

function formatDetectAction(action) {
  const map = {
    resumed: 'wznowiono',
    no_match: 'brak dopasowania',
    no_user_message: 'brak wiadomosci usera',
    final_stage_already_sent: 'ostatni etap juz wyslany',
    active_process_exists: 'aktywny proces juz istnieje',
    inject_failed: 'blad inject/odczytu',
    resume_failed: 'blad wznowienia'
  };
  return map[action] || action || 'unknown';
}

function renderDetectResults(state = {}) {
  if (!detectResults) return;

  if (state.loading) {
    detectResults.textContent = 'Przechodze po kartach GPT Inwestycje po kolei (1 pass, max 45s), wykrywam etap i uruchamiam wznowienie...';
    return;
  }

  if (state.error) {
    detectResults.textContent = `Blad: ${state.error}`;
    return;
  }

  const response = state.response;
  if (!response) {
    detectResults.textContent = 'Wyniki auto-detekcji (GPT Inwestycje) pojawia sie tutaj.';
    return;
  }

  const rows = Array.isArray(response.results) ? response.results : [];
  const header = document.createElement('div');
  header.className = 'detect-header';
  header.textContent = `Skan: ${response.scannedTabs} | Dopasowane: ${response.matchedTabs} | Wznowione: ${response.resumedTabs} | Passy: ${response.passCount || 0} | Pozostale: ${response.pendingAfterLoop || 0}`;

  detectResults.innerHTML = '';
  detectResults.appendChild(header);

  if (!response.success && response.error) {
    const errorRow = document.createElement('div');
    errorRow.className = 'detect-meta';
    errorRow.textContent = `Blad wykonania: ${response.error}`;
    detectResults.appendChild(errorRow);
  }

  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'detect-meta';
    empty.textContent = 'Brak kart do raportu.';
    detectResults.appendChild(empty);
    return;
  }

  rows.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'detect-row';

    const title = item?.title || item?.url || `Tab ${item?.tabId ?? '-'}`;
    const actionLabel = formatDetectAction(item?.action);
    const promptText = Number.isInteger(item?.detectedPromptNumber)
      ? `Prompt ${item.detectedPromptNumber}`
      : 'brak';
    const nextText = Number.isInteger(item?.nextStartIndex)
      ? `startIndex=${item.nextStartIndex}`
      : 'startIndex=-';
    const stageText = typeof item?.detectedStageName === 'string' && item.detectedStageName
      ? item.detectedStageName
      : '-';
    const methodText = typeof item?.detectedMethod === 'string' && item.detectedMethod
      ? item.detectedMethod
      : '-';
    const msgCount = Number.isInteger(item?.userMessageCount) ? item.userMessageCount : 0;
    const msgLen = Number.isInteger(item?.lastUserMessageLength) ? item.lastUserMessageLength : 0;
    const attempts = Number.isInteger(item?.attempts) ? item.attempts : 0;
    const lastPass = Number.isInteger(item?.lastPass) ? item.lastPass : 0;
    const retryExhausted = !!item?.retryExhausted;
    const consistencyText = item?.stageConsistency
      ? `${item.stageConsistency}${Number.isInteger(item?.stageDelta) ? ` (delta=${item.stageDelta})` : ''}`
      : '-';
    const progressText = Number.isInteger(item?.progressPromptNumber)
      ? `Prompt ${item.progressPromptNumber}${item?.progressStageName ? ` (${item.progressStageName})` : ''}`
      : '-';
    const signaturePreview = typeof item?.detectedSignature === 'string' && item.detectedSignature
      ? item.detectedSignature
      : '';

    row.innerHTML = `
      <div><strong>${escapeHtml(title)}</strong></div>
      <div class="detect-meta">akcja: ${escapeHtml(actionLabel)} (${escapeHtml(String(item?.action || 'unknown'))}), reason: ${escapeHtml(String(item?.reason || '-'))}</div>
      <div class="detect-meta">detected: ${escapeHtml(promptText)} | stage: ${escapeHtml(stageText)} | method: ${escapeHtml(methodText)} | next: ${escapeHtml(nextText)}</div>
      <div class="detect-meta">proby: ${escapeHtml(String(attempts))} | ostatni pass: ${escapeHtml(String(lastPass))} | retry_exhausted: ${escapeHtml(String(retryExhausted))}</div>
      <div class="detect-meta">spojnosc etapu: ${escapeHtml(consistencyText)} | progress(process): ${escapeHtml(progressText)}</div>
      <div class="detect-meta">wiadomosci usera: ${escapeHtml(String(msgCount))}, dlugosc ostatniej: ${escapeHtml(String(msgLen))} znakow, tabId: ${escapeHtml(String(item?.tabId ?? '-'))}</div>
      ${signaturePreview ? `<div class="detect-meta">sygnatura: ${escapeHtml(signaturePreview)}</div>` : ''}
    `;
    detectResults.appendChild(row);
  });
}

async function detectLastPromptAndResume() {
  if (!detectResumeBtn) return;

  const originalText = detectResumeBtn.textContent || 'Wykryj ostatni prompt i wznow';
  detectResumeBtn.disabled = true;
  detectResumeBtn.textContent = 'Skanuje...';
  renderDetectResults({ loading: true });

  try {
    const response = await sendDetectLastPromptAndResume();
    renderDetectResults({ response });
    await refreshProcesses();
  } catch (error) {
    renderDetectResults({ error: error?.message || String(error) });
  } finally {
    detectResumeBtn.disabled = false;
    detectResumeBtn.textContent = originalText;
  }
}

function restoreDecisionButtons(waitBtn, skipBtn) {
  if (waitBtn) waitBtn.disabled = false;
  if (skipBtn) skipBtn.disabled = false;
}

function scheduleDecisionButtonRecovery(processId, waitBtn, skipBtn, delayMs = 1800) {
  setTimeout(() => {
    const latest = currentProcesses.find((process) => process.id === processId);
    if (latest?.needsAction) {
      restoreDecisionButtons(waitBtn, skipBtn);
    }
  }, delayMs);
}

function updateUI(processes, options = {}) {
  const items = Array.isArray(processes) ? processes.slice() : [];
  if (items.length === 0) {
    processList.innerHTML = '';
    emptyState.style.display = 'block';
    selectedProcessId = null;
    currentProcesses = [];
    lastSignature = '';
    processCardMap.clear();
    processSeenAt.clear();
    renderDetails();
    updateResumeAllButtonState();
    return;
  }
  
  emptyState.style.display = 'none';
  
  const itemsWithKey = items.map((process) => ({
    process,
    sortKey: getProcessSortKey(process)
  }));

  // Sortuj: needs-action najpierw, potem stabilnie po starcie
  itemsWithKey.sort((a, b) => {
    const aNeeds = !!a.process.needsAction;
    const bNeeds = !!b.process.needsAction;
    if (aNeeds && !bNeeds) return -1;
    if (!aNeeds && bNeeds) return 1;
    const diff = (b.sortKey || 0) - (a.sortKey || 0);
    if (diff !== 0) return diff;
    return String(a.process.id).localeCompare(String(b.process.id));
  });

  const orderedItems = itemsWithKey.map((entry) => entry.process);

  if (!selectedProcessId) {
    const needsAction = orderedItems.find((process) => process.needsAction);
    selectedProcessId = needsAction ? needsAction.id : orderedItems[0].id;
  } else if (!orderedItems.some((process) => process.id === selectedProcessId)) {
    selectedProcessId = orderedItems[0].id;
  }

  const signature = orderedItems
    .map((process) => {
      const stageKey = Number.isInteger(process.stageIndex) ? process.stageIndex : '';
      const stageName = process.stageName || '';
      const statusText = process.statusText || '';
      const reason = process.reason || '';
      const title = process.title || '';
      const analysisType = process.analysisType || '';
      const tabId = Number.isInteger(process.tabId) ? process.tabId : '';
      const windowId = Number.isInteger(process.windowId) ? process.windowId : '';
      const chatUrl = process.chatUrl || '';
      const sourceUrl = process.sourceUrl || '';
      const autoRecovery = process?.autoRecovery && typeof process.autoRecovery === 'object'
        ? process.autoRecovery
        : null;
      const autoAttempt = Number.isInteger(autoRecovery?.attempt) ? autoRecovery.attempt : '';
      const autoMax = Number.isInteger(autoRecovery?.maxAttempts) ? autoRecovery.maxAttempts : '';
      const autoReason = typeof autoRecovery?.reason === 'string' ? autoRecovery.reason : '';
      const autoPrompt = Number.isInteger(autoRecovery?.currentPrompt) ? autoRecovery.currentPrompt : '';
      const sortKey = getProcessSortKey(process);
      return `${process.id}|${sortKey}|${process.status}|${process.needsAction}|${process.currentPrompt || 0}|${process.totalPrompts || 0}|${stageKey}|${stageName}|${statusText}|${reason}|${title}|${analysisType}|${tabId}|${windowId}|${chatUrl}|${sourceUrl}|${autoAttempt}|${autoMax}|${autoReason}|${autoPrompt}`;
    })
    .join(';') + `|sel:${selectedProcessId || ''}`;

  const listChanged = options.force || signature !== lastSignature;
  lastSignature = signature;

  if (listChanged) {
    const seenIds = new Set();
    orderedItems.forEach((process) => {
      const processId = process.id;
      if (!processId) return;
      seenIds.add(processId);

      let entry = processCardMap.get(processId);
      if (!entry) {
        entry = buildProcessCard();
        processCardMap.set(processId, entry);
      }
      updateProcessCard(entry, process, processId === selectedProcessId);
      processList.appendChild(entry.card);
    });

    for (const [processId, entry] of processCardMap.entries()) {
      if (!seenIds.has(processId)) {
        entry.card.remove();
        processCardMap.delete(processId);
        processSeenAt.delete(processId);
      }
    }
  }

  currentProcesses = orderedItems.slice();
  renderDetails();
  updateResumeAllButtonState();
}

function updateHistory(processes) {
  const items = Array.isArray(processes) ? processes.slice() : [];
  items.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  const signature = items
    .map((process) => `${process.id}|${process.timestamp}|${process.status}|${process.currentPrompt}|${process.totalPrompts}|${process.stageIndex || ''}|${process.stageName || ''}|${process.chatUrl || ''}|${process.sourceUrl || ''}|${process.tabId || ''}|${process.windowId || ''}`)
    .join(';');

  if (signature === lastHistorySignature) {
    if (historyToggle) {
      historyToggle.textContent = items.length > 0
        ? `Poprzednie procesy (${items.length})`
        : 'Poprzednie procesy';
    }
    updateResumeAllButtonState();
    return;
  }

  lastHistorySignature = signature;

  if (historyToggle) {
    historyToggle.textContent = items.length > 0
      ? `Poprzednie procesy (${items.length})`
      : 'Poprzednie procesy';
  }

  if (!historyList) return;
  historyList.innerHTML = '';

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'details-empty';
    empty.textContent = 'Brak poprzednich procesow.';
    historyList.appendChild(empty);
    updateResumeAllButtonState();
    return;
  }

  items.forEach((process) => {
    const card = document.createElement('div');
    card.className = 'history-card';
    card.addEventListener('click', () => {
      const analysisType = process.analysisType || 'company';
      const closed = isProcessClosed(process);
      if (analysisType === 'company' && closed) {
        void openResumeStageWithAutoDetect(process);
        return;
      }
      void openHistoryProcess(process);
    });

    const title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = process.title || 'Bez tytulu';

    const stageLabel = resolveStageLabel(process);

    const statusLabel = isProcessClosed(process)
      ? (isFailedStatus(getNormalizedStatus(process)) ? 'Blad' : 'Zakonczono')
      : 'Przerwane';

    const meta = document.createElement('div');
    meta.className = 'history-meta';
    meta.innerHTML = `<span>Etap: ${escapeHtml(stageLabel)}</span><span>${escapeHtml(statusLabel)}</span>`;

    const actions = document.createElement('div');
    actions.className = 'history-actions';

    const openBtn = document.createElement('button');
    openBtn.className = 'history-open';
    openBtn.textContent = 'Otworz ChatGPT';
    const chatLink = resolveChatUrl(process);
    const canFocus = Number.isInteger(process.tabId) || Number.isInteger(process.windowId);
    openBtn.disabled = !(chatLink || canFocus);
    openBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (openBtn.disabled) return;
      openBtn.disabled = true;
      void openHistoryProcess(process).finally(() => {
        setTimeout(() => {
          openBtn.disabled = false;
        }, 600);
      });
    });

    actions.appendChild(openBtn);

    const copyBtn = document.createElement('button');
    copyBtn.className = 'history-open history-copy';
    copyBtn.textContent = 'Skopiuj skonczona odpowiedz';
    copyBtn.disabled = !isProcessCompleted(process);
    copyBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (copyBtn.disabled) return;
      void copyCompletedResponse(process, copyBtn);
    });
    actions.appendChild(copyBtn);

    if ((process.analysisType || 'company') === 'company') {
      const resumeBtn = document.createElement('button');
      resumeBtn.className = 'history-open history-resume-next';
      resumeBtn.textContent = 'Wznow od kolejnego etapu';
      resumeBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        void openResumeStageWithAutoDetect(process, resumeBtn);
      });
      actions.appendChild(resumeBtn);
    }

    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(actions);
    historyList.appendChild(card);
  });
  updateResumeAllButtonState();
}

function getResumeStartIndex(process) {
  if (!process) return null;
  if (Number.isInteger(process.currentPrompt) && process.currentPrompt > 0) return process.currentPrompt;
  if (Number.isInteger(process.stageIndex) && process.stageIndex >= 0) return process.stageIndex + 1;
  return null;
}

function getNeedsActionProcesses() {
  const source = allProcessesCache.length > 0 ? allProcessesCache : currentProcesses;
  return source.filter((process) => !!process?.needsAction && !isProcessClosed(process));
}

function updateResumeAllButtonState() {
  if (!resumeAllBtn) return;

  const needsActionCount = getNeedsActionProcesses().length;
  if (needsActionCount > 0) {
    resumeAllBtn.disabled = false;
    resumeAllBtn.textContent = `Wyslij nastepny prompt we wszystkich (${needsActionCount})`;
    return;
  }

  resumeAllBtn.disabled = true;
  resumeAllBtn.textContent = 'Wyslij nastepny prompt we wszystkich';
}

async function resumeAllProcesses() {
  if (!resumeAllBtn || resumeAllBtn.disabled) return;

  const needsActionProcesses = getNeedsActionProcesses();
  if (needsActionProcesses.length === 0) return;

  resumeAllBtn.disabled = true;
  // Globalne "wznow" = klikniecie "Wyslij nastepny prompt" (skip) dla kazdego zatrzymanego procesu.
  const bulk = await sendDecisionAll('skip');

  // Fallback: jesli bulk nie dostarczyl wszystkich decyzji, dopytaj stan i doslij selektywnie.
  if (!bulk.success || bulk.delivered < needsActionProcesses.length) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await refreshProcesses();
    const remaining = getNeedsActionProcesses();
    if (remaining.length > 0) {
      const fallbackResults = await Promise.all(remaining.map((process) => sendDecision(process, 'skip')));
      if (fallbackResults.some((result) => !result)) {
        console.warn('[panel] Nie wszystkie decyzje RESUME_ALL zostaly dostarczone (bulk+fallback)', {
          bulk,
          remaining: remaining.length
        });
      }
    }
  }

  setTimeout(() => {
    updateResumeAllButtonState();
  }, 700);
}

function openResumeStage(process) {
  let startIndex = getResumeStartIndex(process);
  if (!Number.isInteger(startIndex)) return false;
  if (startIndex < 1) startIndex = 1;
  chrome.runtime.sendMessage({
    type: 'RESUME_STAGE_OPEN',
    startIndex,
    title: process?.title || '',
    analysisType: process?.analysisType || ''
  });
  return true;
}

async function openResumeStageWithAutoDetect(process, button = null) {
  if (!process || (process.analysisType || 'company') !== 'company') {
    return false;
  }

  const autoOpened = await resumeNextStageFromPanel(process, button, { openDialogOnly: true });
  if (autoOpened) {
    return true;
  }

  return openResumeStage(process);
}

async function openHistoryProcess(process) {
  const opened = await openProcessWindow(process);
  if (opened) return;

  chrome.runtime.sendMessage({ type: 'ACTIVATE_TAB', reason: 'history-open' }, () => {
    if (chrome.runtime.lastError) {
      // Ignore if no ChatGPT tab available
    }
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderDetails() {
  const selected = currentProcesses.find((process) => process.id === selectedProcessId);
  if (!selected) {
    detailsEmpty.style.display = 'block';
    detailsContainer.style.display = 'none';
    detailsContainer.innerHTML = '';
    return;
  }

  detailsEmpty.style.display = 'none';
  detailsContainer.style.display = 'flex';
  detailsContainer.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'details-header';

  const titleWrap = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'details-title';
  title.textContent = selected.title || 'Bez tytulu';
  const subtitle = document.createElement('div');
  subtitle.className = 'details-subtitle';
  const selectedStatus = getNormalizedStatus(selected);
  const statusLabel = isCompletedStatus(selectedStatus)
    ? 'Zakonczono'
    : isFailedStatus(selectedStatus)
      ? 'Blad'
      : selected.needsAction
        ? 'Wymaga akcji'
        : 'W trakcie';
  subtitle.textContent = `${selected.analysisType || 'company'} · ${statusLabel}`;
  titleWrap.appendChild(title);
  titleWrap.appendChild(subtitle);

  const metaWrap = document.createElement('div');
  metaWrap.className = 'details-subtitle';
  const detailsProgress = getProgressPercent(selected.currentPrompt, selected.totalPrompts);
  const detailsStage = resolveStageLabel(selected);
  const detailsUpdatedAt = Number.isInteger(selected.timestamp) ? selected.timestamp : selected.startedAt;
  metaWrap.textContent = `Etap: ${detailsStage} | Prompt ${selected.currentPrompt || 0} / ${selected.totalPrompts || 0} (${detailsProgress}%) | Aktualizacja: ${formatRelativeTime(detailsUpdatedAt)}`;

  header.appendChild(titleWrap);
  header.appendChild(metaWrap);

  const autoRecovery = selected?.autoRecovery && typeof selected.autoRecovery === 'object'
    ? selected.autoRecovery
    : null;
  if (autoRecovery) {
    const autoAttempt = Number.isInteger(autoRecovery.attempt) ? autoRecovery.attempt : 0;
    const autoMaxAttempts = Number.isInteger(autoRecovery.maxAttempts) ? autoRecovery.maxAttempts : 0;
    const autoDelaySec = Number.isInteger(autoRecovery.delayMs) ? Math.round(autoRecovery.delayMs / 1000) : 0;
    const autoReason = typeof autoRecovery.reason === 'string' && autoRecovery.reason.trim()
      ? autoRecovery.reason
      : 'unknown';
    const autoCurrentPrompt = Number.isInteger(autoRecovery.currentPrompt) ? autoRecovery.currentPrompt : null;
    const autoLine = document.createElement('div');
    autoLine.className = 'details-subtitle';
    autoLine.textContent = `Auto-recovery: ${autoAttempt}/${autoMaxAttempts}, reason=${autoReason}, delay=${autoDelaySec}s${autoCurrentPrompt !== null ? `, prompt=${autoCurrentPrompt}` : ''}`;
    header.appendChild(autoLine);
  }

  const actions = document.createElement('div');
  actions.className = 'details-actions';
  const chatLink = resolveChatUrl(selected);
  const canFocus = Number.isInteger(selected.tabId) || Number.isInteger(selected.windowId);

  if (chatLink) {
    const openBtn = document.createElement('button');
    openBtn.className = 'details-open';
    openBtn.textContent = 'Otworz ChatGPT';
    openBtn.addEventListener('click', () => {
      openBtn.disabled = true;
      void openProcessWindow(selected).finally(() => {
        setTimeout(() => {
          openBtn.disabled = false;
        }, 600);
      });
    });
    actions.appendChild(openBtn);
  }

  if (canFocus) {
    const focusBtn = document.createElement('button');
    focusBtn.className = 'details-focus';
    focusBtn.textContent = 'Pokaz okno';
    focusBtn.addEventListener('click', () => {
      focusBtn.disabled = true;
      void focusProcessWindow(selected).finally(() => {
        setTimeout(() => {
          focusBtn.disabled = false;
        }, 600);
      });
    });
    actions.appendChild(focusBtn);
  }

  const canResumeNextFromDetails = (selected.analysisType || 'company') === 'company'
    && (selected.needsAction || isProcessClosed(selected));
  if (canResumeNextFromDetails) {
    const resumeNextBtn = document.createElement('button');
    resumeNextBtn.className = 'details-open details-resume-next';
    resumeNextBtn.textContent = 'Resume next stage';
    resumeNextBtn.addEventListener('click', () => {
      void resumeNextStageFromPanel(selected, resumeNextBtn);
    });
    actions.appendChild(resumeNextBtn);
  }

  const copyCompletedBtn = document.createElement('button');
  copyCompletedBtn.className = 'details-copy';
  copyCompletedBtn.textContent = 'Skopiuj skonczona odpowiedz';
  copyCompletedBtn.disabled = !isProcessCompleted(selected);
  copyCompletedBtn.addEventListener('click', () => {
    if (copyCompletedBtn.disabled) return;
    void copyCompletedResponse(selected, copyCompletedBtn);
  });
  actions.appendChild(copyCompletedBtn);

  if (actions.childNodes.length > 0) {
    header.appendChild(actions);
  }
  detailsContainer.appendChild(header);

  const messageList = document.createElement('div');
  messageList.className = 'message-list';

  const messages = Array.isArray(selected.messages) ? selected.messages : [];
  if (messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'details-empty';
    empty.textContent = 'Brak wiadomosci dla tego procesu.';
    messageList.appendChild(empty);
  } else {
    messages.forEach((message, index) => {
      const details = document.createElement('details');
      details.className = `message ${message.role === 'user' ? 'user' : 'assistant'}`;
      if (index === messages.length - 1) {
        details.open = true;
      }

      const summary = document.createElement('summary');
      const summaryLabel = document.createElement('span');
      summaryLabel.className = 'message-summary';
      const roleLabel = message.role === 'user' ? 'User' : 'Bot';
      const stageLabel = message.stageName
        ? message.stageName
        : (Number.isInteger(message.stageIndex) ? `Prompt ${message.stageIndex + 1}` : 'Wiadomosc');
      const truncatedLabel = message.truncated ? ' - skrocone' : '';
      summaryLabel.textContent = `${roleLabel} · ${stageLabel}${truncatedLabel}`;

      const preview = document.createElement('span');
      preview.className = 'message-preview';
      const previewText = (message.text || '').replace(/\s+/g, ' ').trim();
      preview.textContent = previewText.length > 140 ? `${previewText.slice(0, 140)}...` : previewText;

      summary.appendChild(summaryLabel);
      summary.appendChild(preview);

      const body = document.createElement('div');
      body.className = 'message-body';
      let bodyText = message.text || '';
      if (message.truncated && message.fullLength) {
        bodyText += `\n\n[Przycieto z ${message.fullLength} znakow]`;
      }
      body.textContent = bodyText;

      details.appendChild(summary);
      details.appendChild(body);
      messageList.appendChild(details);
    });
  }

  detailsContainer.appendChild(messageList);
}


