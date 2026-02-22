const CHAT_URL = "https://chatgpt.com/g/g-p-6970fbfa4c348191ba16b549b09ce706/project";
const CHAT_URL_PORTFOLIO = "https://chatgpt.com/g/g-p-6970fbfa4c348191ba16b549b09ce706/project";
const INVEST_GPT_URL_BASE = "https://chatgpt.com/g/g-p-6970fbfa4c348191ba16b549b09ce706-inwestycje";
const INVEST_GPT_URL_PREFIX = `${INVEST_GPT_URL_BASE}/`;
const CHAT_GPT_HOSTS = new Set([
  'chatgpt.com',
  'www.chatgpt.com',
  'chat.openai.com',
  'www.chat.openai.com'
]);
const INVEST_GPT_PATH_BASE = (() => {
  try {
    return new URL(INVEST_GPT_URL_BASE).pathname.replace(/\/+$/, '');
  } catch (error) {
    return '/g/g-p-6970fbfa4c348191ba16b549b09ce706-inwestycje';
  }
})();
const PAUSE_MS = 1000;
const WAIT_FOR_TEXTAREA_MS = 10000; // 10 sekund na znalezienie textarea
const WAIT_FOR_RESPONSE_MS = 14400000; // 240 minut na odpowiedź ChatGPT (zwiększono dla bardzo długich sesji)
const RETRY_INTERVAL_MS = 500;
// Auto start over active process contexts.
const RESET_SCAN_DEFAULT_PASSES = 3;
const RESET_SCAN_PASS_DELAY_MS = 500;
const RESET_SCAN_PER_TAB_BUDGET_MS = 6000;
const RESET_SCAN_MIN_RUNTIME_MS = 90 * 1000;
const RESUME_ALL_SCOPE_ACTIVE_COMPANY_INVEST = 'active_company_invest_processes';
const AUTO_RECOVERY_MAX_ATTEMPTS = 2;
const AUTO_RECOVERY_DELAY_MS = 2000;
const AUTO_RECOVERY_RELOAD_TIMEOUT_MS = 30000;
const AUTO_RECOVERY_REASONS = ['send_failed', 'timeout', 'invalid_response'];
const YT_TRANSCRIPT_PREFERRED_LANGUAGES = ['pl', 'en'];
const YT_TRANSCRIPT_REQUEST_TIMEOUT_MS = 9000;
const YT_TRANSCRIPT_MAX_RETRIES = 3;
const YT_TRANSCRIPT_RETRY_DELAY_MS = 900;
const YT_TRANSCRIPT_MIN_CHARS = 50;
const YT_TRANSCRIPT_CACHE_TTL_MS = 10 * 60 * 1000;
const YT_TRANSCRIPT_CACHE_MAX_ITEMS = 60;
const YT_TRANSCRIPT_INJECT_RETRY_DELAY_MS = 350;
const MANUAL_PDF_CHUNK_SIZE = 512 * 1024;
const MANUAL_PDF_PROVIDER_TIMEOUT_MS = 20000;
const MANUAL_PDF_QUEUE_MAX_CONCURRENCY = 3;

// Intake transport config: prefer local storage, keep sync backup, inline values are optional fallback.
const WATCHLIST_DISPATCH = {
  enabled: true,
  intakeUrl: "https://iskierka-watchlist.duckdns.org/api/v1/intake/economist-response",
  keyId: "extension-primary",
  secret: "233bf044070040d30391b224219635080696bbe1bf4eda74317213f49f01b862",
  // Fallback for networks where outbound 80/443 to server is blocked.
  // Use with: ssh -N -L 18080:127.0.0.1:8080 iskierka
  localTunnelIntakeUrl: "http://127.0.0.1:18080/api/v1/intake/economist-response",
  intakeUrlStorageKey: "watchlist_intake_url",
  intakeUrlSyncStorageKey: "watchlist_intake_url",
  keyIdStorageKey: "watchlist_intake_key_id",
  keyIdSyncStorageKey: "watchlist_intake_key_id",
  secretStorageKey: "watchlist_intake_secret",
  secretSyncStorageKey: "watchlist_intake_secret",
  timeoutMs: 20000,
  retryCount: 3,
  backoffMs: 1500,
  maxBackoffMs: 30 * 60 * 1000,
  outboxStorageKey: "watchlist_dispatch_outbox",
  outboxMaxItems: 5000,
  historyStorageKey: "watchlist_dispatch_history",
  historyMaxItems: 200,
  alarmName: "watchlist-dispatch-flush",
  alarmPeriodMinutes: 2
};

const AUTO_RESTORE_WINDOWS = {
  enabledStorageKey: 'auto_restore_windows_enabled',
  lastCycleStorageKey: 'auto_restore_windows_last_cycle',
  alarmName: 'auto-restore-process-windows',
  alarmPeriodMinutes: 5,
  minAssistantWords: 35,
  minAssistantSentences: 2,
  maxIssueItems: 12
};

const PROCESS_MONITOR_STORAGE_KEY = 'process_monitor_state';
const PROCESS_HISTORY_LIMIT = 30;
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
const processRegistry = new Map();
const ytTranscriptInFlightRequests = new Map();
const ytTranscriptCache = new Map();
const manualPdfProviderPorts = new Map();
let processRegistryReady = null;
let watchlistDispatchFlushInProgress = false;
let watchlistDispatchFlushPending = false;
let watchlistDispatchFlushPendingReason = '';
let watchlistDispatchCredentialsCache = null;
let autoRestoreWindowsInProgress = false;

function extractManualPdfProviderIdFromPort(port) {
  const name = typeof port?.name === 'string' ? port.name.trim() : '';
  const prefix = 'manual-pdf-provider:';
  if (!name || !name.startsWith(prefix)) return '';
  const providerId = name.slice(prefix.length).trim();
  return providerId || '';
}

async function waitForManualPdfProviderPort(providerId, timeoutMs = 5000) {
  const safeProviderId = typeof providerId === 'string' ? providerId.trim() : '';
  if (!safeProviderId) return false;
  if (manualPdfProviderPorts.has(safeProviderId)) return true;
  const startedAt = Date.now();
  const maxWaitMs = Math.max(500, Math.min(15000, Number.isInteger(timeoutMs) ? timeoutMs : 5000));
  while (Date.now() - startedAt < maxWaitMs) {
    if (manualPdfProviderPorts.has(safeProviderId)) return true;
    await sleep(100);
  }
  return manualPdfProviderPorts.has(safeProviderId);
}

function isClosedProcessStatus(status) {
  return CLOSED_PROCESS_STATUSES.has(String(status || '').toLowerCase());
}

function normalizeProcessStatus(status) {
  if (typeof status !== 'string') return 'running';
  const normalized = status.trim().toLowerCase();
  return normalized || 'running';
}

function normalizePromptCounters(status, currentPrompt, totalPrompts, stageIndex) {
  let total = Number.isInteger(totalPrompts) ? totalPrompts : 0;
  let current = Number.isInteger(currentPrompt) ? currentPrompt : 0;
  const stage = Number.isInteger(stageIndex) ? stageIndex : null;

  if (total < 0) total = 0;
  if (current < 0) current = 0;

  if (total === 0 && Number.isInteger(stage) && stage >= 0) {
    total = stage + 1;
  }
  if (current === 0 && Number.isInteger(stage) && stage >= 0) {
    current = stage + 1;
  }
  if (total === 0 && current > 0) {
    total = current;
  }
  if (total > 0 && current > total) {
    current = total;
  }
  if (isClosedProcessStatus(status) && current === 0 && total > 0) {
    current = total;
  }
  if (status === 'completed' && total > 0) {
    current = total;
  }

  return { currentPrompt: current, totalPrompts: total };
}

function normalizeAutoRecoveryState(rawState) {
  if (!rawState || typeof rawState !== 'object') return null;

  const normalized = {};
  if (Number.isInteger(rawState.attempt) && rawState.attempt >= 0) {
    normalized.attempt = rawState.attempt;
  }
  if (Number.isInteger(rawState.maxAttempts) && rawState.maxAttempts > 0) {
    normalized.maxAttempts = rawState.maxAttempts;
  }
  if (Number.isInteger(rawState.delayMs) && rawState.delayMs >= 0) {
    normalized.delayMs = rawState.delayMs;
  }
  if (typeof rawState.reason === 'string' && rawState.reason.trim()) {
    normalized.reason = rawState.reason.trim();
  }
  if (Number.isInteger(rawState.currentPrompt) && rawState.currentPrompt >= 0) {
    normalized.currentPrompt = rawState.currentPrompt;
  }
  if (Number.isInteger(rawState.stageIndex) && rawState.stageIndex >= 0) {
    normalized.stageIndex = rawState.stageIndex;
  }
  if (Number.isInteger(rawState.updatedAt) && rawState.updatedAt > 0) {
    normalized.updatedAt = rawState.updatedAt;
  }

  if (Object.keys(normalized).length === 0) return null;
  if (!Number.isInteger(normalized.maxAttempts)) normalized.maxAttempts = AUTO_RECOVERY_MAX_ATTEMPTS;
  if (!Number.isInteger(normalized.delayMs)) normalized.delayMs = AUTO_RECOVERY_DELAY_MS;
  if (!Number.isInteger(normalized.attempt)) normalized.attempt = 0;
  return normalized;
}

function isFailedProcessStatus(status) {
  const normalized = normalizeProcessStatus(status);
  return normalized === 'failed' || normalized === 'error';
}

function collectProcessRecordAnomalies(record) {
  if (!record || typeof record !== 'object') return [];
  const anomalies = [];
  const status = normalizeProcessStatus(record.status);
  const currentPrompt = Number.isInteger(record.currentPrompt) ? record.currentPrompt : null;
  const totalPrompts = Number.isInteger(record.totalPrompts) ? record.totalPrompts : null;
  const hasTabOrWindow = Number.isInteger(record.tabId) || Number.isInteger(record.windowId);

  if (Number.isInteger(currentPrompt) && Number.isInteger(totalPrompts) && currentPrompt > totalPrompts) {
    anomalies.push('current_gt_total');
  }
  if (isClosedProcessStatus(status) && record.needsAction) {
    anomalies.push('closed_with_needs_action');
  }
  if (!isClosedProcessStatus(status) && !hasTabOrWindow) {
    anomalies.push('running_without_tab_or_window');
  }
  if (isFailedProcessStatus(status) && !record.reason && !record.error) {
    anomalies.push('failed_without_reason');
  }
  return anomalies;
}

function collectNormalizationCorrections(next, patch) {
  const corrections = [];
  if (!next || !patch || typeof patch !== 'object') return corrections;

  if (Number.isInteger(patch.currentPrompt) && patch.currentPrompt !== next.currentPrompt) {
    corrections.push(`currentPrompt:${patch.currentPrompt}->${next.currentPrompt}`);
  }
  if (Number.isInteger(patch.totalPrompts) && patch.totalPrompts !== next.totalPrompts) {
    corrections.push(`totalPrompts:${patch.totalPrompts}->${next.totalPrompts}`);
  }
  if (typeof patch.needsAction === 'boolean' && patch.needsAction !== next.needsAction) {
    corrections.push(`needsAction:${patch.needsAction}->${next.needsAction}`);
  }
  if (Number.isInteger(patch.stageIndex)) {
    const normalizedStage = Number.isInteger(next.stageIndex) ? next.stageIndex : null;
    if (patch.stageIndex !== normalizedStage) {
      corrections.push(`stageIndex:${patch.stageIndex}->${normalizedStage}`);
    }
  }
  if (typeof patch.status === 'string') {
    const patchStatus = normalizeProcessStatus(patch.status);
    if (patchStatus !== next.status) {
      corrections.push(`status:${patchStatus}->${next.status}`);
    }
  }
  return corrections;
}

function logProcessTransition(runId, next, patch) {
  const anomalies = collectProcessRecordAnomalies(next);
  const corrections = collectNormalizationCorrections(next, patch);
  if (anomalies.length === 0 && corrections.length === 0) return;

  console.warn('[monitor] Skorygowano niespojne dane procesu', {
    runId,
    corrections,
    anomalies,
    status: next.status,
    currentPrompt: next.currentPrompt,
    totalPrompts: next.totalPrompts,
    stageIndex: Number.isInteger(next.stageIndex) ? next.stageIndex : null
  });
}

function normalizeProcessRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const id = typeof record.id === 'string' ? record.id : String(record.id || '');
  if (!id) return null;

  const status = normalizeProcessStatus(record.status);
  const normalizedCounters = normalizePromptCounters(
    status,
    record.currentPrompt,
    record.totalPrompts,
    record.stageIndex
  );

  const normalized = {
    ...record,
    id,
    title: typeof record.title === 'string' && record.title.trim()
      ? record.title
      : 'Bez tytulu',
    analysisType: typeof record.analysisType === 'string' && record.analysisType.trim()
      ? record.analysisType
      : 'company',
    status,
    currentPrompt: normalizedCounters.currentPrompt,
    totalPrompts: normalizedCounters.totalPrompts,
    timestamp: Number.isInteger(record.timestamp) ? record.timestamp : Date.now(),
    startedAt: Number.isInteger(record.startedAt)
      ? record.startedAt
      : (Number.isInteger(record.timestamp) ? record.timestamp : Date.now()),
    needsAction: isClosedProcessStatus(status) ? false : !!record.needsAction,
    messages: Array.isArray(record.messages) ? record.messages : []
  };

  if (!Number.isInteger(normalized.windowId)) delete normalized.windowId;
  if (!Number.isInteger(normalized.tabId)) delete normalized.tabId;
  if (typeof normalized.reason !== 'string') delete normalized.reason;
  if (typeof normalized.statusText !== 'string') delete normalized.statusText;
  if (typeof normalized.stageName !== 'string') delete normalized.stageName;
  if (!Number.isInteger(normalized.stageIndex)) delete normalized.stageIndex;
  if (typeof normalized.chatUrl !== 'string') delete normalized.chatUrl;
  if (typeof normalized.sourceUrl !== 'string') delete normalized.sourceUrl;
  if (typeof normalized.error !== 'string') delete normalized.error;
  if (!Number.isInteger(normalized.finishedAt)) delete normalized.finishedAt;
  if (Number.isInteger(normalized.stageIndex) && normalized.totalPrompts > 0) {
    if (normalized.stageIndex < 0) {
      delete normalized.stageIndex;
    } else if (normalized.stageIndex >= normalized.totalPrompts) {
      normalized.stageIndex = normalized.totalPrompts - 1;
    }
  }
  if (normalized.totalPrompts > 0 && normalized.currentPrompt === 0 && Number.isInteger(normalized.stageIndex)) {
    normalized.currentPrompt = Math.min(normalized.stageIndex + 1, normalized.totalPrompts);
  }
  if (normalized.totalPrompts > 0 && normalized.currentPrompt > normalized.totalPrompts) {
    normalized.currentPrompt = normalized.totalPrompts;
  }
  if (normalized.currentPrompt < 0) {
    normalized.currentPrompt = 0;
  }
  if (normalized.startedAt > normalized.timestamp) {
    normalized.startedAt = normalized.timestamp;
  }
  if (Number.isInteger(normalized.finishedAt) && normalized.finishedAt < normalized.startedAt) {
    normalized.finishedAt = normalized.timestamp;
  }
  if (isClosedProcessStatus(status)) {
    delete normalized.autoRecovery;
  } else {
    const normalizedAutoRecovery = normalizeAutoRecoveryState(normalized.autoRecovery);
    if (normalizedAutoRecovery) {
      normalized.autoRecovery = normalizedAutoRecovery;
    } else {
      delete normalized.autoRecovery;
    }
  }

  return normalized;
}

function pruneProcessRecords(records) {
  const normalized = (Array.isArray(records) ? records : [])
    .map(normalizeProcessRecord)
    .filter(Boolean);

  const byId = new Map();
  normalized.forEach((record) => {
    const existing = byId.get(record.id);
    if (!existing) {
      byId.set(record.id, record);
      return;
    }
    const existingTs = Number.isInteger(existing.timestamp) ? existing.timestamp : 0;
    const nextTs = Number.isInteger(record.timestamp) ? record.timestamp : 0;
    if (nextTs >= existingTs) {
      byId.set(record.id, record);
    }
  });

  const deduped = Array.from(byId.values());
  const active = [];
  const closed = [];
  for (const process of deduped) {
    if (isClosedProcessStatus(process.status)) {
      closed.push(process);
    } else {
      active.push(process);
    }
  }

  active.sort((a, b) => (b.startedAt || b.timestamp || 0) - (a.startedAt || a.timestamp || 0));
  closed.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  return active.concat(closed.slice(0, PROCESS_HISTORY_LIMIT));
}

async function ensureProcessRegistryReady() {
  if (!processRegistryReady) {
    processRegistryReady = (async () => {
      try {
        const stored = await chrome.storage.local.get([PROCESS_MONITOR_STORAGE_KEY]);
        const records = pruneProcessRecords(stored?.[PROCESS_MONITOR_STORAGE_KEY]);
        processRegistry.clear();
        records.forEach((record) => {
          processRegistry.set(record.id, record);
        });
      } catch (error) {
        console.warn('[monitor] Failed to read process monitor state:', error);
        processRegistry.clear();
      }
    })();
  }
  return processRegistryReady;
}

async function persistProcessRegistry() {
  const records = pruneProcessRecords(Array.from(processRegistry.values()));
  processRegistry.clear();
  records.forEach((record) => {
    processRegistry.set(record.id, record);
  });
  await chrome.storage.local.set({ [PROCESS_MONITOR_STORAGE_KEY]: records });
  return records;
}

async function getProcessSnapshot() {
  await ensureProcessRegistryReady();
  return pruneProcessRecords(Array.from(processRegistry.values()));
}

async function broadcastProcessUpdate() {
  const processes = await getProcessSnapshot();
  try {
    await chrome.runtime.sendMessage({
      type: 'PROCESSES_UPDATE',
      processes
    });
  } catch (error) {
    // Ignore: no listeners currently connected.
  }
  return processes;
}

async function upsertProcess(runId, patch = {}) {
  if (!runId) return null;
  await ensureProcessRegistryReady();
  const patchData = (patch && typeof patch === 'object')
    ? { ...patch }
    : {};

  const existing = processRegistry.get(runId) || {
    id: runId,
    title: 'Bez tytulu',
    analysisType: 'company',
    status: 'starting',
    currentPrompt: 0,
    totalPrompts: 0,
    startedAt: Date.now(),
    timestamp: Date.now(),
    needsAction: false,
    messages: []
  };

  const existingStatus = normalizeProcessStatus(existing.status);
  if (existingStatus === 'stopped' && !patchData.forceStatusOverride) {
    const requestedStatus = typeof patchData.status === 'string'
      ? normalizeProcessStatus(patchData.status)
      : '';
    if (!requestedStatus || requestedStatus !== 'stopped') {
      patchData.status = 'stopped';
    }
    patchData.needsAction = false;
    if (!patchData.reason && typeof existing.reason === 'string') {
      patchData.reason = existing.reason;
    }
    if (!patchData.statusText && typeof existing.statusText === 'string') {
      patchData.statusText = existing.statusText;
    }
  }
  delete patchData.forceStatusOverride;

  const next = normalizeProcessRecord({
    ...existing,
    ...patchData,
    id: runId,
    startedAt: existing.startedAt || Date.now(),
    timestamp: Number.isInteger(patchData.timestamp) ? patchData.timestamp : Date.now()
  });

  if (!next) return null;
  processRegistry.set(runId, next);
  logProcessTransition(runId, next, patchData);
  await persistProcessRegistry();
  await broadcastProcessUpdate();
  return next;
}

async function findProcessIdByTabId(tabId) {
  if (!Number.isInteger(tabId)) return null;
  await ensureProcessRegistryReady();

  for (const process of processRegistry.values()) {
    if (process.tabId === tabId && !isClosedProcessStatus(process.status)) {
      return process.id;
    }
  }
  for (const process of processRegistry.values()) {
    if (process.tabId === tabId) {
      return process.id;
    }
  }
  return null;
}

async function resolveProcessId(message, sender) {
  if (typeof message?.runId === 'string' && message.runId.trim()) {
    return message.runId;
  }
  const messageTabId = Number.isInteger(message?.tabId) ? message.tabId : null;
  const senderTabId = Number.isInteger(sender?.tab?.id) ? sender.tab.id : null;
  const tabId = messageTabId ?? senderTabId;
  return findProcessIdByTabId(tabId);
}

async function hasActiveProcessForTab(tabId) {
  if (!Number.isInteger(tabId)) return false;
  const process = await getActiveProcessForTab(tabId);
  return !!process;
}

async function getActiveProcessForTab(tabId) {
  if (!Number.isInteger(tabId)) return null;
  await ensureProcessRegistryReady();
  let latest = null;
  let latestTs = -1;
  for (const process of processRegistry.values()) {
    if (!process || process.tabId !== tabId) continue;
    if (isClosedProcessStatus(process.status)) continue;
    const ts = Number.isInteger(process.timestamp)
      ? process.timestamp
      : (Number.isInteger(process.startedAt) ? process.startedAt : 0);
    if (ts >= latestTs) {
      latestTs = ts;
      latest = process;
    }
  }
  return latest;
}

function removeWindowSafe(windowId) {
  return new Promise((resolve) => {
    if (!Number.isInteger(windowId)) {
      resolve(false);
      return;
    }
    try {
      chrome.windows.remove(windowId, () => {
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

function removeTabSafe(tabId) {
  return new Promise((resolve) => {
    if (!Number.isInteger(tabId)) {
      resolve(false);
      return;
    }
    try {
      chrome.tabs.remove(tabId, () => {
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

function getTabGroupIdNone() {
  return Number.isInteger(chrome?.tabGroups?.TAB_GROUP_ID_NONE)
    ? chrome.tabGroups.TAB_GROUP_ID_NONE
    : -1;
}

async function ungroupTabsById(tabIds, options = {}) {
  const requestedTabIds = Array.from(
    new Set(
      (Array.isArray(tabIds) ? tabIds : [tabIds])
        .map((value) => (Number.isInteger(value) ? value : null))
        .filter((value) => value !== null)
    )
  );

  const baseResult = {
    ok: false,
    reason: 'unknown',
    requested: requestedTabIds.length,
    groupedCount: 0,
    ungroupedCount: 0,
    skippedCount: 0,
    error: '',
    requestedTabIds,
    groupedTabIds: [],
    origin: typeof options?.origin === 'string' ? options.origin : ''
  };

  if (requestedTabIds.length === 0) {
    return {
      ...baseResult,
      reason: 'no_tab_ids',
      ok: true,
      skippedCount: 0
    };
  }

  if (!chrome?.tabs?.ungroup) {
    return {
      ...baseResult,
      reason: 'ungroup_api_unavailable',
      error: 'chrome.tabs.ungroup is not available'
    };
  }

  const noneGroupId = getTabGroupIdNone();
  const tabLookups = await Promise.all(requestedTabIds.map((tabId) => getTabByIdSafe(tabId)));
  const groupedTabIds = tabLookups
    .map((tab) => (Number.isInteger(tab?.id) && Number.isInteger(tab?.groupId) && tab.groupId !== noneGroupId ? tab.id : null))
    .filter((tabId) => Number.isInteger(tabId));
  const uniqueGroupedTabIds = Array.from(new Set(groupedTabIds));

  if (uniqueGroupedTabIds.length === 0) {
    return {
      ...baseResult,
      reason: 'already_ungrouped',
      ok: true,
      groupedCount: 0,
      ungroupedCount: 0,
      skippedCount: requestedTabIds.length,
      groupedTabIds: []
    };
  }

  const ungroupResult = await new Promise((resolve) => {
    try {
      chrome.tabs.ungroup(uniqueGroupedTabIds, () => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            reason: 'ungroup_runtime_error',
            error: chrome.runtime.lastError.message || 'ungroup_runtime_error'
          });
          return;
        }
        resolve({
          ok: true,
          reason: 'ungrouped',
          error: ''
        });
      });
    } catch (error) {
      resolve({
        ok: false,
        reason: 'ungroup_exception',
        error: error?.message || String(error)
      });
    }
  });

  return {
    ...baseResult,
    ...ungroupResult,
    groupedCount: uniqueGroupedTabIds.length,
    ungroupedCount: ungroupResult.ok ? uniqueGroupedTabIds.length : 0,
    skippedCount: requestedTabIds.length - uniqueGroupedTabIds.length,
    groupedTabIds: uniqueGroupedTabIds
  };
}

async function ungroupChatGptTabsInWindow(windowId, options = {}) {
  const origin = typeof options?.origin === 'string' ? options.origin : '';
  if (!Number.isInteger(windowId)) {
    return {
      ok: false,
      reason: 'invalid_window_id',
      windowId: null,
      requested: 0,
      groupedCount: 0,
      ungroupedCount: 0,
      skippedCount: 0,
      error: '',
      origin
    };
  }

  const queryResult = await queryTabsInWindowSafe(windowId);
  if (!queryResult.ok) {
    return {
      ok: false,
      reason: queryResult.reason || 'query_tabs_failed',
      windowId,
      requested: 0,
      groupedCount: 0,
      ungroupedCount: 0,
      skippedCount: 0,
      error: queryResult.reason || '',
      origin
    };
  }

  const tabs = Array.isArray(queryResult.tabs) ? queryResult.tabs : [];
  const chatTabIds = tabs
    .filter((tab) => isChatGptUrl(getTabEffectiveUrl(tab)))
    .map((tab) => (Number.isInteger(tab?.id) ? tab.id : null))
    .filter((tabId) => Number.isInteger(tabId));

  if (chatTabIds.length === 0) {
    return {
      ok: true,
      reason: 'no_chat_tabs',
      windowId,
      requested: 0,
      groupedCount: 0,
      ungroupedCount: 0,
      skippedCount: 0,
      error: '',
      origin
    };
  }

  const ungroupResult = await ungroupTabsById(chatTabIds, { origin });
  return {
    ...ungroupResult,
    windowId,
    requested: chatTabIds.length,
    reason: ungroupResult.reason || 'ungroup_result_missing_reason',
    origin
  };
}

function matchesWindowScope(process, windowId) {
  if (!Number.isInteger(windowId)) return true;
  if (!process || typeof process !== 'object') return false;
  return (
    process.windowId === windowId ||
    process.invocationWindowId === windowId ||
    process.sourceWindowId === windowId
  );
}

function requestProcessForceStopOnTab(tabId, payload = {}, timeoutMs = 1200) {
  return new Promise((resolve) => {
    if (!Number.isInteger(tabId)) {
      resolve({
        sent: false,
        acknowledged: false,
        reason: 'invalid_tab_id'
      });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        sent: false,
        acknowledged: false,
        reason: 'timeout'
      });
    }, Math.max(200, timeoutMs));

    try {
      const forceStopMessage = {
        type: 'PROCESS_FORCE_STOP',
        reason: typeof payload.reason === 'string' ? payload.reason : 'manual_stop',
        origin: typeof payload.origin === 'string' ? payload.origin : 'background'
      };
      if (typeof payload.runId === 'string' && payload.runId.trim()) {
        forceStopMessage.runId = payload.runId.trim();
      }

      chrome.tabs.sendMessage(
        tabId,
        forceStopMessage,
        (response) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            finish({
              sent: false,
              acknowledged: false,
              reason: chrome.runtime.lastError.message || 'runtime_error'
            });
            return;
          }

          const acknowledged = !!(
            response?.acknowledged ||
            response?.success ||
            response?.stopped
          );

          finish({
            sent: true,
            acknowledged,
            reason: acknowledged ? 'ack' : 'no_ack'
          });
        }
      );
    } catch (error) {
      clearTimeout(timer);
      finish({
        sent: false,
        acknowledged: false,
        reason: error?.message || String(error)
      });
    }
  });
}

function extractResponseIdFromCopyTrace(copyTrace, expectedRunId = '') {
  if (typeof copyTrace !== 'string' || !copyTrace.trim()) return '';
  const trimmed = copyTrace.trim();
  const separator = trimmed.lastIndexOf('/');
  if (separator < 0 || separator >= trimmed.length - 1) return '';
  const runPart = trimmed.slice(0, separator).trim();
  const responsePart = trimmed.slice(separator + 1).trim();
  if (!responsePart || responsePart === 'no-response') return '';
  if (typeof expectedRunId === 'string' && expectedRunId.trim() && runPart && runPart !== expectedRunId.trim()) {
    return '';
  }
  return responsePart;
}

function buildRestartReplayResponseId(runId = '', responseText = '', promptNumber = 0) {
  const safeRunId = typeof runId === 'string' && runId.trim()
    ? runId.trim().replace(/[^a-zA-Z0-9._-]/g, '_')
    : 'run';
  const safePromptNumber = Number.isInteger(promptNumber) && promptNumber > 0 ? promptNumber : 0;
  const fp = textFingerprint(responseText || '');
  return `${safeRunId}_restart_p${safePromptNumber}_${fp}`;
}

function extractAssistantTextFromProcess(process) {
  if (!process || typeof process !== 'object') return '';
  if (typeof process.completedResponseText === 'string' && process.completedResponseText.trim()) {
    return process.completedResponseText.trim();
  }
  const messages = Array.isArray(process.messages) ? process.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== 'assistant') continue;
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (text) return text;
  }
  return '';
}

async function extractLastAssistantResponseFromTab(tabId, maxWaitMs = 1800) {
  if (!Number.isInteger(tabId)) return '';
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      function: async (waitMs) => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const compact = (text) => (text || '').replace(/\s+/g, ' ').trim();

        function extractTextFromNode(node) {
          if (!node) return '';
          const clone = node.cloneNode(true);
          const removableSelectors = [
            '[data-testid="copy-turn-action-button"]',
            '[data-testid="message-actions"]',
            'button',
            'svg',
            'aside',
            'nav',
            'footer'
          ];
          removableSelectors.forEach((selector) => {
            clone.querySelectorAll(selector).forEach((child) => child.remove());
          });
          return compact(clone.innerText || clone.textContent || '');
        }

        function readAssistantText() {
          const byRole = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
          for (let i = byRole.length - 1; i >= 0; i -= 1) {
            const text = extractTextFromNode(byRole[i]);
            if (text) return text;
          }
          const conversationTurns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn-"]'));
          for (let i = conversationTurns.length - 1; i >= 0; i -= 1) {
            const turn = conversationTurns[i];
            const candidate = turn.querySelector('[data-message-author-role="assistant"]') || turn;
            const text = extractTextFromNode(candidate);
            if (text) return text;
          }
          const articles = Array.from(document.querySelectorAll('article'));
          for (let i = articles.length - 1; i >= 0; i -= 1) {
            const text = extractTextFromNode(articles[i]);
            if (text) return text;
          }
          return '';
        }

        const startedAt = Date.now();
        let best = '';
        while ((Date.now() - startedAt) <= waitMs) {
          const candidate = readAssistantText();
          if (candidate.length > best.length) {
            best = candidate;
          }
          if (best.length >= 50) break;
          await sleep(220);
        }
        return best;
      },
      args: [Math.max(500, Math.min(maxWaitMs, 12000))]
    });
    const text = typeof results?.[0]?.result === 'string' ? results[0].result.trim() : '';
    return text;
  } catch (error) {
    return '';
  }
}

async function replayCompletedResponseForProcess(process, options = {}) {
  if (!process || typeof process !== 'object') {
    return { attempted: false, success: false, reason: 'invalid_process' };
  }

  const currentPrompt = Number.isInteger(process.currentPrompt) ? process.currentPrompt : 0;
  const totalPrompts = Number.isInteger(process.totalPrompts) ? process.totalPrompts : 0;
  const statusText = typeof process.statusText === 'string' ? process.statusText.toLowerCase() : '';
  const hasCompletedPayload = typeof process.completedResponseText === 'string' && process.completedResponseText.trim().length > 0;
  const likelyFinalStage = hasCompletedPayload
    || (Number.isInteger(process.completedResponseLength) && process.completedResponseLength > 0)
    || (totalPrompts > 0 && currentPrompt >= totalPrompts)
    || statusText.includes('trwa zapis do bazy')
    || statusText.includes('zakonczony');
  if (!likelyFinalStage && options?.force !== true) {
    return { attempted: false, success: false, reason: 'not_final_stage' };
  }

  const alreadySaved = process?.completedResponseSaved === true || process?.persistenceStatus?.saveOk === true;
  if (alreadySaved && options?.force !== true) {
    return { attempted: false, success: true, reason: 'already_saved' };
  }

  const runId = typeof process.id === 'string' ? process.id : '';
  const analysisType = typeof process.analysisType === 'string' && process.analysisType.trim()
    ? process.analysisType.trim()
    : 'company';
  const source = typeof process.title === 'string' && process.title.trim()
    ? process.title.trim()
    : 'Restart replay';

  let responseText = extractAssistantTextFromProcess(process);
  if (!responseText && Number.isInteger(options?.tabId)) {
    responseText = await extractLastAssistantResponseFromTab(options.tabId, options?.tabReadTimeoutMs || 1800);
  }
  if (!responseText) {
    return { attempted: false, success: false, reason: 'missing_response_text' };
  }

  const existingTrace = typeof process.completedResponseSaveTrace === 'string' && process.completedResponseSaveTrace.trim()
    ? process.completedResponseSaveTrace.trim()
    : (typeof process?.persistenceStatus?.copyTrace === 'string' ? process.persistenceStatus.copyTrace.trim() : '');
  const responseIdFromTrace = extractResponseIdFromCopyTrace(existingTrace, runId);
  const promptNumber = Number.isInteger(process.currentPrompt) && process.currentPrompt > 0
    ? process.currentPrompt
    : (Number.isInteger(process.stageIndex) && process.stageIndex >= 0 ? (process.stageIndex + 1) : 0);
  const responseId = responseIdFromTrace || buildRestartReplayResponseId(runId, responseText, promptNumber);

  const stageMeta = {};
  if (promptNumber > 0) {
    stageMeta.selected_response_prompt = promptNumber;
  }
  if (Number.isInteger(process.stageIndex) && process.stageIndex >= 0) {
    stageMeta.selected_response_stage_index = process.stageIndex;
  } else if (promptNumber > 0) {
    stageMeta.selected_response_stage_index = promptNumber - 1;
  }
  stageMeta.selected_response_reason = 'restart_replay';

  const conversationUrl = normalizeChatConversationUrl(process.chatUrl)
    || normalizeChatConversationUrl(process.sourceUrl)
    || null;

  const saveResult = await saveResponse(
    responseText,
    source,
    analysisType,
    runId || null,
    responseId,
    stageMeta,
    conversationUrl
  );

  if (!saveResult?.success) {
    return {
      attempted: true,
      success: false,
      reason: 'save_response_failed',
      responseId,
      responseLength: responseText.length
    };
  }

  const dispatchSummary = formatDispatchUiSummary(saveResult.dispatch);
  return {
    attempted: true,
    success: true,
    reason: 'saved',
    responseId,
    responseLength: responseText.length,
    copyTrace: typeof saveResult.copyTrace === 'string' ? saveResult.copyTrace : '',
    dispatch: saveResult.dispatch && typeof saveResult.dispatch === 'object'
      ? saveResult.dispatch
      : null,
    dispatchSummary
  };
}

async function stopSingleProcess(process, options = {}) {
  if (!process || isClosedProcessStatus(process.status)) return false;

  const runId = process.id;
  if (!runId) return false;

  const reason = typeof options.reason === 'string' && options.reason.trim()
    ? options.reason.trim()
    : 'manual_stop';
  const statusText = typeof options.statusText === 'string' && options.statusText.trim()
    ? options.statusText.trim()
    : 'Przerwano przez uzytkownika';
  const now = Date.now();

  const preserveWindowId = Number.isInteger(options.preserveWindowId)
    ? options.preserveWindowId
    : null;
  const processWindowId = Number.isInteger(process.windowId) ? process.windowId : null;
  const processTabId = Number.isInteger(process.tabId) ? process.tabId : null;
  const replayOnRestart = options?.replayLatestResponse === true
    || reason === 'restarted_in_same_window';
  let replayResult = null;

  if (reason === 'restarted_in_same_window' && processTabId !== null) {
    const restartUngroup = await ungroupTabsById([processTabId], {
      origin: 'restart-stop-single-process'
    });
    if (!restartUngroup.ok && restartUngroup.reason !== 'already_ungrouped') {
      console.warn('[restart] ungroup process tab failed:', {
        runId,
        tabId: processTabId,
        reason: restartUngroup.reason,
        error: restartUngroup.error || ''
      });
    }
  }

  if (replayOnRestart) {
    replayResult = await replayCompletedResponseForProcess(process, {
      force: options?.forceReplayLatestResponse === true || reason === 'restarted_in_same_window',
      tabId: processTabId,
      tabReadTimeoutMs: 1800
    });
    console.log('[restart] replay-last-response', {
      runId,
      attempted: replayResult?.attempted === true,
      success: replayResult?.success === true,
      reason: replayResult?.reason || '',
      responseId: replayResult?.responseId || '',
      copyTrace: replayResult?.copyTrace || ''
    });
  }

  if (processTabId !== null) {
    await requestProcessForceStopOnTab(processTabId, {
      runId,
      reason,
      origin: options.origin || 'background'
    });
  }

  let tabClosed = false;
  if (processTabId !== null) {
    tabClosed = await removeTabSafe(processTabId);
  }

  // Fallback: close the whole window only when it is a dedicated process window
  // with no extra tabs (to avoid closing source/info windows).
  if (!tabClosed && processWindowId !== null && processWindowId !== preserveWindowId) {
    const tabsInWindow = await queryTabsInWindowSafe(processWindowId);
    const validTabs = Array.isArray(tabsInWindow?.tabs)
      ? tabsInWindow.tabs.filter((tab) => Number.isInteger(tab?.id))
      : [];
    const hasOnlyProcessTab = validTabs.length === 1
      && processTabId !== null
      && validTabs[0].id === processTabId;
    if (hasOnlyProcessTab) {
      await removeWindowSafe(processWindowId);
    }
  }

  const stopPatch = {
    status: 'stopped',
    statusText,
    reason,
    needsAction: false,
    finishedAt: now,
    timestamp: now
  };

  if (replayResult?.attempted) {
    stopPatch.restartReplay = {
      attempted: true,
      success: replayResult?.success === true,
      reason: replayResult?.reason || '',
      responseId: replayResult?.responseId || '',
      copyTrace: replayResult?.copyTrace || '',
      updatedAt: now
    };
  }

  if (replayResult?.attempted && replayResult?.success) {
    stopPatch.completedResponseSaved = true;
    if (typeof replayResult.copyTrace === 'string' && replayResult.copyTrace.trim()) {
      stopPatch.completedResponseSaveTrace = replayResult.copyTrace.trim();
    }
    if (replayResult.dispatch && typeof replayResult.dispatch === 'object') {
      stopPatch.completedResponseDispatch = replayResult.dispatch;
      stopPatch.completedResponseDispatchSummary = replayResult.dispatchSummary || formatDispatchUiSummary(replayResult.dispatch);
    }
    const previousStatus = process?.persistenceStatus && typeof process.persistenceStatus === 'object'
      ? process.persistenceStatus
      : {};
    stopPatch.persistenceStatus = {
      ...previousStatus,
      hasResponse: true,
      saveOk: true,
      dispatchSummary: replayResult.dispatchSummary || formatDispatchUiSummary(replayResult.dispatch),
      copyTrace: replayResult.copyTrace || '',
      saveError: '',
      dispatch: replayResult.dispatch || null,
      updatedAt: now
    };
  }

  await upsertProcess(runId, stopPatch);

  return true;
}

async function stopActiveProcesses(options = {}) {
  await ensureProcessRegistryReady();
  const targetWindowId = Number.isInteger(options.windowId) ? options.windowId : null;
  const preserveWindowId = Number.isInteger(options.preserveWindowId) ? options.preserveWindowId : null;

  const candidates = Array.from(processRegistry.values()).filter((process) => {
    if (!process || isClosedProcessStatus(process.status)) return false;
    return matchesWindowScope(process, targetWindowId);
  });

  let stopped = 0;
  for (const process of candidates) {
    const didStop = await stopSingleProcess(process, {
      reason: options.reason,
      statusText: options.statusText,
      origin: options.origin,
      preserveWindowId,
      replayLatestResponse: options?.replayLatestResponse === true,
      forceReplayLatestResponse: options?.forceReplayLatestResponse === true
    });
    if (didStop) stopped += 1;
  }

  return {
    matched: candidates.length,
    stopped,
    windowId: targetWindowId
  };
}

function queryTabsInWindowSafe(windowId) {
  return new Promise((resolve) => {
    if (!Number.isInteger(windowId)) {
      resolve({ ok: false, tabs: [], reason: 'invalid_window_id' });
      return;
    }

    try {
      chrome.tabs.query({ windowId }, (tabs) => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            tabs: [],
            reason: chrome.runtime.lastError.message || 'runtime_error'
          });
          return;
        }
        resolve({
          ok: true,
          tabs: Array.isArray(tabs) ? tabs : [],
          reason: ''
        });
      });
    } catch (error) {
      resolve({
        ok: false,
        tabs: [],
        reason: error?.message || String(error)
      });
    }
  });
}

async function forceReloadWindowTabs(windowId, options = {}) {
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : 15000;
  const bypassCache = options.bypassCache !== false;
  const skipTabIds = options?.skipTabIds instanceof Set ? options.skipTabIds : new Set();
  const queryResult = await queryTabsInWindowSafe(windowId);

  if (!queryResult.ok) {
    return {
      ok: false,
      windowId,
      totalTabs: 0,
      attemptedTabIds: [],
      reloadedTabs: 0,
      failedTabs: 0,
      reason: queryResult.reason || 'query_tabs_failed'
    };
  }

  const tabs = Array.isArray(queryResult.tabs) ? queryResult.tabs : [];
  const attemptedTabIds = [];
  let reloadedTabs = 0;
  let failedTabs = 0;

  for (const tab of tabs) {
    const tabId = Number.isInteger(tab?.id) ? tab.id : null;
    if (tabId === null || skipTabIds.has(tabId)) continue;

    attemptedTabIds.push(tabId);
    const reloadResult = await forceReloadTab(tabId, { timeoutMs, bypassCache });
    if (reloadResult?.ok) {
      reloadedTabs += 1;
    } else {
      failedTabs += 1;
    }
  }

  return {
    ok: true,
    windowId,
    totalTabs: tabs.length,
    attemptedTabIds,
    reloadedTabs,
    failedTabs,
    reason: ''
  };
}

async function forceStopAndReloadProcessContext(process, options = {}) {
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : 15000;
  const bypassCache = options.bypassCache !== false;
  const reloadedWindowIds = options?.reloadedWindowIds instanceof Set
    ? options.reloadedWindowIds
    : new Set();
  const seenTabIds = new Set();
  const processTabId = Number.isInteger(process?.tabId) ? process.tabId : null;
  const processWindowId = Number.isInteger(process?.windowId) ? process.windowId : null;

  let tabReloads = 0;
  let tabReloadFailures = 0;
  let windowReloads = 0;
  let windowReloadFailures = 0;

  if (processTabId !== null) {
    seenTabIds.add(processTabId);
    const reloadResult = await forceReloadTab(processTabId, { timeoutMs, bypassCache });
    if (reloadResult?.ok) {
      tabReloads += 1;
    } else {
      tabReloadFailures += 1;
    }
  }

  if (processWindowId !== null && !reloadedWindowIds.has(processWindowId)) {
    reloadedWindowIds.add(processWindowId);

    const windowReloadResult = await forceReloadWindowTabs(processWindowId, {
      timeoutMs,
      bypassCache,
      skipTabIds: seenTabIds
    });

    if (windowReloadResult.ok) {
      windowReloads += 1;
      tabReloads += windowReloadResult.reloadedTabs;
      tabReloadFailures += windowReloadResult.failedTabs;
    } else {
      windowReloadFailures += 1;
    }
  }

  return {
    tabReloads,
    tabReloadFailures,
    windowReloads,
    windowReloadFailures
  };
}

async function resetTrackedProcessesForBulkRun(options = {}) {
  await ensureProcessRegistryReady();

  const clearHistory = options?.clearHistory !== false;
  const reason = typeof options?.reason === 'string' && options.reason.trim()
    ? options.reason.trim()
    : 'bulk_reset_before_detect_resume';
  const statusText = typeof options?.statusText === 'string' && options.statusText.trim()
    ? options.statusText.trim()
    : 'Reset przed globalnym uruchomieniem';
  const origin = typeof options?.origin === 'string' && options.origin.trim()
    ? options.origin.trim()
    : 'bulk-reset';
  const now = Date.now();

  const currentRecords = pruneProcessRecords(Array.from(processRegistry.values()));
  const nextRecords = [];

  let activeBefore = 0;
  let resetCount = 0;
  let historyRetained = 0;
  let stopSignalsSent = 0;
  let stopSignalsAcked = 0;
  let tabReloads = 0;
  let tabReloadFailures = 0;
  let windowReloads = 0;
  let windowReloadFailures = 0;
  const reloadedWindowIds = new Set();

  for (const process of currentRecords) {
    if (!process || typeof process !== 'object') continue;
    const isActive = !isClosedProcessStatus(process.status);

    if (isActive) {
      activeBefore += 1;

      // Try graceful stop first; fallback to tab reload to hard-stop injected execution.
      if (Number.isInteger(process.tabId)) {
        const stopResult = await requestProcessForceStopOnTab(process.tabId, {
          runId: process.id,
          reason,
          origin
        });
        if (stopResult.sent) {
          stopSignalsSent += 1;
        }
        if (stopResult.acknowledged) {
          stopSignalsAcked += 1;
        }
      }

      // Always force a reload of process context during reset.
      // This guarantees that in-tab execution is interrupted even when force-stop was acknowledged.
      const reloadSummary = await forceStopAndReloadProcessContext(process, {
        timeoutMs: 15000,
        bypassCache: true,
        reloadedWindowIds
      });
      tabReloads += reloadSummary.tabReloads;
      tabReloadFailures += reloadSummary.tabReloadFailures;
      windowReloads += reloadSummary.windowReloads;
      windowReloadFailures += reloadSummary.windowReloadFailures;

      const resetRecord = normalizeProcessRecord({
        ...process,
        status: 'stopped',
        statusText,
        reason,
        needsAction: false,
        autoRecovery: null,
        finishedAt: Number.isInteger(process.finishedAt) ? process.finishedAt : now,
        timestamp: now
      });
      if (resetRecord) {
        nextRecords.push(resetRecord);
        resetCount += 1;
      }
      continue;
    }

    if (!clearHistory) {
      nextRecords.push(process);
      historyRetained += 1;
    }
  }

  processRegistry.clear();
  nextRecords.forEach((record) => {
    if (record?.id) processRegistry.set(record.id, record);
  });

  await persistProcessRegistry();
  await broadcastProcessUpdate();

  return {
    clearHistory,
    activeBefore,
    resetCount,
    historyRetained,
    stopSignalsSent,
    stopSignalsAcked,
    tabReloads,
    tabReloadFailures,
    windowReloads,
    windowReloadFailures,
    uniqueWindowsReloaded: reloadedWindowIds.size,
    totalAfter: nextRecords.length
  };
}

function applyMonotonicProcessPatch(existing, patch, message = null) {
  if (!patch || typeof patch !== 'object') return patch;
  if (!existing || typeof existing !== 'object') return patch;

  const next = { ...patch };
  const incomingStatus = normalizeProcessStatus(next.status || existing.status);
  const incomingClosed = isClosedProcessStatus(incomingStatus);
  const existingClosed = isClosedProcessStatus(existing.status);
  const allowLowerProgress = !!message?.allowLowerProgress || incomingClosed;

  if (existingClosed && !incomingClosed) {
    next.status = existing.status;
    next.needsAction = false;
  }

  if (Number.isInteger(existing.totalPrompts) && Number.isInteger(next.totalPrompts)) {
    if (next.totalPrompts < existing.totalPrompts && !incomingClosed) {
      next.totalPrompts = existing.totalPrompts;
    }
  }

  if (Number.isInteger(existing.currentPrompt) && Number.isInteger(next.currentPrompt)) {
    if (next.currentPrompt < existing.currentPrompt && !allowLowerProgress) {
      next.currentPrompt = existing.currentPrompt;
    }
  }

  if (Number.isInteger(existing.stageIndex) && Number.isInteger(next.stageIndex)) {
    if (next.stageIndex < existing.stageIndex && !allowLowerProgress) {
      next.stageIndex = existing.stageIndex;
    }
  }

  if (!Number.isInteger(next.stageIndex) && Number.isInteger(next.currentPrompt) && next.currentPrompt > 0) {
    next.stageIndex = next.currentPrompt - 1;
  }
  if (Number.isInteger(next.currentPrompt) && next.currentPrompt > 0) {
    const normalizedPromptStageName = `Prompt ${next.currentPrompt}`;
    if (typeof next.stageName !== 'string' || /^Prompt\s+\d+/i.test(next.stageName.trim())) {
      next.stageName = normalizedPromptStageName;
    }
  }

  return next;
}

async function handleProcessProgressMessage(message, sender) {
  const runId = await resolveProcessId(message, sender);
  if (!runId) return false;

  const patch = {
    timestamp: Date.now(),
    needsAction: !!message?.needsAction
  };

  if (typeof message?.status === 'string' && message.status.trim()) {
    patch.status = message.status;
  } else {
    patch.status = 'running';
  }
  if (Number.isInteger(message?.currentPrompt)) patch.currentPrompt = message.currentPrompt;
  if (Number.isInteger(message?.totalPrompts)) patch.totalPrompts = message.totalPrompts;
  if (typeof message?.statusText === 'string') patch.statusText = message.statusText;
  if (typeof message?.reason === 'string') patch.reason = message.reason;
  if (Number.isInteger(message?.stageIndex)) patch.stageIndex = message.stageIndex;
  if (typeof message?.stageName === 'string') patch.stageName = message.stageName;
  if (typeof message?.chatUrl === 'string') patch.chatUrl = message.chatUrl;
  if (typeof message?.sourceUrl === 'string') patch.sourceUrl = message.sourceUrl;
  if (typeof message?.analysisType === 'string' && message.analysisType.trim()) patch.analysisType = message.analysisType.trim();
  if (typeof message?.title === 'string' && message.title.trim()) patch.title = message.title.trim();
  if (Number.isInteger(message?.tabId)) patch.tabId = message.tabId;
  if (Number.isInteger(message?.windowId)) patch.windowId = message.windowId;

  await ensureProcessRegistryReady();
  const existing = processRegistry.get(runId) || null;
  const safePatch = applyMonotonicProcessPatch(existing, patch, message);
  await upsertProcess(runId, safePatch);
  return true;
}

async function handleProcessNeedsActionMessage(message, sender) {
  const runId = await resolveProcessId(message, sender);
  if (!runId) return false;
  const patch = {
    status: 'running',
    needsAction: true,
    timestamp: Date.now()
  };
  if (Number.isInteger(message?.currentPrompt)) patch.currentPrompt = message.currentPrompt;
  if (Number.isInteger(message?.totalPrompts)) patch.totalPrompts = message.totalPrompts;
  if (Number.isInteger(message?.stageIndex)) patch.stageIndex = message.stageIndex;
  if (typeof message?.stageName === 'string') patch.stageName = message.stageName;
  if (typeof message?.statusText === 'string') patch.statusText = message.statusText;
  if (typeof message?.reason === 'string') patch.reason = message.reason;
  if (typeof message?.analysisType === 'string' && message.analysisType.trim()) patch.analysisType = message.analysisType.trim();
  if (typeof message?.title === 'string' && message.title.trim()) patch.title = message.title.trim();
  if (Number.isInteger(message?.tabId)) patch.tabId = message.tabId;
  if (Number.isInteger(message?.windowId)) patch.windowId = message.windowId;
  await ensureProcessRegistryReady();
  const existing = processRegistry.get(runId) || null;
  const safePatch = applyMonotonicProcessPatch(existing, patch, message);
  await upsertProcess(runId, safePatch);
  return true;
}

function getDecisionResolvedStatusText(decision) {
  return decision === 'skip' ? 'Pominieto czekanie' : 'Wznowiono czekanie';
}

async function handleProcessActionResolvedMessage(message, sender) {
  const runId = await resolveProcessId(message, sender);
  if (!runId) return false;
  const decision = message?.decision === 'skip' ? 'skip' : 'wait';
  const patch = {
    status: 'running',
    needsAction: false,
    reason: '',
    statusText: getDecisionResolvedStatusText(decision),
    timestamp: Date.now()
  };
  if (typeof message?.analysisType === 'string' && message.analysisType.trim()) patch.analysisType = message.analysisType.trim();
  if (typeof message?.title === 'string' && message.title.trim()) patch.title = message.title.trim();
  if (Number.isInteger(message?.tabId)) patch.tabId = message.tabId;
  if (Number.isInteger(message?.windowId)) patch.windowId = message.windowId;
  await upsertProcess(runId, patch);
  return true;
}

async function handleProcessDecisionMessage(message) {
  const runId = await resolveProcessId(message, { tab: { id: message?.tabId } });
  if (!runId) return false;

  await ensureProcessRegistryReady();
  const process = processRegistry.get(runId) || null;
  const decision = message?.decision === 'skip' ? 'skip' : 'wait';

  const targetTabId = Number.isInteger(message?.tabId)
    ? message.tabId
    : (Number.isInteger(process?.tabId) ? process.tabId : null);

  let forwarded = false;
  if (Number.isInteger(targetTabId)) {
    try {
      await chrome.tabs.sendMessage(targetTabId, {
        type: 'PROCESS_DECISION',
        runId,
        decision,
        origin: message?.origin || 'panel'
      });
      forwarded = true;
    } catch (error) {
      console.warn('[monitor] Unable to forward PROCESS_DECISION to tab:', targetTabId, error?.message || error);
    }
  }

  if (forwarded) {
    const patch = {
      status: isClosedProcessStatus(process?.status) ? process.status : 'running',
      needsAction: false,
      reason: '',
      statusText: getDecisionResolvedStatusText(decision),
      timestamp: Date.now()
    };
    if (typeof message?.analysisType === 'string' && message.analysisType.trim()) patch.analysisType = message.analysisType.trim();
    if (typeof message?.title === 'string' && message.title.trim()) patch.title = message.title.trim();
    if (Number.isInteger(message?.tabId)) patch.tabId = message.tabId;
    if (Number.isInteger(message?.windowId)) patch.windowId = message.windowId;
    await upsertProcess(runId, patch);
    return true;
  }

  await upsertProcess(runId, {
    status: isClosedProcessStatus(process?.status) ? process.status : 'running',
    needsAction: true,
    statusText: 'Panel: decyzja niedostarczona (brak aktywnej karty)',
    timestamp: Date.now()
  });
  return false;
}

async function handleProcessDecisionAllMessage(message) {
  await ensureProcessRegistryReady();
  const decision = message?.decision === 'skip' ? 'skip' : 'wait';
  const candidates = Array.from(processRegistry.values()).filter((process) => (
    process &&
    !isClosedProcessStatus(process.status) &&
    !!process.needsAction
  ));

  let delivered = 0;
  for (const process of candidates) {
    const handled = await handleProcessDecisionMessage({
      runId: process.id,
      decision,
      origin: message?.origin || 'panel-bulk',
      tabId: Number.isInteger(process.tabId) ? process.tabId : null,
      windowId: Number.isInteger(process.windowId) ? process.windowId : null
    });
    if (handled) delivered += 1;
  }

  return {
    matched: candidates.length,
    delivered
  };
}

// Zmienne globalne dla promptów
let PROMPTS_COMPANY = [];
let PROMPTS_PORTFOLIO = [];

// Nazwy etapów dla company analysis (synchronizowane z prompts-company.txt)
const STAGE_NAMES_COMPANY = [
  "Stage 0: Evidence Ledger + Thesis",
  "Pipeline Setup (Stages 0-10)",
  "Stage 1: Sub-segment Validation (Porter + S-curve)",
  "Stage 2: Stock Universe (15 names)",
  "Stage 2.5: Reverse DCF Lite + Driver Screen",
  "Stage 3: Competitive Position (4 finalists)",
  "Stage 3.5: Revaluation Parameter (RP)",
  "Stage 4: DuPont ROE Quality",
  "Stage 6: Thesis Monetization Quantification",
  "Reverse DCF (Full / TOTAL)",
  "Stage 8: Four-Gate Decision",
  "Stage 10: Position State Machine"
];

// Funkcja generująca losowe opóźnienie dla anti-automation
function extractLastTwoSentences(text) {
  if (typeof text !== 'string') return '';

  const cleaned = text
    .replace(/\r/g, ' ')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return '';

  const sentences = cleaned
    .match(/[^.!?\n]+[.!?]+(?:["')\]]+)?|[^.!?\n]+$/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) || [];

  if (sentences.length === 0) return '';
  if (sentences.length === 1) return sentences[0];
  return `${sentences[sentences.length - 2]} ${sentences[sentences.length - 1]}`.trim();
}

function normalizeSentenceSignature(text) {
  if (typeof text !== 'string') return '';
  let normalized = text;
  if (typeof normalized.normalize === 'function') {
    normalized = normalized.normalize('NFKC');
  }

  normalized = normalized
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B`´]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized;
}

function buildPromptSignatureCatalog(prompts) {
  if (!Array.isArray(prompts)) return [];

  const catalog = [];
  prompts.forEach((promptText, index) => {
    if (typeof promptText !== 'string') return;
    const signatureRaw = extractLastTwoSentences(promptText);
    const signature = normalizeSentenceSignature(signatureRaw);
    if (!signature) return;
    const promptNumber = index + 1;
    catalog.push({
      index,
      promptNumber,
      stageName: STAGE_NAMES_COMPANY[index] || `Prompt ${promptNumber}`,
      signature,
      signatureRaw,
      signatureLength: signature.length
    });
  });

  return catalog;
}

function detectPromptIndexFromMessage(lastUserMessageText, catalog) {
  const messageSignatureRaw = extractLastTwoSentences(lastUserMessageText || '');
  const messageSignature = normalizeSentenceSignature(messageSignatureRaw);
  if (!messageSignature) {
    return {
      matched: false,
      reason: 'no_user_message',
      messageSignatureRaw,
      messageSignature
    };
  }

  const list = Array.isArray(catalog) ? catalog : [];
  if (list.length === 0) {
    return {
      matched: false,
      reason: 'catalog_empty',
      messageSignatureRaw,
      messageSignature
    };
  }

  const exactMatches = list.filter((entry) => entry.signature === messageSignature);
  if (exactMatches.length > 0) {
    const selected = exactMatches.sort((a, b) => b.index - a.index)[0];
    return {
      matched: true,
      method: 'exact',
      ...selected,
      messageSignatureRaw,
      messageSignature
    };
  }

  const minComparableLen = 24;
  if (messageSignature.length < minComparableLen) {
    return {
      matched: false,
      reason: 'signature_too_short',
      messageSignatureRaw,
      messageSignature
    };
  }

  const includesMatches = list
    .filter((entry) => {
      const left = typeof entry?.signature === 'string' ? entry.signature : '';
      if (left.length < minComparableLen) return false;
      return messageSignature.includes(left) || left.includes(messageSignature);
    })
    .sort((a, b) => {
      if (b.signatureLength !== a.signatureLength) {
        return b.signatureLength - a.signatureLength;
      }
      return b.index - a.index;
    });

  if (includesMatches.length > 0) {
    const selected = includesMatches[0];
    return {
      matched: true,
      method: 'includes',
      ...selected,
      messageSignatureRaw,
      messageSignature
    };
  }

  return {
    matched: false,
    reason: 'signature_not_found',
    messageSignatureRaw,
    messageSignature
  };
}

async function extractLastUserMessageFromTab(tabId) {
  if (!Number.isInteger(tabId)) {
    return { success: false, error: 'invalid_tab_id' };
  }

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      function: () => {
        const userMessages = document.querySelectorAll('[data-message-author-role="user"]');
        const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
        const count = userMessages.length;
        const assistantCount = assistantMessages.length;
        const last = count > 0 ? userMessages[count - 1] : null;
        const text = last ? (last.innerText || last.textContent || '') : '';
        return {
          text: typeof text === 'string' ? text : '',
          count,
          assistantCount,
          title: document.title || '',
          url: location.href || ''
        };
      }
    });

    const payload = result?.[0]?.result || {};
    return {
      success: true,
      text: typeof payload.text === 'string' ? payload.text : '',
      count: Number.isInteger(payload.count) ? payload.count : 0,
      assistantCount: Number.isInteger(payload.assistantCount) ? payload.assistantCount : 0,
      title: typeof payload.title === 'string' ? payload.title : '',
      url: typeof payload.url === 'string' ? payload.url : ''
    };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
}

async function resumeFromStageOnTab(tabId, windowId, startIndex, options = {}) {
  const normalizedStartIndex = Number.isInteger(startIndex) ? startIndex : -1;
  if (!Number.isInteger(tabId) || normalizedStartIndex < 0) {
    return { success: false, error: 'invalid_resume_arguments' };
  }

  let targetTab = null;
  try {
    targetTab = await chrome.tabs.get(tabId);
  } catch (error) {
    return { success: false, error: 'tab_not_found' };
  }

  let targetTabUrl = getTabEffectiveUrl(targetTab);
  if (!isChatGptUrl(targetTabUrl)) {
    return { success: false, error: 'tab_not_chatgpt' };
  }

  if (PROMPTS_COMPANY.length === 0) {
    await loadPrompts();
  }
  if (PROMPTS_COMPANY.length === 0) {
    return { success: false, error: 'prompts_empty' };
  }
  if (normalizedStartIndex >= PROMPTS_COMPANY.length) {
    return { success: false, error: 'start_index_out_of_range' };
  }

  const targetWindowId = Number.isInteger(windowId) ? windowId : targetTab.windowId;
  const reloadBeforeResume = options?.reloadBeforeResume !== false;
  if (reloadBeforeResume) {
    const prepareResult = await prepareTabForResume(tabId, targetWindowId, {
      timeoutMs: 15000,
      bypassCache: true
    });
    if (!prepareResult?.ok) {
      return {
        success: false,
        error: 'reload_failed',
        reason: prepareResult?.reason || 'reload_failed',
        details: prepareResult?.error || ''
      };
    }
    const refreshedTab = await getTabByIdSafe(tabId);
    if (!refreshedTab) {
      return { success: false, error: 'tab_not_found' };
    }
    targetTab = refreshedTab;
    targetTabUrl = getTabEffectiveUrl(targetTab);
    if (!isChatGptUrl(targetTabUrl)) {
      return { success: false, error: 'tab_not_chatgpt' };
    }
  }

  const promptsToSend = PROMPTS_COMPANY.slice(normalizedStartIndex);
  const cleanedPrompts = [...promptsToSend];
  if (cleanedPrompts[0]) {
    cleanedPrompts[0] = cleanedPrompts[0].replace('{{articlecontent}}', '').trim();
  }

  const payload = '';
  const restOfPrompts = cleanedPrompts;
  const processTitle = typeof options.processTitle === 'string' && options.processTitle.trim()
    ? options.processTitle.trim()
    : `Auto Resume from Stage ${normalizedStartIndex + 1}`;
  const processId = `resume-auto-company-${Date.now()}-${tabId}-${normalizedStartIndex}-${Math.random().toString(36).slice(2, 8)}`;

  await upsertProcess(processId, {
    title: processTitle,
    analysisType: 'company',
    status: 'starting',
    statusText: 'Auto-resume przygotowanie',
    currentPrompt: normalizedStartIndex,
    totalPrompts: PROMPTS_COMPANY.length,
    stageIndex: normalizedStartIndex > 0 ? (normalizedStartIndex - 1) : null,
    stageName: normalizedStartIndex > 0 ? `Prompt ${normalizedStartIndex}` : 'Start',
    needsAction: false,
    startedAt: Date.now(),
    timestamp: Date.now(),
    sourceUrl: targetTabUrl || '',
    chatUrl: targetTabUrl || '',
    tabId,
    windowId: Number.isInteger(windowId) ? windowId : targetTab.windowId,
    messages: []
  });

  try {
    if (Number.isInteger(targetWindowId)) {
      await chrome.windows.update(targetWindowId, { focused: true });
    }
    await chrome.tabs.update(tabId, { active: true });
  } catch (error) {
    console.warn('[auto-resume] Nie udalo sie aktywowac karty przed resume:', error?.message || error);
  }

  const executeResumeFlow = async () => {
    let results;
    let result;
    let executionPayload = payload;
    let executionPromptChain = restOfPrompts;
    let executionPromptOffset = normalizedStartIndex;
    let autoRecoveryAttempt = 0;

    while (true) {
      try {
        results = await chrome.scripting.executeScript({
          target: { tabId },
          function: injectToChat,
          args: [
            executionPayload,
            executionPromptChain,
            WAIT_FOR_TEXTAREA_MS,
            WAIT_FOR_RESPONSE_MS,
            RETRY_INTERVAL_MS,
            processTitle,
            'company',
            processId,
            {
              promptOffset: executionPromptOffset,
              totalPromptsOverride: PROMPTS_COMPANY.length
            },
            {
              enabled: true,
              attempt: autoRecoveryAttempt,
              maxAttempts: AUTO_RECOVERY_MAX_ATTEMPTS,
              delayMs: AUTO_RECOVERY_DELAY_MS,
              reasons: [...AUTO_RECOVERY_REASONS]
            },
            {
              persistFinalResponseViaMessage: true,
              mode: 'runtime_message',
              saveTimeoutMs: 18000
            }
          ]
        });
      } catch (error) {
        await upsertProcess(processId, {
          status: 'failed',
          needsAction: false,
          statusText: 'Blad executeScript auto-resume',
          reason: 'auto_resume_execute_script_failed',
          error: error?.message || String(error),
          autoRecovery: null,
          finishedAt: Date.now(),
          timestamp: Date.now()
        });
        return { success: false, error: 'inject_failed' };
      }

      if (!results || results.length === 0) {
        await upsertProcess(processId, {
          status: 'failed',
          needsAction: false,
          statusText: 'Brak wyniku executeScript auto-resume',
          reason: 'missing_execute_result',
          autoRecovery: null,
          finishedAt: Date.now(),
          timestamp: Date.now()
        });
        return { success: false, error: 'missing_execute_result' };
      }

      result = results?.[0]?.result;
      const handoff = result?.error === 'auto_recovery_required' ? result?.autoRecovery : null;
      if (!handoff || autoRecoveryAttempt >= AUTO_RECOVERY_MAX_ATTEMPTS) {
        break;
      }

      autoRecoveryAttempt += 1;
      const nextPromptOffset = Number.isInteger(handoff.promptOffset) && handoff.promptOffset >= 0
        ? handoff.promptOffset
        : executionPromptOffset;
      const nextRemainingPrompts = Array.isArray(handoff.remainingPrompts)
        ? handoff.remainingPrompts
        : executionPromptChain;
      const recoveryReasonBase = typeof handoff.reason === 'string' && handoff.reason.trim()
        ? handoff.reason.trim()
        : 'unknown';
      const recoveryReason = `auto_recovery_${recoveryReasonBase}`;
      const recoveryCurrentPrompt = Number.isInteger(handoff.currentPrompt) && handoff.currentPrompt >= 0
        ? handoff.currentPrompt
        : (nextPromptOffset > 0 ? nextPromptOffset : executionPromptOffset);
      const recoveryStageIndex = Number.isInteger(handoff.stageIndex)
        ? handoff.stageIndex
        : (recoveryCurrentPrompt > 0 ? (recoveryCurrentPrompt - 1) : null);

      const recoveryPatch = {
        title: processTitle,
        analysisType: 'company',
        status: 'running',
        needsAction: false,
        currentPrompt: recoveryCurrentPrompt,
        totalPrompts: PROMPTS_COMPANY.length,
        statusText: `Auto-resend ${autoRecoveryAttempt}/${AUTO_RECOVERY_MAX_ATTEMPTS}`,
        reason: recoveryReason,
        autoRecovery: {
          attempt: autoRecoveryAttempt,
          maxAttempts: AUTO_RECOVERY_MAX_ATTEMPTS,
          delayMs: AUTO_RECOVERY_DELAY_MS,
          reason: recoveryReasonBase,
          currentPrompt: recoveryCurrentPrompt,
          ...(Number.isInteger(recoveryStageIndex) ? { stageIndex: recoveryStageIndex } : {}),
          updatedAt: Date.now()
        },
        timestamp: Date.now()
      };
      if (Number.isInteger(recoveryStageIndex)) {
        recoveryPatch.stageIndex = recoveryStageIndex;
        recoveryPatch.stageName = `Prompt ${recoveryStageIndex + 1}`;
      }
      await upsertProcess(processId, recoveryPatch);

      await sleep(AUTO_RECOVERY_DELAY_MS);

      executionPayload = '';
      executionPromptChain = nextRemainingPrompts;
      executionPromptOffset = nextPromptOffset;
    }

    if (result?.success) {
      const resultLastResponse = typeof result?.lastResponse === 'string'
        ? result.lastResponse
        : '';
      const hasResultLastResponse = resultLastResponse.trim().length > 0;
      const selectedPrompt = Number.isInteger(result?.selectedResponsePrompt)
        ? result.selectedResponsePrompt
        : null;
      const selectedStageIndex = Number.isInteger(result?.selectedResponseStageIndex)
        ? result.selectedResponseStageIndex
        : (selectedPrompt && selectedPrompt > 0 ? (selectedPrompt - 1) : null);

      const stageMeta = {};
      if (Number.isInteger(selectedPrompt)) {
        stageMeta.selected_response_prompt = selectedPrompt;
      }
      if (Number.isInteger(selectedStageIndex)) {
        stageMeta.selected_response_stage_index = selectedStageIndex;
      }
      if (typeof result?.selectedResponseReason === 'string' && result.selectedResponseReason.trim()) {
        stageMeta.selected_response_reason = result.selectedResponseReason.trim();
      }

      const normalizedConversationUrl = normalizeChatConversationUrl(result?.conversationUrl)
        || normalizeChatConversationUrl(getTabEffectiveUrl(targetTab));
      const providedResponseId = typeof result?.responseId === 'string' && result.responseId.trim()
        ? result.responseId.trim()
        : null;
      const injectedSaveResult = result?.persistedSaveResult && typeof result.persistedSaveResult === 'object'
        ? result.persistedSaveResult
        : null;
      const savedViaInjectedMessage = result?.persistedViaMessage === true && !!injectedSaveResult?.success;

      let saveResult = null;
      if (hasResultLastResponse) {
        if (savedViaInjectedMessage) {
          saveResult = injectedSaveResult;
          console.log('[auto-resume] saveResponse pominięte - zapis wykonany z kontekstu karty', {
            processId,
            responseId: providedResponseId || injectedSaveResult?.response?.responseId || '',
            copyTrace: injectedSaveResult?.copyTrace || ''
          });
        } else {
          saveResult = await saveResponse(
            resultLastResponse,
            processTitle,
            'company',
            processId,
            providedResponseId,
            Object.keys(stageMeta).length > 0 ? stageMeta : null,
            normalizedConversationUrl || null
          );
        }
      } else {
        console.warn('[auto-resume] Proces zakonczony, ale lastResponse jest pusta - pomijam saveResponse');
      }

      const persistenceSummary = buildPersistenceUiSummary({
        hasResponse: hasResultLastResponse,
        saveResult,
        saveError: hasResultLastResponse && !saveResult?.success
          ? (typeof result?.persistedSaveError === 'string' && result.persistedSaveError.trim()
            ? result.persistedSaveError.trim()
            : 'save_response_failed')
          : ''
      });
      await renderFinalCounterStatusOnTab(tabId, {
        heading: hasResultLastResponse
          ? (persistenceSummary.saveOk ? 'Zakonczono' : 'Zakonczono (blad zapisu)')
          : 'Zakonczono (pusta odpowiedz)',
        tone: persistenceSummary.tone,
        lines: persistenceSummary.logLines,
        autoCloseMs: 0
      });

      const MAX_COMPLETED_RESPONSE_CHARS = 180000;
      const completedResponseTruncated = resultLastResponse.length > MAX_COMPLETED_RESPONSE_CHARS;
      const storedCompletedResponse = completedResponseTruncated
        ? resultLastResponse.slice(0, MAX_COMPLETED_RESPONSE_CHARS)
        : resultLastResponse;

      await upsertProcess(processId, {
        title: processTitle,
        analysisType: 'company',
        status: 'completed',
        needsAction: false,
        statusText: persistenceSummary.statusText,
        reason: persistenceSummary.reason,
        ...(Number.isInteger(selectedPrompt) ? { currentPrompt: selectedPrompt } : {}),
        ...(Number.isInteger(selectedStageIndex)
          ? {
            stageIndex: selectedStageIndex,
            stageName: `Prompt ${selectedStageIndex + 1}`
          }
          : {}),
        ...(normalizedConversationUrl ? { chatUrl: normalizedConversationUrl } : {}),
        persistenceLog: persistenceSummary.logLines,
        persistenceStatus: {
          hasResponse: hasResultLastResponse,
          saveOk: persistenceSummary.saveOk,
          dispatchSummary: persistenceSummary.dispatchSummary,
          copyTrace: persistenceSummary.copyTrace,
          saveError: persistenceSummary.saveError,
          dispatch: persistenceSummary.dispatch || null,
          updatedAt: Date.now()
        },
        ...(hasResultLastResponse
          ? {
            completedResponseText: storedCompletedResponse,
            completedResponseLength: resultLastResponse.length,
            completedResponseTruncated,
            completedResponseCapturedAt: Date.now(),
            completedResponseSaved: persistenceSummary.saveOk,
            completedResponseDispatch: persistenceSummary.dispatch || null,
            completedResponseDispatchSummary: persistenceSummary.dispatchSummary,
            completedResponseSaveTrace: persistenceSummary.copyTrace || ''
          }
          : {}),
        autoRecovery: null,
        finishedAt: Date.now(),
        timestamp: Date.now()
      });

      return {
        success: true,
        processId
      };
    }

    await upsertProcess(processId, {
      status: 'failed',
      needsAction: false,
      statusText: 'Auto-resume nieudany',
      reason: 'auto_resume_failed',
      error: typeof result?.error === 'string' ? result.error : 'Unknown auto-resume error',
      autoRecovery: null,
      finishedAt: Date.now(),
      timestamp: Date.now()
    });
    return { success: false, error: 'resume_failed' };
  };

  if (options?.detach === true) {
    console.log('[auto-resume] Dispatch (detached)', {
      processId,
      tabId,
      windowId: Number.isInteger(windowId) ? windowId : targetTab.windowId,
      startIndex: normalizedStartIndex,
      startPromptNumber: normalizedStartIndex + 1
    });

    void executeResumeFlow()
      .then((detachedResult) => {
        if (detachedResult?.success) {
          console.log('[auto-resume] Detached flow completed', {
            processId,
            tabId,
            success: true
          });
          return;
        }
        console.warn('[auto-resume] Detached flow finished with failure', {
          processId,
          tabId,
          error: detachedResult?.error || 'unknown_detached_error'
        });
      })
      .catch(async (error) => {
        console.error('[auto-resume] Detached flow unhandled exception', {
          processId,
          tabId,
          error: error?.message || String(error)
        });
        await upsertProcess(processId, {
          status: 'failed',
          needsAction: false,
          statusText: 'Auto-resume exception',
          reason: 'auto_resume_unhandled_exception',
          error: error?.message || String(error),
          autoRecovery: null,
          finishedAt: Date.now(),
          timestamp: Date.now()
        });
      });

    return { success: true, processId, detached: true };
  }

  return executeResumeFlow();
}

async function runResetScanStartAllTabs(options = {}) {
  try {
    const origin = typeof options?.origin === 'string' && options.origin.trim()
      ? options.origin.trim()
      : 'reset-scan-start';
    const requestedScope = typeof options?.scope === 'string' && options.scope.trim()
      ? options.scope.trim()
      : RESUME_ALL_SCOPE_ACTIVE_COMPANY_INVEST;
    const scope = requestedScope === RESUME_ALL_SCOPE_ACTIVE_COMPANY_INVEST
      ? requestedScope
      : RESUME_ALL_SCOPE_ACTIVE_COMPANY_INVEST;

    const emptySummary = {
      started: 0,
      detect_failed: 0,
      reload_failed: 0,
      skipped_non_company: 0,
      skipped_outside_invest: 0,
      final_stage_completed: 0,
      start_failed: 0,
      reload_ok: 0,
      reload_total: 0,
      prompt_blocks: 0,
      response_blocks: 0,
      detected_prompts: 0
    };
    const resetSummary = {
      mode: 'scoped_active_processes',
      scope
    };

    const promptsReady = await ensureCompanyPromptsReady();
    if (!promptsReady || PROMPTS_COMPANY.length === 0) {
      await loadPrompts();
    }
    if (PROMPTS_COMPANY.length === 0) {
      return {
        success: false,
        scannedTabs: 0,
        matchedTabs: 0,
        startedTabs: 0,
        resumedTabs: 0,
        requestedProcesses: 0,
        eligibleProcesses: 0,
        summary: { ...emptySummary },
        scope,
        results: [],
        resetSummary,
        error: 'prompts_not_loaded'
      };
    }

    const catalog = buildPromptSignatureCatalog(PROMPTS_COMPANY);
    const promptRecords = buildPromptSignatureRecords(PROMPTS_COMPANY);
    const processSnapshot = await getProcessSnapshot();
    const activeProcesses = processSnapshot
      .filter((process) => process && !isClosedProcessStatus(process.status))
      .sort(compareProcessesForRestore);
    const resultsByKey = new Map();
    const orderedResultKeys = [];
    const scanTargets = [];
    const matchedKeys = new Set();
    const startedKeys = new Set();
    const preparedKeys = new Set();

    const startedAt = Date.now();
    const maxPasses = Number.isInteger(options?.maxPasses) && options.maxPasses > 0
      ? options.maxPasses
      : RESET_SCAN_DEFAULT_PASSES;
    const maxRuntimeMs = Math.max(
      RESET_SCAN_MIN_RUNTIME_MS,
      activeProcesses.length * RESET_SCAN_PER_TAB_BUDGET_MS,
      Number.isInteger(options?.maxRuntimeMs) && options.maxRuntimeMs > 0
        ? options.maxRuntimeMs
        : 0
    );
    const passDelayMs = Number.isInteger(options?.passDelayMs) && options.passDelayMs >= 0
      ? options.passDelayMs
      : RESET_SCAN_PASS_DELAY_MS;
    let passCount = 0;
    const truncateForLog = (text, maxLen = 180) => {
      if (typeof text !== 'string') return '';
      const compact = text.replace(/\s+/g, ' ').trim();
      if (compact.length <= maxLen) return compact;
      return `${compact.slice(0, Math.max(0, maxLen - 3))}...`;
    };
    const getResultKey = (process, index) => {
      const processId = process?.id ? String(process.id).trim() : '';
      if (processId) return `run:${processId}`;
      return `idx:${index}`;
    };
    const markProcessCompletedAfterFinalStage = async (row, reason = 'already_at_last_stage') => {
      if (!row?.runId || PROMPTS_COMPANY.length <= 0) return false;
      try {
        const finalPromptNumber = PROMPTS_COMPANY.length;
        const finalStageIndex = finalPromptNumber - 1;
        await upsertProcess(row.runId, {
          status: 'completed',
          needsAction: false,
          statusText: 'Zakonczono - wykryto finalny etap',
          reason,
          currentPrompt: finalPromptNumber,
          totalPrompts: finalPromptNumber,
          stageIndex: finalStageIndex,
          stageName: STAGE_NAMES_COMPANY[finalStageIndex] || `Prompt ${finalPromptNumber}`,
          autoRecovery: null,
          finishedAt: Date.now(),
          timestamp: Date.now()
        });
        return true;
      } catch (error) {
        console.warn('[reset-scan-start] Nie udalo sie oznaczyc procesu jako zakonczony', {
          runId: row?.runId || '',
          reason,
          error: error?.message || String(error)
        });
        return false;
      }
    };
    const computeFallbackResumeStartIndex = (row) => {
      const promptCount = PROMPTS_COMPANY.length;
      if (!Number.isInteger(promptCount) || promptCount <= 1) return null;

      const progressPrompt = Number.isInteger(row?.progressPromptNumber)
        ? row.progressPromptNumber
        : null;
      const hasCounters = Number.isInteger(row?.assistantMessageCount) && Number.isInteger(row?.userMessageCount);
      const shouldAdvancePrompt = hasCounters
        ? row.assistantMessageCount >= row.userMessageCount
        : true;

      if (Number.isInteger(progressPrompt) && progressPrompt > 0) {
        const progressIndex = Math.min(Math.max(progressPrompt - 1, 0), promptCount - 1);
        const computed = computeNextResumeIndex(progressIndex, promptCount, shouldAdvancePrompt);
        if (Number.isInteger(computed)) {
          return Math.min(Math.max(computed, 1), promptCount - 1);
        }
        return null;
      }

      // Last-resort fallback: start from Prompt 2 when counters are unavailable.
      return 1;
    };

    for (let index = 0; index < activeProcesses.length; index += 1) {
      const process = activeProcesses[index];
      const key = getResultKey(process, index);
      const analysisType = typeof process?.analysisType === 'string' && process.analysisType.trim()
        ? process.analysisType.trim()
        : 'company';
      const row = {
        key,
        runId: typeof process?.id === 'string' && process.id.trim() ? process.id.trim() : '',
        analysisType,
        processTitle: typeof process?.title === 'string' ? process.title : '',
        tabId: Number.isInteger(process?.tabId) ? process.tabId : null,
        windowId: Number.isInteger(process?.windowId) ? process.windowId : null,
        title: typeof process?.title === 'string' ? process.title : '',
        url: typeof process?.chatUrl === 'string' && process.chatUrl.trim()
          ? process.chatUrl.trim()
          : (typeof process?.sourceUrl === 'string' ? process.sourceUrl.trim() : ''),
        userMessageCount: null,
        assistantMessageCount: null,
        responseBlockCount: null,
        lastUserMessageLength: null,
        detectedPromptIndex: null,
        detectedPromptNumber: null,
        detectedStageName: null,
        detectedMethod: '',
        detectedSignature: '',
        detectedHasAssistantReply: null,
        progressPromptNumber: Number.isInteger(process?.currentPrompt) ? process.currentPrompt : null,
        progressStageName: typeof process?.stageName === 'string' ? process.stageName : '',
        stageConsistency: '',
        stageDelta: null,
        nextStartIndex: null,
        action: 'queued',
        reason: '',
        attempts: 0,
        lastPass: 0,
        retryExhausted: false,
        stopSignalSent: false,
        stopSignalAck: false,
        stopSignalReason: '',
        reloadMethod: ''
      };

      if (analysisType !== 'company') {
        row.action = 'skipped_non_company';
        row.reason = `analysis_type:${analysisType || 'unknown'}`;
        orderedResultKeys.push(key);
        resultsByKey.set(key, row);
        continue;
      }

      let tab = Number.isInteger(row.tabId) ? await getTabByIdSafe(row.tabId) : null;
      if (!tab && Number.isInteger(row.windowId)) {
        try {
          const tabsInWindow = await chrome.tabs.query({ windowId: row.windowId });
          const investTab = tabsInWindow.find((candidate) => isInvestGptUrl(getTabEffectiveUrl(candidate)));
          if (investTab && Number.isInteger(investTab.id)) {
            tab = investTab;
          }
        } catch (error) {
          // Best effort only.
        }
      }

      if (tab) {
        row.tabId = Number.isInteger(tab?.id) ? tab.id : row.tabId;
        row.windowId = Number.isInteger(tab?.windowId) ? tab.windowId : row.windowId;
        row.title = typeof tab?.title === 'string' ? tab.title : row.title;
        row.url = getTabEffectiveUrl(tab) || row.url;
      }

      if (!isInvestGptUrl(row.url)) {
        row.action = 'skipped_outside_invest';
        row.reason = `outside_invest:${row.url || 'empty'}`;
        orderedResultKeys.push(key);
        resultsByKey.set(key, row);
        continue;
      }

      if (!Number.isInteger(row.tabId)) {
        row.action = 'detect_failed';
        row.reason = 'tab_not_found_for_process';
        orderedResultKeys.push(key);
        resultsByKey.set(key, row);
        continue;
      }

      row.action = 'queued_for_detection';
      row.reason = 'queued_for_detection';
      orderedResultKeys.push(key);
      resultsByKey.set(key, row);
      scanTargets.push({
        key,
        runId: row.runId,
        tabId: row.tabId,
        windowId: row.windowId,
        process
      });
    }

    const pendingKeys = new Set(scanTargets.map((target) => target.key));

    console.log('[reset-scan-start] Init', {
      origin,
      scope,
      promptsCompanyCount: PROMPTS_COMPANY.length,
      signatureCatalogCount: catalog.length,
      promptRecordsCount: promptRecords.length,
      activeProcessesCount: activeProcesses.length,
      eligibleProcessesCount: scanTargets.length,
      maxPasses,
      maxRuntimeMs,
      passDelayMs,
      resetSummary
    });

    while (
      pendingKeys.size > 0 &&
      passCount < maxPasses &&
      (Date.now() - startedAt) < maxRuntimeMs
    ) {
      passCount += 1;
      console.log('[reset-scan-start] Pass start', {
        pass: passCount,
        pending: pendingKeys.size,
        scanned: scanTargets.length
      });

      for (const target of scanTargets) {
        if (!pendingKeys.has(target.key)) continue;

        const previous = resultsByKey.get(target.key) || null;
        const row = {
          ...(previous || {}),
          attempts: previous?.attempts ? (previous.attempts + 1) : 1,
          lastPass: passCount
        };
        resultsByKey.set(target.key, row);

        console.log('[reset-scan-start] Inspect process', {
          pass: passCount,
          runId: row.runId || '',
          tabId: row.tabId,
          windowId: row.windowId,
          attempt: row.attempts,
          url: truncateForLog(row.url, 140),
          title: truncateForLog(row.title, 100)
        });

        if (!Number.isInteger(row.tabId)) {
          row.action = 'detect_failed';
          row.reason = 'invalid_tab_id';
          resultsByKey.set(target.key, row);
          pendingKeys.delete(target.key);
          continue;
        }

        if (!preparedKeys.has(target.key)) {
          const stopResult = await requestProcessForceStopOnTab(row.tabId, {
            runId: row.runId,
            reason: 'bulk_resume_reload',
            origin
          });
          row.stopSignalSent = stopResult?.sent === true;
          row.stopSignalAck = stopResult?.acknowledged === true;
          row.stopSignalReason = stopResult?.reason || '';

          const prepareResult = await prepareTabForResume(row.tabId, row.windowId, {
            timeoutMs: 15000,
            bypassCache: true
          });
          if (!prepareResult?.ok) {
            row.action = 'reload_failed';
            row.reason = prepareResult?.reason || 'reload_failed';
            row.reloadDetails = prepareResult?.error || '';
            resultsByKey.set(target.key, row);
            pendingKeys.delete(target.key);
            console.warn('[reset-scan-start] Reload failed for process context', {
              runId: row.runId || '',
              tabId: row.tabId,
              windowId: row.windowId,
              reason: row.reason,
              details: row.reloadDetails || ''
            });
            continue;
          }
          row.reloadMethod = typeof prepareResult?.reloadResult?.method === 'string'
            ? prepareResult.reloadResult.method
            : '';
          preparedKeys.add(target.key);

          if (row.runId) {
            await upsertProcess(row.runId, {
              status: 'stopped',
              statusText: 'Zatrzymany przed wznowieniem zbiorczym',
              reason: 'bulk_resume_reload',
              needsAction: false,
              autoRecovery: null,
              finishedAt: Date.now(),
              timestamp: Date.now()
            });
          }
        } else {
          await prepareTabForDetection(row.tabId, row.windowId);
        }

        const currentTab = await getTabByIdSafe(row.tabId);
        if (!currentTab) {
          row.action = 'detect_failed';
          row.reason = 'tab_not_found';
          resultsByKey.set(target.key, row);
          pendingKeys.delete(target.key);
          continue;
        }

        row.title = typeof currentTab?.title === 'string' ? currentTab.title : row.title;
        row.url = getTabEffectiveUrl(currentTab) || row.url;
        row.windowId = Number.isInteger(currentTab?.windowId) ? currentTab.windowId : row.windowId;

        if (!isInvestGptUrl(row.url)) {
          row.action = 'skipped_outside_invest';
          row.reason = `tab_url_not_inwestycje_gpt:${row.url || 'empty'}`;
          resultsByKey.set(target.key, row);
          pendingKeys.delete(target.key);
          console.warn('[reset-scan-start] Skip process (url outside inwestycje GPT)', {
            runId: row.runId || '',
            tabId: row.tabId,
            reason: row.reason
          });
          continue;
        }

        console.log('[reset-scan-start] Context prepared for detection', {
          runId: row.runId || '',
          tabId: row.tabId,
          windowId: row.windowId
        });

        let extraction = await extractLastUserMessageFromTab(row.tabId);
        if (!extraction.success) {
          console.warn('[reset-scan-start] Extraction failed, retrying', {
            runId: row.runId || '',
            tabId: row.tabId,
            error: extraction.error || 'unknown_error'
          });
          await sleep(350);
          extraction = await extractLastUserMessageFromTab(row.tabId);
        }
        if (!extraction.success) {
          row.action = 'detect_failed';
          row.reason = extraction.error || 'extract_last_user_message_failed';
          resultsByKey.set(target.key, row);
          console.warn('[reset-scan-start] Extraction failed after retry', {
            runId: row.runId || '',
            tabId: row.tabId,
            reason: row.reason
          });
          await sleep(250);
          continue;
        }

        row.userMessageCount = Number.isInteger(extraction.count) ? extraction.count : 0;
        row.assistantMessageCount = Number.isInteger(extraction.assistantCount) ? extraction.assistantCount : 0;
        row.responseBlockCount = row.assistantMessageCount;
        row.lastUserMessageLength = typeof extraction.text === 'string' ? extraction.text.length : 0;
        console.log('[reset-scan-start] Extraction success', {
          runId: row.runId || '',
          tabId: row.tabId,
          userMessageCount: row.userMessageCount,
          assistantMessageCount: row.assistantMessageCount,
          lastUserMessageLength: row.lastUserMessageLength,
          lastUserMessagePreview: truncateForLog(extraction.text, 220)
        });

        const lastUserText = typeof extraction.text === 'string' ? extraction.text.trim() : '';
        let detection = null;
        let directDetectionReason = '';

        if (lastUserText.length > 0) {
          const directDetection = detectPromptIndexFromMessage(lastUserText, catalog);
          if (directDetection.matched && Number.isInteger(directDetection.index)) {
            detection = directDetection;
            console.log('[reset-scan-start] Direct detection matched', {
              runId: row.runId || '',
              tabId: row.tabId,
              method: directDetection.method || 'unknown',
              index: directDetection.index,
              promptNumber: directDetection.promptNumber,
              stageName: directDetection.stageName || '',
              signatureLength: typeof directDetection.messageSignature === 'string'
                ? directDetection.messageSignature.length
                : null,
              signaturePreview: truncateForLog(directDetection.messageSignatureRaw || directDetection.messageSignature || '', 140)
            });
          } else {
            directDetectionReason = directDetection.reason || 'signature_not_found';
            console.log('[reset-scan-start] Direct detection failed', {
              runId: row.runId || '',
              tabId: row.tabId,
              reason: directDetectionReason,
              signatureLength: typeof directDetection.messageSignature === 'string'
                ? directDetection.messageSignature.length
                : null,
              signaturePreview: truncateForLog(directDetection.messageSignatureRaw || directDetection.messageSignature || '', 140)
            });
          }
        } else {
          console.log('[reset-scan-start] Direct detection skipped (empty last user text)', {
            runId: row.runId || '',
            tabId: row.tabId
          });
        }

        let recentMatch = null;
        if (promptRecords.length > 0) {
          const recent = await extractRecentUserPromptsFromTab(row.tabId, 4000);
          const recentEntries = Array.isArray(recent?.messageMeta) && recent.messageMeta.length > 0
            ? recent.messageMeta
            : (Array.isArray(recent?.messages) ? recent.messages : []);
          recentMatch = detectLastPromptMatch(recentEntries, promptRecords);
          console.log('[reset-scan-start] Recent history fallback evaluated', {
            runId: row.runId || '',
            tabId: row.tabId,
            recentMessageCount: recentEntries.length,
            recentUrl: truncateForLog(recent?.url || '', 140),
            matched: !!recentMatch,
            matchedMethod: recentMatch?.method || '',
            matchedIndex: Number.isInteger(recentMatch?.index) ? recentMatch.index : null,
            matchedPromptNumber: Number.isInteger(recentMatch?.promptNumber) ? recentMatch.promptNumber : null,
            matchedHasAssistantReply: typeof recentMatch?.hasAssistantReplyAfter === 'boolean'
              ? recentMatch.hasAssistantReplyAfter
              : null,
            matchedSignaturePreview: truncateForLog(recentMatch?.signature || '', 140)
          });

          if (detection && Number.isInteger(detection.index)) {
            if (recentMatch && Number.isInteger(recentMatch.index) && recentMatch.index === detection.index) {
              detection.hasAssistantReplyAfter = recentMatch.hasAssistantReplyAfter;
              if (typeof recentMatch.signature === 'string' && recentMatch.signature) {
                detection.messageSignature = recentMatch.signature;
              }
            }
          } else if (recentMatch && Number.isInteger(recentMatch.index)) {
            const promptNumber = Number.isInteger(recentMatch.promptNumber)
              ? recentMatch.promptNumber
              : (recentMatch.index + 1);
            detection = {
              matched: true,
              index: recentMatch.index,
              promptNumber,
              stageName: STAGE_NAMES_COMPANY[recentMatch.index] || `Prompt ${promptNumber}`,
              method: typeof recentMatch.method === 'string' && recentMatch.method
                ? `recent_${recentMatch.method}`
                : 'recent_match',
              messageSignature: typeof recentMatch.signature === 'string'
                ? recentMatch.signature
                : '',
              hasAssistantReplyAfter: recentMatch.hasAssistantReplyAfter
            };
            console.log('[reset-scan-start] Detection recovered from recent history', {
              runId: row.runId || '',
              tabId: row.tabId,
              index: detection.index,
              promptNumber: detection.promptNumber,
              stageName: detection.stageName || '',
              method: detection.method || '',
              hasAssistantReplyAfter: typeof detection.hasAssistantReplyAfter === 'boolean'
                ? detection.hasAssistantReplyAfter
                : null
            });
          }
        }

        if (!detection || !Number.isInteger(detection.index)) {
          if (lastUserText.length === 0) {
            row.action = 'detect_failed';
            row.reason = 'empty_user_message';
          } else {
            row.action = 'detect_failed';
            row.reason = directDetectionReason || 'signature_not_found';
          }
          resultsByKey.set(target.key, row);
          // Signature matching may fail during early page hydration; retry in next pass.
          console.log('[reset-scan-start] Detection unresolved for process (will retry)', {
            pass: passCount,
            runId: row.runId || '',
            tabId: row.tabId,
            action: row.action,
            reason: row.reason,
            attempts: row.attempts
          });
          await sleep(250);
          continue;
        }

        matchedKeys.add(target.key);
        row.detectedPromptIndex = detection.index;
        row.detectedPromptNumber = detection.promptNumber;
        row.detectedStageName = detection.stageName;
        row.detectedMethod = typeof detection.method === 'string' ? detection.method : '';
        row.detectedSignature = typeof detection.messageSignature === 'string'
          ? detection.messageSignature.slice(0, 180)
          : '';
        row.detectedHasAssistantReply = typeof detection.hasAssistantReplyAfter === 'boolean'
          ? detection.hasAssistantReplyAfter
          : null;
        const shouldAdvancePrompt = row.detectedHasAssistantReply !== false;
        row.nextStartIndex = computeNextResumeIndex(
          detection.index,
          PROMPTS_COMPANY.length,
          shouldAdvancePrompt
        );
        if (Number.isInteger(row.progressPromptNumber) && Number.isInteger(row.detectedPromptNumber)) {
          const delta = row.detectedPromptNumber - row.progressPromptNumber;
          row.stageDelta = delta;
          row.stageConsistency = Math.abs(delta) <= 1 ? 'ok' : 'drift';
        }
        console.log('[reset-scan-start] Detection resolved', {
          runId: row.runId || '',
          tabId: row.tabId,
          detectedPromptIndex: row.detectedPromptIndex,
          detectedPromptNumber: row.detectedPromptNumber,
          detectedStageName: row.detectedStageName,
          detectedMethod: row.detectedMethod,
          detectedHasAssistantReply: row.detectedHasAssistantReply,
          nextStartIndex: row.nextStartIndex,
          progressPromptNumber: row.progressPromptNumber,
          stageDelta: row.stageDelta,
          stageConsistency: row.stageConsistency || ''
        });

        if (!Number.isInteger(row.nextStartIndex)) {
          row.action = 'final_stage_already_sent';
          row.reason = 'already_at_last_stage';
          await markProcessCompletedAfterFinalStage(row, 'already_at_last_stage');
          resultsByKey.set(target.key, row);
          pendingKeys.delete(target.key);
          console.log('[reset-scan-start] Final stage already sent for tab', {
            runId: row.runId || '',
            tabId: row.tabId,
            detectedPromptNumber: row.detectedPromptNumber,
            nextStartIndex: row.nextStartIndex
          });
          await sleep(250);
          continue;
        }

        row.action = 'ready_to_start';
        row.reason = row.detectedHasAssistantReply === false
          ? 'retry_same_prompt_no_assistant_reply'
          : 'ready_to_start';
        resultsByKey.set(target.key, row);
        pendingKeys.delete(target.key);
        console.log('[reset-scan-start] Process queued for sequential start', {
          runId: row.runId || '',
          tabId: row.tabId,
          nextStartIndex: row.nextStartIndex,
          startPromptNumber: row.nextStartIndex + 1,
          reason: row.reason
        });
        await sleep(250);
      }

      if (
        pendingKeys.size > 0 &&
        passCount < maxPasses &&
        (Date.now() - startedAt) < maxRuntimeMs
      ) {
        console.log('[reset-scan-start] Pass delay', {
          pass: passCount,
          pending: pendingKeys.size,
          delayMs: passDelayMs
        });
        await sleep(passDelayMs);
      }
    }

    const runtimeLimitHit = (Date.now() - startedAt) >= maxRuntimeMs;
    const passLimitHit = passCount >= maxPasses;
    if (pendingKeys.size > 0) {
      for (const key of pendingKeys) {
        const row = resultsByKey.get(key);
        if (!row) continue;
        const suffix = runtimeLimitHit
          ? 'runtime_limit_reached'
          : (passLimitHit ? 'pass_limit_reached' : 'retry_budget_exhausted');
        row.reason = row.reason ? `${row.reason}|${suffix}` : suffix;
        row.retryExhausted = true;
        row.action = 'detect_failed';
        resultsByKey.set(key, row);
      }
    }

    // Fallback: ensure remaining company processes are resumed when signature detection failed.
    for (const target of scanTargets) {
      const row = resultsByKey.get(target.key);
      if (!row || row.action !== 'detect_failed') continue;

      const fallbackStartIndex = computeFallbackResumeStartIndex(row);
      if (Number.isInteger(fallbackStartIndex)) {
        row.nextStartIndex = fallbackStartIndex;
        row.action = 'ready_to_start';
        row.reason = 'fallback_progress_resume';
        if (!row.detectedMethod) row.detectedMethod = 'progress_counter_fallback';
        if (!Number.isInteger(row.detectedPromptNumber) && Number.isInteger(row.progressPromptNumber)) {
          row.detectedPromptNumber = row.progressPromptNumber;
          row.detectedPromptIndex = Math.max(0, row.progressPromptNumber - 1);
          row.detectedStageName = STAGE_NAMES_COMPANY[row.detectedPromptIndex] || `Prompt ${row.detectedPromptNumber}`;
        }
        resultsByKey.set(target.key, row);
        console.log('[reset-scan-start] Fallback resume queued', {
          runId: row.runId || '',
          tabId: row.tabId,
          fallbackStartIndex,
          startPromptNumber: fallbackStartIndex + 1,
          progressPromptNumber: row.progressPromptNumber
        });
        continue;
      }

      row.action = 'final_stage_already_sent';
      row.reason = 'fallback_final_stage_completed';
      await markProcessCompletedAfterFinalStage(row, 'fallback_final_stage_completed');
      resultsByKey.set(target.key, row);
      console.log('[reset-scan-start] Fallback detected completed process', {
        runId: row.runId || '',
        tabId: row.tabId,
        progressPromptNumber: row.progressPromptNumber
      });
    }

    // Start phase: execute queued starts sequentially after full scan pass.
    // This avoids interleaving scan/start on the same pass and makes behavior deterministic.
    const startQueue = scanTargets
      .map((target) => {
        const row = resultsByKey.get(target.key);
        if (!row || row.action !== 'ready_to_start') return null;
        return row;
      })
      .filter(Boolean);
    console.log('[reset-scan-start] Start queue prepared', {
      queueSize: startQueue.length,
      queue: startQueue.map((row) => ({
        runId: row.runId || '',
        tabId: row.tabId,
        windowId: row.windowId,
        nextStartIndex: row.nextStartIndex,
        startPromptNumber: Number.isInteger(row.nextStartIndex) ? (row.nextStartIndex + 1) : null,
        detectedPromptNumber: row.detectedPromptNumber,
        detectedMethod: row.detectedMethod
      }))
    });

    for (const row of startQueue) {
      if (!Number.isInteger(row.tabId) || !Number.isInteger(row.nextStartIndex)) continue;

      const autoStartTitle = `Auto Start: Prompt ${row.nextStartIndex + 1}`;
      console.log('[reset-scan-start] Starting process from queue', {
        runId: row.runId || '',
        tabId: row.tabId,
        windowId: row.windowId,
        nextStartIndex: row.nextStartIndex,
        autoStartTitle
      });
      const startResult = await resumeFromStageOnTab(row.tabId, row.windowId, row.nextStartIndex, {
        processTitle: autoStartTitle,
        detach: true,
        // Tab is already hard-reloaded in the detection phase.
        reloadBeforeResume: false
      });

      if (startResult.success) {
        startedKeys.add(row.key);
        row.action = 'started';
        row.reason = startResult.detached ? 'start_dispatched' : 'start_started';
        console.log('[reset-scan-start] Start success', {
          runId: row.runId || '',
          tabId: row.tabId,
          processId: startResult.processId || '',
          detached: !!startResult.detached,
          action: row.action
        });
      } else {
        row.action = startResult?.error === 'reload_failed' ? 'reload_failed' : 'start_failed';
        row.reason = startResult.error || 'start_failed';
        console.warn('[reset-scan-start] Start failed', {
          runId: row.runId || '',
          tabId: row.tabId,
          action: row.action,
          reason: row.reason
        });
      }
      resultsByKey.set(row.key, row);
      await sleep(250);
    }

    const results = orderedResultKeys.map((key) => {
      const row = resultsByKey.get(key);
      if (row) return row;
      return {
        key,
        runId: '',
        tabId: null,
        windowId: null,
        title: '',
        url: '',
        userMessageCount: null,
        assistantMessageCount: null,
        responseBlockCount: null,
        detectedPromptIndex: null,
        detectedPromptNumber: null,
        detectedStageName: null,
        nextStartIndex: null,
        action: 'detect_failed',
        reason: runtimeLimitHit ? 'runtime_limit_reached_before_processing' : 'not_processed'
      };
    });

    const startedCount = startedKeys.size;
    const actionCounts = results.reduce((acc, row) => {
      const key = typeof row?.action === 'string' && row.action
        ? row.action
        : 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const promptBlocks = results.reduce((sum, row) => (
      sum + (Number.isInteger(row?.userMessageCount) ? row.userMessageCount : 0)
    ), 0);
    const responseBlocks = results.reduce((sum, row) => (
      sum + (
        Number.isInteger(row?.responseBlockCount)
          ? row.responseBlockCount
          : (Number.isInteger(row?.assistantMessageCount) ? row.assistantMessageCount : 0)
      )
    ), 0);
    const detectedPrompts = results.reduce((sum, row) => (
      sum + (Number.isInteger(row?.detectedPromptNumber) ? 1 : 0)
    ), 0);
    const summary = {
      started: actionCounts.started || 0,
      detect_failed: actionCounts.detect_failed || 0,
      reload_failed: actionCounts.reload_failed || 0,
      skipped_non_company: actionCounts.skipped_non_company || 0,
      skipped_outside_invest: actionCounts.skipped_outside_invest || 0,
      final_stage_completed: actionCounts.final_stage_already_sent || 0,
      start_failed: actionCounts.start_failed || 0,
      reload_ok: preparedKeys.size,
      reload_total: scanTargets.length,
      prompt_blocks: promptBlocks,
      response_blocks: responseBlocks,
      detected_prompts: detectedPrompts
    };
    console.log('[reset-scan-start] Summary', {
      scope,
      maxPasses,
      maxRuntimeMs,
      passCount,
      pendingAfterLoop: pendingKeys.size,
      scannedTabs: scanTargets.length,
      matchedTabs: matchedKeys.size,
      startedTabs: startedCount,
      requestedProcesses: activeProcesses.length,
      summary,
      actionCounts
    });
    results.forEach((item) => {
      console.log('[reset-scan-start] Process result', item);
    });

    return {
      success: true,
      scope,
      scannedTabs: scanTargets.length,
      matchedTabs: matchedKeys.size,
      startedTabs: startedCount,
      // Legacy alias for compatibility.
      resumedTabs: startedCount,
      requestedProcesses: activeProcesses.length,
      eligibleProcesses: scanTargets.length,
      passCount,
      maxPasses,
      maxRuntimeMs,
      pendingAfterLoop: pendingKeys.size,
      summary,
      resetSummary,
      results
    };
  } catch (error) {
    const summary = {
      started: 0,
      detect_failed: 0,
      reload_failed: 0,
      skipped_non_company: 0,
      skipped_outside_invest: 0,
      final_stage_completed: 0,
      start_failed: 0,
      reload_ok: 0,
      reload_total: 0,
      prompt_blocks: 0,
      response_blocks: 0,
      detected_prompts: 0
    };
    return {
      success: false,
      scannedTabs: 0,
      matchedTabs: 0,
      startedTabs: 0,
      resumedTabs: 0,
      requestedProcesses: 0,
      eligibleProcesses: 0,
      summary,
      scope: RESUME_ALL_SCOPE_ACTIVE_COMPANY_INVEST,
      results: [],
      error: error?.message || String(error)
    };
  }
}

const SIGNATURE_SENTENCE_LIMIT = 2;
const SIGNATURE_MIN_LENGTH = 60;
const SIGNATURE_COMPARE_LIMIT = 220;

function safeAlert(message) {
  if (typeof alert === 'function') {
    try {
      alert(message);
      return;
    } catch (error) {
      // Ignore and fallback to console warning.
    }
  }
  console.warn('[alert]', message);
}

function compactWhitespace(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\s+/g, ' ').trim();
}

function isChatGptUrl(url) {
  if (typeof url !== 'string') return false;
  const candidate = url.trim();
  if (!candidate) return false;
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    return CHAT_GPT_HOSTS.has(parsed.hostname.toLowerCase());
  } catch (error) {
    return candidate.includes('chatgpt.com') || candidate.includes('chat.openai.com');
  }
}

function normalizeChatConversationUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return '';
  const candidate = rawUrl.trim();
  if (!candidate) return '';
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    const host = parsed.hostname.toLowerCase();
    if (!CHAT_GPT_HOSTS.has(host)) return '';
    if (!parsed.pathname || parsed.pathname === '/') return '';
    return parsed.toString();
  } catch (error) {
    return '';
  }
}

function isInvestGptUrl(url) {
  if (typeof url !== 'string') return false;
  const compactUrl = url.trim();
  if (!compactUrl) return false;

  try {
    const parsed = new URL(compactUrl);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (!CHAT_GPT_HOSTS.has(parsed.hostname.toLowerCase())) return false;
    const normalizedPath = (parsed.pathname || '').replace(/\/+$/, '');
    if (!normalizedPath) return false;
    if (normalizedPath === INVEST_GPT_PATH_BASE) return true;
    return normalizedPath.startsWith(`${INVEST_GPT_PATH_BASE}/`);
  } catch (error) {
    if (!compactUrl.startsWith(INVEST_GPT_URL_BASE)) return false;
    if (compactUrl.length === INVEST_GPT_URL_BASE.length) return true;
    const separator = compactUrl.charAt(INVEST_GPT_URL_BASE.length);
    return separator === '/' || separator === '?' || separator === '#';
  }
}

function getTabEffectiveUrl(tab) {
  if (!tab || typeof tab !== 'object') return '';
  const url = typeof tab.url === 'string' ? tab.url.trim() : '';
  if (url) return url;
  const pendingUrl = typeof tab.pendingUrl === 'string' ? tab.pendingUrl.trim() : '';
  return pendingUrl;
}

function compareTabsByWindowAndIndex(left, right) {
  const leftWindow = Number.isInteger(left?.windowId) ? left.windowId : Number.MAX_SAFE_INTEGER;
  const rightWindow = Number.isInteger(right?.windowId) ? right.windowId : Number.MAX_SAFE_INTEGER;
  if (leftWindow !== rightWindow) return leftWindow - rightWindow;
  const leftIndex = Number.isInteger(left?.index) ? left.index : Number.MAX_SAFE_INTEGER;
  const rightIndex = Number.isInteger(right?.index) ? right.index : Number.MAX_SAFE_INTEGER;
  if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  const leftId = Number.isInteger(left?.id) ? left.id : Number.MAX_SAFE_INTEGER;
  const rightId = Number.isInteger(right?.id) ? right.id : Number.MAX_SAFE_INTEGER;
  return leftId - rightId;
}

function compareProcessesForRestore(left, right) {
  const leftWindow = Number.isInteger(left?.windowId) ? left.windowId : Number.MAX_SAFE_INTEGER;
  const rightWindow = Number.isInteger(right?.windowId) ? right.windowId : Number.MAX_SAFE_INTEGER;
  if (leftWindow !== rightWindow) return leftWindow - rightWindow;

  const leftStartedAt = Number.isInteger(left?.startedAt)
    ? left.startedAt
    : (Number.isInteger(left?.timestamp) ? left.timestamp : 0);
  const rightStartedAt = Number.isInteger(right?.startedAt)
    ? right.startedAt
    : (Number.isInteger(right?.timestamp) ? right.timestamp : 0);
  if (leftStartedAt !== rightStartedAt) return leftStartedAt - rightStartedAt;

  return String(left?.id || '').localeCompare(String(right?.id || ''));
}

async function restoreProcessWindows(options = {}) {
  const origin = typeof options?.origin === 'string' && options.origin.trim()
    ? options.origin.trim()
    : 'restore-process-windows';

  const snapshot = await getProcessSnapshot();
  const activeProcesses = snapshot
    .filter((process) => !isClosedProcessStatus(process?.status))
    .sort(compareProcessesForRestore);
  const activeProcessByTabId = new Map();
  const activeProcessByWindowId = new Map();
  activeProcesses.forEach((process) => {
    if (Number.isInteger(process?.tabId) && !activeProcessByTabId.has(process.tabId)) {
      activeProcessByTabId.set(process.tabId, process);
    }
    if (Number.isInteger(process?.windowId) && !activeProcessByWindowId.has(process.windowId)) {
      activeProcessByWindowId.set(process.windowId, process);
    }
  });

  const tabsRaw = await chrome.tabs.query({});
  const investTabs = tabsRaw
    .filter((tab) => isInvestGptUrl(getTabEffectiveUrl(tab)))
    .sort(compareTabsByWindowAndIndex);

  if (investTabs.length === 0 && activeProcesses.length === 0) {
    return {
      success: true,
      origin,
      requested: 0,
      restored: 0,
      opened: 0,
      failed: 0,
      skipped: 0,
      results: []
    };
  }

  const targets = [];
  const handledContextKeys = new Set();
  let skipped = 0;

  investTabs.forEach((tab) => {
    const tabId = Number.isInteger(tab?.id) ? tab.id : null;
    const windowId = Number.isInteger(tab?.windowId) ? tab.windowId : null;
    if (!Number.isInteger(tabId) || !Number.isInteger(windowId)) return;
    const contextKey = `tab:${tabId}`;
    if (handledContextKeys.has(contextKey)) {
      skipped += 1;
      return;
    }
    handledContextKeys.add(contextKey);
    targets.push({
      source: 'tab_scan',
      tabId,
      windowId,
      url: getTabEffectiveUrl(tab) || ''
    });
  });

  activeProcesses.forEach((process) => {
    const processTabId = Number.isInteger(process?.tabId) ? process.tabId : null;
    const processWindowId = Number.isInteger(process?.windowId) ? process.windowId : null;
    if (!Number.isInteger(processTabId) && !Number.isInteger(processWindowId)) return;
    const contextKey = Number.isInteger(processTabId)
      ? `tab:${processTabId}`
      : `window:${processWindowId}`;
    if (handledContextKeys.has(contextKey)) {
      skipped += 1;
      return;
    }
    handledContextKeys.add(contextKey);
    targets.push({
      source: 'process_context',
      tabId: processTabId,
      windowId: processWindowId,
      url: typeof process?.chatUrl === 'string' ? process.chatUrl.trim() : '',
      process
    });
  });

  const results = [];
  let restored = 0;
  let failed = 0;

  for (const target of targets) {
    const targetTabId = Number.isInteger(target?.tabId) ? target.tabId : null;
    const targetWindowIdInput = Number.isInteger(target?.windowId) ? target.windowId : null;
    const tabProcess = Number.isInteger(targetTabId) ? activeProcessByTabId.get(targetTabId) : null;
    const windowProcess = Number.isInteger(targetWindowIdInput) ? activeProcessByWindowId.get(targetWindowIdInput) : null;
    const process = tabProcess || windowProcess || target?.process || null;
    const runId = process?.id ? String(process.id) : '';

    let tab = targetTabId ? await getTabByIdSafe(targetTabId) : null;
    if (tab && !isInvestGptUrl(getTabEffectiveUrl(tab))) {
      tab = null;
    }
    const targetWindowId = Number.isInteger(tab?.windowId) ? tab.windowId : targetWindowIdInput;

    let windowUpdated = false;
    let windowState = '';
    if (Number.isInteger(targetWindowId)) {
      try {
        const windowInfo = await chrome.windows.get(targetWindowId);
        windowState = typeof windowInfo?.state === 'string' ? windowInfo.state : '';
        const updatePayload = windowState && windowState !== 'normal'
          ? { state: 'normal', focused: true }
          : { focused: true };
        await chrome.windows.update(targetWindowId, updatePayload);
        windowUpdated = true;
      } catch (error) {
        // Keep going, tab activation may still work.
      }
    }

    if (!tab && Number.isInteger(targetWindowId)) {
      try {
        const tabsInWindow = await chrome.tabs.query({ windowId: targetWindowId });
        const investTab = tabsInWindow.find((candidate) => isInvestGptUrl(getTabEffectiveUrl(candidate)));
        if (investTab && Number.isInteger(investTab.id)) {
          tab = investTab;
          if (runId && process) {
            await upsertProcess(runId, {
              tabId: investTab.id,
              windowId: targetWindowId,
              chatUrl: getTabEffectiveUrl(investTab) || (typeof process?.chatUrl === 'string' ? process.chatUrl : '')
            });
          }
        }
      } catch (error) {
        // Ignore: no suitable tab found in this window.
      }
    }

    let tabActivated = false;
    if (Number.isInteger(tab?.id)) {
      const restoreUngroup = await ungroupTabsById([tab.id], {
        origin: 'restore-process-windows'
      });
      if (!restoreUngroup.ok && restoreUngroup.reason !== 'already_ungrouped') {
        console.warn('[restore] ungroup tab failed:', {
          tabId: tab.id,
          reason: restoreUngroup.reason,
          error: restoreUngroup.error || ''
        });
      }
      try {
        await chrome.tabs.update(tab.id, { active: true });
        tabActivated = true;
      } catch (error) {
        // Ignore, report as failed below if needed.
      }
    }

    if (windowUpdated || tabActivated) {
      restored += 1;
      results.push({
        runId,
        action: 'restored_existing',
        source: target.source || 'unknown',
        tabId: Number.isInteger(tab?.id) ? tab.id : targetTabId,
        windowId: Number.isInteger(tab?.windowId) ? tab.windowId : targetWindowId,
        url: Number.isInteger(tab?.id) ? (getTabEffectiveUrl(tab) || '') : (target?.url || ''),
        windowStateBefore: windowState || null
      });
    } else {
      failed += 1;
      results.push({
        runId,
        action: 'failed_restore',
        source: target.source || 'unknown',
        tabId: targetTabId,
        windowId: targetWindowId,
        reason: 'missing_or_unreachable_process_context'
      });
    }

    await sleep(2000);
  }

  return {
    success: true,
    origin,
    requested: targets.length,
    restored,
    opened: 0,
    failed,
    skipped,
    results
  };
}

function waitForTabCompleteWithTimeout(tabId, timeoutMs = 12000) {
  return new Promise((resolve) => {
    if (!Number.isInteger(tabId)) {
      resolve(false);
      return;
    }
    let settled = false;
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);

    waitForTabComplete(tabId)
      .then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(true);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(false);
      });
  });
}

function requestTabReload(tabId, reloadProperties = {}) {
  return new Promise((resolve) => {
    if (!Number.isInteger(tabId)) {
      resolve({ ok: false, reason: 'invalid_tab_id' });
      return;
    }

    try {
      chrome.tabs.reload(tabId, reloadProperties, () => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            reason: 'reload_command_failed',
            error: chrome.runtime.lastError.message || 'runtime_last_error'
          });
          return;
        }
        resolve({ ok: true, reason: 'reload_command_sent' });
      });
    } catch (error) {
      resolve({
        ok: false,
        reason: 'reload_exception',
        error: error?.message || String(error)
      });
    }
  });
}

function requestTabNavigate(tabId, url) {
  return new Promise((resolve) => {
    if (!Number.isInteger(tabId)) {
      resolve({ ok: false, reason: 'invalid_tab_id' });
      return;
    }
    if (typeof url !== 'string' || !url.trim()) {
      resolve({ ok: false, reason: 'invalid_url' });
      return;
    }

    try {
      chrome.tabs.update(tabId, { url: url.trim() }, () => {
        if (chrome.runtime.lastError) {
          resolve({
            ok: false,
            reason: 'navigate_command_failed',
            error: chrome.runtime.lastError.message || 'runtime_last_error'
          });
          return;
        }
        resolve({ ok: true, reason: 'navigate_command_sent' });
      });
    } catch (error) {
      resolve({
        ok: false,
        reason: 'navigate_exception',
        error: error?.message || String(error)
      });
    }
  });
}

function waitForTabReloadCycle(tabId, timeoutMs = AUTO_RECOVERY_RELOAD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!Number.isInteger(tabId)) {
      resolve({ ok: false, reason: 'invalid_tab_id', sawLoading: false });
      return;
    }

    let settled = false;
    let sawLoading = false;
    const startedAt = Date.now();

    const finish = (ok, details = {}) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve({
        ok,
        sawLoading,
        elapsedMs: Date.now() - startedAt,
        ...details
      });
    };

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || settled) return;
      if (changeInfo.status === 'loading') {
        sawLoading = true;
      }
      if (changeInfo.status === 'complete' && sawLoading) {
        finish(true, { reason: 'reload_completed', source: 'onUpdated' });
      }
    };

    chrome.tabs.onUpdated.addListener(onUpdated);

    (async () => {
      while (!settled && (Date.now() - startedAt) < timeoutMs) {
        const tabInfo = await getTabByIdSafe(tabId);
        if (!tabInfo) {
          finish(false, { reason: 'tab_not_found' });
          return;
        }
        if (tabInfo.status === 'loading') {
          sawLoading = true;
        }
        if (tabInfo.status === 'complete' && sawLoading) {
          finish(true, { reason: 'reload_completed', source: 'poll' });
          return;
        }
        await sleep(250);
      }

      if (!settled) {
        finish(false, {
          reason: sawLoading ? 'reload_complete_timeout' : 'reload_not_started'
        });
      }
    })();
  });
}

async function forceReloadTab(tabId, options = {}) {
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : AUTO_RECOVERY_RELOAD_TIMEOUT_MS;
  const bypassCache = options.bypassCache !== false;
  const reloadRequest = await requestTabReload(tabId, { bypassCache });

  if (reloadRequest.ok) {
    const reloadCycle = await waitForTabReloadCycle(tabId, timeoutMs);
    if (reloadCycle.ok) {
      return {
        ok: true,
        method: 'tabs.reload',
        fallbackUsed: false,
        ...reloadCycle
      };
    }
  }

  const tabInfo = await getTabByIdSafe(tabId);
  const tabUrl = getTabEffectiveUrl(tabInfo);
  if (!tabUrl) {
    return {
      ok: false,
      method: 'tabs.reload',
      fallbackUsed: false,
      reason: reloadRequest.ok ? 'reload_failed_no_tab_url' : reloadRequest.reason,
      error: reloadRequest.error || ''
    };
  }

  const navigateRequest = await requestTabNavigate(tabId, tabUrl);
  if (!navigateRequest.ok) {
    return {
      ok: false,
      method: 'tabs.update',
      fallbackUsed: true,
      reason: navigateRequest.reason,
      error: navigateRequest.error || '',
      primaryReloadReason: reloadRequest.reason
    };
  }

  const completed = await waitForTabCompleteWithTimeout(tabId, timeoutMs);
  if (completed) {
    return {
      ok: true,
      method: 'tabs.update',
      fallbackUsed: true,
      reason: 'navigate_completed',
      primaryReloadReason: reloadRequest.reason
    };
  }

  return {
    ok: false,
    method: 'tabs.update',
    fallbackUsed: true,
    reason: 'navigate_complete_timeout',
    primaryReloadReason: reloadRequest.reason
  };
}

async function prepareTabForDetection(tabId, windowId = null) {
  if (!Number.isInteger(tabId)) return false;
  try {
    if (Number.isInteger(windowId)) {
      await chrome.windows.update(windowId, { focused: true });
    }
  } catch (error) {
    // Best effort only.
  }

  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch (error) {
    // Best effort only.
  }

  try {
    const tabInfo = await chrome.tabs.get(tabId);
    if (tabInfo?.discarded) {
      await forceReloadTab(tabId, { timeoutMs: 12000 });
    }
  } catch (error) {
    // Ignore and continue.
  }

  await waitForTabCompleteWithTimeout(tabId, 12000);
  await sleep(250);
  return true;
}

async function prepareTabForResume(tabId, windowId = null, options = {}) {
  if (!Number.isInteger(tabId)) {
    return { ok: false, reason: 'invalid_tab_id' };
  }

  const prepared = await prepareTabForDetection(tabId, windowId);
  if (!prepared) {
    return { ok: false, reason: 'prepare_detection_failed' };
  }

  const timeoutMs = Number.isInteger(options?.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : 15000;
  const bypassCache = options?.bypassCache !== false;

  const reloadResult = await forceReloadTab(tabId, {
    timeoutMs,
    bypassCache
  });
  if (!reloadResult?.ok) {
    return {
      ok: false,
      reason: reloadResult?.reason || 'reload_failed',
      error: reloadResult?.error || '',
      reloadResult
    };
  }

  const completed = await waitForTabCompleteWithTimeout(tabId, timeoutMs);
  if (!completed) {
    return {
      ok: false,
      reason: 'reload_complete_timeout',
      reloadResult
    };
  }

  await sleep(250);
  return {
    ok: true,
    reason: 'prepared',
    reloadResult
  };
}

function normalizeSignatureText(text) {
  return compactWhitespace(text)
    .toLowerCase()
    .replace(/[`"'“”‘’]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLeadingSentences(text, limit = SIGNATURE_SENTENCE_LIMIT) {
  const compact = compactWhitespace(text);
  if (!compact) return [];

  const candidates = compact.match(/[^.!?\n]+[.!?]+|[^.!?\n]+$/g) || [];
  const sentences = [];
  for (const candidate of candidates) {
    const sentence = compactWhitespace(candidate);
    if (!sentence) continue;
    sentences.push(sentence);
    if (sentences.length >= limit) break;
  }

  if (sentences.length === 0) {
    const fallback = compact.slice(0, 240);
    return fallback ? [fallback] : [];
  }
  return sentences;
}

function buildTwoSentenceSignature(text) {
  if (typeof extractLastTwoSentences === 'function' && typeof normalizeSentenceSignature === 'function') {
    const raw = extractLastTwoSentences(text);
    return normalizeSentenceSignature(raw);
  }
  const sentences = extractLeadingSentences(text, SIGNATURE_SENTENCE_LIMIT);
  if (sentences.length === 0) return '';
  return normalizeSignatureText(sentences.join(' '));
}

function buildPromptSignatureRecords(prompts) {
  return (Array.isArray(prompts) ? prompts : [])
    .map((promptText, index) => {
      const signature = buildTwoSentenceSignature(promptText);
      const normalizedPrefix = normalizeSignatureText(promptText).slice(0, 360);
      return {
        index,
        promptNumber: index + 1,
        signature,
        normalizedPrefix
      };
    })
    .filter((entry) => entry.signature.length > 0);
}

function sharedPrefixLength(left, right, maxLen = SIGNATURE_COMPARE_LIMIT) {
  if (!left || !right) return 0;
  const limit = Math.min(left.length, right.length, maxLen);
  let i = 0;
  while (i < limit && left[i] === right[i]) {
    i += 1;
  }
  return i;
}

function matchPromptBySignature(signature, normalizedPromptText, promptRecords) {
  if (!signature || signature.length < SIGNATURE_MIN_LENGTH) return null;

  let best = null;
  for (const prompt of promptRecords) {
    if (!prompt || !prompt.signature) continue;
    if (signature === prompt.signature) {
      return {
        index: prompt.index,
        promptNumber: prompt.promptNumber,
        method: 'exact_2_sentence',
        score: 10000
      };
    }

    const signaturePrefix = sharedPrefixLength(signature, prompt.signature, SIGNATURE_COMPARE_LIMIT);
    let score = signaturePrefix >= SIGNATURE_MIN_LENGTH
      ? (5000 + signaturePrefix)
      : 0;

    const textPrefix = sharedPrefixLength(normalizedPromptText, prompt.normalizedPrefix, 320);
    if (textPrefix >= 120) {
      score = Math.max(score, 2500 + textPrefix);
    }

    if (score > 0 && (!best || score > best.score)) {
      best = {
        index: prompt.index,
        promptNumber: prompt.promptNumber,
        method: score >= 5000 ? 'prefix_2_sentence' : 'prefix_prompt',
        score
      };
    }
  }

  return best;
}

function getProgressPromptIndex(process) {
  if (Number.isInteger(process?.currentPrompt) && process.currentPrompt > 0) {
    return process.currentPrompt - 1;
  }
  if (Number.isInteger(process?.stageIndex) && process.stageIndex >= 0) {
    return process.stageIndex;
  }
  return null;
}

async function ensureCompanyPromptsReady() {
  if (Array.isArray(PROMPTS_COMPANY) && PROMPTS_COMPANY.length > 0) {
    return true;
  }
  await loadPrompts();
  return Array.isArray(PROMPTS_COMPANY) && PROMPTS_COMPANY.length > 0;
}

function buildCompanyPromptChainForResume(startIndex) {
  if (!Array.isArray(PROMPTS_COMPANY) || PROMPTS_COMPANY.length === 0) {
    return [];
  }
  const boundedStart = Number.isInteger(startIndex)
    ? Math.max(0, Math.min(startIndex, PROMPTS_COMPANY.length))
    : 0;
  const chain = PROMPTS_COMPANY.slice(boundedStart);
  if (chain.length === 0) return [];

  const normalized = [...chain];
  if (typeof normalized[0] === 'string') {
    normalized[0] = normalized[0].replace('{{articlecontent}}', '').trim();
  }
  return normalized;
}

async function detectCompanyRecoveryPointFromLastMessage(tabId, fallbackPromptOffset = 0, catalog = null) {
  const safeFallbackOffset = Number.isInteger(fallbackPromptOffset) && fallbackPromptOffset >= 0
    ? fallbackPromptOffset
    : 0;
  if (!Number.isInteger(tabId)) {
    return {
      matched: false,
      reason: 'invalid_tab_id',
      promptOffset: safeFallbackOffset,
      remainingPrompts: []
    };
  }

  const promptsReady = await ensureCompanyPromptsReady();
  if (!promptsReady) {
    return {
      matched: false,
      reason: 'prompts_not_loaded',
      promptOffset: safeFallbackOffset,
      remainingPrompts: []
    };
  }

  const promptCatalog = Array.isArray(catalog) && catalog.length > 0
    ? catalog
    : buildPromptSignatureCatalog(PROMPTS_COMPANY);

  let extraction = await extractLastUserMessageFromTab(tabId);
  if (!extraction.success) {
    await sleep(350);
    extraction = await extractLastUserMessageFromTab(tabId);
  }

  if (!extraction.success) {
    return {
      matched: false,
      reason: extraction.error || 'extract_last_user_message_failed',
      promptOffset: safeFallbackOffset,
      remainingPrompts: []
    };
  }

  const lastUserText = typeof extraction.text === 'string' ? extraction.text.trim() : '';
  if (!lastUserText) {
    return {
      matched: false,
      reason: 'empty_user_message',
      promptOffset: safeFallbackOffset,
      remainingPrompts: []
    };
  }

  const detection = detectPromptIndexFromMessage(lastUserText, promptCatalog);
  if (!detection.matched || !Number.isInteger(detection.index)) {
    return {
      matched: false,
      reason: detection.reason || 'signature_not_found',
      promptOffset: safeFallbackOffset,
      remainingPrompts: []
    };
  }

  const promptCount = PROMPTS_COMPANY.length;
  let hasAssistantReplyAfter = null;
  const promptRecords = buildPromptSignatureRecords(PROMPTS_COMPANY);
  if (promptRecords.length > 0) {
    const recent = await extractRecentUserPromptsFromTab(tabId, 3500);
    const recentEntries = Array.isArray(recent?.messageMeta) && recent.messageMeta.length > 0
      ? recent.messageMeta
      : (Array.isArray(recent?.messages) ? recent.messages : []);
    const recentMatch = detectLastPromptMatch(recentEntries, promptRecords);
    if (recentMatch && Number.isInteger(recentMatch.index) && recentMatch.index === detection.index) {
      hasAssistantReplyAfter = recentMatch.hasAssistantReplyAfter;
    }
  }

  const shouldAdvancePrompt = hasAssistantReplyAfter !== false;
  const nextStartIndex = computeNextResumeIndex(
    detection.index,
    PROMPTS_COMPANY.length,
    shouldAdvancePrompt
  );
  const finalStageReached = !Number.isInteger(nextStartIndex);
  const promptOffset = finalStageReached
    ? PROMPTS_COMPANY.length
    : Math.max(0, Math.min(nextStartIndex, PROMPTS_COMPANY.length));
  const remainingPrompts = buildCompanyPromptChainForResume(promptOffset);

  return {
    matched: true,
    reason: 'matched',
    promptOffset,
    promptCount,
    finalStageReached,
    remainingPrompts,
    detection: {
      ...detection,
      hasAssistantReplyAfter
    }
  };
}

function alignExecutionStateWithDetectedPrompt(basePromptOffset, baseRemainingPrompts, detectedRecoveryPoint) {
  const safeBaseOffset = Number.isInteger(basePromptOffset) && basePromptOffset >= 0
    ? basePromptOffset
    : 0;
  const safeBaseRemaining = Array.isArray(baseRemainingPrompts) ? baseRemainingPrompts : [];

  if (!detectedRecoveryPoint?.matched || !Number.isInteger(detectedRecoveryPoint.promptOffset)) {
    return {
      applied: false,
      reason: detectedRecoveryPoint?.reason || 'no_detected_recovery_point',
      promptOffset: safeBaseOffset,
      remainingPrompts: safeBaseRemaining
    };
  }

  const detectedOffset = Math.max(0, detectedRecoveryPoint.promptOffset);
  if (detectedOffset <= safeBaseOffset) {
    return {
      applied: false,
      reason: 'detected_offset_not_ahead',
      promptOffset: safeBaseOffset,
      remainingPrompts: safeBaseRemaining
    };
  }

  if (Array.isArray(detectedRecoveryPoint.remainingPrompts)) {
    return {
      applied: true,
      reason: 'detected_catalog_alignment',
      promptOffset: detectedOffset,
      remainingPrompts: detectedRecoveryPoint.remainingPrompts
    };
  }

  const skipCount = detectedOffset - safeBaseOffset;
  return {
    applied: true,
    reason: 'detected_delta_alignment',
    promptOffset: detectedOffset,
    remainingPrompts: safeBaseRemaining.slice(skipCount)
  };
}

async function getTabByIdSafe(tabId) {
  if (!Number.isInteger(tabId)) return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab || null;
  } catch (error) {
    return null;
  }
}

async function resolveChatTabForProcess(process, message = {}) {
  const messageTabId = Number.isInteger(message?.tabId) ? message.tabId : null;
  const processTabId = Number.isInteger(process?.tabId) ? process.tabId : null;
  const candidateTabIds = [messageTabId, processTabId].filter((tabId, index, arr) => (
    Number.isInteger(tabId) && arr.indexOf(tabId) === index
  ));

  for (const tabId of candidateTabIds) {
    const tab = await getTabByIdSafe(tabId);
    if (tab && isChatGptUrl(getTabEffectiveUrl(tab))) {
      const directUngroup = await ungroupTabsById([tab.id], {
        origin: 'resume-direct-chat-tab'
      });
      if (!directUngroup.ok && directUngroup.reason !== 'already_ungrouped') {
        console.warn('[resume] ungroup direct chat tab failed:', {
          tabId: tab.id,
          reason: directUngroup.reason,
          error: directUngroup.error || ''
        });
      }
      return tab;
    }
  }

  const chatUrlRaw = typeof message?.chatUrl === 'string' && message.chatUrl.trim()
    ? message.chatUrl.trim()
    : (typeof process?.chatUrl === 'string' ? process.chatUrl.trim() : '');

  if (!chatUrlRaw || !isChatGptUrl(chatUrlRaw)) {
    return null;
  }

  try {
    const existingTabs = await chrome.tabs.query({ url: chatUrlRaw });
    const candidate = Array.isArray(existingTabs) ? existingTabs[0] : null;
    if (candidate && Number.isInteger(candidate.id)) {
      const existingUngroup = await ungroupTabsById([candidate.id], {
        origin: 'resume-existing-chat-tab'
      });
      if (!existingUngroup.ok && existingUngroup.reason !== 'already_ungrouped') {
        console.warn('[resume] ungroup existing chat tab failed:', {
          tabId: candidate.id,
          reason: existingUngroup.reason,
          error: existingUngroup.error || ''
        });
      }
      return candidate;
    }
  } catch (error) {
    // Ignore and fallback to opening a new tab.
  }

  try {
    const createOptions = { url: chatUrlRaw, active: false };
    if (Number.isInteger(process?.windowId)) {
      createOptions.windowId = process.windowId;
    }
    const createdTab = await chrome.tabs.create(createOptions);
    if (createdTab && Number.isInteger(createdTab.id)) {
      const createdUngroup = await ungroupTabsById([createdTab.id], {
        origin: 'resume-created-chat-tab'
      });
      if (!createdUngroup.ok && createdUngroup.reason !== 'already_ungrouped') {
        console.warn('[resume] ungroup created chat tab failed:', {
          tabId: createdTab.id,
          reason: createdUngroup.reason,
          error: createdUngroup.error || ''
        });
      }
      await waitForTabComplete(createdTab.id);
    }
    return createdTab || null;
  } catch (error) {
    console.warn('[resume] Nie udalo sie otworzyc karty chat do detekcji:', error?.message || error);
    return null;
  }
}

async function extractRecentUserPromptsFromTab(tabId, maxWaitMs = 12000) {
  if (!Number.isInteger(tabId)) {
    return { messages: [], messageMeta: [], url: '' };
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      function: async (waitMs) => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const compact = (text) => (text || '').replace(/\s+/g, ' ').trim();

        function readConversationEntries() {
          const nodes = Array.from(
            document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]')
          );
          return nodes
            .map((node) => {
              const role = node?.getAttribute ? node.getAttribute('data-message-author-role') : '';
              const text = compact(node?.innerText || node?.textContent || '');
              return {
                role,
                text: text.length > 24000 ? text.slice(0, 24000) : text
              };
            })
            .filter((entry) => (entry.role === 'user' || entry.role === 'assistant') && entry.text.length > 0)
            .slice(-40);
        }

        function buildUserMessageMeta() {
          const conversation = readConversationEntries();
          const users = [];
          for (let i = 0; i < conversation.length; i += 1) {
            const entry = conversation[i];
            if (entry.role !== 'user') continue;

            let hasAssistantReplyAfter = false;
            let assistantReplyLength = 0;
            for (let j = i + 1; j < conversation.length; j += 1) {
              const nextEntry = conversation[j];
              if (nextEntry.role === 'assistant') {
                hasAssistantReplyAfter = nextEntry.text.length > 0;
                assistantReplyLength = nextEntry.text.length;
                break;
              }
              if (nextEntry.role === 'user') {
                break;
              }
            }

            users.push({
              text: entry.text,
              hasAssistantReplyAfter,
              assistantReplyLength
            });
          }
          return users.slice(-14);
        }

        const startedAt = Date.now();
        let messageMeta = buildUserMessageMeta();
        let messages = messageMeta.map((entry) => entry.text);
        while (messages.length === 0 && (Date.now() - startedAt) < waitMs) {
          await sleep(300);
          messageMeta = buildUserMessageMeta();
          messages = messageMeta.map((entry) => entry.text);
        }

        return {
          url: location.href,
          messages,
          messageMeta
        };
      },
      args: [maxWaitMs]
    });

    return results?.[0]?.result || { messages: [], messageMeta: [], url: '' };
  } catch (error) {
    console.warn('[resume] Nie udalo sie odczytac promptow usera z tab:', tabId, error?.message || error);
    return { messages: [], messageMeta: [], url: '' };
  }
}

function detectLastPromptMatch(userMessages, promptRecords) {
  const messages = Array.isArray(userMessages) ? userMessages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const entry = messages[i];
    const text = typeof entry === 'string'
      ? entry
      : (typeof entry?.text === 'string' ? entry.text : '');
    if (typeof text !== 'string' || text.trim().length === 0) continue;
    const signature = buildTwoSentenceSignature(text);
    const normalizedPromptText = normalizeSignatureText(text).slice(0, 360);
    const matched = matchPromptBySignature(signature, normalizedPromptText, promptRecords);
    if (matched) {
      return {
        ...matched,
        messageIndex: i,
        signature,
        hasAssistantReplyAfter: typeof entry?.hasAssistantReplyAfter === 'boolean'
          ? entry.hasAssistantReplyAfter
          : null,
        assistantReplyLength: Number.isInteger(entry?.assistantReplyLength)
          ? entry.assistantReplyLength
          : null
      };
    }
  }
  return null;
}

function computeNextResumeIndex(lastPromptIndex, totalPrompts, shouldAdvancePrompt = true) {
  if (!Number.isInteger(lastPromptIndex)) return null;
  const promptCount = Number.isInteger(totalPrompts) ? totalPrompts : 0;
  if (promptCount <= 0) return null;

  const maxIndex = promptCount - 1;
  const boundedCurrent = Math.min(Math.max(lastPromptIndex, 0), maxIndex);
  if (shouldAdvancePrompt === false) {
    // Retry the same prompt when no assistant response was generated.
    return boundedCurrent;
  }

  const nextIndex = boundedCurrent + 1;
  if (nextIndex > maxIndex) return null;

  return Math.max(1, nextIndex);
}

function openResumeStagePopup(startIndex, title = '', analysisType = 'company') {
  const params = new URLSearchParams();
  if (Number.isInteger(startIndex)) params.set('startIndex', String(startIndex));
  if (title) params.set('title', title);
  if (analysisType) params.set('analysisType', analysisType);
  const query = params.toString();
  const targetUrl = chrome.runtime.getURL('resume-stage.html' + (query ? ('?' + query) : ''));

  chrome.windows.create({
    url: targetUrl,
    type: 'popup',
    width: 600,
    height: 400
  });
}

async function handleProcessResumeNextStageMessage(message) {
  const runId = await resolveProcessId(message, { tab: { id: message?.tabId } });
  if (!runId) {
    const tabId = Number.isInteger(message?.tabId) ? message.tabId : null;
    if (!Number.isInteger(tabId)) {
      return { success: false, error: 'run_not_found' };
    }

    const promptsReady = await ensureCompanyPromptsReady();
    if (!promptsReady) {
      return { success: false, error: 'prompts_not_loaded' };
    }

    const chatTab = await getTabByIdSafe(tabId);
    if (!chatTab || !isChatGptUrl(getTabEffectiveUrl(chatTab))) {
      return { success: false, error: 'chat_tab_not_found' };
    }

    const recoveryPoint = await detectCompanyRecoveryPointFromLastMessage(chatTab.id, 1);
    if (!recoveryPoint?.matched || !Number.isInteger(recoveryPoint?.promptOffset)) {
      return {
        success: false,
        error: recoveryPoint?.reason || 'signature_not_found'
      };
    }

    const promptCount = Number.isInteger(recoveryPoint?.promptCount) ? recoveryPoint.promptCount : PROMPTS_COMPANY.length;
    let nextStartIndex = recoveryPoint.promptOffset;
    const detectedPromptIndex = Number.isInteger(recoveryPoint?.detection?.index)
      ? recoveryPoint.detection.index
      : null;
    const detectedMethod = typeof recoveryPoint?.detection?.method === 'string'
      ? recoveryPoint.detection.method
      : 'last_user_signature';
    let retrySamePrompt = recoveryPoint?.detection?.hasAssistantReplyAfter === false;
    let retryReason = retrySamePrompt ? 'missing_assistant_reply' : '';

    if (!retrySamePrompt) {
      const metrics = await collectTabConversationMetricsForAutoRestore(chatTab.id);
      const assistantReplyTooShort = metrics.success
        && metrics.hasAssistantAfterLastUser === true
        && (
          metrics.lastAssistantWordCount < AUTO_RESTORE_WINDOWS.minAssistantWords
          || metrics.lastAssistantSentenceCount < AUTO_RESTORE_WINDOWS.minAssistantSentences
        );
      if (assistantReplyTooShort && Number.isInteger(detectedPromptIndex)) {
        retrySamePrompt = true;
        retryReason = 'assistant_reply_too_short';
        nextStartIndex = detectedPromptIndex;
      }
    }

    if (promptCount > 1) {
      nextStartIndex = Math.min(Math.max(nextStartIndex, 1), promptCount - 1);
    } else {
      nextStartIndex = Math.max(nextStartIndex, 0);
    }

    if (recoveryPoint.finalStageReached || !Number.isInteger(nextStartIndex) || nextStartIndex >= promptCount) {
      return {
        success: false,
        error: 'already_at_last_prompt',
        detectedPromptIndex,
        detectedPromptNumber: Number.isInteger(detectedPromptIndex) ? (detectedPromptIndex + 1) : null,
        detectedMethod,
        retrySamePrompt,
        retryReason
      };
    }

    if (message?.openDialogOnly) {
      const title = typeof message?.title === 'string' ? message.title.trim() : '';
      openResumeStagePopup(nextStartIndex, title || (chatTab.title || ''), 'company');
      return {
        success: true,
        mode: 'dialog',
        startIndex: nextStartIndex,
        startPromptNumber: nextStartIndex + 1,
        detectedPromptIndex,
        detectedPromptNumber: Number.isInteger(detectedPromptIndex) ? (detectedPromptIndex + 1) : null,
        detectedMethod,
        retrySamePrompt,
        retryReason
      };
    }

    const resumeTitle = typeof message?.title === 'string' && message.title.trim()
      ? message.title.trim()
      : (typeof chatTab.title === 'string' ? chatTab.title : '');
    const resumeResult = await resumeFromStage(nextStartIndex, {
      targetTabId: chatTab.id,
      suppressAlerts: true,
      processTitle: resumeTitle || undefined
    });

    if (!resumeResult?.success) {
      return {
        success: false,
        error: resumeResult?.error || 'resume_failed',
        startIndex: nextStartIndex,
        startPromptNumber: nextStartIndex + 1,
        detectedPromptIndex,
        detectedPromptNumber: Number.isInteger(detectedPromptIndex) ? (detectedPromptIndex + 1) : null,
        detectedMethod,
        retrySamePrompt,
        retryReason
      };
    }

    return {
      success: true,
      mode: 'direct',
      startIndex: nextStartIndex,
      startPromptNumber: nextStartIndex + 1,
      detectedPromptIndex,
      detectedPromptNumber: Number.isInteger(detectedPromptIndex) ? (detectedPromptIndex + 1) : null,
      detectedMethod,
      retrySamePrompt,
      retryReason
    };
  }

  await ensureProcessRegistryReady();
  const process = processRegistry.get(runId) || null;
  const analysisType = typeof message?.analysisType === 'string' && message.analysisType.trim()
    ? message.analysisType.trim()
    : (process?.analysisType || 'company');

  if (analysisType !== 'company') {
    return { success: false, error: 'analysis_not_supported' };
  }

  const promptsReady = await ensureCompanyPromptsReady();
  if (!promptsReady) {
    return { success: false, error: 'prompts_not_loaded' };
  }

  const chatTab = await resolveChatTabForProcess(process, message);
  if (!chatTab || !Number.isInteger(chatTab.id)) {
    return { success: false, error: 'chat_tab_not_found' };
  }

  const promptRecords = buildPromptSignatureRecords(PROMPTS_COMPANY);
  const extracted = await extractRecentUserPromptsFromTab(chatTab.id);
  const extractedEntries = Array.isArray(extracted?.messageMeta) && extracted.messageMeta.length > 0
    ? extracted.messageMeta
    : (Array.isArray(extracted?.messages) ? extracted.messages : []);
  const matched = detectLastPromptMatch(extractedEntries, promptRecords);

  const detectedPromptIndex = matched
    ? matched.index
    : getProgressPromptIndex(process);
  const detectedMethod = matched ? matched.method : 'progress_fallback';
  let shouldAdvancePrompt = matched?.hasAssistantReplyAfter !== false;
  let retrySamePrompt = matched?.hasAssistantReplyAfter === false;
  let retryReason = retrySamePrompt ? 'missing_assistant_reply' : '';

  if (shouldAdvancePrompt) {
    const metrics = await collectTabConversationMetricsForAutoRestore(chatTab.id);
    const assistantReplyTooShort = metrics.success
      && metrics.hasAssistantAfterLastUser === true
      && (
        metrics.lastAssistantWordCount < AUTO_RESTORE_WINDOWS.minAssistantWords
        || metrics.lastAssistantSentenceCount < AUTO_RESTORE_WINDOWS.minAssistantSentences
      );
    if (assistantReplyTooShort) {
      shouldAdvancePrompt = false;
      retrySamePrompt = true;
      retryReason = 'assistant_reply_too_short';
    }
  }

  const nextStartIndex = computeNextResumeIndex(
    detectedPromptIndex,
    PROMPTS_COMPANY.length,
    shouldAdvancePrompt
  );
  if (!Number.isInteger(nextStartIndex)) {
    return {
      success: false,
      error: 'already_at_last_prompt',
      detectedPromptIndex,
      detectedPromptNumber: Number.isInteger(detectedPromptIndex) ? (detectedPromptIndex + 1) : null,
      detectedMethod,
      retrySamePrompt,
      retryReason
    };
  }

  const title = typeof message?.title === 'string' && message.title.trim()
    ? message.title.trim()
    : (typeof process?.title === 'string' ? process.title : '');

  if (message?.openDialogOnly) {
    openResumeStagePopup(nextStartIndex, title, analysisType);
    return {
      success: true,
      mode: 'dialog',
      startIndex: nextStartIndex,
      startPromptNumber: nextStartIndex + 1,
      detectedPromptIndex,
      detectedPromptNumber: Number.isInteger(detectedPromptIndex) ? (detectedPromptIndex + 1) : null,
      detectedMethod,
      retrySamePrompt,
      retryReason
    };
  }

  const resumeResult = await resumeFromStage(nextStartIndex, {
    targetTabId: chatTab.id,
    suppressAlerts: true,
    processTitle: title || undefined
  });

  if (!resumeResult?.success) {
    return {
      success: false,
      error: resumeResult?.error || 'resume_failed',
      startIndex: nextStartIndex,
      startPromptNumber: nextStartIndex + 1,
      detectedPromptIndex,
      detectedPromptNumber: Number.isInteger(detectedPromptIndex) ? (detectedPromptIndex + 1) : null,
      detectedMethod,
      retrySamePrompt,
      retryReason
    };
  }

  await upsertProcess(runId, {
    status: 'stopped',
    statusText: retrySamePrompt
      ? (
        retryReason === 'assistant_reply_too_short'
          ? `Ponowiono Prompt ${nextStartIndex + 1} (odpowiedz byla za krotka)`
          : `Ponowiono Prompt ${nextStartIndex + 1} (brak odpowiedzi)`
      )
      : `Wznowiono od Prompt ${nextStartIndex + 1}`,
    reason: 'resumed_from_decision_panel',
    needsAction: false,
    finishedAt: Date.now(),
    timestamp: Date.now()
  });

  return {
    success: true,
    mode: 'direct',
    startIndex: nextStartIndex,
    startPromptNumber: nextStartIndex + 1,
    detectedPromptIndex,
    detectedPromptNumber: Number.isInteger(detectedPromptIndex) ? (detectedPromptIndex + 1) : null,
    detectedMethod,
    retrySamePrompt,
    retryReason
  };
}

function getRandomDelay() {
  const minDelay = 3000;  // 3 sekundy
  const maxDelay = 15000; // 15 sekund
  return Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
}

function generateResponseId(runId = '') {
  const safeRunId = typeof runId === 'string' && runId.trim()
    ? runId.trim().replace(/[^a-zA-Z0-9._-]/g, '_')
    : 'run';
  if (globalThis?.crypto?.randomUUID) {
    return `${safeRunId}_${globalThis.crypto.randomUUID()}`;
  }
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `${safeRunId}_${Date.now().toString(36)}_${randomPart}`;
}

function textFingerprint(text = '') {
  const normalized = typeof text === 'string' ? text : String(text ?? '');
  let hash = 0x811c9dc5; // FNV-1a 32-bit
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = (hash >>> 0) * 0x01000193;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function buildCopyTrace(runId = '', responseId = '') {
  const normalizedRunId = typeof runId === 'string' && runId.trim() ? runId.trim() : 'no-run';
  const normalizedResponseId = typeof responseId === 'string' && responseId.trim() ? responseId.trim() : 'no-response';
  return `${normalizedRunId}/${normalizedResponseId}`;
}

async function mirrorCopyFlowLogToTab(tabId, level, message, details = null) {
  if (!Number.isInteger(tabId)) return;
  if (!chrome?.scripting?.executeScript) return;

  const normalizedLevel = level === 'error' || level === 'warn' ? level : 'log';
  const normalizedMessage = typeof message === 'string' && message.trim()
    ? message.trim()
    : 'event';
  const normalizedDetails = details && typeof details === 'object' ? details : null;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (payload) => {
        const method = payload?.level === 'error'
          ? 'error'
          : payload?.level === 'warn'
            ? 'warn'
            : 'log';
        const logger = (console && typeof console[method] === 'function') ? console[method] : console.log;
        const prefix = '[copy-flow][sw->tab]';
        if (payload?.details && typeof payload.details === 'object') {
          logger(`${prefix} ${payload.message}`, payload.details);
        } else {
          logger(`${prefix} ${payload?.message || 'event'}`);
        }
      },
      args: [{
        level: normalizedLevel,
        message: normalizedMessage,
        details: normalizedDetails
      }]
    });
  } catch (error) {
    // Mirror logs are best-effort only.
  }
}

function truncateDispatchLogText(value, maxLength = 240) {
  const raw = typeof value === 'string' ? value : String(value ?? '');
  if (raw.length <= maxLength) return raw;
  return `${raw.slice(0, maxLength)}...`;
}

function formatDispatchUiSummary(dispatchOutcome) {
  const dispatch = dispatchOutcome && typeof dispatchOutcome === 'object'
    ? dispatchOutcome
    : null;
  if (!dispatch) return 'Dispatch: brak danych';

  if (dispatch.queueSkipped) {
    const reason = typeof dispatch.queueSkipReason === 'string' && dispatch.queueSkipReason.trim()
      ? dispatch.queueSkipReason.trim()
      : 'unknown';
    return `Dispatch: pominieto (${reason})`;
  }

  if (dispatch.queued) {
    if (dispatch.flushSkipped) {
      const queueSize = Number.isInteger(dispatch.queueSize) ? dispatch.queueSize : 0;
      const reason = typeof dispatch.flushSkipReason === 'string' && dispatch.flushSkipReason.trim()
        ? dispatch.flushSkipReason.trim()
        : 'unknown';
      return `Dispatch: kolejka=${queueSize}, flush pominiety (${reason})`;
    }

    const sent = Number.isInteger(dispatch.sent) ? dispatch.sent : 0;
    const failed = Number.isInteger(dispatch.failed) ? dispatch.failed : 0;
    const deferred = Number.isInteger(dispatch.deferred) ? dispatch.deferred : 0;
    const remaining = Number.isInteger(dispatch.remaining) ? dispatch.remaining : 0;
    return `Dispatch: sent=${sent}, failed=${failed}, deferred=${deferred}, remaining=${remaining}`;
  }

  return 'Dispatch: brak wysylki';
}

function buildPersistenceUiSummary(options = {}) {
  const hasResponse = options?.hasResponse !== false;
  const saveResult = options?.saveResult && typeof options.saveResult === 'object'
    ? options.saveResult
    : null;
  const saveErrorRaw = typeof options?.saveError === 'string' ? options.saveError : '';
  const saveError = saveErrorRaw.trim();
  const dispatch = saveResult?.dispatch && typeof saveResult.dispatch === 'object'
    ? saveResult.dispatch
    : null;
  const dispatchSummary = formatDispatchUiSummary(dispatch);

  if (!hasResponse) {
    const logLines = [
      'Baza: pominieto (pusta odpowiedz)',
      'Dispatch: pominieto'
    ];
    return {
      saveOk: false,
      hasResponse: false,
      statusText: 'Zakonczono (pusta odpowiedz)',
      reason: 'empty_response',
      tone: 'warn',
      logLines,
      dispatchSummary: 'Dispatch: pominieto',
      dispatch: null,
      copyTrace: '',
      saveError: 'empty_response'
    };
  }

  const saveOk = !!saveResult?.success;
  if (!saveOk) {
    const normalizedSaveError = saveError || 'save_failed';
    const storageSummary = `Baza: BLAD zapisu (${truncateDispatchLogText(normalizedSaveError, 140)})`;
    const logLines = [storageSummary, dispatchSummary];
    return {
      saveOk: false,
      hasResponse: true,
      statusText: `Zakonczono | ${storageSummary} | ${dispatchSummary}`,
      reason: 'save_failed',
      tone: 'error',
      logLines,
      dispatchSummary,
      dispatch,
      copyTrace: '',
      saveError: normalizedSaveError
    };
  }

  const verifiedCount = Number.isInteger(saveResult?.verifiedCount) ? saveResult.verifiedCount : null;
  const storageSummary = verifiedCount === null
    ? 'Baza: OK'
    : `Baza: OK (records=${verifiedCount})`;
  const copyTrace = typeof saveResult?.copyTrace === 'string' && saveResult.copyTrace.trim()
    ? saveResult.copyTrace.trim()
    : '';
  const logLines = [storageSummary, dispatchSummary];
  if (copyTrace) {
    logLines.push(`Trace: ${copyTrace}`);
  }
  if (typeof dispatch?.firstFailure === 'string' && dispatch.firstFailure.trim()) {
    logLines.push(`Dispatch error: ${truncateDispatchLogText(dispatch.firstFailure, 180)}`);
  }

  const tone = Number.isInteger(dispatch?.failed) && dispatch.failed > 0 ? 'warn' : 'success';
  return {
    saveOk: true,
    hasResponse: true,
    statusText: `Zakonczono | ${storageSummary} | ${dispatchSummary}`,
    reason: '',
    tone,
    logLines,
    dispatchSummary,
    dispatch,
    copyTrace,
    saveError: ''
  };
}

async function renderFinalCounterStatusOnTab(tabId, options = {}) {
  if (!Number.isInteger(tabId)) return;
  if (!chrome?.scripting?.executeScript) return;

  const heading = typeof options?.heading === 'string' && options.heading.trim()
    ? options.heading.trim()
    : 'Zakonczono';
  const tone = options?.tone === 'error'
    ? 'error'
    : options?.tone === 'warn'
      ? 'warn'
      : 'success';
  const lines = Array.isArray(options?.lines)
    ? options.lines
      .filter((line) => typeof line === 'string' && line.trim())
      .map((line) => line.trim())
      .slice(0, 6)
    : [];
  const autoCloseMs = Number.isInteger(options?.autoCloseMs)
    ? Math.max(0, Math.min(options.autoCloseMs, 60000))
    : 0;
  const currentPrompt = Number.isInteger(options?.currentPrompt) && options.currentPrompt >= 0
    ? options.currentPrompt
    : null;
  const totalPrompts = Number.isInteger(options?.totalPrompts) && options.totalPrompts >= 0
    ? options.totalPrompts
    : null;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (payload) => {
        const counters = Array.from(document.querySelectorAll('#economist-prompt-counter'));
        if (counters.length === 0) return { updated: false, reason: 'counter_missing' };

        const counter = counters[counters.length - 1];
        if (counters.length > 1) {
          counters.slice(0, -1).forEach((node) => {
            try {
              node.remove();
            } catch (_) {
              // ignore
            }
          });
        }

        const normalizeTone = (value = '') => {
          if (value === 'success' || value === 'warn' || value === 'error') return value;
          return 'neutral';
        };

        const toneToDotColor = (value = 'neutral') => {
          if (value === 'success') return '#22c55e';
          if (value === 'warn') return '#f59e0b';
          if (value === 'error') return '#ef4444';
          return 'rgba(255,255,255,0.85)';
        };

        const ensureMiniStage = () => {
          const header = counter.firstElementChild;
          if (!header) return null;

          let miniStage = header.querySelector('#economist-counter-mini-stage');
          if (miniStage) return miniStage;

          miniStage = document.createElement('div');
          miniStage.id = 'economist-counter-mini-stage';
    miniStage.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      margin-left: 8px;
      margin-right: auto;
      min-width: 72px;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.26);
      background: rgba(15,23,42,0.22);
      font-size: 11px;
      font-weight: 700;
      line-height: 1;
      opacity: 0.98;
      white-space: nowrap;
    `;

          const dot = document.createElement('span');
          dot.className = 'economist-counter-mini-dot';
    dot.style.cssText = `
      width: 7px;
      height: 7px;
      border-radius: 999px;
      display: inline-block;
      background: rgba(255,255,255,0.85);
      flex: 0 0 auto;
      box-shadow: 0 0 0 1px rgba(15,23,42,0.25);
    `;

          const label = document.createElement('span');
          label.className = 'economist-counter-mini-label';
          label.textContent = 'P0/0';
    label.style.cssText = `
      letter-spacing: 0.01em;
      font-size: 11px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-variant-numeric: tabular-nums;
    `;

          miniStage.appendChild(dot);
          miniStage.appendChild(label);

          const controls = header.querySelector('#economist-counter-controls');
          if (controls) {
            header.insertBefore(miniStage, controls);
          } else {
            header.appendChild(miniStage);
          }

          return miniStage;
        };

        let content = counter.querySelector('#economist-counter-content');
        if (!content) {
          content = document.createElement('div');
          content.id = 'economist-counter-content';
          counter.appendChild(content);
        }

        const header = counter.firstElementChild;
        if (header && header.style) {
          header.style.borderBottom = '1px solid rgba(255,255,255,0.3)';
        }

        const minimizeBtn = counter.querySelector('#economist-counter-minimize');
        if (minimizeBtn) {
          minimizeBtn.textContent = '-';
        }

        try {
          localStorage.setItem('economist-counter-minimized', 'false');
        } catch (_) {
          // ignore localStorage failures
        }

        content.style.display = 'block';
        content.style.padding = '8px 18px 14px 18px';
        counter.style.minWidth = '270px';
        counter.style.cursor = 'default';

        if (payload.tone === 'success') {
          counter.style.background = 'linear-gradient(135deg, #166534 0%, #15803d 100%)';
        } else if (payload.tone === 'warn') {
          counter.style.background = 'linear-gradient(135deg, #9a3412 0%, #b45309 100%)';
        } else {
          counter.style.background = 'linear-gradient(135deg, #991b1b 0%, #b91c1c 100%)';
        }

        while (content.firstChild) {
          content.removeChild(content.firstChild);
        }

        const title = document.createElement('div');
        title.style.fontSize = '17px';
        title.style.fontWeight = '700';
        title.style.marginBottom = payload.lines.length > 0 ? '6px' : '0';
        title.textContent = payload.heading || 'Zakonczono';
        content.appendChild(title);

        payload.lines.forEach((line) => {
          const row = document.createElement('div');
          row.style.fontSize = '12px';
          row.style.opacity = '0.95';
          row.style.lineHeight = '1.35';
          row.style.marginTop = '2px';
          row.textContent = line;
          content.appendChild(row);
        });

        const datasetCurrent = Number.parseInt(counter.dataset.economistCurrent || '', 10);
        const datasetTotal = Number.parseInt(counter.dataset.economistTotal || '', 10);
        const safeCurrentRaw = Number.isInteger(payload.currentPrompt)
          ? payload.currentPrompt
          : (Number.isInteger(datasetCurrent) ? datasetCurrent : 0);
        const safeTotalRaw = Number.isInteger(payload.totalPrompts)
          ? payload.totalPrompts
          : (Number.isInteger(datasetTotal) ? datasetTotal : 0);
        const safeTotal = safeTotalRaw > 0 ? safeTotalRaw : 0;
        const boundedCurrent = safeTotal > 0
          ? Math.min(Math.max(safeCurrentRaw, 0), safeTotal)
          : Math.max(safeCurrentRaw, 0);
        const miniTone = normalizeTone(payload.tone || counter.dataset.economistMiniTone || 'neutral');
        const progressText = safeTotal > 0
          ? `P${boundedCurrent}/${safeTotal}`
          : `P${boundedCurrent}/0`;

        const miniStage = ensureMiniStage();
        if (miniStage) {
          const dot = miniStage.querySelector('.economist-counter-mini-dot');
          const label = miniStage.querySelector('.economist-counter-mini-label');
          if (dot) {
            dot.style.background = toneToDotColor(miniTone);
          }
          if (label) {
            label.textContent = progressText;
          } else {
            miniStage.textContent = progressText;
          }
        }

        counter.dataset.economistCurrent = String(boundedCurrent);
        counter.dataset.economistTotal = String(safeTotal);
        counter.dataset.economistMiniTone = miniTone;

        const existingTimerId = Number.parseInt(counter.dataset.economistCloseTimerId || '', 10);
        if (Number.isInteger(existingTimerId)) {
          clearTimeout(existingTimerId);
          delete counter.dataset.economistCloseTimerId;
        }

        if (Number.isInteger(payload.autoCloseMs) && payload.autoCloseMs > 0) {
          const timerId = window.setTimeout(() => {
            const activeCounters = Array.from(document.querySelectorAll('#economist-prompt-counter'));
            activeCounters.forEach((node) => {
              try {
                node.remove();
              } catch (_) {
                // ignore
              }
            });
          }, payload.autoCloseMs);
          counter.dataset.economistCloseTimerId = String(timerId);
        }

        return { updated: true };
      },
      args: [{
        heading,
        tone,
        lines,
        autoCloseMs,
        currentPrompt,
        totalPrompts
      }]
    });
  } catch (error) {
    // Counter rendering is best-effort only.
  }
}

function summarizeWatchlistDispatchPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const text = typeof payload.text === 'string' ? payload.text : '';
  const stage = payload.stage && typeof payload.stage === 'object' ? payload.stage : null;
  return {
    responseId: typeof payload.responseId === 'string' ? payload.responseId : '',
    runId: typeof payload.runId === 'string' ? payload.runId : '',
    analysisType: typeof payload.analysisType === 'string' ? payload.analysisType : '',
    source: typeof payload.source === 'string' ? payload.source : '',
    timestamp: payload.timestamp ?? null,
    textLength: text.length,
    textFingerprint: textFingerprint(text),
    hasConversationUrl: !!(typeof payload.conversationUrl === 'string' && payload.conversationUrl.trim()),
    stage: stage
      ? {
        number: Number.isInteger(stage.number) ? stage.number : null,
        index: Number.isInteger(stage.index) ? stage.index : null,
        name: typeof stage.name === 'string' ? stage.name : ''
      }
      : null
  };
}

function normalizeWatchlistDispatchPayload(response) {
  if (!response || typeof response !== 'object') return null;
  const text = typeof response.text === 'string' ? response.text : '';
  if (!text.trim()) return null;

  const responseId = typeof response.responseId === 'string' ? response.responseId.trim() : '';
  const runId = typeof response.runId === 'string' ? response.runId.trim() : '';
  const stage = response.stage && typeof response.stage === 'object' && !Array.isArray(response.stage)
    ? response.stage
    : null;

  const payload = {
    schema: "economist.response.v1",
    responseId: responseId || generateResponseId(runId),
    runId: runId || null,
    text,
    source: typeof response.source === 'string' ? response.source : '',
    analysisType: typeof response.analysisType === 'string' ? response.analysisType : '',
    timestamp: response.timestamp ?? Date.now()
  };
  if (stage) {
    payload.stage = stage;
  }
  const conversationUrl = normalizeChatConversationUrl(response.conversationUrl);
  if (conversationUrl) {
    payload.conversationUrl = conversationUrl;
  }
  return payload;
}

function getWatchlistOutboxDedupKey(item) {
  if (!item || typeof item !== 'object') return '';
  const payload = item.payload && typeof item.payload === 'object' ? item.payload : {};
  const responseId = typeof payload.responseId === 'string' ? payload.responseId.trim() : '';
  if (responseId) {
    return `response:${responseId}`;
  }
  const base = [
    typeof payload.runId === 'string' ? payload.runId.trim() : '',
    typeof payload.source === 'string' ? payload.source.trim() : '',
    typeof payload.text === 'string' ? payload.text.trim() : '',
    String(payload.timestamp ?? '')
  ].join('|');
  return `hash:${textFingerprint(base)}`;
}

function sanitizeWatchlistOutbox(rawItems) {
  const items = Array.isArray(rawItems) ? rawItems : [];
  const deduped = new Map();

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const payload = item.payload && typeof item.payload === 'object' ? item.payload : null;
    if (!payload) continue;
    const key = getWatchlistOutboxDedupKey(item);
    if (!key) continue;
    deduped.set(key, {
      payload,
      queuedAt: Number.isInteger(item.queuedAt) ? item.queuedAt : Date.now(),
      attemptCount: Number.isInteger(item.attemptCount) && item.attemptCount >= 0 ? item.attemptCount : 0,
      nextAttemptAt: Number.isInteger(item.nextAttemptAt) ? item.nextAttemptAt : 0,
      lastError: typeof item.lastError === 'string' ? item.lastError : ''
    });
  }

  const normalized = Array.from(deduped.values());
  if (normalized.length <= WATCHLIST_DISPATCH.outboxMaxItems) {
    return normalized;
  }
  return normalized.slice(normalized.length - WATCHLIST_DISPATCH.outboxMaxItems);
}

async function readWatchlistOutbox() {
  const storageKey = WATCHLIST_DISPATCH.outboxStorageKey;
  const result = await chrome.storage.local.get([storageKey]);
  return sanitizeWatchlistOutbox(result?.[storageKey]);
}

async function writeWatchlistOutbox(items) {
  const storageKey = WATCHLIST_DISPATCH.outboxStorageKey;
  const normalized = sanitizeWatchlistOutbox(items);
  await chrome.storage.local.set({ [storageKey]: normalized });
  return normalized;
}

function sanitizeWatchlistDispatchHistory(rawItems) {
  const items = Array.isArray(rawItems) ? rawItems : [];
  const normalized = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    normalized.push({
      ts: Number.isInteger(item.ts) ? item.ts : Date.now(),
      kind: typeof item.kind === 'string' && item.kind.trim() ? item.kind.trim() : 'flush',
      reason: typeof item.reason === 'string' ? item.reason : '',
      success: item.success === true,
      skipped: item.skipped === true,
      skipReason: typeof item.skipReason === 'string' ? item.skipReason : '',
      error: typeof item.error === 'string' ? item.error : '',
      queued: Number.isInteger(item.queued) ? item.queued : 0,
      sent: Number.isInteger(item.sent) ? item.sent : 0,
      failed: Number.isInteger(item.failed) ? item.failed : 0,
      deferred: Number.isInteger(item.deferred) ? item.deferred : 0,
      remaining: Number.isInteger(item.remaining) ? item.remaining : 0
    });
  }

  const limit = Math.max(1, Number(WATCHLIST_DISPATCH.historyMaxItems || 200));
  if (normalized.length <= limit) return normalized;
  return normalized.slice(normalized.length - limit);
}

async function readWatchlistDispatchHistory() {
  const storageKey = WATCHLIST_DISPATCH.historyStorageKey;
  if (!storageKey || !chrome?.storage?.local?.get) return [];
  const result = await chrome.storage.local.get([storageKey]);
  return sanitizeWatchlistDispatchHistory(result?.[storageKey]);
}

async function appendWatchlistDispatchHistory(entry) {
  const storageKey = WATCHLIST_DISPATCH.historyStorageKey;
  if (!storageKey || !chrome?.storage?.local?.get || !chrome?.storage?.local?.set) return;
  try {
    const snapshot = await chrome.storage.local.get([storageKey]);
    const current = sanitizeWatchlistDispatchHistory(snapshot?.[storageKey]);
    const normalizedEntry = sanitizeWatchlistDispatchHistory([entry])[0];
    const next = sanitizeWatchlistDispatchHistory([...current, normalizedEntry]);
    await chrome.storage.local.set({ [storageKey]: next });
  } catch (error) {
    console.warn('[copy-flow] [dispatch:history-write-failed]', error);
  }
}

async function enqueueWatchlistDispatch(response, copyTrace = 'no-run/no-response') {
  if (!WATCHLIST_DISPATCH.enabled) {
    return { skipped: true, reason: 'dispatch_disabled' };
  }

  const payload = normalizeWatchlistDispatchPayload(response);
  if (!payload) {
    const text = typeof response?.text === 'string' ? response.text : '';
    console.warn('[copy-flow] [dispatch:queue-skipped] invalid payload', {
      trace: copyTrace,
      hasResponse: !!response,
      textLength: text.length,
      textFingerprint: textFingerprint(text),
      runId: typeof response?.runId === 'string' ? response.runId : '',
      responseId: typeof response?.responseId === 'string' ? response.responseId : '',
      analysisType: typeof response?.analysisType === 'string' ? response.analysisType : '',
      source: typeof response?.source === 'string' ? response.source : ''
    });
    return { skipped: true, reason: 'invalid_payload' };
  }

  const current = await readWatchlistOutbox();
  const next = [
    ...current,
    {
      payload,
      queuedAt: Date.now(),
      attemptCount: 0,
      nextAttemptAt: 0,
      lastError: ''
    }
  ];
  const saved = await writeWatchlistOutbox(next);
  console.log('[copy-flow] [dispatch:queued]', {
    trace: copyTrace,
    queueSize: saved.length,
    payload: summarizeWatchlistDispatchPayload(payload)
  });
  return { queued: true, responseId: payload.responseId, queueSize: saved.length };
}

function normalizeWatchlistDispatchToken(rawToken) {
  return typeof rawToken === 'string' ? rawToken.trim() : '';
}

function isLocalWatchlistLoopbackHost(rawHost) {
  const host = typeof rawHost === 'string' ? rawHost.trim().toLowerCase() : '';
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function normalizeWatchlistIntakeUrl(rawUrl) {
  const value = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!value) return '';
  try {
    const parsed = new URL(value);
    const protocol = String(parsed.protocol || '').toLowerCase();
    const hostname = String(parsed.hostname || '').toLowerCase();
    if (protocol === 'https:') return parsed.toString();
    // Allow plain HTTP only for local SSH tunnel endpoint.
    if (protocol === 'http:' && isLocalWatchlistLoopbackHost(hostname)) return parsed.toString();
    return '';
  } catch {
    return '';
  }
}

function buildWatchlistDispatchUrlCandidates(primaryIntakeUrl) {
  const primary = normalizeWatchlistIntakeUrl(primaryIntakeUrl);
  if (!primary) return [];

  const urls = [primary];
  const fallback = normalizeWatchlistIntakeUrl(WATCHLIST_DISPATCH.localTunnelIntakeUrl || '');
  if (!fallback || fallback === primary) {
    return urls;
  }

  try {
    const primaryHost = new URL(primary).hostname;
    const fallbackHost = new URL(fallback).hostname;
    const primaryIsLoopback = isLocalWatchlistLoopbackHost(primaryHost);
    const fallbackIsLoopback = isLocalWatchlistLoopbackHost(fallbackHost);
    if (!primaryIsLoopback && fallbackIsLoopback) {
      urls.push(fallback);
    }
  } catch {
    // Keep primary URL only when URL parsing is inconsistent.
  }

  return urls;
}

function shouldSwitchWatchlistUrlCandidateEarly({
  usingFallbackUrl,
  hasAnotherUrlCandidate,
  dispatchReason,
  statusCode
}) {
  if (usingFallbackUrl || !hasAnotherUrlCandidate) return false;
  if (statusCode != null) return false;
  const reason = typeof dispatchReason === 'string' ? dispatchReason.trim().toLowerCase() : '';
  return reason === 'timeout' || reason === 'dispatch_error';
}

function normalizeWatchlistKeyId(rawKeyId) {
  return typeof rawKeyId === 'string' ? rawKeyId.trim() : '';
}

function getWatchlistCredentialStorageKeys() {
  const secretLocalKey = typeof WATCHLIST_DISPATCH.secretStorageKey === 'string'
    ? WATCHLIST_DISPATCH.secretStorageKey.trim()
    : '';
  const secretSyncKeyRaw = typeof WATCHLIST_DISPATCH.secretSyncStorageKey === 'string'
    ? WATCHLIST_DISPATCH.secretSyncStorageKey.trim()
    : '';
  const intakeUrlLocalKey = typeof WATCHLIST_DISPATCH.intakeUrlStorageKey === 'string'
    ? WATCHLIST_DISPATCH.intakeUrlStorageKey.trim()
    : '';
  const intakeUrlSyncKeyRaw = typeof WATCHLIST_DISPATCH.intakeUrlSyncStorageKey === 'string'
    ? WATCHLIST_DISPATCH.intakeUrlSyncStorageKey.trim()
    : '';
  const keyIdLocalKey = typeof WATCHLIST_DISPATCH.keyIdStorageKey === 'string'
    ? WATCHLIST_DISPATCH.keyIdStorageKey.trim()
    : '';
  const keyIdSyncKeyRaw = typeof WATCHLIST_DISPATCH.keyIdSyncStorageKey === 'string'
    ? WATCHLIST_DISPATCH.keyIdSyncStorageKey.trim()
    : '';
  return {
    secretLocalKey,
    secretSyncKey: secretSyncKeyRaw || secretLocalKey,
    intakeUrlLocalKey,
    intakeUrlSyncKey: intakeUrlSyncKeyRaw || intakeUrlLocalKey,
    keyIdLocalKey,
    keyIdSyncKey: keyIdSyncKeyRaw || keyIdLocalKey,
  };
}

async function readWatchlistValueFromStorageArea(storageArea, storageKey, normalizer) {
  if (!storageArea || typeof storageArea.get !== 'function' || !storageKey) return '';
  try {
    const result = await storageArea.get([storageKey]);
    return normalizer(result?.[storageKey]);
  } catch (error) {
    console.warn('[copy-flow] [dispatch:config-read-failed]', {
      storage: storageArea === chrome?.storage?.sync ? 'sync' : 'local',
      key: storageKey,
      error: error?.message || String(error)
    });
    return '';
  }
}

async function resolveWatchlistSetting({
  inlineValue,
  localKey,
  syncKey,
  normalizer,
  forceReload = false,
  cacheKey
}) {
  if (!forceReload && watchlistDispatchCredentialsCache && typeof watchlistDispatchCredentialsCache[cacheKey] === 'string') {
    const cachedValue = watchlistDispatchCredentialsCache[cacheKey];
    const cachedSource = watchlistDispatchCredentialsCache[`${cacheKey}Source`] || 'missing';
    return { value: cachedValue, source: cachedSource };
  }

  const inline = normalizer(inlineValue);
  if (inline) {
    return { value: inline, source: 'inline_config' };
  }

  const local = await readWatchlistValueFromStorageArea(chrome?.storage?.local, localKey, normalizer);
  if (local) {
    return { value: local, source: 'storage_local' };
  }

  const sync = await readWatchlistValueFromStorageArea(chrome?.storage?.sync, syncKey, normalizer);
  if (sync) {
    if (localKey && chrome?.storage?.local?.set) {
      try {
        await chrome.storage.local.set({ [localKey]: sync });
      } catch (error) {
        console.warn('[copy-flow] [dispatch:config-local-repair-failed]', { key: localKey, error });
      }
    }
    return { value: sync, source: 'storage_sync' };
  }

  return { value: '', source: 'missing' };
}

async function resolveWatchlistDispatchToken(forceReload = false) {
  const keys = getWatchlistCredentialStorageKeys();
  return resolveWatchlistSetting({
    inlineValue: WATCHLIST_DISPATCH.secret,
    localKey: keys.secretLocalKey,
    syncKey: keys.secretSyncKey,
    normalizer: normalizeWatchlistDispatchToken,
    forceReload,
    cacheKey: 'secret'
  });
}

async function resolveWatchlistDispatchConfiguration(forceReload = false) {
  if (!WATCHLIST_DISPATCH.enabled) {
    console.warn('[copy-flow] [dispatch:config] disabled');
    return {
      ok: false,
      reason: 'dispatch_disabled',
      intakeUrl: '',
      keyId: '',
      secret: '',
      intakeUrlSource: 'missing',
      keyIdSource: 'missing',
      secretSource: 'missing'
    };
  }

  const keys = getWatchlistCredentialStorageKeys();
  const [secretInfo, intakeUrlInfo, keyIdInfo] = await Promise.all([
    resolveWatchlistDispatchToken(forceReload),
    resolveWatchlistSetting({
      inlineValue: WATCHLIST_DISPATCH.intakeUrl,
      localKey: keys.intakeUrlLocalKey,
      syncKey: keys.intakeUrlSyncKey,
      normalizer: normalizeWatchlistIntakeUrl,
      forceReload,
      cacheKey: 'intakeUrl'
    }),
    resolveWatchlistSetting({
      inlineValue: WATCHLIST_DISPATCH.keyId,
      localKey: keys.keyIdLocalKey,
      syncKey: keys.keyIdSyncKey,
      normalizer: normalizeWatchlistKeyId,
      forceReload,
      cacheKey: 'keyId'
    }),
  ]);

  watchlistDispatchCredentialsCache = {
    secret: secretInfo.value || '',
    secretSource: secretInfo.source || 'missing',
    intakeUrl: intakeUrlInfo.value || '',
    intakeUrlSource: intakeUrlInfo.source || 'missing',
    keyId: keyIdInfo.value || '',
    keyIdSource: keyIdInfo.source || 'missing',
  };

  if (!intakeUrlInfo.value) {
    return {
      ok: false,
      reason: 'missing_intake_url',
      intakeUrl: '',
      keyId: keyIdInfo.value || '',
      secret: '',
      intakeUrlSource: intakeUrlInfo.source || 'missing',
      keyIdSource: keyIdInfo.source || 'missing',
      secretSource: secretInfo.source || 'missing'
    };
  }
  if (!keyIdInfo.value) {
    return {
      ok: false,
      reason: 'missing_key_id',
      intakeUrl: intakeUrlInfo.value || '',
      keyId: '',
      secret: '',
      intakeUrlSource: intakeUrlInfo.source || 'missing',
      keyIdSource: keyIdInfo.source || 'missing',
      secretSource: secretInfo.source || 'missing'
    };
  }
  if (!secretInfo.value) {
    return {
      ok: false,
      reason: 'missing_dispatch_credentials',
      intakeUrl: intakeUrlInfo.value || '',
      keyId: keyIdInfo.value || '',
      secret: '',
      intakeUrlSource: intakeUrlInfo.source || 'missing',
      keyIdSource: keyIdInfo.source || 'missing',
      secretSource: secretInfo.source || 'missing'
    };
  }

  return {
    ok: true,
    reason: null,
    intakeUrl: intakeUrlInfo.value,
    keyId: keyIdInfo.value,
    secret: secretInfo.value,
    intakeUrlSource: intakeUrlInfo.source || 'missing',
    keyIdSource: keyIdInfo.source || 'missing',
    secretSource: secretInfo.source || 'missing'
  };
}

async function getWatchlistDispatchStatus(forceReload = false) {
  const [config, outbox, history] = await Promise.all([
    resolveWatchlistDispatchConfiguration(forceReload),
    readWatchlistOutbox().catch(() => []),
    readWatchlistDispatchHistory().catch(() => [])
  ]);
  const lastFlush = history.length > 0 ? history[history.length - 1] : null;
  const outboxItems = Array.isArray(outbox) ? outbox : [];
  const retryCandidates = outboxItems
    .map((item) => (Number.isInteger(item?.nextAttemptAt) ? item.nextAttemptAt : 0))
    .filter((value) => value > Date.now());
  const nextRetryAt = retryCandidates.length > 0 ? Math.min(...retryCandidates) : null;
  const errorCandidates = outboxItems
    .filter((item) => typeof item?.lastError === 'string' && item.lastError.trim())
    .sort((a, b) => {
      const attemptsA = Number.isInteger(a?.attemptCount) ? a.attemptCount : 0;
      const attemptsB = Number.isInteger(b?.attemptCount) ? b.attemptCount : 0;
      if (attemptsB !== attemptsA) return attemptsB - attemptsA;
      const queuedA = Number.isInteger(a?.queuedAt) ? a.queuedAt : 0;
      const queuedB = Number.isInteger(b?.queuedAt) ? b.queuedAt : 0;
      return queuedB - queuedA;
    });
  const mostRecentError = errorCandidates.length > 0 ? errorCandidates[0] : null;
  const latestOutboxError = mostRecentError
    ? truncateDispatchLogText(mostRecentError.lastError, 220)
    : '';
  const latestOutboxErrorTrace = mostRecentError
    ? buildCopyTrace(mostRecentError?.payload?.runId || '', mostRecentError?.payload?.responseId || '')
    : '';
  return {
    enabled: WATCHLIST_DISPATCH.enabled,
    intakeUrl: config.intakeUrl || '',
    keyId: config.keyId || '',
    configured: !!config.ok,
    hasToken: !!config.secret,
    tokenSource: config.secretSource || 'missing',
    intakeUrlSource: config.intakeUrlSource || 'missing',
    keyIdSource: config.keyIdSource || 'missing',
    reason: config.reason,
    queueSize: outboxItems.length,
    flushInProgress: !!watchlistDispatchFlushInProgress,
    historySize: Array.isArray(history) ? history.length : 0,
    lastFlush,
    nextRetryAt,
    latestOutboxError,
    latestOutboxErrorTrace
  };
}

function summarizeWatchlistDispatchStatusForLog(status) {
  if (!status || typeof status !== 'object') {
    return {
      configured: false,
      reason: 'status_unavailable',
      queueSize: 0
    };
  }

  const lastFlush = status.lastFlush && typeof status.lastFlush === 'object'
    ? {
      reason: typeof status.lastFlush.reason === 'string' ? status.lastFlush.reason : '',
      sent: Number.isInteger(status.lastFlush.sent) ? status.lastFlush.sent : 0,
      failed: Number.isInteger(status.lastFlush.failed) ? status.lastFlush.failed : 0,
      deferred: Number.isInteger(status.lastFlush.deferred) ? status.lastFlush.deferred : 0,
      remaining: Number.isInteger(status.lastFlush.remaining) ? status.lastFlush.remaining : 0,
      skipped: status.lastFlush.skipped === true,
      skipReason: typeof status.lastFlush.skipReason === 'string' ? status.lastFlush.skipReason : ''
    }
    : null;

  return {
    configured: !!status.configured,
    reason: typeof status.reason === 'string' ? status.reason : '',
    intakeUrl: typeof status.intakeUrl === 'string' ? status.intakeUrl : '',
    keyId: typeof status.keyId === 'string' ? status.keyId : '',
    queueSize: Number.isInteger(status.queueSize) ? status.queueSize : 0,
    flushInProgress: !!status.flushInProgress,
    tokenSource: typeof status.tokenSource === 'string' ? status.tokenSource : 'missing',
    intakeUrlSource: typeof status.intakeUrlSource === 'string' ? status.intakeUrlSource : 'missing',
    keyIdSource: typeof status.keyIdSource === 'string' ? status.keyIdSource : 'missing',
    nextRetryAt: Number.isInteger(status.nextRetryAt) ? status.nextRetryAt : null,
    latestOutboxError: typeof status.latestOutboxError === 'string' ? status.latestOutboxError : '',
    lastFlush
  };
}

async function logWatchlistDispatchStatusSnapshot(context, forceReload = false, extra = {}) {
  try {
    const status = await getWatchlistDispatchStatus(forceReload);
    console.log('[copy-flow] [dispatch:status-snapshot]', {
      context: typeof context === 'string' ? context : 'unknown',
      ...summarizeWatchlistDispatchStatusForLog(status),
      ...extra
    });
  } catch (error) {
    console.warn('[copy-flow] [dispatch:status-snapshot-failed]', {
      context: typeof context === 'string' ? context : 'unknown',
      error: error?.message || String(error),
      ...extra
    });
  }
}

async function setWatchlistDispatchToken(rawInput) {
  const keys = getWatchlistCredentialStorageKeys();
  const payload = rawInput && typeof rawInput === 'object'
    ? rawInput
    : { secret: rawInput };

  const currentConfig = await resolveWatchlistDispatchConfiguration(true).catch(() => ({
    intakeUrl: '',
    keyId: ''
  }));
  const intakeUrl = normalizeWatchlistIntakeUrl(payload?.intakeUrl || currentConfig?.intakeUrl || WATCHLIST_DISPATCH.intakeUrl);
  const keyId = normalizeWatchlistKeyId(payload?.keyId || currentConfig?.keyId || WATCHLIST_DISPATCH.keyId);
  const secret = normalizeWatchlistDispatchToken(payload?.secret);

  if (!intakeUrl) {
    return { success: false, reason: 'missing_intake_url' };
  }
  if (!keyId) {
    return { success: false, reason: 'missing_key_id' };
  }
  if (!secret) {
    return { success: false, reason: 'empty_token' };
  }

  let localSaved = false;
  let syncSaved = false;

  if (chrome?.storage?.local?.set) {
    const localPayload = {};
    if (keys.secretLocalKey) localPayload[keys.secretLocalKey] = secret;
    if (keys.intakeUrlLocalKey) localPayload[keys.intakeUrlLocalKey] = intakeUrl;
    if (keys.keyIdLocalKey) localPayload[keys.keyIdLocalKey] = keyId;
    if (Object.keys(localPayload).length > 0) {
      try {
        await chrome.storage.local.set(localPayload);
        localSaved = true;
      } catch (error) {
        console.warn('[copy-flow] [dispatch:token-local-save-failed]', error);
      }
    }
  }

  if (chrome?.storage?.sync?.set) {
    const syncPayload = {};
    if (keys.secretSyncKey) syncPayload[keys.secretSyncKey] = secret;
    if (keys.intakeUrlSyncKey) syncPayload[keys.intakeUrlSyncKey] = intakeUrl;
    if (keys.keyIdSyncKey) syncPayload[keys.keyIdSyncKey] = keyId;
    if (Object.keys(syncPayload).length > 0) {
      try {
        await chrome.storage.sync.set(syncPayload);
        syncSaved = true;
      } catch (error) {
        console.warn('[copy-flow] [dispatch:token-sync-save-failed]', error);
      }
    }
  }

  if (!localSaved && !syncSaved) {
    return { success: false, reason: 'storage_unavailable' };
  }

  watchlistDispatchCredentialsCache = {
    secret,
    secretSource: localSaved ? 'storage_local' : 'storage_sync',
    intakeUrl,
    intakeUrlSource: localSaved ? 'storage_local' : 'storage_sync',
    keyId,
    keyIdSource: localSaved ? 'storage_local' : 'storage_sync',
  };
  return { success: true, source: localSaved ? 'storage_local' : 'storage_sync', localSaved, syncSaved };
}

async function clearWatchlistDispatchToken() {
  const keys = getWatchlistCredentialStorageKeys();
  if (chrome?.storage?.local?.remove) {
    const localKeys = [keys.secretLocalKey, keys.intakeUrlLocalKey, keys.keyIdLocalKey].filter(Boolean);
    if (localKeys.length > 0) {
      try {
        await chrome.storage.local.remove(localKeys);
      } catch (error) {
        console.warn('[copy-flow] [dispatch:token-local-clear-failed]', error);
      }
    }
  }
  if (chrome?.storage?.sync?.remove) {
    const syncKeys = [keys.secretSyncKey, keys.intakeUrlSyncKey, keys.keyIdSyncKey].filter(Boolean);
    if (syncKeys.length > 0) {
      try {
        await chrome.storage.sync.remove(syncKeys);
      } catch (error) {
        console.warn('[copy-flow] [dispatch:token-sync-clear-failed]', error);
      }
    }
  }

  watchlistDispatchCredentialsCache = null;
  return {
    success: true,
    hasToken: false,
    source: 'missing'
  };
}

async function sha256HexForDispatch(value) {
  const encoder = new TextEncoder();
  const data = encoder.encode(typeof value === 'string' ? value : String(value || ''));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256Hex(secret, canonical) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(canonical));
  return Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function generateWatchlistNonce() {
  if (typeof crypto?.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function buildWatchlistCanonicalString({ method, path, timestamp, nonce, bodyHash }) {
  return [
    String(method || 'POST').toUpperCase(),
    String(path || '/'),
    String(timestamp || ''),
    String(nonce || ''),
    String(bodyHash || ''),
  ].join('\\n');
}

async function sendWatchlistDispatch(payload, copyTrace = 'no-run/no-response') {
  if (!WATCHLIST_DISPATCH.enabled) {
    return { skipped: true, reason: 'dispatch_disabled' };
  }

  const dispatchConfig = await resolveWatchlistDispatchConfiguration();
  if (!dispatchConfig.ok) {
    return { skipped: true, reason: dispatchConfig.reason || 'missing_dispatch_credentials' };
  }

  const urlCandidates = buildWatchlistDispatchUrlCandidates(dispatchConfig.intakeUrl);
  if (urlCandidates.length === 0) {
    return { success: false, reason: 'missing_intake_url', error: 'missing_intake_url' };
  }
  const body = JSON.stringify(payload);
  const maxAttempts = Math.max(1, Number(WATCHLIST_DISPATCH.retryCount || 0) + 1);
  let lastFailure = { success: false, error: 'unknown', reason: 'dispatch_error', status: null, requestId: '' };

  for (let candidateIndex = 0; candidateIndex < urlCandidates.length; candidateIndex += 1) {
    const url = urlCandidates[candidateIndex];
    const urlObject = new URL(url);
    const usingFallbackUrl = candidateIndex > 0;

    console.log('[copy-flow] [dispatch:send-start]', {
      trace: copyTrace,
      intakeUrl: url,
      usingFallbackUrl,
      urlCandidateIndex: candidateIndex + 1,
      urlCandidatesCount: urlCandidates.length,
      keyId: dispatchConfig.keyId,
      maxAttempts,
      timeoutMs: WATCHLIST_DISPATCH.timeoutMs,
      credentialSources: {
        secret: dispatchConfig.secretSource || 'unknown',
        intakeUrl: dispatchConfig.intakeUrlSource || 'unknown',
        keyId: dispatchConfig.keyIdSource || 'unknown'
      },
      payload: summarizeWatchlistDispatchPayload(payload)
    });

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), WATCHLIST_DISPATCH.timeoutMs);
      try {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const nonce = generateWatchlistNonce();
        const bodyHash = await sha256HexForDispatch(body);
        const canonical = buildWatchlistCanonicalString({
          method: 'POST',
          path: urlObject.pathname || '/',
          timestamp,
          nonce,
          bodyHash,
        });
        const signature = await hmacSha256Hex(dispatchConfig.secret, canonical);

        console.log(`[copy-flow] [dispatch:attempt] trace=${copyTrace} attempt=${attempt}/${maxAttempts} intakeUrl=${url}`);
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Watchlist-Key-Id': dispatchConfig.keyId,
            'X-Watchlist-Timestamp': timestamp,
            'X-Watchlist-Nonce': nonce,
            'X-Watchlist-Signature': signature,
          },
          body,
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          const requestId = response.headers?.get?.('x-request-id') || response.headers?.get?.('x-correlation-id') || '';
          const normalizedErrorText = truncateDispatchLogText(errorText, 500);
          const httpError = new Error(
            `HTTP ${response.status}${normalizedErrorText ? ` ${normalizedErrorText}` : ''}`
          );
          httpError.dispatchMeta = {
            reason: 'http_error',
            status: response.status,
            requestId,
            responseSnippet: normalizedErrorText
          };
          throw httpError;
        }

        const requestId = response.headers?.get?.('x-request-id') || response.headers?.get?.('x-correlation-id') || '';
        let responseJson = null;
        try {
          responseJson = await response.json();
        } catch {
          responseJson = null;
        }
        console.log('[copy-flow] [dispatch:ok]', {
          trace: copyTrace,
          intakeUrl: url,
          status: response.status,
          requestId,
          responseBody: responseJson && typeof responseJson === 'object'
            ? {
              status: responseJson.status || '',
              event_id: responseJson.event_id || null
            }
            : null
        });
        return { success: true, status: response.status, eventId: responseJson?.event_id || null };
      } catch (error) {
        clearTimeout(timeoutId);
        const errorMessage = error?.message || String(error);
        const dispatchMeta = error?.dispatchMeta && typeof error.dispatchMeta === 'object'
          ? error.dispatchMeta
          : {};
        if (!dispatchMeta.reason && error?.name === 'AbortError') {
          dispatchMeta.reason = 'timeout';
        }
        const dispatchReason = dispatchMeta.reason || 'dispatch_error';
        const hasAnotherUrlCandidate = candidateIndex < (urlCandidates.length - 1);
        const switchCandidateEarly = shouldSwitchWatchlistUrlCandidateEarly({
          usingFallbackUrl,
          hasAnotherUrlCandidate,
          dispatchReason,
          statusCode: dispatchMeta.status ?? null
        });
        const retryDelayMs = WATCHLIST_DISPATCH.backoffMs * attempt;
        if (attempt < maxAttempts) {
          if (switchCandidateEarly) {
            console.warn('[copy-flow] [dispatch:switch-url-candidate]', {
              trace: copyTrace,
              fromIntakeUrl: url,
              toCandidateIndex: candidateIndex + 2,
              reason: dispatchReason,
              error: truncateDispatchLogText(errorMessage, 500)
            });
            break;
          }
          console.warn('[copy-flow] [dispatch:retry]', {
            trace: copyTrace,
            intakeUrl: url,
            attempt: `${attempt}/${maxAttempts}`,
            retryDelayMs,
            error: truncateDispatchLogText(errorMessage, 500),
            reason: dispatchReason,
            status: dispatchMeta.status || null,
            requestId: dispatchMeta.requestId || ''
          });
          await sleep(retryDelayMs);
          continue;
        }

        lastFailure = {
          success: false,
          error: errorMessage,
          reason: dispatchReason,
          status: dispatchMeta.status || null,
          requestId: dispatchMeta.requestId || ''
        };

        const failedLogMethod = hasAnotherUrlCandidate ? 'warn' : 'error';
        console[failedLogMethod]('[copy-flow] [dispatch:failed]', {
          trace: copyTrace,
          intakeUrl: url,
          usingFallbackUrl,
          attempts: maxAttempts,
          hasAnotherUrlCandidate,
          error: truncateDispatchLogText(errorMessage, 700),
          reason: dispatchReason,
          status: dispatchMeta.status || null,
          requestId: dispatchMeta.requestId || '',
          responseSnippet: dispatchMeta.responseSnippet || ''
        });
      }
    }
  }

  return lastFailure;
}

function normalizeWatchlistFlushReason(rawReason, fallback = 'manual') {
  if (typeof rawReason !== 'string') return fallback;
  const trimmed = rawReason.trim();
  if (!trimmed) return fallback;
  return trimmed.slice(0, 80);
}

async function flushWatchlistDispatchOutbox(reason = 'manual') {
  const normalizedReason = normalizeWatchlistFlushReason(reason, 'manual');
  const ts = Date.now();
  if (!WATCHLIST_DISPATCH.enabled) {
    appendWatchlistDispatchHistory({
      ts,
      kind: 'flush',
      reason: normalizedReason,
      skipped: true,
      skipReason: 'dispatch_disabled',
      queued: 0,
      sent: 0,
      failed: 0,
      deferred: 0,
      remaining: 0
    }).catch(() => {});
    return { skipped: true, reason: 'dispatch_disabled' };
  }
  if (watchlistDispatchFlushInProgress) {
    watchlistDispatchFlushPending = true;
    if (!watchlistDispatchFlushPendingReason) {
      watchlistDispatchFlushPendingReason = normalizedReason;
    }
    appendWatchlistDispatchHistory({
      ts,
      kind: 'flush',
      reason: normalizedReason,
      skipped: true,
      skipReason: 'flush_in_progress',
      queued: 0,
      sent: 0,
      failed: 0,
      deferred: 0,
      remaining: 0
    }).catch(() => {});
    return {
      skipped: true,
      reason: 'flush_in_progress',
      followUpScheduled: true
    };
  }

  watchlistDispatchFlushInProgress = true;
  try {
    const queued = await readWatchlistOutbox();
    console.log(`[copy-flow] [dispatch:flush-start] reason=${normalizedReason} queued=${queued.length}`);
    if (queued.length === 0) {
      console.log(`[copy-flow] [dispatch:flush-empty] reason=${normalizedReason}`);
      appendWatchlistDispatchHistory({
        ts,
        kind: 'flush',
        reason: normalizedReason,
        success: true,
        queued: 0,
        sent: 0,
        failed: 0,
        deferred: 0,
        remaining: 0
      }).catch(() => {});
      return { success: true, sent: 0, failed: 0, deferred: 0, remaining: 0 };
    }

    const remaining = [];
    let sent = 0;
    let failed = 0;
    let deferred = 0;
    const now = Date.now();
    let firstFailure = '';

    for (const item of queued) {
      if (!item || typeof item !== 'object' || !item.payload || typeof item.payload !== 'object') {
        failed += 1;
        if (!firstFailure) {
          firstFailure = 'invalid_queue_item';
        }
        console.warn('[copy-flow] [dispatch:item-invalid] reason=invalid_queue_item');
        continue;
      }

      const nextAttemptAt = Number.isInteger(item.nextAttemptAt) ? item.nextAttemptAt : 0;
      if (nextAttemptAt > now) {
        deferred += 1;
        const waitMs = Math.max(0, nextAttemptAt - now);
        const trace = buildCopyTrace(item.payload.runId || '', item.payload.responseId || '');
        console.log(`[copy-flow] [dispatch:item-deferred] trace=${trace} waitMs=${waitMs}`);
        remaining.push(item);
        continue;
      }

      const payload = item.payload;
      const trace = buildCopyTrace(payload.runId || '', payload.responseId || '');
      const dispatchResult = await sendWatchlistDispatch(payload, trace);
      if (dispatchResult.success) {
        sent += 1;
        continue;
      }

      failed += 1;
      const attemptCount = (Number.isInteger(item.attemptCount) ? item.attemptCount : 0) + 1;
      const retryDelayMs = Math.min(
        WATCHLIST_DISPATCH.maxBackoffMs,
        Math.max(1000, WATCHLIST_DISPATCH.backoffMs * attemptCount)
      );
      const dispatchError = dispatchResult.reason || dispatchResult.error || 'dispatch_failed';
      if (!firstFailure) {
        firstFailure = truncateDispatchLogText(`${trace}:${dispatchError}`, 300);
      }
      console.warn(
        `[copy-flow] [dispatch:item-failed] trace=${trace} attemptCount=${attemptCount} retryInMs=${retryDelayMs} error=${truncateDispatchLogText(dispatchError, 400)}`
      );
      remaining.push({
        ...item,
        attemptCount,
        nextAttemptAt: Date.now() + retryDelayMs,
        lastError: dispatchError
      });
    }

    const persisted = await writeWatchlistOutbox(remaining);
    console.log(
      `[copy-flow] [dispatch:flush] reason=${normalizedReason} sent=${sent} failed=${failed} deferred=${deferred} remaining=${persisted.length}`
    );
    appendWatchlistDispatchHistory({
      ts,
      kind: 'flush',
      reason: normalizedReason,
      success: true,
      queued: queued.length,
      sent,
      failed,
      deferred,
      remaining: persisted.length,
      error: firstFailure || ''
    }).catch(() => {});
    return {
      success: true,
      sent,
      failed,
      deferred,
      remaining: persisted.length,
      firstFailure: firstFailure || ''
    };
  } finally {
    watchlistDispatchFlushInProgress = false;
    if (watchlistDispatchFlushPending) {
      const pendingReason = normalizeWatchlistFlushReason(
        `follow_up:${watchlistDispatchFlushPendingReason || normalizedReason}`,
        'follow_up'
      );
      watchlistDispatchFlushPending = false;
      watchlistDispatchFlushPendingReason = '';
      console.log(`[copy-flow] [dispatch:flush-follow-up] reason=${pendingReason}`);
      Promise.resolve()
        .then(() => flushWatchlistDispatchOutbox(pendingReason))
        .catch((error) => {
          console.warn('[copy-flow] [dispatch:flush-follow-up-failed]', {
            reason: pendingReason,
            error: error?.message || String(error)
          });
        });
    }
  }
}

function ensureWatchlistDispatchAlarm() {
  if (!WATCHLIST_DISPATCH.enabled) return;
  if (!chrome?.alarms?.create) return;
  try {
    chrome.alarms.create(WATCHLIST_DISPATCH.alarmName, {
      periodInMinutes: WATCHLIST_DISPATCH.alarmPeriodMinutes
    });
  } catch (error) {
    console.warn('[copy-flow] [dispatch:alarm-failed]', error);
  }
}

function getAlarmSafe(alarmName) {
  return new Promise((resolve) => {
    if (!chrome?.alarms?.get) {
      resolve(null);
      return;
    }
    try {
      chrome.alarms.get(alarmName, (alarm) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(alarm || null);
      });
    } catch (error) {
      resolve(null);
    }
  });
}

function clearAlarmSafe(alarmName) {
  return new Promise((resolve) => {
    if (!chrome?.alarms?.clear) {
      resolve(false);
      return;
    }
    try {
      chrome.alarms.clear(alarmName, (cleared) => {
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        resolve(!!cleared);
      });
    } catch (error) {
      resolve(false);
    }
  });
}

async function readAutoRestoreWindowsLastCycle() {
  try {
    const key = AUTO_RESTORE_WINDOWS.lastCycleStorageKey;
    const result = await chrome.storage.local.get([key]);
    const record = result?.[key];
    if (!record || typeof record !== 'object') return null;
    return record;
  } catch (error) {
    return null;
  }
}

async function writeAutoRestoreWindowsLastCycle(record) {
  try {
    const key = AUTO_RESTORE_WINDOWS.lastCycleStorageKey;
    await chrome.storage.local.set({ [key]: record });
  } catch (error) {
    console.warn('[auto-restore] save last cycle failed:', error?.message || error);
  }
}

async function notifyAutoRestoreStatusUpdated(payload = {}) {
  if (!chrome?.runtime?.sendMessage) return;
  try {
    await chrome.runtime.sendMessage({
      type: 'AUTO_RESTORE_STATUS_UPDATED',
      ts: Date.now(),
      ...(payload && typeof payload === 'object' ? payload : {})
    });
  } catch (error) {
    // No receiving side is expected when popup is closed.
  }
}

async function collectTabConversationMetricsForAutoRestore(tabId) {
  if (!Number.isInteger(tabId)) {
    return { success: false, error: 'invalid_tab_id' };
  }

  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      function: () => {
        const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
        const countWords = (text) => {
          const normalized = normalize(text).toLowerCase();
          if (!normalized) return 0;
          return normalized
            .split(/[\s,.;:!?()[\]{}"'<>\-_/\\|]+/)
            .map((token) => token.trim())
            .filter((token) => token.length > 0)
            .length;
        };
        const countSentences = (text) => {
          const normalized = normalize(text);
          if (!normalized) return 0;
          const parts = normalized.match(/[^.!?\n]+(?:[.!?]+|$)/g) || [];
          return parts
            .map((part) => normalize(part))
            .filter((part) => part.length > 0 && countWords(part) > 0)
            .length;
        };

        const messageNodes = Array.from(
          document.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"]')
        );

        let lastUserIndex = -1;
        let lastAssistantIndex = -1;
        let lastUserText = '';
        let lastAssistantText = '';
        let userBlocks = 0;
        let assistantBlocks = 0;

        messageNodes.forEach((node, index) => {
          const role = String(node?.getAttribute?.('data-message-author-role') || '').trim();
          const text = normalize(node?.innerText || node?.textContent || '');
          if (role === 'user') {
            userBlocks += 1;
            lastUserIndex = index;
            lastUserText = text;
          } else if (role === 'assistant') {
            assistantBlocks += 1;
            lastAssistantIndex = index;
            lastAssistantText = text;
          }
        });

        const hasAssistantAfterLastUser = lastUserIndex >= 0
          ? (lastAssistantIndex > lastUserIndex)
          : null;
        const assistantWordCount = countWords(lastAssistantText);
        const assistantSentenceCount = countSentences(lastAssistantText);

        return {
          success: true,
          userBlocks,
          assistantBlocks,
          lastUserIndex,
          lastAssistantIndex,
          hasAssistantAfterLastUser,
          lastUserWordCount: countWords(lastUserText),
          lastAssistantWordCount: assistantWordCount,
          lastAssistantSentenceCount: assistantSentenceCount,
          lastAssistantCharCount: lastAssistantText.length,
          lastUserPreview: lastUserText.slice(0, 220),
          lastAssistantPreview: lastAssistantText.slice(0, 220),
          url: typeof location?.href === 'string' ? location.href : ''
        };
      }
    });

    const payload = result?.[0]?.result;
    if (!payload || typeof payload !== 'object') {
      return { success: false, error: 'invalid_payload' };
    }

    return {
      success: payload.success === true,
      userBlocks: Number.isInteger(payload.userBlocks) ? payload.userBlocks : 0,
      assistantBlocks: Number.isInteger(payload.assistantBlocks) ? payload.assistantBlocks : 0,
      lastUserIndex: Number.isInteger(payload.lastUserIndex) ? payload.lastUserIndex : -1,
      lastAssistantIndex: Number.isInteger(payload.lastAssistantIndex) ? payload.lastAssistantIndex : -1,
      hasAssistantAfterLastUser: typeof payload.hasAssistantAfterLastUser === 'boolean'
        ? payload.hasAssistantAfterLastUser
        : null,
      lastUserWordCount: Number.isInteger(payload.lastUserWordCount) ? payload.lastUserWordCount : 0,
      lastAssistantWordCount: Number.isInteger(payload.lastAssistantWordCount) ? payload.lastAssistantWordCount : 0,
      lastAssistantSentenceCount: Number.isInteger(payload.lastAssistantSentenceCount) ? payload.lastAssistantSentenceCount : 0,
      lastAssistantCharCount: Number.isInteger(payload.lastAssistantCharCount) ? payload.lastAssistantCharCount : 0,
      lastUserPreview: typeof payload.lastUserPreview === 'string' ? payload.lastUserPreview : '',
      lastAssistantPreview: typeof payload.lastAssistantPreview === 'string' ? payload.lastAssistantPreview : '',
      url: typeof payload.url === 'string' ? payload.url : ''
    };
  } catch (error) {
    return { success: false, error: error?.message || String(error) };
  }
}

async function collectAutoRestoreProcessHealthSnapshot(options = {}) {
  await ensureProcessRegistryReady();
  const processSnapshot = await getProcessSnapshot();
  const activeProcesses = processSnapshot
    .filter((process) => process && !isClosedProcessStatus(process.status))
    .sort(compareProcessesForRestore);

  const minAssistantWords = Number.isInteger(options?.minAssistantWords) && options.minAssistantWords > 0
    ? options.minAssistantWords
    : AUTO_RESTORE_WINDOWS.minAssistantWords;
  const minAssistantSentences = Number.isInteger(options?.minAssistantSentences) && options.minAssistantSentences > 0
    ? options.minAssistantSentences
    : AUTO_RESTORE_WINDOWS.minAssistantSentences;
  const maxIssueItems = Number.isInteger(options?.maxIssueItems) && options.maxIssueItems > 0
    ? options.maxIssueItems
    : AUTO_RESTORE_WINDOWS.maxIssueItems;

  const reasonCounts = {};
  const allItems = [];
  const issueItems = [];

  for (const process of activeProcesses) {
    const processItem = {
      runId: typeof process?.id === 'string' ? process.id : '',
      title: typeof process?.title === 'string' ? process.title : '',
      status: typeof process?.status === 'string' ? process.status : '',
      analysisType: typeof process?.analysisType === 'string' ? process.analysisType : '',
      tabId: Number.isInteger(process?.tabId) ? process.tabId : null,
      windowId: Number.isInteger(process?.windowId) ? process.windowId : null,
      currentPrompt: Number.isInteger(process?.currentPrompt) ? process.currentPrompt : 0,
      totalPrompts: Number.isInteger(process?.totalPrompts) ? process.totalPrompts : 0,
      issueFlags: [],
      userBlocks: 0,
      assistantBlocks: 0,
      lastAssistantWordCount: 0,
      lastAssistantSentenceCount: 0,
      lastAssistantCharCount: 0,
      lastAssistantPreview: '',
      lastUserPreview: ''
    };

    if (!!process?.needsAction) processItem.issueFlags.push('needs_action');
    if (isFailedProcessStatus(process?.status)) processItem.issueFlags.push('failed_status');

    if (!Number.isInteger(processItem.tabId)) {
      processItem.issueFlags.push('missing_tab_context');
    } else {
      const tab = await getTabByIdSafe(processItem.tabId);
      if (!tab) {
        processItem.issueFlags.push('tab_not_found');
      } else if (!isChatGptUrl(getTabEffectiveUrl(tab))) {
        processItem.issueFlags.push('tab_not_chatgpt');
      } else {
        const metrics = await collectTabConversationMetricsForAutoRestore(processItem.tabId);
        if (!metrics.success) {
          processItem.issueFlags.push('metrics_unavailable');
        } else {
          processItem.userBlocks = metrics.userBlocks;
          processItem.assistantBlocks = metrics.assistantBlocks;
          processItem.lastAssistantWordCount = metrics.lastAssistantWordCount;
          processItem.lastAssistantSentenceCount = metrics.lastAssistantSentenceCount;
          processItem.lastAssistantCharCount = metrics.lastAssistantCharCount;
          processItem.lastAssistantPreview = metrics.lastAssistantPreview;
          processItem.lastUserPreview = metrics.lastUserPreview;

          if (metrics.hasAssistantAfterLastUser === false) {
            processItem.issueFlags.push('missing_assistant_reply');
          } else if (metrics.hasAssistantAfterLastUser === true) {
            if (metrics.lastAssistantWordCount <= 0 || metrics.lastAssistantCharCount <= 0) {
              processItem.issueFlags.push('assistant_reply_empty');
            } else if (
              metrics.lastAssistantWordCount < minAssistantWords
              || metrics.lastAssistantSentenceCount < minAssistantSentences
            ) {
              processItem.issueFlags.push('assistant_reply_too_short');
            }
          }
        }
      }
    }

    processItem.issueFlags = Array.from(new Set(processItem.issueFlags));
    allItems.push(processItem);

    if (processItem.issueFlags.length > 0) {
      issueItems.push(processItem);
      processItem.issueFlags.forEach((flag) => {
        reasonCounts[flag] = (reasonCounts[flag] || 0) + 1;
      });
    }
  }

  return {
    checkedAt: Date.now(),
    totalActiveProcesses: activeProcesses.length,
    checkedProcesses: allItems.length,
    issueProcesses: issueItems.length,
    scanRecommended: issueItems.length > 0,
    thresholds: {
      minAssistantWords,
      minAssistantSentences
    },
    reasonCounts,
    items: issueItems.slice(0, maxIssueItems)
  };
}

async function getAutoRestoreWindowsEnabled() {
  try {
    const key = AUTO_RESTORE_WINDOWS.enabledStorageKey;
    const result = await chrome.storage.local.get([key]);
    if (typeof result?.[key] === 'boolean') {
      return result[key] === true;
    }
    // Default behavior: enabled unless explicitly disabled by user.
    return true;
  } catch (error) {
    // Fail-safe toward default ON.
    return true;
  }
}

async function syncAutoRestoreWindowsAlarm() {
  const enabled = await getAutoRestoreWindowsEnabled();
  if (!chrome?.alarms?.create) {
    return { enabled, alarmActive: false, nextRunAt: null };
  }

  if (enabled) {
    try {
      chrome.alarms.create(AUTO_RESTORE_WINDOWS.alarmName, {
        delayInMinutes: AUTO_RESTORE_WINDOWS.alarmPeriodMinutes,
        periodInMinutes: AUTO_RESTORE_WINDOWS.alarmPeriodMinutes
      });
    } catch (error) {
      console.warn('[auto-restore] create alarm failed:', error);
    }
  } else {
    await clearAlarmSafe(AUTO_RESTORE_WINDOWS.alarmName);
  }

  const alarm = await getAlarmSafe(AUTO_RESTORE_WINDOWS.alarmName);
  return {
    enabled,
    alarmActive: !!alarm,
    nextRunAt: Number.isInteger(alarm?.scheduledTime) ? alarm.scheduledTime : null
  };
}

async function getAutoRestoreWindowsStatus(options = {}) {
  const lastCycle = await readAutoRestoreWindowsLastCycle();
  if (options?.forceSync) {
    const synced = await syncAutoRestoreWindowsAlarm();
    return {
      success: true,
      enabled: !!synced.enabled,
      alarmActive: !!synced.alarmActive,
      nextRunAt: synced.nextRunAt,
      periodInMinutes: AUTO_RESTORE_WINDOWS.alarmPeriodMinutes,
      inProgress: autoRestoreWindowsInProgress,
      lastCycle
    };
  }

  const enabled = await getAutoRestoreWindowsEnabled();
  const alarm = await getAlarmSafe(AUTO_RESTORE_WINDOWS.alarmName);
  return {
    success: true,
    enabled,
    alarmActive: !!alarm,
    nextRunAt: Number.isInteger(alarm?.scheduledTime) ? alarm.scheduledTime : null,
    periodInMinutes: AUTO_RESTORE_WINDOWS.alarmPeriodMinutes,
    inProgress: autoRestoreWindowsInProgress,
    lastCycle
  };
}

async function setAutoRestoreWindowsEnabled(enabled) {
  const nextEnabled = enabled === true;
  const key = AUTO_RESTORE_WINDOWS.enabledStorageKey;
  await chrome.storage.local.set({ [key]: nextEnabled });
  const status = await getAutoRestoreWindowsStatus({ forceSync: true });
  return { success: true, ...status };
}

async function runAutoRestoreWindowsCycle(options = {}) {
  const origin = typeof options?.origin === 'string' && options.origin.trim()
    ? options.origin.trim()
    : 'auto-restore-cycle';

  const enabled = await getAutoRestoreWindowsEnabled();
  if (!enabled) {
    return {
      success: true,
      skipped: true,
      reason: 'auto_restore_disabled',
      origin
    };
  }

  if (autoRestoreWindowsInProgress) {
    return {
      success: true,
      skipped: true,
      reason: 'auto_restore_already_running',
      origin
    };
  }

  autoRestoreWindowsInProgress = true;
  try {
    const cycleStartedAt = Date.now();
    const restoreResult = await restoreProcessWindows({ origin });
    const healthCheck = await collectAutoRestoreProcessHealthSnapshot({ origin });

    let scanResult = null;
    let scanTriggered = false;
    if (healthCheck.scanRecommended) {
      scanTriggered = true;
      try {
        scanResult = await runResetScanStartAllTabs({
          origin: `${origin}:health_scan`,
          scope: RESUME_ALL_SCOPE_ACTIVE_COMPANY_INVEST
        });
      } catch (error) {
        scanResult = {
          success: false,
          error: error?.message || String(error),
          summary: null,
          startedTabs: 0,
          resumedTabs: 0,
          matchedTabs: 0
        };
      }
    }

    const cycleRecord = {
      ts: Date.now(),
      origin,
      durationMs: Date.now() - cycleStartedAt,
      restore: {
        requested: Number.isInteger(restoreResult?.requested) ? restoreResult.requested : 0,
        restored: Number.isInteger(restoreResult?.restored) ? restoreResult.restored : 0,
        failed: Number.isInteger(restoreResult?.failed) ? restoreResult.failed : 0,
        skipped: Number.isInteger(restoreResult?.skipped) ? restoreResult.skipped : 0
      },
      check: healthCheck,
      scan: {
        triggered: scanTriggered,
        success: scanResult ? (scanResult.success === true) : null,
        startedTabs: Number.isInteger(scanResult?.startedTabs)
          ? scanResult.startedTabs
          : (Number.isInteger(scanResult?.resumedTabs) ? scanResult.resumedTabs : 0),
        matchedTabs: Number.isInteger(scanResult?.matchedTabs) ? scanResult.matchedTabs : 0,
        error: typeof scanResult?.error === 'string' ? scanResult.error : '',
        summary: scanResult?.summary && typeof scanResult.summary === 'object'
          ? scanResult.summary
          : null
      }
    };
    await writeAutoRestoreWindowsLastCycle(cycleRecord);
    await notifyAutoRestoreStatusUpdated({
      origin,
      cycleTs: cycleRecord.ts,
      issueProcesses: Number.isInteger(cycleRecord?.check?.issueProcesses) ? cycleRecord.check.issueProcesses : 0,
      scanTriggered: cycleRecord?.scan?.triggered === true
    });

    return {
      success: true,
      skipped: false,
      origin,
      ...restoreResult,
      healthCheck,
      scan: cycleRecord.scan,
      cycleTs: cycleRecord.ts
    };
  } finally {
    autoRestoreWindowsInProgress = false;
  }
}

// Load prompts from txt files.
async function loadPrompts() {
  try {
    console.log('[prompts] Loading prompts from files...');

    const companyUrl = chrome.runtime.getURL('prompts-company.txt');
    const companyResponse = await fetch(companyUrl);
    const companyText = await companyResponse.text();

    // Parse by PROMPT_SEPARATOR token in an encoding-safe way.
    PROMPTS_COMPANY = companyText
      .split(/\W+PROMPT_SEPARATOR\W+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    console.log(`[prompts] Loaded company prompts: ${PROMPTS_COMPANY.length}`);

    const portfolioUrl = chrome.runtime.getURL('prompts-portfolio.txt');
    const portfolioResponse = await fetch(portfolioUrl);
    const portfolioText = await portfolioResponse.text();

    // Parse by PROMPT_SEPARATOR token in an encoding-safe way.
    PROMPTS_PORTFOLIO = portfolioText
      .split(/\W+PROMPT_SEPARATOR\W+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    console.log(`[prompts] Loaded portfolio prompts: ${PROMPTS_PORTFOLIO.length}`);
  } catch (error) {
    console.error('[prompts] Failed loading prompts:', error);
    PROMPTS_COMPANY = [];
    PROMPTS_PORTFOLIO = [];
  }
}

// Wczytaj prompty przy starcie rozszerzenia
loadPrompts();
ensureProcessRegistryReady().catch((error) => {
  console.warn('[monitor] Initial process registry load failed:', error);
});
ensureWatchlistDispatchAlarm();
syncAutoRestoreWindowsAlarm().catch((error) => {
  console.warn('[auto-restore] sync alarm on boot failed:', error);
});
logWatchlistDispatchStatusSnapshot('service_worker_boot:before_flush', false).catch(() => {});
flushWatchlistDispatchOutbox('service_worker_boot').catch((error) => {
  console.warn('[copy-flow] [dispatch:flush-error] reason=service_worker_boot', error);
});

// Obsługiwane źródła artykułów
const SUPPORTED_SOURCES = [
  { pattern: "https://*.economist.com/*", name: "The Economist" },
  { pattern: "https://epoch.ai/*", name: "Epoch AI" },
  { pattern: "https://*.epoch.ai/*", name: "Epoch AI" },
  { pattern: "https://asia.nikkei.com/*", name: "Nikkei Asia" },
  { pattern: "https://*.caixinglobal.com/*", name: "Caixin Global" },
  { pattern: "https://*.theafricareport.com/*", name: "The Africa Report" },
  { pattern: "https://*.nzz.ch/*", name: "NZZ" },
  { pattern: "https://*.project-syndicate.org/*", name: "Project Syndicate" },
  { pattern: "https://the-ken.com/*", name: "The Ken" },
  { pattern: "https://*.lazard.com/*", name: "Lazard" },
  { pattern: "https://*.rand.org/*", name: "RAND Corporation" },
  { pattern: "https://www.youtube.com/*", name: "YouTube" },
  { pattern: "https://youtu.be/*", name: "YouTube" },
  { pattern: "https://*.wsj.com/*", name: "Wall Street Journal" },
  { pattern: "https://*.barrons.com/*", name: "Barron's" },
  { pattern: "https://*.foreignaffairs.com/*", name: "Foreign Affairs" },
  { pattern: "https://open.spotify.com/*", name: "Spotify" },
  { pattern: "https://mail.google.com/*", name: "Gmail" }
];

// Funkcja zwracająca tablicę URLi do query
function getSupportedSourcesQuery() {
  return SUPPORTED_SOURCES.map(s => s.pattern);
}

// Tworzenie menu kontekstowego przy instalacji
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "view-responses",
    title: "Pokaz zebrane odpowiedzi",
    contexts: ["all"]
  });
  ensureWatchlistDispatchAlarm();
  syncAutoRestoreWindowsAlarm().catch((error) => {
    console.warn('[auto-restore] sync alarm onInstalled failed:', error);
  });
  logWatchlistDispatchStatusSnapshot('on_installed:before_flush', false).catch(() => {});
  flushWatchlistDispatchOutbox('on_installed').catch((error) => {
    console.warn('[copy-flow] [dispatch:flush-error] reason=on_installed', error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  ensureWatchlistDispatchAlarm();
  syncAutoRestoreWindowsAlarm().catch((error) => {
    console.warn('[auto-restore] sync alarm onStartup failed:', error);
  });
  logWatchlistDispatchStatusSnapshot('on_startup:before_flush', false).catch(() => {});
  flushWatchlistDispatchOutbox('on_startup').catch((error) => {
    console.warn('[copy-flow] [dispatch:flush-error] reason=on_startup', error);
  });
});

if (chrome?.runtime?.onConnect) {
  chrome.runtime.onConnect.addListener((port) => {
    const providerId = extractManualPdfProviderIdFromPort(port);
    if (!providerId) return;

    manualPdfProviderPorts.set(providerId, {
      port,
      lastSeenAt: Date.now()
    });
    console.log('[manual-pdf] provider keepalive connected:', {
      providerId
    });

    if (port?.onMessage?.addListener) {
      port.onMessage.addListener((message) => {
        const incomingProviderId = typeof message?.providerId === 'string'
          ? message.providerId.trim()
          : '';
        if (!incomingProviderId || incomingProviderId !== providerId) return;
        const record = manualPdfProviderPorts.get(providerId);
        if (!record || record.port !== port) return;
        record.lastSeenAt = Date.now();
        manualPdfProviderPorts.set(providerId, record);
      });
    }

    if (port?.onDisconnect?.addListener) {
      port.onDisconnect.addListener(() => {
        const record = manualPdfProviderPorts.get(providerId);
        if (record && record.port === port) {
          manualPdfProviderPorts.delete(providerId);
        }
        console.log('[manual-pdf] provider keepalive disconnected:', {
          providerId
        });
      });
    }
  });
}

if (chrome?.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm || typeof alarm.name !== 'string') return;

    if (alarm.name === WATCHLIST_DISPATCH.alarmName) {
      logWatchlistDispatchStatusSnapshot('alarm:before_flush', false, { alarmName: alarm.name }).catch(() => {});
      flushWatchlistDispatchOutbox('alarm').catch((error) => {
        console.warn('[copy-flow] [dispatch:flush-error] reason=alarm', error);
      });
      return;
    }

    if (alarm.name === AUTO_RESTORE_WINDOWS.alarmName) {
      runAutoRestoreWindowsCycle({ origin: 'auto_restore_alarm' }).catch((error) => {
        console.warn('[auto-restore] cycle failed:', error);
      });
    }
  });
}
// Handler kliknięcia menu kontekstowego
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "view-responses") {
    chrome.tabs.create({
      url: chrome.runtime.getURL('responses.html')
    });
  }
});

// Funkcja zapisująca odpowiedź do storage
async function saveResponse(responseText, source, analysisType = 'company', runId = null, responseId = null, stage = null, conversationUrl = null) {
  try {
    console.log(`\n${'*'.repeat(80)}`);
    console.log(`💾 💾 💾 [saveResponse] ROZPOCZĘTO ZAPISYWANIE 💾 💾 💾`);
    console.log(`${'*'.repeat(80)}`);
    console.log(`Długość tekstu: ${responseText?.length || 0} znaków`);
    console.log(`Źródło: ${source}`);
    console.log(`Typ analizy: ${analysisType}`);
    console.log(`${'*'.repeat(80)}`);
    
    // Walidacja - nie zapisuj pustych odpowiedzi
    if (!responseText || responseText.trim().length === 0) {
      console.warn(`⚠️ [saveResponse] POMINIĘTO - odpowiedź jest pusta (${responseText?.length || 0} znaków)`);
      console.warn(`   Źródło: ${source}`);
      console.warn(`   Typ analizy: ${analysisType}`);
      console.log(`${'*'.repeat(80)}\n`);
      return;
    }
    
    const result = await chrome.storage.session.get(['responses']);
    const storedResponses = Array.isArray(result.responses) ? result.responses : [];
    
    console.log(`📦 Obecny stan storage: ${storedResponses.length} odpowiedzi`);
    
    const normalizedRunId = typeof runId === 'string' && runId.trim()
      ? runId.trim()
      : '';
    const normalizedResponseId = typeof responseId === 'string' && responseId.trim()
      ? responseId.trim()
      : generateResponseId(normalizedRunId);
    const copyTrace = buildCopyTrace(normalizedRunId, normalizedResponseId);
    const copyFingerprint = textFingerprint(responseText);
    console.log(`[copy-flow] [save:start] trace=${copyTrace} len=${responseText.length} fp=${copyFingerprint} analysis=${analysisType}`);
    console.log('[copy-flow] [save:meta]', {
      trace: copyTrace,
      runId: normalizedRunId || '',
      responseId: normalizedResponseId,
      hasStage: !!(stage && typeof stage === 'object' && !Array.isArray(stage)),
      hasConversationUrl: !!(typeof conversationUrl === 'string' && conversationUrl.trim())
    });

    const newResponse = {
      text: responseText,
      timestamp: Date.now(),
      source: source,
      analysisType: analysisType,
      responseId: normalizedResponseId
    };
    if (normalizedRunId) {
      newResponse.runId = normalizedRunId;
    }
    const normalizedStage = stage && typeof stage === 'object' && !Array.isArray(stage)
      ? stage
      : null;
    if (normalizedStage) {
      newResponse.stage = normalizedStage;
    }
    const normalizedConversationUrl = normalizeChatConversationUrl(conversationUrl);
    if (normalizedConversationUrl) {
      newResponse.conversationUrl = normalizedConversationUrl;
    }
    
    const saveMaxAttempts = 4;
    const saveRetryDelayMs = 650;
    let verifiedResponses = storedResponses;
    let lastSaved = null;
    let saveAttemptOk = false;

    for (let attempt = 1; attempt <= saveMaxAttempts; attempt += 1) {
      try {
        const snapshot = await chrome.storage.session.get(['responses']);
        const currentResponses = Array.isArray(snapshot.responses) ? snapshot.responses : [];
        const existingIndex = currentResponses.findIndex((item) => item?.responseId === normalizedResponseId);

        if (existingIndex >= 0) {
          verifiedResponses = currentResponses;
          lastSaved = currentResponses[existingIndex];
          saveAttemptOk = true;
          console.log(`[copy-flow] [save:attempt] trace=${copyTrace} attempt=${attempt}/${saveMaxAttempts} dedupe=existing index=${existingIndex}`);
          break;
        }

        const responsesToStore = [...currentResponses, newResponse];
        console.log(`[copy-flow] [save:attempt] trace=${copyTrace} attempt=${attempt}/${saveMaxAttempts} from=${currentResponses.length} target=${responsesToStore.length}`);

        await chrome.storage.session.set({ responses: responsesToStore });

        const verification = await chrome.storage.session.get(['responses']);
        verifiedResponses = Array.isArray(verification.responses) ? verification.responses : [];
        const candidate = verifiedResponses.find((item) => item?.responseId === normalizedResponseId) || verifiedResponses[verifiedResponses.length - 1];
        const candidateText = typeof candidate?.text === 'string' ? candidate.text : '';
        const candidateFingerprint = textFingerprint(candidateText);
        const textMatch = candidateText === responseText;

        console.log(
          `[copy-flow] [save:verify-attempt] trace=${copyTrace} attempt=${attempt}/${saveMaxAttempts} count=${verifiedResponses.length} fp=${candidateFingerprint} textMatch=${textMatch}`
        );

        if (candidate && textMatch) {
          lastSaved = candidate;
          saveAttemptOk = true;
          break;
        }

        if (attempt < saveMaxAttempts) {
          console.warn(`[copy-flow] [save:retry] trace=${copyTrace} attempt=${attempt}/${saveMaxAttempts} reason=verify_mismatch`);
          await sleep(saveRetryDelayMs * attempt);
        }
      } catch (attemptError) {
        if (attempt < saveMaxAttempts) {
          console.warn(
            `[copy-flow] [save:retry] trace=${copyTrace} attempt=${attempt}/${saveMaxAttempts} reason=${attemptError.message || String(attemptError)}`
          );
          await sleep(saveRetryDelayMs * attempt);
          continue;
        }
        throw attemptError;
      }
    }

    if (!saveAttemptOk || !lastSaved) {
      throw new Error('Storage verification failed after retries');
    }

    const verifiedFingerprint = textFingerprint(lastSaved.text || '');
    console.log(`✅ Weryfikacja storage: OK`);
    console.log(`[copy-flow] [save:verified] trace=${copyTrace} fp=${verifiedFingerprint} match=${verifiedFingerprint === copyFingerprint}`);

    const dispatchOutcome = {
      queued: false,
      queueSize: 0,
      queueSkipped: false,
      queueSkipReason: '',
      flushSkipped: false,
      flushSkipReason: '',
      flushFollowUpScheduled: false,
      sent: 0,
      failed: 0,
      deferred: 0,
      remaining: 0,
      firstFailure: ''
    };

    const dispatchQueueResult = await enqueueWatchlistDispatch(newResponse, copyTrace);
    if (dispatchQueueResult?.queued) {
      dispatchOutcome.queued = true;
      dispatchOutcome.queueSize = Number.isInteger(dispatchQueueResult?.queueSize) ? dispatchQueueResult.queueSize : 0;
      console.log(
        `[copy-flow] [dispatch:queued-ok] trace=${copyTrace} responseId=${dispatchQueueResult.responseId} queueSize=${dispatchQueueResult.queueSize}`
      );
      const flushResult = await flushWatchlistDispatchOutbox('save_response');
      if (flushResult?.skipped) {
        const flushSkipReason = typeof flushResult?.reason === 'string' ? flushResult.reason : 'unknown';
        const flushLogMethod = flushSkipReason === 'flush_in_progress' ? 'log' : 'warn';
        dispatchOutcome.flushSkipped = true;
        dispatchOutcome.flushSkipReason = flushSkipReason;
        dispatchOutcome.flushFollowUpScheduled = flushResult?.followUpScheduled === true;
        console[flushLogMethod](
          `[copy-flow] [dispatch:flush-result] trace=${copyTrace} skipped=true reason=${flushSkipReason} followUpScheduled=${dispatchOutcome.flushFollowUpScheduled}`
        );
      } else {
        dispatchOutcome.sent = Number.isInteger(flushResult?.sent) ? flushResult.sent : 0;
        dispatchOutcome.failed = Number.isInteger(flushResult?.failed) ? flushResult.failed : 0;
        dispatchOutcome.deferred = Number.isInteger(flushResult?.deferred) ? flushResult.deferred : 0;
        dispatchOutcome.remaining = Number.isInteger(flushResult?.remaining) ? flushResult.remaining : 0;
        dispatchOutcome.firstFailure = typeof flushResult?.firstFailure === 'string' ? flushResult.firstFailure : '';
        console.log(
          `[copy-flow] [dispatch:flush-result] trace=${copyTrace} sent=${flushResult?.sent || 0} failed=${flushResult?.failed || 0} deferred=${flushResult?.deferred || 0} remaining=${flushResult?.remaining || 0} firstFailure=${truncateDispatchLogText(flushResult?.firstFailure || '', 180)}`
        );
      }
      await logWatchlistDispatchStatusSnapshot('save_response:post_flush', false, { trace: copyTrace });
    } else if (dispatchQueueResult?.skipped) {
      dispatchOutcome.queueSkipped = true;
      dispatchOutcome.queueSkipReason = typeof dispatchQueueResult?.reason === 'string' ? dispatchQueueResult.reason : 'unknown';
      console.log(
        `[copy-flow] [dispatch:queued-skipped] trace=${copyTrace} reason=${dispatchQueueResult.reason || 'unknown'}`
      );
      await logWatchlistDispatchStatusSnapshot('save_response:queue_skipped', false, {
        trace: copyTrace,
        skipReason: dispatchQueueResult.reason || 'unknown'
      });
    }

    console.log(`\n${'*'.repeat(80)}`);
    console.log(`✅ ✅ ✅ [saveResponse] ZAPISANO I ZWERYFIKOWANO POMYŚLNIE ✅ ✅ ✅`);
    console.log(`${'*'.repeat(80)}`);
    console.log(`Nowy stan: ${verifiedResponses.length} odpowiedzi w storage (zweryfikowano: ${verifiedResponses.length})`);
    console.log(`Preview: "${responseText.substring(0, 150)}..."`);
    console.log(`${'*'.repeat(80)}\n`);
    return {
      success: true,
      response: newResponse,
      copyTrace,
      verifiedCount: verifiedResponses.length,
      dispatch: dispatchOutcome
    };
  } catch (error) {
    console.error(`\n${'!'.repeat(80)}`);
    console.error(`❌ ❌ ❌ [saveResponse] BŁĄD ZAPISYWANIA ❌ ❌ ❌`);
    console.error(`${'!'.repeat(80)}`);
    console.error('Error:', error);
    console.error('Stack:', error.stack);
    console.error(`${'!'.repeat(80)}\n`);
    return null;
  }
}

// Listener na wiadomości z content scriptu i popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SAVE_RESPONSE') {
    saveResponse(
      message.text,
      message.source,
      message.analysisType,
      message.runId,
      message.responseId,
      message.stage || null,
      message.conversationUrl || null
    )
      .then((saveResult) => {
        if (typeof sendResponse === 'function') {
          sendResponse({
            success: !!saveResult?.success,
            saveResult: saveResult
              ? {
                success: !!saveResult.success,
                copyTrace: typeof saveResult.copyTrace === 'string' ? saveResult.copyTrace : '',
                verifiedCount: Number.isInteger(saveResult.verifiedCount) ? saveResult.verifiedCount : null,
                response: saveResult.response && typeof saveResult.response === 'object'
                  ? {
                    responseId: typeof saveResult.response.responseId === 'string' ? saveResult.response.responseId : ''
                  }
                  : null,
                dispatch: saveResult.dispatch && typeof saveResult.dispatch === 'object'
                  ? saveResult.dispatch
                  : null
              }
              : null
          });
        }
      })
      .catch((error) => {
        if (typeof sendResponse === 'function') {
          sendResponse({
            success: false,
            error: error?.message || String(error)
          });
        }
      });
    return true;
  } else if (message.type === 'RUN_ANALYSIS') {
    (async () => {
      const invocationWindowId = Number.isInteger(message?.windowId)
        ? message.windowId
        : (Number.isInteger(sender?.tab?.windowId) ? sender.tab.windowId : null);
      const promptsReady = await ensureCompanyPromptsReady();
      if (!promptsReady) {
        sendResponse({ success: false, error: 'prompts_not_loaded' });
        return;
      }

      runAnalysis({
        invocationWindowId,
        stopExistingInWindow: true
      }).catch((error) => {
        console.error('[run] RUN_ANALYSIS failed:', error);
      });
      sendResponse({ success: true, started: true });
    })().catch((error) => {
      sendResponse({ success: false, error: error?.message || 'run_analysis_start_failed' });
    });
    return true;
  } else if (message.type === 'YT_FETCH_TRANSCRIPT_FOR_TAB') {
    (async () => {
      const targetTabId = Number.isInteger(message?.tabId)
        ? message.tabId
        : (Number.isInteger(sender?.tab?.id) ? sender.tab.id : null);

      if (!Number.isInteger(targetTabId)) {
        sendResponse({
          success: false,
          transcript: '',
          lang: '',
          method: 'none',
          errorCode: 'tab_id_missing',
          error: 'Missing target tab id',
        });
        return;
      }

      let targetTab;
      try {
        targetTab = await chrome.tabs.get(targetTabId);
      } catch (error) {
        sendResponse({
          success: false,
          transcript: '',
          lang: '',
          method: 'none',
          errorCode: 'tab_not_found',
          error: error?.message || 'Unable to get tab info',
        });
        return;
      }

      const targetUrl = typeof targetTab?.url === 'string' ? targetTab.url : '';
      if (!isYouTubeTabUrl(targetUrl)) {
        sendResponse({
          success: false,
          transcript: '',
          lang: '',
          method: 'none',
          errorCode: 'not_youtube_tab',
          error: 'Active tab is not a YouTube page',
          tabId: targetTabId,
          tabUrl: targetUrl,
        });
        return;
      }

      const preferredLanguages = Array.isArray(message?.preferredLanguages) && message.preferredLanguages.length > 0
        ? message.preferredLanguages
        : YT_TRANSCRIPT_PREFERRED_LANGUAGES;
      const timeoutMs = Number.isInteger(message?.timeoutMs) ? message.timeoutMs : YT_TRANSCRIPT_REQUEST_TIMEOUT_MS;
      const maxRetries = Number.isInteger(message?.maxRetries) ? message.maxRetries : YT_TRANSCRIPT_MAX_RETRIES;
      const result = await fetchYouTubeTranscriptForTab(targetTabId, preferredLanguages, { timeoutMs, maxRetries });
      sendResponse({
        ...result,
        tabId: targetTabId,
        tabUrl: targetUrl,
      });
    })().catch((error) => {
      sendResponse({
        success: false,
        transcript: '',
        lang: '',
        method: 'none',
        errorCode: 'runtime_error',
        error: error?.message || 'runtime_error',
      });
    });
    return true;
  } else if (message.type === 'STOP_PROCESS') {
    (async () => {
      const targetWindowId = Number.isInteger(message?.windowId)
        ? message.windowId
        : (Number.isInteger(sender?.tab?.windowId) ? sender.tab.windowId : null);
      if (!Number.isInteger(targetWindowId)) {
        sendResponse({
          success: false,
          matched: 0,
          stopped: 0
        });
        return;
      }
      const result = await stopActiveProcesses({
        windowId: targetWindowId,
        reason: 'manual_stop',
        statusText: 'Przerwano z popup',
        origin: message?.origin || 'popup-stop'
      });
      sendResponse({
        success: true,
        matched: result.matched,
        stopped: result.stopped,
        windowId: result.windowId
      });
    })().catch((error) => {
      console.warn('[monitor] STOP_PROCESS failed:', error);
      sendResponse({
        success: false,
        matched: 0,
        stopped: 0
      });
    });
    return true;
  } else if (message.type === 'MANUAL_SOURCE_SUBMIT') {
    const mode = message?.mode === 'pdf' ? 'pdf' : 'text';
    const normalizedInstances = Math.max(1, Math.min(10, Number.isInteger(message?.instances) ? message.instances : 1));
    console.log('[manual-source] MANUAL_SOURCE_SUBMIT:', {
      mode,
      titleLength: typeof message?.title === 'string' ? message.title.length : 0,
      textLength: typeof message?.text === 'string' ? message.text.length : 0,
      instances: normalizedInstances,
      pdfProviderId: typeof message?.pdfProviderId === 'string' ? message.pdfProviderId : '',
      pdfFiles: Array.isArray(message?.pdfFiles) ? message.pdfFiles.length : 0
    });

    if (mode === 'pdf') {
      const providerId = typeof message?.pdfProviderId === 'string' ? message.pdfProviderId.trim() : '';
      const pdfFiles = Array.isArray(message?.pdfFiles) ? message.pdfFiles : [];
      if (!providerId || pdfFiles.length === 0) {
        sendResponse({ success: false, error: 'invalid_pdf_payload' });
        return true;
      }

      (async () => {
        const promptsReady = await ensureCompanyPromptsReady();
        if (!promptsReady) {
          sendResponse({ success: false, error: 'prompts_not_loaded' });
          return;
        }

        runManualPdfAnalysisQueue({
          title: typeof message?.title === 'string' ? message.title : '',
          instances: normalizedInstances,
          providerId,
          pdfFiles
        }).catch((error) => {
          console.warn('[manual-pdf] queue failed:', error?.message || String(error));
        });

        sendResponse({ success: true, mode: 'pdf', queued: pdfFiles.length * normalizedInstances });
      })().catch((error) => {
        sendResponse({ success: false, error: error?.message || 'manual_pdf_start_failed' });
      });
      return true;
    }

    (async () => {
      const promptsReady = await ensureCompanyPromptsReady();
      if (!promptsReady) {
        sendResponse({ success: false, error: 'prompts_not_loaded' });
        return;
      }

      runManualSourceAnalysis(message.text, message.title, normalizedInstances).catch((error) => {
        console.warn('[manual-source] text mode failed:', error?.message || String(error));
      });
      sendResponse({ success: true, mode: 'text' });
    })().catch((error) => {
      sendResponse({ success: false, error: error?.message || 'manual_source_start_failed' });
    });
    return true;
  } else if (message.type === 'MANUAL_PDF_GET_CHUNK') {
    (async () => {
      const providerId = typeof message?.providerId === 'string' ? message.providerId.trim() : '';
      const token = typeof message?.token === 'string' ? message.token.trim() : '';
      const offset = Number.isInteger(message?.offset) && message.offset >= 0 ? message.offset : 0;
      const chunkSize = Number.isInteger(message?.chunkSize) && message.chunkSize > 0
        ? message.chunkSize
        : MANUAL_PDF_CHUNK_SIZE;

      if (!providerId || !token) {
        sendResponse({ success: false, error: 'invalid_chunk_request' });
        return;
      }

      const chunkResult = await requestManualPdfProviderChunk({
        providerId,
        token,
        offset,
        chunkSize
      });
      sendResponse(chunkResult);
    })().catch((error) => {
      sendResponse({ success: false, error: error?.message || 'chunk_read_failed' });
    });
    return true;
  } else if (message.type === 'GET_PROCESSES') {
    (async () => {
      const processes = await getProcessSnapshot();
      sendResponse({ processes });
    })().catch((error) => {
      console.warn('[monitor] GET_PROCESSES failed:', error);
      sendResponse({ processes: [] });
    });
    return true;
  } else if (message.type === 'GET_WATCHLIST_DISPATCH_STATUS') {
    getWatchlistDispatchStatus(Boolean(message?.forceReload))
      .then((status) => sendResponse({ success: true, ...status }))
      .catch((error) => {
        console.warn('[copy-flow] [dispatch:status-failed]', error);
        sendResponse({ success: false, error: error?.message || 'status_failed' });
      });
    return true;
  } else if (message.type === 'GET_AUTO_RESTORE_WINDOWS_STATUS') {
    getAutoRestoreWindowsStatus({ forceSync: Boolean(message?.forceSync) })
      .then((status) => sendResponse(status))
      .catch((error) => {
        console.warn('[auto-restore] status failed:', error);
        sendResponse({ success: false, error: error?.message || 'auto_restore_status_failed' });
      });
    return true;
  } else if (message.type === 'SET_AUTO_RESTORE_WINDOWS_ENABLED') {
    setAutoRestoreWindowsEnabled(Boolean(message?.enabled))
      .then((status) => sendResponse(status))
      .catch((error) => {
        console.warn('[auto-restore] set enabled failed:', error);
        sendResponse({ success: false, error: error?.message || 'auto_restore_set_failed' });
      });
    return true;
  } else if (message.type === 'FLUSH_WATCHLIST_DISPATCH') {
    (async () => {
      const reason = normalizeWatchlistFlushReason(message?.reason, 'manual_popup');
      console.log('[copy-flow] [dispatch:manual-flush-requested]', { reason });
      const flushResult = await flushWatchlistDispatchOutbox(reason);
      const status = await getWatchlistDispatchStatus(Boolean(message?.forceReload));
      await logWatchlistDispatchStatusSnapshot('manual_flush', false, { reason, flushResult });
      sendResponse({ success: true, flushResult, status });
    })().catch((error) => {
      console.warn('[copy-flow] [dispatch:manual-flush-failed]', error);
      sendResponse({ success: false, error: error?.message || 'manual_flush_failed' });
    });
    return true;
  } else if (message.type === 'SET_WATCHLIST_DISPATCH_TOKEN') {
    const credentials = message?.credentials && typeof message.credentials === 'object'
      ? message.credentials
      : {
        intakeUrl: message?.intakeUrl,
        keyId: message?.keyId,
        secret: message?.token
      };
    setWatchlistDispatchToken(credentials)
      .then(async (result) => {
        if (!result?.success) {
          sendResponse({ success: false, reason: result?.reason || 'token_update_failed' });
          return;
        }

        const [status, flushResult] = await Promise.all([
          getWatchlistDispatchStatus(true),
          flushWatchlistDispatchOutbox('credentials_updated').catch((error) => ({
            success: false,
            error: error?.message || String(error)
          }))
        ]);
        await logWatchlistDispatchStatusSnapshot('credentials_updated', false, { flushResult });
        sendResponse({ success: true, status, flushResult });
      })
      .catch((error) => {
        console.warn('[copy-flow] [dispatch:set-token-failed]', error);
        sendResponse({ success: false, error: error?.message || 'set_token_failed' });
      });
    return true;
  } else if (message.type === 'CLEAR_WATCHLIST_DISPATCH_TOKEN') {
    clearWatchlistDispatchToken()
      .then(async () => {
        const status = await getWatchlistDispatchStatus(true);
        await logWatchlistDispatchStatusSnapshot('credentials_cleared', false);
        sendResponse({ success: true, status });
      })
      .catch((error) => {
        console.warn('[copy-flow] [dispatch:clear-token-failed]', error);
        sendResponse({ success: false, error: error?.message || 'clear_token_failed' });
      });
    return true;
  } else if (message.type === 'PROCESS_PROGRESS') {
    handleProcessProgressMessage(message, sender)
      .then((handled) => sendResponse({ success: !!handled }))
      .catch((error) => {
        console.warn('[monitor] PROCESS_PROGRESS failed:', error);
        sendResponse({ success: false });
      });
    return true;
  } else if (message.type === 'PROCESS_NEEDS_ACTION') {
    handleProcessNeedsActionMessage(message, sender)
      .then((handled) => sendResponse({ success: !!handled }))
      .catch((error) => {
        console.warn('[monitor] PROCESS_NEEDS_ACTION failed:', error);
        sendResponse({ success: false });
      });
    return true;
  } else if (message.type === 'PROCESS_ACTION_RESOLVED') {
    handleProcessActionResolvedMessage(message, sender)
      .then((handled) => sendResponse({ success: !!handled }))
      .catch((error) => {
        console.warn('[monitor] PROCESS_ACTION_RESOLVED failed:', error);
        sendResponse({ success: false });
      });
    return true;
  } else if (message.type === 'PROCESS_DECISION') {
    handleProcessDecisionMessage(message)
      .then((handled) => sendResponse({ success: !!handled }))
      .catch((error) => {
        console.warn('[monitor] PROCESS_DECISION failed:', error);
        sendResponse({ success: false });
      });
    return true;
  } else if (message.type === 'PROCESS_DECISION_ALL') {
    handleProcessDecisionAllMessage(message)
      .then((result) => sendResponse({
        success: (result?.delivered || 0) > 0,
        matched: result?.matched || 0,
        delivered: result?.delivered || 0
      }))
      .catch((error) => {
        console.warn('[monitor] PROCESS_DECISION_ALL failed:', error);
        sendResponse({ success: false, matched: 0, delivered: 0 });
      });
    return true;
  } else if (message.type === 'DETECT_LAST_COMPANY_PROMPT_AND_RESUME') {
    const resumeScope = typeof message?.scope === 'string' && message.scope.trim()
      ? message.scope.trim()
      : RESUME_ALL_SCOPE_ACTIVE_COMPANY_INVEST;
    runResetScanStartAllTabs({
      origin: typeof message?.origin === 'string' ? message.origin : 'runtime-message',
      scope: resumeScope
    })
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.warn('[monitor] DETECT_LAST_COMPANY_PROMPT_AND_RESUME failed:', error);
        sendResponse({
          success: false,
          scannedTabs: 0,
          matchedTabs: 0,
          startedTabs: 0,
          resumedTabs: 0,
          scope: resumeScope,
          summary: {
            started: 0,
            detect_failed: 0,
            reload_failed: 0,
            skipped_non_company: 0,
            skipped_outside_invest: 0,
            final_stage_completed: 0,
            start_failed: 0,
            reload_ok: 0,
            reload_total: 0,
            prompt_blocks: 0,
            response_blocks: 0,
            detected_prompts: 0
          },
          resetSummary: null,
          results: [],
          error: error?.message || String(error)
        });
      });
    return true;
  } else if (message.type === 'PROCESS_RESUME_NEXT_STAGE') {
    handleProcessResumeNextStageMessage(message)
      .then((result) => sendResponse(result || { success: false, error: 'resume_result_missing' }))
      .catch((error) => {
        console.warn('[monitor] PROCESS_RESUME_NEXT_STAGE failed:', error);
        sendResponse({ success: false, error: error?.message || 'resume_exception' });
      });
    return true;
  } else if (message.type === 'RESTORE_PROCESS_WINDOWS') {
    restoreProcessWindows({
      origin: typeof message?.origin === 'string' ? message.origin : 'runtime-message'
    })
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.warn('[monitor] RESTORE_PROCESS_WINDOWS failed:', error);
        sendResponse({
          success: false,
          requested: 0,
          restored: 0,
          opened: 0,
          failed: 0,
          results: [],
          error: error?.message || String(error)
        });
      });
    return true;
  } else if (message.type === 'GET_COMPANY_PROMPTS') {
    // Zwróć prompty dla company
    sendResponse({ prompts: PROMPTS_COMPANY });
    return false;
  } else if (message.type === 'GET_STAGE_NAMES') {
    // Zwróć nazwy etapów
    sendResponse({ stageNames: STAGE_NAMES_COMPANY });
    return false;
  } else if (message.type === 'RESUME_STAGE_START') {
    // Uruchom analizę od konkretnego etapu
    console.log('📩 Otrzymano RESUME_STAGE_START:', { startIndex: message.startIndex });
    const reloadBeforeResume = message?.reloadBeforeResume !== false;
    const resumeOptions = {
      reloadBeforeResume
    };
    if (typeof message?.title === 'string' && message.title.trim()) {
      resumeOptions.processTitle = message.title.trim();
    }
    console.log('[resume] RESUME_STAGE_START options', {
      startIndex: message.startIndex,
      reloadBeforeResume
    });
    resumeFromStage(message.startIndex, resumeOptions)
      .then((result) => sendResponse(result || { success: false, error: 'resume_result_missing' }))
      .catch((error) => {
        console.warn('[resume] RESUME_STAGE_START failed:', error);
        sendResponse({ success: false, error: error?.message || 'resume_exception' });
      });
    return true;
  } else if (message.type === 'RESUME_STAGE_OPEN') {
    // Otworz okno z wyborem etapu
    const startIndex = Number.isInteger(message.startIndex) ? message.startIndex : null;
    const title = typeof message.title === 'string' ? message.title.trim() : '';
    const analysisType = typeof message.analysisType === 'string' ? message.analysisType.trim() : '';

    console.log('[resume] Otrzymano RESUME_STAGE_OPEN', {
      startIndex,
      title,
      analysisType
    });
    openResumeStagePopup(startIndex, title, analysisType);
    sendResponse({ success: true });
    return false;
  } else if (message.type === 'ACTIVATE_TAB') {
    // POPRAWKA: Aktywuj kartę ChatGPT przed wysyłaniem wiadomości
    console.log('🔍 Aktywuję kartę ChatGPT...');
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs[0]) {
        try {
          await chrome.tabs.update(tabs[0].id, { active: true });
          await chrome.windows.update(tabs[0].windowId, { focused: true });
          console.log('✅ Karta ChatGPT aktywowana');
          sendResponse({ success: true });
        } catch (error) {
          console.error('❌ Błąd aktywacji karty:', error);
          sendResponse({ success: false, error: error.message });
        }
      } else {
        sendResponse({ success: false, error: 'No active tab found' });
      }
    });
    return true; // Utrzymuj kanał otwarty dla async
  }
});

// Listener na skróty klawiszowe
chrome.commands.onCommand.addListener((command) => {
  if (command === 'open_responses') {
    chrome.tabs.create({ url: chrome.runtime.getURL('responses.html') });
    return;
  }
  if (command === 'open_process_monitor') {
    chrome.tabs.create({ url: chrome.runtime.getURL('process-monitor.html') });
  }
});

// Funkcja wznawiania od konkretnego etapu
async function resumeFromStage(startIndex, options = {}) {
  const suppressAlerts = !!options?.suppressAlerts;
  const notifyAlert = (message) => {
    if (!suppressAlerts) safeAlert(message);
  };

  console.log(`\n${'='.repeat(80)}`);
  console.log(`[resume] Resume from stage ${Number.isInteger(startIndex) ? (startIndex + 1) : 'unknown'}`);
  console.log(`${'='.repeat(80)}\n`);

  try {
    let activeTab = null;

    if (Number.isInteger(options?.targetTabId)) {
      activeTab = await getTabByIdSafe(options.targetTabId);
      if (!activeTab) {
        notifyAlert('Blad: Nie znaleziono wskazanej karty ChatGPT.');
        return { success: false, error: 'target_tab_not_found' };
      }
    } else {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      activeTab = Array.isArray(tabs) && tabs.length > 0 ? tabs[0] : null;
      if (!activeTab) {
        notifyAlert('Blad: Brak aktywnej karty ChatGPT.');
        return { success: false, error: 'no_active_tab' };
      }
    }

    if (!isChatGptUrl(getTabEffectiveUrl(activeTab))) {
      notifyAlert('Blad: Aktywna karta nie jest ChatGPT.');
      return { success: false, error: 'active_tab_not_chatgpt' };
    }

    if (!Number.isInteger(startIndex) || startIndex < 0) {
      notifyAlert('Blad: Nieprawidlowy indeks etapu.');
      return { success: false, error: 'invalid_start_index' };
    }

    const processTitle = typeof options?.processTitle === 'string' && options.processTitle.trim()
      ? options.processTitle.trim()
      : `Resume from Stage ${startIndex + 1}`;
    const reloadBeforeResume = options?.reloadBeforeResume !== false;

    const resumed = await resumeFromStageOnTab(activeTab.id, activeTab.windowId, startIndex, {
      processTitle,
      reloadBeforeResume
    });

    if (!resumed?.success) {
      const errorCode = resumed?.error || 'resume_failed';
      if (!suppressAlerts) {
        if (errorCode === 'prompts_empty') {
          notifyAlert('Blad: Brak promptow. Sprawdz plik prompts-company.txt.');
        } else if (errorCode === 'start_index_out_of_range') {
          notifyAlert('Blad: Nieprawidlowy indeks etapu.');
        } else if (errorCode === 'tab_not_chatgpt') {
          notifyAlert('Blad: Docelowa karta nie jest ChatGPT.');
        } else if (errorCode === 'reload_failed') {
          notifyAlert('Blad: Nie udalo sie przeladowac karty przed wznowieniem.');
        } else {
          notifyAlert('Blad wznowienia procesu.');
        }
      }
      return { success: false, error: errorCode };
    }

    return {
      success: true,
      processId: resumed.processId,
      startIndex,
      startPromptNumber: startIndex + 1
    };
  } catch (error) {
    console.error('Blad w resumeFromStage:', error);
    notifyAlert('Blad wznowienia procesu.');
    return { success: false, error: error?.message || String(error) };
  }
}

// Funkcja pobierania prompt chain od użytkownika
async function getPromptChain() {
  return new Promise((resolve) => {
    let resolved = false;
    
    // Stwórz małe okno z dialogiem
    chrome.windows.create({
      url: chrome.runtime.getURL('prompt-dialog.html'),
      type: 'popup',
      width: 600,
      height: 400
    }, (window) => {
      const windowId = window.id;
      
      // Listener na wiadomość z dialogu
      const messageListener = (message, sender) => {
        if (message.type === 'PROMPT_CHAIN_SUBMIT') {
          cleanup();
          chrome.windows.remove(sender.tab.windowId, () => {
            if (chrome.runtime.lastError) {
              // Okno już zamknięte - ignoruj
            }
          });
          if (!resolved) {
            resolved = true;
            resolve(message.prompts);
          }
        } else if (message.type === 'PROMPT_CHAIN_CANCEL') {
          cleanup();
          chrome.windows.remove(sender.tab.windowId, () => {
            if (chrome.runtime.lastError) {
              // Okno już zamknięte - ignoruj
            }
          });
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        }
      };
      
      // Listener na zamknięcie okna (ręczne zamknięcie przez X)
      const windowListener = (closedWindowId) => {
        if (closedWindowId === windowId) {
          cleanup();
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        }
      };
      
      function cleanup() {
        chrome.runtime.onMessage.removeListener(messageListener);
        chrome.windows.onRemoved.removeListener(windowListener);
      }
      
      chrome.runtime.onMessage.addListener(messageListener);
      chrome.windows.onRemoved.addListener(windowListener);
    });
  });
}

// Funkcja wyboru artykułów do analizy portfela
async function getArticleSelection(articles) {
  console.log(`getArticleSelection: otrzymano ${articles.length} artykułów`);
  
  return new Promise((resolve) => {
    let resolved = false;
    
    // Przygotuj dane artykułów (title i url)
    const articlesData = articles.map(tab => ({
      title: tab.title || 'Bez tytułu',
      url: tab.url,
      id: tab.id
    }));
    
    console.log(`getArticleSelection: przygotowano dane dla ${articlesData.length} artykułów:`, articlesData);
    
    // Enkoduj dane do URL
    const encodedData = encodeURIComponent(JSON.stringify(articlesData));
    console.log(`getArticleSelection: długość zakodowanych danych: ${encodedData.length} znaków`);
    const selectorUrl = chrome.runtime.getURL(`article-selector.html?articles=${encodedData}`);
    console.log(`getArticleSelection: otwieranie selektora: ${selectorUrl.substring(0, 150)}...`);
    
    // Stwórz małe okno z dialogiem
    chrome.windows.create({
      url: selectorUrl,
      type: 'popup',
      width: 700,
      height: 600
    }, (window) => {
      const windowId = window.id;
      
      // Listener na wiadomość z dialogu
      const messageListener = (message, sender) => {
        if (message.type === 'ARTICLE_SELECTION_SUBMIT') {
          cleanup();
          chrome.windows.remove(sender.tab.windowId, () => {
            if (chrome.runtime.lastError) {
              // Okno już zamknięte - ignoruj
            }
          });
          if (!resolved) {
            resolved = true;
            // Zwróć indeksy zaznaczonych artykułów
            resolve(message.selectedIndices || []);
          }
        } else if (message.type === 'ARTICLE_SELECTION_CANCEL') {
          cleanup();
          chrome.windows.remove(sender.tab.windowId, () => {
            if (chrome.runtime.lastError) {
              // Okno już zamknięte - ignoruj
            }
          });
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        }
      };
      
      // Listener na zamknięcie okna (ręczne zamknięcie przez X)
      const windowListener = (closedWindowId) => {
        if (closedWindowId === windowId) {
          cleanup();
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        }
      };
      
      function cleanup() {
        chrome.runtime.onMessage.removeListener(messageListener);
        chrome.windows.onRemoved.removeListener(windowListener);
      }
      
      chrome.runtime.onMessage.addListener(messageListener);
      chrome.windows.onRemoved.addListener(windowListener);
    });
  });
}

// Funkcja przetwarzająca artykuły z danym prompt chain i URL
function isYouTubeTabUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
  try {
    const parsed = new URL(rawUrl);
    const host = String(parsed.hostname || '').toLowerCase();
    return host.includes('youtube.com') || host.includes('youtu.be');
  } catch (error) {
    return false;
  }
}

function extractYouTubeVideoId(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return '';
  try {
    const parsed = new URL(rawUrl);
    const host = String(parsed.hostname || '').toLowerCase();
    if (host.includes('youtube.com')) {
      const queryVideoId = String(parsed.searchParams.get('v') || '').trim();
      if (queryVideoId) return queryVideoId;
      const pathParts = String(parsed.pathname || '').split('/').filter(Boolean);
      if (pathParts[0] === 'shorts' || pathParts[0] === 'live') {
        return String(pathParts[1] || '').trim();
      }
      return '';
    }
    if (host.includes('youtu.be')) {
      return String(parsed.pathname || '').replace(/^\/+/, '').split('/')[0].trim();
    }
    return '';
  } catch (error) {
    return '';
  }
}

function normalizePreferredTranscriptLanguages(preferredLanguages) {
  const fallback = Array.isArray(YT_TRANSCRIPT_PREFERRED_LANGUAGES) && YT_TRANSCRIPT_PREFERRED_LANGUAGES.length > 0
    ? YT_TRANSCRIPT_PREFERRED_LANGUAGES
    : ['pl', 'en'];
  const source = Array.isArray(preferredLanguages) && preferredLanguages.length > 0
    ? preferredLanguages
    : fallback;

  return Array.from(
    new Set(
      source
        .map((item) => String(item || '').trim().toLowerCase().split('-')[0])
        .filter(Boolean)
    )
  );
}

function buildYouTubeTranscriptCacheKey(videoId, preferredLanguages) {
  const normalizedVideoId = String(videoId || '').trim();
  if (!normalizedVideoId) return '';
  const languages = normalizePreferredTranscriptLanguages(preferredLanguages);
  return `${normalizedVideoId}::${languages.join(',') || 'default'}`;
}

function pruneYouTubeTranscriptCache() {
  const now = Date.now();
  for (const [cacheKey, cacheEntry] of ytTranscriptCache.entries()) {
    if (!cacheEntry || !Number.isFinite(cacheEntry.expiresAt) || cacheEntry.expiresAt <= now) {
      ytTranscriptCache.delete(cacheKey);
    }
  }
  while (ytTranscriptCache.size > YT_TRANSCRIPT_CACHE_MAX_ITEMS) {
    const oldestKey = ytTranscriptCache.keys().next().value;
    if (!oldestKey) break;
    ytTranscriptCache.delete(oldestKey);
  }
}

function getCachedYouTubeTranscript(videoId, preferredLanguages) {
  const cacheKey = buildYouTubeTranscriptCacheKey(videoId, preferredLanguages);
  if (!cacheKey) return null;
  pruneYouTubeTranscriptCache();
  const cacheEntry = ytTranscriptCache.get(cacheKey);
  if (!cacheEntry || !cacheEntry.result) {
    return null;
  }
  return {
    ...cacheEntry.result,
    cacheHit: true,
  };
}

function setCachedYouTubeTranscript(videoId, preferredLanguages, result) {
  const cacheKey = buildYouTubeTranscriptCacheKey(videoId, preferredLanguages);
  if (!cacheKey || !result || result.success !== true) return;
  pruneYouTubeTranscriptCache();
  if (ytTranscriptCache.has(cacheKey)) {
    ytTranscriptCache.delete(cacheKey);
  }
  ytTranscriptCache.set(cacheKey, {
    expiresAt: Date.now() + YT_TRANSCRIPT_CACHE_TTL_MS,
    result: {
      ...result,
      cacheHit: false,
    },
  });
  pruneYouTubeTranscriptCache();
}

function isRetryableYouTubeTranscriptError(errorCode) {
  const normalized = String(errorCode || '').trim().toLowerCase();
  return normalized === 'content_script_unreachable'
    || normalized === 'caption_tracks_timeout'
    || normalized === 'caption_tracks_missing'
    || normalized === 'player_response_missing'
    || normalized === 'timedtext_list_fetch_failed'
    || normalized === 'runtime_error'
    || normalized === 'runtime_timeout'
    || normalized === 'invalid_transcript_response'
    || normalized === 'transcript_fetch_failed';
}

function normalizeYouTubeTranscriptResponse(response) {
  const hasObjectPayload = !!(response && typeof response === 'object');
  const payload = hasObjectPayload ? response : {};
  const transcript = typeof payload.transcript === 'string' ? payload.transcript.trim() : '';
  const success = payload.success === true && transcript.length >= YT_TRANSCRIPT_MIN_CHARS;
  const rawErrorCode = typeof payload.errorCode === 'string' && payload.errorCode.trim()
    ? payload.errorCode.trim().toLowerCase()
    : '';
  const errorCode = success
    ? ''
    : (
      rawErrorCode
      || (!hasObjectPayload ? 'invalid_transcript_response' : '')
      || (transcript.length > 0 && transcript.length < YT_TRANSCRIPT_MIN_CHARS ? 'transcript_too_short' : 'transcript_unavailable')
    );
  const error = success
    ? ''
    : (
      typeof payload.error === 'string' && payload.error.trim()
        ? payload.error.trim()
        : (errorCode === 'invalid_transcript_response' ? 'Invalid response from YouTube content script' : (errorCode || 'transcript_unavailable'))
    );

  return {
    success,
    transcript: success ? transcript : '',
    lang: typeof payload.lang === 'string' ? payload.lang.trim() : '',
    method: typeof payload.method === 'string' ? payload.method.trim() : 'none',
    videoId: typeof payload.videoId === 'string' ? payload.videoId.trim() : '',
    title: typeof payload.title === 'string' ? payload.title : '',
    errorCode,
    error,
    retryable: !success && isRetryableYouTubeTranscriptError(errorCode),
    cacheHit: payload.cacheHit === true,
  };
}

function normalizeYouTubeSendMessageError(error) {
  const message = String(error?.message || error || '').trim();
  const lowered = message.toLowerCase();
  if (lowered.includes('no tab with id')) {
    return {
      errorCode: 'tab_not_found',
      error: message || 'tab_not_found',
      retryable: false,
    };
  }
  if (
    lowered.includes('cannot access contents of url')
    || lowered.includes('cannot access a chrome://')
    || lowered.includes('extensions gallery cannot be scripted')
    || lowered.includes('missing host permission')
  ) {
    return {
      errorCode: 'content_script_injection_blocked',
      error: message || 'content_script_injection_blocked',
      retryable: false,
    };
  }
  if (
    lowered.includes('receiving end does not exist')
    || lowered.includes('could not establish connection')
    || lowered.includes('message port closed')
  ) {
    return {
      errorCode: 'content_script_unreachable',
      error: message || 'content_script_unreachable',
      retryable: true,
    };
  }
  if (lowered.includes('timeout')) {
    return {
      errorCode: 'runtime_timeout',
      error: message || 'runtime_timeout',
      retryable: true,
    };
  }
  return {
    errorCode: 'runtime_error',
    error: message || 'runtime_error',
    retryable: true,
  };
}

async function ensureYouTubeContentScriptInjected(tabId) {
  try {
    const probeResults = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => Boolean(window.__iskraYtTranscriptScriptReady),
    });
    if (Array.isArray(probeResults) && probeResults.some((row) => row?.result === true)) {
      return {
        success: true,
        errorCode: '',
        error: '',
      };
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['youtube-content.js'],
    });
    return {
      success: true,
      errorCode: '',
      error: '',
    };
  } catch (error) {
    const message = String(error?.message || error || '').trim();
    const lowered = message.toLowerCase();
    const blocked = lowered.includes('cannot access contents of url')
      || lowered.includes('cannot access a chrome://')
      || lowered.includes('extensions gallery cannot be scripted')
      || lowered.includes('missing host permission');
    return {
      success: false,
      errorCode: blocked ? 'content_script_injection_blocked' : 'content_script_injection_failed',
      error: message || (blocked ? 'content_script_injection_blocked' : 'content_script_injection_failed'),
    };
  }
}

async function fetchYouTubeTranscriptForTabInternal(tabId, preferredLanguages = YT_TRANSCRIPT_PREFERRED_LANGUAGES, options = {}) {
  const maxRetriesRaw = Number.isInteger(options?.maxRetries) ? options.maxRetries : YT_TRANSCRIPT_MAX_RETRIES;
  const timeoutMsRaw = Number.isInteger(options?.timeoutMs) ? options.timeoutMs : YT_TRANSCRIPT_REQUEST_TIMEOUT_MS;
  const maxRetries = Math.max(1, Math.min(6, maxRetriesRaw));
  const timeoutMs = Math.max(1000, Math.min(30000, timeoutMsRaw));
  const preferred = normalizePreferredTranscriptLanguages(preferredLanguages);
  const useCache = options?.useCache !== false;
  let tabUrl = '';

  try {
    const tab = await chrome.tabs.get(tabId);
    tabUrl = typeof tab?.url === 'string' ? tab.url : '';
  } catch (error) {
    return {
      success: false,
      transcript: '',
      lang: '',
      method: 'none',
      videoId: '',
      title: '',
      errorCode: 'tab_not_found',
      error: error?.message || 'tab_not_found',
      retryable: false,
      attempts: maxRetries,
      attemptUsed: 0,
      cacheHit: false,
    };
  }

  if (!isYouTubeTabUrl(tabUrl)) {
    return {
      success: false,
      transcript: '',
      lang: '',
      method: 'none',
      videoId: '',
      title: '',
      errorCode: 'not_youtube_tab',
      error: 'Active tab is not a YouTube page',
      retryable: false,
      attempts: maxRetries,
      attemptUsed: 0,
      cacheHit: false,
    };
  }

  const initialVideoId = extractYouTubeVideoId(tabUrl);
  if (useCache && initialVideoId) {
    const cached = getCachedYouTubeTranscript(initialVideoId, preferred);
    if (cached && cached.success) {
      return {
        ...cached,
        attempts: maxRetries,
        attemptUsed: 0,
      };
    }
  }

  let lastResult = {
    success: false,
    transcript: '',
    lang: '',
    method: 'none',
    videoId: '',
    title: '',
    errorCode: 'transcript_unavailable',
    error: 'transcript_unavailable',
    retryable: true,
    cacheHit: false,
  };
  let injectionAttempted = false;
  let attemptUsed = 0;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    attemptUsed = attempt;
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: 'GET_TRANSCRIPT',
        preferredLanguages: preferred,
        timeoutMs,
      });

      const normalized = normalizeYouTubeTranscriptResponse(response);
      if (normalized.success) {
        const resolvedVideoId = String(normalized.videoId || initialVideoId || '').trim();
        const normalizedSuccess = {
          ...normalized,
          videoId: resolvedVideoId,
          cacheHit: normalized.cacheHit === true,
        };
        if (useCache && resolvedVideoId) {
          setCachedYouTubeTranscript(resolvedVideoId, preferred, normalizedSuccess);
        }
        return {
          ...normalizedSuccess,
          attempts: maxRetries,
          attemptUsed: attempt,
        };
      }

      lastResult = {
        ...normalized,
        videoId: normalized.videoId || initialVideoId || '',
      };
    } catch (error) {
      const normalizedError = normalizeYouTubeSendMessageError(error);
      lastResult = {
        success: false,
        transcript: '',
        lang: '',
        method: 'none',
        videoId: initialVideoId,
        title: '',
        errorCode: normalizedError.errorCode,
        error: normalizedError.error,
        retryable: normalizedError.retryable,
        cacheHit: false,
      };
    }

    if (attempt < maxRetries && lastResult.retryable) {
      if (lastResult.errorCode === 'content_script_unreachable' && !injectionAttempted) {
        injectionAttempted = true;
        const injectResult = await ensureYouTubeContentScriptInjected(tabId);
        if (!injectResult.success) {
          return {
            success: false,
            transcript: '',
            lang: '',
            method: 'none',
            videoId: initialVideoId || '',
            title: '',
            errorCode: injectResult.errorCode || 'content_script_injection_failed',
            error: injectResult.error || injectResult.errorCode || 'content_script_injection_failed',
            retryable: false,
            attempts: maxRetries,
            attemptUsed: attempt,
            cacheHit: false,
          };
        }
        await sleep(YT_TRANSCRIPT_INJECT_RETRY_DELAY_MS);
        continue;
      }
      await sleep(YT_TRANSCRIPT_RETRY_DELAY_MS * attempt);
      continue;
    }
    break;
  }

  return {
    ...lastResult,
    attempts: maxRetries,
    attemptUsed: Math.max(1, attemptUsed || maxRetries),
    videoId: lastResult.videoId || initialVideoId || '',
    cacheHit: false,
  };
}

async function fetchYouTubeTranscriptForTab(tabId, preferredLanguages = YT_TRANSCRIPT_PREFERRED_LANGUAGES, options = {}) {
  const preferred = normalizePreferredTranscriptLanguages(preferredLanguages);
  const useCache = options?.useCache !== false;
  const inFlightKey = `${tabId}::${preferred.join(',') || 'default'}::${useCache ? 'cache' : 'nocache'}`;
  const existingRequest = ytTranscriptInFlightRequests.get(inFlightKey);
  if (existingRequest) {
    return existingRequest;
  }

  let requestPromise = null;
  requestPromise = fetchYouTubeTranscriptForTabInternal(tabId, preferred, options)
    .finally(() => {
      if (ytTranscriptInFlightRequests.get(inFlightKey) === requestPromise) {
        ytTranscriptInFlightRequests.delete(inFlightKey);
      }
    });

  ytTranscriptInFlightRequests.set(inFlightKey, requestPromise);
  return requestPromise;
}

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [cacheKey, requestPromise] of ytTranscriptInFlightRequests.entries()) {
    if (cacheKey.startsWith(`${tabId}::`) && ytTranscriptInFlightRequests.get(cacheKey) === requestPromise) {
      ytTranscriptInFlightRequests.delete(cacheKey);
    }
  }
});

async function processArticles(tabs, promptChain, chatUrl, analysisType, options = {}) {
  if (!tabs || tabs.length === 0) {
    console.log(`[${analysisType}] Brak artykułów do przetworzenia`);
    return [];
  }

  const invocationWindowId = Number.isInteger(options?.invocationWindowId)
    ? options.invocationWindowId
    : null;
  
  console.log(`[${analysisType}] Rozpoczynam przetwarzanie ${tabs.length} artykułów`);
  
  const processingPromises = tabs.map(async (tab, index) => {
    const processId = `${analysisType}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`;
    let processTitle = tab?.title || 'Bez tytulu';
    let processTotalPrompts = Array.isArray(promptChain) ? promptChain.length : 0;
    const sourceWindowId = Number.isInteger(tab?.windowId) ? tab.windowId : null;
    try {
      console.log(`\n=== [${analysisType}] [${index + 1}/${tabs.length}] Przetwarzam kartę ID: ${tab.id}, Tytuł: ${tab.title}`);
      console.log(`URL: ${tab.url}`);
      
      // Małe opóźnienie między startami aby nie przytłoczyć przeglądarki
      await sleep(index * 500);
      
      // Sprawdź czy to pseudo-tab (ręcznie wklejone źródło)
      const manualUrl = typeof tab?.url === 'string' ? tab.url : '';
      const isManualSource = manualUrl.startsWith('manual://');
      const isManualPdf = manualUrl === 'manual://pdf';
      let extractedText;
      let transcriptLang = null; // Moze byc ustawiony przez YouTube content script
      const manualPdfAttachmentContext = isManualPdf && tab?.manualPdfAttachment && typeof tab.manualPdfAttachment === 'object'
        ? tab.manualPdfAttachment
        : null;      
      if (isManualSource) {
        // Użyj tekstu przekazanego bezpośrednio
        extractedText = tab.manualText;
        console.log(`[${analysisType}] [${index + 1}/${tabs.length}] Używam ręcznie wklejonego tekstu: ${extractedText?.length || 0} znaków`);
        
        // Dla manual source: brak walidacji długości (zgodnie z planem)
        if (!extractedText || extractedText.length === 0) {
          console.log(`[${analysisType}] [${index + 1}/${tabs.length}] Pominięto - pusty tekst`);
          return { success: false, title: processTitle, reason: 'pusty tekst', error: 'manual_source_empty' };
        }
      } else {
        // Wykryj źródło najpierw, aby wiedzieć czy to YouTube
        const isYouTube = isYouTubeTabUrl(tab.url);
        
        if (isYouTube) {
          console.log(`[${analysisType}] [${index + 1}/${tabs.length}] YouTube detected - fetching transcript`);
          const transcriptResult = await fetchYouTubeTranscriptForTab(tab.id, YT_TRANSCRIPT_PREFERRED_LANGUAGES, {
            timeoutMs: YT_TRANSCRIPT_REQUEST_TIMEOUT_MS,
            maxRetries: YT_TRANSCRIPT_MAX_RETRIES,
          });

          console.log(`[${analysisType}] [${index + 1}/${tabs.length}] YouTube transcript result:`, {
            success: transcriptResult.success,
            length: transcriptResult.transcript?.length || 0,
            lang: transcriptResult.lang,
            method: transcriptResult.method,
            cacheHit: transcriptResult.cacheHit,
            errorCode: transcriptResult.errorCode,
            error: transcriptResult.error,
            attemptUsed: transcriptResult.attemptUsed,
            attempts: transcriptResult.attempts,
          });

          if (!transcriptResult.success || !transcriptResult.transcript) {
            const ytReason = transcriptResult.errorCode || 'transcript_unavailable';
            const ytError = transcriptResult.error || ytReason;
            console.warn(
              `[${analysisType}] [${index + 1}/${tabs.length}] YouTube transcript failed: reason=${ytReason} retryable=${transcriptResult.retryable === true} attempt=${transcriptResult.attemptUsed || 0}/${transcriptResult.attempts || YT_TRANSCRIPT_MAX_RETRIES} error=${truncateDispatchLogText(ytError, 220)}`
            );
            return {
              success: false,
              title: processTitle,
              reason: `youtube_${ytReason}`,
              error: ytError
            };
          }

          extractedText = transcriptResult.transcript;
          transcriptLang = transcriptResult.lang || 'unknown';
        } else {
          // === NON-YOUTUBE: Użyj executeScript z extractText ===
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            function: extractText
          });
          extractedText = results[0]?.result;
          console.log(`[${analysisType}] [${index + 1}/${tabs.length}] Wyekstrahowano ${extractedText?.length || 0} znaków`);
        }
        
        // Dla automatycznych źródeł: walidacja minimum 50 znaków
        if (!extractedText || extractedText.length < 50) {
          console.log(`[${analysisType}] [${index + 1}/${tabs.length}] Pominięto - za mało tekstu`);
          return {
            success: false,
            title: processTitle,
            reason: 'za mało tekstu',
            error: `text_too_short_${extractedText?.length || 0}`
          };
        }
      }

      // Pobierz tytuł
      const title = tab.title || "Bez tytułu";
      processTitle = title;
      
      // Wykryj źródło artykułu (dla non-YouTube lub dla payload metadata)
      let sourceName;
      
      if (isManualSource) {
        sourceName = isManualPdf ? "Manual PDF" : "Manual Source";
      } else {
        const url = new URL(tab.url);
        const hostname = url.hostname;
        sourceName = "Unknown";
        for (const source of SUPPORTED_SOURCES) {
          const domain = source.pattern.replace('*://*.', '').replace('*://', '').replace('/*', '');
          if (hostname.includes(domain)) {
            sourceName = source.name;
            break;
          }
        }
      }

      // Wyciągnij treść pierwszego prompta z promptChain
      const firstPrompt = promptChain[0] || '';
      
      // Wstaw treść artykułu do pierwszego prompta (zamień {{articlecontent}})
      let payload = firstPrompt.replace('{{articlecontent}}', extractedText);
      
      // Usuń pierwszy prompt z promptChain (zostanie użyty jako payload)
      const restOfPrompts = promptChain.slice(1);
      processTotalPrompts = Array.isArray(promptChain) ? promptChain.length : 0;
      const processPromptOffset = processTotalPrompts > 0 ? 1 : 0;
      await upsertProcess(processId, {
        title,
        analysisType,
        status: 'starting',
        statusText: 'Przygotowanie procesu',
        currentPrompt: 0,
        totalPrompts: processTotalPrompts,
        needsAction: false,
        startedAt: Date.now(),
        timestamp: Date.now(),
        sourceUrl: isManualSource ? (tab.url || 'manual://source') : (tab.url || ''),
        chatUrl,
        ...(invocationWindowId !== null ? { invocationWindowId } : {}),
        ...(sourceWindowId !== null ? { sourceWindowId } : {}),
        messages: []
      });

      // Otwórz nowe okno ChatGPT
      const window = await chrome.windows.create({
        url: chatUrl,
        type: "normal",
        focused: true  // POPRAWKA: Aktywuj okno od razu
      });

      const chatTabId = window.tabs[0].id;

      const createdChatUngroup = await ungroupTabsById([chatTabId], {
        origin: 'process-chat-tab-created'
      });
      if (!createdChatUngroup.ok && createdChatUngroup.reason !== 'already_ungrouped') {
        console.warn('[run] chat tab ungroup failed:', {
          tabId: chatTabId,
          reason: createdChatUngroup.reason,
          error: createdChatUngroup.error || ''
        });
      }

      // POPRAWKA: Upewnij się że okno jest aktywne i karta ma fokus
      await chrome.windows.update(window.id, { focused: true });
      await chrome.tabs.update(chatTabId, { active: true });

      await upsertProcess(processId, {
        status: 'running',
        statusText: 'Okno ChatGPT gotowe',
        windowId: window.id,
        tabId: chatTabId,
        timestamp: Date.now()
      });

      // Czekaj na załadowanie strony
      await waitForTabComplete(chatTabId);

      // Wstrzyknij tekst do ChatGPT z retry i uruchom prompt chain
      let results;
      let result;
      let executionPayload = payload;
      let executionPromptChain = restOfPrompts;
      let executionPromptOffset = processPromptOffset;
      let autoRecoveryAttempt = 0;
      const autoRecoveryReasonsList = [...AUTO_RECOVERY_REASONS];
      while (true) {
        try {
        console.log(`\n🚀 Wywołuję executeScript dla karty ${chatTabId}...`);
        results = await chrome.scripting.executeScript({
          target: { tabId: chatTabId },
          function: injectToChat,
          args: [
            executionPayload,
            executionPromptChain,
            WAIT_FOR_TEXTAREA_MS,
            WAIT_FOR_RESPONSE_MS,
            RETRY_INTERVAL_MS,
            title,
            analysisType,
            processId,
            {
              promptOffset: executionPromptOffset,
              totalPromptsOverride: processTotalPrompts
            },
            {
              enabled: true,
              attempt: autoRecoveryAttempt,
              maxAttempts: AUTO_RECOVERY_MAX_ATTEMPTS,
              delayMs: AUTO_RECOVERY_DELAY_MS,
              reasons: autoRecoveryReasonsList
            },
            {
              persistFinalResponseViaMessage: true,
              mode: 'runtime_message',
              saveTimeoutMs: 15000
            },
            manualPdfAttachmentContext
          ]
        });
        console.log(`✅ executeScript zakończony pomyślnie`);
      } catch (executeError) {
        console.error(`\n${'='.repeat(80)}`);
        console.error(`❌ executeScript FAILED`);
        console.error(`  Tab ID: ${chatTabId}`);
        console.error(`  Error: ${executeError.message}`);
        console.error(`  Stack: ${executeError.stack}`);
        console.error(`${'='.repeat(80)}\n`);
        await upsertProcess(processId, {
          title: processTitle,
          analysisType,
          status: 'failed',
          needsAction: false,
          statusText: 'Blad executeScript',
          reason: 'execute_script_failed',
          error: executeError.message || 'executeScript failed',
          autoRecovery: null,
          finishedAt: Date.now(),
          timestamp: Date.now()
        });
          return { success: false, title, error: `executeScript error: ${executeError.message}` };
        }

        if (!results || results.length === 0) {
          console.error(`❌ KRYTYCZNY: results jest puste lub undefined!`);
          console.error(`  - results: ${results}`);
          await upsertProcess(processId, {
            title: processTitle,
            analysisType,
            status: 'failed',
            needsAction: false,
            statusText: 'Brak wyniku executeScript',
            reason: 'missing_execute_result',
            autoRecovery: null,
            finishedAt: Date.now(),
            timestamp: Date.now()
          });
          return { success: false, title, error: 'executeScript nie zwrocil wynikow' };
        }

        result = results[0]?.result;
        const handoff = result?.error === 'auto_recovery_required' ? result?.autoRecovery : null;
        if (!handoff || autoRecoveryAttempt >= AUTO_RECOVERY_MAX_ATTEMPTS) {
          break;
        }

        autoRecoveryAttempt += 1;
        const nextPromptOffset = Number.isInteger(handoff.promptOffset) && handoff.promptOffset >= 0
          ? handoff.promptOffset
          : executionPromptOffset;
        const nextRemainingPrompts = Array.isArray(handoff.remainingPrompts)
          ? handoff.remainingPrompts
          : executionPromptChain;
        const recoveryReasonBase = typeof handoff.reason === 'string' && handoff.reason.trim()
          ? handoff.reason.trim()
          : 'unknown';
        const recoveryReason = `auto_recovery_${recoveryReasonBase}`;
        const recoveryCurrentPrompt = Number.isInteger(handoff.currentPrompt) && handoff.currentPrompt >= 0
          ? handoff.currentPrompt
          : (nextPromptOffset > 0 ? nextPromptOffset : executionPromptOffset);
        const recoveryStageIndex = Number.isInteger(handoff.stageIndex)
          ? handoff.stageIndex
          : (recoveryCurrentPrompt > 0 ? (recoveryCurrentPrompt - 1) : null);
        const recoveryPatch = {
          title: processTitle,
          analysisType,
          status: 'running',
          needsAction: false,
          currentPrompt: recoveryCurrentPrompt,
          totalPrompts: processTotalPrompts,
          statusText: `Auto-resend ${autoRecoveryAttempt}/${AUTO_RECOVERY_MAX_ATTEMPTS}`,
          reason: recoveryReason,
          autoRecovery: {
            attempt: autoRecoveryAttempt,
            maxAttempts: AUTO_RECOVERY_MAX_ATTEMPTS,
            delayMs: AUTO_RECOVERY_DELAY_MS,
            reason: recoveryReasonBase,
            currentPrompt: recoveryCurrentPrompt,
            ...(Number.isInteger(recoveryStageIndex) ? { stageIndex: recoveryStageIndex } : {}),
            updatedAt: Date.now()
          },
          timestamp: Date.now()
        };
        if (Number.isInteger(recoveryStageIndex)) {
          recoveryPatch.stageIndex = recoveryStageIndex;
          recoveryPatch.stageName = `Prompt ${recoveryStageIndex + 1}`;
        }
        await upsertProcess(processId, recoveryPatch);

        console.warn(`[${analysisType}] [${index + 1}/${tabs.length}] Auto-resend ${autoRecoveryAttempt}/${AUTO_RECOVERY_MAX_ATTEMPTS} (${recoveryReasonBase}) dla prompta ${recoveryCurrentPrompt}`);
        await sleep(AUTO_RECOVERY_DELAY_MS);

        executionPayload = '';
        executionPromptChain = nextRemainingPrompts;
        executionPromptOffset = nextPromptOffset;
      }

      // Zapisz ostatnią odpowiedź zwróconą z injectToChat
      console.log(`\n${'='.repeat(80)}`);
      console.log(`[${analysisType}] [${index + 1}/${tabs.length}] 🎯 ANALIZA WYNIKU Z executeScript`);
      console.log(`Artykuł: ${title}`);
      console.log(`${'='.repeat(80)}`);
      
      // Sprawdź co dokładnie zwróciło executeScript
      console.log(`📦 results array:`, {
        exists: !!results,
        length: results?.length,
        type: typeof results
      });
      
      // Bezpieczna diagnostyka results (bez JSON.stringify)
      if (results && results.length > 0) {
        console.log(`📦 results[0] keys:`, results[0] ? Object.keys(results[0]) : 'brak');
        console.log(`📦 results[0].result type:`, typeof results[0]?.result);
        console.log(`📦 results[0].result exists:`, results[0]?.result !== undefined);
      }
      
      if (!results || results.length === 0) {
        console.error(`❌ KRYTYCZNY: results jest puste lub undefined!`);
        console.error(`  - results: ${results}`);
        console.log(`${'='.repeat(80)}\n`);
        await upsertProcess(processId, {
          title: processTitle,
          analysisType,
          status: 'failed',
          needsAction: false,
          statusText: 'Brak wyniku executeScript',
          reason: 'missing_execute_result',
          autoRecovery: null,
          finishedAt: Date.now(),
          timestamp: Date.now()
        });
        // Ten return trafia do Promise.allSettled jako fulfilled z tą wartością
        return { success: false, title, error: 'executeScript nie zwrócił wyników' };
      }
      
      console.log(`📦 results[0]:`, {
        exists: !!results[0],
        type: typeof results[0],
        keys: results[0] ? Object.keys(results[0]) : []
      });
      
      result = results[0]?.result;

      // Capture conversation URL from injected context (preferred) or from the tab (fallback).
      let conversationUrl = normalizeChatConversationUrl(result?.conversationUrl);
      if (!conversationUrl) {
        try {
          const chatTab = await chrome.tabs.get(chatTabId);
          const chatTabUrl = getTabEffectiveUrl(chatTab);
          conversationUrl = normalizeChatConversationUrl(chatTabUrl);
        } catch (error) {
          // Ignore and continue without URL.
        }
      }
      
      if (result === undefined) {
        console.error(`❌ KRYTYCZNY: results[0].result jest undefined!`);
        console.error(`  - results[0]: ${JSON.stringify(results[0], null, 2)}`);
      } else if (result === null) {
        console.error(`❌ KRYTYCZNY: results[0].result jest null!`);
      } else {
        console.log(`✓ result istnieje i nie jest null/undefined`);
        console.log(`  - type: ${typeof result}`);
        console.log(`  - success: ${result.success}`);
        console.log(`  - lastResponse type: ${typeof result.lastResponse}`);
        console.log(`  - lastResponse defined: ${result.lastResponse !== undefined}`);
        console.log(`  - lastResponse not null: ${result.lastResponse !== null}`);
        if (result.lastResponse !== undefined && result.lastResponse !== null) {
          console.log(`  - lastResponse length: ${result.lastResponse.length}`);
          console.log(`  - lastResponse preview: "${result.lastResponse.substring(0, 100)}..."`);
        }
        if (result.error) {
          console.log(`  - error: ${result.error}`);
        }
      }
      
      // DIAGNOSTYKA: Sprawdź dokładnie co mamy w result
      console.log(`\n🔍 DIAGNOSTYKA RESULT:`);
      console.log(`  - result exists: ${!!result}`);
      console.log(`  - result.success: ${result?.success}`);
      console.log(`  - result.lastResponse exists: ${result?.lastResponse !== undefined}`);
      console.log(`  - result.lastResponse is null: ${result?.lastResponse === null}`);
      console.log(`  - result.lastResponse length: ${result?.lastResponse?.length || 0}`);
      console.log(`  - result.lastResponse trim length: ${result?.lastResponse?.trim()?.length || 0}`);
      console.log(`  - result.lastResponse preview: "${result?.lastResponse?.substring(0, 100) || 'undefined'}..."`);

      const injectMetrics = (result && typeof result === 'object' && result.metrics && typeof result.metrics === 'object')
        ? result.metrics
        : null;
      if (injectMetrics) {
        console.log(`[${analysisType}] [${index + 1}/${tabs.length}] injectToChat metrics:`, injectMetrics);
      }
      let finalStatus = 'completed';
      let finalStatusText = 'Zakonczono';
      let finalReason = '';
      let finalError = '';
      const resultLastResponse = typeof result?.lastResponse === 'string'
        ? result.lastResponse
        : '';
      const hasResultLastResponse = resultLastResponse.trim().length > 0;
      const MAX_COMPLETED_RESPONSE_CHARS = 180000;
      let completedResponsePatch = {};
      let persistencePatch = null;

      if (typeof result?.lastResponse === 'string') {
        const completedResponseTruncated = resultLastResponse.length > MAX_COMPLETED_RESPONSE_CHARS;
        const storedCompletedResponse = completedResponseTruncated
          ? resultLastResponse.slice(0, MAX_COMPLETED_RESPONSE_CHARS)
          : resultLastResponse;

        completedResponsePatch = {
          completedResponseText: storedCompletedResponse,
          completedResponseLength: resultLastResponse.length,
          completedResponseTruncated,
          completedResponseCapturedAt: Date.now(),
          completedResponseSaved: false
        };
      }
      
      if (result && result.success && hasResultLastResponse) {
        console.log(`\n✅ ✅ ✅ WARUNEK SPEŁNIONY - WYWOŁUJĘ saveResponse ✅ ✅ ✅`);
        console.log(`Zapisuję odpowiedź: ${resultLastResponse.length} znaków`);
        console.log(`Typ analizy: ${analysisType}`);
        console.log(`Tytuł: ${title}`);
        console.log(`[copy-flow] [process:save-call] run=${processId || 'no-run'} len=${resultLastResponse.length} fp=${textFingerprint(resultLastResponse)}`);
        await mirrorCopyFlowLogToTab(chatTabId, 'log', `[save:start] run=${processId || 'no-run'} len=${resultLastResponse.length}`, {
          analysisType,
          source: title,
          responseLength: resultLastResponse.length
        });

        const stageMeta = {};
        if (Number.isInteger(result?.selectedResponsePrompt)) {
          stageMeta.selected_response_prompt = result.selectedResponsePrompt;
        }
        if (Number.isInteger(result?.selectedResponseStageIndex)) {
          stageMeta.selected_response_stage_index = result.selectedResponseStageIndex;
        }
        if (typeof result?.selectedResponseReason === 'string' && result.selectedResponseReason.trim()) {
          stageMeta.selected_response_reason = result.selectedResponseReason.trim();
        }
        const providedResponseId = typeof result?.responseId === 'string' && result.responseId.trim()
          ? result.responseId.trim()
          : null;
        const injectedSaveResult = result?.persistedSaveResult && typeof result.persistedSaveResult === 'object'
          ? result.persistedSaveResult
          : null;
        const savedViaInjectedMessage = result?.persistedViaMessage === true && !!injectedSaveResult?.success;

        const saveResult = savedViaInjectedMessage
          ? injectedSaveResult
          : await saveResponse(
            resultLastResponse,
            title,
            analysisType,
            processId,
            providedResponseId,
            Object.keys(stageMeta).length > 0 ? stageMeta : null,
            conversationUrl || null
          );
        const persistenceSummary = buildPersistenceUiSummary({
          hasResponse: true,
          saveResult,
          saveError: saveResult?.success
            ? ''
            : (typeof result?.persistedSaveError === 'string' && result.persistedSaveError.trim()
              ? result.persistedSaveError.trim()
              : 'save_response_failed')
        });
        finalStatusText = persistenceSummary.statusText;
        finalReason = persistenceSummary.reason;
        persistencePatch = {
          persistenceLog: persistenceSummary.logLines,
          persistenceStatus: {
            hasResponse: true,
            saveOk: persistenceSummary.saveOk,
            dispatchSummary: persistenceSummary.dispatchSummary,
            copyTrace: persistenceSummary.copyTrace,
            saveError: persistenceSummary.saveError,
            dispatch: persistenceSummary.dispatch || null,
            updatedAt: Date.now()
          }
        };
        if (Object.keys(completedResponsePatch).length > 0) {
          completedResponsePatch.completedResponseSaved = persistenceSummary.saveOk;
          completedResponsePatch.completedResponseDispatch = persistenceSummary.dispatch || null;
          completedResponsePatch.completedResponseDispatchSummary = persistenceSummary.dispatchSummary;
          completedResponsePatch.completedResponseSaveTrace = persistenceSummary.copyTrace || '';
        }
        await mirrorCopyFlowLogToTab(
          chatTabId,
          persistenceSummary.saveOk ? 'log' : 'warn',
          persistenceSummary.saveOk
            ? `[save:ok] trace=${saveResult?.copyTrace || 'n/a'}`
            : '[save:failed]',
          persistenceSummary.saveOk
            ? {
              responseId: saveResult?.response?.responseId || null,
              verifiedCount: Number.isInteger(saveResult?.verifiedCount) ? saveResult.verifiedCount : null,
              dispatch: saveResult?.dispatch || null
            }
            : {
              analysisType,
              source: title
            }
        );
        await mirrorCopyFlowLogToTab(
          chatTabId,
          persistenceSummary.saveOk ? 'log' : 'warn',
          '[save:summary]',
          {
            statusText: finalStatusText,
            log: persistenceSummary.logLines,
            reason: persistenceSummary.reason || '',
            dispatch: persistenceSummary.dispatch || null
          }
        );
        await renderFinalCounterStatusOnTab(chatTabId, {
          heading: persistenceSummary.saveOk ? 'Zakonczono' : 'Zakonczono (blad zapisu)',
          tone: persistenceSummary.tone,
          lines: persistenceSummary.logLines,
          autoCloseMs: 0
        });
        
        console.log(`✅ ✅ ✅ saveResponse ZAKOŃCZONY ✅ ✅ ✅`);
        console.log(`${'='.repeat(80)}\n`);
      } else if (result && result.success && !hasResultLastResponse) {
        console.warn(`\n⚠️ ⚠️ ⚠️ Proces SUKCES ale lastResponse jest pusta lub null ⚠️ ⚠️ ⚠️`);
        console.warn(`lastResponse: "${result.lastResponse}" (długość: ${result.lastResponse?.length || 0})`);
        const persistenceSummary = buildPersistenceUiSummary({ hasResponse: false });
        finalStatusText = persistenceSummary.statusText;
        finalReason = persistenceSummary.reason;
        persistencePatch = {
          persistenceLog: persistenceSummary.logLines,
          persistenceStatus: {
            hasResponse: false,
            saveOk: false,
            dispatchSummary: persistenceSummary.dispatchSummary,
            copyTrace: '',
            saveError: persistenceSummary.saveError,
            dispatch: null,
            updatedAt: Date.now()
          }
        };
        await mirrorCopyFlowLogToTab(chatTabId, 'warn', '[save:skipped_empty_response]', {
          statusText: finalStatusText,
          log: persistenceSummary.logLines
        });
        await renderFinalCounterStatusOnTab(chatTabId, {
          heading: 'Zakonczono (pusta odpowiedz)',
          tone: persistenceSummary.tone,
          lines: persistenceSummary.logLines,
          autoCloseMs: 0
        });
        console.log(`${'='.repeat(80)}\n`);
      } else if (result && !result.success) {
        console.warn(`\n⚠️ ⚠️ ⚠️ Proces zakończony BEZ SUKCESU (success=false) ⚠️ ⚠️ ⚠️`);
        finalStatus = 'failed';
        finalError = result?.error || '';
        if (finalError === 'pdf_attach_failed') {
          finalStatusText = 'pdf_attach_failed';
          finalReason = 'pdf_attach_failed';
        } else {
          finalStatusText = 'Blad procesu';
          finalReason = 'inject_failed';
        }
        await renderFinalCounterStatusOnTab(chatTabId, {
          heading: 'Blad procesu',
          tone: 'error',
          lines: [`Powod: ${finalError || finalReason}`],
          autoCloseMs: 0
        });
        console.log(`${'='.repeat(80)}\n`);
      } else {
        console.error(`\n❌ ❌ ❌ NIEOCZEKIWANY STAN ❌ ❌ ❌`);
        console.error(`hasResult: ${!!result}`);
        console.error(`success: ${result?.success}`);
        console.error(`lastResponse: ${result?.lastResponse}`);
        finalStatus = 'failed';
        finalStatusText = 'Nieoczekiwany wynik';
        finalReason = 'invalid_result';
        await renderFinalCounterStatusOnTab(chatTabId, {
          heading: 'Blad procesu',
          tone: 'error',
          lines: ['Powod: invalid_result'],
          autoCloseMs: 0
        });
        console.log(`${'='.repeat(80)}\n`);
      }

      await upsertProcess(processId, {
        title: processTitle,
        analysisType,
        status: finalStatus,
        needsAction: false,
        statusText: finalStatusText,
        reason: finalReason,
        error: finalError,
        autoRecovery: null,
        ...(injectMetrics ? { injectMetrics } : {}),
        ...(persistencePatch ? persistencePatch : {}),
        ...(Object.keys(completedResponsePatch).length > 0
          ? completedResponsePatch
          : {}),
        ...(finalStatus === 'completed'
          ? {
            currentPrompt: processTotalPrompts,
            totalPrompts: processTotalPrompts,
            ...(processTotalPrompts > 0
              ? {
                stageIndex: processTotalPrompts - 1,
                stageName: `Prompt ${processTotalPrompts}`
              }
              : {
                stageName: 'Start'
              })
          }
          : {}),
        finishedAt: Date.now(),
        timestamp: Date.now()
      });

      const processSuccess = finalStatus === 'completed';
      console.log(`[${analysisType}] [${index + 1}/${tabs.length}] ${processSuccess ? '✅' : '❌'} Zakończono przetwarzanie: ${title} status=${finalStatus}`);
      return {
        success: processSuccess,
        title,
        reason: finalReason || '',
        error: finalError || ''
      };

    } catch (error) {
      console.error(`[${analysisType}] [${index + 1}/${tabs.length}] ❌ Błąd:`, error);
      await upsertProcess(processId, {
        title: processTitle,
        analysisType,
        status: 'failed',
        needsAction: false,
        statusText: 'Blad procesu',
        reason: 'exception',
        error: error?.message || String(error),
        autoRecovery: null,
        finishedAt: Date.now(),
        timestamp: Date.now()
      });
      return { success: false, error: error.message };
    }
  });

  // Poczekaj na uruchomienie wszystkich
  const results = await Promise.allSettled(processingPromises);
  
  const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
  console.log(`\n[${analysisType}] 🎉 Uruchomiono ${successful}/${tabs.length} procesów ChatGPT`);
  const failedEntries = results
    .map((result, index) => {
      if (result.status === 'fulfilled') {
        if (result.value?.success) return null;
        return {
          index,
          title: result.value?.title || tabs[index]?.title || 'Bez tytulu',
          reason: result.value?.reason || 'failed',
          error: result.value?.error || ''
        };
      }
      return {
        index,
        title: tabs[index]?.title || 'Bez tytulu',
        reason: 'promise_rejected',
        error: result.reason?.message || String(result.reason || '')
      };
    })
    .filter(Boolean);
  if (failedEntries.length > 0) {
    console.warn(`[${analysisType}] ⚠️ Nieudane procesy: ${failedEntries.length}`);
    for (const failed of failedEntries) {
      console.warn(
        `[${analysisType}] [${failed.index + 1}/${tabs.length}] title="${failed.title}" reason=${failed.reason} error=${truncateDispatchLogText(failed.error || '', 220)}`
      );
    }
  }
  
  return results;
}

// Główna funkcja uruchamiająca analizę
async function runAnalysis(options = {}) {
  try {
    console.log("\n=== ROZPOCZYNAM KONFIGURACJĘ ANALIZY ===");

    const invocationWindowId = Number.isInteger(options?.invocationWindowId)
      ? options.invocationWindowId
      : null;
    if (options?.stopExistingInWindow && Number.isInteger(invocationWindowId)) {
      const preUngroupResult = await ungroupChatGptTabsInWindow(invocationWindowId, {
        origin: 'run-analysis-restart-pre-stop'
      });
      console.log('[restart] pre-stop ungroup chat tabs:', {
        windowId: invocationWindowId,
        ok: preUngroupResult.ok,
        reason: preUngroupResult.reason,
        requested: preUngroupResult.requested,
        groupedCount: preUngroupResult.groupedCount,
        ungroupedCount: preUngroupResult.ungroupedCount,
        skippedCount: preUngroupResult.skippedCount,
        error: preUngroupResult.error || ''
      });

      const stopResult = await stopActiveProcesses({
        windowId: invocationWindowId,
        reason: 'restarted_in_same_window',
        statusText: 'Zatrzymano przez ponowne uruchomienie',
        origin: 'run-analysis-restart',
        replayLatestResponse: true,
        forceReplayLatestResponse: true
      });
      if (stopResult.stopped > 0) {
        console.log(`[run] Zatrzymano ${stopResult.stopped} aktywnych procesow w oknie ${invocationWindowId}`);
        await sleep(250);
      }

      const postUngroupResult = await ungroupChatGptTabsInWindow(invocationWindowId, {
        origin: 'run-analysis-restart-post-stop'
      });
      console.log('[restart] post-stop ungroup chat tabs:', {
        windowId: invocationWindowId,
        ok: postUngroupResult.ok,
        reason: postUngroupResult.reason,
        requested: postUngroupResult.requested,
        groupedCount: postUngroupResult.groupedCount,
        ungroupedCount: postUngroupResult.ungroupedCount,
        skippedCount: postUngroupResult.skippedCount,
        error: postUngroupResult.error || ''
      });
    }
    
    // KROK 1: Sprawdź czy prompty są wczytane
    console.log("\n📝 Krok 1: Sprawdzanie promptów");
    const promptsReady = await ensureCompanyPromptsReady();
    if (!promptsReady || PROMPTS_COMPANY.length === 0) {
      console.error("❌ Brak promptów dla analizy spółki w prompts-company.txt");
      return;
    }
    console.log(`✅ Analiza spółki: ${PROMPTS_COMPANY.length} promptów`);
    
    if (PROMPTS_PORTFOLIO.length === 0) {
      console.warn("⚠️ Brak promptów dla analizy portfela w prompts-portfolio.txt");
    } else {
      console.log(`✅ Analiza portfela: ${PROMPTS_PORTFOLIO.length} promptów`);
    }
    
    // KROK 2: Pobierz wszystkie artykuły
    console.log("\n📰 Krok 2: Pobieranie artykułów");
    const allTabs = [];
    const patterns = getSupportedSourcesQuery();
    console.log(`Szukam artykułów w ${patterns.length} źródłach:`, patterns);
    
    for (const pattern of patterns) {
      const tabs = await chrome.tabs.query({url: pattern});
      console.log(`  - ${pattern}: znaleziono ${tabs.length} kart`);
      if (tabs.length > 0) {
        tabs.forEach(tab => console.log(`    • ${tab.title} (${tab.url})`));
      }
      allTabs.push(...tabs);
    }
    
    const orderedTabs = Array.from(
      new Map(
        allTabs
          .filter((tab) => Number.isInteger(tab?.id))
          .map((tab) => [tab.id, tab])
      ).values()
    ).sort(compareTabsByWindowAndIndex);

    if (orderedTabs.length === 0) {
      console.log("❌ Brak otwartych kart z obsługiwanych źródeł");
      return;
    }

    console.log(`✅ Znaleziono ${orderedTabs.length} artykułów łącznie`);
    
    // KROK 3: Wybór artykułów do analizy portfela
    console.log("\n🎯 Krok 3: Wybór artykułów do analizy portfela");
    const selectedIndices = await getArticleSelection(orderedTabs);
    
    if (selectedIndices === null) {
      console.log("❌ Anulowano wybór artykułów");
      return;
    }
    
    console.log(`✅ Wybrano ${selectedIndices.length} artykułów do analizy portfela`);
    
    // KROK 4: Przygotuj zaznaczone artykuły do analizy portfela
    let selectedTabs = [];
    if (selectedIndices.length > 0 && PROMPTS_PORTFOLIO.length > 0) {
      selectedTabs = selectedIndices
        .map((index) => orderedTabs[index])
        .filter(Boolean);
      console.log(`\n✅ Przygotowano ${selectedTabs.length} artykułów do analizy portfela`);
    } else if (selectedIndices.length > 0 && PROMPTS_PORTFOLIO.length === 0) {
      console.log("\n⚠️ Zaznaczono artykuły ale brak promptów - pomijam analizę portfela");
    } else {
      console.log("\n⏭️ Nie zaznaczono artykułów do analizy portfela");
    }
    
    // KROK 5: Uruchom oba procesy równolegle
    console.log("\n🚀 Krok 5: Uruchamianie procesów analizy");
    console.log(`   - Analiza spółki: ${orderedTabs.length} artykułów`);
    console.log(`   - Analiza portfela: ${selectedTabs.length} artykułów`);
    
    const processingTasks = [];
    
    // Zawsze uruchamiaj analizę spółki
    processingTasks.push(
      processArticles(orderedTabs, PROMPTS_COMPANY, CHAT_URL, 'company', {
        invocationWindowId
      })
    );
    
    // Uruchom analizę portfela jeśli są zaznaczone artykuły i prompty
    if (selectedTabs.length > 0) {
      processingTasks.push(
        processArticles(selectedTabs, PROMPTS_PORTFOLIO, CHAT_URL_PORTFOLIO, 'portfolio', {
          invocationWindowId
        })
      );
    }
    
    // Poczekaj na uruchomienie obu procesów
    await Promise.allSettled(processingTasks);
    
    console.log("\n✅ ZAKOŃCZONO URUCHAMIANIE WSZYSTKICH PROCESÓW");

  } catch (error) {
    console.error("❌ Błąd główny:", error);
  }
}

// Funkcja uruchamiająca analizę z ręcznie wklejonego źródła
function normalizeManualInstances(instances) {
  return Math.max(1, Math.min(10, Number.isInteger(instances) ? instances : 1));
}

function buildManualPdfPayload(fileName) {
  const safeName = typeof fileName === 'string' && fileName.trim() ? fileName.trim() : 'source.pdf';
  return `Nazwa pliku: ${safeName}\nPrzeanalizuj zalaczony PDF.`;
}

function normalizeManualPdfFiles(rawFiles) {
  if (!Array.isArray(rawFiles)) return [];
  return rawFiles
    .filter((item) => item && typeof item === 'object')
    .map((item, index) => {
      const token = typeof item.token === 'string' ? item.token.trim() : '';
      const rawName = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : `source-${index + 1}`;
      const loweredMimeType = typeof item.mimeType === 'string' ? item.mimeType.trim().toLowerCase() : '';
      const isPdfByMime = loweredMimeType === 'application/pdf' || loweredMimeType === 'application/x-pdf';
      const isPdfByName = rawName.toLowerCase().endsWith('.pdf');
      const isPdf = isPdfByMime || isPdfByName;
      const name = isPdfByName ? rawName : `${rawName}.pdf`;
      const size = Number.isFinite(item.size) ? Math.max(0, Math.floor(item.size)) : 0;
      const mimeType = 'application/pdf';
      const lastModified = Number.isInteger(item.lastModified) ? item.lastModified : Date.now();
      return {
        token,
        name,
        size,
        mimeType,
        lastModified,
        isPdf
      };
    })
    .filter((item) => item.token && item.isPdf)
    .map(({ token, name, size, mimeType, lastModified }) => ({
      token,
      name,
      size,
      mimeType,
      lastModified
    }));
}

async function sendManualPdfProviderMessage(payload, timeoutMs = MANUAL_PDF_PROVIDER_TIMEOUT_MS) {
  const timeoutMarker = '__manual_pdf_provider_timeout__';
  const safeTimeout = Math.max(2000, Math.min(60000, Number.isInteger(timeoutMs) ? timeoutMs : MANUAL_PDF_PROVIDER_TIMEOUT_MS));
  try {
    const response = await Promise.race([
      chrome.runtime.sendMessage(payload),
      new Promise((resolve) => setTimeout(() => resolve(timeoutMarker), safeTimeout))
    ]);

    if (response === timeoutMarker) {
      return { success: false, error: 'provider_timeout' };
    }

    if (response && typeof response === 'object') {
      if (response.success === false) {
        return { success: false, error: response.error || 'provider_error', response };
      }
      return { success: true, response };
    }

    return { success: false, error: 'provider_invalid_response' };
  } catch (error) {
    const lowered = String(error?.message || error || '').toLowerCase();
    if (lowered.includes('receiving end does not exist') || lowered.includes('could not establish connection')) {
      return { success: false, error: 'provider_unavailable' };
    }
    return { success: false, error: error?.message || 'provider_message_failed' };
  }
}

async function notifyManualPdfProviderStatus(providerId, status, message, extra = {}) {
  if (typeof providerId !== 'string' || !providerId.trim()) return;
  const payload = {
    type: 'MANUAL_PDF_PROVIDER_STATUS',
    providerId: providerId.trim(),
    status: typeof status === 'string' ? status : 'running',
    message: typeof message === 'string' ? message : '',
    ...extra
  };
  const sent = await sendManualPdfProviderMessage(payload, 5000);
  if (!sent.success) {
    console.warn('[manual-pdf] provider status push failed:', {
      status,
      error: sent.error
    });
  }
}

async function releaseManualPdfProvider(providerId, message, extra = {}) {
  if (typeof providerId !== 'string' || !providerId.trim()) return;
  const payload = {
    type: 'MANUAL_PDF_PROVIDER_RELEASE',
    providerId: providerId.trim(),
    message: typeof message === 'string' ? message : '',
    ...extra
  };
  const sent = await sendManualPdfProviderMessage(payload, 5000);
  if (!sent.success) {
    console.warn('[manual-pdf] provider release failed:', {
      error: sent.error
    });
  }
}

async function requestManualPdfProviderChunk({ providerId, token, offset = 0, chunkSize = MANUAL_PDF_CHUNK_SIZE }) {
  const safeProviderId = typeof providerId === 'string' ? providerId.trim() : '';
  const safeToken = typeof token === 'string' ? token.trim() : '';
  const safeOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0;
  const safeChunkSize = Number.isInteger(chunkSize) && chunkSize > 0
    ? Math.max(64 * 1024, Math.min(2 * 1024 * 1024, chunkSize))
    : MANUAL_PDF_CHUNK_SIZE;

  if (!safeProviderId || !safeToken) {
    return { success: false, error: 'invalid_chunk_request' };
  }

  const providerResult = await sendManualPdfProviderMessage({
    type: 'MANUAL_PDF_PROVIDER_READ_CHUNK',
    providerId: safeProviderId,
    token: safeToken,
    offset: safeOffset,
    chunkSize: safeChunkSize
  }, MANUAL_PDF_PROVIDER_TIMEOUT_MS);

  if (!providerResult.success) {
    const normalizedError = providerResult.error || 'chunk_read_failed';
    return {
      success: false,
      error: normalizedError === 'provider_timeout' ? 'provider_unavailable' : normalizedError
    };
  }

  const response = providerResult.response && typeof providerResult.response === 'object'
    ? providerResult.response
    : {};

  return {
    success: true,
    eof: response.eof === true,
    base64Chunk: typeof response.base64Chunk === 'string' ? response.base64Chunk : '',
    nextOffset: Number.isInteger(response.nextOffset) ? response.nextOffset : safeOffset
  };
}

// Funkcja uruchamiajaca analize z recznie wklejonego zrodla
async function runManualSourceAnalysis(text, title, instances) {
  try {
    const safeText = typeof text === 'string' ? text : '';
    const safeTitle = typeof title === 'string' && title.trim() ? title.trim() : 'Recznie wklejony artykul';
    const safeInstances = normalizeManualInstances(instances);

    console.log('\n=== ROZPOCZYNAM ANALIZE Z RECZNEGO ZRODLA ===');
    console.log(`Tytul: ${safeTitle}`);
    console.log(`Tekst: ${safeText.length} znakow`);
    console.log(`Instancje: ${safeInstances}`);

    const promptsReady = await ensureCompanyPromptsReady();
    if (!promptsReady || PROMPTS_COMPANY.length === 0) {
      console.error('[manual-source] Brak promptow dla analizy spolki');
      return;
    }

    const timestamp = Date.now();
    const pseudoTabs = [];
    for (let i = 0; i < safeInstances; i += 1) {
      pseudoTabs.push({
        id: `manual-${timestamp}-${i}`,
        title: safeTitle,
        url: 'manual://source',
        manualText: safeText
      });
    }

    await processArticles(pseudoTabs, PROMPTS_COMPANY, CHAT_URL, 'company');
    console.log('\n[manual-source] Zakonczono uruchamianie analizy recznego zrodla.');
  } catch (error) {
    console.error('[manual-source] Blad runManualSourceAnalysis:', error);
  }
}

async function runManualPdfAnalysisQueue({ title, instances, providerId, pdfFiles }) {
  const safeProviderId = typeof providerId === 'string' ? providerId.trim() : '';
  const safeInstances = normalizeManualInstances(instances);
  const normalizedFiles = normalizeManualPdfFiles(pdfFiles);

  if (!safeProviderId) {
    console.warn('[manual-pdf] Missing providerId, queue skipped.');
    return;
  }

  const providerPortReady = await waitForManualPdfProviderPort(safeProviderId, 7000);
  if (!providerPortReady) {
    console.warn('[manual-pdf] Provider keepalive port not connected. Queue may be interrupted by worker lifecycle.', {
      providerId: safeProviderId
    });
    await notifyManualPdfProviderStatus(
      safeProviderId,
      'running',
      'Uwaga: brak polaczenia keepalive z providerem PDF. Nie zamykaj okna i odswiez rozszerzenie, jesli kolejka zatrzyma sie po 1 pliku.'
    );
  }

  const promptsReady = await ensureCompanyPromptsReady();
  if (!promptsReady || PROMPTS_COMPANY.length === 0) {
    console.error('[manual-pdf] Brak promptow dla analizy spolki');
    await notifyManualPdfProviderStatus(safeProviderId, 'failed', 'Brak promptow company. Kolejka przerwana.');
    await releaseManualPdfProvider(safeProviderId, 'Kolejka PDF przerwana: brak promptow.', { success: false });
    return;
  }

  if (normalizedFiles.length === 0) {
    console.warn('[manual-pdf] Empty PDF list, queue skipped.');
    await notifyManualPdfProviderStatus(safeProviderId, 'failed', 'Brak poprawnych PDF do przetworzenia.');
    await releaseManualPdfProvider(safeProviderId, 'Kolejka PDF przerwana: brak poprawnych plikow.', { success: false });
    return;
  }

  const queueJobs = [];
  for (const file of normalizedFiles) {
    for (let instanceIndex = 1; instanceIndex <= safeInstances; instanceIndex += 1) {
      queueJobs.push({
        file,
        instanceIndex,
        instanceTotal: safeInstances
      });
    }
  }

  const timestamp = Date.now();
  let completedJobs = 0;
  let failedJobs = 0;

  console.log('[manual-pdf] Queue start:', {
    providerId: safeProviderId,
    files: normalizedFiles.length,
    instances: safeInstances,
    jobs: queueJobs.length
  });

  await notifyManualPdfProviderStatus(
    safeProviderId,
    'running',
    `Start kolejki PDF: ${queueJobs.length} zadan (${normalizedFiles.length} plikow x ${safeInstances} instancji).`,
    { totalJobs: queueJobs.length, completedJobs: 0, failedJobs: 0 }
  );

  const queueConcurrency = Math.max(
    1,
    Math.min(
      queueJobs.length,
      Number.isInteger(MANUAL_PDF_QUEUE_MAX_CONCURRENCY) ? MANUAL_PDF_QUEUE_MAX_CONCURRENCY : 1
    )
  );

  console.log('[manual-pdf] Queue concurrency:', {
    providerId: safeProviderId,
    jobs: queueJobs.length,
    concurrency: queueConcurrency
  });

  try {
    const queueState = {
      nextJobIndex: 0,
      completedJobs: 0,
      failedJobs: 0
    };

    const runSingleJob = async (job, jobIndex, workerId) => {
      const isMultiInstance = job.instanceTotal > 1;
      const baseTitle = typeof title === 'string' && title.trim() ? title.trim() : job.file.name;
      const runTitle = isMultiInstance
        ? `${baseTitle} [${job.file.name}] [instancja ${job.instanceIndex}/${job.instanceTotal}]`
        : `${baseTitle} [${job.file.name}]`;

      console.log('[manual-pdf] job:start', {
        index: jobIndex + 1,
        total: queueJobs.length,
        file: job.file.name,
        instance: `${job.instanceIndex}/${job.instanceTotal}`,
        workerId
      });

      await notifyManualPdfProviderStatus(
        safeProviderId,
        'running',
        `Start ${jobIndex + 1}/${queueJobs.length}: ${job.file.name} (instancja ${job.instanceIndex}/${job.instanceTotal}).`,
        {
          currentJob: jobIndex + 1,
          totalJobs: queueJobs.length,
          completedJobs: queueState.completedJobs,
          failedJobs: queueState.failedJobs,
          workerId
        }
      );

      const pseudoTab = {
        id: `manual-pdf-${timestamp}-${jobIndex}`,
        title: runTitle,
        url: 'manual://pdf',
        manualText: buildManualPdfPayload(job.file.name),
        manualPdfAttachment: {
          enabled: true,
          providerId: safeProviderId,
          token: job.file.token,
          name: job.file.name,
          mimeType: 'application/pdf',
          size: job.file.size,
          instanceIndex: job.instanceIndex,
          instanceTotal: job.instanceTotal
        }
      };

      try {
        const settled = await processArticles([pseudoTab], PROMPTS_COMPANY, CHAT_URL, 'company');
        const firstResult = Array.isArray(settled) && settled.length > 0 ? settled[0] : null;

        if (firstResult?.status === 'fulfilled') {
          return {
            jobSuccess: !!firstResult.value?.success,
            jobReason: firstResult.value?.reason || firstResult.value?.error || ''
          };
        }

        if (firstResult?.status === 'rejected') {
          return {
            jobSuccess: false,
            jobReason: firstResult.reason?.message || String(firstResult.reason || 'promise_rejected')
          };
        }

        return {
          jobSuccess: false,
          jobReason: 'missing_result'
        };
      } catch (jobError) {
        return {
          jobSuccess: false,
          jobReason: jobError?.message || String(jobError || 'process_articles_failed')
        };
      }
    };

    const runWorker = async (workerId) => {
      while (true) {
        const jobIndex = queueState.nextJobIndex;
        if (jobIndex >= queueJobs.length) return;
        queueState.nextJobIndex += 1;

        const job = queueJobs[jobIndex];
        const jobResult = await runSingleJob(job, jobIndex, workerId);
        const jobSuccess = !!jobResult.jobSuccess;
        const jobReason = jobResult.jobReason || '';

        if (jobSuccess) {
          queueState.completedJobs += 1;
          console.log('[manual-pdf] job:ok', {
            index: jobIndex + 1,
            total: queueJobs.length,
            file: job.file.name,
            workerId
          });
        } else {
          queueState.failedJobs += 1;
          console.warn('[manual-pdf] job:failed', {
            index: jobIndex + 1,
            total: queueJobs.length,
            file: job.file.name,
            reason: truncateDispatchLogText(jobReason || 'unknown', 220),
            workerId
          });
        }

        await notifyManualPdfProviderStatus(
          safeProviderId,
          jobSuccess ? 'running' : 'failed',
          jobSuccess
            ? `Gotowe ${jobIndex + 1}/${queueJobs.length}: ${job.file.name}.`
            : `Blad ${jobIndex + 1}/${queueJobs.length}: ${job.file.name} (${jobReason || 'unknown'}).`,
          {
            currentJob: jobIndex + 1,
            totalJobs: queueJobs.length,
            completedJobs: queueState.completedJobs,
            failedJobs: queueState.failedJobs,
            success: jobSuccess,
            reason: jobReason || '',
            workerId
          }
        );
      }
    };

    const workers = [];
    for (let workerId = 1; workerId <= queueConcurrency; workerId += 1) {
      workers.push(runWorker(workerId));
    }
    await Promise.all(workers);

    completedJobs = queueState.completedJobs;
    failedJobs = queueState.failedJobs;

    const finalMessage = `Kolejka PDF zakonczona. Sukces: ${completedJobs}, bledy: ${failedJobs}, razem: ${queueJobs.length}.`;
    await notifyManualPdfProviderStatus(
      safeProviderId,
      'completed',
      finalMessage,
      {
        totalJobs: queueJobs.length,
        completedJobs,
        failedJobs,
        success: failedJobs === 0
      }
    );
    await releaseManualPdfProvider(safeProviderId, finalMessage, {
      totalJobs: queueJobs.length,
      completedJobs,
      failedJobs,
      success: failedJobs === 0
    });
  } catch (error) {
    const finalError = error?.message || String(error);
    console.warn('[manual-pdf] Queue runtime error:', finalError);
    const finalMessage = `Kolejka PDF przerwana: ${finalError}`;
    await notifyManualPdfProviderStatus(
      safeProviderId,
      'failed',
      finalMessage,
      {
        totalJobs: queueJobs.length,
        completedJobs,
        failedJobs,
        success: false,
        reason: finalError
      }
    );
    await releaseManualPdfProvider(safeProviderId, finalMessage, {
      totalJobs: queueJobs.length,
      completedJobs,
      failedJobs,
      success: false,
      reason: finalError
    });
  }
}

// Uwaga: chrome.action.onClicked NIE działa gdy jest default_popup w manifest
// Ikona uruchamia popup, a popup wysyła message RUN_ANALYSIS

// Funkcja ekstrakcji tekstu (content script) - tylko dla non-YouTube sources
// YouTube używa dedykowanego content script (youtube-content.js)
async function extractText() {
  const hostname = window.location.hostname;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const elementText = (el) => normalizeText(el && (el.innerText || el.textContent) ? (el.innerText || el.textContent) : '');
  const safeClick = (el) => {
    try {
      if (el && typeof el.click === 'function') el.click();
    } catch (_) {
      // ignore
    }
  };

  async function extractSpotifyTranscript() {
    try {
      const url = new URL(window.location.href);
      const title = normalizeText(document.title || '');
      const path = url.pathname || '';
      const isEpisode = /(^|\/)episode\//.test(path);
      const isTrack = /(^|\/)track\//.test(path);

      // Give Spotify Web Player (React) a moment to render dynamic sections.
      await sleep(350);

      const transcriptWord = /transcript|transkrypc/i;
      const triggerCandidates = Array.from(document.querySelectorAll('button, [role="button"], a'));
      const trigger = triggerCandidates.find((el) => transcriptWord.test(`${elementText(el)} ${normalizeText(el.getAttribute('aria-label'))}`));
      if (trigger) {
        safeClick(trigger);
        await sleep(450);
      }

      const transcriptSelectors = [
        '[data-testid*="transcript" i]',
        '[aria-label*="transcript" i]',
        '[aria-label*="transkrypc" i]',
        '[class*="transcript" i]',
        '[id*="transcript" i]',
        '[class*="transkrypc" i]',
        '[id*="transkrypc" i]'
      ];

      const candidates = [];
      for (const selector of transcriptSelectors) {
        try {
          candidates.push(...Array.from(document.querySelectorAll(selector)));
        } catch (_) {
          // ignore invalid selectors / browser quirks
        }
      }

      const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5'));
      for (const heading of headings) {
        const headingText = elementText(heading);
        if (!headingText) continue;
        if (!transcriptWord.test(headingText)) continue;
        const container = heading.closest('section, article, div') || heading.parentElement;
        if (container) candidates.push(container);
      }

      // Pick the most "transcript-like" block: longest text among transcript-marked candidates.
      let bestText = '';
      const seen = new Set();
      for (const el of candidates) {
        if (!el || seen.has(el)) continue;
        seen.add(el);
        const text = elementText(el);
        if (text.length > bestText.length) bestText = text;
      }

      bestText = normalizeText(bestText);
      if (!bestText || bestText.length < 200) return '';

      const headerType = isEpisode ? 'podcast transcript' : (isTrack ? 'track text (lyrics/transcript)' : 'page transcript');
      const headerParts = [
        '[Spotify]',
        headerType,
        title ? `Title: ${title}` : null,
        `URL: ${url.href}`
      ].filter(Boolean);

      return `${headerParts.join(' | ')}\n\n${bestText}`;
    } catch (error) {
      console.error('Spotify transcript extraction failed:', error);
      return '';
    }
  }

  async function extractGmailOpenEmail() {
    try {
      const url = new URL(window.location.href);

      // Gmail renders message panels lazily after navigation.
      await sleep(500);

      const firstText = (selectors, minLength = 1) => {
        for (const selector of selectors) {
          let elements = [];
          try {
            elements = Array.from(document.querySelectorAll(selector));
          } catch (_) {
            continue;
          }
          for (const element of elements) {
            const text = elementText(element);
            if (text.length >= minLength) {
              return text;
            }
          }
        }
        return '';
      };

      const longestText = (selectors, minLength = 1) => {
        let best = '';
        for (const selector of selectors) {
          let elements = [];
          try {
            elements = Array.from(document.querySelectorAll(selector));
          } catch (_) {
            continue;
          }
          for (const element of elements) {
            const text = elementText(element);
            if (text.length >= minLength && text.length > best.length) {
              best = text;
            }
          }
        }
        return best;
      };

      const subject = firstText([
        'h2.hP',
        'h2[data-thread-perm-id]',
        'div[role="main"] h2[tabindex="-1"]',
        'div[role="main"] h2'
      ], 2);

      const sender = firstText([
        'div.adn.ads span.gD',
        'div[role="listitem"] span.gD',
        'span.gD[email]',
        'span[email][name]',
        'span[email]'
      ], 2);

      const sentAtNode = document.querySelector('div.adn.ads span.g3[title], div[role="listitem"] span.g3[title], span.g3[title]');
      const sentAt = normalizeText(
        (sentAtNode && (sentAtNode.getAttribute('title') || sentAtNode.innerText || sentAtNode.textContent)) || ''
      );

      const bodyText = longestText([
        'div.adn.ads div.a3s.aiL',
        'div.adn.ads div.a3s',
        'div[role="listitem"] div.a3s.aiL',
        'div[role="listitem"] div.a3s',
        'div[role="main"] div.a3s.aiL',
        'div[role="main"] div.a3s'
      ], 20);

      if (!subject && !bodyText) {
        return '';
      }

      const headerParts = [
        '[Gmail]',
        subject ? `Subject: ${subject}` : null,
        sender ? `From: ${sender}` : null,
        sentAt ? `Date: ${sentAt}` : null,
        `URL: ${url.href}`
      ].filter(Boolean);

      return `${headerParts.join(' | ')}\n\n${bodyText}`;
    } catch (error) {
      console.error('Gmail extraction failed:', error);
      return '';
    }
  }

  if (hostname.includes('open.spotify.com')) {
    const spotifyTranscript = await extractSpotifyTranscript();
    if (spotifyTranscript && spotifyTranscript.length > 50) {
      console.log(`Spotify: extracted transcript text, length=${spotifyTranscript.length}`);
      return spotifyTranscript;
    }
  }

  if (hostname.includes('mail.google.com')) {
    const gmailEmail = await extractGmailOpenEmail();
    if (gmailEmail && gmailEmail.length > 20) {
      console.log(`Gmail: extracted open email, length=${gmailEmail.length}`);
      return gmailEmail;
    }
    console.log('Gmail: open email not detected, skipping tab');
    return '';
  }
  console.log(`Próbuję wyekstrahować tekst z: ${hostname}`);
  
  // Mapa selektorów specyficznych dla każdego źródła
  const sourceSelectors = {
    'economist.com': [
      'article',
      '[data-test-id="Article"]',
      '.article__body-text',
      '.layout-article-body'
    ],
    'asia.nikkei.com': [
      'article',
      '.article-body',
      '.ezrichtext-field',
      '.article__body'
    ],
    'caixinglobal.com': [
      'article',
      '.article-content',
      '.article__body',
      '.story-content'
    ],
    'theafricareport.com': [
      'article',
      '.post-content',
      '.entry-content',
      '.article-body'
    ],
    'nzz.ch': [
      'article',
      '.article__body',
      '[itemprop="articleBody"]',
      '.article-content'
    ],
    'project-syndicate.org': [
      'article',
      '.article-content',
      '.body-content',
      '[itemprop="articleBody"]'
    ],
    'the-ken.com': [
      'article',
      '.story-content',
      '[data-article-body]',
      '.article-body'
    ],
    'wsj.com': [
      'article',
      '[itemprop="articleBody"]',
      '.article-content',
      '.wsj-snippet-body'
    ],
    'barrons.com': [
      'article',
      '[itemprop="articleBody"]',
      '.article-content',
      '.snippet-promotion',
      '[data-module="ArticleBody"]'
    ],
    'foreignaffairs.com': [
      'article',
      '.article-body',
      '[itemprop="articleBody"]',
      '.article-content'
    ],
    'lazard.com': [
      'article',
      '[itemprop="articleBody"]',
      '.article-content',
      '.post-content',
      '.entry-content',
      '.content-body',
      'main'
    ],
    'rand.org': [
      'article',
      '[itemprop="articleBody"]',
      '.article-content',
      '.post-content',
      '.entry-content',
      '.content-body',
      'main'
    ],
    'epoch.ai': [
      'article',
      'main article',
      '[data-mdx-content]',
      '[class*="article-content"]',
      '[class*="post-content"]',
      '[class*="prose"]',
      'main'
    ],
    'open.spotify.com': [
      '[data-testid*="transcript" i]',
      '[aria-label*="transcript" i]',
      '[aria-label*="transkrypc" i]',
      '[class*="transcript" i]',
      '[id*="transcript" i]',
      'article',
      'main',
      '[role="main"]'
    ]
  };
  
  // Znajdź odpowiednie selektory dla obecnego źródła
  let selectorsToTry = [];
  for (const [domain, selectors] of Object.entries(sourceSelectors)) {
    if (hostname.includes(domain)) {
      selectorsToTry = selectors;
      console.log(`Używam selektorów dla: ${domain}`);
      break;
    }
  }
  
  // Dodaj uniwersalne selektory jako fallback
  const universalSelectors = [
    'main article',
    'main',
    '[role="main"]',
    '.article-content',
    '[class*="article-content"]',
    '[class*="post-content"]',
    '[class*="prose"]',
    '[data-mdx-content]',
    '#content'
  ];
  selectorsToTry = [...selectorsToTry, ...universalSelectors];
  
  // Próbuj ekstrahować tekst
  const minTextLength = 100;
  for (const selector of selectorsToTry) {
    let elements = [];
    try {
      elements = Array.from(document.querySelectorAll(selector));
    } catch (_) {
      // Ignore invalid selector and continue.
      continue;
    }

    let bestText = '';
    for (const element of elements) {
      const text = normalizeText(element.innerText || element.textContent || '');
      if (text.length > bestText.length) {
        bestText = text;
      }
    }

    if (bestText.length > minTextLength) {
      console.log(`Found text via selector: ${selector}, length: ${bestText.length}`);
      return bestText;
    }
  }

  // Broad fallback: pick the largest text block from common containers.
  const broadFallbackSelectors = ['article', 'main', '[role="main"]'];
  let broadBestText = '';
  for (const selector of broadFallbackSelectors) {
    const elements = Array.from(document.querySelectorAll(selector));
    for (const element of elements) {
      const text = normalizeText(element.innerText || element.textContent || '');
      if (text.length > broadBestText.length) {
        broadBestText = text;
      }
    }
  }
  if (broadBestText.length > minTextLength) {
    console.log(`Fallback container extraction length: ${broadBestText.length}`);
    return broadBestText;
  }

  // Final fallback: full body.
  const bodyText = normalizeText(document.body.innerText || document.body.textContent || '');
  console.log(`Fallback to body, length: ${bodyText.length}`);
  return bodyText;
}

// Funkcja wklejania do ChatGPT (content script)
async function injectToChat(
  payload,
  promptChain,
  textareaWaitMs,
  responseWaitMs,
  retryIntervalMs,
  articleTitle,
  analysisType = 'company',
  runId = null,
  progressContext = null,
  autoRecoveryContext = null,
  persistenceContext = null,
  manualPdfAttachmentContext = null
) {
  let forceStopRequested = false;
  let forceStopReason = 'force_stop';
  let forceStopOrigin = 'background';
  let forceStopListener = null;

  const isForceStopForCurrentRun = (message) => {
    if (!message || message.type !== 'PROCESS_FORCE_STOP') return false;
    if (typeof runId === 'string' && runId.trim()) {
      if (typeof message.runId === 'string' && message.runId.trim()) {
        return message.runId === runId;
      }
      return true;
    }
    return true;
  };

  const markForceStopRequested = (message = {}) => {
    forceStopRequested = true;
    if (typeof message.reason === 'string' && message.reason.trim()) {
      forceStopReason = message.reason.trim();
    }
    if (typeof message.origin === 'string' && message.origin.trim()) {
      forceStopOrigin = message.origin.trim();
    }
  };

  const cleanupForceStopListener = () => {
    if (!forceStopListener || !chrome?.runtime?.onMessage?.removeListener) return;
    try {
      chrome.runtime.onMessage.removeListener(forceStopListener);
    } catch (error) {
      // Ignore cleanup issues.
    }
    forceStopListener = null;
  };

  try {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🚀 [injectToChat] START`);
    console.log(`  Article: ${articleTitle}`);
    console.log(`  Analysis: ${analysisType}`);
    console.log(`  Prompts: ${promptChain?.length || 0}`);
    console.log(`${'='.repeat(80)}\n`);

    if (chrome?.runtime?.onMessage?.addListener) {
      forceStopListener = (message, sender, sendResponse) => {
        if (!isForceStopForCurrentRun(message)) return;
        markForceStopRequested(message);
        console.warn(`[injectToChat] Otrzymano PROCESS_FORCE_STOP (runId=${runId || 'n/a'})`);
        if (typeof sendResponse === 'function') {
          try {
            sendResponse({
              success: true,
              acknowledged: true,
              stopped: true,
              runId: runId || null
            });
          } catch (error) {
            // Ignore sendResponse issues.
          }
        }
        return true;
      };
      try {
        chrome.runtime.onMessage.addListener(forceStopListener);
      } catch (error) {
        forceStopListener = null;
      }
    }

    const shouldStopNow = () => forceStopRequested;
    const runStartedAt = Date.now();
    const runMetrics = {
      sendAttempts: 0,
      sendOkVerified: 0,
      sendOkInferred: 0,
      sendFailures: 0,
      sendSkipped: 0,
      sendHardFail: 0,
      sendDuplicateAttempts: 0,
      responseTimeouts: 0,
      responseSkipped: 0,
      responseInvalid: 0,
      responseAccepted: 0,
      responseAcceptedEmpty: 0,
      responseDuplicateAccepted: 0,
      stageCompleted: 0,
      captureOk: 0,
      captureEmpty: 0
    };
    const sendOkPromptIndexes = new Set();
    const sendAttemptPromptIndexes = new Set();
    const sendAttemptsByPrompt = new Map();
    const stageCompletedPromptIndexes = new Set();
    const responseFingerprintsAccepted = new Map();

    const runTag = `runId=${runId || 'n/a'}`;

    const sendOkTotal = () => runMetrics.sendOkVerified + runMetrics.sendOkInferred;
    const duplicateTotal = () => runMetrics.sendDuplicateAttempts + runMetrics.responseDuplicateAccepted;

    function buildMetricsSnapshot(extra = {}) {
      return {
        ...runMetrics,
        sendOkTotal: sendOkTotal(),
        sendOkUnique: sendOkPromptIndexes.size,
        sendAttemptUnique: sendAttemptPromptIndexes.size,
        stageCompletedUnique: stageCompletedPromptIndexes.size,
        responseAcceptedUnique: responseFingerprintsAccepted.size,
        duplicateTotal: duplicateTotal(),
        durationMs: Date.now() - runStartedAt,
        ...extra
      };
    }

    function logSend(event, extra = {}) {
      // Keep logs ASCII to avoid mojibake in some consoles.
      console.log(`[inject][send] ${event} ${runTag}`, {
        ok: sendOkTotal(),
        uniqueOk: sendOkPromptIndexes.size,
        verifiedOk: runMetrics.sendOkVerified,
        inferredOk: runMetrics.sendOkInferred,
        failures: runMetrics.sendFailures,
        skipped: runMetrics.sendSkipped,
        hardFail: runMetrics.sendHardFail,
        ...extra
      });
    }

    function logCapture(event, extra = {}) {
      console.log(`[inject][capture] ${event} ${runTag}`, {
        ok: runMetrics.captureOk,
        empty: runMetrics.captureEmpty,
        ...extra
      });
    }

    const forceStopResult = () => ({
      success: false,
      lastResponse: '',
      error: 'force_stopped',
      stopped: true,
      reason: forceStopReason,
      origin: forceStopOrigin,
      metrics: buildMetricsSnapshot({ stopped: true })
    });

    // Shared helpers for injected context
    function compactText(text) {
      return (text || '').replace(/\s+/g, ' ').trim();
    }

    function normalizePromptMetricIndex(promptIndex) {
      return Number.isInteger(promptIndex) && promptIndex > 0 ? promptIndex : null;
    }

    function registerPromptAttempt(promptIndex) {
      const normalizedIndex = normalizePromptMetricIndex(promptIndex);
      if (!normalizedIndex) return;
      sendAttemptPromptIndexes.add(normalizedIndex);
      const nextCount = (sendAttemptsByPrompt.get(normalizedIndex) || 0) + 1;
      sendAttemptsByPrompt.set(normalizedIndex, nextCount);
      if (nextCount > 1) {
        runMetrics.sendDuplicateAttempts += 1;
      }
    }

    function registerStageCompletion(promptIndex, responseText = '', validated = true) {
      if (!validated) return;
      const normalizedIndex = normalizePromptMetricIndex(promptIndex);
      if (!normalizedIndex) return;

      if (!stageCompletedPromptIndexes.has(normalizedIndex)) {
        stageCompletedPromptIndexes.add(normalizedIndex);
        runMetrics.stageCompleted = stageCompletedPromptIndexes.size;
      }

      const normalizedResponse = compactText(responseText);
      if (!normalizedResponse) {
        runMetrics.responseAcceptedEmpty += 1;
        return;
      }

      runMetrics.responseAccepted += 1;
      const fp = computeCopyFingerprint(normalizedResponse);
      const seenCount = responseFingerprintsAccepted.get(fp) || 0;
      responseFingerprintsAccepted.set(fp, seenCount + 1);
      if (seenCount > 0) {
        runMetrics.responseDuplicateAccepted += 1;
      }
    }

    function buildCounterSummary(current, total, status) {
      const safeTotal = Number.isInteger(total) && total > 0
        ? total
        : (Number.isInteger(totalPromptsForRun) ? totalPromptsForRun : 0);
      const safeCurrent = Number.isInteger(current) && current > 0
        ? current
        : 0;
      const boundedCurrent = safeTotal > 0
        ? Math.min(Math.max(safeCurrent, 0), safeTotal)
        : safeCurrent;
      const progressPct = safeTotal > 0
        ? Math.round((boundedCurrent / safeTotal) * 100)
        : 0;
      const duplicateCount = duplicateTotal();
      return {
        safeTotal,
        safeCurrent,
        boundedCurrent,
        progressPct,
        status: typeof status === 'string' ? status : '',
        stagesOk: runMetrics.stageCompleted,
        promptsAll: runMetrics.sendAttempts,
        promptsUnique: sendAttemptPromptIndexes.size,
        responsesAll: runMetrics.responseAccepted,
        responsesUnique: responseFingerprintsAccepted.size,
        duplicatePrompts: runMetrics.sendDuplicateAttempts,
        duplicateResponses: runMetrics.responseDuplicateAccepted,
        duplicateCount
      };
    }

    function getAssistantSnapshot() {
      const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
      const count = assistantMessages.length;
      const lastMsg = count > 0 ? assistantMessages[count - 1] : null;
      const lastText = lastMsg ? compactText(lastMsg.innerText || lastMsg.textContent || '') : '';
      return { count, lastText };
    }

    const STAGE0_PLACEHOLDER_REGEX = /\[WSTAW TUTAJ PIERWSZA ODPOWIEDZ \(Stage 0\)\]|WSTAW TUTAJ PIERWSZA ODPOWIEDZ \(Stage 0\)/gi;

    function injectStage0IntoPrompt(promptText, stage0Text) {
      if (!promptText || !stage0Text) {
        return { text: promptText, replaced: false };
      }
      const regex = new RegExp(STAGE0_PLACEHOLDER_REGEX.source, STAGE0_PLACEHOLDER_REGEX.flags);
      if (!regex.test(promptText)) {
        return { text: promptText, replaced: false };
      }
      return {
        text: promptText.replace(regex, () => stage0Text),
        replaced: true
      };
    }

    function injectStage0IntoChain(chain, stage0Text) {
      if (!Array.isArray(chain) || chain.length === 0) {
        return { chain, replacedCount: 0 };
      }

      let replacedCount = 0;
      const updatedChain = chain.map((promptText) => {
        const result = injectStage0IntoPrompt(promptText, stage0Text);
        if (result.replaced) {
          replacedCount += 1;
        }
        return result.text;
      });

      return { chain: updatedChain, replacedCount };
    }

    const promptOffset = Number.isInteger(progressContext?.promptOffset) && progressContext.promptOffset > 0
      ? progressContext.promptOffset
      : 0;
    const totalPromptsOverride = Number.isInteger(progressContext?.totalPromptsOverride) && progressContext.totalPromptsOverride >= 0
      ? progressContext.totalPromptsOverride
      : null;
    const localPromptCount = Array.isArray(promptChain) ? promptChain.length : 0;
    const totalPromptsForRun = Number.isInteger(totalPromptsOverride)
      ? Math.max(totalPromptsOverride, promptOffset + localPromptCount)
      : (promptOffset + localPromptCount);
    const payloadTextForMode = typeof payload === 'string' ? payload : '';
    const isResumeModeFromPayload = payloadTextForMode.trim() === ''
      || payloadTextForMode.includes('Resume from stage');
    const baselineCompletedStages = Number.isInteger(promptOffset) && promptOffset > 0
      ? Math.min(
        promptOffset,
        Number.isInteger(totalPromptsForRun) && totalPromptsForRun > 0
          ? totalPromptsForRun
          : promptOffset
      )
      : 0;
    const baselinePromptBlocks = isResumeModeFromPayload
      ? baselineCompletedStages
      : Math.max(0, baselineCompletedStages - 1);
    const baselineResponseBlocks = isResumeModeFromPayload
      ? baselineCompletedStages
      : Math.max(0, baselineCompletedStages - 1);
    if (baselineCompletedStages > 0) {
      for (let promptNumber = 1; promptNumber <= baselineCompletedStages; promptNumber += 1) {
        stageCompletedPromptIndexes.add(promptNumber);
      }
      runMetrics.stageCompleted = stageCompletedPromptIndexes.size;
      for (let promptNumber = 1; promptNumber <= baselinePromptBlocks; promptNumber += 1) {
        sendAttemptPromptIndexes.add(promptNumber);
        sendOkPromptIndexes.add(promptNumber);
        sendAttemptsByPrompt.set(promptNumber, 1);
      }
      runMetrics.sendAttempts = sendAttemptPromptIndexes.size;
      runMetrics.sendOkVerified = sendOkPromptIndexes.size;

      for (let responseNumber = 1; responseNumber <= baselineResponseBlocks; responseNumber += 1) {
        responseFingerprintsAccepted.set(`baseline_response_${responseNumber}`, 1);
      }
      runMetrics.responseAccepted = responseFingerprintsAccepted.size;
      runMetrics.responseDuplicateAccepted = 0;
      console.log('[inject][metrics] Baseline stage completion from resume offset', {
        isResumeModeFromPayload,
        promptOffset,
        baselineCompletedStages,
        baselinePromptBlocks,
        baselineResponseBlocks,
        totalPromptsForRun,
        stageCompleted: runMetrics.stageCompleted,
        promptBlocks: runMetrics.sendAttempts,
        responseBlocks: runMetrics.responseAccepted
      });
    }
    const autoRecoveryEnabled = autoRecoveryContext?.enabled === true;
    const autoRecoveryAttempt = Number.isInteger(autoRecoveryContext?.attempt) && autoRecoveryContext.attempt >= 0
      ? autoRecoveryContext.attempt
      : 0;
    const autoRecoveryMaxAttempts = Number.isInteger(autoRecoveryContext?.maxAttempts) && autoRecoveryContext.maxAttempts > 0
      ? autoRecoveryContext.maxAttempts
      : 0;
    const autoRecoveryDelayMs = Number.isInteger(autoRecoveryContext?.delayMs) && autoRecoveryContext.delayMs >= 0
      ? autoRecoveryContext.delayMs
      : 0;
    const autoRecoveryReasons = new Set(
      Array.isArray(autoRecoveryContext?.reasons)
        ? autoRecoveryContext.reasons.filter((reason) => typeof reason === 'string')
        : []
    );
    const persistenceMode = typeof persistenceContext?.mode === 'string'
      ? persistenceContext.mode.trim()
      : '';
    const persistFinalResponseViaMessage = persistenceContext?.persistFinalResponseViaMessage === true
      || persistenceMode === 'runtime_message';
    const persistenceTimeoutMs = Number.isInteger(persistenceContext?.saveTimeoutMs) && persistenceContext.saveTimeoutMs > 0
      ? Math.max(1000, Math.min(persistenceContext.saveTimeoutMs, 60000))
      : 18000;
    const MANUAL_PDF_ATTACH_MAX_ATTEMPTS = 2;
    const MANUAL_PDF_ATTACH_RETRY_DELAY_MS = 1200;
    const MANUAL_PDF_CHUNK_SIZE_INJECT = 512 * 1024;
    // Limit "wait for ready" to a short window so resume/start cannot freeze for hours.
    const INTERFACE_READY_MAX_WAIT_MS = 3 * 60 * 1000;
    const interfaceReadyWaitMs = Number.isFinite(responseWaitMs) && responseWaitMs > 0
      ? Math.max(15000, Math.min(responseWaitMs, INTERFACE_READY_MAX_WAIT_MS))
      : INTERFACE_READY_MAX_WAIT_MS;
    const manualPdfAttachment = (() => {
      const ctx = manualPdfAttachmentContext && typeof manualPdfAttachmentContext === 'object'
        ? manualPdfAttachmentContext
        : null;
      if (!ctx || ctx.enabled !== true) return null;
      const providerId = typeof ctx.providerId === 'string' ? ctx.providerId.trim() : '';
      const token = typeof ctx.token === 'string' ? ctx.token.trim() : '';
      const name = typeof ctx.name === 'string' && ctx.name.trim() ? ctx.name.trim() : 'source.pdf';
      const mimeType = typeof ctx.mimeType === 'string' && ctx.mimeType.trim()
        ? ctx.mimeType.trim()
        : 'application/pdf';
      const size = Number.isInteger(ctx.size) && ctx.size >= 0 ? ctx.size : 0;
      const instanceIndex = Number.isInteger(ctx.instanceIndex) && ctx.instanceIndex > 0 ? ctx.instanceIndex : 1;
      const instanceTotal = Number.isInteger(ctx.instanceTotal) && ctx.instanceTotal > 0 ? ctx.instanceTotal : 1;
      if (!providerId || !token) return null;
      return {
        enabled: true,
        providerId,
        token,
        name,
        mimeType,
        size,
        instanceIndex,
        instanceTotal
      };
    })();

    function getAbsolutePromptIndex(localPromptNumber) {
      if (!Number.isInteger(localPromptNumber) || localPromptNumber <= 0) return 0;
      return promptOffset + localPromptNumber;
    }

    function getAbsoluteStageIndex(localStageIndex, localPromptNumber = null) {
      if (Number.isInteger(localStageIndex) && localStageIndex >= 0) {
        return promptOffset + localStageIndex;
      }
      if (Number.isInteger(localPromptNumber) && localPromptNumber > 0) {
        return getAbsolutePromptIndex(localPromptNumber) - 1;
      }
      return null;
    }

    function computeCopyFingerprint(value = '') {
      const normalized = typeof value === 'string' ? value : String(value ?? '');
      let hash = 0x811c9dc5; // FNV-1a 32-bit
      for (let i = 0; i < normalized.length; i += 1) {
        hash ^= normalized.charCodeAt(i);
        hash = (hash >>> 0) * 0x01000193;
      }
      return (hash >>> 0).toString(16).padStart(8, '0');
    }

    function buildInjectedResponseId(responseText = '', selectedPrompt = null) {
      const safeRunId = typeof runId === 'string' && runId.trim()
        ? runId.trim().replace(/[^a-zA-Z0-9._-]/g, '_')
        : 'run';
      const promptPart = Number.isInteger(selectedPrompt) && selectedPrompt > 0
        ? `p${selectedPrompt}`
        : 'p0';
      const fp = computeCopyFingerprint(responseText);
      return `${safeRunId}_${promptPart}_${fp}`;
    }

    async function sendRuntimeMessageWithTimeout(message, timeoutMs = 15000) {
      if (!chrome?.runtime?.sendMessage) {
        return { ok: false, error: 'runtime_unavailable' };
      }
      const safeTimeout = Number.isInteger(timeoutMs) && timeoutMs > 0
        ? Math.max(1000, Math.min(timeoutMs, 60000))
        : 15000;
      const timeoutMarker = { __timeout__: true };
      try {
        const response = await Promise.race([
          chrome.runtime.sendMessage(message),
          new Promise((resolve) => setTimeout(() => resolve(timeoutMarker), safeTimeout))
        ]);
        if (response && response.__timeout__ === true) {
          return { ok: false, error: 'runtime_timeout' };
        }
        return { ok: true, response };
      } catch (error) {
        return { ok: false, error: error?.message || String(error) };
      }
    }

    async function persistFinalResponseViaRuntimeMessage(responseText, responseId, selectedPrompt, selectedStageIndex) {
      const normalizedText = typeof responseText === 'string' ? responseText : '';
      if (!normalizedText.trim()) {
        return { ok: false, error: 'empty_response' };
      }

      const stageMeta = {};
      if (Number.isInteger(selectedPrompt)) {
        stageMeta.selected_response_prompt = selectedPrompt;
      }
      if (Number.isInteger(selectedStageIndex)) {
        stageMeta.selected_response_stage_index = selectedStageIndex;
      }
      if (Number.isInteger(selectedPrompt)) {
        stageMeta.selected_response_reason = 'last_prompt';
      }

      const messagePayload = {
        type: 'SAVE_RESPONSE',
        text: normalizedText,
        source: articleTitle || '',
        analysisType,
        runId: typeof runId === 'string' ? runId : '',
        responseId: typeof responseId === 'string' ? responseId : '',
        stage: Object.keys(stageMeta).length > 0 ? stageMeta : null,
        conversationUrl: typeof location?.href === 'string' ? location.href : ''
      };

      const saveAttempt = await sendRuntimeMessageWithTimeout(messagePayload, persistenceTimeoutMs);
      if (!saveAttempt.ok) {
        return { ok: false, error: saveAttempt.error || 'save_message_failed' };
      }

      const runtimeResponse = saveAttempt.response && typeof saveAttempt.response === 'object'
        ? saveAttempt.response
        : null;
      if (!runtimeResponse?.success) {
        return {
          ok: false,
          error: runtimeResponse?.error || 'save_response_failed',
          saveResult: runtimeResponse?.saveResult || null
        };
      }

      return {
        ok: true,
        saveResult: runtimeResponse?.saveResult && typeof runtimeResponse.saveResult === 'object'
          ? runtimeResponse.saveResult
          : null
      };
    }

    function decodeBase64Chunk(base64Chunk = '') {
      const normalized = typeof base64Chunk === 'string' ? base64Chunk.trim() : '';
      if (!normalized) return new Uint8Array(0);
      const binary = atob(normalized);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return bytes;
    }

    async function fetchManualPdfFileFromProvider(attachment) {
      if (!attachment?.enabled) {
        return { success: false, error: 'attachment_disabled' };
      }

      const parts = [];
      let offset = 0;
      let guard = 0;
      const maxGuard = 200000;

      while (guard < maxGuard) {
        guard += 1;
        const chunkAttempt = await sendRuntimeMessageWithTimeout({
          type: 'MANUAL_PDF_GET_CHUNK',
          providerId: attachment.providerId,
          token: attachment.token,
          offset,
          chunkSize: MANUAL_PDF_CHUNK_SIZE_INJECT
        }, 30000);

        if (!chunkAttempt.ok) {
          const mappedError = chunkAttempt.error === 'runtime_timeout'
            ? 'provider_unavailable'
            : (chunkAttempt.error || 'chunk_read_failed');
          return { success: false, error: mappedError };
        }

        const chunkResponse = chunkAttempt.response && typeof chunkAttempt.response === 'object'
          ? chunkAttempt.response
          : null;
        if (!chunkResponse?.success) {
          return {
            success: false,
            error: chunkResponse?.error || 'chunk_read_failed'
          };
        }

        const base64Chunk = typeof chunkResponse.base64Chunk === 'string' ? chunkResponse.base64Chunk : '';
        if (base64Chunk) {
          try {
            const bytes = decodeBase64Chunk(base64Chunk);
            if (bytes.length > 0) parts.push(bytes);
          } catch (error) {
            return { success: false, error: 'chunk_decode_failed' };
          }
        }

        const nextOffset = Number.isInteger(chunkResponse.nextOffset)
          ? chunkResponse.nextOffset
          : offset;
        const eof = chunkResponse.eof === true;
        if (eof) {
          offset = nextOffset;
          break;
        }
        if (nextOffset <= offset) {
          return { success: false, error: 'invalid_next_offset' };
        }
        offset = nextOffset;
      }

      if (guard >= maxGuard) {
        return { success: false, error: 'chunk_guard_exceeded' };
      }

      if (parts.length === 0) {
        return { success: false, error: 'pdf_empty' };
      }

      try {
        const file = new File(parts, attachment.name || 'source.pdf', {
          type: attachment.mimeType || 'application/pdf'
        });
        return { success: true, file };
      } catch (error) {
        return { success: false, error: 'file_build_failed' };
      }
    }

    function findFileInputElement() {
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
      if (inputs.length === 0) return null;
      const preferred = inputs.find((input) => {
        if (!input || input.disabled) return false;
        const accept = String(input.getAttribute('accept') || '').toLowerCase();
        return !accept || accept.includes('pdf') || accept.includes('application/pdf');
      });
      return preferred || inputs.find((input) => input && !input.disabled) || inputs[0];
    }

    function findAttachmentTrigger() {
      const triggerPattern = /(attach|attachment|upload|file|paperclip|zalacz|za\u0142acz|dodaj plik|add files?)/i;
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], label, a'));
      for (const candidate of candidates) {
        if (!candidate) continue;
        const label = compactText([
          candidate.innerText || candidate.textContent || '',
          candidate.getAttribute?.('aria-label') || '',
          candidate.getAttribute?.('title') || '',
          candidate.getAttribute?.('data-testid') || ''
        ].join(' '));
        if (triggerPattern.test(label)) {
          return candidate;
        }
      }
      return null;
    }

    async function resolveFileInput(maxWaitMs = 8000) {
      const startedAt = Date.now();
      let lastClickAt = 0;
      while (Date.now() - startedAt < maxWaitMs) {
        const directInput = findFileInputElement();
        if (directInput) return directInput;

        const trigger = findAttachmentTrigger();
        if (trigger && Date.now() - lastClickAt > 700) {
          try {
            trigger.click();
            lastClickAt = Date.now();
          } catch (error) {
            // Ignore click issues and keep polling.
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return null;
    }

    function assignFileToInput(input, file) {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      input.files = dataTransfer.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function waitForAttachmentConfirmation(fileName, maxWaitMs = 15000) {
      const normalizedFileName = compactText(fileName || '').toLowerCase();
      const startedAt = Date.now();
      const errorPattern = /(upload failed|failed to upload|couldn['\u2019]?t upload|nie udalo sie przeslac|blad przesylania)/i;

      while (Date.now() - startedAt < maxWaitMs) {
        const pageText = compactText(document.body?.innerText || '');
        if (normalizedFileName && pageText.toLowerCase().includes(normalizedFileName)) {
          return { success: true };
        }

        const chips = document.querySelectorAll(
          '[data-testid*="attachment" i], [data-testid*="file" i], [class*="attachment" i], [class*="file" i], [aria-label*="attachment" i], [aria-label*="file" i]'
        );
        for (const chip of chips) {
          const chipText = compactText(chip?.textContent || '');
          if (normalizedFileName && chipText.toLowerCase().includes(normalizedFileName)) {
            return { success: true };
          }
        }

        if (errorPattern.test(pageText)) {
          return { success: false, error: 'upload_failed_ui' };
        }

        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      return { success: false, error: 'attachment_not_confirmed' };
    }

    async function attachManualPdfOnce(attachment) {
      const fileResult = await fetchManualPdfFileFromProvider(attachment);
      if (!fileResult.success || !fileResult.file) {
        return { success: false, error: fileResult.error || 'provider_unavailable' };
      }

      const input = await resolveFileInput(9000);
      if (!input) {
        return { success: false, error: 'file_input_not_found' };
      }

      try {
        assignFileToInput(input, fileResult.file);
      } catch (error) {
        return { success: false, error: 'file_input_assignment_failed' };
      }

      return waitForAttachmentConfirmation(fileResult.file.name, 15000);
    }

    async function attachManualPdfWithRetry(attachment) {
      for (let attempt = 1; attempt <= MANUAL_PDF_ATTACH_MAX_ATTEMPTS; attempt += 1) {
        notifyProcess('PROCESS_PROGRESS', {
          status: 'running',
          currentPrompt: promptOffset,
          totalPrompts: totalPromptsForRun,
          statusText: attempt === 1 ? 'uploading_pdf' : 'pdf_attach_retry',
          reason: attempt === 1 ? 'uploading_pdf' : 'pdf_attach_retry',
          needsAction: false
        });

        console.log('[manual-pdf][attach] attempt start', {
          attempt,
          maxAttempts: MANUAL_PDF_ATTACH_MAX_ATTEMPTS,
          file: attachment.name,
          runId: runId || 'n/a'
        });

        const attemptResult = await attachManualPdfOnce(attachment);
        if (attemptResult.success) {
          notifyProcess('PROCESS_PROGRESS', {
            status: 'running',
            currentPrompt: promptOffset,
            totalPrompts: totalPromptsForRun,
            statusText: 'pdf_attached',
            reason: 'pdf_attached',
            needsAction: false
          });
          console.log('[manual-pdf][attach] success', {
            attempt,
            file: attachment.name,
            runId: runId || 'n/a'
          });
          return { success: true };
        }

        console.warn('[manual-pdf][attach] failed', {
          attempt,
          maxAttempts: MANUAL_PDF_ATTACH_MAX_ATTEMPTS,
          file: attachment.name,
          error: attemptResult.error || 'unknown',
          runId: runId || 'n/a'
        });

        if (attempt < MANUAL_PDF_ATTACH_MAX_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, MANUAL_PDF_ATTACH_RETRY_DELAY_MS));
          continue;
        }

        notifyProcess('PROCESS_PROGRESS', {
          status: 'failed',
          currentPrompt: promptOffset,
          totalPrompts: totalPromptsForRun,
          statusText: 'pdf_attach_failed',
          reason: 'pdf_attach_failed',
          error: attemptResult.error || 'pdf_attach_failed',
          needsAction: false
        });
        return {
          success: false,
          error: 'pdf_attach_failed',
          details: attemptResult.error || ''
        };
      }

      return { success: false, error: 'pdf_attach_failed' };
    }

    async function captureLastResponseWithRetries(initialText = '', promptNumber = 0) {
      const maxAttempts = 5;
      const retryDelayMs = 700;
      const initial = typeof initialText === 'string' ? initialText : '';

      let bestText = initial;
      let bestFp = computeCopyFingerprint(bestText);
      let previousFp = bestFp;
      let stableHits = bestText.trim().length > 0 ? 1 : 0;

      console.log(
        `[copy-flow] [capture:stabilize:start] prompt=${promptNumber} attempts=${maxAttempts} initialLen=${bestText.length} fp=${bestFp}`
      );

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (attempt > 1) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        }

        let candidateText = '';
        try {
          const extracted = await getLastResponseText();
          candidateText = typeof extracted === 'string' ? extracted : '';
        } catch (error) {
          console.warn(
            `[copy-flow] [capture:stabilize:error] prompt=${promptNumber} attempt=${attempt}/${maxAttempts} error=${error?.message || String(error)}`
          );
          candidateText = '';
        }

        const candidateFp = computeCopyFingerprint(candidateText);
        const candidateLen = candidateText.length;
        const improved = candidateLen > bestText.length;
        if (improved) {
          bestText = candidateText;
          bestFp = candidateFp;
        }

        if (candidateText.trim().length > 0 && candidateFp === previousFp) {
          stableHits += 1;
        } else {
          stableHits = candidateText.trim().length > 0 ? 1 : 0;
        }
        previousFp = candidateFp;

        console.log(
          `[copy-flow] [capture:stabilize:attempt] prompt=${promptNumber} attempt=${attempt}/${maxAttempts} candidateLen=${candidateLen} candidateFp=${candidateFp} improved=${improved} bestLen=${bestText.length} stableHits=${stableHits}`
        );

        if (stableHits >= 2 && bestText.length > 0) {
          console.log(
            `[copy-flow] [capture:stabilize:stable] prompt=${promptNumber} attempt=${attempt}/${maxAttempts} len=${bestText.length} fp=${bestFp}`
          );
          break;
        }
      }

      console.log(
        `[copy-flow] [capture:stabilize:done] prompt=${promptNumber} finalLen=${bestText.length} fp=${bestFp} changed=${bestText !== initial}`
      );
      return bestText;
    }

    function buildAutoRecoveryHandoff(reason, localPromptIndex, promptChainSnapshot) {
      const safeLocalIndex = Number.isInteger(localPromptIndex) && localPromptIndex >= 0
        ? localPromptIndex
        : 0;
      const localPromptNumber = safeLocalIndex + 1;
      const currentPrompt = getAbsolutePromptIndex(localPromptNumber);
      const stageIndex = getAbsoluteStageIndex(safeLocalIndex, localPromptNumber);
      const nextPromptOffset = Math.max(0, currentPrompt - 1);
      const remainingPrompts = Array.isArray(promptChainSnapshot)
        ? promptChainSnapshot.slice(safeLocalIndex)
        : [];

      return {
        success: false,
        lastResponse: '',
        error: 'auto_recovery_required',
        autoRecovery: {
          reason,
          currentPrompt,
          stageIndex,
          promptOffset: nextPromptOffset,
          remainingPrompts
        }
      };
    }

    function maybeTriggerAutoRecovery(reason, localPromptIndex, promptChainSnapshot, absoluteCurrentPrompt, absoluteStageIndex, counterRef) {
      if (!autoRecoveryEnabled) return null;
      if (!autoRecoveryReasons.has(reason)) return null;
      if (autoRecoveryAttempt >= autoRecoveryMaxAttempts) return null;

      const nextAttempt = autoRecoveryAttempt + 1;
      const safePrompt = Number.isInteger(absoluteCurrentPrompt) ? absoluteCurrentPrompt : 0;
      const safeStageIndex = Number.isInteger(absoluteStageIndex)
        ? absoluteStageIndex
        : (safePrompt > 0 ? safePrompt - 1 : null);
      const stageName = safePrompt > 0 ? `Prompt ${safePrompt}` : 'Start';
      const delaySec = Math.max(0, Math.round(autoRecoveryDelayMs / 1000));

      updateCounter(
        counterRef,
        safePrompt,
        totalPromptsForRun,
        `Auto-resend ${nextAttempt}/${autoRecoveryMaxAttempts} za ${delaySec}s...`
      );
      notifyProcess('PROCESS_PROGRESS', {
        status: 'running',
        currentPrompt: safePrompt,
        totalPrompts: totalPromptsForRun,
        stageIndex: safeStageIndex,
        stageName,
        statusText: `Auto-resend ${nextAttempt}/${autoRecoveryMaxAttempts}`,
        reason: `auto_recovery_${reason}`,
        needsAction: false
      });

      return buildAutoRecoveryHandoff(reason, localPromptIndex, promptChainSnapshot);
    }

    function getPromptProbeFragment(promptText) {
      if (typeof promptText !== 'string') return '';
      return compactText(promptText).slice(0, 60);
    }

    function getLastTurnContainer(node) {
      if (!node) return null;
      return node.closest('[data-testid^="conversation-turn-"]')
        || node.closest('article')
        || node.closest('[class*="turn"]')
        || node.closest('[class*="message"]')
        || null;
    }

    function isHardGenerationErrorText(text) {
      const lowered = compactText(text || '').toLowerCase();
      if (!lowered) return false;
      return (
        lowered.includes('something went wrong while generating the response') ||
        lowered === 'something went wrong' ||
        lowered.includes('an error occurred while generating') ||
        lowered.includes('network error') ||
        (
          lowered.includes('streaming interrupted') &&
          lowered.includes('waiting for the complete message')
        )
      );
    }

    function getLastTurnState() {
      const userMessages = document.querySelectorAll('[data-message-author-role="user"]');
      const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
      const lastUser = userMessages.length > 0 ? userMessages[userMessages.length - 1] : null;
      const lastAssistant = assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1] : null;
      const lastUserContainer = getLastTurnContainer(lastUser);
      const lastAssistantContainer = getLastTurnContainer(lastAssistant);
      const alerts = [
        ...document.querySelectorAll('[role="alert"]'),
        ...document.querySelectorAll('[role="status"]')
      ];
      const lastAlert = alerts.length > 0 ? alerts[alerts.length - 1] : null;

      return {
        userCount: userMessages.length,
        assistantCount: assistantMessages.length,
        lastUser,
        lastAssistant,
        lastUserContainer,
        lastAssistantContainer,
        lastUserText: compactText(lastUser ? (lastUser.innerText || lastUser.textContent || '') : ''),
        lastAssistantText: compactText(lastAssistant ? (lastAssistant.innerText || lastAssistant.textContent || '') : ''),
        lastUserTurnText: compactText(lastUserContainer ? (lastUserContainer.innerText || lastUserContainer.textContent || '') : ''),
        lastAssistantTurnText: compactText(lastAssistantContainer ? (lastAssistantContainer.innerText || lastAssistantContainer.textContent || '') : ''),
        lastAlertText: compactText(lastAlert ? (lastAlert.innerText || lastAlert.textContent || '') : ''),
        turnLikelyCurrent: assistantMessages.length >= userMessages.length
      };
    }

    function getPromptDomSnapshot() {
      const state = getLastTurnState();
      return {
        userCount: state.userCount,
        assistantCount: state.assistantCount,
        lastUserText: state.lastUserText,
        lastAssistantText: state.lastAssistantText,
        lastUserTurnText: state.lastUserTurnText,
        lastAssistantTurnText: state.lastAssistantTurnText
      };
    }

    function hasAssistantAdvancedSince(snapshot, minDelta = 30) {
      const base = snapshot && typeof snapshot === 'object' ? snapshot : {};
      const current = getPromptDomSnapshot();
      if (current.assistantCount > (Number.isInteger(base.assistantCount) ? base.assistantCount : 0)) {
        return true;
      }
      const prevText = typeof base.lastAssistantText === 'string' ? base.lastAssistantText : '';
      const nextText = typeof current.lastAssistantText === 'string' ? current.lastAssistantText : '';
      const prevTurnText = typeof base.lastAssistantTurnText === 'string' ? base.lastAssistantTurnText : '';
      const nextTurnText = typeof current.lastAssistantTurnText === 'string' ? current.lastAssistantTurnText : '';
      if (prevText !== nextText && Math.abs(nextText.length - prevText.length) >= minDelta) {
        return true;
      }
      if (prevTurnText !== nextTurnText && Math.abs(nextTurnText.length - prevTurnText.length) >= minDelta) {
        return true;
      }
      return false;
    }

    function hasStreamingInterruptedState() {
      const interruptedPhrase = 'streaming interrupted';
      const waitingPhrase = 'waiting for the complete message';
      const userCount = document.querySelectorAll('[data-message-author-role="user"]').length;
      const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
      const assistantCount = assistantMessages.length;
      const turnLikelyCurrent = assistantCount >= userCount;

      const lastAssistant = assistantCount > 0 ? assistantMessages[assistantCount - 1] : null;
      const lastAssistantText = compactText(
        lastAssistant ? (lastAssistant.innerText || lastAssistant.textContent || '') : ''
      ).toLowerCase();
      const interruptedInLastAssistant =
        lastAssistantText.includes(interruptedPhrase) &&
        lastAssistantText.includes(waitingPhrase);

      if (interruptedInLastAssistant && turnLikelyCurrent) {
        return true;
      }

      const alerts = [
        ...document.querySelectorAll('[role="alert"]'),
        ...document.querySelectorAll('[role="status"]')
      ];
      const lastAlert = alerts.length > 0 ? alerts[alerts.length - 1] : null;
      const lastAlertText = compactText(
        lastAlert ? (lastAlert.innerText || lastAlert.textContent || '') : ''
      ).toLowerCase();
      const interruptedInAlert =
        lastAlertText.includes(interruptedPhrase) &&
        lastAlertText.includes(waitingPhrase);

      return interruptedInAlert && turnLikelyCurrent;
    }

    function hasHardGenerationErrorMessage() {
      if (hasStreamingInterruptedState()) {
        return true;
      }

      const state = getLastTurnState();
      if (!state.turnLikelyCurrent) {
        return false;
      }

      if (isHardGenerationErrorText(state.lastAssistantText)) {
        return true;
      }
      if (isHardGenerationErrorText(state.lastAlertText)) {
        return true;
      }

      const scopedContainers = [state.lastAssistant, state.lastAssistantContainer].filter(Boolean);
      for (const container of scopedContainers) {
        const scopedCandidates = [
          ...container.querySelectorAll('[role="alert"]'),
          ...container.querySelectorAll('[class*="error"]'),
          ...container.querySelectorAll('[class*="text"]')
        ];
        for (const node of scopedCandidates) {
          const text = compactText(node?.textContent || '');
          if (isHardGenerationErrorText(text)) {
            return true;
          }
        }
      }

      return false;
    }

    async function detectPromptSentDespiteFailure(snapshot, promptText, maxWaitMs = 6000) {
      const start = Date.now();
      const base = snapshot && typeof snapshot === 'object' ? snapshot : getPromptDomSnapshot();
      const promptFragment = getPromptProbeFragment(promptText);

      while (Date.now() - start < maxWaitMs) {
        const current = getPromptDomSnapshot();
        const userAdvanced = current.userCount > (Number.isInteger(base.userCount) ? base.userCount : 0);
        const userMatchesPrompt = !promptFragment || current.lastUserText.includes(promptFragment);
        const userMessageChanged =
          !!current.lastUserText &&
          current.lastUserText !== (typeof base.lastUserText === 'string' ? base.lastUserText : '');
        const userTurnChanged =
          !!current.lastUserTurnText &&
          current.lastUserTurnText !== (typeof base.lastUserTurnText === 'string' ? base.lastUserTurnText : '');
        if ((userAdvanced || userMessageChanged || userTurnChanged) && userMatchesPrompt) {
          return true;
        }

        await new Promise((resolve) => setTimeout(resolve, 250));
      }

      return false;
    }

    async function classifyTimeoutOutcome(snapshot, promptText) {
      const base = snapshot && typeof snapshot === 'object' ? snapshot : getPromptDomSnapshot();
      const promptFragment = getPromptProbeFragment(promptText);

      if (hasHardGenerationErrorMessage()) {
        return 'no_response_or_error';
      }

      if (hasAssistantAdvancedSince(base, 20)) {
        const extracted = await getLastResponseText();
        if (!hasHardGenerationErrorMessage() && validateResponse(extracted)) {
          return 'response_ready';
        }
      }

      const generation = isGenerating();
      const current = getPromptDomSnapshot();
      const userAdvanced = current.userCount > (Number.isInteger(base.userCount) ? base.userCount : 0);
      const userMatchesPrompt = !promptFragment || current.lastUserText.includes(promptFragment);
      if (generation.generating || (userAdvanced && userMatchesPrompt)) {
        return 'still_generating';
      }

      return 'no_response_or_error';
    }

    function notifyProcess(type, payload = {}) {
      if (!runId || !chrome?.runtime?.sendMessage) return;
      try {
        chrome.runtime.sendMessage({
          type,
          runId,
          analysisType,
          title: articleTitle || '',
          ...payload
        }).catch(() => {});
      } catch (error) {
        // Ignore messaging errors in injected context.
      }
    }



    
  // Funkcja generująca losowe opóźnienie dla anti-automation
  function getRandomDelay() {
    const minDelay = 3000;  // 3 sekundy
    const maxDelay = 15000; // 15 sekund
    return Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
  }
    
  // Funkcja tworząca licznik promptów
  function getCounterMiniToneFromStatus(status = '') {
    const normalized = String(status || '').toLowerCase().trim();
    if (!normalized) return 'neutral';

    if (
      normalized.includes('wymaga decyzji')
      || normalized.includes('wymaga akcji')
      || normalized.includes('needs action')
      || normalized.includes('decision')
    ) {
      return 'warn';
    }

    if (
      normalized.includes('blad')
      || normalized.includes('błąd')
      || normalized.includes('error')
      || normalized.includes('failed')
      || normalized.includes('timeout')
      || normalized.includes('nie gotowy')
      || normalized.includes('krytyczny')
    ) {
      return 'error';
    }

    if (
      normalized.includes('zakoncz')
      || normalized.includes('zakończ')
      || normalized.includes('completed')
      || normalized.includes('gotowe')
      || normalized.includes('saved')
      || normalized.includes('zapis')
    ) {
      return 'success';
    }

    return 'neutral';
  }

  function getCounterMiniDotColor(tone = 'neutral') {
    if (tone === 'success') return '#22c55e';
    if (tone === 'warn') return '#f59e0b';
    if (tone === 'error') return '#ef4444';
    return 'rgba(255,255,255,0.85)';
  }

  function ensureCounterMiniStageElement(counter) {
    if (!counter) return null;
    const header = counter.firstElementChild;
    if (!header) return null;

    let miniStage = header.querySelector('#economist-counter-mini-stage');
    if (miniStage) return miniStage;

    miniStage = document.createElement('div');
    miniStage.id = 'economist-counter-mini-stage';
    miniStage.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      margin-left: 8px;
      margin-right: auto;
      min-width: 72px;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.26);
      background: rgba(15,23,42,0.22);
      font-size: 11px;
      font-weight: 700;
      line-height: 1;
      opacity: 0.98;
      white-space: nowrap;
    `;

    const dot = document.createElement('span');
    dot.className = 'economist-counter-mini-dot';
    dot.style.cssText = `
      width: 7px;
      height: 7px;
      border-radius: 999px;
      display: inline-block;
      background: rgba(255,255,255,0.85);
      flex: 0 0 auto;
      box-shadow: 0 0 0 1px rgba(15,23,42,0.25);
    `;

    const label = document.createElement('span');
    label.className = 'economist-counter-mini-label';
    label.textContent = 'P0/0';
    label.style.cssText = `
      letter-spacing: 0.01em;
      font-size: 11px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-variant-numeric: tabular-nums;
    `;

    miniStage.appendChild(dot);
    miniStage.appendChild(label);

    const controls = header.querySelector('#economist-counter-controls');
    if (controls) {
      header.insertBefore(miniStage, controls);
    } else {
      header.appendChild(miniStage);
    }

    return miniStage;
  }

  function setCounterMiniStage(counter, current, total, tone = 'neutral') {
    if (!counter) return;
    const miniStage = ensureCounterMiniStageElement(counter);
    if (!miniStage) return;

    const safeTotal = Number.isInteger(total) && total > 0 ? total : 0;
    const safeCurrentRaw = Number.isInteger(current) ? current : 0;
    const boundedCurrent = safeTotal > 0
      ? Math.min(Math.max(safeCurrentRaw, 0), safeTotal)
      : Math.max(safeCurrentRaw, 0);
    const progressText = safeTotal > 0
      ? `P${boundedCurrent}/${safeTotal}`
      : `P${boundedCurrent}/0`;

    const dot = miniStage.querySelector('.economist-counter-mini-dot');
    const label = miniStage.querySelector('.economist-counter-mini-label');

    if (dot) {
      dot.style.background = getCounterMiniDotColor(tone);
    }

    if (label) {
      label.textContent = progressText;
    } else {
      miniStage.textContent = progressText;
    }
  }

  // Funkcja tworzaca licznik promptow
  function createCounter() {
    const existingCounters = Array.from(document.querySelectorAll('#economist-prompt-counter'));
    existingCounters.forEach((node) => {
      const timerId = Number.parseInt(node?.dataset?.economistCloseTimerId || '', 10);
      if (Number.isInteger(timerId)) {
        clearTimeout(timerId);
      }
      try {
        node.remove();
      } catch (_) {
        // ignore
      }
    });

    const counter = document.createElement('div');
    counter.id = 'economist-prompt-counter';

    let savedPosition = { top: '20px', right: '20px', left: '' };
    try {
      const rawSaved = JSON.parse(localStorage.getItem('economist-counter-position') || '{}');
      if (rawSaved && typeof rawSaved === 'object') {
        savedPosition = {
          top: typeof rawSaved.top === 'string' && rawSaved.top.trim()
            ? rawSaved.top.trim()
            : '20px',
          left: typeof rawSaved.left === 'string' && rawSaved.left.trim()
            ? rawSaved.left.trim()
            : '',
          right: typeof rawSaved.right === 'string' && rawSaved.right.trim()
            ? rawSaved.right.trim()
            : ''
        };
      }
    } catch (_) {
      savedPosition = { top: '20px', right: '20px', left: '' };
    }
    if (!savedPosition.left && !savedPosition.right) {
      savedPosition.right = '20px';
    }
    const isMinimized = localStorage.getItem('economist-counter-minimized') === 'true';
    const expandedMinWidthPx = 220;
    const minimizedMinWidthPx = 140;

    counter.style.cssText = `
      position: fixed;
      top: ${savedPosition.top};
      ${savedPosition.right ? `right: ${savedPosition.right};` : ''}
      ${savedPosition.left ? `left: ${savedPosition.left};` : ''}
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      border-radius: 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px;
      font-weight: 600;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      z-index: 10000;
      min-width: ${isMinimized ? `${minimizedMinWidthPx}px` : `${expandedMinWidthPx}px`};
      cursor: ${isMinimized ? 'pointer' : 'default'};
      transition: all 0.3s ease;
    `;

    const header = document.createElement('div');
    header.style.cssText = `
      padding: 8px 12px;
      cursor: move;
      display: flex;
      align-items: center;
      gap: 8px;
      border-bottom: ${isMinimized ? 'none' : '1px solid rgba(255,255,255,0.3)'};
      user-select: none;
    `;

    const dragHandle = document.createElement('span');
    dragHandle.textContent = '::';
    dragHandle.style.cssText = 'opacity: 0.7; font-size: 14px; line-height: 1;';

    const miniStage = document.createElement('div');
    miniStage.id = 'economist-counter-mini-stage';
    miniStage.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      margin-left: 2px;
      margin-right: auto;
      min-width: 72px;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,0.26);
      background: rgba(15,23,42,0.22);
      font-size: 11px;
      font-weight: 700;
      line-height: 1;
      opacity: 0.98;
      white-space: nowrap;
    `;
    const miniDot = document.createElement('span');
    miniDot.className = 'economist-counter-mini-dot';
    miniDot.style.cssText = `
      width: 7px;
      height: 7px;
      border-radius: 999px;
      display: inline-block;
      background: rgba(255,255,255,0.85);
      flex: 0 0 auto;
      box-shadow: 0 0 0 1px rgba(15,23,42,0.25);
    `;
    const miniLabel = document.createElement('span');
    miniLabel.className = 'economist-counter-mini-label';
    miniLabel.textContent = 'P0/0';
    miniLabel.style.cssText = `
      letter-spacing: 0.01em;
      font-size: 11px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-variant-numeric: tabular-nums;
    `;
    miniStage.appendChild(miniDot);
    miniStage.appendChild(miniLabel);

    const controls = document.createElement('div');
    controls.id = 'economist-counter-controls';
    controls.style.cssText = `
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-left: 2px;
    `;

    const minimizeBtn = document.createElement('button');
    minimizeBtn.id = 'economist-counter-minimize';
    minimizeBtn.textContent = isMinimized ? '+' : '-';
    minimizeBtn.style.cssText = `
      background: none;
      border: none;
      color: white;
      font-size: 17px;
      line-height: 1;
      cursor: pointer;
      padding: 0;
      width: 18px;
      height: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0.75;
      transition: opacity 0.2s;
    `;
    minimizeBtn.onmouseover = () => { minimizeBtn.style.opacity = '1'; };
    minimizeBtn.onmouseout = () => { minimizeBtn.style.opacity = '0.75'; };

    const closeBtn = document.createElement('button');
    closeBtn.id = 'economist-counter-close';
    closeBtn.textContent = 'x';
    closeBtn.style.cssText = `
      background: none;
      border: none;
      color: white;
      font-size: 13px;
      line-height: 1;
      cursor: pointer;
      padding: 0;
      width: 18px;
      height: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0.75;
      transition: opacity 0.2s;
    `;
    closeBtn.onmouseover = () => { closeBtn.style.opacity = '1'; };
    closeBtn.onmouseout = () => { closeBtn.style.opacity = '0.75'; };

    controls.appendChild(minimizeBtn);
    controls.appendChild(closeBtn);

    header.appendChild(dragHandle);
    header.appendChild(miniStage);
    header.appendChild(controls);
    counter.appendChild(header);

    const content = document.createElement('div');
    content.id = 'economist-counter-content';
    content.style.cssText = `
      padding: ${isMinimized ? '0' : '8px 24px 16px 24px'};
      text-align: center;
      display: ${isMinimized ? 'none' : 'block'};
    `;
    counter.appendChild(content);

    const applyMinimizedState = (nextMinimized) => {
      if (nextMinimized) {
        header.style.padding = '8px 10px';
        content.style.display = 'none';
        content.style.padding = '0';
        counter.style.minWidth = `${minimizedMinWidthPx}px`;
        counter.style.cursor = 'pointer';
        header.style.borderBottom = 'none';
        minimizeBtn.textContent = '+';
        localStorage.setItem('economist-counter-minimized', 'true');
      } else {
        header.style.padding = '8px 12px';
        content.style.display = 'block';
        content.style.padding = '8px 24px 16px 24px';
        counter.style.minWidth = `${expandedMinWidthPx}px`;
        counter.style.cursor = 'default';
        header.style.borderBottom = '1px solid rgba(255,255,255,0.3)';
        minimizeBtn.textContent = '-';
        localStorage.setItem('economist-counter-minimized', 'false');
      }
    };

    applyMinimizedState(isMinimized);

    minimizeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const isCurrentlyMinimized = content.style.display === 'none';
      applyMinimizedState(!isCurrentlyMinimized);
    });

    closeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const timerId = Number.parseInt(counter.dataset.economistCloseTimerId || '', 10);
      if (Number.isInteger(timerId)) {
        clearTimeout(timerId);
      }
      counter.remove();
    });

    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    header.addEventListener('mousedown', (event) => {
      if (controls.contains(event.target)) return;
      isDragging = true;
      startX = event.clientX;
      startY = event.clientY;

      const rect = counter.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;

      counter.style.transition = 'none';
      event.preventDefault();
    });

    document.addEventListener('mousemove', (event) => {
      if (!isDragging) return;

      const deltaX = event.clientX - startX;
      const deltaY = event.clientY - startY;
      counter.style.left = `${startLeft + deltaX}px`;
      counter.style.right = 'auto';
      counter.style.top = `${startTop + deltaY}px`;
    });

    document.addEventListener('mouseup', () => {
      if (!isDragging) return;
      isDragging = false;
      counter.style.transition = 'all 0.3s ease';
      const position = {
        top: counter.style.top,
        left: counter.style.left
      };
      localStorage.setItem('economist-counter-position', JSON.stringify(position));
    });

    counter.addEventListener('click', (event) => {
      if (content.style.display !== 'none') return;
      if (controls.contains(event.target)) return;
      minimizeBtn.click();
    });

    document.body.appendChild(counter);

    const ensureCounterVisibleOnScreen = () => {
      if (!counter || !counter.isConnected) return;
      const rect = counter.getBoundingClientRect();
      if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) {
        counter.style.top = '20px';
        counter.style.right = '20px';
        counter.style.left = 'auto';
        localStorage.setItem('economist-counter-position', JSON.stringify({
          top: '20px',
          right: '20px'
        }));
        return;
      }

      const marginPx = 8;
      const viewportWidth = Math.max(document.documentElement?.clientWidth || 0, window.innerWidth || 0);
      const viewportHeight = Math.max(document.documentElement?.clientHeight || 0, window.innerHeight || 0);
      if (viewportWidth <= 0 || viewportHeight <= 0) return;

      const maxLeft = Math.max(marginPx, viewportWidth - rect.width - marginPx);
      const maxTop = Math.max(marginPx, viewportHeight - rect.height - marginPx);
      const clampedLeft = Math.min(Math.max(rect.left, marginPx), maxLeft);
      const clampedTop = Math.min(Math.max(rect.top, marginPx), maxTop);
      const moved = Math.abs(clampedLeft - rect.left) > 1 || Math.abs(clampedTop - rect.top) > 1;

      if (!moved) return;
      counter.style.left = `${Math.round(clampedLeft)}px`;
      counter.style.right = 'auto';
      counter.style.top = `${Math.round(clampedTop)}px`;
      localStorage.setItem('economist-counter-position', JSON.stringify({
        top: counter.style.top,
        left: counter.style.left
      }));
    };
    ensureCounterVisibleOnScreen();
    setCounterMiniStage(counter, 0, 0, 'neutral');
    return counter;
  }

  // Funkcja aktualizujaca licznik
  function updateCounter(counter, current, total, status = '') {
    const activeCounter = (counter && counter.isConnected)
      ? counter
      : Array.from(document.querySelectorAll('#economist-prompt-counter')).pop();
    if (!activeCounter) return;

    let content = activeCounter.querySelector('#economist-counter-content');
    if (!content) {
      content = document.createElement('div');
      content.id = 'economist-counter-content';
      content.style.cssText = 'padding: 8px 24px 16px 24px; text-align: center; display: block;';
      activeCounter.appendChild(content);
    }
    if (!content) return;

    const summary = buildCounterSummary(current, total, status);
    const miniTone = getCounterMiniToneFromStatus(summary.status);
    setCounterMiniStage(activeCounter, summary.boundedCurrent, summary.safeTotal, miniTone);
    activeCounter.dataset.economistCurrent = String(summary.boundedCurrent);
    activeCounter.dataset.economistTotal = String(summary.safeTotal);
    activeCounter.dataset.economistMiniTone = miniTone;

    const safeStatus = String(summary.status || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const title = summary.safeCurrent === 0
      ? 'Przetwarzanie'
      : 'Prompt Chain';
    const progressText = summary.safeTotal > 0
      ? `${summary.boundedCurrent} / ${summary.safeTotal}`
      : (summary.safeCurrent > 0 ? String(summary.safeCurrent) : '0 / 0');

    content.innerHTML = `
      <div style="font-size: 15px; font-weight: 700; margin-bottom: 6px;">${title}</div>
      <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; margin-bottom: 8px; text-align: left;">
        <div style="background: rgba(255,255,255,0.16); border-radius: 8px; padding: 6px 8px;">
          <div style="font-size: 10px; opacity: 0.85;">Etapy OK</div>
          <div style="font-size: 15px; font-weight: 700;">${summary.stagesOk}/${summary.safeTotal || 0}</div>
        </div>
        <div style="background: rgba(255,255,255,0.16); border-radius: 8px; padding: 6px 8px;">
          <div style="font-size: 10px; opacity: 0.85;">Prompty</div>
          <div style="font-size: 15px; font-weight: 700;">${summary.promptsUnique}/${summary.promptsAll}</div>
        </div>
        <div style="background: rgba(255,255,255,0.16); border-radius: 8px; padding: 6px 8px;">
          <div style="font-size: 10px; opacity: 0.85;">Odpowiedzi</div>
          <div style="font-size: 15px; font-weight: 700;">${summary.responsesUnique}/${summary.responsesAll}</div>
        </div>
        <div style="background: rgba(255,255,255,0.16); border-radius: 8px; padding: 6px 8px;">
          <div style="font-size: 10px; opacity: 0.85;">Duplikacje</div>
          <div style="font-size: 15px; font-weight: 700;">${summary.duplicateCount}</div>
        </div>
      </div>
      <div style="font-size: 19px; margin-bottom: 5px;">${progressText}</div>
      <div style="background: rgba(255,255,255,0.3); height: 6px; border-radius: 3px; margin-bottom: 5px;">
        <div style="background: white; height: 100%; border-radius: 3px; width: ${summary.progressPct}%; transition: width 0.25s;"></div>
      </div>
      <div style="font-size: 10px; opacity: 0.88; margin-bottom: 2px;">
        DUP_P=${summary.duplicatePrompts} | DUP_R=${summary.duplicateResponses}
      </div>
      <div style="font-size: 12px; opacity: 0.95;">${safeStatus}</div>
    `;
  }

  // Funkcja usuwajaca licznik
  function removeCounter(counter, success = true) {
    const activeCounter = (counter && counter.isConnected)
      ? counter
      : Array.from(document.querySelectorAll('#economist-prompt-counter')).pop();
    if (!activeCounter) return;

    const existingTimerId = Number.parseInt(activeCounter.dataset.economistCloseTimerId || '', 10);
    if (Number.isInteger(existingTimerId)) {
      clearTimeout(existingTimerId);
      delete activeCounter.dataset.economistCloseTimerId;
    }

    if (success) {
      const content = activeCounter.querySelector('#economist-counter-content');
      if (content) {
        content.innerHTML = `
          <div style="font-size: 18px;">Zakonczono!</div>
        `;
        content.style.display = 'block';
        content.style.padding = '8px 24px 16px 24px';
      }

      const header = activeCounter.firstElementChild;
      if (header && header.style) {
        header.style.borderBottom = '1px solid rgba(255,255,255,0.3)';
      }
      activeCounter.style.minWidth = '200px';
      activeCounter.style.cursor = 'default';

      const minimizeBtn = activeCounter.querySelector('#economist-counter-minimize');
      if (minimizeBtn) {
        minimizeBtn.textContent = '-';
      }
      localStorage.setItem('economist-counter-minimized', 'false');

      const currentPrompt = Number.parseInt(activeCounter.dataset.economistCurrent || '', 10);
      const totalPrompts = Number.parseInt(activeCounter.dataset.economistTotal || '', 10);
      setCounterMiniStage(
        activeCounter,
        Number.isInteger(currentPrompt) ? currentPrompt : 0,
        Number.isInteger(totalPrompts) ? totalPrompts : 0,
        'success'
      );
      activeCounter.dataset.economistMiniTone = 'success';
    } else {
      activeCounter.remove();
    }
  }

  // Edit+Send jest celowo wyłączony; recovery działa przez ponowne wysłanie promptu.
  async function tryEditResend() {
    console.warn('[tryEditResend] Disabled: workflow uses prompt resend only.');
    return false;
  }

  // Funkcja sprawdzajaca czy ChatGPT generuje odpowiedz (rozszerzona detekcja)
  function isGenerating() {
    // 1. Stop button (klasyczne selektory)
    const stopButton = document.querySelector('button[aria-label*="Stop"]') || 
                       document.querySelector('[data-testid="stop-button"]') ||
                       document.querySelector('button[aria-label*="stop"]') ||
                       document.querySelector('button[aria-label="Zatrzymaj"]') ||
                       document.querySelector('button[aria-label*="Zatrzymaj"]');
    if (stopButton) {
      return { generating: true, reason: 'stopButton', element: stopButton };
    }
    
    // 2. Thinking indicators - TYLKO w ostatniej wiadomości assistant!
    // Znajdź ostatnią wiadomość assistant
    const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (assistantMessages.length > 0) {
      const lastAssistantMsg = assistantMessages[assistantMessages.length - 1];
      
      // Sprawdź thinking indicator TYLKO w ostatniej wiadomości
      const thinkingInLastMsg = lastAssistantMsg.querySelector('[class*="thinking"]') ||
                                lastAssistantMsg.querySelector('[class*="Thinking"]') ||
                                lastAssistantMsg.querySelector('[data-testid*="thinking"]') ||
                                lastAssistantMsg.querySelector('[aria-label*="Thinking"]') ||
                                lastAssistantMsg.querySelector('[aria-label*="thinking"]');
      if (thinkingInLastMsg) {
        return { generating: true, reason: 'thinkingIndicator', element: thinkingInLastMsg };
      }
    }
    
    // 3. Update indicators
    const updateIndicators = document.querySelector('[aria-label*="Update"]') ||
                            document.querySelector('[aria-label*="update"]') ||
                            document.querySelector('[class*="updating"]') ||
                            document.querySelector('[class*="Updating"]') ||
                            document.querySelector('[data-testid*="update"]');
    if (updateIndicators) {
      return { generating: true, reason: 'updateIndicator', element: updateIndicators };
    }
    
    // 4. Streaming indicators
    const streamingIndicators = document.querySelector('[class*="streaming"]') ||
                               document.querySelector('[class*="Streaming"]') ||
                               document.querySelector('[data-testid*="streaming"]') ||
                               document.querySelector('[aria-label*="Streaming"]');
    if (streamingIndicators) {
      return { generating: true, reason: 'streamingIndicator', element: streamingIndicators };
    }
    
    // 5. Typing/Loading indicators
    const typingIndicators = document.querySelector('[class*="typing"]') ||
                            document.querySelector('[class*="Typing"]') ||
                            document.querySelector('[class*="loading"]') ||
                            document.querySelector('[class*="Loading"]') ||
                            document.querySelector('[aria-label*="typing"]') ||
                            document.querySelector('[aria-label*="loading"]');
    if (typingIndicators) {
      return { generating: true, reason: 'typingIndicator', element: typingIndicators };
    }
    
    // 6. Editor disabled (fallback - mniej pewny)
    const editor = document.querySelector('[role="textbox"]') ||
                  document.querySelector('[contenteditable]');
    const editorDisabled = editor && editor.getAttribute('contenteditable') === 'false';
    if (editorDisabled) {
      return { generating: true, reason: 'editorDisabled', element: editor };
    }
    
    return { generating: false, reason: 'none', element: null };
  }
  
  // Funkcja czekająca na zakończenie odpowiedzi ChatGPT
  // Snapshot ostatniej odpowiedzi assistant

  async function waitForResponse(maxWaitMs) {
    if (shouldStopNow()) return false;
    const initialSnapshot = getAssistantSnapshot();
    const initialAssistantCount = initialSnapshot.count;
    const initialAssistantText = initialSnapshot.lastText || '';
    const initialAssistantLength = initialAssistantText.length;
    const MIN_RESPONSE_DELTA = 30;
    let responseSeenInDOM = false;
    console.log('Czekam na odpowiedz ChatGPT...');

    // Faza 1: wykryj start odpowiedzi.
    const phase1StartTime = Date.now();
    const startTimeout = Math.min(maxWaitMs, 7200000);
    let responseStarted = false;

    while (Date.now() - phase1StartTime < startTimeout) {
      if (shouldStopNow()) return false;
      if (hasHardGenerationErrorMessage()) {
        console.error('[FAZA 1] Wykryto hard error na ostatnim turnie.');
        return false;
      }

      const genStatus = isGenerating();
      const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
      const hasNewContent = assistantMessages.length > initialAssistantCount;
      const lastAssistantMsg = assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1] : null;
      const lastAssistantText = lastAssistantMsg ? compactText(lastAssistantMsg.innerText || lastAssistantMsg.textContent || '') : '';
      const lastTextChanged = lastAssistantText && lastAssistantText !== initialAssistantText;
      const lengthDelta = Math.abs(lastAssistantText.length - initialAssistantLength);
      const meaningfulTextChange = lastTextChanged && lengthDelta >= MIN_RESPONSE_DELTA;

      if (hasNewContent || meaningfulTextChange) {
        responseSeenInDOM = true;
      }

      if (genStatus.generating || hasNewContent || meaningfulTextChange) {
        responseStarted = true;
        break;
      }

      if ((Date.now() - phase1StartTime) % 30000 < 500) {
        const elapsed = Math.round((Date.now() - phase1StartTime) / 1000);
        console.log(`[FAZA 1] Czekam na start odpowiedzi... (${elapsed}s)`);
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    if (!responseStarted) {
      console.error(`[FAZA 1] Timeout startu odpowiedzi po ${Math.round(startTimeout / 1000)}s.`);
      return false;
    }

    // Faza 2: wykryj stabilne zakonczenie odpowiedzi.
    const phase2StartTime = Date.now();
    const phase2Timeout = Math.min(maxWaitMs, 7200000);
    let consecutiveReady = 0;
    let logInterval = 0;
    let lastAssistantText = initialAssistantText;
    let lastAssistantChangeAt = Date.now();

    while (Date.now() - phase2StartTime < phase2Timeout) {
      if (shouldStopNow()) return false;
      if (hasHardGenerationErrorMessage()) {
        console.error('[FAZA 2] Wykryto hard error na ostatnim turnie.');
        return false;
      }

      const editor = document.querySelector('[role="textbox"][contenteditable="true"]') ||
                     document.querySelector('div[contenteditable="true"]') ||
                     document.querySelector('[data-testid="composer-input"][contenteditable="true"]');

      const sendButton = document.querySelector('[data-testid="send-button"]') ||
                        document.querySelector('#composer-submit-button') ||
                        document.querySelector('button[aria-label="Send"]') ||
                        document.querySelector('button[aria-label*="Send"]');

      const genStatus = isGenerating();

      if (logInterval % 10 === 0) {
        const phase2Elapsed = Math.round((Date.now() - phase2StartTime) / 1000);
        console.log('[FAZA 2] Stan interfejsu:', {
          editor_exists: !!editor,
          editor_enabled: editor?.getAttribute('contenteditable') === 'true',
          generating: genStatus.generating,
          genReason: genStatus.reason,
          sendButton_exists: !!sendButton,
          sendButton_disabled: sendButton?.disabled,
          consecutiveReady,
          elapsed: `${phase2Elapsed}s`
        });
      }
      logInterval += 1;

      const editorReady = editor && editor.getAttribute('contenteditable') === 'true';
      const noGeneration = !genStatus.generating;

      const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
      const lastAssistantMsg = assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1] : null;
      const currentLastText = lastAssistantMsg ? compactText(lastAssistantMsg.innerText || lastAssistantMsg.textContent || '') : '';
      if (currentLastText && currentLastText !== lastAssistantText) {
        lastAssistantText = currentLastText;
        lastAssistantChangeAt = Date.now();
      }

      const hasNewAssistantMessage = assistantMessages.length > initialAssistantCount;
      const phase2TextChanged = currentLastText && currentLastText !== initialAssistantText;
      const phase2LengthDelta = Math.abs(currentLastText.length - initialAssistantLength);
      const meaningfulTextChange = phase2TextChanged && phase2LengthDelta >= MIN_RESPONSE_DELTA;
      if (hasNewAssistantMessage || meaningfulTextChange) {
        responseSeenInDOM = true;
      }

      const textStable = Date.now() - lastAssistantChangeAt >= 2500;
      const hasThinkingInMessage = !!(lastAssistantMsg && lastAssistantMsg.querySelector('[class*="thinking"]'));
      const progressText = (currentLastText || '').toLowerCase();
      const hasProgressText = progressText.includes('research in progress') ||
        progressText.includes('deep research') ||
        progressText.includes('researching') ||
        progressText.includes('searching the web') ||
        progressText.includes('searching for') ||
        progressText.includes('gathering sources') ||
        progressText.includes('collecting sources') ||
        progressText.includes('checking sources') ||
        progressText.includes('looking up');
      const minResponseLengthReached = currentLastText.length >= 50;

      const isReady = noGeneration && editorReady && !hasThinkingInMessage && responseSeenInDOM && textStable && minResponseLengthReached && !hasProgressText;

      if (isReady) {
        consecutiveReady += 1;
        if (consecutiveReady >= 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000));

          const domMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
          const domArticles = document.querySelectorAll('article');
          if (domMessages.length > 0 || domArticles.length > 0) {
            return true;
          }

          console.warn('[FAZA 2] DOM odpowiedzi nie jest jeszcze stabilny, ale kontynuuje.');
          return true;
        }
      } else {
        consecutiveReady = 0;
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const phase2Duration = Math.round((Date.now() - phase2StartTime) / 1000);
    console.error(`[FAZA 2] Timeout zakonczenia odpowiedzi po ${phase2Duration}s.`);
    return false;
  }

  // Funkcja sprawdzajaca czy ChatGPT dziala (brak bledow polaczenia)
  async function checkChatGPTConnection() {
    console.log("🔍 Sprawdzam połączenie z ChatGPT...");
    
    try {
      // Sprawdź czy są błędy w konsoli (HTTP2, 404, itp.)
      const hasConnectionErrors = await checkForConnectionErrors();
      if (hasConnectionErrors) {
        return { healthy: false, error: "Wykryto błędy połączenia w konsoli" };
      }
      
      // Sprawdź czy interfejs ChatGPT jest responsywny
      const editor = document.querySelector('[role="textbox"]') || 
                   document.querySelector('[contenteditable]');
      if (!editor) {
        return { healthy: false, error: "Nie znaleziono edytora ChatGPT" };
      }
      
      // Sprawdź czy nie ma komunikatów o błędach na stronie
      // Używamy bardziej precyzyjnych selektorów dla rzeczywistych błędów ChatGPT
      const errorSelectors = [
        '[class*="error"]',
        '[class*="alert"]',
        '[role="alert"]',
        '.text-red-500',
        '.text-red-600'
      ];
      
      for (const selector of errorSelectors) {
        const errorElements = document.querySelectorAll(selector);
        for (const elem of errorElements) {
          const text = elem.textContent.toLowerCase();
          // Sprawdź tylko elementy zawierające znane frazy błędów
          if (text.includes('something went wrong') || 
              text.includes('connection error') ||
              text.includes('network error') ||
              text.includes('server error') ||
              text.includes('unable to load') ||
              text.includes('failed to')) {
            return { healthy: false, error: `Błąd na stronie: ${text.substring(0, 100)}` };
          }
        }
      }
      
      return { healthy: true, error: null };
      
    } catch (error) {
      console.warn("⚠️ Błąd podczas sprawdzania połączenia:", error);
      return { healthy: false, error: `Błąd sprawdzania: ${error.message}` };
    }
  }
  
  // Funkcja sprawdzająca błędy połączenia w konsoli
  async function checkForConnectionErrors() {
    // Sprawdź czy są aktywne błędy połączenia
    // (Ta funkcja może być rozszerzona o bardziej zaawansowaną detekcję)
    return false; // Na razie zwracamy false - można dodać bardziej zaawansowaną logikę
  }

  // Funkcja wyciągająca ostatnią odpowiedź ChatGPT z DOM
  async function getLastResponseText() {
    console.log("🔍 Wyciągam ostatnią odpowiedź ChatGPT...");
    
    // Funkcja pomocnicza - wyciąga tylko treść głównej odpowiedzi, pomija źródła/linki
    function extractMainContent(element) {
      // Klonuj element aby nie modyfikować oryginału
      const clone = element.cloneNode(true);
      
      // Usuń elementy które zawierają źródła/linki (zazwyczaj na końcu)
      const toRemove = [
        'ol[data-block-id]',  // Lista źródeł
        'div[class*="citation"]',  // Cytowania
        'div[class*="source"]',  // Źródła
        'a[target="_blank"]',  // Zewnętrzne linki
        'button',  // Przyciski
        '[role="button"]'  // Role przyciski
      ];
      
      toRemove.forEach(selector => {
        clone.querySelectorAll(selector).forEach(el => el.remove());
      });
      
      // Wyciągnij tekst - użyj innerText aby zachować formatowanie (nowe linie)
      const text = clone.innerText || clone.textContent || '';

      // Oczyść z nadmiarowych spacji, ale zachowaj formatowanie
      // POPRAWKA: Nie kolapsuj CAŁEJ spacji - tylko trim края linii
      return text
        .split('\n')
        .map(line => line.trim())  // Tylko trim краї - zachowuj wewnętrzne spacje
        .join('\n')
        .replace(/\n{3,}/g, '\n\n') // Max 2 puste linie z rzędu
        .trim();
    }
    
    // RETRY LOOP - React może asynchronicznie renderować treść
    // Nawet jeśli interface jest gotowy, treść może jeszcze być w trakcie renderowania
    // POPRAWKA: Zwiększono z 15 prób × 300ms (4.5s) do 20 prób × 500ms (10s)
    // Powód: ChatGPT React rendering może być wolny dla długich odpowiedzi
    const maxRetries = 20; // Zwiększono z 15 do 20
    const retryDelay = 500; // Zwiększono z 300ms do 500ms (total: 10s max)
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        console.log(`🔄 Retry ${attempt}/${maxRetries - 1} - czekam ${retryDelay}ms na renderowanie treści...`);
        await new Promise(r => setTimeout(r, retryDelay));
      }
      
      // Szukaj wszystkich odpowiedzi ChatGPT w konwersacji
      // POPRAWKA: Dodano diagnostykę selektorów dla lepszego debugowania
      const messages = document.querySelectorAll('[data-message-author-role="assistant"]');
      console.log(`🔍 Znaleziono ${messages.length} wiadomości assistant w DOM (selektor: [data-message-author-role="assistant"])`);

      // Diagnostyka: sprawdź inne możliwe selektory jeśli primary nie zadziałał
      if (messages.length === 0 && attempt === 0) {
        console.warn(`⚠️ Primary selector nie znalazł wiadomości - diagnostyka:`);
        const altSelectors = [
          '[role="presentation"]',
          '.agent-turn',
          '.markdown',
          '[data-testid*="conversation"]',
          'article',
          '[data-testid^="conversation-turn-"]',
          'div[class*="markdown"]',
          'div[class*="message"]'
        ];
        for (const sel of altSelectors) {
          const count = document.querySelectorAll(sel).length;
          console.log(`   ${sel}: ${count} elementów`);
        }
        
        // Dodatkowa diagnostyka - sprawdź czy w ogóle są jakieś wiadomości
        const allDivs = document.querySelectorAll('div');
        console.log(`   Wszystkie divy: ${allDivs.length}`);
        
        // Sprawdź czy są elementy z tekstem
        const textElements = Array.from(allDivs).filter(div => 
          div.textContent && div.textContent.trim().length > 10 && 
          !div.querySelector('[data-message-author-role]') // Nie licząc już znalezionych
        );
        console.log(`   Divy z tekstem (bez data-message-author-role): ${textElements.length}`);
        
        if (textElements.length > 0) {
          console.log(`   Przykłady tekstu:`, textElements.slice(0, 3).map(el => ({
            text: el.textContent.substring(0, 100),
            classes: el.className,
            id: el.id
          })));
        }
      }
      
      if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        
        // Sprawdź czy to nie jest tylko thinking indicator
        const thinkingIndicators = lastMessage.querySelectorAll('[class*="thinking"]');
        if (thinkingIndicators.length > 0) {
          console.warn("⚠️ Ostatnia wiadomość zawiera thinking indicator - ChatGPT jeszcze nie zaczął odpowiedzi");
          console.log(`   Thinking indicators: ${thinkingIndicators.length}`);
          // Kontynuuj retry - może treść się pojawi
          continue;
        }
        
        const text = extractMainContent(lastMessage);
        
        // Jeśli znaleziono niepustą odpowiedź - sukces!
        if (text.length > 0) {
          // Oblicz szczegółowe statystyki odpowiedzi
          const textSize = text.length;
          const textSizeKB = (textSize / 1024).toFixed(2);
          const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
          const lineCount = text.split('\n').length;
          const isLarge = textSize > 10000; // >10KB
          const isVeryLarge = textSize > 50000; // >50KB
          
          console.log(`✅ Znaleziono odpowiedź (attempt ${attempt + 1}/${maxRetries})`);
          console.log(`📊 Rozmiar odpowiedzi:`, {
            characters: textSize,
            sizeKB: textSizeKB,
            words: wordCount,
            lines: lineCount,
            isLarge: isLarge,
            isVeryLarge: isVeryLarge
          });
          
          console.log(`📝 Preview (pierwsze 200 znaków): "${text.substring(0, 200)}${text.length > 200 ? '...' : ''}"`);
          console.log(`📝 Preview (ostatnie 200 znaków): "...${text.substring(Math.max(0, text.length - 200))}"`);
          
          // Weryfikacja kompletności
          if (textSize < 50) {
            console.warn('⚠️ UWAGA: Odpowiedź bardzo krótka (<50 znaków) - może być niepełna lub błędna');
          }
          if (textSize < 10) {
            console.warn('❌ KRYTYCZNE: Odpowiedź ekstremalnie krótka (<10 znaków) - prawdopodobnie błąd');
          }
          
          return text;
        }
        
        // Jeśli pusta - loguj i kontynuuj retry (chyba że ostatnia próba)
        if (attempt < maxRetries - 1) {
          console.warn(`⚠️ Wyekstrahowany tekst ma długość 0 (attempt ${attempt + 1}/${maxRetries}) - retry...`);
        } else {
          // Ostatnia próba - pełne logowanie
          console.warn("⚠️ Wyekstrahowany tekst ma długość 0 po wszystkich próbach!");
          console.log("   HTML preview:", lastMessage.innerHTML.substring(0, 300));
          console.log("   textContent:", lastMessage.textContent.substring(0, 300));
          console.log("   Liczba children:", lastMessage.children.length);
          console.log("   Klasy:", lastMessage.className);
        }
      } else if (attempt === maxRetries - 1) {
        // Ostatnia próba i nadal brak wiadomości - pełne logowanie
        console.warn(`⚠️ Brak wiadomości assistant w DOM po ${maxRetries} próbach`);
      }
    }
    
    // Fallback 2: szukaj przez conversation-turn containers (z retry)
    console.log("🔍 Fallback 2: Szukam przez conversation-turn containers...");
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        console.log(`🔄 Fallback 2 retry ${attempt}/4 - czekam 300ms...`);
        await new Promise(r => setTimeout(r, 300));
      }
      
      const turnContainers = document.querySelectorAll('[data-testid^="conversation-turn-"]');
      console.log(`🔍 Znaleziono ${turnContainers.length} conversation turns w DOM (fallback 2)`);
      
      if (turnContainers.length > 0) {
        // Szukaj ostatniego turnu z assistant
        for (let i = turnContainers.length - 1; i >= 0; i--) {
          const turn = turnContainers[i];
          const assistantMsg = turn.querySelector('[data-message-author-role="assistant"]');
          if (assistantMsg) {
            const text = extractMainContent(assistantMsg);
            if (text.length > 0) {
              console.log(`✅ Znaleziono odpowiedź przez conversation-turn (fallback 2): ${text.length} znaków`);
              console.log(`📝 Preview: "${text.substring(0, 200)}${text.length > 200 ? '...' : ''}"`);
              return text;
            }
          }
        }
        
        // Jeśli nie znaleziono przez data-message-author-role, spróbuj znaleźć ostatni turn z tekstem
        console.log("🔍 Fallback 2b: Szukam ostatniego turnu z tekstem...");
        for (let i = turnContainers.length - 1; i >= 0; i--) {
          const turn = turnContainers[i];
          const text = extractMainContent(turn);
          if (text.length > 50) { // Minimum 50 znaków
            console.log(`✅ Znaleziono odpowiedź przez conversation-turn (fallback 2b): ${text.length} znaków`);
            console.log(`📝 Preview: "${text.substring(0, 200)}${text.length > 200 ? '...' : ''}"`);
            return text;
          }
        }
      }
    }
    
    // Fallback 3: szukaj artykułów z odpowiedziami (z retry)
    console.log("🔍 Fallback 3: Szukam przez article tags...");
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        console.log(`🔄 Fallback 3 retry ${attempt}/4 - czekam 300ms...`);
        await new Promise(r => setTimeout(r, 300));
      }
      
      const articles = document.querySelectorAll('article');
      console.log(`🔍 Znaleziono ${articles.length} articles w DOM (fallback 3)`);
      
      if (articles.length > 0) {
        const lastArticle = articles[articles.length - 1];
        const text = extractMainContent(lastArticle);
        if (text.length > 0) {
          console.log(`✅ Znaleziono odpowiedź przez article (fallback 3): ${text.length} znaków`);
          console.log(`📝 Preview: "${text.substring(0, 200)}${text.length > 200 ? '...' : ''}"`);
          return text;
        }
      }
    }
    
    // Fallback 4: szukaj po klasach markdown (z retry)
    console.log("🔍 Fallback 4: Szukam przez klasy markdown...");
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        console.log(`🔄 Fallback 4 retry ${attempt}/4 - czekam 300ms...`);
        await new Promise(r => setTimeout(r, 300));
      }
      
      const markdownSelectors = [
        'div[class*="markdown"]',
        'div[class*="message"]',
        'div[class*="content"]',
        'div[class*="response"]'
      ];
      
      for (const selector of markdownSelectors) {
        const elements = document.querySelectorAll(selector);
        console.log(`🔍 Znaleziono ${elements.length} elementów (${selector})`);
        
        if (elements.length > 0) {
          // Weź ostatni element
          const lastElement = elements[elements.length - 1];
          const text = extractMainContent(lastElement);
          if (text.length > 50) { // Minimum 50 znaków
            console.log(`✅ Znaleziono odpowiedź przez ${selector} (fallback 4): ${text.length} znaków`);
            console.log(`📝 Preview: "${text.substring(0, 200)}${text.length > 200 ? '...' : ''}"`);
            return text;
          }
        }
      }
    }
    
    console.error("❌ Nie znaleziono odpowiedzi ChatGPT w DOM po wszystkich próbach");
    console.log("   Wszystkie selektory (z retry) zwróciły puste wyniki");
    return '';
  }
  
  // Funkcja walidująca odpowiedź
  // POPRAWKA: Zwiększono minimalną długość z 10 do 50 znaków i dodano sprawdzanie błędów
  function validateResponse(text) {
    const minLength = 50; // Zwiększono z 10 do 50

    // Podstawowa walidacja długości
    if (text.length < minLength) {
      console.log(`📊 Walidacja: ❌ ZA KRÓTKA (${text.length} < ${minLength} znaków)`);
      return false;
    }

    // Twarde wzorce błędów - odpowiedź uznajemy za niepoprawną.
    const hardErrorPatterns = [
      /something went wrong/i,
      /an error occurred/i,
      /internal server error/i,
      /network error/i,
      /try again (later|in a few)/i,
      /unable to.*(complete|process|generate)/i,
      /conversation not found/i,
      /at capacity/i
    ];

    const head = text.substring(0, 400);
    for (const pattern of hardErrorPatterns) {
      if (pattern.test(head)) {
        console.warn(`📊 Walidacja: ❌ Wykryto błąd generacji (${pattern})`);
        console.warn(`   Początek tekstu: "${head.substring(0, 120)}..."`);
        return false;
      }
    }

    // Miękkie wzorce ostrzegawcze (nie odrzucamy automatycznie).
    const softWarningPatterns = [
      /I apologize.*error/i,
      /something went wrong/i,
      /please try again/i,
      /I cannot.*at the moment/i,
      /unable to.*right now/i
    ];

    for (const pattern of softWarningPatterns) {
      if (pattern.test(head)) {
        console.warn(`📊 Walidacja: ⚠️ Wykryto wzorzec błędu: ${pattern}`);
        console.warn(`   Początek tekstu: "${head.substring(0, 120)}..."`);
      }
    }

    console.log(`📊 Walidacja: ✅ OK (${text.length} >= ${minLength} znaków)`);
    return true;
  }
  
  // Funkcja czekająca aż interface ChatGPT będzie gotowy do wysłania kolejnego prompta
  async function waitForInterfaceReady(maxWaitMs, counter = null, promptIndex = 0, promptTotal = 0) {
    if (shouldStopNow()) return false;
    const startTime = Date.now();
    let consecutiveReady = 0;
    
    console.log("⏳ Czekam aż interface będzie gotowy...");
    
    // POPRAWKA: Sprawdź czy to jest nowa konwersacja (brak wiadomości)
    const userMessages = document.querySelectorAll('[data-message-author-role="user"]');
    const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
    const isNewConversation = userMessages.length === 0 && assistantMessages.length === 0;
    
    if (isNewConversation) {
      console.log("✅ Nowa konwersacja - pomijam czekanie na gotowość (nie powinno być generowania)");
      // Sprawdź tylko czy editor istnieje i jest enabled
      const editor = document.querySelector('[role="textbox"][contenteditable="true"]') ||
                     document.querySelector('div[contenteditable="true"]');
      if (editor) {
        console.log("✅ Editor gotowy - kontynuuję natychmiast");
        return true;
      } else {
        console.log("⏳ Editor nie istnieje - czekam max 5s...");
        maxWaitMs = 5000; // Krótki timeout tylko na pojawienie się editora
      }
    } else {
      console.log(`📊 Kontynuacja konwersacji (${userMessages.length} user, ${assistantMessages.length} assistant) - pełny timeout`);
    }
    
    // POPRAWKA: Sprawdź czy karta jest aktywna (rozwiązuje problem z wyciszonymi kartami)
    if (document.hidden || document.visibilityState === 'hidden') {
      console.warn("⚠️ Karta jest nieaktywna - próbuję aktywować...");
      try {
        chrome.runtime.sendMessage({ type: 'ACTIVATE_TAB' });
        // Czekaj chwilę na aktywację
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.warn("⚠️ Nie udało się aktywować karty:", error);
      }
    }
    
    // Mapowanie powodów na przyjazne opisy po polsku
    let lastAssistantText = '';
    let lastAssistantChangeAt = Date.now();
    const initialAssistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (initialAssistantMessages.length > 0) {
      const lastMsg = initialAssistantMessages[initialAssistantMessages.length - 1];
      lastAssistantText = compactText(lastMsg.innerText || lastMsg.textContent || '');
    }
    const reasonDescriptions = {
      'stopButton': 'generuje odpowiedź',
      'thinkingIndicator': 'myśli (chain-of-thought)',
      'updateIndicator': 'aktualizuje odpowiedź',
      'streamingIndicator': 'streamuje odpowiedź',
      'typingIndicator': 'pisze odpowiedź',
      'editorDisabled': 'interface zablokowany',
      'none': 'gotowy'
    };
    
    while (Date.now() - startTime < maxWaitMs) {
      if (shouldStopNow()) return false;
      // Sprawdź wszystkie elementy interfejsu
      const editor = document.querySelector('[role="textbox"][contenteditable="true"]') ||
                     document.querySelector('div[contenteditable="true"]');
      
      // POPRAWKA: Użyj isGenerating() zamiast tylko sprawdzania stopButton
      const genStatus = isGenerating();
      
      // Interface jest gotowy gdy:
      // 1. BRAK wskaźników generowania (isGenerating() == false)
      // 2. Editor ISTNIEJE i jest ENABLED
      const editorReady = editor && editor.getAttribute('contenteditable') === 'true';
      const noGeneration = !genStatus.generating;
      const lastMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
      const lastAssistantMsg = lastMessages.length > 0 ? lastMessages[lastMessages.length - 1] : null;
      const currentLastText = lastAssistantMsg ? compactText(lastAssistantMsg.innerText || lastAssistantMsg.textContent || '') : '';
      if (currentLastText && currentLastText !== lastAssistantText) {
        lastAssistantText = currentLastText;
        lastAssistantChangeAt = Date.now();
      }
      const progressText = (currentLastText || '').toLowerCase();
      const hasProgressText = progressText.includes('research in progress') ||
        progressText.includes('deep research') ||
        progressText.includes('researching') ||
        progressText.includes('searching the web') ||
        progressText.includes('searching for') ||
        progressText.includes('gathering sources') ||
        progressText.includes('collecting sources') ||
        progressText.includes('checking sources') ||
        progressText.includes('looking up');
      const textStable = Date.now() - lastAssistantChangeAt >= 2500;
      const minResponseLengthReached = currentLastText.length >= 50;
      const isReady = noGeneration && editorReady && textStable && minResponseLengthReached && !hasProgressText;
      
      if (isReady) {
        consecutiveReady++;
        if (consecutiveReady >= 2) { // Potwierdź przez 2 sprawdzenia (1s)
          console.log("✅ Interface gotowy");
          await new Promise(resolve => setTimeout(resolve, 500)); // Krótka stabilizacja
          return true;
        }
      } else {
        // Resetowanie licznika - loguj powód
        if (consecutiveReady > 0) {
          const reason = reasonDescriptions[genStatus.reason] || genStatus.reason;
          console.log(`🔄 Interface nie gotowy - reset licznika. Powód: ${reason}`);
        }
        consecutiveReady = 0;
        
        // Aktualizuj licznik wizualny z powodem czekania
        if (counter) {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          const reason = reasonDescriptions[genStatus.reason] || genStatus.reason;
          const statusText = `⏳ Czekam na gotowość... (${elapsed}s)\nChatGPT: ${reason}`;
          updateCounter(counter, promptIndex, promptTotal, statusText);
        }
      }
      
      // Loguj szczegółowy status co 5s
      if ((Date.now() - startTime) % 5000 < 500) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const reason = reasonDescriptions[genStatus.reason] || genStatus.reason;
        console.log(`⏳ Interface nie gotowy (${elapsed}s)`, {
          generating: genStatus.generating,
          reason: genStatus.reason,
          reasonDesc: reason,
          editorReady: editorReady,
          textStable: textStable,
          minResponseLengthReached: minResponseLengthReached,
          hasProgressText: hasProgressText,
          consecutiveReady: consecutiveReady
        });
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.error(`❌ Timeout czekania na gotowość interfejsu (${maxWaitMs}ms)`);
    return false;
  }
  
  // Funkcja pokazująca przyciski "Kontynuuj" i czekająca na kliknięcie
  // Zwraca: 'wait' - czekaj na odpowiedź, 'skip' - pomiń i wyślij następny prompt
  function showContinueButton(counter, currentPrompt, totalPrompts, reason = 'needs_action') {
    return new Promise((resolve) => {
      console.log(`⏸️ Pokazuję przyciski Kontynuuj dla prompta ${currentPrompt}/${totalPrompts}`);
      notifyProcess('PROCESS_NEEDS_ACTION', {
        status: 'running',
        needsAction: true,
        currentPrompt,
        totalPrompts,
        reason,
        statusText: 'Wymaga decyzji'
      });

      let content = counter ? counter.querySelector('#economist-counter-content') : null;
      if (!content) {
        content = document.getElementById('economist-counter-content');
      }
      if (!content && counter) {
        console.warn('⚠️ Brak #economist-counter-content - odtwarzam kontener');
        content = document.createElement('div');
        content.id = 'economist-counter-content';
        counter.appendChild(content);
      }

      if (!content) {
        console.error('❌ Nie mogę pokazać przycisków kontynuacji - brak kontenera licznika');
        notifyProcess('PROCESS_ACTION_RESOLVED', {
          currentPrompt,
          totalPrompts,
          decision: 'wait',
          origin: 'fallback',
          needsAction: false
        });
        resolve('wait');
        return;
      }

      // Wymuś rozwinięcie panelu, aby przyciski były widoczne i licznik mógł wrócić po kliknięciu.
      content.style.display = 'block';
      content.style.padding = '8px 24px 16px 24px';
      localStorage.setItem('economist-counter-minimized', 'false');
      if (counter) {
        counter.style.minWidth = '220px';
        counter.style.cursor = 'default';
      }

      const header = counter && counter.firstElementChild;
      if (header && header.style) {
        header.style.borderBottom = '1px solid rgba(255,255,255,0.3)';
        const minimizeBtn = header.querySelector('button');
        if (minimizeBtn) {
          minimizeBtn.textContent = '−';
        }
      }

      content.innerHTML = `
        <div style="font-size: 16px; margin-bottom: 8px;">⚠️ Zatrzymano</div>
        <div style="font-size: 14px; margin-bottom: 12px;">Prompt ${currentPrompt} / ${totalPrompts}</div>
        <div style="font-size: 12px; opacity: 0.9; margin-bottom: 12px; line-height: 1.4;">
          Odpowiedź niepoprawna lub timeout.<br>
          Napraw sytuację w ChatGPT, potem wybierz:
        </div>
        <button id="continue-wait-btn" data-continue-action="wait" style="
          background: white;
          color: #667eea;
          border: none;
          padding: 10px 20px;
          border-radius: 8px;
          font-weight: 600;
          cursor: pointer;
          font-size: 14px;
          width: 100%;
          margin-bottom: 8px;
          transform: translateY(0) scale(1);
          transition: transform 0.18s ease, box-shadow 0.18s ease, opacity 0.18s ease;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
        ">⏳ Czekaj na odpowiedź</button>
        <button id="continue-skip-btn" data-continue-action="skip" style="
          background: rgba(255,255,255,0.3);
          color: white;
          border: 1px solid white;
          padding: 10px 20px;
          border-radius: 8px;
          font-weight: 600;
          cursor: pointer;
          font-size: 14px;
          width: 100%;
          transform: translateY(0) scale(1);
          transition: transform 0.18s ease, box-shadow 0.18s ease, opacity 0.18s ease;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        ">⏭️ Wyślij następny prompt</button>
      `;

      const waitBtn = content.querySelector('[data-continue-action="wait"]');
      const skipBtn = content.querySelector('[data-continue-action="skip"]');
      if (!waitBtn || !skipBtn) {
        console.error('❌ Nie udało się zbudować przycisków kontynuacji');
        notifyProcess('PROCESS_ACTION_RESOLVED', {
          currentPrompt,
          totalPrompts,
          decision: 'wait',
          origin: 'fallback',
          needsAction: false
        });
        resolve('wait');
        return;
      }

      const setHoverState = (button, active) => {
        button.style.transform = active ? 'translateY(-1px) scale(1.03)' : 'translateY(0) scale(1)';
        button.style.boxShadow = active
          ? '0 6px 16px rgba(0, 0, 0, 0.24)'
          : '0 2px 8px rgba(0, 0, 0, 0.15)';
      };

      const setPressedState = (button, pressed) => {
        button.style.transform = pressed ? 'translateY(0) scale(0.98)' : 'translateY(-1px) scale(1.03)';
      };

      let isResolved = false;
      let decisionListener = null;

      const cleanupDecisionListener = () => {
        if (decisionListener && chrome?.runtime?.onMessage?.removeListener) {
          try {
            chrome.runtime.onMessage.removeListener(decisionListener);
          } catch (error) {
            // Ignore listener cleanup issues.
          }
        }
      };

      const finish = (action, origin = 'local') => {
        if (isResolved) return;
        isResolved = true;
        cleanupDecisionListener();
        waitBtn.disabled = true;
        skipBtn.disabled = true;
        waitBtn.style.opacity = '0.7';
        skipBtn.style.opacity = '0.7';
        notifyProcess('PROCESS_ACTION_RESOLVED', {
          status: 'running',
          needsAction: false,
          currentPrompt,
          totalPrompts,
          decision: action,
          origin,
          statusText: action === 'skip' ? 'Pominieto czekanie' : 'Wznowiono czekanie'
        });
        resolve(action);
      };

      if (runId && chrome?.runtime?.onMessage?.addListener) {
        decisionListener = (message) => {
          if (!message || message.type !== 'PROCESS_DECISION') return;
          if (message.runId && message.runId !== runId) return;
          const forcedAction = message.decision === 'skip' ? 'skip' : 'wait';
          console.log(`✅ Otrzymano decyzję z panelu (${forcedAction}) dla runId=${runId}`);
          finish(forcedAction, message.origin || 'panel');
        };
        try {
          chrome.runtime.onMessage.addListener(decisionListener);
        } catch (error) {
          decisionListener = null;
        }
      }

      [waitBtn, skipBtn].forEach((button) => {
        button.addEventListener('mouseenter', () => setHoverState(button, true));
        button.addEventListener('mouseleave', () => setHoverState(button, false));
        button.addEventListener('mousedown', () => setPressedState(button, true));
        button.addEventListener('mouseup', () => setPressedState(button, false));
      });

      waitBtn.addEventListener('click', () => {
        console.log('✅ Użytkownik kliknął "Czekaj na odpowiedź" - wznawiam czekanie');
        finish('wait', 'local');
      });

      skipBtn.addEventListener('click', () => {
        console.log('✅ Użytkownik kliknął "Wyślij następny prompt" - pomijam czekanie');
        finish('skip', 'local');
      });
    });
  }

  // Funkcja wysyłania pojedynczego prompta
  async function sendPrompt(promptText, maxWaitForReady = interfaceReadyWaitMs, counter = null, promptIndex = 0, promptTotal = 0) {
    if (shouldStopNow()) return false;
    runMetrics.sendAttempts += 1;
    registerPromptAttempt(promptIndex);
    logSend('ATTEMPT', { promptIndex, promptTotal, chars: typeof promptText === 'string' ? promptText.length : 0 });
    // KROK 0: POPRAWKA - Aktywuj kartę przed wysyłaniem (rozwiązuje problem z wyciszonymi kartami)
    const maxRetries = 3;
    let retryCount = 0;
    
    while (retryCount < maxRetries) {
      if (shouldStopNow()) return false;
      try {
        console.log(`🔍 Aktywuję kartę ChatGPT przed wysyłaniem (próba ${retryCount + 1}/${maxRetries})...`);
        
        // Sprawdź czy karta jest aktywna - ale nie blokuj jeśli executeScript działa
        if (document.hidden || document.visibilityState === 'hidden') {
          console.warn("⚠️ Karta może być nieaktywna - ale kontynuuję (executeScript działa)");
          // Nie blokuj - executeScript już działa w kontekście aktywnej karty
        }
        
        console.log("✅ Karta jest aktywna - kontynuuję wysyłanie");
        break;
        
      } catch (error) {
        console.warn("⚠️ Błąd aktywacji karty:", error);
        retryCount++;
        if (retryCount < maxRetries) {
          console.warn(`⚠️ Próba ${retryCount + 1}/${maxRetries} za 2 sekundy...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          console.error("❌ Nie udało się aktywować karty po wszystkich próbach");
          return false;
        }
      }
    }
    
    // KROK 1: Czekaj aż interface będzie gotowy (jeśli poprzednia odpowiedź się jeszcze generuje)
    console.log("🔍 Sprawdzam gotowość interfejsu przed wysłaniem...");
    const interfaceReady = await waitForInterfaceReady(maxWaitForReady, counter, promptIndex, promptTotal);
    
    if (!interfaceReady) {
      console.error(`❌ Interface nie stał się gotowy po ${Math.round(maxWaitForReady/1000)}s`);
      return false;
    }
    
    console.log("✅ Interface gotowy - sprawdzam połączenie z ChatGPT");
    
    // KROK 1.5: Sprawdź czy ChatGPT działa (brak błędów połączenia)
    const connectionCheck = await checkChatGPTConnection();
    if (!connectionCheck.healthy) {
      console.error(`❌ ChatGPT nie działa: ${connectionCheck.error}`);
      return false;
    }
    console.log("✅ Połączenie z ChatGPT OK - wysyłam prompt");
    
    // KROK 2: Szukaj edytora
    console.log("🔍 Szukam edytora contenteditable...");
    
    // ChatGPT używa contenteditable div, NIE textarea!
    let editor = null;
    const maxWait = 15000; // Zwiększono z 10s na 15s
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWait) {
      if (shouldStopNow()) return false;
      editor = document.querySelector('textarea#prompt-textarea') ||
               document.querySelector('[role="textbox"][contenteditable="true"]') ||
               document.querySelector('div[contenteditable="true"]') ||
               document.querySelector('[data-testid="composer-input"]') ||
               document.querySelector('[contenteditable]');
      if (editor) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    if (!editor) {
      console.error("❌ Nie znaleziono edytora contenteditable po " + maxWait + "ms");
      return false;
    }
    
    console.log("✓ Znaleziono edytor");
    
    // Focus i wyczyść - ulepszona wersja
    editor.focus();
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Wyczyść zawartość - najpierw spróbuj nowoczesnym API
    try {
      // Metoda 1: Selection API (najbardziej niezawodna)
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      
      // Usuń przez KeyboardEvent (symuluje naturalne usuwanie)
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', bubbles: true }));
      document.execCommand('delete', false, null);
      
    } catch (e) {
      console.warn("⚠️ Fallback czyszczenia:", e);
    }
    
    // Wymuś czyszczenie przez innerHTML i textContent
    editor.innerHTML = '';
    editor.textContent = '';
    
    // Triggeruj event czyszczenia
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
    
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Wstaw tekst - ulepszona wersja z zachowaniem formatowania
    // Użyj innerHTML zamiast createTextNode aby zachować HTML i nowe linie
    editor.innerHTML = promptText.replace(/\n/g, '<br>');
    
    // Przesuń kursor na koniec
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (e) {
      console.warn("⚠️ Nie udało się przesunąć kursora:", e);
    }
    
    // Triggeruj więcej eventów dla pewności
    editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText' }));
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
    
    console.log(`✓ Tekst wstawiony (${promptText.length} znaków): "${promptText.substring(0, 50)}..."`);
    
    // Czekaj aż przycisk Send będzie enabled - zwiększony timeout
    let submitButton = null;
    let waitTime = 0;
    const maxButtonWait = 10000; // Zwiększono z 3s na 10s
    
    while (waitTime < maxButtonWait) {
      if (shouldStopNow()) return false;
      submitButton = document.querySelector('[data-testid="send-button"]') ||
                     document.querySelector('#composer-submit-button') ||
                     document.querySelector('button[aria-label="Send"]') ||
                     document.querySelector('button[aria-label*="Send"]') ||
                     document.querySelector('button[data-testid*="send"]');
      
      if (submitButton && !submitButton.disabled) {
        console.log(`✅ Przycisk Send gotowy (${waitTime}ms)`);
        break;
      }
      
      // Loguj co 2s
      if (waitTime > 0 && waitTime % 2000 === 0) {
        console.log(`⏳ Czekam na przycisk Send... (${waitTime}ms / ${maxButtonWait}ms)`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
      waitTime += 100;
    }
    
    if (!submitButton) {
      console.error("❌ Nie znaleziono przycisku Send po " + maxButtonWait + "ms");
      return false;
    }
    
    if (submitButton.disabled) {
      console.error("❌ Przycisk Send jest disabled po " + maxButtonWait + "ms");
      return false;
    }
    
    // Poczekaj dłużej przed kliknięciem - daj czas na stabilizację UI
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log("✓ Klikam Send...");
    submitButton.click();
    
    // WERYFIKACJA: Sprawdź czy kliknięcie zadziałało
    console.log("🔍 Weryfikuję czy prompt został wysłany...");
    let verified = false;
    let verifyTime = 0;
    const maxVerifyWait = 10000; // Zwiększono z 5s do 10s na weryfikację
    
    while (verifyTime < maxVerifyWait) {
      if (shouldStopNow()) return false;
      // Po wysłaniu prompta ChatGPT powinien:
      // 1. Pokazać stopButton (zacząć generować) - NAJBARDZIEJ PEWNY wskaźnik
      // 2. LUB wyczyścić/disabled editor + disabled sendButton + nowa wiadomość w DOM
      
      const editorNow = document.querySelector('[role="textbox"]') ||
                        document.querySelector('[contenteditable]');
      
      // Fallbacki dla stopButton z dokumentacji
      const stopBtn = document.querySelector('button[aria-label*="Stop"]') || 
                      document.querySelector('[data-testid="stop-button"]') ||
                      document.querySelector('button[aria-label*="stop"]') ||
                      document.querySelector('button[aria-label="Zatrzymaj"]') ||
                      document.querySelector('button[aria-label*="Zatrzymaj"]');
      
      const sendBtn = document.querySelector('[data-testid="send-button"]') ||
                      document.querySelector('#composer-submit-button') ||
                      document.querySelector('button[aria-label="Send"]') ||
                      document.querySelector('button[aria-label*="Send"]');
      
      const editorDisabled = editorNow && editorNow.getAttribute('contenteditable') === 'false';
      const editorEmpty = editorNow && (editorNow.textContent || '').trim().length === 0;
      const sendDisabled = sendBtn && sendBtn.disabled;
      
      // Weryfikacja: czy jest nowa aktywność w DOM?
      const userMessages = document.querySelectorAll('[data-message-author-role="user"]');
      const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
      const hasMessages = userMessages.length > 0 || assistantMessages.length > 0;
      
      // GŁÓWNY wskaźnik: stopButton (najbardziej pewny)
      const hasStopButton = !!stopBtn;
      
      // ALTERNATYWNY wskaźnik: interface zablokowany + są jakieś wiadomości w DOM
      const interfaceBlocked = (editorDisabled || (editorEmpty && sendDisabled)) && hasMessages;
      
      // NOWY wskaźnik: sprawdź czy nasza wiadomość pojawiła się w DOM
      let messageInDOM = false;
      if (userMessages.length > 0) {
        const lastUserMessage = userMessages[userMessages.length - 1];
        const messageText = lastUserMessage.textContent || lastUserMessage.innerText || '';
        // Sprawdź czy ostatnia wiadomość użytkownika zawiera fragment naszego prompta
        const promptFragment = promptText.substring(0, 50);
        if (messageText.includes(promptFragment)) {
          messageInDOM = true;
          console.log(`✅ Znaleziono naszą wiadomość w DOM (${messageText.length} znaków)`);
        }
      }
      
      // Jeśli którykolwiek z PEWNYCH wskaźników potwierdza wysłanie:
      if (hasStopButton || interfaceBlocked || messageInDOM) {
        console.log(`✅ Prompt faktycznie wysłany (${verifyTime}ms)`, {
          stopBtn: !!stopBtn,
          editorDisabled,
          editorEmpty,
          sendDisabled,
          userMsgCount: userMessages.length,
          assistantMsgCount: assistantMessages.length,
          messageInDOM
        });
        verified = true;
        break;
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
      verifyTime += 100;
    }
    
    if (!verified) {
      console.error(`❌ Kliknięcie Send nie zadziałało - prompt NIE został wysłany po ${maxVerifyWait}ms`);
      return false;
    }
    
    runMetrics.sendOkVerified += 1;
    sendOkPromptIndexes.add(promptIndex);
    logSend('VERIFIED_OK', { promptIndex, promptTotal });
    return true;
  }

  // Główna logika
  const startTime = Date.now();
  let stage0Response = '';
  notifyProcess('PROCESS_PROGRESS', {
    status: 'running',
    currentPrompt: promptOffset,
    totalPrompts: totalPromptsForRun,
    statusText: 'Inicjalizacja procesu',
    needsAction: false
  });
  
  // Retry loop - czekaj na editor (contenteditable div, nie textarea!)
  while (Date.now() - startTime < textareaWaitMs) {
    if (shouldStopNow()) {
      return forceStopResult();
    }
    const editor = document.querySelector('[role="textbox"]') ||
                   document.querySelector('[contenteditable]') ||
                   document.querySelector('[data-testid="composer-input"]');
    
    if (editor) {
      console.log("=== ROZPOCZYNAM PRZETWARZANIE ===");
      
      // POPRAWKA: Sprawdź czy to resume (payload jest pusty lub zawiera marker)
      const isResume = !payload || payload.trim() === '' || payload.includes('Resume from stage');
      
      if (isResume) {
        console.log("🔄 TRYB RESUME - pomijam wysyłanie payload, zaczynam od prompt chain");
      } else {
        console.log(`Artykuł: ${payload.substring(0, 100)}...`);
      }
      
      // Stwórz licznik
      const counter = createCounter();
      
      if (!isResume) {
        if (manualPdfAttachment?.enabled) {
          updateCounter(counter, promptOffset, totalPromptsForRun, 'Zalaczam PDF...');
          const attachResult = await attachManualPdfWithRetry(manualPdfAttachment);
          if (!attachResult.success) {
            return {
              success: false,
              lastResponse: '',
              error: 'pdf_attach_failed',
              metrics: buildMetricsSnapshot({
                completed: false,
                reason: 'pdf_attach_failed',
                pdfAttachError: attachResult.details || attachResult.error || ''
              })
            };
          }
        }

        updateCounter(counter, promptOffset, totalPromptsForRun, 'Wysylam artykul...');

        console.log('Wysylam artykul do ChatGPT...');
        await sendPrompt(payload, interfaceReadyWaitMs, counter, promptOffset, totalPromptsForRun);
        if (shouldStopNow()) {
          return forceStopResult();
        }

        updateCounter(counter, promptOffset, totalPromptsForRun, 'Czekam na odpowiedz...');
        await waitForResponse(responseWaitMs);
        if (shouldStopNow()) {
          return forceStopResult();
        }
        console.log('Artykul przetworzony');

        stage0Response = await getLastResponseText();
        const stage0PromptIndex = normalizePromptMetricIndex(promptOffset);
        const stage0Validated = validateResponse(stage0Response);
        registerStageCompletion(stage0PromptIndex, stage0Response, stage0Validated);
        if (stage0Response && stage0Response.trim().length > 0) {
          console.log(`Stage 0 captured (${stage0Response.length} znakow) - bedzie wstawione w prompt chain`);
        } else {
          console.warn('Nie udalo sie pobrac Stage 0 (pusty tekst) - prompt chain bez wstawienia');
          stage0Response = '';
        }

        const delay = getRandomDelay();
        console.log(`Anti-automation delay: ${(delay / 1000).toFixed(1)}s przed prompt chain...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        if (shouldStopNow()) {
          return forceStopResult();
        }
      } else {
        // Resume mode - zacznij od razu od prompt chain
        updateCounter(counter, promptOffset, totalPromptsForRun, '🔄 Resume from stage...');
        console.log("⏭️ Pomijam payload - zaczynam od prompt chain");
        
        // NOWE: Dodatkowe czekanie na gotowość interfejsu w trybie resume
        console.log("🔍 Sprawdzam gotowość interfejsu przed rozpoczęciem resume chain...");
        updateCounter(counter, promptOffset, totalPromptsForRun, '⏳ Sprawdzam gotowość...');
        
        const resumeInterfaceReady = await waitForInterfaceReady(interfaceReadyWaitMs, counter, promptOffset, totalPromptsForRun);
        if (shouldStopNow()) {
          return forceStopResult();
        }
        
        if (!resumeInterfaceReady) {
          console.error("❌ Interface nie jest gotowy w trybie resume - przerywam");
          updateCounter(counter, promptOffset, totalPromptsForRun, '❌ Interface nie gotowy');
          await new Promise(resolve => setTimeout(resolve, 5000));
          notifyProcess('PROCESS_PROGRESS', {
            status: 'failed',
            currentPrompt: promptOffset,
            totalPrompts: totalPromptsForRun,
            statusText: 'Interface nie gotowy (resume)',
            reason: 'resume_interface_not_ready',
            needsAction: false
          });
          return {
            success: false,
            lastResponse: '',
            error: 'Interface nie gotowy w trybie resume',
            metrics: buildMetricsSnapshot({ completed: false, reason: 'resume_interface_not_ready' })
          };
        }
        
        console.log("✅ Interface gotowy - rozpoczynam resume chain");
        updateCounter(counter, promptOffset, totalPromptsForRun, '🔄 Rozpoczynam chain...');
        await new Promise(resolve => setTimeout(resolve, 1000)); // Krótka stabilizacja
      }
      
      // Teraz uruchom prompt chain
      if (promptChain && promptChain.length > 0) {
        if (stage0Response) {
          const preparedChain = injectStage0IntoChain(promptChain, stage0Response);
          promptChain = preparedChain.chain;
          if (preparedChain.replacedCount > 0) {
            console.log(`✅ Wstawiono Stage 0 do ${preparedChain.replacedCount} prompt(ów)`);
          } else {
            console.warn('⚠️ Stage 0 zebrane, ale nie znaleziono placeholdera w prompt chain');
          }
        }

        console.log(`\n=== PROMPT CHAIN: ${promptChain.length} promptów do wykonania ===`);
        console.log(`Pełna lista promptów:`, promptChain);
        delete window._lastResponseToSave;
        
        for (let i = 0; i < promptChain.length; i++) {
          if (shouldStopNow()) {
            return forceStopResult();
          }
          const prompt = promptChain[i];
          const remaining = promptChain.length - i - 1;
          const localPromptNumber = i + 1;
          const absoluteCurrentPrompt = getAbsolutePromptIndex(localPromptNumber);
          const absoluteStageIndex = getAbsoluteStageIndex(i, localPromptNumber);
          const promptSnapshotBeforeSend = getPromptDomSnapshot();
          
          console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
          console.log(`>>> PROMPT ${i + 1}/${promptChain.length} (pozostało: ${remaining})`);
          console.log(`Długość: ${prompt.length} znaków, ${prompt.split('\n').length} linii`);
          console.log(`Preview:\n${prompt.substring(0, 200)}${prompt.length > 200 ? '...' : ''}`);
          console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
          
          // Aktualizuj licznik - wysyłanie
          updateCounter(counter, absoluteCurrentPrompt, totalPromptsForRun, 'Wysyłam prompt...');
          notifyProcess('PROCESS_PROGRESS', {
            status: 'running',
            currentPrompt: absoluteCurrentPrompt,
            totalPrompts: totalPromptsForRun,
            stageIndex: absoluteStageIndex,
            stageName: `Prompt ${absoluteCurrentPrompt}`,
            statusText: 'Wysylam prompt',
            needsAction: false
          });
          
          // Wyślij prompt
          console.log(`[${i + 1}/${promptChain.length}] Wywołuję sendPrompt()...`);
          const sent = await sendPrompt(prompt, interfaceReadyWaitMs, counter, absoluteCurrentPrompt, totalPromptsForRun);
          if (shouldStopNow()) {
            return forceStopResult();
          }
          
          if (!sent) {
            console.error(`❌ Nie udało się wysłać prompta ${i + 1}/${promptChain.length}`);
            console.log(`⏸️ Błąd wysyłania - czekam na interwencję użytkownika`);
            updateCounter(counter, absoluteCurrentPrompt, totalPromptsForRun, `❌ Błąd wysyłania`);
            const sentDespiteFailure = await detectPromptSentDespiteFailure(promptSnapshotBeforeSend, prompt, 7000);
            if (sentDespiteFailure) {
              console.warn(`⚠️ sendPrompt zwrócił false, ale DOM pokazuje że prompt prawdopodobnie został wysłany - kontynuuję bez auto-reload`);
              runMetrics.sendOkInferred += 1;
              sendOkPromptIndexes.add(absoluteCurrentPrompt);
              logSend('INFERRED_OK', { promptIndex: absoluteCurrentPrompt, promptTotal: totalPromptsForRun });
            } else {
              runMetrics.sendFailures += 1;
              logSend('FAIL', { promptIndex: absoluteCurrentPrompt, promptTotal: totalPromptsForRun });
            
              // Pokaż przyciski i czekaj na user - może naprawić sytuację lub pominąć
              const autoRecoveryHandoff = maybeTriggerAutoRecovery(
                'send_failed',
                i,
                promptChain,
                absoluteCurrentPrompt,
                absoluteStageIndex,
                counter
              );
              if (autoRecoveryHandoff) {
                return autoRecoveryHandoff;
              }

              const action = await showContinueButton(counter, absoluteCurrentPrompt, totalPromptsForRun, 'send_failed');
            
              if (action === 'skip') {
                console.log(`⏭️ User wybrał pominięcie - przechodzę do następnego prompta`);
                runMetrics.sendSkipped += 1;
                logSend('SKIP', { promptIndex: absoluteCurrentPrompt, promptTotal: totalPromptsForRun });
                continue; // Pomiń resztę tego prompta, idź do następnego
              }
            
              // User naprawił, spróbuj wysłać ponownie ten sam prompt
              console.log(`🔄 Kontynuacja po naprawie - ponowne wysyłanie prompta ${i + 1}...`);
              const retried = await sendPrompt(prompt, interfaceReadyWaitMs, counter, absoluteCurrentPrompt, totalPromptsForRun);
              if (shouldStopNow()) {
                return forceStopResult();
              }
            
              if (!retried) {
                console.error(`❌ Ponowna próba nieudana - przerywam chain`);
                updateCounter(counter, absoluteCurrentPrompt, totalPromptsForRun, `❌ Błąd krytyczny`);
                await new Promise(resolve => setTimeout(resolve, 10000));
                notifyProcess('PROCESS_PROGRESS', {
                  status: 'failed',
                  currentPrompt: absoluteCurrentPrompt,
                  totalPrompts: totalPromptsForRun,
                  stageIndex: absoluteStageIndex,
                  stageName: `Prompt ${absoluteCurrentPrompt}`,
                  statusText: 'Blad krytyczny po retry',
                  reason: 'send_retry_failed',
                  needsAction: false
                });
                // WAŻNE: Musimy zwrócić obiekt, nie undefined!
                runMetrics.sendHardFail += 1;
                logSend('HARD_FAIL', { promptIndex: absoluteCurrentPrompt, promptTotal: totalPromptsForRun });
                return {
                  success: false,
                  lastResponse: '',
                  error: 'Nie udało się wysłać prompta po retry',
                  metrics: buildMetricsSnapshot({ failedAtPrompt: absoluteCurrentPrompt, reason: 'send_retry_failed' })
                };
              }
            
              console.log(`✅ Ponowne wysyłanie udane - kontynuuję chain`);
            }
          }
          
          // Aktualizuj licznik - czekanie
          updateCounter(counter, absoluteCurrentPrompt, totalPromptsForRun, 'Czekam na odpowiedz...');
          
          // Pętla czekania na odpowiedź - powtarzaj aż się uda
          let responseCompleted = false;
          while (!responseCompleted) {
            if (shouldStopNow()) {
              return forceStopResult();
            }
            console.log(`[${i + 1}/${promptChain.length}] Wywołuję waitForResponse()...`);
            const completed = await waitForResponse(responseWaitMs);
            if (shouldStopNow()) {
              return forceStopResult();
            }
            
            if (!completed) {
              // Timeout - pokaż przyciski i czekaj na user
              console.error(`❌ Timeout przy promptcie ${i + 1}/${promptChain.length}`);
              console.log(`⏸️ ChatGPT nie odpowiedział w czasie - czekam na interwencję użytkownika`);
              updateCounter(counter, absoluteCurrentPrompt, totalPromptsForRun, 'Timeout - czekam...');
              const timeoutOutcome = await classifyTimeoutOutcome(promptSnapshotBeforeSend, prompt);
              if (timeoutOutcome === 'response_ready') {
                console.warn(`⚠️ Timeout heurystyki, ale wykryto odpowiedź - pomijam auto-reload dla prompta ${absoluteCurrentPrompt}`);
                responseCompleted = true;
                break;
              }
              if (timeoutOutcome === 'still_generating') {
                console.warn(`⚠️ Timeout heurystyki, ale ChatGPT nadal generuje - kontynuuję czekanie bez auto-reload`);
                updateCounter(counter, absoluteCurrentPrompt, totalPromptsForRun, 'ChatGPT nadal generuje...');
                await new Promise((resolve) => setTimeout(resolve, 1500));
                continue;
              }
              
              const autoRecoveryHandoff = maybeTriggerAutoRecovery(
                'timeout',
                i,
                promptChain,
                absoluteCurrentPrompt,
                absoluteStageIndex,
                counter
              );
              if (autoRecoveryHandoff) {
                return autoRecoveryHandoff;
              }

              const action = await showContinueButton(counter, absoluteCurrentPrompt, totalPromptsForRun, 'timeout');
              
              if (action === 'skip') {
                console.log(`⏭️ User wybrał pominięcie - zakładam że odpowiedź jest OK i idę dalej`);
                responseCompleted = true; // Wyjdź z pętli czekania
                break;
              }
              
              // User kliknął "Czekaj na odpowiedź" - czekaj ponownie
              console.log(`🔄 Kontynuacja po timeout - ponowne czekanie na odpowiedź...`);
              updateCounter(counter, absoluteCurrentPrompt, totalPromptsForRun, 'Czekam na odpowiedz...');
              continue; // Powtórz pętlę waitForResponse
            }
            
            // Odpowiedź zakończona - wyjdź z pętli
            responseCompleted = true;
          }
          
          // Pętla walidacji odpowiedzi - powtarzaj aż będzie poprawna
          let responseValid = false;
          let responseText = '';
          while (!responseValid) {
            if (shouldStopNow()) {
              return forceStopResult();
            }
            console.log(`[${i + 1}/${promptChain.length}] Walidacja odpowiedzi...`);
            responseText = await getLastResponseText();
            const isValid = validateResponse(responseText);
            
            if (!isValid) {
              // Odpowiedź niepoprawna - pokaż przyciski i czekaj na user
              console.error(`❌ Odpowiedź niepoprawna przy promptcie ${i + 1}/${promptChain.length}`);
              console.error(`❌ Długość: ${responseText.length} znaków (wymagane min 50)`);
              updateCounter(counter, absoluteCurrentPrompt, totalPromptsForRun, 'Odpowiedz za krotka');
              const trimmedResponse = compactText(responseText);
              const assistantAdvanced = hasAssistantAdvancedSince(promptSnapshotBeforeSend, 10);
              const allowAutoRecoveryForInvalid = hasHardGenerationErrorMessage() || (!assistantAdvanced && trimmedResponse.length === 0);
              
              if (allowAutoRecoveryForInvalid) {
                const autoRecoveryHandoff = maybeTriggerAutoRecovery(
                  'invalid_response',
                  i,
                  promptChain,
                  absoluteCurrentPrompt,
                  absoluteStageIndex,
                  counter
                );
                if (autoRecoveryHandoff) {
                  return autoRecoveryHandoff;
                }
              }

              const action = await showContinueButton(counter, absoluteCurrentPrompt, totalPromptsForRun, 'invalid_response');
              
              if (action === 'skip') {
                console.log(`⏭️ User wybrał pominięcie - akceptuję krótką odpowiedź i idę dalej`);
                responseValid = true; // Wyjdź z pętli walidacji
                break;
              }
              
              // User kliknął "Czekaj na odpowiedź" - może ChatGPT jeszcze generuje
              console.log(`🔄 Kontynuacja po naprawie - czekam na zakończenie generowania...`);
              updateCounter(counter, absoluteCurrentPrompt, totalPromptsForRun, 'Czekam na odpowiedz...');
              
              // Poczekaj na zakończenie odpowiedzi ChatGPT
              await waitForResponse(responseWaitMs);
              if (shouldStopNow()) {
                return forceStopResult();
              }
              
              // Powtórz walidację
              continue;
            }
            
          // Odpowiedź poprawna - wyjdź z pętli
          responseValid = true;
        }
        
        console.log(`✅ Prompt ${i + 1}/${promptChain.length} zakończony - odpowiedź poprawna`);
        notifyProcess('PROCESS_PROGRESS', {
          status: 'running',
          currentPrompt: absoluteCurrentPrompt,
          totalPrompts: totalPromptsForRun,
          stageIndex: absoluteStageIndex,
          stageName: `Prompt ${absoluteCurrentPrompt}`,
          statusText: 'Prompt zakonczony',
          needsAction: false
        });
        const stageValidated = validateResponse(responseText);
        registerStageCompletion(absoluteCurrentPrompt, responseText, stageValidated);
          
          // Zapamiętaj TYLKO odpowiedź z ostatniego prompta (do zwrócenia na końcu)
          const isLastPrompt = (i === promptChain.length - 1);
          if (isLastPrompt) {
            const rawResponseText = responseText || '';
            const stabilizedResponse = await captureLastResponseWithRetries(rawResponseText, absoluteCurrentPrompt);

            // Zapisz ZAWSZE ostatnią odpowiedź, nawet jeśli pusta (dla debugowania)
            window._lastResponseToSave = stabilizedResponse || '';
            const captureFingerprint = computeCopyFingerprint(window._lastResponseToSave);
            const rawFingerprint = computeCopyFingerprint(rawResponseText);
            if (window._lastResponseToSave && window._lastResponseToSave.length > 0) {
              runMetrics.captureOk += 1;
              logCapture('OK', { promptIndex: absoluteCurrentPrompt, chars: window._lastResponseToSave.length });
              console.log(`💾 Przygotowano ostatnią odpowiedź z prompta ${i + 1}/${promptChain.length} do zapisu (${window._lastResponseToSave.length} znaków)`);
              console.log(`[copy-flow] [capture:last-prompt] prompt=${absoluteCurrentPrompt} len=${window._lastResponseToSave.length} fp=${captureFingerprint} rawLen=${rawResponseText.length} rawFp=${rawFingerprint} changed=${window._lastResponseToSave !== rawResponseText}`);
            } else {
              runMetrics.captureEmpty += 1;
              logCapture('EMPTY', { promptIndex: absoluteCurrentPrompt });
              console.warn(`⚠️ Ostatnia odpowiedź z prompta ${i + 1}/${promptChain.length} jest pusta! Zapisuję pustą odpowiedź dla debugowania.`);
              console.warn(`[copy-flow] [capture:last-prompt-empty] prompt=${absoluteCurrentPrompt} fp=${captureFingerprint} rawLen=${rawResponseText.length} rawFp=${rawFingerprint}`);
            }
          } else {
            console.log(`⏭️ Pomijam odpowiedź ${i + 1}/${promptChain.length} - nie jest to ostatni prompt`);
          }
          
          // Anti-automation delay przed następnym promptem
          if (i < promptChain.length - 1) {
            const delay = getRandomDelay();
            console.log(`⏸️ Anti-automation delay: ${(delay/1000).toFixed(1)}s przed promptem ${i + 2}/${promptChain.length}...`);
            updateCounter(counter, absoluteCurrentPrompt, totalPromptsForRun, `⏸️ Czekam ${(delay/1000).toFixed(0)}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            if (shouldStopNow()) {
              return forceStopResult();
            }
          }
        }
        
        // Sukces - pętla zakończona bez break
        console.log(`\n🎉 ZAKOŃCZONO PROMPT CHAIN - wykonano wszystkie ${promptChain.length} promptów`);
        
        // Usuń licznik z animacją sukcesu
        const completedPrompt = getAbsolutePromptIndex(promptChain.length);
        const counterCurrent = completedPrompt > 0
          ? completedPrompt
          : (totalPromptsForRun > 0 ? totalPromptsForRun : 1);
        const counterTotal = totalPromptsForRun > 0
          ? totalPromptsForRun
          : Math.max(counterCurrent, 1);
        updateCounter(counter, counterCurrent, counterTotal, 'Prompt chain zakonczony. Trwa zapis do bazy...');
        
        // Zwróć ostatnią odpowiedź do zapisania
        const lastResponse = window._lastResponseToSave || '';
        delete window._lastResponseToSave;
        console.log(`🔙 Zwracam odpowiedź do zapisu (${lastResponse.length} znaków)`);
        console.log(`[copy-flow] [capture:return] prompt=${promptChain.length} len=${lastResponse.length} fp=${computeCopyFingerprint(lastResponse)}`);
        const selectedPrompt = completedPrompt;
        const selectedStageIndex = selectedPrompt > 0 ? (selectedPrompt - 1) : null;
        const responseId = buildInjectedResponseId(lastResponse, selectedPrompt);
        let persistedViaMessage = false;
        let persistedSaveResult = null;
        let persistedSaveError = '';
        if (persistFinalResponseViaMessage && lastResponse.trim().length > 0) {
          console.log(
            `[copy-flow] [capture:tab-save:start] prompt=${selectedPrompt} len=${lastResponse.length} responseId=${responseId}`
          );
          const tabSaveResult = await persistFinalResponseViaRuntimeMessage(
            lastResponse,
            responseId,
            selectedPrompt,
            selectedStageIndex
          );
          if (tabSaveResult.ok) {
            persistedViaMessage = true;
            persistedSaveResult = tabSaveResult.saveResult && typeof tabSaveResult.saveResult === 'object'
              ? tabSaveResult.saveResult
              : null;
            console.log(
              `[copy-flow] [capture:tab-save:ok] prompt=${selectedPrompt} responseId=${responseId} trace=${persistedSaveResult?.copyTrace || 'n/a'}`
            );
          } else {
            persistedSaveError = typeof tabSaveResult.error === 'string' ? tabSaveResult.error : 'save_message_failed';
            persistedSaveResult = tabSaveResult.saveResult && typeof tabSaveResult.saveResult === 'object'
              ? tabSaveResult.saveResult
              : null;
            console.warn(
              `[copy-flow] [capture:tab-save:failed] prompt=${selectedPrompt} responseId=${responseId} error=${persistedSaveError}`
            );
          }
        }
        notifyProcess('PROCESS_PROGRESS', {
          status: 'completed',
          currentPrompt: completedPrompt,
          totalPrompts: totalPromptsForRun,
          stageIndex: completedPrompt > 0 ? (completedPrompt - 1) : null,
          stageName: completedPrompt > 0 ? `Prompt ${completedPrompt}` : 'Start',
          statusText: 'Prompt chain zakonczony - trwa zapis do bazy',
          needsAction: false
        });

        console.log('[inject][summary] completed', buildMetricsSnapshot({ completed: true, totalPrompts: totalPromptsForRun }));
        return {
          success: true,
          lastResponse: lastResponse,
          conversationUrl: typeof location?.href === 'string' ? location.href : '',
          responseId,
          selectedResponsePrompt: selectedPrompt,
          selectedResponseStageIndex: selectedStageIndex,
          selectedResponseReason: 'last_prompt',
          persistedViaMessage,
          persistedSaveResult,
          persistedSaveError,
          metrics: buildMetricsSnapshot({ completed: true, totalPrompts: totalPromptsForRun })
        };
      } else {
        console.log("ℹ️ Brak prompt chain do wykonania (prompt chain jest puste lub null)");
        
        // Usuń licznik
        removeCounter(counter, true);
        notifyProcess('PROCESS_PROGRESS', {
          status: 'completed',
          currentPrompt: promptOffset,
          totalPrompts: totalPromptsForRun,
          stageIndex: promptOffset > 0 ? (promptOffset - 1) : null,
          stageName: promptOffset > 0 ? `Prompt ${promptOffset}` : 'Start',
          statusText: 'Brak prompt chain',
          needsAction: false
        });
        
        // Brak prompt chain - nie ma odpowiedzi do zapisania
        console.log('[inject][summary] completed_no_chain', buildMetricsSnapshot({ completed: true, totalPrompts: totalPromptsForRun }));
        return { success: true, lastResponse: '', metrics: buildMetricsSnapshot({ completed: true, totalPrompts: totalPromptsForRun }) };
      }
      
      // Ten return nigdy nie powinien zostać osiągnięty
      return { success: false, lastResponse: '', error: 'unexpected_code_path', metrics: buildMetricsSnapshot({ completed: false }) };
    }
    
    // Czekaj przed następną próbą
    await new Promise(resolve => setTimeout(resolve, retryIntervalMs));
  }
  
  console.error("Nie znaleziono textarea w ChatGPT po " + textareaWaitMs + "ms");
  notifyProcess('PROCESS_PROGRESS', {
    status: 'failed',
    currentPrompt: promptOffset,
    totalPrompts: totalPromptsForRun,
    statusText: 'Nie znaleziono textarea',
    reason: 'textarea_not_found',
    needsAction: false
  });
  return { success: false, lastResponse: '', error: 'Nie znaleziono textarea', metrics: buildMetricsSnapshot({ completed: false, reason: 'textarea_not_found' }) };
  
  } catch (error) {
    if (forceStopRequested) {
      return {
        success: false,
        lastResponse: '',
        error: 'force_stopped',
        stopped: true,
        reason: forceStopReason,
        origin: forceStopOrigin
      };
    }
    console.error(`\n${'='.repeat(80)}`);
    console.error(`❌ [injectToChat] CRITICAL ERROR`);
    console.error(`  Error: ${error.message}`);
    console.error(`  Stack: ${error.stack}`);
    console.error(`${'='.repeat(80)}\n`);
    notifyProcess('PROCESS_PROGRESS', {
      status: 'failed',
      currentPrompt: promptOffset,
      totalPrompts: totalPromptsForRun,
      statusText: 'Krytyczny blad injectToChat',
      reason: 'inject_critical_error',
      needsAction: false
    });
    return { success: false, lastResponse: '', error: `Critical error: ${error.message}`, metrics: buildMetricsSnapshot({ completed: false, reason: 'critical_error' }) };
  } finally {
    cleanupForceStopListener();
  }
}

// Funkcja pomocnicza do czekania
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Funkcja czekająca na pełne załadowanie karty
function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    
    // Sprawdź czy już jest complete
    chrome.tabs.get(tabId, (tab) => {
      if (tab.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}










