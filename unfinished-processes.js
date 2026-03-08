const refreshBtn = document.getElementById('refresh-btn');
const runBtn = document.getElementById('run-btn');
const run10Btn = document.getElementById('run-10-btn');
const openPanelBtn = document.getElementById('open-panel-btn');
const sourceFilterSelect = document.getElementById('source-filter');
const statusBox = document.getElementById('status');
const statusTitleBox = document.getElementById('status-title');
const statusMetaBox = document.getElementById('status-meta');
const statusHintsBox = document.getElementById('status-hints');
const processBody = document.getElementById('process-body');
const batchBody = document.getElementById('batch-body');
const metricTotal = document.getElementById('metric-total');
const metricRunnable = document.getElementById('metric-runnable');
const metricRunnableCaption = document.getElementById('metric-runnable-caption');
const metricRunnableBar = document.getElementById('metric-runnable-bar');
const metricMissing = document.getElementById('metric-missing');
const metricMissingCaption = document.getElementById('metric-missing-caption');
const metricBatchStatus = document.getElementById('metric-batch-status');
const metricProgress = document.getElementById('metric-progress');
const metricProgressBar = document.getElementById('metric-progress-bar');
const countingSummary = document.getElementById('counting-summary');
const selectionSummary = document.getElementById('selection-summary');
const UNFINISHED_RESUME_KEEPALIVE_INTERVAL_MS = 15000;
const UNFINISHED_RESUME_POLL_INTERVAL_MS = 5000;

