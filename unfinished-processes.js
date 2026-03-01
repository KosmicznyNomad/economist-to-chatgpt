const refreshBtn = document.getElementById('refresh-btn');
const runBtn = document.getElementById('run-btn');
const openPanelBtn = document.getElementById('open-panel-btn');
const statusBox = document.getElementById('status');
const processBody = document.getElementById('process-body');
const batchBody = document.getElementById('batch-body');
const metricTotal = document.getElementById('metric-total');
const metricRunnable = document.getElementById('metric-runnable');
const metricMissing = document.getElementById('metric-missing');
const metricBatchStatus = document.getElementById('metric-batch-status');
const metricProgress = document.getElementById('metric-progress');

let lastListResult = null;
let lastBatchState = null;
let refreshInProgress = false;
let pendingRefresh = false;
let pollIntervalId = null;

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
  if (!statusBox) return;
  statusBox.textContent = typeof text === 'string' ? text : '';
  statusBox.classList.toggle('error', !!isError);
}

function formatDateTime(ts) {
  if (!Number.isInteger(ts) || ts <= 0) return '-';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '-';
  }
}

function shortenText(text, maxLength = 96) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return '';
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function normalizeBatchStatus(status) {
  const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
  if (!normalized) return 'idle';
  if (normalized === 'running') return 'running';
  if (normalized === 'completed') return 'completed';
  if (normalized === 'completed_with_errors') return 'completed_with_errors';
  if (normalized === 'interrupted') return 'interrupted';
  return 'idle';
}

function createPlaceholderRow(colspan, text) {
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = colspan;
  cell.className = 'placeholder';
  cell.textContent = text;
  row.appendChild(cell);
  return row;
}

function openChat(url) {
  const chatUrl = typeof url === 'string' ? url.trim() : '';
  if (!chatUrl) return;
  chrome.tabs.create({ url: chatUrl });
}

function renderMetrics(listResult, batchState) {
  const list = listResult && typeof listResult === 'object' ? listResult : {};
  const state = batchState && typeof batchState === 'object' ? batchState : {};
  const totals = state?.totals && typeof state.totals === 'object' ? state.totals : {};
  const status = normalizeBatchStatus(state?.status);
  const processed = Number.isInteger(totals?.processed) ? totals.processed : 0;
  const total = Number.isInteger(totals?.total) ? totals.total : (Number.isInteger(list?.total) ? list.total : 0);

  metricTotal.textContent = String(Number.isInteger(list?.total) ? list.total : 0);
  metricRunnable.textContent = String(Number.isInteger(list?.runnable) ? list.runnable : 0);
  metricMissing.textContent = String(Number.isInteger(list?.skippedMissingUrl) ? list.skippedMissingUrl : 0);

  metricBatchStatus.innerHTML = '';
  const badge = document.createElement('span');
  badge.className = `badge badge-${status}`;
  badge.textContent = status;
  metricBatchStatus.appendChild(badge);

  const details = document.createElement('div');
  details.textContent = `\njob: ${state?.jobId || '-'} | active: ${state?.activeRunId || '-'}`;
  metricBatchStatus.appendChild(details);

  const resumed = Number.isInteger(totals?.resumed) ? totals.resumed : 0;
  const failed = Number.isInteger(totals?.failed) ? totals.failed : 0;
  const skippedMissing = Number.isInteger(totals?.skipped_missing_chat_url) ? totals.skipped_missing_chat_url : 0;
  const skippedNotFound = Number.isInteger(totals?.skipped_not_found) ? totals.skipped_not_found : 0;
  const skippedDone = Number.isInteger(totals?.skipped_already_completed) ? totals.skipped_already_completed : 0;
  metricProgress.textContent = `${processed}/${total} | resumed=${resumed} | failed=${failed}`;
  const progressExtra = document.createElement('div');
  progressExtra.textContent = `\nskip_url=${skippedMissing} | skip_not_found=${skippedNotFound} | skip_done=${skippedDone}`;
  metricProgress.appendChild(progressExtra);
}

