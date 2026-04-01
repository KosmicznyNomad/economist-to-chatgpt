// process-monitor.js - UI dla centralnego okna monitoringu
const processList = document.getElementById('process-list');
const emptyState = document.getElementById('empty-state');
const detailsEmpty = document.getElementById('details-empty');
const detailsContainer = document.getElementById('process-details');
const historyToggle = document.getElementById('history-toggle');
const historyList = document.getElementById('history-list');
const resumeAllBtn = document.getElementById('resume-all-btn');
const unfinishedProcessesBtn = document.getElementById('unfinished-processes-btn');
const processSummary = document.getElementById('process-summary');
const viewFilterSelect = document.getElementById('view-filter');
const viewQueryInput = document.getElementById('view-query');
const viewHint = document.getElementById('view-hint');

let selectedProcessId = null;
let currentProcesses = [];
let activeProcessesCache = [];
let allProcessesCache = [];
let analysisQueueSnapshot = null;
let processSnapshotVersion = 0;
let queueSnapshotVersion = 0;
let lastSignature = '';
let lastHistorySignature = '';
let historyOpen = false;
let viewFilterMode = 'all';
let viewQueryValue = '';
let lastPushUpdateAt = 0;
const processCardMap = new Map();
const processSeenAt = new Map();
let stageNamesCompany = [];
let stageNamesLoaded = false;
const processConversationAuditCache = new Map();
const processConversationAuditInFlight = new Map();
const processCompanySnapshotCache = new Map();
const processCompanySnapshotInFlight = new Map();
const PROCESS_AUDIT_CACHE_TTL_MS = 45_000;
const PROCESS_COMPANY_SNAPSHOT_TTL_MS = 60_000;

console.log('[panel] Monitor procesow uruchomiony');

async function loadStageNames() {
  const response = await sendRuntimeMessage({ type: 'GET_STAGE_NAMES' });
  const names = Array.isArray(response?.stageNames)
    ? response.stageNames.filter((name) => typeof name === 'string')
    : [];
  stageNamesCompany = names;
  stageNamesLoaded = true;
  return names;
}

async function initializeMonitor() {
  await loadStageNames();
  await refreshProcesses();
}

// Pobierz procesy przy starcie
void initializeMonitor();

// Nasluchuj na aktualizacje
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'PROCESSES_UPDATE') {
    lastPushUpdateAt = Date.now();
    if (Number.isInteger(message?.version)) processSnapshotVersion = message.version;
    if (Number.isInteger(message?.queueVersion)) queueSnapshotVersion = message.queueVersion;
    applyProcessesUpdate(message.processes, { queue: message.queue || null });
  }
});

function shouldRunFallbackRefresh() {
  if (!lastPushUpdateAt) return true;
  return (Date.now() - lastPushUpdateAt) > 10_000;
}

// Push-first monitor; backup poll only when channel looks stale.
setInterval(() => {
  if (!shouldRunFallbackRefresh()) return;
  void refreshProcesses();
}, 20_000);
installProcessMonitorRuntimeProblemLogging();

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

if (unfinishedProcessesBtn) {
  unfinishedProcessesBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('unfinished-processes.html') });
  });
}

if (viewFilterSelect) {
  viewFilterSelect.addEventListener('change', () => {
    const nextValue = typeof viewFilterSelect.value === 'string' ? viewFilterSelect.value : 'all';
    viewFilterMode = nextValue || 'all';
    lastSignature = '';
    updateUI(activeProcessesCache.length > 0 ? activeProcessesCache : currentProcesses, { force: true });
  });
}

if (viewQueryInput) {
  let queryTimer = null;
  viewQueryInput.addEventListener('input', () => {
    if (queryTimer) clearTimeout(queryTimer);
    queryTimer = setTimeout(() => {
      viewQueryValue = typeof viewQueryInput.value === 'string' ? viewQueryInput.value.trim().toLowerCase() : '';
      lastSignature = '';
      updateUI(activeProcessesCache.length > 0 ? activeProcessesCache : currentProcesses, { force: true });
    }, 120);
  });
}

const reasonLabels = {
  send_failed: 'Blad wysylania promptu',
  timeout: 'Timeout odpowiedzi',
  invalid_response: 'Za krotka odpowiedz',
  missing_assistant_reply: 'Brak odpowiedzi asystenta',
  textarea_not_found: 'Nie znaleziono pola wpisywania',
  execute_script_failed: 'Blad executeScript',
  execute_script_retry: 'Retry executeScript',
  auto_resume_execute_script_failed: 'Auto-resume: blad executeScript',
  auto_resume_execute_script_retry: 'Auto-resume: retry executeScript',
  auto_resume_failed: 'Auto-resume nieudany',
  auto_resume_unhandled_exception: 'Auto-resume: nieobsluzony wyjatek',
  bulk_resume_reload: 'Zatrzymano przed zbiorczym wznowieniem',
  missing_execute_result: 'Brak wyniku executeScript',
  inject_failed: 'Inject zakonczyl sie bledem',
  inject_critical_error: 'Krytyczny blad injectToChat',
  force_stopped: 'Proces zatrzymany sygnalem STOP',
  pdf_attach_failed: 'Nie udalo sie dolaczyc PDF',
  save_failed: 'Blad zapisu odpowiedzi',
  save_response_failed: 'Nieudany zapis odpowiedzi',
  empty_response: 'Pusta odpowiedz (bez zapisu)',
  auto_recovery_send_failed: 'Auto-resend po bledzie wysylania',
  auto_recovery_timeout: 'Auto-resend po timeout',
  auto_recovery_invalid_response: 'Auto-resend po niepoprawnej odpowiedzi',
  auto_recovery_textarea_not_found: 'Auto-resend: brak pola wpisywania',
  auto_recovery_provider_invalid_response: 'Auto-resend: niepoprawna odpowiedz providera',
  data_gap_unresolved: 'DATA_GAPS nierozwiazany',
  data_gap_rewind_applied: 'DATA_GAPS rewind zastosowany'
};
const persistenceErrorLabels = {
  runtime_unavailable: 'most runtime niedostepny',
  runtime_timeout: 'timeout mostu runtime',
  save_message_failed: 'blad save-message',
  save_response_failed: 'blad save-response',
  save_failed: 'blad zapisu',
  dispatch_failed: 'blad dispatch',
  missing_intake_url: 'brak Intake URL',
  missing_dispatch_credentials: 'brak danych dispatch',
  storage_unavailable: 'storage niedostepny',
  empty_response: 'pusta odpowiedz'
};
const DecisionContractUtils = globalThis.DecisionContractUtils || {};
const ResponseStorageUtils = globalThis.ResponseStorageUtils || {};
const DecisionViewModelUtils = globalThis.DecisionViewModelUtils || {};
const ProcessContractUtils = globalThis.ProcessContractUtils || {};
const ProblemLogUiUtils = globalThis.ProblemLogUiUtils || {};
const RESPONSE_STORAGE_KEY = ResponseStorageUtils.RESPONSE_STORAGE_KEY || 'responses';

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
      defaultSource: 'process-monitor-ui',
      defaultMessage: 'process_monitor_problem',
      signatureNamespace: 'process-monitor-ui'
    });
    return;
  }
  const source = typeof rawEntry?.source === 'string' && rawEntry.source.trim()
    ? rawEntry.source.trim()
    : 'process-monitor-ui';
  const message = typeof rawEntry?.message === 'string' && rawEntry.message.trim()
    ? rawEntry.message.trim()
    : 'process_monitor_problem';
  const error = typeof rawEntry?.error === 'string' ? rawEntry.error.trim() : '';
  const reason = typeof rawEntry?.reason === 'string' ? rawEntry.reason.trim() : '';
  const signature = typeof rawEntry?.signature === 'string' && rawEntry.signature.trim()
    ? rawEntry.signature.trim()
    : ['process-monitor-ui', source, rawEntry?.title || '', reason, error, message].join('|');
  try {
    void sendRuntimeMessage({
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
    });
  } catch {
    // Ignore runtime bridge errors in UI page.
  }
}