const CLOSED_PROCESS_STATUSES = new Set([
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
const FAILED_PROCESS_STATUSES = new Set([
  'failed',
  'error',
  'aborted',
  'cancelled',
  'canceled',
  'stopped',
  'crashed'
]);
const urlParams = new URLSearchParams(window.location.search);
const serviceMode = typeof urlParams.get('mode') === 'string'
  ? urlParams.get('mode').trim().toLowerCase()
  : '';
const STALE_RUNNING_RECOVERY_MODE = serviceMode === 'stale-running-recovery';
const staleHoursParam = Number.parseFloat(urlParams.get('staleHours'));
const STALE_RUNNING_RECOVERY_HOURS = Number.isFinite(staleHoursParam) && staleHoursParam > 0
  ? Math.max(0.25, Math.min(staleHoursParam, 168))
  : 4;
const STALE_RUNNING_RECOVERY_THRESHOLD_MS = Math.round(STALE_RUNNING_RECOVERY_HOURS * 60 * 60 * 1000);
const serviceLimitParam = Number.parseInt(urlParams.get('limit'), 10);
const STALE_RUNNING_RECOVERY_LIMIT = Number.isInteger(serviceLimitParam) && serviceLimitParam > 0
  ? Math.min(serviceLimitParam, 1000)
  : null;
const STALE_RUNNING_RECOVERY_AUTORUN = (
  urlParams.get('autorun') === '1'
  || urlParams.get('autorun') === 'true'
  || urlParams.get('autorun') === 'yes'
);

let lastListResult = null;
let lastBatchState = null;
let refreshInProgress = false;
let pendingRefresh = false;
let pollIntervalId = null;
let selectedSourceFilter = 'all';
let keepalivePort = null;
let keepaliveTimerId = null;
let keepaliveReconnectTimerId = null;
let pageIsClosing = false;
const keepalivePageId = `unfinished-resume-page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const serviceRecoveredRunIds = new Set();
let serviceBatchState = null;
let serviceAutoRunStarted = false;

function isUnfinishedPageVisible() {
  return document.visibilityState === 'visible';
}

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

function getKeepaliveState() {
  return normalizeBatchStatus(lastBatchState?.status) === 'running' ? 'running' : 'idle';
}

function postKeepaliveTick() {
  if (!keepalivePort) return;
  try {
    keepalivePort.postMessage({
      type: 'UNFINISHED_RESUME_PAGE_KEEPALIVE',
      pageId: keepalivePageId,
      state: getKeepaliveState(),
      sourceFilter: selectedSourceFilter,
      timestamp: Date.now()
    });
  } catch (_) {
    // onDisconnect handles cleanup.
  }
}

function stopWorkerKeepalive() {
  pageIsClosing = true;
  if (keepaliveTimerId !== null) {
    clearInterval(keepaliveTimerId);
    keepaliveTimerId = null;
  }
  if (keepaliveReconnectTimerId !== null) {
    clearTimeout(keepaliveReconnectTimerId);
    keepaliveReconnectTimerId = null;
  }
  if (!keepalivePort) return;
  try {
    keepalivePort.disconnect();
  } catch (_) {
    // Ignore disconnect races.
  }
  keepalivePort = null;
}

function startWorkerKeepalive() {
  if (keepalivePort) return;
  pageIsClosing = false;
  if (keepaliveReconnectTimerId !== null) {
    clearTimeout(keepaliveReconnectTimerId);
    keepaliveReconnectTimerId = null;
  }
  try {
    keepalivePort = chrome.runtime.connect({ name: `unfinished-resume-page:${keepalivePageId}` });
    keepalivePort.onDisconnect.addListener(() => {
      keepalivePort = null;
      if (keepaliveTimerId !== null) {
        clearInterval(keepaliveTimerId);
        keepaliveTimerId = null;
      }
      const batchRunning = normalizeBatchStatus(lastBatchState?.status) === 'running';
      if (batchRunning) {
        setStatus('Polaczenie z workerem zostalo przerwane', {
          meta: 'Batch moze zostac zatrzymany po uspieniu workera lub przeladowaniu rozszerzenia.',
          hints: ['odswiez strone recovery', 'sprawdz log worker service'],
          isError: true
        });
      }
      if (!pageIsClosing && keepaliveReconnectTimerId === null) {
        keepaliveReconnectTimerId = window.setTimeout(() => {
          keepaliveReconnectTimerId = null;
          startWorkerKeepalive();
        }, 1500);
      }
    });
    postKeepaliveTick();
    keepaliveTimerId = setInterval(() => {
      postKeepaliveTick();
    }, UNFINISHED_RESUME_KEEPALIVE_INTERVAL_MS);
  } catch (_) {
    keepalivePort = null;
    if (keepaliveTimerId !== null) {
      clearInterval(keepaliveTimerId);
      keepaliveTimerId = null;
    }
  }
}

function clearNode(node) {
  if (!node) return;
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function createTextLine(text, className) {
  const line = document.createElement('div');
  line.className = className;
  line.textContent = text;
  return line;
}

function createPill(text, className = '') {
  const pill = document.createElement('span');
  pill.className = `pill ${className}`.trim();
  pill.textContent = text;
  return pill;
}

function createStackCell(lines = []) {
  const wrap = document.createElement('div');
  wrap.className = 'table-stack';
  lines.filter(Boolean).forEach((entry, index) => {
    const value = typeof entry === 'string' ? entry : entry.text;
    if (!value) return;
    const className = typeof entry === 'string'
      ? (index === 0 ? 'table-main' : 'table-sub')
      : (entry.className || (index === 0 ? 'table-main' : 'table-sub'));
    wrap.appendChild(createTextLine(value, className));
  });
  return wrap;
}

function createMetricValue(primary, secondary = '') {
  const wrap = document.createElement('div');
  const number = document.createElement('span');
  number.className = 'metric-number';
  number.textContent = primary;
  wrap.appendChild(number);
  if (secondary) {
    wrap.appendChild(createTextLine(secondary, 'metric-caption'));
  }
  return wrap;
}

function setMetricValue(node, primary, secondary = '') {
  clearNode(node);
  node.appendChild(createMetricValue(primary, secondary));
}

function setProgressFill(node, ratio, tone = '') {
  if (!node) return;
  const safeRatio = Number.isFinite(ratio) ? Math.max(0, Math.min(ratio, 1)) : 0;
  node.style.width = `${Math.round(safeRatio * 100)}%`;
  node.className = `progress-fill${tone ? ` ${tone}` : ''}`;
}

function appendSummaryRows(container, rows, emptyText) {
  clearNode(container);
  const safeRows = Array.isArray(rows) ? rows.filter((row) => row && row.label && row.value) : [];
  if (safeRows.length === 0) {
    const row = document.createElement('div');
    row.className = 'summary-row';
    row.appendChild(createTextLine('Brak danych', 'summary-label'));
    row.appendChild(createTextLine(emptyText || '-', 'summary-value'));
    container.appendChild(row);
    return;
  }

  safeRows.forEach((entry) => {
    const row = document.createElement('div');
    row.className = 'summary-row';
    row.appendChild(createTextLine(entry.label, 'summary-label'));
    row.appendChild(createTextLine(entry.value, 'summary-value'));
    container.appendChild(row);
  });
}

function setStatus(title, options = {}) {
  if (!statusBox) return;
  const safeTitle = typeof title === 'string' && title.trim()
    ? title.trim()
    : 'Brak statusu.';
  const meta = typeof options?.meta === 'string' ? options.meta.trim() : '';
  const hints = Array.isArray(options?.hints) ? options.hints : [];

  statusBox.classList.toggle('error', options?.isError === true);
  if (statusTitleBox) statusTitleBox.textContent = safeTitle;
  if (statusMetaBox) statusMetaBox.textContent = meta;

  clearNode(statusHintsBox);
  hints
    .map((hint) => (typeof hint === 'string' ? hint.trim() : ''))
    .filter(Boolean)
    .forEach((hint) => {
      const chip = document.createElement('span');
      chip.className = 'hint-chip';
      chip.textContent = hint;
      statusHintsBox.appendChild(chip);
    });
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
    return 'top-progress snapshot';
  }
  if (normalized === 'latest_update_first') {
    return 'latest update';
  }
  return normalized || '-';
}

function describeSelectionStrategy(strategy) {
  const normalized = typeof strategy === 'string' ? strategy.trim().toLowerCase() : '';
  if (normalized === 'most_advanced_incomplete_first') {
    return 'ranking po snapshot progressu, potem live verify';
  }
  if (normalized === 'latest_update_first') {
    return 'kolejnosc po czasie zapisu, potem live verify';
  }
  return 'brak jawnej strategii';
}

function formatPercent(part, total) {
  if (!Number.isInteger(total) || total <= 0 || !Number.isInteger(part) || part <= 0) {
    return '0%';
  }
  return `${Math.round((part / total) * 100)}%`;
}

function isFailedProcessStatus(status) {
  return FAILED_PROCESS_STATUSES.has(normalizeProcessStatusToken(status));
}

function isClosedProcessStatus(status) {
  return CLOSED_PROCESS_STATUSES.has(normalizeProcessStatusToken(status));
}

function hasRecoverableExecutionEvidence(process) {
  if (!process || typeof process !== 'object') return false;
  const currentPrompt = Number.isInteger(process?.currentPrompt) ? process.currentPrompt : 0;
  const stageIndex = Number.isInteger(process?.stageIndex) ? process.stageIndex : -1;
  if (currentPrompt > 0 || stageIndex >= 0) return true;

  const messages = Array.isArray(process?.messages) ? process.messages : [];
  return messages.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const text = typeof entry.text === 'string' ? entry.text.trim() : '';
    return text.length > 0;
  });
}

function extractProcessChatUrl(process) {
  if (!process || typeof process !== 'object') return '';
  const direct = typeof process?.chatUrl === 'string' ? process.chatUrl.trim() : '';
  if (direct) return direct;
  const history = Array.isArray(process?.conversationUrls) ? process.conversationUrls : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const value = typeof history[index] === 'string' ? history[index].trim() : '';
    if (value) return value;
  }
  return '';
}

function deriveSourceMeta(process) {
  const sourceUrl = typeof process?.sourceUrl === 'string' ? process.sourceUrl.trim() : '';
  if (!sourceUrl) {
    return { sourceKey: 'unknown', sourceLabel: 'unknown', sourceUrl: '' };
  }
  if (sourceUrl.startsWith('manual://')) {
    return { sourceKey: 'manual', sourceLabel: 'manual', sourceUrl };
  }
  try {
    const parsed = new URL(sourceUrl);
    const hostname = (parsed.hostname || '').replace(/^www\./i, '').toLowerCase();
    if (!hostname) {
      return { sourceKey: 'unknown', sourceLabel: 'unknown', sourceUrl };
    }
    return {
      sourceKey: hostname,
      sourceLabel: hostname,
      sourceUrl
    };
  } catch (_) {
    return { sourceKey: 'unknown', sourceLabel: 'unknown', sourceUrl };
  }
}

function getLastMeaningfulProcessUpdateAt(process) {
  const persistenceUpdatedAt = Number.isInteger(process?.persistenceStatus?.updatedAt)
    ? process.persistenceStatus.updatedAt
    : 0;
  if (persistenceUpdatedAt > 0) return persistenceUpdatedAt;

  const autoRecoveryUpdatedAt = Number.isInteger(process?.autoRecovery?.updatedAt)
    ? process.autoRecovery.updatedAt
    : 0;
  if (autoRecoveryUpdatedAt > 0) return autoRecoveryUpdatedAt;

  const finishedAt = Number.isInteger(process?.finishedAt) ? process.finishedAt : 0;
  if (finishedAt > 0) return finishedAt;

  const startedAt = Number.isInteger(process?.startedAt) ? process.startedAt : 0;
  if (startedAt > 0) return startedAt;

  return Number.isInteger(process?.timestamp) ? process.timestamp : 0;
}

function compareRecoveryItemsByProgressDesc(left, right) {
  const leftProgress = Number.isFinite(left?.progressShare) ? left.progressShare : 0;
  const rightProgress = Number.isFinite(right?.progressShare) ? right.progressShare : 0;
  if (rightProgress !== leftProgress) {
    return rightProgress - leftProgress;
  }
  const leftPrompt = Number.isInteger(left?.currentPrompt) ? left.currentPrompt : 0;
  const rightPrompt = Number.isInteger(right?.currentPrompt) ? right.currentPrompt : 0;
  if (rightPrompt !== leftPrompt) {
    return rightPrompt - leftPrompt;
  }
  const leftTs = Number.isInteger(left?.timestamp) ? left.timestamp : 0;
  const rightTs = Number.isInteger(right?.timestamp) ? right.timestamp : 0;
  if (rightTs !== leftTs) {
    return rightTs - leftTs;
  }
  const leftId = typeof left?.runId === 'string' ? left.runId : '';
  const rightId = typeof right?.runId === 'string' ? right.runId : '';
  return leftId.localeCompare(rightId, 'en', { sensitivity: 'base' });
}

function isStaleRunningRecoveryCandidate(process, nowTs = Date.now()) {
  if (!process || typeof process !== 'object') return false;
  if (isClosedProcessStatus(process?.status)) return false;
  if (!hasRecoverableExecutionEvidence(process)) return false;
  const lastMeaningfulUpdateAt = getLastMeaningfulProcessUpdateAt(process);
  if (!Number.isInteger(lastMeaningfulUpdateAt) || lastMeaningfulUpdateAt <= 0) return false;
  return (nowTs - lastMeaningfulUpdateAt) >= STALE_RUNNING_RECOVERY_THRESHOLD_MS;
}

function buildStaleRunningRecoveryItem(process, nowTs = Date.now()) {
  const sourceMeta = deriveSourceMeta(process);
  const chatUrl = extractProcessChatUrl(process);
  const runId = typeof process?.id === 'string' ? process.id : '';
  const currentPrompt = Number.isInteger(process?.currentPrompt) ? process.currentPrompt : 0;
  const totalPrompts = Number.isInteger(process?.totalPrompts) ? process.totalPrompts : 0;
  const stageName = typeof process?.stageName === 'string' ? process.stageName.trim() : '';
  const lastMeaningfulUpdateAt = getLastMeaningfulProcessUpdateAt(process);
  const ageMs = lastMeaningfulUpdateAt > 0 ? Math.max(0, nowTs - lastMeaningfulUpdateAt) : 0;
  const progressShare = totalPrompts > 0 && currentPrompt > 0
    ? Math.max(0, Math.min(1, currentPrompt / totalPrompts))
    : 0;
  const reason = typeof process?.reason === 'string' && process.reason.trim()
    ? process.reason.trim()
    : 'stale_running_gt_threshold';
  const statusTextBase = typeof process?.statusText === 'string' && process.statusText.trim()
    ? process.statusText.trim()
    : 'Brak nowego postepu';

  return {
    runId,
    title: typeof process?.title === 'string' ? process.title : '',
    status: 'failed',
    isFailedStatus: true,
    needsAction: process?.needsAction === true,
    currentPrompt,
    totalPrompts,
    progressShare,
    stageName: stageName || (currentPrompt > 0 ? `Prompt ${currentPrompt}` : ''),
    timestamp: lastMeaningfulUpdateAt,
    chatUrl,
    hasChatUrl: !!chatUrl,
    sourceUrl: sourceMeta.sourceUrl,
    sourceKey: sourceMeta.sourceKey,
    sourceLabel: sourceMeta.sourceLabel,
    reason,
    statusText: `${statusTextBase} | stale>${STALE_RUNNING_RECOVERY_HOURS}h`,
    lastError: typeof process?.error === 'string' ? process.error : '',
    staleAgeHours: ageMs > 0 ? Math.round((ageMs / 3600000) * 100) / 100 : 0,
    originalStatus: normalizeProcessStatusToken(process?.status || ''),
    hasExecutionEvidence: true
  };
}

function buildServiceModeSourceCatalog(items) {
  const safeItems = Array.isArray(items) ? items : [];
  const byKey = new Map();
  safeItems.forEach((item) => {
    const key = normalizeSourceFilter(item?.sourceKey || 'unknown');
    const label = typeof item?.sourceLabel === 'string' && item.sourceLabel.trim()
      ? item.sourceLabel.trim()
      : (key || 'unknown');
    const existing = byKey.get(key) || {
      key,
      label,
      total: 0,
      runnable: 0
    };
    existing.total += 1;
    if (item?.hasChatUrl === true) existing.runnable += 1;
    byKey.set(key, existing);
  });
  return Array.from(byKey.values()).sort((left, right) => {
    if ((right.total || 0) !== (left.total || 0)) {
      return (right.total || 0) - (left.total || 0);
    }
    return String(left.label || '').localeCompare(String(right.label || ''), 'en', { sensitivity: 'base' });
  });
}

function buildStaleRunningRecoveryListResult(processes) {
  const nowTs = Date.now();
  const requestedFilter = normalizeSourceFilter(selectedSourceFilter);
  const staleItems = (Array.isArray(processes) ? processes : [])
    .filter((process) => isStaleRunningRecoveryCandidate(process, nowTs))
    .map((process) => buildStaleRunningRecoveryItem(process, nowTs))
    .filter((item) => !serviceRecoveredRunIds.has(item.runId))
    .sort((left, right) => (right.timestamp || 0) - (left.timestamp || 0));
  const availableSources = buildServiceModeSourceCatalog(staleItems);
  const filteredItems = requestedFilter === 'all'
    ? staleItems
    : staleItems.filter((item) => item.sourceKey === requestedFilter);
  const runnable = filteredItems.filter((item) => item?.hasChatUrl === true).length;
  const blockedMissingUrl = Math.max(0, filteredItems.length - runnable);
  const sourceFilterMatched = requestedFilter === 'all'
    ? true
    : availableSources.some((entry) => entry?.key === requestedFilter);

  return {
    success: true,
    generatedAt: nowTs,
    total: filteredItems.length,
    runnable,
    skippedMissingUrl: blockedMissingUrl,
    sourceFilter: requestedFilter,
    sourceFilterApplied: requestedFilter !== 'all',
    sourceFilterMatched,
    recoverOnly: false,
    countingModel: {
      listSource: `running stale >${STALE_RUNNING_RECOVERY_HOURS}h`,
      listStageMeaning: 'last meaningful update from process snapshot',
      resumeStageMeaning: 'PROCESS_RESUME_NEXT_STAGE with live detect',
      batchLimitMeaning: 'top progress among stale running items'
    },
    summary: {
      total: filteredItems.length,
      runnable,
      blockedMissingChatUrl: blockedMissingUrl,
      failedStatuses: filteredItems.length,
      needsAction: filteredItems.filter((item) => item?.needsAction === true).length,
      withStageSnapshot: filteredItems.filter((item) => (
        Number.isInteger(item?.currentPrompt) && item.currentPrompt > 0
      )).length,
      latestUpdatedAt: filteredItems.reduce((maxTs, item) => Math.max(maxTs, item?.timestamp || 0), 0),
      runnableSharePct: filteredItems.length > 0
        ? Math.round((runnable / filteredItems.length) * 100)
        : 0,
      statusCounts: {
        failed: filteredItems.length
      }
    },
    availableSources,
    items: filteredItems
  };
}

function buildServiceBatchState(selection, candidates) {
  const safeCandidates = Array.isArray(candidates) ? candidates : [];
  const runnable = safeCandidates.filter((item) => item?.hasChatUrl === true).length;
  const blocked = Math.max(0, safeCandidates.length - runnable);
  return {
    jobId: `stale-running-recovery-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'running',
    startedAt: Date.now(),
    updatedAt: Date.now(),
    finishedAt: null,
    selection,
    totals: {
      total: safeCandidates.length,
      runnable,
      skippedMissingUrl: blocked,
      processed: 0,
      resumed: 0,
      skipped_missing_chat_url: 0,
      skipped_not_found: 0,
      skipped_already_completed: 0,
      failed: 0
    },
    rows: [],
    activeRunId: '',
    error: ''
  };
}

