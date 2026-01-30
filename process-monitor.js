// process-monitor.js - UI dla centralnego okna monitoringu
const processList = document.getElementById('process-list');
const emptyState = document.getElementById('empty-state');
const detailsEmpty = document.getElementById('details-empty');
const detailsContainer = document.getElementById('process-details');
const historyToggle = document.getElementById('history-toggle');
const historyList = document.getElementById('history-list');

let selectedProcessId = null;
let currentProcesses = [];
let lastSignature = '';
let lastHistorySignature = '';
let historyOpen = false;
const processCardMap = new Map();
const processSeenAt = new Map();

console.log('🔍 Monitor procesów uruchomiony');

// Pobierz procesy przy starcie
refreshProcesses();

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

const reasonLabels = {
  send_failed: 'Blad wysylania promptu',
  timeout: 'Timeout odpowiedzi',
  invalid_response: 'Za krotka odpowiedz'
};

function resolveStageLabel(process) {
  if (process?.stageName) return process.stageName;
  if (Number.isInteger(process?.stageIndex)) return `Stage ${process.stageIndex + 1}`;
  if (process?.currentPrompt) return `Prompt ${process.currentPrompt}`;
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
    void focusProcessWindow(process);
  });

  waitBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    const process = card.__process;
    if (!process) return;
    waitBtn.disabled = true;
    skipBtn.disabled = true;
    sendDecision(process, 'wait');
  });

  skipBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    const process = card.__process;
    if (!process) return;
    waitBtn.disabled = true;
    skipBtn.disabled = true;
    sendDecision(process, 'skip');
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

  refs.statusLine.textContent = `Prompt ${currentPrompt} / ${totalPrompts}`;

  let statusBadgeText = 'W trakcie';
  let statusBadgeClass = 'status-running';
  if (process.needsAction) {
    statusBadgeText = 'WYMAGA AKCJI';
    statusBadgeClass = 'status-needs-action';
  } else if (process.status === 'completed') {
    statusBadgeText = 'Zakonczono';
    statusBadgeClass = 'status-completed';
  } else if (process.status === 'failed') {
    statusBadgeText = 'Blad';
    statusBadgeClass = 'status-failed';
  }

  refs.statusBadge.textContent = statusBadgeText;
  refs.statusBadge.className = `status-badge ${statusBadgeClass}`;

  const progress = totalPrompts > 0
    ? Math.round((currentPrompt / totalPrompts) * 100)
    : 0;
  refs.progressFill.style.width = `${progress}%`;

  const stageLabel = resolveStageLabel(process);
  refs.stageMeta.textContent = `Etap: ${stageLabel}`;

  const statusLine = process.statusText ? String(process.statusText) : '';
  if (statusLine) {
    refs.statusMeta.textContent = `Status: ${statusLine}`;
    refs.statusMeta.style.display = 'block';
  } else {
    refs.statusMeta.textContent = '';
    refs.statusMeta.style.display = 'none';
  }

  let reasonText = null;
  if (process.reason) {
    reasonText = reasonLabels[process.reason] || process.reason;
  } else if (process.status === 'failed' && process.error) {
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

const CLOSED_STATUSES = new Set(['completed', 'failed', 'closed']);
const STATUS_CACHE_TTL_MS = 2500;
const tabStatusCache = new Map();
const windowStatusCache = new Map();
let updateSequence = 0;

function isProcessClosed(process) {
  if (!process) return true;
  const status = typeof process.status === 'string' ? process.status.toLowerCase() : '';
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

  const checks = await Promise.all(active.map(async (process) => {
    const tabId = Number.isInteger(process.tabId) ? process.tabId : null;
    const windowId = Number.isInteger(process.windowId) ? process.windowId : null;

    if (!tabId && !windowId) return true;

    if (tabId) {
      const tabExists = await checkTabExists(tabId);
      if (tabExists !== false) return true; // true or unknown => keep
      if (windowId) {
        const windowExists = await checkWindowExists(windowId);
        return windowExists !== false;
      }
      return false;
    }

    const windowExists = await checkWindowExists(windowId);
    return windowExists !== false;
  }));

  return active.filter((_, index) => checks[index]);
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
  const items = Array.isArray(processes) ? processes.slice() : [];
  try {
    const active = await filterActiveProcesses(items);
    if (requestId !== updateSequence) return;
    updateUI(active, options);
    const activeIds = new Set(active.map((process) => process.id));
    const history = items.filter((process) => !activeIds.has(process.id));
    updateHistory(history);
  } catch (error) {
    console.warn('[panel] Nie udalo sie odswiezyc procesow:', error);
    if (requestId !== updateSequence) return;
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

function refreshProcesses() {
  chrome.runtime.sendMessage({ type: 'GET_PROCESSES' }, (response) => {
    if (response && response.processes) {
      applyProcessesUpdate(response.processes);
    }
  });
}

function sendDecision(process, decision) {
  if (!process || !process.id) return;
  chrome.runtime.sendMessage({
    type: 'PROCESS_DECISION',
    runId: process.id,
    decision,
    origin: 'panel',
    tabId: Number.isInteger(process.tabId) ? process.tabId : null,
    windowId: Number.isInteger(process.windowId) ? process.windowId : null
  });
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
      const sortKey = getProcessSortKey(process);
      return `${process.id}|${sortKey}|${process.status}|${process.needsAction}|${process.currentPrompt || 0}|${process.totalPrompts || 0}|${stageKey}|${stageName}|${statusText}|${reason}|${title}|${analysisType}`;
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
}

function updateHistory(processes) {
  const items = Array.isArray(processes) ? processes.slice() : [];
  items.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  const signature = items
    .map((process) => `${process.id}|${process.timestamp}|${process.status}|${process.currentPrompt}|${process.totalPrompts}|${process.stageIndex || ''}|${process.stageName || ''}|${process.chatUrl || ''}|${process.sourceUrl || ''}`)
    .join(';');

  if (signature === lastHistorySignature) {
    if (historyToggle) {
      historyToggle.textContent = items.length > 0
        ? `Poprzednie procesy (${items.length})`
        : 'Poprzednie procesy';
    }
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
    return;
  }

  items.forEach((process) => {
    const card = document.createElement('div');
    card.className = 'history-card';
    card.addEventListener('click', () => {
      const analysisType = process.analysisType || 'company';
      const closed = isProcessClosed(process);
      if (analysisType === 'company' && closed && openResumeStage(process)) {
        return;
      }
      void openHistoryProcess(process);
    });

    const title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = process.title || 'Bez tytulu';

    const stageLabel = process.stageName
      ? process.stageName
      : (Number.isInteger(process.stageIndex)
        ? `Stage ${process.stageIndex + 1}`
        : (process.currentPrompt ? `Prompt ${process.currentPrompt}${process.totalPrompts ? ` / ${process.totalPrompts}` : ''}` : 'Start'));

    const statusLabel = isProcessClosed(process)
      ? (process.status === 'failed' ? 'Blad' : 'Zakonczono')
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

    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(actions);
    historyList.appendChild(card);
  });
}

function getResumeStartIndex(process) {
  if (!process) return null;
  if (Number.isInteger(process.stageIndex)) return process.stageIndex;
  if (Number.isInteger(process.currentPrompt) && process.currentPrompt > 0) return process.currentPrompt;
  return null;
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

async function openHistoryProcess(process) {
  const focused = await focusProcessWindow(process);
  if (focused) return;

  if (openChatTab(process)) return;

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
  const statusLabel = selected.status === 'completed'
    ? 'Zakonczono'
    : selected.status === 'failed'
      ? 'Blad'
      : selected.needsAction
        ? 'Wymaga akcji'
        : 'W trakcie';
  subtitle.textContent = `${selected.analysisType || 'company'} · ${statusLabel}`;
  titleWrap.appendChild(title);
  titleWrap.appendChild(subtitle);

  const metaWrap = document.createElement('div');
  metaWrap.className = 'details-subtitle';
  metaWrap.textContent = `Prompt ${selected.currentPrompt || 0} / ${selected.totalPrompts || 0}`;

  header.appendChild(titleWrap);
  header.appendChild(metaWrap);

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
      openChatTab(selected);
      setTimeout(() => {
        openBtn.disabled = false;
      }, 600);
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