function installProcessMonitorRuntimeProblemLogging() {
  window.addEventListener('error', (event) => {
    const fileName = typeof event?.filename === 'string' ? event.filename.trim() : '';
    const lineNo = Number.isInteger(event?.lineno) ? event.lineno : null;
    const colNo = Number.isInteger(event?.colno) ? event.colno : null;
    const location = fileName
      ? `${fileName}${lineNo !== null ? `:${lineNo}` : ''}${colNo !== null ? `:${colNo}` : ''}`
      : '';
    const errorText = summarizeClientErrorValue(event?.error || event?.message || '');
    reportProblemLogFromUi({
      source: 'process-monitor-window',
      title: 'Process monitor runtime error',
      reason: location || 'process_monitor_error',
      error: errorText,
      message: typeof event?.message === 'string' && event.message.trim()
        ? event.message.trim()
        : (errorText || 'process_monitor_runtime_error')
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reasonText = summarizeClientErrorValue(event?.reason);
    reportProblemLogFromUi({
      source: 'process-monitor-window',
      title: 'Process monitor unhandled rejection',
      reason: 'unhandledrejection',
      error: reasonText,
      message: reasonText || 'process_monitor_unhandled_rejection'
    });
  });
}

function normalizeCodeToken(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function humanizeToken(value) {
  const normalized = normalizeCodeToken(value);
  if (!normalized) return '';
  return normalized.replace(/[_-]+/g, ' ');
}

function getProcessContract(process) {
  if (ProcessContractUtils && typeof ProcessContractUtils.getProcessContract === 'function') {
    return ProcessContractUtils.getProcessContract(process || {});
  }

  const lifecycleStatus = typeof process?.lifecycleStatus === 'string'
    ? process.lifecycleStatus
    : (typeof process?.status === 'string' ? process.status : 'running');
  const actionRequired = process?.needsAction ? 'manual_resume' : 'none';
  return {
    lifecycleStatus,
    phase: typeof process?.phase === 'string' ? process.phase : '',
    actionRequired,
    statusCode: typeof process?.statusCode === 'string' ? process.statusCode : '',
    statusText: typeof process?.statusText === 'string' ? process.statusText : ''
  };
}

function getProcessLifecycleStatus(process) {
  return getProcessContract(process).lifecycleStatus;
}

function getProcessPhase(process) {
  return getProcessContract(process).phase;
}

function getProcessActionRequired(process) {
  return getProcessContract(process).actionRequired;
}

function getProcessStatusCode(process) {
  return getProcessContract(process).statusCode;
}

function getProcessStatusText(process) {
  const contract = getProcessContract(process);
  return typeof contract?.statusText === 'string' && contract.statusText.trim()
    ? contract.statusText.trim()
    : (typeof process?.statusText === 'string' ? process.statusText.trim() : '');
}

function processNeedsAction(process) {
  return getProcessActionRequired(process) !== 'none';
}

function getReasonLabel(reasonCode) {
  const normalized = normalizeCodeToken(reasonCode);
  if (!normalized) return '';
  if (reasonLabels[normalized]) return reasonLabels[normalized];
  if (normalized.startsWith('auto_recovery_')) {
    const suffix = normalized.slice('auto_recovery_'.length);
    if (suffix && reasonLabels[suffix]) {
      return `Auto-recovery: ${reasonLabels[suffix].toLowerCase()}`;
    }
    return `Auto-recovery: ${humanizeToken(suffix) || 'nieznany powod'}`;
  }
  return humanizeToken(normalized);
}

function getPersistenceErrorLabel(errorCode) {
  const normalized = normalizeCodeToken(errorCode);
  if (!normalized) return '';
  if (persistenceErrorLabels[normalized]) return persistenceErrorLabels[normalized];
  return humanizeToken(normalized);
}

function buildProcessReasonLine(process) {
  if (!process || typeof process !== 'object') return '';
  const reasonCode = normalizeCodeToken(process?.reason);
  const reasonLabel = getReasonLabel(reasonCode);
  const errorText = shortenText(process?.error || '', 180);
  const persistenceStatus = process?.persistenceStatus && typeof process.persistenceStatus === 'object'
    ? process.persistenceStatus
    : null;
  const saveErrorCode = normalizeCodeToken(persistenceStatus?.saveError || '');
  const bridgeErrorCode = normalizeCodeToken(persistenceStatus?.bridgeError || '');

  const details = [];
  if (saveErrorCode && saveErrorCode !== 'empty_response') {
    details.push(`save=${getPersistenceErrorLabel(saveErrorCode)}`);
  }
  if (bridgeErrorCode) {
    details.push(`bridge=${getPersistenceErrorLabel(bridgeErrorCode)}`);
  }
  if (errorText) {
    details.push(`err=${errorText}`);
  }

  if (reasonLabel && details.length === 0) return reasonLabel;
  if (!reasonLabel && details.length > 0) return details.join(' | ');
  if (!reasonLabel) return '';
  return `${reasonLabel} | ${details.join(' | ')}`;
}

function shortenText(value, maxLength = 180) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function getPersistenceLogLines(process, maxLines = 4) {
  const normalizedMaxLines = Number.isInteger(maxLines) && maxLines > 0 ? maxLines : 4;
  const lines = [];
  const persistenceStatus = process?.persistenceStatus && typeof process.persistenceStatus === 'object'
    ? process.persistenceStatus
    : null;

  const directLog = Array.isArray(process?.persistenceLog)
    ? process.persistenceLog
    : [];
  directLog.forEach((line) => {
    const normalized = shortenText(line, 220);
    if (!normalized) return;
    lines.push(normalized);
  });

  if (lines.length === 0) {
    const summary = shortenText(persistenceStatus?.dispatchSummary || '', 220);
    if (summary) {
      lines.push(summary);
    }
  }

  if (lines.length === 0) {
    const saveError = getPersistenceErrorLabel(persistenceStatus?.saveError || '');
    if (saveError && persistenceStatus?.saveOk === false) {
      lines.push(`Baza: BLAD zapisu (${saveError})`);
    }
  }

  if (lines.length === 0) {
    const bridgeError = getPersistenceErrorLabel(persistenceStatus?.bridgeError || '');
    if (bridgeError && persistenceStatus?.saveOk === true) {
      lines.push(`Most runtime: fallback (${bridgeError})`);
    }
  }

  if (lines.length === 0) {
    const completedSaved = process?.completedResponseSaved;
    const status = getNormalizedStatus(process);
    if (completedSaved === true) {
      lines.push('Baza: OK');
    } else if (completedSaved === false && isCompletedStatus(status)) {
      lines.push('Baza: BLAD zapisu');
    }
  }

  return lines.slice(0, normalizedMaxLines);
}

function parseDispatchCountFromSummary(summaryText, key) {
  if (typeof summaryText !== 'string' || !summaryText.trim() || typeof key !== 'string' || !key.trim()) {
    return null;
  }
  const pattern = new RegExp(`\\b${key}\\s*=\\s*(\\d+)\\b`, 'i');
  const match = summaryText.match(pattern);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function resolveProcessDatabaseDelivery(process) {
  const persistenceStatus = process?.persistenceStatus && typeof process.persistenceStatus === 'object'
    ? process.persistenceStatus
    : null;
  const finalStagePersistence = process?.finalStagePersistence && typeof process.finalStagePersistence === 'object'
    ? process.finalStagePersistence
    : null;
  const dispatch = persistenceStatus?.dispatch && typeof persistenceStatus.dispatch === 'object'
    ? persistenceStatus.dispatch
    : (process?.completedResponseDispatch && typeof process.completedResponseDispatch === 'object'
      ? process.completedResponseDispatch
      : null);
  const summaryText = [
    typeof persistenceStatus?.dispatchSummary === 'string' ? persistenceStatus.dispatchSummary : '',
    typeof finalStagePersistence?.dispatchSummary === 'string' ? finalStagePersistence.dispatchSummary : '',
    typeof process?.completedResponseDispatchSummary === 'string' ? process.completedResponseDispatchSummary : ''
  ].find((item) => typeof item === 'string' && item.trim()) || '';

  let sent = Number.isInteger(dispatch?.sent) ? dispatch.sent : null;
  let failed = Number.isInteger(dispatch?.failed) ? dispatch.failed : null;
  let deferred = Number.isInteger(dispatch?.deferred) ? dispatch.deferred : null;
  let remaining = Number.isInteger(dispatch?.remaining) ? dispatch.remaining : null;

  if (sent === null) sent = parseDispatchCountFromSummary(summaryText, 'sent');
  if (failed === null) failed = parseDispatchCountFromSummary(summaryText, 'failed');
  if (deferred === null) deferred = parseDispatchCountFromSummary(summaryText, 'deferred');
  if (remaining === null) remaining = parseDispatchCountFromSummary(summaryText, 'remaining');

  const hasNumericDispatch = sent !== null || failed !== null || deferred !== null || remaining !== null;
  const safeSent = sent ?? 0;
  const safeFailed = failed ?? 0;
  const safeDeferred = deferred ?? 0;
  const safeRemaining = remaining ?? 0;
  const pending = safeDeferred + safeRemaining;

  let saveOk = null;
  if (typeof persistenceStatus?.saveOk === 'boolean') {
    saveOk = persistenceStatus.saveOk;
  } else if (typeof process?.completedResponseSaved === 'boolean') {
    saveOk = process.completedResponseSaved;
  } else if (typeof finalStagePersistence?.success === 'boolean') {
    saveOk = finalStagePersistence.success;
  }

  return {
    saveOk,
    sent: safeSent,
    failed: safeFailed,
    deferred: safeDeferred,
    remaining: safeRemaining,
    pending,
    hasNumericDispatch,
    queueSkipped: dispatch?.queueSkipped === true || finalStagePersistence?.queueSkipped === true,
    summaryText: typeof summaryText === 'string' ? summaryText.trim() : ''
  };
}

function getDatabaseBadgeModel(process) {
  const delivery = resolveProcessDatabaseDelivery(process);
  const hasSignal = delivery.saveOk !== null || delivery.hasNumericDispatch || !!delivery.summaryText;
  if (!hasSignal) {
    return {
      visible: false,
      text: '',
      className: 'db-badge db-info',
      detailText: ''
    };
  }

  if (delivery.saveOk === false) {
    const failedChunk = delivery.hasNumericDispatch ? `, blad=${delivery.failed}` : '';
    return {
      visible: true,
      text: `Baza: BLAD${failedChunk}`,
      className: 'db-badge db-error',
      detailText: `Baza danych: BLAD zapisu${failedChunk}`
    };
  }

  if (delivery.saveOk === true) {
    if (delivery.hasNumericDispatch) {
      const parts = [`Baza: ${delivery.sent} OK`];
      if (delivery.pending > 0) parts.push(`pending=${delivery.pending}`);
      if (delivery.failed > 0) parts.push(`blad=${delivery.failed}`);
      const severityClass = delivery.failed > 0
        ? (delivery.sent > 0 ? 'db-warning' : 'db-error')
        : (delivery.pending > 0 || delivery.queueSkipped ? 'db-warning' : 'db-success');
      return {
        visible: true,
        text: parts.join(', '),
        className: `db-badge ${severityClass}`,
        detailText: `Baza danych: wyslano=${delivery.sent}, pending=${delivery.pending}, bledy=${delivery.failed}`
      };
    }
    return {
      visible: true,
      text: 'Baza: OK',
      className: 'db-badge db-success',
      detailText: 'Baza danych: zapis OK'
    };
  }

  if (delivery.hasNumericDispatch) {
    return {
      visible: true,
      text: `Baza: sent=${delivery.sent}, pending=${delivery.pending}, blad=${delivery.failed}`,
      className: 'db-badge db-info',
      detailText: `Baza danych: sent=${delivery.sent}, pending=${delivery.pending}, bledy=${delivery.failed}`
    };
  }

  return {
    visible: true,
    text: 'Baza: status nieznany',
    className: 'db-badge db-info',
    detailText: delivery.summaryText ? `Baza danych: ${delivery.summaryText}` : 'Baza danych: status nieznany'
  };
}

function getNormalizedStatus(process) {
  return getProcessLifecycleStatus(process);
}

function normalizePromptNumberList(values) {
  if (!Array.isArray(values)) return [];
  const unique = new Set();
  values.forEach((value) => {
    const asNumber = Number.parseInt(String(value || '').trim(), 10);
    if (Number.isInteger(asNumber) && asNumber > 0) {
      unique.add(asNumber);
    }
  });
  return Array.from(unique).sort((left, right) => left - right);
}

function normalizeCompanyConversationAudit(rawAudit) {
  if (!rawAudit || typeof rawAudit !== 'object' || rawAudit.success !== true) {
    return null;
  }
  const totals = rawAudit?.totals && typeof rawAudit.totals === 'object'
    ? rawAudit.totals
    : {};
  const verification = rawAudit?.verification && typeof rawAudit.verification === 'object'
    ? rawAudit.verification
    : {};
  const stageMappingCheck = rawAudit?.stageMappingCheck && typeof rawAudit.stageMappingCheck === 'object'
    ? rawAudit.stageMappingCheck
    : {};

  const promptCatalogCount = Number.isInteger(rawAudit?.promptCatalogCount)
    ? rawAudit.promptCatalogCount
    : 0;
  const matchedPromptMessages = Number.isInteger(totals?.matchedPromptMessages)
    ? totals.matchedPromptMessages
    : 0;
  const recognizedUniquePrompts = Number.isInteger(totals?.recognizedUniquePrompts)
    ? totals.recognizedUniquePrompts
    : 0;
  const missingReplyPromptNumbers = normalizePromptNumberList(rawAudit?.missingReplyPromptNumbers);
  const lowQualityReplyPromptNumbers = normalizePromptNumberList(rawAudit?.lowQualityReplyPromptNumbers);
  const missingPromptNumbers = normalizePromptNumberList(rawAudit?.missingPromptNumbers);
  const processIssueFlags = Array.isArray(rawAudit?.processIssueFlags)
    ? rawAudit.processIssueFlags.filter((item) => typeof item === 'string' && item.trim())
    : [];

  const promptRepliesMissing = Number.isInteger(totals?.promptRepliesMissing)
    ? totals.promptRepliesMissing
    : missingReplyPromptNumbers.length;
  const promptRepliesBelowThreshold = Number.isInteger(totals?.promptRepliesBelowThreshold)
    ? totals.promptRepliesBelowThreshold
    : lowQualityReplyPromptNumbers.length;

  const dataGapStopDetected = rawAudit?.dataGapStopDetected === true
    || verification?.dataGapStopDetected === true
    || processIssueFlags.includes('data_gap_stop');
  const dataGapMissingInputsList = Array.isArray(rawAudit?.dataGapMissingInputsList)
    ? rawAudit.dataGapMissingInputsList.filter((item) => typeof item === 'string' && item.trim())
    : [];
  const dataGapMissingInputsText = typeof rawAudit?.dataGapMissingInputs === 'string'
    ? rawAudit.dataGapMissingInputs.trim()
    : '';

  return {
    success: true,
    fetchedAt: Date.now(),
    tabId: Number.isInteger(rawAudit?.tabId) ? rawAudit.tabId : null,
    processState: typeof rawAudit?.processState === 'string' ? rawAudit.processState.trim() : '',
    promptCatalogCount,
    matchedPromptMessages,
    recognizedUniquePrompts,
    promptRepliesMissing,
    promptRepliesBelowThreshold,
    missingReplyPromptNumbers,
    lowQualityReplyPromptNumbers,
    missingPromptNumbers,
    dataGapStopDetected,
    dataGapMissingInputsList,
    dataGapMissingInputsText,
    processIssueFlags,
    stageMappingCheck: {
      promptCount: Number.isInteger(stageMappingCheck?.promptCount) ? stageMappingCheck.promptCount : promptCatalogCount,
      stageNameCount: Number.isInteger(stageMappingCheck?.stageNameCount) ? stageMappingCheck.stageNameCount : 0,
      alignedByCount: stageMappingCheck?.alignedByCount === true,
      missingStageNames: normalizePromptNumberList(stageMappingCheck?.missingStageNames)
    }
  };
}

function getProcessAuditCacheEntry(process) {
  if (!process || !process.id) return null;
  return processConversationAuditCache.get(String(process.id)) || null;
}

function getCachedProcessAudit(process) {
  const entry = getProcessAuditCacheEntry(process);
  if (!entry || !entry.audit) return null;
  const ageMs = Date.now() - (Number.isInteger(entry.fetchedAt) ? entry.fetchedAt : 0);
  if (ageMs > PROCESS_AUDIT_CACHE_TTL_MS) return null;

  const processTabId = Number.isInteger(process?.tabId) ? process.tabId : null;
  if (Number.isInteger(entry.tabId) && Number.isInteger(processTabId) && entry.tabId !== processTabId) {
    return null;
  }
  return entry.audit;
}

function setProcessAuditCache(process, audit) {
  if (!process || !process.id || !audit) return;
  processConversationAuditCache.set(String(process.id), {
    audit,
    fetchedAt: Number.isInteger(audit?.fetchedAt) ? audit.fetchedAt : Date.now(),
    tabId: Number.isInteger(audit?.tabId) ? audit.tabId : (Number.isInteger(process?.tabId) ? process.tabId : null)
  });
}

function getProcessSignalFromAudit(process) {
  const audit = getCachedProcessAudit(process);
  if (!audit) return null;
  return {
    hasDataGap: audit.dataGapStopDetected === true,
    hasMissingReply: (audit.promptRepliesMissing || 0) > 0 || audit.missingReplyPromptNumbers.length > 0
  };
}

function isDataGapProcess(process) {
  const auditSignal = getProcessSignalFromAudit(process);
  if (auditSignal) return auditSignal.hasDataGap;
  if (!process || typeof process !== 'object') return false;
  const marker = [
    typeof process?.reason === 'string' ? process.reason : '',
    getProcessStatusText(process),
    typeof process?.error === 'string' ? process.error : ''
  ].join(' ');
  return /\bdata[_\s-]?gaps?(?:\b|[_-])/i.test(marker);
}

function isMissingReplyProcess(process) {
  const auditSignal = getProcessSignalFromAudit(process);
  if (auditSignal) return auditSignal.hasMissingReply;
  if (!process || typeof process !== 'object') return false;
  const marker = [
    typeof process?.reason === 'string' ? process.reason : '',
    getProcessStatusText(process),
    typeof process?.error === 'string' ? process.error : ''
  ].join(' ');
  return (
    /\bmissing_assistant_reply\b/i.test(marker)
    || /brak odpowiedzi/i.test(marker)
  );
}

function isFailedStatus(status) {
  if (ProcessContractUtils && typeof ProcessContractUtils.isFailedLifecycleStatus === 'function') {
    return ProcessContractUtils.isFailedLifecycleStatus(status);
  }
  return status === 'failed';
}

function isCompletedStatus(status) {
  if (ProcessContractUtils && typeof ProcessContractUtils.isCompletedLifecycleStatus === 'function') {
    return ProcessContractUtils.isCompletedLifecycleStatus(status);
  }
  return status === 'completed';
}

const priorityReasonWeights = Object.freeze({
  data_gap_unresolved: 42,
  missing_assistant_reply: 34,
  timeout: 28,
  send_failed: 26,
  invalid_response: 20,
  save_failed: 24,
  save_response_failed: 24,
  inject_failed: 18,
  execute_script_failed: 18,
  textarea_not_found: 16,
  auto_resume_failed: 15,
  auto_resume_execute_script_failed: 15,
  auto_resume_unhandled_exception: 15,
  data_gap_rewind_applied: 12
});

function resolveReasonPriorityWeight(reasonCode) {
  const normalized = normalizeCodeToken(reasonCode);
  if (!normalized) return 0;
  if (priorityReasonWeights[normalized]) return priorityReasonWeights[normalized];
  if (normalized.startsWith('auto_recovery_')) return 10;
  return 0;
}

function getProcessPriorityModel(process) {
  if (!process || typeof process !== 'object') {
    return {
      code: 'P4',
      label: 'Niski',
      score: 0,
      className: 'priority-p4',
      drivers: ['brak_danych'],
      summary: 'brak danych'
    };
  }

  const status = getNormalizedStatus(process);
  if (isCompletedStatus(status)) {
    return {
      code: 'P4',
      label: 'Niski',
      score: 0,
      className: 'priority-p4',
      drivers: ['completed'],
      summary: 'zakonczony'
    };
  }

  let score = 0;
  const drivers = [];

  if (processNeedsAction(process)) {
    score += 40;
    drivers.push('needs_action');
  }
  if (isFailedStatus(status)) {
    score += 30;
    drivers.push('failed_status');
  }
  if (isDataGapProcess(process)) {
    score += 35;
    drivers.push('data_gap');
  }
  if (isMissingReplyProcess(process)) {
    score += 28;
    drivers.push('missing_reply');
  }

  const reasonCode = normalizeCodeToken(process?.reason || '');
  const reasonWeight = resolveReasonPriorityWeight(reasonCode);
  if (reasonWeight > 0) {
    score += reasonWeight;
    drivers.push(`reason:${reasonCode}`);
  }

  const persistenceStatus = process?.persistenceStatus && typeof process.persistenceStatus === 'object'
    ? process.persistenceStatus
    : null;
  if (persistenceStatus?.saveOk === false) {
    score += 20;
    drivers.push('save_failed');
  } else if (normalizeCodeToken(persistenceStatus?.bridgeError || '')) {
    score += 8;
    drivers.push('bridge_fallback');
  }

  const updatedAt = Number.isInteger(process?.lastActivityAt)
    ? process.lastActivityAt
    : (Number.isInteger(process.timestamp) ? process.timestamp : process.startedAt);
  if (Number.isInteger(updatedAt) && updatedAt > 0) {
    const ageMinutes = Math.max(0, (Date.now() - updatedAt) / 60_000);
    if (ageMinutes >= 10) {
      const ageScore = Math.min(20, Math.floor((ageMinutes - 10) / 5) * 3 + 3);
      score += ageScore;
      drivers.push(`stale_${Math.round(ageMinutes)}m`);
    }
  }

  const progress = getProgressPercent(process?.currentPrompt, process?.totalPrompts);
  if (processNeedsAction(process) && progress >= 80) {
    score += 8;
    drivers.push('late_stage_block');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  if (score >= 70) {
    return {
      code: 'P1',
      label: 'Krytyczny',
      score,
      className: 'priority-p1',
      drivers,
      summary: drivers.join(', ')
    };
  }
  if (score >= 50) {
    return {
      code: 'P2',
      label: 'Wysoki',
      score,
      className: 'priority-p2',
      drivers,
      summary: drivers.join(', ')
    };
  }
  if (score >= 30) {
    return {
      code: 'P3',
      label: 'Sredni',
      score,
      className: 'priority-p3',
      drivers,
      summary: drivers.join(', ')
    };
  }
  return {
    code: 'P4',
    label: 'Niski',
    score,
    className: 'priority-p4',
    drivers,
    summary: drivers.join(', ') || 'niski sygnal'
  };
}

function isDefaultViewScope() {
  return viewFilterMode === 'all' && !viewQueryValue;
}

function getViewScopeLabel() {
  switch (viewFilterMode) {
    case 'needs_action':
      return 'wymaga akcji';
    case 'p1p2':
      return 'priorytet P1/P2';
    case 'failed':
      return 'status blad';
    case 'data_gap':
      return 'DATA_GAPS';
    default:
      return 'wszystkie aktywne';
  }
}

function matchesViewFilter(process) {
  if (!process || typeof process !== 'object') return false;

  switch (viewFilterMode) {
    case 'needs_action':
      return processNeedsAction(process);
    case 'p1p2': {
      const code = getProcessPriorityModel(process).code;
      return code === 'P1' || code === 'P2';
    }
    case 'failed':
      return isFailedStatus(getNormalizedStatus(process));
    case 'data_gap':
      return isDataGapProcess(process);
    case 'all':
    default:
      return true;
  }
}

function matchesViewQuery(process) {
  if (!viewQueryValue) return true;
  const haystack = [
    process?.title || '',
    process?.id || '',
    process?.reason || '',
    getProcessStatusText(process),
    process?.error || ''
  ].join(' ').toLowerCase();
  return haystack.includes(viewQueryValue);
}

function applyViewFilters(processes) {
  const items = Array.isArray(processes) ? processes : [];
  return items.filter((process) => matchesViewFilter(process) && matchesViewQuery(process));
}

function updateViewHint(visibleCount, totalCount) {
  if (!viewHint) return;
  const safeVisible = Number.isInteger(visibleCount) ? visibleCount : 0;
  const safeTotal = Number.isInteger(totalCount) ? totalCount : 0;
  const queryPart = viewQueryValue ? `, query="${viewQueryValue}"` : '';
  viewHint.textContent = `Widok: ${getViewScopeLabel()}${queryPart} | pokazane ${safeVisible}/${safeTotal}`;
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

  const activeNeedsAction = activeItems.filter((process) => processNeedsAction(process)).length;
  // Count needsAction only on the same active partition (by id),
  // otherwise stale/non-visible items in history can cause false mismatches.
  const partitionNeedsAction = allItems.filter((process) => {
    if (!processNeedsAction(process)) return false;
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
  const needsActionCount = activeItems.filter((process) => processNeedsAction(process)).length;
  const completedCount = allItems.filter((process) => isCompletedStatus(getNormalizedStatus(process))).length;
  const failedCount = allItems.filter((process) => isFailedStatus(getNormalizedStatus(process))).length;
  const dataGapCount = allItems.filter((process) => isDataGapProcess(process)).length;
  const missingReplyCount = allItems.filter((process) => isMissingReplyProcess(process)).length;
  const totalCount = allItems.length;
  const consistencyIssues = ensureCountConsistency(allItems, activeItems, historyItems);
  const activeProgress = activeItems
    .map((process) => getProgressPercent(process?.currentPrompt, process?.totalPrompts))
    .filter((value) => Number.isInteger(value));
  const avgProgress = activeProgress.length > 0
    ? Math.round(activeProgress.reduce((sum, value) => sum + value, 0) / activeProgress.length)
    : 0;
  const priorityCounts = { P1: 0, P2: 0, P3: 0, P4: 0 };
  activeItems.forEach((process) => {
    const code = getProcessPriorityModel(process).code;
    if (priorityCounts[code] !== undefined) {
      priorityCounts[code] += 1;
    }
  });
  const oldestActiveTs = activeItems.reduce((oldest, process) => {
    const ts = Number.isInteger(process?.startedAt)
      ? process.startedAt
      : (Number.isInteger(process?.timestamp) ? process.timestamp : null);
    if (!Number.isInteger(ts)) return oldest;
    if (!Number.isInteger(oldest)) return ts;
    return Math.min(oldest, ts);
  }, null);
  const stageInfo = stageNamesLoaded ? `Etapy: ${stageNamesCompany.length}` : 'Etapy: ladowanie...';
  const queue = analysisQueueSnapshot && typeof analysisQueueSnapshot === 'object'
    ? analysisQueueSnapshot
    : null;
  const queueSlots = Number.isInteger(queue?.reservedSlots)
    ? queue.reservedSlots
    : (Number.isInteger(queue?.activeSlots) ? queue.activeSlots : 0);
  const queueLiveSlots = Number.isInteger(queue?.liveSlots) ? queue.liveSlots : queueSlots;
  const queueStartingSlots = Number.isInteger(queue?.startingSlots)
    ? queue.startingSlots
    : Math.max(0, queueSlots - queueLiveSlots);
  const queueMax = Number.isInteger(queue?.maxConcurrent) ? queue.maxConcurrent : 7;
  const queueSize = Number.isInteger(queue?.queueSize) ? queue.queueSize : 0;

  if (processSummary) {
    const summary = `Aktywne ${activeCount} | Sloty ${queueSlots}/${queueMax} | Okna ${queueLiveSlots}/${queueMax} | Kolejka ${queueSize} | Akcja ${needsActionCount} | Zakonczone ${completedCount} | Bledy ${failedCount} | P1 ${priorityCounts.P1} | P2 ${priorityCounts.P2} | Wszystkie ${totalCount}`;
    const details = [
      `DATA_GAPS: ${dataGapCount}`,
      `Braki odpowiedzi: ${missingReplyCount}`,
      `Sredni postep aktywnych: ${avgProgress}%`,
      `Najstarszy aktywny: ${formatRelativeTime(oldestActiveTs)}`,
      `Priorytety aktywnych: P1=${priorityCounts.P1}, P2=${priorityCounts.P2}, P3=${priorityCounts.P3}, P4=${priorityCounts.P4}`,
      `Kolejka scheduler: sloty=${queueSlots}/${queueMax}, zywe_okna=${queueLiveSlots}/${queueMax}, startujace=${queueStartingSlots}, oczekuje=${queueSize}`,
      stageInfo
    ];
    if (consistencyIssues.length > 0) {
      details.push(`Korekta licznikow: ${consistencyIssues.join(',')}`);
      console.warn('[panel] Wykryto niespojnosc licznikow procesow', {
        issues: consistencyIssues,
        statusCounts: buildStatusCounts(allItems),
        activeCount,
        historyCount: historyItems.length,
        totalCount
      });
    }
    processSummary.textContent = summary;
    processSummary.title = details.join(' | ');
  }
}

function getStorageAreas() {
  return typeof ResponseStorageUtils.getStorageAreas === 'function'
    ? ResponseStorageUtils.getStorageAreas()
    : {
      local: chrome.storage?.local || null,
      session: chrome.storage?.session || null
    };
}

function makeResponseKey(response) {
  if (typeof ResponseStorageUtils.buildResponseIdentityKeys !== 'function') return '';
  return ResponseStorageUtils.buildResponseIdentityKeys(response).join('|');
}

function mergeResponses(primary, secondary) {
  return typeof ResponseStorageUtils.mergeResponseCollections === 'function'
    ? ResponseStorageUtils.mergeResponseCollections(primary, secondary, DecisionContractUtils)
    : [];
}

async function readResponsesFromStorage() {
  return typeof ResponseStorageUtils.readCanonicalResponses === 'function'
    ? ResponseStorageUtils.readCanonicalResponses(getStorageAreas(), DecisionContractUtils)
    : [];
}

function formatPromptList(values) {
  const list = normalizePromptNumberList(values);
  if (list.length === 0) return '-';
  return list.map((value) => `P${value}`).join(', ');
}

function parseDecisionRecordLine(text) {
  return typeof DecisionContractUtils.parseDecisionRecordLine === 'function'
    ? DecisionContractUtils.parseDecisionRecordLine(text)
    : null;
}

function extractDecisionRecordsFromText(text) {
  return typeof DecisionContractUtils.extractDecisionRecordsFromText === 'function'
    ? DecisionContractUtils.extractDecisionRecordsFromText(text)
    : [];
}

function extractDecisionRecordFromText(text) {
  return typeof DecisionContractUtils.extractDecisionRecordFromText === 'function'
    ? DecisionContractUtils.extractDecisionRecordFromText(text)
    : null;
}

function normalizeDecisionContractSummaryForMonitor(summary) {
  return typeof DecisionContractUtils.normalizeDecisionContractSummary === 'function'
    ? DecisionContractUtils.normalizeDecisionContractSummary(summary)
    : (summary && typeof summary === 'object' ? summary : null);
}

function getDecisionContractRecordForMonitor(summary, role) {
  if (!summary || typeof summary !== 'object') return null;
  if (role === 'PRIMARY' && typeof DecisionContractUtils.getDecisionContractPrimaryRecord === 'function') {
    return DecisionContractUtils.getDecisionContractPrimaryRecord(summary);
  }
  if (role === 'SECONDARY' && typeof DecisionContractUtils.getDecisionContractSecondaryRecord === 'function') {
    return DecisionContractUtils.getDecisionContractSecondaryRecord(summary);
  }
  const records = Array.isArray(summary.records) ? summary.records : [];
  if (role === 'PRIMARY') return records.find((record) => record?.role === 'PRIMARY') || records[0] || null;
  if (role === 'SECONDARY') return records.find((record) => record?.role === 'SECONDARY') || null;
  return null;
}

function mergeDecisionContractMonitorRecord(primary, fallback) {
  const left = primary && typeof primary === 'object' ? primary : null;
  const right = fallback && typeof fallback === 'object' ? fallback : null;
  if (!left && !right) return null;
  const result = { ...(right || {}), ...(left || {}) };
  ['role', 'company', 'decisionDate', 'decisionStatus', 'composite', 'sizing'].forEach((key) => {
    const leftValue = typeof left?.[key] === 'string' ? left[key].trim() : '';
    const rightValue = typeof right?.[key] === 'string' ? right[key].trim() : '';
    result[key] = leftValue || rightValue || '';
  });
  ['compositeValue', 'sizingPercent'].forEach((key) => {
    const leftValue = Number.isFinite(left?.[key]) ? left[key] : Number.NaN;
    const rightValue = Number.isFinite(right?.[key]) ? right[key] : Number.NaN;
    result[key] = Number.isFinite(leftValue) ? leftValue : rightValue;
  });
  return result;
}

function getProcessCompanySnapshotCacheEntry(process) {
  if (!process || !process.id) return null;
  return processCompanySnapshotCache.get(String(process.id)) || null;
}

function getCachedProcessCompanySnapshot(process) {
  const entry = getProcessCompanySnapshotCacheEntry(process);
  if (!entry || !entry.snapshot) return null;
  const ageMs = Date.now() - (Number.isInteger(entry.fetchedAt) ? entry.fetchedAt : 0);
  if (ageMs > PROCESS_COMPANY_SNAPSHOT_TTL_MS) return null;
  return entry.snapshot;
}

function setProcessCompanySnapshotCache(process, snapshot) {
  if (!process || !process.id || !snapshot) return;
  processCompanySnapshotCache.set(String(process.id), {
    snapshot,
    fetchedAt: Date.now()
  });
}

function refreshSummaryUsingCurrentPartitions() {
  const allItems = allProcessesCache.length > 0 ? allProcessesCache : currentProcesses;
  const activeItems = currentProcesses.slice();
  const activeIds = new Set(activeItems.map((process) => process.id));
  const historyItems = allItems.filter((process) => !activeIds.has(process.id));
  updateSummaryPanels(allItems, activeItems, historyItems);
}

async function fetchProcessConversationAudit(process, options = {}) {
  if (!process || !process.id || !Number.isInteger(process.tabId)) return null;
  const processId = String(process.id);
  const force = options?.force === true;

  if (!force) {
    const cached = getCachedProcessAudit(process);
    if (cached) return cached;
  }

  const existingRequest = processConversationAuditInFlight.get(processId);
  if (existingRequest) return existingRequest;

  const request = (async () => {
    const response = await sendRuntimeMessage({
      type: 'COUNT_COMPANY_CONVERSATION_MESSAGES',
      tabId: process.tabId,
      origin: 'process-monitor-company-audit'
    });
    const audit = normalizeCompanyConversationAudit(response);
    if (!audit) return null;
    setProcessAuditCache(process, audit);
    return audit;
  })()
    .catch((error) => {
      console.warn('[panel] company audit fetch failed:', error?.message || error);
      return null;
    })
    .finally(() => {
      if (processConversationAuditInFlight.get(processId) === request) {
        processConversationAuditInFlight.delete(processId);
      }
    });

  processConversationAuditInFlight.set(processId, request);
  const result = await request;
  if (result) {
    refreshSummaryUsingCurrentPartitions();
  }
  return result;
}

async function fetchProcessCompanySnapshot(process, options = {}) {
  if (!process || !process.id) return null;
  const processId = String(process.id);
  const force = options?.force === true;

  if (!force) {
    const cached = getCachedProcessCompanySnapshot(process);
    if (cached) return cached;
  }

  const existingRequest = processCompanySnapshotInFlight.get(processId);
  if (existingRequest) return existingRequest;

  const request = (async () => {
    const fromProcessSnapshot = buildProcessCompanySnapshotFromProcess(process);
    if (fromProcessSnapshot) {
      setProcessCompanySnapshotCache(process, fromProcessSnapshot);
      return fromProcessSnapshot;
    }

    const responses = await readResponsesFromStorage();
    const completed = findCompletedResponseForProcess(process, responses);
    const rawText = extractResponseText(completed) || extractCompletedTextFromProcess(process);
    const stage12State = typeof DecisionViewModelUtils.buildValidatedStage12State === 'function'
      ? DecisionViewModelUtils.buildValidatedStage12State(
        completed && typeof completed === 'object'
          ? completed
          : {
            text: rawText,
            timestamp: Number.isInteger(process?.finishedAt) ? process.finishedAt : Date.now(),
            source: process?.title || '',
            analysisType: 'company',
            runId: String(processId)
          },
        DecisionContractUtils
      )
      : null;
    const snapshot = buildProcessCompanySnapshotFromStage12State(process, {
      processId,
      hasCompletedResponse: !!completed || !!rawText,
      responseTimestamp: Number.isInteger(completed?.timestamp) ? completed.timestamp : null,
      stage12State
    });

    setProcessCompanySnapshotCache(process, snapshot);
    return snapshot;
  })()
    .catch((error) => {
      console.warn('[panel] company snapshot fetch failed:', error?.message || error);
      return null;
    })
    .finally(() => {
      if (processCompanySnapshotInFlight.get(processId) === request) {
        processCompanySnapshotInFlight.delete(processId);
      }
    });

  processCompanySnapshotInFlight.set(processId, request);
  return request;
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
  const source = process.title || '';
  const startedAt = Number.isInteger(process.startedAt) ? process.startedAt : null;
  const finishedAt = Number.isInteger(process.finishedAt) ? process.finishedAt : null;

  const byMetadata = sorted.filter((response) => {
    if ((response.analysisType || 'company') !== 'company') return false;
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

function mapStage12Record(record = {}) {
  return {
    decisionRole: record.role || record.decisionRole || '',
    company: record.company || '',
    decisionStatus: record.decisionStatus || '',
    decisionDate: record.decisionDate || '',
    bear: record.bear || '',
    base: record.base || '',
    bull: record.bull || '',
    sector: record.sector || '',
    companyFamily: record.companyFamily || '',
    companyType: record.companyType || '',
    revenueModel: record.revenueModel || '',
    region: record.region || '',
    currency: record.currency || '',
    composite: record.composite || '',
    sizing: record.sizing || '',
    voi: record.voi || '',
    fals: record.fals || '',
    primaryRisk: record.primaryRisk || ''
  };
}

function buildProcessCompanySnapshotFromStage12State(process, options = {}) {
  const stage12State = options?.stage12State && typeof options.stage12State === 'object'
    ? options.stage12State
    : {};
  const stage12Records = Array.isArray(stage12State?.records)
    ? stage12State.records.map((record) => mapStage12Record(record))
    : [];
  return {
    processId: typeof options?.processId === 'string' ? options.processId : String(process?.id || ''),
    hasCompletedResponse: options?.hasCompletedResponse === true,
    responseTimestamp: Number.isInteger(options?.responseTimestamp) ? options.responseTimestamp : null,
    company: stage12State?.company || (process?.title || ''),
    hasDecisionRecord: stage12Records.length > 0,
    decisionContractStatus: typeof stage12State?.status === 'string' ? stage12State.status : 'invalid',
    decisionContractIssues: Array.isArray(stage12State?.issueCodes) ? stage12State.issueCodes : [],
    decisionRecordCount: Number.isInteger(stage12State?.recordCount) ? stage12State.recordCount : stage12Records.length,
    decisionRecordFormats: Array.isArray(stage12State?.recordFormats) ? stage12State.recordFormats : [],
    stage12Records
  };
}

function buildProcessCompanySnapshotFromProcess(process) {
  const rawSnapshot = process?.completedStage12Snapshot;
  if (!rawSnapshot || typeof rawSnapshot !== 'object') return null;

  const records = Array.isArray(rawSnapshot?.records)
    ? rawSnapshot.records.map((record) => mapStage12Record(record))
    : [];
  return {
    processId: String(process?.id || ''),
    hasCompletedResponse: true,
    responseTimestamp: Number.isInteger(process?.finishedAt)
      ? process.finishedAt
      : (Number.isInteger(process?.lastActivityAt) ? process.lastActivityAt : null),
    company: typeof rawSnapshot?.company === 'string' && rawSnapshot.company.trim()
      ? rawSnapshot.company.trim()
      : (process?.title || ''),
    hasDecisionRecord: rawSnapshot?.hasDecisionRecord === true || records.length > 0,
    decisionContractStatus: typeof rawSnapshot?.status === 'string' ? rawSnapshot.status : 'invalid',
    decisionContractIssues: Array.isArray(rawSnapshot?.issueCodes) ? rawSnapshot.issueCodes : [],
    decisionRecordCount: Number.isInteger(rawSnapshot?.recordCount) ? rawSnapshot.recordCount : records.length,
    decisionRecordFormats: Array.isArray(rawSnapshot?.recordFormats) ? rawSnapshot.recordFormats : [],
    stage12Records: records
  };
}

// Clipboard copy counters (in-memory per panel tab open).
const panelClipboardCounters = {
  ops: 0,
  opsOk: 0,
  opsFail: 0,
  copiedOk: 0,
  copiedFail: 0
};

function logPanelClipboard(event, extra = {}) {
  // Keep logs ASCII to avoid mojibake in some consoles.
  console.log(`[panel:clipboard] ${event}`, { ...panelClipboardCounters, ...extra });
}

async function copyCompletedResponse(process, button) {
  if (!process || !button) return;

  const originalText = button.dataset.originalText || button.textContent || 'Skopiuj skonczona odpowiedz';
  button.dataset.originalText = originalText;
  button.disabled = true;
  panelClipboardCounters.ops += 1;

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
    panelClipboardCounters.opsOk += 1;
    panelClipboardCounters.copiedOk += 1;
    logPanelClipboard('OK copy_completed', {
      processId: process?.id,
      source: textFromStorage ? 'responses' : 'process_fallback',
      length: text.length
    });
    button.textContent = `\u2713 Skopiowano (${panelClipboardCounters.copiedOk})`;
  } catch (error) {
    panelClipboardCounters.opsFail += 1;
    panelClipboardCounters.copiedFail += 1;
    console.warn('[panel] Nie udalo sie skopiowac skonczonej odpowiedzi:', error?.message || error);
    logPanelClipboard('FAIL copy_completed', { processId: process?.id, error: error?.message || String(error) });
    button.textContent = '\u2717 Brak odpowiedzi';
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
  const companyStageName = normalizedPrompt > 0
    ? stageNamesCompany[normalizedPrompt - 1]
    : '';

  if (rawStageName) {
    const promptMatch = rawStageName.match(/^Prompt\s+(\d+)$/i);
    if (promptMatch && normalizedPrompt > 0) {
      const stagePrompt = Number.parseInt(promptMatch[1], 10);
      if (Number.isInteger(stagePrompt) && stagePrompt !== normalizedPrompt) {
        if (companyStageName) {
          return `${companyStageName} (Prompt ${normalizedPrompt})`;
        }
        return `Prompt ${normalizedPrompt}`;
      }
      if (companyStageName) {
        return `${companyStageName} (Prompt ${normalizedPrompt})`;
      }
    }
    return rawStageName;
  }

  if (normalizedPrompt > 0) {
    if (companyStageName) {
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
  const links = Array.isArray(process?.conversationUrls) ? process.conversationUrls : [];
  for (let index = links.length - 1; index >= 0; index -= 1) {
    const candidate = normalizeUrl(links[index]);
    if (candidate) return candidate;
  }
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

  const tags = document.createElement('div');
  tags.className = 'process-tags';

  const type = document.createElement('div');
  type.className = 'process-type';

  const priority = document.createElement('div');
  priority.className = 'process-priority priority-p4';

  tags.appendChild(type);
  tags.appendChild(priority);
  header.appendChild(title);
  header.appendChild(tags);

  const status = document.createElement('div');
  status.className = 'process-status';

  const statusLine = document.createElement('span');
  statusLine.className = 'status-line';

  const statusBadge = document.createElement('span');
  statusBadge.className = 'status-badge';

  status.appendChild(statusLine);
  status.appendChild(statusBadge);

  const dbDelivery = document.createElement('div');
  dbDelivery.className = 'db-delivery';

  const dbBadge = document.createElement('span');
  dbBadge.className = 'db-badge db-info';
  dbDelivery.appendChild(dbBadge);

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
  card.appendChild(dbDelivery);
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
      priority,
      statusLine,
      statusBadge,
      dbDelivery,
      dbBadge,
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
  const contract = getProcessContract(process);
  const lifecycleStatus = contract.lifecycleStatus;
  const actionRequired = contract.actionRequired;
  const operatorStatusText = getProcessStatusText(process);
  card.__process = process;
  card.id = `process-${process.id}`;

  if (!card.classList.contains('process-card')) {
    card.classList.add('process-card');
  }
  card.classList.toggle('needs-action', actionRequired !== 'none');
  card.classList.toggle('selected', !!isSelected);

  refs.title.textContent = process.title || 'Bez tytulu';
  refs.type.textContent = 'company';
  const priorityModel = getProcessPriorityModel(process);
  refs.priority.textContent = `${priorityModel.code} ${priorityModel.label}`;
  refs.priority.className = `process-priority ${priorityModel.className}`;
  refs.priority.title = `score=${priorityModel.score} | ${priorityModel.summary}`;

  const currentPrompt = Number.isInteger(process.currentPrompt) ? process.currentPrompt : 0;
  const totalPrompts = Number.isInteger(process.totalPrompts) ? process.totalPrompts : 0;
  const progress = getProgressPercent(currentPrompt, totalPrompts);
  const startedAt = Number.isInteger(process.startedAt) ? process.startedAt : null;
  const updatedAt = Number.isInteger(process?.lastActivityAt)
    ? process.lastActivityAt
    : (Number.isInteger(process.timestamp) ? process.timestamp : startedAt);
  const tabLabel = Number.isInteger(process.tabId) ? String(process.tabId) : '-';
  const windowLabel = Number.isInteger(process.windowId) ? String(process.windowId) : '-';

  refs.statusLine.textContent = lifecycleStatus === 'queued'
    ? operatorStatusText
    : (ProcessContractUtils?.buildStageProgressLabel?.(process) || `Prompt ${currentPrompt}/${totalPrompts} (${progress}%)`);

  let statusBadgeText = 'W trakcie';
  let statusBadgeClass = 'status-running';
  if (actionRequired !== 'none') {
    statusBadgeText = 'WYMAGA AKCJI';
    statusBadgeClass = 'status-needs-action';
  } else if (lifecycleStatus === 'queued') {
    statusBadgeText = 'W kolejce';
    statusBadgeClass = 'status-queued';
  } else if (lifecycleStatus === 'finalizing') {
    statusBadgeText = 'Finalizacja';
    statusBadgeClass = 'status-running';
  } else if (isCompletedStatus(lifecycleStatus)) {
    statusBadgeText = 'Zakonczono';
    statusBadgeClass = 'status-completed';
  } else if (isFailedStatus(lifecycleStatus)) {
    statusBadgeText = 'Blad';
    statusBadgeClass = 'status-failed';
  } else if (lifecycleStatus === 'stopped') {
    statusBadgeText = 'Zatrzymano';
    statusBadgeClass = 'status-failed';
  }

  refs.statusBadge.textContent = statusBadgeText;
  refs.statusBadge.className = `status-badge ${statusBadgeClass}`;

  const dbBadgeModel = getDatabaseBadgeModel(process);
  if (dbBadgeModel.visible) {
    refs.dbBadge.textContent = dbBadgeModel.text;
    refs.dbBadge.className = dbBadgeModel.className;
    refs.dbDelivery.style.display = 'block';
  } else {
    refs.dbBadge.textContent = '';
    refs.dbBadge.className = 'db-badge db-info';
    refs.dbDelivery.style.display = 'none';
  }

  refs.progressFill.style.width = `${progress}%`;

  const stageLabel = resolveStageLabel(process);
  refs.stageMeta.textContent = `Etap: ${stageLabel}`;

  const statusLine = operatorStatusText ? shortenText(String(operatorStatusText), 96) : '';
  if (statusLine || updatedAt) {
    const statusChunk = statusLine || 'brak statusu';
    refs.statusMeta.textContent = `${statusChunk} | ${formatRelativeTime(updatedAt)}`;
    refs.statusMeta.style.display = 'block';
  } else {
    refs.statusMeta.textContent = '';
    refs.statusMeta.style.display = 'none';
  }

  refs.timingMeta.textContent = `Start: ${formatClock(startedAt)} | Ostatni: ${formatClock(updatedAt)}`;
  refs.locationMeta.textContent = lifecycleStatus === 'queued' && tabLabel === '-' && windowLabel === '-'
    ? 'Oczekuje na wolny slot'
    : `Tab ${tabLabel} | Okno ${windowLabel}`;

  const reasonText = buildProcessReasonLine(process);

  if (reasonText) {
    refs.reason.textContent = `Uwaga: ${reasonText}`;
    refs.reason.style.display = 'block';
  } else {
    refs.reason.textContent = '';
    refs.reason.style.display = 'none';
  }

  const needsAction = actionRequired !== 'none';
  refs.actions.style.display = needsAction ? 'flex' : 'none';
  if (!needsAction) {
    refs.waitBtn.disabled = false;
    refs.skipBtn.disabled = false;
  }

  if (needsAction) {
    refs.hint.textContent = actionRequired === 'continue_button'
      ? 'Kliknij Continue w ChatGPT albo wybierz akcje.'
      : 'Wybierz akcje lub otworz okno ChatGPT.';
    refs.hint.style.display = 'block';
  } else {
    refs.hint.textContent = '';
    refs.hint.style.display = 'none';
  }
}

function openChatTab(process) {
  const chatUrl = resolveChatUrl(process);
  if (!chatUrl) return false;
  chrome.tabs.create({ url: chatUrl });
  return true;
}

const MAX_ORPHAN_ACTIVE_AGE_MS = 45000;
const STATUS_CACHE_TTL_MS = 2500;
const tabStatusCache = new Map();
const windowStatusCache = new Map();
let updateSequence = 0;

function isProcessClosed(process) {
  if (!process) return true;
  if (ProcessContractUtils && typeof ProcessContractUtils.isClosedLifecycleStatus === 'function') {
    return ProcessContractUtils.isClosedLifecycleStatus(getNormalizedStatus(process));
  }
  const status = getNormalizedStatus(process);
  return status === 'completed' || status === 'failed' || status === 'stopped';
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
    const normalizedStatus = getNormalizedStatus(process);
    const tabId = Number.isInteger(process.tabId) ? process.tabId : null;
    const windowId = Number.isInteger(process.windowId) ? process.windowId : null;

    if (normalizedStatus === 'queued' && !tabId && !windowId) {
      return { process, keep: false, reason: 'queued_waiting' };
    }

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
  analysisQueueSnapshot = options?.queue && typeof options.queue === 'object'
    ? options.queue
    : analysisQueueSnapshot;
  allProcessesCache = items.slice();
  try {
    const active = await filterActiveProcesses(items);
    if (requestId !== updateSequence) return;
    activeProcessesCache = active.slice();
    const activeIds = new Set(active.map((process) => process.id));
    const history = items.filter((process) => !activeIds.has(process.id));
    updateSummaryPanels(items, active, history);
    updateUI(active, options);
    updateHistory(history);
  } catch (error) {
    console.warn('[panel] Nie udalo sie odswiezyc procesow:', error);
    if (requestId !== updateSequence) return;
    activeProcessesCache = items.slice();
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

async function refreshProcesses() {
  const response = await sendRuntimeMessage({ type: 'GET_PROCESSES' });
  if (response?.ok === false) {
    console.warn('[panel] GET_PROCESSES failed:', response.errorMessage || response.errorCode || response.error);
    return [];
  }

  if (Number.isInteger(response?.version)) processSnapshotVersion = response.version;
  if (Number.isInteger(response?.queueVersion)) queueSnapshotVersion = response.queueVersion;
  const processes = Array.isArray(response?.processes) ? response.processes : [];
  await applyProcessesUpdate(processes, { queue: response?.queue || null });
  return processes;
}

async function sendDecision(process, decision) {
  if (!process || !process.id) {
    return false;
  }
  const response = await sendRuntimeMessage({
    type: 'PROCESS_DECISION',
    runId: process.id,
    decision,
    origin: 'panel',
    tabId: Number.isInteger(process.tabId) ? process.tabId : null,
    windowId: Number.isInteger(process.windowId) ? process.windowId : null
  });
  if (response?.ok === false) {
    console.warn('[panel] PROCESS_DECISION failed:', response.errorMessage || response.errorCode || response.error);
    return false;
  }
  return !!response?.success;
}

async function sendDecisionAll(decision) {
  const response = await sendRuntimeMessage({
    type: 'PROCESS_DECISION_ALL',
    decision,
    origin: 'panel'
  });
  if (response?.ok === false) {
    console.warn('[panel] PROCESS_DECISION_ALL failed:', response.errorMessage || response.errorCode || response.error);
    return { success: false, matched: 0, delivered: 0 };
  }

  return {
    success: !!response?.success,
    matched: Number.isInteger(response?.matched) ? response.matched : 0,
    delivered: Number.isInteger(response?.delivered) ? response.delivered : 0
  };
}

async function sendProcessResumeNextStage(process, options = {}) {
  if (!process || !process.id) {
    return { success: false, error: 'missing_process_id' };
  }

  const response = await sendRuntimeMessage({
    type: 'PROCESS_RESUME_NEXT_STAGE',
    runId: process.id,
    tabId: Number.isInteger(process.tabId) ? process.tabId : null,
    windowId: Number.isInteger(process.windowId) ? process.windowId : null,
    chatUrl: resolveChatUrl(process),
    title: process?.title || '',
    openDialogOnly: !!options.openDialogOnly
  });
  if (response?.ok === false) {
    console.warn('[panel] PROCESS_RESUME_NEXT_STAGE failed:', response.errorMessage || response.errorCode || response.error);
    return {
      success: false,
      error: response.errorCode || response.error || 'runtime_error'
    };
  }

  return {
    success: !!response?.success,
    error: typeof response?.error === 'string' ? response.error : '',
    mode: typeof response?.mode === 'string' ? response.mode : '',
    startIndex: Number.isInteger(response?.startIndex) ? response.startIndex : null,
    startPromptNumber: Number.isInteger(response?.startPromptNumber) ? response.startPromptNumber : null,
    detectedPromptNumber: Number.isInteger(response?.detectedPromptNumber) ? response.detectedPromptNumber : null,
    detectedMethod: typeof response?.detectedMethod === 'string' ? response.detectedMethod : '',
    finalStagePersistence: response?.finalStagePersistence && typeof response.finalStagePersistence === 'object'
      ? response.finalStagePersistence
      : null
  };
}

function formatFinalStagePersistenceShort(finalStagePersistence) {
  const sent = Number.isInteger(finalStagePersistence?.sent) ? finalStagePersistence.sent : null;
  const failed = Number.isInteger(finalStagePersistence?.failed) ? finalStagePersistence.failed : null;
  const pending = Number.isInteger(finalStagePersistence?.pending)
    ? finalStagePersistence.pending
    : (
      (Number.isInteger(finalStagePersistence?.deferred) ? finalStagePersistence.deferred : 0)
      + (Number.isInteger(finalStagePersistence?.remaining) ? finalStagePersistence.remaining : 0)
    );
  const hasNumericDispatch = sent !== null || failed !== null || pending !== null;

  if (hasNumericDispatch) {
    const safeSent = sent ?? 0;
    const safeFailed = failed ?? 0;
    const safePending = pending ?? 0;
    const queueSkipped = finalStagePersistence?.queueSkipped === true;
    const flushSkipped = finalStagePersistence?.flushSkipped === true;
    const skipReasonCode = queueSkipped
      ? (typeof finalStagePersistence?.queueSkipReason === 'string' ? finalStagePersistence.queueSkipReason : '')
      : (flushSkipped
        ? (typeof finalStagePersistence?.flushSkipReason === 'string' ? finalStagePersistence.flushSkipReason : '')
        : '');
    const reason = typeof skipReasonCode === 'string' && skipReasonCode.trim()
      ? skipReasonCode.trim()
      : '';
    const failureStage = typeof finalStagePersistence?.failureStage === 'string'
      ? finalStagePersistence.failureStage.trim()
      : '';
    const failureReasonCodeRaw = typeof finalStagePersistence?.failureReason === 'string'
      ? finalStagePersistence.failureReason.trim()
      : '';
    const failureReason = failureReasonCodeRaw || reason;
    const failureStatus = Number.isInteger(finalStagePersistence?.failureStatus)
      ? finalStagePersistence.failureStatus
      : null;
    const failureRequestId = typeof finalStagePersistence?.failureRequestId === 'string'
      ? finalStagePersistence.failureRequestId.trim()
      : '';
    const diagParts = [];
    if (failureStage) diagParts.push(`stage=${failureStage}`);
    if (failureReason) diagParts.push(`reason=${failureReason}`);
    if (failureStatus !== null) diagParts.push(`http=${failureStatus}`);
    if (failureRequestId) diagParts.push(`requestId=${shortenText(failureRequestId, 28)}`);
    const diagText = diagParts.length > 0 ? `, ${diagParts.join(', ')}` : '';

    if (safeSent > 0 && safePending === 0 && safeFailed === 0) {
      return `baza=OK, sent=${safeSent}`;
    }
    if (safeSent > 0 && (safePending > 0 || safeFailed > 0)) {
      const parts = [`baza=partial`, `sent=${safeSent}`];
      if (safePending > 0) parts.push(`pending=${safePending}`);
      if (safeFailed > 0) parts.push(`failed=${safeFailed}`);
      return `${parts.join(', ')}${diagText}`;
    }
    if (safePending > 0 && safeSent === 0 && safeFailed === 0) {
      return `baza=local_only, pending=${safePending}${diagText}`;
    }
    if (
      flushSkipped
      && reason === 'flush_in_progress'
      && finalStagePersistence?.flushFollowUpScheduled === true
    ) {
      return `baza=local_only, wait=active_flush_follow_up${diagText}`;
    }
    if (safeFailed > 0 && safeSent === 0) {
      return `baza=local_only, failed=${safeFailed}${diagText}`;
    }
    return `baza=local_only, sent=0, unconfirmed${diagText}`;
  }

  const dispatchSummary = typeof finalStagePersistence?.dispatchSummary === 'string'
    ? finalStagePersistence.dispatchSummary.trim()
    : '';
  return dispatchSummary || 'baza=local_only';
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
        } else if (response.mode === 'final_stage_persisted') {
          const persistenceText = formatFinalStagePersistenceShort(response?.finalStagePersistence);
          button.textContent = `Final zapisany (${persistenceText})`;
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

function restoreDecisionButtons(waitBtn, skipBtn) {
  if (waitBtn) waitBtn.disabled = false;
  if (skipBtn) skipBtn.disabled = false;
}

function scheduleDecisionButtonRecovery(processId, waitBtn, skipBtn, delayMs = 1800) {
  setTimeout(() => {
    const latest = currentProcesses.find((process) => process.id === processId);
    if (processNeedsAction(latest)) {
      restoreDecisionButtons(waitBtn, skipBtn);
    }
  }, delayMs);
}

function updateUI(processes, options = {}) {
  const sourceItems = Array.isArray(processes) ? processes.slice() : [];
  if (sourceItems.length === 0) {
    processList.innerHTML = '';
    emptyState.style.display = 'block';
    emptyState.textContent = 'Brak aktywnych procesow.';
    selectedProcessId = null;
    currentProcesses = [];
    lastSignature = '';
    processCardMap.clear();
    processSeenAt.clear();
    processConversationAuditCache.clear();
    processConversationAuditInFlight.clear();
    processCompanySnapshotCache.clear();
    processCompanySnapshotInFlight.clear();
    updateViewHint(0, 0);
    renderDetails();
    updateResumeAllButtonState();
    return;
  }

  const filteredItems = applyViewFilters(sourceItems);
  if (filteredItems.length === 0) {
    processList.innerHTML = '';
    emptyState.style.display = 'block';
    emptyState.textContent = 'Brak procesow dla wybranego filtra.';
    selectedProcessId = null;
    currentProcesses = [];
    lastSignature = '';
    for (const [processId, entry] of processCardMap.entries()) {
      entry.card.remove();
      processCardMap.delete(processId);
    }
    updateViewHint(0, sourceItems.length);
    renderDetails();
    updateResumeAllButtonState();
    return;
  }

  emptyState.style.display = 'none';
  emptyState.textContent = 'Brak aktywnych procesow.';

  const itemsWithKey = filteredItems.map((process) => ({
    process,
    sortKey: getProcessSortKey(process),
    priority: getProcessPriorityModel(process)
  }));

  // Sortowanie triage: najwyzszy priorytet -> needs-action -> najnowsze.
  itemsWithKey.sort((a, b) => {
    const byPriority = (b.priority?.score || 0) - (a.priority?.score || 0);
    if (byPriority !== 0) return byPriority;
    const aNeeds = processNeedsAction(a.process);
    const bNeeds = processNeedsAction(b.process);
    if (aNeeds && !bNeeds) return -1;
    if (!aNeeds && bNeeds) return 1;
    const diff = (b.sortKey || 0) - (a.sortKey || 0);
    if (diff !== 0) return diff;
    return String(a.process.id).localeCompare(String(b.process.id));
  });

  const orderedItems = itemsWithKey.map((entry) => entry.process);

  if (!selectedProcessId) {
    selectedProcessId = orderedItems[0].id;
  } else if (!orderedItems.some((process) => process.id === selectedProcessId)) {
    selectedProcessId = orderedItems[0].id;
  }

  const signature = orderedItems
    .map((process) => {
      const stageKey = Number.isInteger(process.stageIndex) ? process.stageIndex : '';
      const stageName = process.stageName || '';
      const statusText = getProcessStatusText(process);
      const reason = process.reason || '';
      const title = process.title || '';
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
      const persistenceStatus = process?.persistenceStatus && typeof process.persistenceStatus === 'object'
        ? process.persistenceStatus
        : null;
      const persistenceDispatchSummary = typeof persistenceStatus?.dispatchSummary === 'string'
        ? persistenceStatus.dispatchSummary
        : '';
      const persistenceSaveOk = typeof persistenceStatus?.saveOk === 'boolean'
        ? String(persistenceStatus.saveOk)
        : '';
      const dbDelivery = resolveProcessDatabaseDelivery(process);
      const dbDeliverySignature = `${dbDelivery.saveOk === null ? 'n/a' : String(dbDelivery.saveOk)}:${dbDelivery.sent}:${dbDelivery.failed}:${dbDelivery.pending}:${dbDelivery.hasNumericDispatch ? 1 : 0}`;
      const persistenceLog = getPersistenceLogLines(process, 4).join('||');
      const sortKey = getProcessSortKey(process);
      return `${process.id}|${sortKey}|${getNormalizedStatus(process)}|${getProcessActionRequired(process)}|${getProcessPhase(process)}|${getProcessStatusCode(process)}|${process.currentPrompt || 0}|${process.totalPrompts || 0}|${stageKey}|${stageName}|${statusText}|${reason}|${title}|${tabId}|${windowId}|${chatUrl}|${sourceUrl}|${autoAttempt}|${autoMax}|${autoReason}|${autoPrompt}|${persistenceSaveOk}|${persistenceDispatchSummary}|${dbDeliverySignature}|${persistenceLog}`;
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
        processConversationAuditCache.delete(processId);
        processConversationAuditInFlight.delete(processId);
        processCompanySnapshotCache.delete(processId);
        processCompanySnapshotInFlight.delete(processId);
      }
    }
  }

  currentProcesses = orderedItems.slice();
  updateViewHint(currentProcesses.length, sourceItems.length);
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
        ? `Historia (${items.length})`
        : 'Historia';
    }
    updateResumeAllButtonState();
    return;
  }

  lastHistorySignature = signature;

  if (historyToggle) {
    historyToggle.textContent = items.length > 0
      ? `Historia (${items.length})`
      : 'Historia';
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
      const closed = isProcessClosed(process);
      if (closed) {
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

    const resumeBtn = document.createElement('button');
    resumeBtn.className = 'history-open history-resume-next';
    resumeBtn.textContent = 'Wznow od kolejnego etapu';
    resumeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      void openResumeStageWithAutoDetect(process, resumeBtn);
    });
    actions.appendChild(resumeBtn);

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
  return source.filter((process) => processNeedsAction(process) && !isProcessClosed(process));
}

function updateResumeAllButtonState() {
  if (!resumeAllBtn) return;

  const needsActionCount = getNeedsActionProcesses().length;
  if (needsActionCount > 0) {
    resumeAllBtn.disabled = false;
    resumeAllBtn.textContent = `Nastepny etap we wszystkich (${needsActionCount})`;
    return;
  }

  resumeAllBtn.disabled = true;
  resumeAllBtn.textContent = 'Nastepny etap we wszystkich';
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
  void sendRuntimeMessage({
    type: 'RESUME_STAGE_OPEN',
    startIndex,
    title: process?.title || ''
  });
  return true;
}

async function openResumeStageWithAutoDetect(process, button = null) {
  if (!process) {
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

  await sendRuntimeMessage({ type: 'ACTIVATE_TAB', reason: 'history-open' });
}

function buildDetailsAuditCard(titleText) {
  const card = document.createElement('section');
  card.className = 'details-audit-card';

  const title = document.createElement('div');
  title.className = 'details-audit-title';
  title.textContent = titleText;

  const body = document.createElement('div');
  body.className = 'details-audit-line';
  body.textContent = 'Ladowanie...';

  card.appendChild(title);
  card.appendChild(body);

  return { card, body };
}

function setAuditBody(body, text, level = '') {
  if (!body) return;
  body.className = 'details-audit-line';
  if (level === 'ok' || level === 'warn' || level === 'err') {
    body.classList.add(level);
  }
  body.textContent = text;
}

function formatDecisionContractStatusLabel(status) {
  if (status === 'current') return 'current';
  if (status === 'shortfall') return 'shortfall';
  if (status === 'legacy') return 'legacy read-only';
  return 'invalid';
}

function formatCompanySnapshotText(snapshot) {
  if (!snapshot) return 'Brak danych o spolce dla wybranego procesu.';
  const lines = [];
  const companyLabel = snapshot.company || 'brak';
  lines.push(`Spolka: ${companyLabel}`);

  if (!snapshot.hasDecisionRecord) {
    lines.push(`Kontrakt Stage 12: ${formatDecisionContractStatusLabel(snapshot.decisionContractStatus)}`);
    if (snapshot.hasCompletedResponse) {
      lines.push('Jest zapisana odpowiedz koncowa, ale nie spelnia aktualnego kontraktu final record.');
    } else {
      lines.push('Brak zapisanej odpowiedzi koncowej dla tego runId.');
    }
    if (Array.isArray(snapshot.decisionContractIssues) && snapshot.decisionContractIssues.length > 0) {
      lines.push(`Uwagi: ${snapshot.decisionContractIssues.join(', ')}`);
    }
    return lines.join('\n');
  }

  lines.push(
    `Kontrakt Stage 12: ${formatDecisionContractStatusLabel(snapshot.decisionContractStatus)} | Rekordy: ${snapshot.decisionRecordCount || 0}`
  );
  if (Array.isArray(snapshot.decisionContractIssues) && snapshot.decisionContractIssues.length > 0) {
    lines.push(`Uwagi: ${snapshot.decisionContractIssues.join(', ')}`);
  }
  const stage12Records = Array.isArray(snapshot.stage12Records) ? snapshot.stage12Records : [];
  if (stage12Records.length === 0) {
    lines.push('Brak rekordow Stage 12 do wyswietlenia.');
    return lines.join('\n');
  }
  stage12Records.forEach((record) => {
    const role = record?.decisionRole || 'RECORD';
    lines.push(`${role}: ${record?.company || companyLabel} | ${record?.decisionStatus || 'brak'} | Composite: ${record?.composite || '-'} | Sizing: ${record?.sizing || '-'}`);
    const voiBits = [record?.voi || '', record?.fals || '', record?.primaryRisk || '']
      .filter((value) => typeof value === 'string' && value.trim());
    if (voiBits.length > 0) {
      lines.push(`VOI/Fals/Risk ${role}: ${voiBits.join(' | ')}`);
    }
    const taxonomy = [record?.sector || '', record?.companyFamily || '', record?.companyType || '', record?.revenueModel || '']
      .filter((value) => typeof value === 'string' && value.trim());
    if (taxonomy.length > 0) {
      lines.push(`Taxonomia ${role}: ${taxonomy.join(' | ')}`);
    }
    const geo = [record?.region || '', record?.currency || '']
      .filter((value) => typeof value === 'string' && value.trim());
    if (geo.length > 0) {
      lines.push(`Region/Waluta ${role}: ${geo.join(' | ')}`);
    }
  });
  if (snapshot.decisionContractStatus === 'shortfall') {
    lines.push('SHORTFALL: only 1 company passed Stage 10 gates');
  }
  return lines.join('\n');
}

function formatConversationAuditText(audit) {
  if (!audit) return 'Brak audytu etapow dla tej karty (niedostepny tabId lub dane wygasly).';

  const coverage = audit.promptCatalogCount > 0
    ? `${audit.recognizedUniquePrompts}/${audit.promptCatalogCount}`
    : `${audit.recognizedUniquePrompts}/0`;
  const lines = [
    `Stan: ${audit.processState || 'n/a'} | Pokrycie etapow: ${coverage}`,
    `Instancje promptow: ${audit.matchedPromptMessages} | Braki odpowiedzi: ${audit.promptRepliesMissing} (${formatPromptList(audit.missingReplyPromptNumbers)})`,
    `Niska jakosc: ${audit.promptRepliesBelowThreshold} (${formatPromptList(audit.lowQualityReplyPromptNumbers)}) | Braki etapow: ${formatPromptList(audit.missingPromptNumbers)}`
  ];

  const stageCheck = audit.stageMappingCheck || {};
  lines.push(
    `Mapowanie prompt->stage: prompts=${stageCheck.promptCount || 0}, stage_names=${stageCheck.stageNameCount || 0}, align=${stageCheck.alignedByCount ? 'TAK' : 'NIE'}`
  );
  if (Array.isArray(stageCheck.missingStageNames) && stageCheck.missingStageNames.length > 0) {
    lines.push(`Brak nazw stage dla: ${formatPromptList(stageCheck.missingStageNames)}`);
  }

  if (audit.dataGapStopDetected) {
    const missingInputsText = audit.dataGapMissingInputsList.length > 0
      ? audit.dataGapMissingInputsList.join(', ')
      : (audit.dataGapMissingInputsText || 'brak');
    lines.push(`DATA_GAPS: TAK | missing_inputs: ${missingInputsText}`);
  } else {
    lines.push('DATA_GAPS: NIE');
  }

  if (Array.isArray(audit.processIssueFlags) && audit.processIssueFlags.length > 0) {
    lines.push(`Issue flags: ${audit.processIssueFlags.join(', ')}`);
  }

  return lines.join('\n');
}

async function hydrateDetailsCards(process, snapshotBody, auditBody) {
  if (!process || !process.id) return;
  const expectedProcessId = String(process.id);

  if (snapshotBody) {
    const cachedSnapshot = getCachedProcessCompanySnapshot(process);
    if (cachedSnapshot) {
      const cachedLevel = cachedSnapshot?.hasDecisionRecord
        && (cachedSnapshot.decisionContractStatus === 'current' || cachedSnapshot.decisionContractStatus === 'shortfall')
        ? 'ok'
        : 'warn';
      setAuditBody(snapshotBody, formatCompanySnapshotText(cachedSnapshot), cachedLevel);
    }
  }

  if (auditBody) {
    const cachedAudit = getCachedProcessAudit(process);
    if (cachedAudit) {
      const cachedLevel = cachedAudit.dataGapStopDetected
        ? 'err'
        : ((cachedAudit.promptRepliesMissing || 0) > 0 || (cachedAudit.promptRepliesBelowThreshold || 0) > 0 ? 'warn' : 'ok');
      setAuditBody(auditBody, formatConversationAuditText(cachedAudit), cachedLevel);
    }
  }

  const [snapshot, audit] = await Promise.all([
    fetchProcessCompanySnapshot(process),
    fetchProcessConversationAudit(process)
  ]);

  if (selectedProcessId !== expectedProcessId) return;

  if (snapshotBody?.isConnected) {
    const snapshotLevel = snapshot?.hasDecisionRecord
      && (snapshot.decisionContractStatus === 'current' || snapshot.decisionContractStatus === 'shortfall')
      ? 'ok'
      : 'warn';
    setAuditBody(snapshotBody, formatCompanySnapshotText(snapshot), snapshotLevel);
  }

  if (auditBody?.isConnected) {
    const auditLevel = audit?.dataGapStopDetected
      ? 'err'
      : ((audit?.promptRepliesMissing || 0) > 0 || (audit?.promptRepliesBelowThreshold || 0) > 0 ? 'warn' : 'ok');
    setAuditBody(auditBody, formatConversationAuditText(audit), auditLevel);
  }
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
      : processNeedsAction(selected)
        ? 'Wymaga akcji'
        : 'W trakcie';
  subtitle.textContent = `Status: ${statusLabel}`;
  titleWrap.appendChild(title);
  titleWrap.appendChild(subtitle);

  const reasonSummary = buildProcessReasonLine(selected);
  if (reasonSummary) {
    const reasonMeta = document.createElement('div');
    reasonMeta.className = 'details-subtitle';
    reasonMeta.textContent = `Uwaga: ${reasonSummary}`;
    titleWrap.appendChild(reasonMeta);
  }

  const metaWrap = document.createElement('div');
  metaWrap.className = 'details-subtitle';
  const detailsProgress = getProgressPercent(selected.currentPrompt, selected.totalPrompts);
  const detailsStage = resolveStageLabel(selected);
  const detailsUpdatedAt = Number.isInteger(selected?.lastActivityAt)
    ? selected.lastActivityAt
    : (Number.isInteger(selected.timestamp) ? selected.timestamp : selected.startedAt);
  metaWrap.textContent = `Etap ${detailsStage} | Prompt ${selected.currentPrompt || 0}/${selected.totalPrompts || 0} (${detailsProgress}%) | ${formatRelativeTime(detailsUpdatedAt)}`;
  const priorityMeta = document.createElement('div');
  priorityMeta.className = 'details-subtitle';
  const priorityModel = getProcessPriorityModel(selected);
  priorityMeta.textContent = `Priorytet: ${priorityModel.code} ${priorityModel.label} (score=${priorityModel.score})`;

  header.appendChild(titleWrap);
  header.appendChild(metaWrap);
  header.appendChild(priorityMeta);

  const dbBadgeModel = getDatabaseBadgeModel(selected);
  if (dbBadgeModel.visible && dbBadgeModel.detailText) {
    const databaseLine = document.createElement('div');
    databaseLine.className = 'details-subtitle';
    databaseLine.textContent = dbBadgeModel.detailText;
    header.appendChild(databaseLine);
  }
  // Keep storage log available in source data but hide raw log noise from the main panel.

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

  const canResumeNextFromDetails = processNeedsAction(selected) || isProcessClosed(selected);
  if (canResumeNextFromDetails) {
    const resumeNextBtn = document.createElement('button');
    resumeNextBtn.className = 'details-open details-resume-next';
    resumeNextBtn.textContent = 'Wznow nastepny etap';
    resumeNextBtn.addEventListener('click', () => {
      void resumeNextStageFromPanel(selected, resumeNextBtn);
    });
    actions.appendChild(resumeNextBtn);
  }

  const copyCompletedBtn = document.createElement('button');
  copyCompletedBtn.className = 'details-copy';
  copyCompletedBtn.textContent = 'Kopiuj final';
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

  const companySnapshotCard = buildDetailsAuditCard('Snapshot decyzji');
  const companyAuditCard = buildDetailsAuditCard('Audit etapow');
  detailsContainer.appendChild(companySnapshotCard.card);
  detailsContainer.appendChild(companyAuditCard.card);
  void hydrateDetailsCards(selected, companySnapshotCard.body, companyAuditCard.body);

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
      const roleLabel = message.role === 'user' ? 'Uzytkownik' : 'Asystent';
      const stageLabel = message.stageName
        ? message.stageName
        : (Number.isInteger(message.stageIndex) ? `Prompt ${message.stageIndex + 1}` : 'Wiadomosc');
      const truncatedLabel = message.truncated ? ' - skrocone' : '';
      summaryLabel.textContent = `${roleLabel} | ${stageLabel}${truncatedLabel}`;

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