function applyServiceBatchRowToTotals(totals, row) {
  const nextTotals = {
    total: Number.isInteger(totals?.total) ? totals.total : 0,
    runnable: Number.isInteger(totals?.runnable) ? totals.runnable : 0,
    skippedMissingUrl: Number.isInteger(totals?.skippedMissingUrl) ? totals.skippedMissingUrl : 0,
    processed: Number.isInteger(totals?.processed) ? totals.processed : 0,
    resumed: Number.isInteger(totals?.resumed) ? totals.resumed : 0,
    skipped_missing_chat_url: Number.isInteger(totals?.skipped_missing_chat_url) ? totals.skipped_missing_chat_url : 0,
    skipped_not_found: Number.isInteger(totals?.skipped_not_found) ? totals.skipped_not_found : 0,
    skipped_already_completed: Number.isInteger(totals?.skipped_already_completed) ? totals.skipped_already_completed : 0,
    failed: Number.isInteger(totals?.failed) ? totals.failed : 0
  };
  nextTotals.processed += 1;

  const outcome = typeof row?.outcome === 'string' ? row.outcome : '';
  if (outcome === 'resumed') nextTotals.resumed += 1;
  if (outcome === 'skipped_missing_chat_url') nextTotals.skipped_missing_chat_url += 1;
  if (outcome === 'skipped_not_found') nextTotals.skipped_not_found += 1;
  if (outcome === 'skipped_already_completed') nextTotals.skipped_already_completed += 1;
  if (outcome === 'failed') nextTotals.failed += 1;
  return nextTotals;
}