function renderProcessRows(listResult) {
  processBody.innerHTML = '';
  const items = Array.isArray(listResult?.items) ? listResult.items : [];
  if (items.length === 0) {
    processBody.appendChild(createPlaceholderRow(8, 'Brak niedokonczonych procesow.'));
    return;
  }

  items.forEach((item, index) => {
    const row = document.createElement('tr');
    const runId = typeof item?.runId === 'string' ? item.runId : '';
    const status = typeof item?.status === 'string' ? item.status : '';
    const stageText = Number.isInteger(item?.currentPrompt) && item.currentPrompt > 0
      ? `P${item.currentPrompt}/${Number.isInteger(item?.totalPrompts) ? item.totalPrompts : 0} ${item?.stageName || ''}`.trim()
      : (item?.stageName || '-');
    const updated = formatDateTime(Number.isInteger(item?.timestamp) ? item.timestamp : null);
    const hasChatUrl = item?.hasChatUrl === true;
    const runnableText = hasChatUrl ? 'YES' : 'NO';

    [
      String(index + 1),
      runId || '-',
      status || '-',
      stageText,
      updated
    ].forEach((value, cellIndex) => {
      const cell = document.createElement('td');
      if (cellIndex === 1) cell.className = 'mono';
      cell.textContent = value;
      row.appendChild(cell);
    });

    const chatCell = document.createElement('td');
    chatCell.textContent = hasChatUrl ? shortenText(item.chatUrl, 82) : '-';
    row.appendChild(chatCell);

    const runnableCell = document.createElement('td');
    runnableCell.textContent = runnableText;
    runnableCell.className = hasChatUrl ? 'outcome-resumed' : 'outcome-skipped_missing_chat_url';
    row.appendChild(runnableCell);

    const actionCell = document.createElement('td');
    if (hasChatUrl) {
      const openBtn = document.createElement('button');
      openBtn.className = 'link-btn';
      openBtn.textContent = 'Otworz chat';
      openBtn.addEventListener('click', () => openChat(item.chatUrl));
      actionCell.appendChild(openBtn);
    } else {
      actionCell.textContent = '-';
    }
    row.appendChild(actionCell);

    processBody.appendChild(row);
  });
}

function renderBatchRows(state) {
  batchBody.innerHTML = '';
  const rows = Array.isArray(state?.rows) ? state.rows.slice() : [];
  if (rows.length === 0) {
    batchBody.appendChild(createPlaceholderRow(9, 'Czekam na uruchomienie batch.'));
    return;
  }

  rows.reverse().forEach((item, index) => {
    const row = document.createElement('tr');
    const outcome = typeof item?.outcome === 'string' ? item.outcome : '';
    const detected = Number.isInteger(item?.detectedPromptNumber) ? item.detectedPromptNumber : null;
    const started = Number.isInteger(item?.startPromptNumber) ? item.startPromptNumber : null;
    const detectedStartText = `${detected !== null ? `P${detected}` : '-'} -> ${started !== null ? `P${started}` : '-'}`;

    const cells = [
      String(index + 1),
      item?.runId || '-',
      shortenText(item?.title || '-', 78),
      outcome || '-',
      detectedStartText,
      item?.detectedMethod || '-',
      shortenText(item?.reason || '-', 64),
      shortenText(item?.error || '-', 90)
    ];
    cells.forEach((value, cellIndex) => {
      const cell = document.createElement('td');
      if (cellIndex === 1) cell.className = 'mono';
      if (cellIndex === 3) {
        cell.className = `outcome-${outcome || 'failed'}`;
      }
      cell.textContent = value;
      row.appendChild(cell);
    });

    const chatCell = document.createElement('td');
    if (typeof item?.chatUrl === 'string' && item.chatUrl.trim()) {
      const openBtn = document.createElement('button');
      openBtn.className = 'link-btn';
      openBtn.textContent = 'Otworz';
      openBtn.addEventListener('click', () => openChat(item.chatUrl));
      chatCell.appendChild(openBtn);
    } else {
      chatCell.textContent = '-';
    }
    row.appendChild(chatCell);

    batchBody.appendChild(row);
  });
}

function updateRunButtonState(state) {
  const status = normalizeBatchStatus(state?.status);
  const running = status === 'running';
  runBtn.disabled = running;
  runBtn.textContent = running ? 'Batch w trakcie...' : 'Uruchom wszystkie';
}

