const refreshBtn = document.getElementById('refresh-btn');
const runBtn = document.getElementById('run-btn');
const run10Btn = document.getElementById('run-10-btn');
const openPanelBtn = document.getElementById('open-panel-btn');
const sourceFilterSelect = document.getElementById('source-filter');
const statusBox = document.getElementById('status');
const processBody = document.getElementById('process-body');
const batchBody = document.getElementById('batch-body');
const metricTotal = document.getElementById('metric-total');
const metricRunnable = document.getElementById('metric-runnable');
const metricMissing = document.getElementById('metric-missing');
const metricBatchStatus = document.getElementById('metric-batch-status');
const metricProgress = document.getElementById('metric-progress');

const FAILED_PROCESS_STATUSES = new Set([
  'failed',
  'error',
  'aborted',
  'cancelled',
  'canceled',
  'stopped',
  'crashed'
]);

let lastListResult = null;
let lastBatchState = null;
let refreshInProgress = false;
let pendingRefresh = false;
let pollIntervalId = null;
let selectedSourceFilter = 'all';

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

function normalizeSourceFilter(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized || normalized === 'all') return 'all';
  return normalized;
}

function normalizeProcessStatusToken(status) {
  return typeof status === 'string' ? status.trim().toLowerCase() : '';
}

function formatSelectionStrategy(strategy) {
  const normalized = typeof strategy === 'string' ? strategy.trim().toLowerCase() : '';
  if (normalized === 'most_advanced_incomplete_first') {
    return 'top-progress';
  }
  if (normalized === 'latest_update_first') {
    return 'latest';
  }
  return normalized || '-';
}

function isFailedProcessStatus(status) {
  return FAILED_PROCESS_STATUSES.has(normalizeProcessStatusToken(status));
}

function formatStatusText(status) {
  const normalized = normalizeProcessStatusToken(status);
  if (!normalized) return '-';
  return normalized.replace(/_/g, ' ');
}