function reportServiceModeEvent({
  reason = '',
  status = '',
  message = '',
  runId = '',
  title = '',
  statusText = '',
  error = ''
} = {}) {
  if (!STALE_RUNNING_RECOVERY_MODE) return;
  const normalizedReason = typeof reason === 'string' ? reason.trim() : '';
  const normalizedStatus = typeof status === 'string' ? status.trim() : '';
  const normalizedMessage = typeof message === 'string' ? message.trim() : '';
  void sendRuntimeMessage({
    type: 'REPORT_PROBLEM_LOG',
    entry: {
      source: 'unfinished-processes-service-mode',
      level: normalizedStatus === 'failed' ? 'error' : 'info',
      category: 'admin',
      analysisType: 'admin',
      runId: typeof runId === 'string' ? runId.trim() : '',
      title: typeof title === 'string' ? title.trim() : '',
      status: normalizedStatus || 'ok',
      reason: normalizedReason || 'service_mode_event',
      statusText: typeof statusText === 'string' ? statusText.trim() : '',
      error: typeof error === 'string' ? error.trim() : '',
      message: normalizedMessage || normalizedReason || 'service_mode_event',
      signature: [
        'unfinished-processes-service-mode',
        normalizedReason || 'service_mode_event',
        normalizedStatus || 'ok',
        typeof runId === 'string' ? runId.trim() : '',
        Date.now(),
        Math.random().toString(36).slice(2, 8)
      ].join('|')
    }
  }).catch(() => {});
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
      className: 'pill-status-failed'
    };
  }
  if (status === 'running') {
    return {
      text: 'running',
      className: 'pill-status-running'
    };
  }
  if (status === 'completed') {
    return {
      text: 'completed',
      className: 'pill-status-completed'
    };
  }
  if (status === 'needs_action' || item?.needsAction === true) {
    return {
      text: 'needs action',
      className: 'pill-status-needs-action'
    };
  }
  return {
    text: formatStatusText(status || 'unknown'),
    className: 'pill-live'
  };
}

function resolveReadinessModel(item) {
  const hasSnapshot = Number.isInteger(item?.currentPrompt) && item.currentPrompt > 0;
  if (item?.hasChatUrl === true) {
    return {
      text: hasSnapshot ? 'ready-live' : 'ready-live-no-snapshot',
      className: 'pill-ready',
      detail: hasSnapshot
        ? 'ma chatUrl; worker otworzy nowa karte i przeliczy etap live'
        : 'ma chatUrl; etap bedzie liczony live bez snapshotu promptu'
    };
  }
  return {
    text: 'blocked',
    className: 'pill-blocked',
    detail: 'brak chatUrl / conversation URL; batch nie ruszy tego rekordu'
  };
}

function resolveStageSnapshotModel(item) {
  const currentPrompt = Number.isInteger(item?.currentPrompt) ? item.currentPrompt : 0;
  const totalPrompts = Number.isInteger(item?.totalPrompts) ? item.totalPrompts : 0;
  const progressShare = Number.isFinite(item?.progressShare) ? item.progressShare : 0;
  const stageName = typeof item?.stageName === 'string' ? item.stageName.trim() : '';
  if (currentPrompt > 0 && totalPrompts > 0) {
    return {
      headline: `snapshot P${currentPrompt}/${totalPrompts}`,
      subline: stageName || `${Math.round(progressShare * 100)}% chaina`,
      ratio: progressShare
    };
  }
  if (currentPrompt > 0) {
    return {
      headline: `snapshot P${currentPrompt}`,
      subline: stageName || 'zapisany prompt bez pelnej dlugosci chaina',
      ratio: 0
    };
  }
  return {
    headline: 'brak snapshotu etapu',
    subline: 'punkt startu bedzie liczony dopiero live po otwarciu karty',
    ratio: 0
  };
}

function resolveProcessPlanModel(item) {
  if (item?.hasChatUrl === true) {
    if (Number.isInteger(item?.currentPrompt) && item.currentPrompt > 0) {
      return {
        headline: 'nowa karta -> live detect -> bezpieczny prompt',
        subline: 'snapshot sluzy jako wskazowka i ranking, nie jako finalna decyzja'
      };
    }
    return {
      headline: 'nowa karta -> live detect od zera',
      subline: 'brak snapshotu promptu, decyzja startu opiera sie na rozmowie'
    };
  }
  return {
    headline: 'stop przed startem',
    subline: 'brak chatUrl; bez rekonstrukcji rozmowy batch nie wznowi procesu'
  };
}

function resolveProcessSignalModel(item) {
  const statusText = typeof item?.statusText === 'string' ? item.statusText.trim() : '';
  const reason = typeof item?.reason === 'string' ? item.reason.trim() : '';
  const lastError = typeof item?.lastError === 'string' ? item.lastError.trim() : '';

  const primary = statusText || (reason ? `reason: ${formatStatusText(reason)}` : 'brak dodatkowego statusText');
  const secondary = statusText && reason ? `reason: ${formatStatusText(reason)}` : '';
  const tertiary = lastError ? `error: ${shortenText(lastError, 120)}` : '';

  return { primary, secondary, tertiary };
}