function applyData(listResult, batchState) {
  lastListResult = listResult && typeof listResult === 'object' ? listResult : null;
  lastBatchState = batchState && typeof batchState === 'object' ? batchState : null;
  renderMetrics(lastListResult, lastBatchState);
  renderProcessRows(lastListResult);
  renderBatchRows(lastBatchState);
  updateRunButtonState(lastBatchState);
}

async function refreshData(options = {}) {
  if (refreshInProgress) {
    pendingRefresh = true;
    return;
  }
  refreshInProgress = true;
  const silent = options?.silent === true;
  if (!silent) {
    setStatus('Odswiezam dane...');
  }

  try {
    const [listResult, batchStateResult] = await Promise.all([
      sendRuntimeMessage({
        type: 'GET_UNFINISHED_PROCESSES',
        includeNonCompleted: true
      }),
      sendRuntimeMessage({
        type: 'GET_UNFINISHED_RESUME_BATCH_STATE'
      })
    ]);

    if (listResult?.success === false) {
      throw new Error(listResult?.error || 'failed_to_fetch_unfinished_processes');
    }
    if (batchStateResult?.success === false) {
      throw new Error(batchStateResult?.error || 'failed_to_fetch_batch_state');
    }

    applyData(listResult, batchStateResult?.state || null);
    const state = batchStateResult?.state || {};
    const updatedAt = Number.isInteger(state?.updatedAt) ? formatDateTime(state.updatedAt) : '-';
    setStatus(`Lista odswiezona: ${formatDateTime(listResult.generatedAt)} | batch updated: ${updatedAt}`);
  } catch (error) {
    setStatus(`Blad odswiezania: ${error?.message || String(error)}`, true);
  } finally {
    refreshInProgress = false;
    if (pendingRefresh) {
      pendingRefresh = false;
      void refreshData({ silent: true });
    }
  }
}

async function startBatch() {
  runBtn.disabled = true;
  setStatus('Uruchamiam batch wznowienia...');
  try {
    const response = await sendRuntimeMessage({
      type: 'RESUME_UNFINISHED_PROCESSES',
      origin: 'unfinished-processes-page',
      forceRestartIfRunning: false
    });
    if (response?.success === false) {
      throw new Error(response?.error || 'resume_unfinished_failed');
    }
    if (response?.alreadyRunning) {
      applyData(lastListResult, response?.state || lastBatchState);
      setStatus(`Batch juz dziala (jobId=${response?.jobId || '-'})`);
      return;
    }

    applyData(lastListResult, response?.state || null);
    setStatus(`Batch wystartowal (jobId=${response?.jobId || '-'})`);
    void refreshData({ silent: true });
  } catch (error) {
    setStatus(`Blad startu batch: ${error?.message || String(error)}`, true);
    runBtn.disabled = false;
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'UNFINISHED_RESUME_BATCH_UPDATED') return;
  const state = message?.state && typeof message.state === 'object' ? message.state : null;
  if (!state) return;
  applyData(lastListResult, state);
  const status = normalizeBatchStatus(state.status);
  if (status === 'running') {
    const processed = Number.isInteger(state?.totals?.processed) ? state.totals.processed : 0;
    const total = Number.isInteger(state?.totals?.total) ? state.totals.total : 0;
    setStatus(`Batch running: ${processed}/${total} | active=${state.activeRunId || '-'}`);
  } else {
    setStatus(`Batch status: ${status} | updated: ${formatDateTime(state.updatedAt)}`);
    void refreshData({ silent: true });
  }
});

if (refreshBtn) {
  refreshBtn.addEventListener('click', () => {
    void refreshData();
  });
}

if (runBtn) {
  runBtn.addEventListener('click', () => {
    void startBatch();
  });
}

if (openPanelBtn) {
  openPanelBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('process-monitor.html') });
  });
}

if (pollIntervalId) {
  window.clearInterval(pollIntervalId);
}
pollIntervalId = window.setInterval(() => {
  void refreshData({ silent: true });
}, 5000);

void refreshData();