function resolveProcessStatusModel(item) {
  const status = normalizeProcessStatusToken(item?.status);
  if (item?.isFailedStatus === true || isFailedProcessStatus(status)) {
    return {
      text: formatStatusText(status || 'failed'),
      className: 'status-failed'
    };
  }
  if (status === 'running') {
    return {
      text: 'running',
      className: 'status-running'
    };
  }
  if (status === 'completed') {
    return {
      text: 'completed',
      className: 'status-completed'
    };
  }
  if (status === 'needs_action' || item?.needsAction === true) {
    return {
      text: 'needs action',
      className: 'status-needs-action'
    };
  }
  return {
    text: formatStatusText(status || 'unknown'),
    className: 'status-other'
  };
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

function rebuildSourceFilterOptions(listResult) {
  if (!sourceFilterSelect) return;
  const availableSources = Array.isArray(listResult?.availableSources) ? listResult.availableSources : [];
  const requestedFilter = normalizeSourceFilter(listResult?.sourceFilter || selectedSourceFilter);
  selectedSourceFilter = requestedFilter;

  sourceFilterSelect.innerHTML = '';

  const totalAcrossSources = availableSources.reduce((sum, source) => {
    const total = Number.isInteger(source?.total) ? source.total : 0;
    return sum + total;
  }, 0);

  const allOption = document.createElement('option');
  allOption.value = 'all';
  allOption.textContent = `Wszystkie zrodla (${totalAcrossSources})`;
  sourceFilterSelect.appendChild(allOption);

  const knownValues = new Set(['all']);
  availableSources.forEach((source) => {
    const key = normalizeSourceFilter(source?.key);
    if (key === 'all' || knownValues.has(key)) return;
    const label = typeof source?.label === 'string' && source.label.trim()
      ? source.label.trim()
      : key;
    const total = Number.isInteger(source?.total) ? source.total : 0;
    const runnable = Number.isInteger(source?.runnable) ? source.runnable : 0;
    const option = document.createElement('option');
    option.value = key;
    option.textContent = `${label} (${total}, run=${runnable})`;
    sourceFilterSelect.appendChild(option);
    knownValues.add(key);
  });

  if (!knownValues.has(selectedSourceFilter) && selectedSourceFilter !== 'all') {
    const missingOption = document.createElement('option');
    missingOption.value = selectedSourceFilter;
    missingOption.textContent = `${selectedSourceFilter} (0)`;
    sourceFilterSelect.appendChild(missingOption);
    knownValues.add(selectedSourceFilter);
  }

  if (!knownValues.has(selectedSourceFilter)) {
    selectedSourceFilter = 'all';
  }
  sourceFilterSelect.value = selectedSourceFilter;
}

function renderMetrics(listResult, batchState) {
  const list = listResult && typeof listResult === 'object' ? listResult : {};
  const state = batchState && typeof batchState === 'object' ? batchState : {};
  const totals = state?.totals && typeof state.totals === 'object' ? state.totals : {};
  const selection = state?.selection && typeof state.selection === 'object' ? state.selection : {};
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

  const selectionSource = normalizeSourceFilter(selection?.sourceFilter || 'all');
  const selectionLimitApplied = Number.isInteger(selection?.limitApplied) ? selection.limitApplied : null;
  const selectionLimitRequested = Number.isInteger(selection?.limitRequested) ? selection.limitRequested : null;
  const selectionLimit = selectionLimitApplied ?? selectionLimitRequested;
  const selectionLabel = typeof selection?.sourceLabel === 'string' && selection.sourceLabel.trim()
    ? selection.sourceLabel.trim()
    : selectionSource;
  const selectionStrategy = formatSelectionStrategy(selection?.strategy);
  const details = document.createElement('div');
  details.textContent = [
    '',
    `job: ${state?.jobId || '-'} | active: ${state?.activeRunId || '-'}`,
    `src: ${selectionLabel || 'all'} | limit: ${selectionLimit || 'all'} | mode: ${selectionStrategy}`
  ].join('\n');
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
    processBody.appendChild(createPlaceholderRow(9, 'Brak procesow do recovery.'));
    return;
  }

  items.forEach((item, index) => {
    const row = document.createElement('tr');
    const runId = typeof item?.runId === 'string' ? item.runId : '';
    const statusModel = resolveProcessStatusModel(item);
    const sourceLabel = typeof item?.sourceLabel === 'string' && item.sourceLabel.trim()
      ? item.sourceLabel.trim()
      : (typeof item?.sourceKey === 'string' && item.sourceKey.trim() ? item.sourceKey.trim() : 'unknown');
    const stageText = Number.isInteger(item?.currentPrompt) && item.currentPrompt > 0
      ? `snapshot P${item.currentPrompt}/${Number.isInteger(item?.totalPrompts) ? item.totalPrompts : 0} ${item?.stageName || ''}`.trim()
      : (item?.stageName ? `snapshot ${item.stageName}` : '-');
    const updated = formatDateTime(Number.isInteger(item?.timestamp) ? item.timestamp : null);
    const hasChatUrl = item?.hasChatUrl === true;
    const runnableText = hasChatUrl ? 'YES' : 'NO';

    const orderCell = document.createElement('td');
    orderCell.textContent = String(index + 1);
    row.appendChild(orderCell);

    const runIdCell = document.createElement('td');
    runIdCell.className = 'mono';
    runIdCell.textContent = runId || '-';
    row.appendChild(runIdCell);

    const statusCell = document.createElement('td');
    const statusChip = document.createElement('span');
    statusChip.className = `status-chip ${statusModel.className}`;
    statusChip.textContent = statusModel.text;
    statusCell.appendChild(statusChip);
    row.appendChild(statusCell);

    const sourceCell = document.createElement('td');
    const sourceChip = document.createElement('span');
    sourceChip.className = 'source-chip';
    sourceChip.textContent = sourceLabel;
    sourceChip.title = sourceLabel;
    sourceCell.appendChild(sourceChip);
    row.appendChild(sourceCell);

    const stageCell = document.createElement('td');
    stageCell.textContent = stageText;
    row.appendChild(stageCell);

    const updatedCell = document.createElement('td');
    updatedCell.textContent = updated;
    row.appendChild(updatedCell);

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
  if (runBtn) {
    runBtn.disabled = running;
    runBtn.textContent = running ? 'Batch w trakcie...' : 'Uruchom wszystkie';
  }
  if (run10Btn) {
    run10Btn.disabled = running;
    run10Btn.textContent = running ? 'Batch w trakcie...' : 'Uruchom 10';
  }
  if (sourceFilterSelect) {
    sourceFilterSelect.disabled = running;
  }
}

function applyData(listResult, batchState) {
  lastListResult = listResult && typeof listResult === 'object' ? listResult : null;
  lastBatchState = batchState && typeof batchState === 'object' ? batchState : null;
  rebuildSourceFilterOptions(lastListResult);
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
        includeNonCompleted: true,
        recoverOnly: true,
        sourceFilter: selectedSourceFilter
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
    const filterMatched = listResult?.sourceFilterMatched !== false;
    const filterNote = selectedSourceFilter !== 'all'
      ? ` | source=${selectedSourceFilter}${filterMatched ? '' : ' (0 match)'}`
      : '';
    setStatus(`Lista odswiezona: ${formatDateTime(listResult.generatedAt)} | batch updated: ${updatedAt}${filterNote}`);
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

async function startBatch(limit = null) {
  updateRunButtonState({ status: 'running' });
  const limitText = Number.isInteger(limit) && limit > 0 ? `${limit}` : 'all';
  const modeText = Number.isInteger(limit) && limit > 0 ? 'top-progress' : 'latest';
  setStatus(`Uruchamiam batch wznowienia (source=${selectedSourceFilter}, limit=${limitText}, mode=${modeText})...`);
  try {
    const response = await sendRuntimeMessage({
      type: 'RESUME_UNFINISHED_PROCESSES',
      origin: 'unfinished-processes-page',
      forceRestartIfRunning: false,
      sourceFilter: selectedSourceFilter,
      limit: Number.isInteger(limit) && limit > 0 ? limit : null
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
    updateRunButtonState(lastBatchState);
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
    void startBatch(null);
  });
}

if (run10Btn) {
  run10Btn.addEventListener('click', () => {
    void startBatch(10);
  });
}

if (sourceFilterSelect) {
  sourceFilterSelect.addEventListener('change', () => {
    selectedSourceFilter = normalizeSourceFilter(sourceFilterSelect.value);
    void refreshData();
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