function resolveBatchOutcomeModel(outcome) {
  const normalized = typeof outcome === 'string' ? outcome.trim() : '';
  if (normalized === 'resumed') {
    return {
      text: 'resumed',
      className: 'pill-outcome-resumed'
    };
  }
  if (normalized === 'failed') {
    return {
      text: 'failed',
      className: 'pill-outcome-failed'
    };
  }
  return {
    text: normalized || 'skipped',
    className: 'pill-outcome-skipped'
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

function buildFallbackSummary(listResult) {
  const items = Array.isArray(listResult?.items) ? listResult.items : [];
  const total = items.length;
  const runnable = items.filter((item) => item?.hasChatUrl === true).length;
  const blockedMissingChatUrl = Math.max(0, total - runnable);
  const failedStatuses = items.filter((item) => item?.isFailedStatus === true).length;
  const needsAction = items.filter((item) => item?.needsAction === true).length;
  const withStageSnapshot = items.filter((item) => (
    Number.isInteger(item?.currentPrompt) && item.currentPrompt > 0
  )).length;
  const latestUpdatedAt = items.reduce((maxTs, item) => {
    const ts = Number.isInteger(item?.timestamp) ? item.timestamp : 0;
    return Math.max(maxTs, ts);
  }, 0);
  const statusCounts = {};
  items.forEach((item) => {
    const key = normalizeProcessStatusToken(item?.status || '') || 'unknown';
    statusCounts[key] = (statusCounts[key] || 0) + 1;
  });

  return {
    total,
    runnable,
    blockedMissingChatUrl,
    failedStatuses,
    needsAction,
    withStageSnapshot,
    latestUpdatedAt,
    runnableSharePct: total > 0 ? Math.round((runnable / total) * 100) : 0,
    statusCounts
  };
}

function getListSummary(listResult) {
  if (listResult?.summary && typeof listResult.summary === 'object') {
    return {
      ...buildFallbackSummary(listResult),
      ...listResult.summary
    };
  }
  return buildFallbackSummary(listResult);
}

function renderMetrics(listResult, batchState) {
  const list = listResult && typeof listResult === 'object' ? listResult : {};
  const state = batchState && typeof batchState === 'object' ? batchState : {};
  const totals = state?.totals && typeof state.totals === 'object' ? state.totals : {};
  const selection = state?.selection && typeof state.selection === 'object' ? state.selection : {};
  const status = normalizeBatchStatus(state?.status);
  const summary = getListSummary(list);
  const total = Number.isInteger(summary.total) ? summary.total : 0;
  const runnable = Number.isInteger(summary.runnable) ? summary.runnable : 0;
  const blocked = Number.isInteger(summary.blockedMissingChatUrl) ? summary.blockedMissingChatUrl : 0;
  const snapshotCount = Number.isInteger(summary.withStageSnapshot) ? summary.withStageSnapshot : 0;
  const runnableSharePct = Number.isInteger(summary.runnableSharePct) ? summary.runnableSharePct : 0;
  const resumed = Number.isInteger(totals?.resumed) ? totals.resumed : 0;
  const failed = Number.isInteger(totals?.failed) ? totals.failed : 0;
  const skippedMissing = Number.isInteger(totals?.skipped_missing_chat_url) ? totals.skipped_missing_chat_url : 0;
  const skippedNotFound = Number.isInteger(totals?.skipped_not_found) ? totals.skipped_not_found : 0;
  const processed = Number.isInteger(totals?.processed) ? totals.processed : 0;
  const batchTotal = Number.isInteger(totals?.total) ? totals.total : total;

  setMetricValue(metricTotal, String(total), `${snapshotCount}/${total || 0} ma zapisany snapshot etapu`);
  setMetricValue(metricRunnable, String(runnable));
  if (metricRunnableCaption) {
    metricRunnableCaption.textContent = total > 0
      ? `${runnableSharePct}% kandydatow ma chatUrl i jest gotowe do live wznowienia`
      : 'Brak kandydatow do uruchomienia.';
  }
  setProgressFill(metricRunnableBar, total > 0 ? (runnable / total) : 0, 'run');

  setMetricValue(metricMissing, String(blocked));
  if (metricMissingCaption) {
    const failedStatuses = Number.isInteger(summary.failedStatuses) ? summary.failedStatuses : 0;
    const needsAction = Number.isInteger(summary.needsAction) ? summary.needsAction : 0;
    metricMissingCaption.textContent = `failed=${failedStatuses} | needs_action=${needsAction}`;
  }

  clearNode(metricBatchStatus);
  metricBatchStatus.appendChild(createPill(status, status === 'completed'
    ? 'pill-outcome-resumed'
    : status === 'completed_with_errors'
      ? 'pill-outcome-skipped'
      : status === 'running'
        ? 'pill-status-running'
        : 'pill-live'));
  metricBatchStatus.appendChild(createStackCell([
    {
      text: `job: ${state?.jobId || '-'}`,
      className: 'table-sub mono'
    },
    {
      text: `src: ${(selection?.sourceLabel || selection?.sourceFilter || 'all')} | mode: ${formatSelectionStrategy(selection?.strategy)}`,
      className: 'table-sub'
    },
    {
      text: `limit: ${Number.isInteger(selection?.limitApplied) ? selection.limitApplied : 'all'} | filtered: ${Number.isInteger(selection?.filteredTotal) ? selection.filteredTotal : total}`,
      className: 'table-sub'
    }
  ]));

  setMetricValue(metricProgress, `${processed}/${batchTotal || 0}`);
  metricProgress.appendChild(createTextLine(`resumed=${resumed} | failed=${failed}`, 'metric-caption'));
  metricProgress.appendChild(createTextLine(
    `skip_url=${skippedMissing} | skip_not_found=${skippedNotFound}`,
    'metric-caption'
  ));
  setProgressFill(metricProgressBar, batchTotal > 0 ? (processed / batchTotal) : 0, 'run');
}

function renderCountingSummary(listResult) {
  const summary = getListSummary(listResult);
  const countingModel = listResult?.countingModel && typeof listResult.countingModel === 'object'
    ? listResult.countingModel
    : {};
  appendSummaryRows(countingSummary, [
    {
      label: 'Lista',
      value: `snapshot z ${countingModel.listSource || 'process_monitor_state'}; kandydaci=${summary.total || 0}`
    },
    {
      label: 'Snapshot etapu',
      value: `${summary.withStageSnapshot || 0}/${summary.total || 0} rekordow ma zapisany prompt lub stage snapshot`
    },
    {
      label: 'Startowalnosc',
      value: `${summary.runnable || 0} gotowych teraz | ${summary.blockedMissingChatUrl || 0} zablokowanych przez brak chatUrl`
    },
    {
      label: 'Najswiezszy zapis',
      value: formatDateTime(Number.isInteger(summary.latestUpdatedAt) ? summary.latestUpdatedAt : 0)
    }
  ], 'Brak podsumowania liczenia.');
}

function renderSelectionSummary(listResult, batchState) {
  const list = listResult && typeof listResult === 'object' ? listResult : {};
  const state = batchState && typeof batchState === 'object' ? batchState : {};
  const selection = state?.selection && typeof state.selection === 'object' ? state.selection : {};
  const sourceLabel = typeof selection?.sourceLabel === 'string' && selection.sourceLabel.trim()
    ? selection.sourceLabel.trim()
    : (selection?.sourceFilter || 'all');
  appendSummaryRows(selectionSummary, [
    {
      label: 'Live przy starcie',
      value: 'Kazdy uruchamiany rekord przechodzi live detect etapu na karcie ChatGPT przed wznowieniem.'
    },
    {
      label: 'Uruchom 10',
      value: 'Najpierw ranking po snapshot progressu, potem live verification i korekta punktu startu.'
    },
    {
      label: 'Biezacy batch',
      value: `status=${normalizeBatchStatus(state?.status)} | source=${sourceLabel || 'all'} | mode=${describeSelectionStrategy(selection?.strategy)}`
    },
    {
      label: 'Zakres',
      value: `limit=${Number.isInteger(selection?.limitApplied) ? selection.limitApplied : 'all'} | filtered=${Number.isInteger(selection?.filteredTotal) ? selection.filteredTotal : (Number.isInteger(list?.total) ? list.total : 0)}`
    }
  ], 'Brak aktywnego batcha.');
}

function renderProcessRows(listResult) {
  clearNode(processBody);
  const items = Array.isArray(listResult?.items) ? listResult.items : [];
  if (items.length === 0) {
    processBody.appendChild(createPlaceholderRow(9, 'Brak procesow do recovery. Lista obejmuje tylko rekordy zamkniete, niedokonczone i z dowodem wykonania.'));
    return;
  }

  items.forEach((item, index) => {
    const row = document.createElement('tr');
    const statusModel = resolveProcessStatusModel(item);
    const readinessModel = resolveReadinessModel(item);
    const stageModel = resolveStageSnapshotModel(item);
    const planModel = resolveProcessPlanModel(item);
    const signalModel = resolveProcessSignalModel(item);
    const sourceLabel = typeof item?.sourceLabel === 'string' && item.sourceLabel.trim()
      ? item.sourceLabel.trim()
      : (typeof item?.sourceKey === 'string' && item.sourceKey.trim() ? item.sourceKey.trim() : 'unknown');
    row.className = item?.hasChatUrl === true ? 'process-row-runnable' : 'process-row-blocked';

    const orderCell = document.createElement('td');
    orderCell.textContent = String(index + 1);
    row.appendChild(orderCell);

    const processCell = document.createElement('td');
    processCell.appendChild(createStackCell([
      { text: item?.title || 'Bez tytulu', className: 'table-main' },
      { text: item?.runId || '-', className: 'table-sub mono' }
    ]));
    row.appendChild(processCell);

    const statusCell = document.createElement('td');
    statusCell.appendChild(createPill(statusModel.text, statusModel.className));
    if (item?.needsAction === true) {
      statusCell.appendChild(createTextLine('needsAction=true w snapshotcie', 'table-sub'));
    }
    row.appendChild(statusCell);

    const stageCell = document.createElement('td');
    const stageWrap = document.createElement('div');
    stageWrap.className = 'stage-block';
    stageWrap.appendChild(createTextLine(stageModel.headline, 'table-main'));
    stageWrap.appendChild(createTextLine(stageModel.subline, 'table-sub'));
    const stageProgress = document.createElement('div');
    stageProgress.className = 'stage-progress';
    const stageProgressLabel = document.createElement('div');
    stageProgressLabel.className = 'stage-progress-label';
    stageProgressLabel.textContent = stageModel.ratio > 0
      ? `${Math.round(stageModel.ratio * 100)}% chaina zapisane w snapshotcie`
      : 'bez twardego progresu do rankingu';
    stageProgress.appendChild(stageProgressLabel);
    const stageTrack = document.createElement('div');
    stageTrack.className = 'progress-strip';
    const stageFill = document.createElement('div');
    setProgressFill(stageFill, stageModel.ratio, stageModel.ratio > 0 ? 'run' : '');
    stageTrack.appendChild(stageFill);
    stageProgress.appendChild(stageTrack);
    stageWrap.appendChild(stageProgress);
    stageCell.appendChild(stageWrap);
    row.appendChild(stageCell);

    const readinessCell = document.createElement('td');
    readinessCell.appendChild(createPill(readinessModel.text, readinessModel.className));
    readinessCell.appendChild(createTextLine(readinessModel.detail, 'table-sub'));
    row.appendChild(readinessCell);

    const planCell = document.createElement('td');
    planCell.appendChild(createStackCell([
      { text: planModel.headline, className: 'table-main' },
      { text: planModel.subline, className: 'table-sub' }
    ]));
    row.appendChild(planCell);

    const signalCell = document.createElement('td');
    signalCell.appendChild(createStackCell([
      { text: signalModel.primary, className: 'table-main' },
      signalModel.secondary ? { text: signalModel.secondary, className: 'table-sub' } : null,
      signalModel.tertiary ? { text: signalModel.tertiary, className: 'table-sub' } : null
    ]));
    row.appendChild(signalCell);

    const sourceCell = document.createElement('td');
    const sourceWrap = document.createElement('div');
    sourceWrap.className = 'table-stack';
    const sourceChip = document.createElement('span');
    sourceChip.className = 'source-chip';
    sourceChip.textContent = sourceLabel;
    sourceChip.title = sourceLabel;
    sourceWrap.appendChild(sourceChip);
    sourceWrap.appendChild(createTextLine(
      `updated: ${formatDateTime(Number.isInteger(item?.timestamp) ? item.timestamp : 0)}`,
      'table-sub'
    ));
    sourceCell.appendChild(sourceWrap);
    row.appendChild(sourceCell);

    const chatCell = document.createElement('td');
    const chatWrap = document.createElement('div');
    chatWrap.className = 'chat-block';
    if (item?.hasChatUrl === true) {
      chatWrap.appendChild(createPill('chat ready', 'pill-ready'));
      chatWrap.appendChild(createTextLine(shortenText(item.chatUrl, 88), 'table-sub mono'));
      const openBtn = document.createElement('button');
      openBtn.className = 'link-btn';
      openBtn.textContent = 'Otworz chat';
      openBtn.addEventListener('click', () => openChat(item.chatUrl));
      chatWrap.appendChild(openBtn);
    } else {
      chatWrap.appendChild(createPill('no chatUrl', 'pill-blocked'));
      chatWrap.appendChild(createTextLine('brak conversation URL do otwarcia nowej karty', 'table-sub'));
    }
    chatCell.appendChild(chatWrap);
    row.appendChild(chatCell);

    processBody.appendChild(row);
  });
}

function renderBatchRows(state) {
  clearNode(batchBody);
  const rows = Array.isArray(state?.rows) ? state.rows.slice().reverse() : [];
  if (rows.length === 0) {
    batchBody.appendChild(createPlaceholderRow(7, 'Czekam na uruchomienie batch.'));
    return;
  }

  rows.forEach((item, index) => {
    const row = document.createElement('tr');
    const outcomeModel = resolveBatchOutcomeModel(item?.outcome);
    const detected = Number.isInteger(item?.detectedPromptNumber) ? item.detectedPromptNumber : null;
    const started = Number.isInteger(item?.startPromptNumber) ? item.startPromptNumber : null;
    const detectedStartText = `${detected !== null ? `P${detected}` : '-'} -> ${started !== null ? `P${started}` : '-'}`;
    const reason = typeof item?.reason === 'string' && item.reason.trim() ? item.reason.trim() : '-';
    const error = typeof item?.error === 'string' && item.error.trim() ? item.error.trim() : '';

    const orderCell = document.createElement('td');
    orderCell.textContent = String(index + 1);
    row.appendChild(orderCell);

    const processCell = document.createElement('td');
    processCell.appendChild(createStackCell([
      { text: item?.title || 'Bez tytulu', className: 'table-main' },
      { text: item?.runId || '-', className: 'table-sub mono' }
    ]));
    row.appendChild(processCell);

    const outcomeCell = document.createElement('td');
    outcomeCell.appendChild(createPill(outcomeModel.text, outcomeModel.className));
    if (item?.retrySamePrompt === true) {
      outcomeCell.appendChild(createTextLine(
        `retry same prompt${item?.retryReason ? `: ${item.retryReason}` : ''}`,
        'table-sub'
      ));
    }
    row.appendChild(outcomeCell);

    const detectCell = document.createElement('td');
    detectCell.appendChild(createStackCell([
      { text: detectedStartText, className: 'table-main mono' },
      {
        text: Number.isInteger(item?.detectedPromptNumber) || Number.isInteger(item?.startPromptNumber)
          ? 'wykryty prompt live -> wyslany prompt startowy'
          : 'brak live detekcji lub brak startu'
      }
    ]));
    row.appendChild(detectCell);

    const methodCell = document.createElement('td');
    methodCell.appendChild(createStackCell([
      { text: item?.detectedMethod || '-', className: 'table-main' },
      {
        text: item?.detectedMethod
          ? 'zrodlo decyzji wznowienia'
          : 'brak zarejestrowanej metody'
      }
    ]));
    row.appendChild(methodCell);

    const reasonCell = document.createElement('td');
    reasonCell.appendChild(createStackCell([
      { text: reason, className: 'table-main' },
      error ? { text: `error: ${shortenText(error, 120)}`, className: 'table-sub' } : null
    ]));
    row.appendChild(reasonCell);

    const chatCell = document.createElement('td');
    if (typeof item?.chatUrl === 'string' && item.chatUrl.trim()) {
      const chatWrap = document.createElement('div');
      chatWrap.className = 'chat-block';
      chatWrap.appendChild(createPill('chat', 'pill-ready'));
      chatWrap.appendChild(createTextLine(shortenText(item.chatUrl, 88), 'table-sub mono'));
      const openBtn = document.createElement('button');
      openBtn.className = 'link-btn';
      openBtn.textContent = 'Otworz';
      openBtn.addEventListener('click', () => openChat(item.chatUrl));
      chatWrap.appendChild(openBtn);
      chatCell.appendChild(chatWrap);
    } else {
      chatCell.appendChild(createStackCell([
        { text: 'no chat', className: 'table-main' },
        { text: 'rekord bez otwieralnego URL', className: 'table-sub' }
      ]));
    }
    row.appendChild(chatCell);

    batchBody.appendChild(row);
  });
}

function buildStatusHints(listResult, extraHints = []) {
  const summary = getListSummary(listResult);
  const hints = [
    `${summary.total || 0} kandydatow`,
    `${summary.runnable || 0} startowalnych`,
    `${summary.withStageSnapshot || 0} ze snapshotem etapu`,
    'live detect on start'
  ];
  if (selectedSourceFilter !== 'all') {
    hints.unshift(`source=${selectedSourceFilter}`);
  }
  return hints.concat(Array.isArray(extraHints) ? extraHints : []);
}

function updateRunButtonState(state) {
  const status = normalizeBatchStatus(state?.status);
  const running = status === 'running';
  const total = Number.isInteger(lastListResult?.total) ? lastListResult.total : 0;
  const runnable = Number.isInteger(lastListResult?.runnable) ? lastListResult.runnable : 0;
  const noRunnable = total === 0 || runnable === 0;
  const runLabel = STALE_RUNNING_RECOVERY_MODE ? 'Wznow stale' : 'Uruchom wszystkie';
  const run10Label = STALE_RUNNING_RECOVERY_MODE ? 'Wznow 10 stale' : 'Uruchom 10';
  if (runBtn) {
    runBtn.disabled = running || noRunnable;
    runBtn.textContent = running ? 'Batch w toku...' : runLabel;
  }
  if (run10Btn) {
    run10Btn.disabled = running || noRunnable;
    run10Btn.textContent = running ? 'Top 10 w toku...' : run10Label;
  }
  if (sourceFilterSelect) {
    sourceFilterSelect.disabled = running;
  }
}

function applyData(listResult, batchState) {
  lastListResult = listResult && typeof listResult === 'object' ? listResult : null;
  lastBatchState = batchState && typeof batchState === 'object' ? batchState : null;
  postKeepaliveTick();
  rebuildSourceFilterOptions(lastListResult);
  renderMetrics(lastListResult, lastBatchState);
  renderCountingSummary(lastListResult);
  renderSelectionSummary(lastListResult, lastBatchState);
  renderProcessRows(lastListResult);
  renderBatchRows(lastBatchState);
  updateRunButtonState(lastBatchState);
}

async function refreshStaleRunningRecoveryData(options = {}) {
  if (refreshInProgress) {
    pendingRefresh = true;
    return;
  }
  refreshInProgress = true;
  const silent = options?.silent === true;
  if (!silent) {
    setStatus('Odswiezam stale running recovery...', {
      meta: `threshold=${STALE_RUNNING_RECOVERY_HOURS}h | source=${selectedSourceFilter}`,
      hints: ['GET_PROCESSES', 'last meaningful update', 'PROCESS_RESUME_NEXT_STAGE']
    });
  }

  try {
    const response = await sendRuntimeMessage({
      type: 'GET_PROCESSES'
    });
    const listResult = buildStaleRunningRecoveryListResult(response?.processes);
    applyData(listResult, serviceBatchState);
    const summary = getListSummary(listResult);
    setStatus('Lista stale running policzona', {
      meta: `threshold=${STALE_RUNNING_RECOVERY_HOURS}h | filtered=${summary.total || 0} | source=${selectedSourceFilter}`,
      hints: [
        `${summary.runnable || 0} gotowych do live resume`,
        `${summary.blockedMissingChatUrl || 0} bez chatUrl`,
        'stale by persistenceStatus.updatedAt'
      ]
    });

    if (STALE_RUNNING_RECOVERY_AUTORUN && !serviceAutoRunStarted) {
      serviceAutoRunStarted = true;
      window.setTimeout(() => {
        void startStaleRunningRecoveryBatch(STALE_RUNNING_RECOVERY_LIMIT);
      }, 250);
    }
  } catch (error) {
    setStatus('Blad odswiezania stale running recovery', {
      meta: error?.message || String(error),
      hints: ['sprawdz worker service', 'sprawdz process monitor'],
      isError: true
    });
  } finally {
    refreshInProgress = false;
    if (pendingRefresh) {
      pendingRefresh = false;
      void refreshData({ silent: true });
    }
  }
}

async function refreshData(options = {}) {
  if (STALE_RUNNING_RECOVERY_MODE) {
    await refreshStaleRunningRecoveryData(options);
    return;
  }
  if (refreshInProgress) {
    pendingRefresh = true;
    return;
  }
  refreshInProgress = true;
  const silent = options?.silent === true;
  if (!silent) {
    setStatus('Odswiezam recovery list...', {
      meta: 'Czytam process_monitor_state i unfinished_resume_batch_state.',
      hints: ['snapshot scan', 'live verify on start']
    });
  }

  try {
    const [listResult, batchStateResult] = await Promise.all([
      sendRuntimeMessage({
        type: 'GET_UNFINISHED_PROCESSES',
        includeNonCompleted: true,
        recoverOnly: true,
        sourceFilter: selectedSourceFilter,
        origin: 'unfinished-processes-page'
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
    const summary = getListSummary(listResult);
    const state = batchStateResult?.state || {};
    const updatedAt = Number.isInteger(state?.updatedAt) ? formatDateTime(state.updatedAt) : '-';
    const filterMatched = listResult?.sourceFilterMatched !== false;
    const filterNote = selectedSourceFilter !== 'all'
      ? `source=${selectedSourceFilter}${filterMatched ? '' : ' (0 match)'}`
      : 'source=all';
    setStatus('Lista recovery policzona', {
      meta: `snapshot=${formatDateTime(listResult.generatedAt)} | batch=${updatedAt} | ${filterNote}`,
      hints: buildStatusHints(listResult, [`${summary.blockedMissingChatUrl || 0} blocked by chatUrl`])
    });
  } catch (error) {
    setStatus('Blad odswiezania recovery listy', {
      meta: error?.message || String(error),
      hints: ['sprawdz worker service', 'sprawdz problem log'],
      isError: true
    });
  } finally {
    refreshInProgress = false;
    if (pendingRefresh) {
      pendingRefresh = false;
      void refreshData({ silent: true });
    }
  }
}

async function startStaleRunningRecoveryBatch(limit = null) {
  const currentItems = Array.isArray(lastListResult?.items) ? lastListResult.items.slice() : [];
  const rankedItems = Number.isInteger(limit) && limit > 0
    ? currentItems.slice().sort(compareRecoveryItemsByProgressDesc)
    : currentItems.slice();
  const limitApplied = Number.isInteger(limit) && limit > 0
    ? Math.min(limit, rankedItems.length)
    : null;
  const candidates = Number.isInteger(limitApplied)
    ? rankedItems.slice(0, limitApplied)
    : rankedItems;

  if (candidates.length === 0) {
    setStatus('Brak stale running kandydatow', {
      meta: `threshold=${STALE_RUNNING_RECOVERY_HOURS}h | source=${selectedSourceFilter}`,
      hints: ['GET_PROCESSES returned 0 stale rows']
    });
    updateRunButtonState(serviceBatchState);
    return;
  }

  const selection = {
    sourceFilter: selectedSourceFilter,
    sourceLabel: selectedSourceFilter,
    strategy: Number.isInteger(limitApplied)
      ? 'most_advanced_incomplete_first'
      : 'latest_update_first',
    limitRequested: Number.isInteger(limit) && limit > 0 ? limit : null,
    limitApplied,
    filteredTotal: Number.isInteger(lastListResult?.total) ? lastListResult.total : candidates.length
  };
  serviceBatchState = buildServiceBatchState(selection, candidates);
  applyData(lastListResult, serviceBatchState);
  setStatus('Uruchamiam stale running recovery...', {
    meta: `threshold=${STALE_RUNNING_RECOVERY_HOURS}h | source=${selectedSourceFilter} | limit=${limitApplied || 'all'}`,
    hints: ['fresh tab for each stale run', 'live detect on chat', 'no LevelDB edits']
  });
  reportServiceModeEvent({
    reason: 'stale_running_recovery_batch_started',
    status: 'started',
    message: 'stale_running_recovery_batch_started',
    statusText: `selected=${candidates.length} threshold_h=${STALE_RUNNING_RECOVERY_HOURS} source=${selectedSourceFilter} limit=${limitApplied || 'all'}`
  });

  for (const [candidateIndex, candidate] of candidates.entries()) {
    serviceBatchState = {
      ...serviceBatchState,
      activeRunId: candidate?.runId || '',
      updatedAt: Date.now()
    };
    applyData(lastListResult, serviceBatchState);

    let row = {
      runId: typeof candidate?.runId === 'string' ? candidate.runId : '',
      title: typeof candidate?.title === 'string' ? candidate.title : '',
      startedAt: Date.now(),
      finishedAt: Date.now(),
      outcome: 'failed',
      reason: 'resume_failed',
      error: '',
      detectedPromptNumber: null,
      startPromptNumber: null,
      detectedMethod: '',
      retrySamePrompt: false,
      retryReason: '',
      chatUrl: typeof candidate?.chatUrl === 'string' ? candidate.chatUrl : ''
    };

    if (!row.runId) {
      row = {
        ...row,
        outcome: 'skipped_not_found',
        reason: 'missing_run_id'
      };
    } else if (!candidate?.hasChatUrl) {
      row = {
        ...row,
        outcome: 'skipped_missing_chat_url',
        reason: 'missing_chat_url'
      };
    } else if (serviceRecoveredRunIds.has(row.runId)) {
      row = {
        ...row,
        outcome: 'skipped_already_completed',
        reason: 'already_processed_in_service_mode'
      };
    } else {
      try {
        const result = await sendRuntimeMessage({
          type: 'PROCESS_RESUME_NEXT_STAGE',
          runId: row.runId,
          preferFreshTab: true,
          origin: 'unfinished-processes-stale-running-recovery'
        });

        const detectedPromptNumber = Number.isInteger(result?.detectedPromptNumber)
          ? result.detectedPromptNumber
          : null;
        const startPromptNumber = Number.isInteger(result?.startPromptNumber)
          ? result.startPromptNumber
          : null;
        const detectedMethod = typeof result?.detectedMethod === 'string'
          ? result.detectedMethod
          : '';
        const retrySamePrompt = result?.retrySamePrompt === true;
        const retryReason = typeof result?.retryReason === 'string' ? result.retryReason : '';

        if (result?.success === true) {
          row = {
            ...row,
            finishedAt: Date.now(),
            outcome: 'resumed',
            reason: 'resume_dispatched',
            detectedPromptNumber,
            startPromptNumber,
            detectedMethod,
            retrySamePrompt,
            retryReason
          };
          serviceRecoveredRunIds.add(row.runId);
        } else if ((result?.error || '') === 'already_at_last_prompt') {
          row = {
            ...row,
            finishedAt: Date.now(),
            outcome: 'skipped_already_completed',
            reason: 'already_at_last_prompt',
            detectedPromptNumber,
            startPromptNumber,
            detectedMethod,
            retrySamePrompt,
            retryReason
          };
          serviceRecoveredRunIds.add(row.runId);
        } else {
          row = {
            ...row,
            finishedAt: Date.now(),
            outcome: 'failed',
            reason: typeof result?.error === 'string' && result.error.trim()
              ? result.error.trim()
              : 'resume_failed',
            error: typeof result?.error === 'string' && result.error.trim()
              ? result.error.trim()
              : 'resume_failed',
            detectedPromptNumber,
            startPromptNumber,
            detectedMethod,
            retrySamePrompt,
            retryReason
          };
        }
      } catch (error) {
        row = {
          ...row,
          finishedAt: Date.now(),
          outcome: 'failed',
          reason: 'resume_exception',
          error: error?.message || String(error)
        };
      }
    }

    const nextRows = (Array.isArray(serviceBatchState?.rows) ? serviceBatchState.rows : [])
      .concat([row])
      .slice(-500);
    const nextTotals = applyServiceBatchRowToTotals(serviceBatchState?.totals, row);
    serviceBatchState = {
      ...serviceBatchState,
      rows: nextRows,
      totals: nextTotals,
      activeRunId: '',
      updatedAt: Date.now()
    };
    applyData(lastListResult, serviceBatchState);
    reportServiceModeEvent({
      reason: `stale_running_recovery_${row.outcome || 'unknown'}`,
      status: row.outcome || 'unknown',
      message: row.reason || row.outcome || 'stale_running_recovery_row',
      runId: row.runId || '',
      title: row.title || '',
      statusText: `idx=${candidateIndex + 1}/${candidates.length} detected=${row.detectedPromptNumber || '-'} start=${row.startPromptNumber || '-'} method=${row.detectedMethod || '-'}`,
      error: row.error || ''
    });
    setStatus('Batch wznowienia trwa', {
      meta: `processed=${nextTotals.processed}/${nextTotals.total} | current=${candidate?.runId || '-'} | idx=${candidateIndex + 1}/${candidates.length}`,
      hints: ['PROCESS_RESUME_NEXT_STAGE', 'fresh tab', 'live detect']
    });
  }

  const totalIssues = (serviceBatchState?.totals?.failed || 0)
    + (serviceBatchState?.totals?.skipped_missing_chat_url || 0)
    + (serviceBatchState?.totals?.skipped_not_found || 0);
  serviceBatchState = {
    ...serviceBatchState,
    status: totalIssues > 0 ? 'completed_with_errors' : 'completed',
    finishedAt: Date.now(),
    updatedAt: Date.now(),
    activeRunId: ''
  };
  applyData(lastListResult, serviceBatchState);
  setStatus(
    totalIssues > 0 ? 'Batch stale running zakonczony z bledami' : 'Batch stale running zakonczony',
    {
      meta: `processed=${serviceBatchState?.totals?.processed || 0}/${serviceBatchState?.totals?.total || 0} | resumed=${serviceBatchState?.totals?.resumed || 0} | failed=${serviceBatchState?.totals?.failed || 0}`,
      hints: ['odswiez liste, aby zobaczyc pozostale stale runy']
    }
  );
  reportServiceModeEvent({
    reason: totalIssues > 0
      ? 'stale_running_recovery_batch_completed_with_errors'
      : 'stale_running_recovery_batch_completed',
    status: totalIssues > 0 ? 'completed_with_errors' : 'completed',
    message: totalIssues > 0
      ? 'stale_running_recovery_batch_completed_with_errors'
      : 'stale_running_recovery_batch_completed',
    statusText: `processed=${serviceBatchState?.totals?.processed || 0}/${serviceBatchState?.totals?.total || 0} resumed=${serviceBatchState?.totals?.resumed || 0} failed=${serviceBatchState?.totals?.failed || 0}`
  });
  await refreshData({ silent: true });
}

async function startBatch(limit = null) {
  if (STALE_RUNNING_RECOVERY_MODE) {
    await startStaleRunningRecoveryBatch(limit);
    return;
  }
  updateRunButtonState({ status: 'running' });
  const limitText = Number.isInteger(limit) && limit > 0 ? `${limit}` : 'all';
  const modeText = Number.isInteger(limit) && limit > 0 ? 'top-progress snapshot' : 'latest update';
  setStatus('Uruchamiam batch wznowienia...', {
    meta: `source=${selectedSourceFilter} | limit=${limitText} | strategy=${modeText}`,
    hints: ['fresh tab for each resume', 'live detect on chat', 'snapshot ranking before start']
  });
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
      setStatus('Batch juz dziala', {
        meta: `jobId=${response?.jobId || '-'} | aktywny batch nie zostal nadpisany`,
        hints: ['monitoring live enabled']
      });
      return;
    }

    applyData(lastListResult, response?.state || null);
    setStatus('Batch wystartowal', {
      meta: `jobId=${response?.jobId || '-'} | limit=${limitText} | strategy=${modeText}`,
      hints: buildStatusHints(lastListResult, ['nowe karty beda otwierane per recovery run'])
    });
    void refreshData({ silent: true });
  } catch (error) {
    setStatus('Blad startu batcha', {
      meta: error?.message || String(error),
      hints: ['sprawdz problem log', 'sprawdz chatUrl i worker service'],
      isError: true
    });
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
    setStatus('Batch wznowienia trwa', {
      meta: `processed=${processed}/${total} | active=${state.activeRunId || '-'} | updated=${formatDateTime(state.updatedAt)}`,
      hints: ['live detect in progress', 'new tabs per candidate']
    });
  } else {
    setStatus(`Batch zakonczony: ${status}`, {
      meta: `updated=${formatDateTime(state.updatedAt)} | jobId=${state.jobId || '-'}`,
      hints: buildStatusHints(lastListResult)
    });
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

window.addEventListener('beforeunload', () => {
  stopWorkerKeepalive();
});

if (pollIntervalId) {
  window.clearInterval(pollIntervalId);
}
pollIntervalId = window.setInterval(() => {
  if (!isUnfinishedPageVisible()) return;
  void refreshData({ silent: true });
}, UNFINISHED_RESUME_POLL_INTERVAL_MS);

document.addEventListener('visibilitychange', () => {
  if (!isUnfinishedPageVisible()) return;
  void refreshData({ silent: true });
});

if (STALE_RUNNING_RECOVERY_MODE) {
  document.title = `Stale Running Recovery > ${STALE_RUNNING_RECOVERY_HOURS}h`;
  setStatus('Tryb serwisowy: stale running recovery', {
    meta: `threshold=${STALE_RUNNING_RECOVERY_HOURS}h | autorun=${STALE_RUNNING_RECOVERY_AUTORUN ? 'on' : 'off'} | limit=${STALE_RUNNING_RECOVERY_LIMIT || 'all'}`,
    hints: ['GET_PROCESSES', 'filter stale running', 'PROCESS_RESUME_NEXT_STAGE']
  });
  reportServiceModeEvent({
    reason: 'stale_running_recovery_page_loaded',
    status: 'loaded',
    message: 'stale_running_recovery_page_loaded',
    statusText: `threshold_h=${STALE_RUNNING_RECOVERY_HOURS} autorun=${STALE_RUNNING_RECOVERY_AUTORUN ? 'on' : 'off'} limit=${STALE_RUNNING_RECOVERY_LIMIT || 'all'}`
  });
}

startWorkerKeepalive();
void refreshData();
