const CHAT_URL = "https://chatgpt.com/g/g-p-6970fbfa4c348191ba16b549b09ce706/project";
const CHAT_URL_PORTFOLIO = "https://chatgpt.com/g/g-p-6970fbfa4c348191ba16b549b09ce706/project";
const INVEST_GPT_URL_BASE = "https://chatgpt.com/g/g-p-6970fbfa4c348191ba16b549b09ce706-inwestycje";
const INVEST_GPT_URL_PREFIX = `${INVEST_GPT_URL_BASE}/`;
const PAUSE_MS = 1000;
const WAIT_FOR_TEXTAREA_MS = 10000; // 10 sekund na znalezienie textarea
const WAIT_FOR_RESPONSE_MS = 14400000; // 240 minut na odpowiedź ChatGPT (zwiększono dla bardzo długich sesji)
const RETRY_INTERVAL_MS = 500;
// Auto start over existing chats: one mode only (hard reset + scan + start).
const RESET_SCAN_DEFAULT_PASSES = 3;
const RESET_SCAN_PASS_DELAY_MS = 500;
const RESET_SCAN_PER_TAB_BUDGET_MS = 6000;
const RESET_SCAN_MIN_RUNTIME_MS = 90 * 1000;
const AUTO_RECOVERY_MAX_ATTEMPTS = 4;
const AUTO_RECOVERY_DELAY_MS = 8000;
const AUTO_RECOVERY_RELOAD_TIMEOUT_MS = 30000;
const AUTO_RECOVERY_REASONS = ['send_failed', 'timeout', 'invalid_response'];

// Optional cloud upload config (kept simple; safe to extend later).
const CLOUD_UPLOAD = {
  enabled: false,
  url: "",
  apiKey: "",
  apiKeyHeader: "Authorization", // Use "Authorization" (Bearer) or custom header like "X-Api-Key".
  timeoutMs: 20000,
  retryCount: 2,
  backoffMs: 1000
};

// One-time setup: prefer token in chrome.storage.local (tokenStorageKey); inline token remains fallback.
const WATCHLIST_DISPATCH = {
  enabled: true,
  apiBaseUrl: "https://api.github.com",
  repository: "KosmicznyNomad/watchlist",
  eventType: "economist_response",
  token: "",
  tokenStorageKey: "watchlist_dispatch_token",
  timeoutMs: 20000,
  retryCount: 3,
  backoffMs: 1500,
  maxBackoffMs: 30 * 60 * 1000,
  outboxStorageKey: "watchlist_dispatch_outbox",
  outboxMaxItems: 5000,
  alarmName: "watchlist-dispatch-flush",
  alarmPeriodMinutes: 2
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
let processRegistryReady = null;
let watchlistDispatchFlushInProgress = false;
let watchlistDispatchTokenCache = null;

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

  if (processTabId !== null) {
    await requestProcessForceStopOnTab(processTabId, {
      runId,
      reason,
      origin: options.origin || 'background'
    });
  }

  let windowClosed = false;
  if (processWindowId !== null && processWindowId !== preserveWindowId) {
    windowClosed = await removeWindowSafe(processWindowId);
  }

  if (!windowClosed && processTabId !== null) {
    await removeTabSafe(processTabId);
  }

  await upsertProcess(runId, {
    status: 'stopped',
    statusText,
    reason,
    needsAction: false,
    finishedAt: now,
    timestamp: now
  });

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
      preserveWindowId
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
        const messages = document.querySelectorAll('[data-message-author-role="user"]');
        const count = messages.length;
        const last = count > 0 ? messages[count - 1] : null;
        const text = last ? (last.innerText || last.textContent || '') : '';
        return {
          text: typeof text === 'string' ? text : '',
          count,
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

  if (!targetTab?.url || !targetTab.url.includes('chatgpt.com')) {
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

  const promptsToSend = PROMPTS_COMPANY.slice(normalizedStartIndex);
  const cleanedPrompts = [...promptsToSend];
  if (cleanedPrompts[0]) {
    cleanedPrompts[0] = cleanedPrompts[0].replace('{{articlecontent}}', '').trim();
  }

  const payload = '';
  const restOfPrompts = cleanedPrompts;
  const companyPromptCatalog = buildPromptSignatureCatalog(PROMPTS_COMPANY);
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
    stageIndex: normalizedStartIndex > 0 ? (normalizedStartIndex - 1) : 0,
    stageName: normalizedStartIndex > 0 ? `Prompt ${normalizedStartIndex}` : 'Start',
    needsAction: false,
    startedAt: Date.now(),
    timestamp: Date.now(),
    sourceUrl: targetTab.url || '',
    chatUrl: targetTab.url || '',
    tabId,
    windowId: Number.isInteger(windowId) ? windowId : targetTab.windowId,
    messages: []
  });

  try {
    const targetWindowId = Number.isInteger(windowId) ? windowId : targetTab.windowId;
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
        statusText: `Auto-reload ${autoRecoveryAttempt}/${AUTO_RECOVERY_MAX_ATTEMPTS}`,
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

      const reloadResult = await forceReloadTab(tabId, {
        timeoutMs: AUTO_RECOVERY_RELOAD_TIMEOUT_MS,
        bypassCache: true
      });
      if (!reloadResult.ok) {
        console.warn('[auto-resume] Nie udalo sie potwierdzic reloadu karty:', reloadResult);
      }
      await sleep(AUTO_RECOVERY_DELAY_MS);

      const detectedRecoveryPoint = await detectCompanyRecoveryPointFromLastMessage(
        tabId,
        nextPromptOffset,
        companyPromptCatalog
      );
      const alignedState = alignExecutionStateWithDetectedPrompt(
        nextPromptOffset,
        nextRemainingPrompts,
        detectedRecoveryPoint
      );

      if (alignedState.applied) {
        const syncedCurrentPrompt = Number.isInteger(alignedState.promptOffset) && alignedState.promptOffset >= 0
          ? alignedState.promptOffset + 1
          : recoveryCurrentPrompt;
        const syncedStageIndex = syncedCurrentPrompt > 0 ? (syncedCurrentPrompt - 1) : null;
        await upsertProcess(processId, {
          title: processTitle,
          analysisType: 'company',
          status: 'running',
          needsAction: false,
          currentPrompt: syncedCurrentPrompt,
          totalPrompts: PROMPTS_COMPANY.length,
          ...(Number.isInteger(syncedStageIndex) ? { stageIndex: syncedStageIndex } : {}),
          ...(syncedCurrentPrompt > 0 ? { stageName: `Prompt ${syncedCurrentPrompt}` } : {}),
          statusText: `Auto-recovery sync: prompt ${syncedCurrentPrompt}`,
          reason: 'auto_recovery_sync_last_message',
          autoRecovery: {
            attempt: autoRecoveryAttempt,
            maxAttempts: AUTO_RECOVERY_MAX_ATTEMPTS,
            delayMs: AUTO_RECOVERY_DELAY_MS,
            reason: recoveryReasonBase,
            currentPrompt: syncedCurrentPrompt,
            ...(Number.isInteger(syncedStageIndex) ? { stageIndex: syncedStageIndex } : {}),
            updatedAt: Date.now()
          },
          timestamp: Date.now()
        });
      }

      executionPayload = '';
      executionPromptChain = alignedState.remainingPrompts;
      executionPromptOffset = alignedState.promptOffset;
    }

    if (result?.success) {
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

    // Legacy request flags (resetProcesses/clearHistory) are intentionally ignored:
    // this endpoint now always runs as hard reset + scan + start.
    const resetSummary = await resetTrackedProcessesForBulkRun({
      clearHistory: true,
      reason: 'bulk_reset_before_scan_start',
      statusText: 'Reset przed skanowaniem',
      origin
    });
    await sleep(200);

    if (PROMPTS_COMPANY.length === 0) {
      await loadPrompts();
    }
    if (PROMPTS_COMPANY.length === 0) {
      return {
        success: false,
        scannedTabs: 0,
        matchedTabs: 0,
        startedTabs: 0,
        resumedTabs: 0,
        results: [],
        resetSummary,
        error: 'prompts_not_loaded'
      };
    }

    const catalog = buildPromptSignatureCatalog(PROMPTS_COMPANY);
    const promptRecords = buildPromptSignatureRecords(PROMPTS_COMPANY);
    const tabsRaw = await chrome.tabs.query({});
    const chatTabs = tabsRaw
      .filter((tab) => isInvestGptUrl(getTabEffectiveUrl(tab)))
      .sort(compareTabsByWindowAndIndex);
    const resultsByTabId = new Map();
    const matchedTabIds = new Set();
    const startedTabIds = new Set();
    const pendingTabIds = new Set(
      chatTabs
        .map((tab) => (Number.isInteger(tab?.id) ? tab.id : null))
        .filter((id) => Number.isInteger(id))
    );

    const startedAt = Date.now();
    const maxPasses = Number.isInteger(options?.maxPasses) && options.maxPasses > 0
      ? options.maxPasses
      : RESET_SCAN_DEFAULT_PASSES;
    const maxRuntimeMs = Math.max(
      RESET_SCAN_MIN_RUNTIME_MS,
      chatTabs.length * RESET_SCAN_PER_TAB_BUDGET_MS,
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

    console.log('[reset-scan-start] Init', {
      origin,
      promptsCompanyCount: PROMPTS_COMPANY.length,
      signatureCatalogCount: catalog.length,
      promptRecordsCount: promptRecords.length,
      chatTabsCount: chatTabs.length,
      maxPasses,
      maxRuntimeMs,
      passDelayMs,
      resetSummary
    });

    while (
      pendingTabIds.size > 0 &&
      passCount < maxPasses &&
      (Date.now() - startedAt) < maxRuntimeMs
    ) {
      passCount += 1;
      console.log('[reset-scan-start] Pass start', {
        pass: passCount,
        pending: pendingTabIds.size,
        scanned: chatTabs.length
      });

      for (const tab of chatTabs) {
        if (!Number.isInteger(tab?.id) || !pendingTabIds.has(tab.id)) continue;

        const previous = resultsByTabId.get(tab.id) || null;
        const row = {
          tabId: Number.isInteger(tab?.id) ? tab.id : null,
          windowId: Number.isInteger(tab?.windowId) ? tab.windowId : null,
          title: typeof tab?.title === 'string' ? tab.title : '',
          url: getTabEffectiveUrl(tab),
          userMessageCount: null,
          lastUserMessageLength: null,
          detectedPromptIndex: null,
          detectedPromptNumber: null,
          detectedStageName: null,
          detectedMethod: '',
          detectedSignature: '',
          progressPromptNumber: null,
          progressStageName: '',
          stageConsistency: '',
          stageDelta: null,
          nextStartIndex: null,
          action: 'no_match',
          reason: '',
          attempts: previous?.attempts ? (previous.attempts + 1) : 1,
          lastPass: passCount
        };

        console.log('[reset-scan-start] Inspect tab', {
          pass: passCount,
          tabId: row.tabId,
          windowId: row.windowId,
          attempt: row.attempts,
          url: truncateForLog(row.url, 140),
          title: truncateForLog(row.title, 100)
        });

        if (!Number.isInteger(tab?.id)) {
          row.action = 'inject_failed';
          row.reason = 'invalid_tab_id';
          resultsByTabId.set(tab.id, row);
          pendingTabIds.delete(tab.id);
          continue;
        }

        let currentTab = null;
        try {
          currentTab = await chrome.tabs.get(tab.id);
        } catch (error) {
          row.action = 'inject_failed';
          row.reason = 'tab_not_found';
          resultsByTabId.set(tab.id, row);
          pendingTabIds.delete(tab.id);
          continue;
        }

        row.title = typeof currentTab?.title === 'string' ? currentTab.title : row.title;
        row.url = getTabEffectiveUrl(currentTab) || row.url;
        row.windowId = Number.isInteger(currentTab?.windowId) ? currentTab.windowId : row.windowId;

        if (!isInvestGptUrl(row.url)) {
          row.action = 'no_match';
          row.reason = `tab_url_not_inwestycje_gpt:${row.url || 'empty'}`;
          resultsByTabId.set(tab.id, row);
          pendingTabIds.delete(tab.id);
          console.warn('[reset-scan-start] Skip tab (url outside inwestycje GPT)', {
            tabId: row.tabId,
            reason: row.reason
          });
          continue;
        }

        await prepareTabForDetection(tab.id, row.windowId);
        console.log('[reset-scan-start] Tab prepared for detection', {
          tabId: row.tabId,
          windowId: row.windowId
        });

        let extraction = await extractLastUserMessageFromTab(tab.id);
        if (!extraction.success) {
          console.warn('[reset-scan-start] Extraction failed, retrying', {
            tabId: row.tabId,
            error: extraction.error || 'unknown_error'
          });
          await sleep(350);
          extraction = await extractLastUserMessageFromTab(tab.id);
        }
        if (!extraction.success) {
          row.action = 'inject_failed';
          row.reason = extraction.error || 'extract_last_user_message_failed';
          resultsByTabId.set(tab.id, row);
          console.warn('[reset-scan-start] Extraction failed after retry', {
            tabId: row.tabId,
            reason: row.reason
          });
          await sleep(250);
          continue;
        }

        row.userMessageCount = Number.isInteger(extraction.count) ? extraction.count : 0;
        row.lastUserMessageLength = typeof extraction.text === 'string' ? extraction.text.length : 0;
        console.log('[reset-scan-start] Extraction success', {
          tabId: row.tabId,
          userMessageCount: row.userMessageCount,
          lastUserMessageLength: row.lastUserMessageLength,
          lastUserMessagePreview: truncateForLog(extraction.text, 220)
        });

        const activeProcess = await getActiveProcessForTab(tab.id);
        if (activeProcess) {
          row.progressPromptNumber = Number.isInteger(activeProcess.currentPrompt) ? activeProcess.currentPrompt : null;
          row.progressStageName = typeof activeProcess.stageName === 'string' ? activeProcess.stageName : '';
          console.log('[reset-scan-start] Active process detected on tab', {
            tabId: row.tabId,
            processId: activeProcess.id,
            status: activeProcess.status,
            currentPrompt: activeProcess.currentPrompt,
            totalPrompts: activeProcess.totalPrompts,
            stageName: activeProcess.stageName || ''
          });
        }

        const lastUserText = typeof extraction.text === 'string' ? extraction.text.trim() : '';
        let detection = null;
        let directDetectionReason = '';

        if (lastUserText.length > 0) {
          const directDetection = detectPromptIndexFromMessage(lastUserText, catalog);
          if (directDetection.matched && Number.isInteger(directDetection.index)) {
            detection = directDetection;
            console.log('[reset-scan-start] Direct detection matched', {
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
            tabId: row.tabId
          });
        }

        if (!detection && promptRecords.length > 0) {
          const recent = await extractRecentUserPromptsFromTab(tab.id, 4000);
          const recentMessages = Array.isArray(recent?.messages) ? recent.messages : [];
          const recentMatch = detectLastPromptMatch(recentMessages, promptRecords);
          console.log('[reset-scan-start] Recent history fallback evaluated', {
            tabId: row.tabId,
            recentMessageCount: recentMessages.length,
            recentUrl: truncateForLog(recent?.url || '', 140),
            matched: !!recentMatch,
            matchedMethod: recentMatch?.method || '',
            matchedIndex: Number.isInteger(recentMatch?.index) ? recentMatch.index : null,
            matchedPromptNumber: Number.isInteger(recentMatch?.promptNumber) ? recentMatch.promptNumber : null,
            matchedSignaturePreview: truncateForLog(recentMatch?.signature || '', 140)
          });
          if (recentMatch && Number.isInteger(recentMatch.index)) {
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
                : ''
            };
            console.log('[reset-scan-start] Detection recovered from recent history', {
              tabId: row.tabId,
              index: detection.index,
              promptNumber: detection.promptNumber,
              stageName: detection.stageName || '',
              method: detection.method || ''
            });
          }
        }

        if (!detection || !Number.isInteger(detection.index)) {
          if (lastUserText.length === 0) {
            row.action = 'no_user_message';
            row.reason = 'empty_user_message';
          } else {
            row.action = 'no_match';
            row.reason = directDetectionReason || 'signature_not_found';
          }
          resultsByTabId.set(tab.id, row);
          // Signature matching may fail during early page hydration; retry in next pass.
          console.log('[reset-scan-start] Detection unresolved for tab (will retry)', {
            pass: passCount,
            tabId: row.tabId,
            action: row.action,
            reason: row.reason,
            attempts: row.attempts
          });
          await sleep(250);
          continue;
        }

        matchedTabIds.add(tab.id);
        row.detectedPromptIndex = detection.index;
        row.detectedPromptNumber = detection.promptNumber;
        row.detectedStageName = detection.stageName;
        row.detectedMethod = typeof detection.method === 'string' ? detection.method : '';
        row.detectedSignature = typeof detection.messageSignature === 'string'
          ? detection.messageSignature.slice(0, 180)
          : '';
        row.nextStartIndex = detection.index + 1;
        if (Number.isInteger(row.progressPromptNumber) && Number.isInteger(row.detectedPromptNumber)) {
          const delta = row.detectedPromptNumber - row.progressPromptNumber;
          row.stageDelta = delta;
          row.stageConsistency = Math.abs(delta) <= 1 ? 'ok' : 'drift';
        }
        console.log('[reset-scan-start] Detection resolved', {
          tabId: row.tabId,
          detectedPromptIndex: row.detectedPromptIndex,
          detectedPromptNumber: row.detectedPromptNumber,
          detectedStageName: row.detectedStageName,
          detectedMethod: row.detectedMethod,
          nextStartIndex: row.nextStartIndex,
          progressPromptNumber: row.progressPromptNumber,
          stageDelta: row.stageDelta,
          stageConsistency: row.stageConsistency || ''
        });

        if (row.nextStartIndex >= PROMPTS_COMPANY.length) {
          row.action = 'final_stage_already_sent';
          row.reason = 'already_at_last_stage';
          resultsByTabId.set(tab.id, row);
          pendingTabIds.delete(tab.id);
          console.log('[reset-scan-start] Final stage already sent for tab', {
            tabId: row.tabId,
            detectedPromptNumber: row.detectedPromptNumber,
            nextStartIndex: row.nextStartIndex
          });
          await sleep(250);
          continue;
        }

        if (activeProcess) {
          row.action = 'active_process_exists';
          row.reason = 'active_process_on_tab';
          resultsByTabId.set(tab.id, row);
          pendingTabIds.delete(tab.id);
          console.log('[reset-scan-start] Skip start due to active process', {
            tabId: row.tabId,
            reason: row.reason
          });
          await sleep(250);
          continue;
        }

        row.action = 'ready_to_start';
        row.reason = 'ready_to_start';
        resultsByTabId.set(tab.id, row);
        pendingTabIds.delete(tab.id);
        console.log('[reset-scan-start] Tab queued for sequential start', {
          tabId: row.tabId,
          nextStartIndex: row.nextStartIndex,
          startPromptNumber: row.nextStartIndex + 1
        });
        await sleep(250);
      }

      if (
        pendingTabIds.size > 0 &&
        passCount < maxPasses &&
        (Date.now() - startedAt) < maxRuntimeMs
      ) {
        console.log('[reset-scan-start] Pass delay', {
          pass: passCount,
          pending: pendingTabIds.size,
          delayMs: passDelayMs
        });
        await sleep(passDelayMs);
      }
    }

    const runtimeLimitHit = (Date.now() - startedAt) >= maxRuntimeMs;
    const passLimitHit = passCount >= maxPasses;
    if (pendingTabIds.size > 0) {
      for (const tabId of pendingTabIds) {
        const row = resultsByTabId.get(tabId);
        if (!row) continue;
        const suffix = runtimeLimitHit
          ? 'runtime_limit_reached'
          : (passLimitHit ? 'pass_limit_reached' : 'retry_budget_exhausted');
        row.reason = row.reason ? `${row.reason}|${suffix}` : suffix;
        row.retryExhausted = true;
      }
    }

    // Start phase: execute queued starts sequentially after full scan pass.
    // This avoids interleaving scan/start on the same pass and makes behavior deterministic.
    const startQueue = chatTabs
      .map((tab) => {
        if (!Number.isInteger(tab?.id)) return null;
        const row = resultsByTabId.get(tab.id);
        if (!row || row.action !== 'ready_to_start') return null;
        return row;
      })
      .filter(Boolean);
    console.log('[reset-scan-start] Start queue prepared', {
      queueSize: startQueue.length,
      queue: startQueue.map((row) => ({
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
      console.log('[reset-scan-start] Starting tab from queue', {
        tabId: row.tabId,
        windowId: row.windowId,
        nextStartIndex: row.nextStartIndex,
        autoStartTitle
      });
      const startResult = await resumeFromStageOnTab(row.tabId, row.windowId, row.nextStartIndex, {
        processTitle: autoStartTitle,
        detach: true
      });

      if (startResult.success) {
        startedTabIds.add(row.tabId);
        row.action = 'started';
        row.reason = startResult.detached ? 'start_dispatched' : 'start_started';
        console.log('[reset-scan-start] Start success', {
          tabId: row.tabId,
          processId: startResult.processId || '',
          detached: !!startResult.detached,
          action: row.action
        });
      } else {
        row.action = 'start_failed';
        row.reason = startResult.error || 'start_failed';
        console.warn('[reset-scan-start] Start failed', {
          tabId: row.tabId,
          action: row.action,
          reason: row.reason
        });
      }
      resultsByTabId.set(row.tabId, row);
      await sleep(250);
    }

    const results = chatTabs.map((tab) => {
      const row = Number.isInteger(tab?.id) ? resultsByTabId.get(tab.id) : null;
      if (row) return row;
      return {
        tabId: Number.isInteger(tab?.id) ? tab.id : null,
        windowId: Number.isInteger(tab?.windowId) ? tab.windowId : null,
        title: typeof tab?.title === 'string' ? tab.title : '',
        url: typeof tab?.url === 'string' ? tab.url : '',
        detectedPromptIndex: null,
        detectedPromptNumber: null,
        detectedStageName: null,
        nextStartIndex: null,
        action: 'no_match',
        reason: runtimeLimitHit ? 'runtime_limit_reached_before_processing' : 'not_processed'
      };
    });

    const startedCount = startedTabIds.size;
    const actionCounts = results.reduce((acc, row) => {
      const key = typeof row?.action === 'string' && row.action
        ? row.action
        : 'unknown';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    console.log('[reset-scan-start] Summary', {
      targetUrlPrefix: INVEST_GPT_URL_PREFIX,
      maxPasses,
      maxRuntimeMs,
      passCount,
      pendingAfterLoop: pendingTabIds.size,
      scannedTabs: chatTabs.length,
      matchedTabs: matchedTabIds.size,
      startedTabs: startedCount,
      actionCounts
    });
    results.forEach((item) => {
      console.log('[reset-scan-start] Tab result', item);
    });

    return {
      success: true,
      scannedTabs: chatTabs.length,
      matchedTabs: matchedTabIds.size,
      startedTabs: startedCount,
      // Legacy alias for compatibility.
      resumedTabs: startedCount,
      passCount,
      maxPasses,
      maxRuntimeMs,
      pendingAfterLoop: pendingTabIds.size,
      resetSummary,
      results
    };
  } catch (error) {
    return {
      success: false,
      scannedTabs: 0,
      matchedTabs: 0,
      startedTabs: 0,
      resumedTabs: 0,
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
  return url.includes('chatgpt.com') || url.includes('chat.openai.com');
}

function isInvestGptUrl(url) {
  if (typeof url !== 'string') return false;
  const compactUrl = url.trim();
  if (!compactUrl.startsWith(INVEST_GPT_URL_BASE)) return false;
  if (compactUrl.length === INVEST_GPT_URL_BASE.length) return true;
  const separator = compactUrl.charAt(INVEST_GPT_URL_BASE.length);
  return separator === '/' || separator === '?' || separator === '#';
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

  const nextStartIndex = detection.index + 1;
  const promptOffset = Math.max(0, Math.min(nextStartIndex, PROMPTS_COMPANY.length));
  const remainingPrompts = buildCompanyPromptChainForResume(promptOffset);
  const promptCount = PROMPTS_COMPANY.length;
  const finalStageReached = promptOffset >= promptCount;

  return {
    matched: true,
    reason: 'matched',
    promptOffset,
    promptCount,
    finalStageReached,
    remainingPrompts,
    detection
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
    if (tab && isChatGptUrl(tab.url || '')) {
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
    return { messages: [], url: '' };
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      function: async (waitMs) => {
        const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const compact = (text) => (text || '').replace(/\s+/g, ' ').trim();

        function readUserMessages() {
          const nodes = Array.from(document.querySelectorAll('[data-message-author-role="user"]'));
          return nodes
            .map((node) => compact(node.innerText || node.textContent || ''))
            .filter((text) => text.length > 0)
            .slice(-14)
            .map((text) => text.length > 24000 ? text.slice(0, 24000) : text);
        }

        const startedAt = Date.now();
        let messages = readUserMessages();
        while (messages.length === 0 && (Date.now() - startedAt) < waitMs) {
          await sleep(300);
          messages = readUserMessages();
        }

        return {
          url: location.href,
          messages
        };
      },
      args: [maxWaitMs]
    });

    return results?.[0]?.result || { messages: [], url: '' };
  } catch (error) {
    console.warn('[resume] Nie udalo sie odczytac promptow usera z tab:', tabId, error?.message || error);
    return { messages: [], url: '' };
  }
}

function detectLastPromptMatch(userMessages, promptRecords) {
  const messages = Array.isArray(userMessages) ? userMessages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = messages[i];
    if (typeof text !== 'string' || text.trim().length === 0) continue;
    const signature = buildTwoSentenceSignature(text);
    const normalizedPromptText = normalizeSignatureText(text).slice(0, 360);
    const matched = matchPromptBySignature(signature, normalizedPromptText, promptRecords);
    if (matched) {
      return {
        ...matched,
        messageIndex: i,
        signature
      };
    }
  }
  return null;
}

function computeNextResumeIndex(lastPromptIndex, totalPrompts) {
  if (!Number.isInteger(lastPromptIndex)) return null;
  const promptCount = Number.isInteger(totalPrompts) ? totalPrompts : 0;
  if (promptCount <= 0) return null;

  const maxIndex = promptCount - 1;
  const boundedCurrent = Math.min(Math.max(lastPromptIndex, 0), maxIndex);
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
    return { success: false, error: 'run_not_found' };
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
  const matched = detectLastPromptMatch(extracted.messages, promptRecords);

  const detectedPromptIndex = matched
    ? matched.index
    : getProgressPromptIndex(process);
  const detectedMethod = matched ? matched.method : 'progress_fallback';

  const nextStartIndex = computeNextResumeIndex(detectedPromptIndex, PROMPTS_COMPANY.length);
  if (!Number.isInteger(nextStartIndex)) {
    return {
      success: false,
      error: 'already_at_last_prompt',
      detectedPromptIndex,
      detectedPromptNumber: Number.isInteger(detectedPromptIndex) ? (detectedPromptIndex + 1) : null,
      detectedMethod
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
      detectedMethod
    };
  }

  const resumeResult = await resumeFromStage(nextStartIndex, {
    targetTabId: chatTab.id,
    suppressAlerts: true
  });

  if (!resumeResult?.success) {
    return {
      success: false,
      error: resumeResult?.error || 'resume_failed',
      startIndex: nextStartIndex,
      startPromptNumber: nextStartIndex + 1,
      detectedPromptIndex,
      detectedPromptNumber: Number.isInteger(detectedPromptIndex) ? (detectedPromptIndex + 1) : null,
      detectedMethod
    };
  }

  await upsertProcess(runId, {
    status: 'stopped',
    statusText: `Wznowiono od Prompt ${nextStartIndex + 1}`,
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
    detectedMethod
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

function normalizeWatchlistDispatchPayload(response) {
  if (!response || typeof response !== 'object') return null;
  const text = typeof response.text === 'string' ? response.text : '';
  if (!text.trim()) return null;

  const responseId = typeof response.responseId === 'string' ? response.responseId.trim() : '';
  const runId = typeof response.runId === 'string' ? response.runId.trim() : '';

  return {
    schema: "economist.response.v1",
    responseId: responseId || generateResponseId(runId),
    runId: runId || null,
    text,
    source: typeof response.source === 'string' ? response.source : '',
    analysisType: typeof response.analysisType === 'string' ? response.analysisType : '',
    timestamp: response.timestamp ?? Date.now()
  };
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

async function enqueueWatchlistDispatch(response, copyTrace = 'no-run/no-response') {
  if (!WATCHLIST_DISPATCH.enabled) {
    return { skipped: true, reason: 'dispatch_disabled' };
  }

  const payload = normalizeWatchlistDispatchPayload(response);
  if (!payload) {
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
  console.log(
    `[copy-flow] [dispatch:queued] trace=${copyTrace} responseId=${payload.responseId} queueSize=${saved.length}`
  );
  return { queued: true, responseId: payload.responseId, queueSize: saved.length };
}

function normalizeWatchlistDispatchToken(rawToken) {
  return typeof rawToken === 'string' ? rawToken.trim() : '';
}

async function resolveWatchlistDispatchToken(forceReload = false) {
  if (!forceReload && watchlistDispatchTokenCache && typeof watchlistDispatchTokenCache.token === 'string') {
    return watchlistDispatchTokenCache;
  }

  const inlineToken = normalizeWatchlistDispatchToken(WATCHLIST_DISPATCH.token);
  if (inlineToken) {
    watchlistDispatchTokenCache = { token: inlineToken, source: 'inline_config' };
    return watchlistDispatchTokenCache;
  }

  const storageKey = WATCHLIST_DISPATCH.tokenStorageKey;
  if (!storageKey || !chrome?.storage?.local?.get) {
    watchlistDispatchTokenCache = { token: '', source: 'missing' };
    return watchlistDispatchTokenCache;
  }

  try {
    const result = await chrome.storage.local.get([storageKey]);
    const storedToken = normalizeWatchlistDispatchToken(result?.[storageKey]);
    watchlistDispatchTokenCache = {
      token: storedToken,
      source: storedToken ? 'storage_local' : 'missing'
    };
  } catch (error) {
    console.warn('[copy-flow] [dispatch:token-read-failed]', error);
    watchlistDispatchTokenCache = { token: '', source: 'missing' };
  }

  return watchlistDispatchTokenCache;
}

async function resolveWatchlistDispatchConfiguration(forceReload = false) {
  if (!WATCHLIST_DISPATCH.enabled) {
    return {
      ok: false,
      reason: 'dispatch_disabled',
      repository: '',
      token: '',
      tokenSource: 'missing'
    };
  }

  const repository = typeof WATCHLIST_DISPATCH.repository === 'string'
    ? WATCHLIST_DISPATCH.repository.trim()
    : '';
  if (!repository) {
    return {
      ok: false,
      reason: 'missing_repository',
      repository: '',
      token: '',
      tokenSource: 'missing'
    };
  }

  const tokenInfo = await resolveWatchlistDispatchToken(forceReload);
  if (!tokenInfo.token) {
    return {
      ok: false,
      reason: 'missing_dispatch_credentials',
      repository,
      token: '',
      tokenSource: tokenInfo.source || 'missing'
    };
  }

  return {
    ok: true,
    reason: null,
    repository,
    token: tokenInfo.token,
    tokenSource: tokenInfo.source || 'missing'
  };
}

async function getWatchlistDispatchStatus(forceReload = false) {
  const config = await resolveWatchlistDispatchConfiguration(forceReload);
  return {
    enabled: WATCHLIST_DISPATCH.enabled,
    repository: typeof WATCHLIST_DISPATCH.repository === 'string' ? WATCHLIST_DISPATCH.repository.trim() : '',
    eventType: typeof WATCHLIST_DISPATCH.eventType === 'string' ? WATCHLIST_DISPATCH.eventType.trim() : '',
    configured: !!config.ok,
    hasToken: !!config.token,
    tokenSource: config.tokenSource || 'missing',
    reason: config.reason
  };
}

async function setWatchlistDispatchToken(rawToken) {
  const token = normalizeWatchlistDispatchToken(rawToken);
  if (!token) {
    return { success: false, reason: 'empty_token' };
  }

  const storageKey = WATCHLIST_DISPATCH.tokenStorageKey;
  if (!storageKey || !chrome?.storage?.local?.set) {
    return { success: false, reason: 'storage_unavailable' };
  }

  await chrome.storage.local.set({ [storageKey]: token });
  watchlistDispatchTokenCache = { token, source: 'storage_local' };
  return { success: true, source: 'storage_local' };
}

async function clearWatchlistDispatchToken() {
  const storageKey = WATCHLIST_DISPATCH.tokenStorageKey;
  if (storageKey && chrome?.storage?.local?.remove) {
    await chrome.storage.local.remove([storageKey]);
  }

  watchlistDispatchTokenCache = null;
  const resolved = await resolveWatchlistDispatchToken(true);
  return {
    success: true,
    hasToken: !!resolved.token,
    source: resolved.source
  };
}

async function sendWatchlistDispatch(payload, copyTrace = 'no-run/no-response') {
  if (!WATCHLIST_DISPATCH.enabled) {
    return { skipped: true, reason: 'dispatch_disabled' };
  }

  const dispatchConfig = await resolveWatchlistDispatchConfiguration();
  if (!dispatchConfig.ok) {
    return { skipped: true, reason: dispatchConfig.reason || 'missing_dispatch_credentials' };
  }

  const repository = dispatchConfig.repository;
  const url = `${WATCHLIST_DISPATCH.apiBaseUrl.replace(/\/+$/, '')}/repos/${repository}/dispatches`;
  const body = JSON.stringify({
    event_type: WATCHLIST_DISPATCH.eventType,
    client_payload: payload
  });

  const maxAttempts = Math.max(1, Number(WATCHLIST_DISPATCH.retryCount || 0) + 1);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WATCHLIST_DISPATCH.timeoutMs);
    try {
      console.log(`[copy-flow] [dispatch:attempt] trace=${copyTrace} attempt=${attempt}/${maxAttempts}`);
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${dispatchConfig.token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json'
        },
        body,
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}${errorText ? ` ${errorText}` : ''}`);
      }

      console.log(`[copy-flow] [dispatch:ok] trace=${copyTrace} status=${response.status}`);
      return { success: true, status: response.status };
    } catch (error) {
      clearTimeout(timeoutId);
      if (attempt < maxAttempts) {
        console.warn(
          `[copy-flow] [dispatch:retry] trace=${copyTrace} attempt=${attempt}/${maxAttempts} error=${error.message || String(error)}`
        );
        await sleep(WATCHLIST_DISPATCH.backoffMs * attempt);
        continue;
      }
      console.error(
        `[copy-flow] [dispatch:failed] trace=${copyTrace} attempts=${maxAttempts} error=${error.message || String(error)}`
      );
      return { success: false, error: error.message || String(error) };
    }
  }

  return { success: false, error: 'unknown' };
}

async function flushWatchlistDispatchOutbox(reason = 'manual') {
  if (!WATCHLIST_DISPATCH.enabled) {
    return { skipped: true, reason: 'dispatch_disabled' };
  }
  if (watchlistDispatchFlushInProgress) {
    return { skipped: true, reason: 'flush_in_progress' };
  }

  watchlistDispatchFlushInProgress = true;
  try {
    const queued = await readWatchlistOutbox();
    if (queued.length === 0) {
      return { success: true, sent: 0, failed: 0, deferred: 0, remaining: 0 };
    }

    const remaining = [];
    let sent = 0;
    let failed = 0;
    let deferred = 0;
    const now = Date.now();

    for (const item of queued) {
      if (!item || typeof item !== 'object' || !item.payload || typeof item.payload !== 'object') {
        failed += 1;
        continue;
      }

      const nextAttemptAt = Number.isInteger(item.nextAttemptAt) ? item.nextAttemptAt : 0;
      if (nextAttemptAt > now) {
        deferred += 1;
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
      remaining.push({
        ...item,
        attemptCount,
        nextAttemptAt: Date.now() + retryDelayMs,
        lastError: dispatchResult.reason || dispatchResult.error || 'dispatch_failed'
      });
    }

    const persisted = await writeWatchlistOutbox(remaining);
    console.log(
      `[copy-flow] [dispatch:flush] reason=${reason} sent=${sent} failed=${failed} deferred=${deferred} remaining=${persisted.length}`
    );
    return { success: true, sent, failed, deferred, remaining: persisted.length };
  } finally {
    watchlistDispatchFlushInProgress = false;
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

async function uploadResponseToCloud(response) {
  if (!CLOUD_UPLOAD.enabled) {
    return { skipped: true, reason: "disabled" };
  }
  if (!CLOUD_UPLOAD.url) {
    console.warn("[cloud] Upload enabled but URL is empty");
    return { skipped: true, reason: "missing_url" };
  }

  const headers = {
    "Content-Type": "application/json"
  };

  if (CLOUD_UPLOAD.apiKey) {
    if ((CLOUD_UPLOAD.apiKeyHeader || "").toLowerCase() === "authorization") {
      headers.Authorization = `Bearer ${CLOUD_UPLOAD.apiKey}`;
    } else {
      headers[CLOUD_UPLOAD.apiKeyHeader] = CLOUD_UPLOAD.apiKey;
    }
  }

  const payload = {
    schema: "economist.response.v1",
    text: response.text,
    timestamp: response.timestamp,
    source: response.source,
    analysisType: response.analysisType,
    runId: response.runId || null,
    responseId: response.responseId || null,
    savedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version
  };
  const copyTrace = buildCopyTrace(response.runId || '', response.responseId || '');
  const copyFingerprint = textFingerprint(response.text || '');
  console.log(`[copy-flow] [upload:start] trace=${copyTrace} len=${(response.text || '').length} fp=${copyFingerprint}`);

  const maxAttempts = Math.max(1, CLOUD_UPLOAD.retryCount + 1);
  const body = JSON.stringify(payload);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CLOUD_UPLOAD.timeoutMs);

    try {
      console.log(`[copy-flow] [upload:attempt] trace=${copyTrace} attempt=${attempt}/${maxAttempts}`);
      const response = await fetch(CLOUD_UPLOAD.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      console.log(`[copy-flow] [upload:ok] trace=${copyTrace} status=${response.status}`);
      return { success: true, status: response.status };
    } catch (error) {
      clearTimeout(timeoutId);

      if (attempt < maxAttempts) {
        console.warn(`[copy-flow] [upload:retry] trace=${copyTrace} attempt=${attempt}/${maxAttempts} error=${error.message || String(error)}`);
        await sleep(CLOUD_UPLOAD.backoffMs * attempt);
        continue;
      }

      console.error(`[copy-flow] [upload:failed] trace=${copyTrace} attempts=${maxAttempts} error=${error.message || String(error)}`);
      return { success: false, error: error.message || String(error) };
    }
  }

  return { success: false, error: "unknown" };
}

// Funkcja wczytująca prompty z plików txt
async function loadPrompts() {
  try {
    console.log("📝 Wczytuję prompty z plików...");
    
    // Wczytaj prompts-company.txt
    const companyUrl = chrome.runtime.getURL('prompts-company.txt');
    const companyResponse = await fetch(companyUrl);
    const companyText = await companyResponse.text();
    
    // Parsuj prompty (oddzielone ◄PROMPT_SEPARATOR►)
    PROMPTS_COMPANY = companyText
      .split('◄PROMPT_SEPARATOR►')
      .map(p => p.trim())
      .filter(p => p.length > 0);
    
    console.log(`✅ Wczytano ${PROMPTS_COMPANY.length} promptów dla analizy spółki`);
    
    // Wczytaj prompts-portfolio.txt
    const portfolioUrl = chrome.runtime.getURL('prompts-portfolio.txt');
    const portfolioResponse = await fetch(portfolioUrl);
    const portfolioText = await portfolioResponse.text();
    
    // Parsuj prompty (oddzielone ◄PROMPT_SEPARATOR►)
    PROMPTS_PORTFOLIO = portfolioText
      .split('◄PROMPT_SEPARATOR►')
      .map(p => p.trim())
      .filter(p => p.length > 0);
    
    console.log(`✅ Wczytano ${PROMPTS_PORTFOLIO.length} promptów dla analizy portfela`);
    
  } catch (error) {
    console.error('❌ Błąd wczytywania promptów:', error);
    // Ustaw puste tablice jako fallback
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
flushWatchlistDispatchOutbox('service_worker_boot').catch((error) => {
  console.warn('[copy-flow] [dispatch:flush-error] reason=service_worker_boot', error);
});

// Obsługiwane źródła artykułów
const SUPPORTED_SOURCES = [
  { pattern: "https://*.economist.com/*", name: "The Economist" },
  { pattern: "https://asia.nikkei.com/*", name: "Nikkei Asia" },
  { pattern: "https://*.caixinglobal.com/*", name: "Caixin Global" },
  { pattern: "https://*.theafricareport.com/*", name: "The Africa Report" },
  { pattern: "https://*.nzz.ch/*", name: "NZZ" },
  { pattern: "https://*.project-syndicate.org/*", name: "Project Syndicate" },
  { pattern: "https://the-ken.com/*", name: "The Ken" },
  { pattern: "https://www.youtube.com/*", name: "YouTube" },
  { pattern: "https://youtu.be/*", name: "YouTube" },
  { pattern: "https://*.wsj.com/*", name: "Wall Street Journal" },
  { pattern: "https://*.barrons.com/*", name: "Barron's" },
  { pattern: "https://*.foreignaffairs.com/*", name: "Foreign Affairs" },
  { pattern: "https://open.spotify.com/*", name: "Spotify" }
];

// Funkcja zwracająca tablicę URLi do query
function getSupportedSourcesQuery() {
  return SUPPORTED_SOURCES.map(s => s.pattern);
}

// Tworzenie menu kontekstowego przy instalacji
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "view-responses",
    title: "Poka� zebrane odpowiedzi",
    contexts: ["all"]
  });
  ensureWatchlistDispatchAlarm();
  flushWatchlistDispatchOutbox('on_installed').catch((error) => {
    console.warn('[copy-flow] [dispatch:flush-error] reason=on_installed', error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  ensureWatchlistDispatchAlarm();
  flushWatchlistDispatchOutbox('on_startup').catch((error) => {
    console.warn('[copy-flow] [dispatch:flush-error] reason=on_startup', error);
  });
});

if (chrome?.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm || alarm.name !== WATCHLIST_DISPATCH.alarmName) return;
    flushWatchlistDispatchOutbox('alarm').catch((error) => {
      console.warn('[copy-flow] [dispatch:flush-error] reason=alarm', error);
    });
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
async function saveResponse(responseText, source, analysisType = 'company', runId = null, responseId = null) {
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

    console.log(`[copy-flow] [save:upload] trace=${copyTrace} responseId=${normalizedResponseId}`);
    const uploadResult = await uploadResponseToCloud({ ...newResponse });
    if (uploadResult?.success) {
      console.log(`[cloud] Upload OK (status ${uploadResult.status})`);
      console.log(`[copy-flow] [save:upload-ok] trace=${copyTrace} status=${uploadResult.status}`);
    } else if (uploadResult?.skipped) {
      console.log(`[cloud] Upload skipped (${uploadResult.reason || "unknown"})`);
      console.log(`[copy-flow] [save:upload-skipped] trace=${copyTrace} reason=${uploadResult.reason || "unknown"}`);
    } else {
      console.warn(`[cloud] Upload failed: ${uploadResult?.error || "unknown"}`);
      console.warn(`[copy-flow] [save:upload-failed] trace=${copyTrace} error=${uploadResult?.error || "unknown"}`);
    }

    const dispatchQueueResult = await enqueueWatchlistDispatch(newResponse, copyTrace);
    if (dispatchQueueResult?.queued) {
      console.log(
        `[copy-flow] [dispatch:queued-ok] trace=${copyTrace} responseId=${dispatchQueueResult.responseId} queueSize=${dispatchQueueResult.queueSize}`
      );
      const flushResult = await flushWatchlistDispatchOutbox('save_response');
      console.log(
        `[copy-flow] [dispatch:flush-result] trace=${copyTrace} sent=${flushResult?.sent || 0} failed=${flushResult?.failed || 0} remaining=${flushResult?.remaining || 0}`
      );
    } else if (dispatchQueueResult?.skipped) {
      console.log(
        `[copy-flow] [dispatch:queued-skipped] trace=${copyTrace} reason=${dispatchQueueResult.reason || 'unknown'}`
      );
    }

    console.log(`\n${'*'.repeat(80)}`);
    console.log(`✅ ✅ ✅ [saveResponse] ZAPISANO I ZWERYFIKOWANO POMYŚLNIE ✅ ✅ ✅`);
    console.log(`${'*'.repeat(80)}`);
    console.log(`Nowy stan: ${verifiedResponses.length} odpowiedzi w storage (zweryfikowano: ${verifiedResponses.length})`);
    console.log(`Preview: "${responseText.substring(0, 150)}..."`);
    console.log(`${'*'.repeat(80)}\n`);
    return newResponse;
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
    saveResponse(message.text, message.source, message.analysisType, message.runId, message.responseId);
  } else if (message.type === 'RUN_ANALYSIS') {
    const invocationWindowId = Number.isInteger(message?.windowId)
      ? message.windowId
      : (Number.isInteger(sender?.tab?.windowId) ? sender.tab.windowId : null);
    runAnalysis({
      invocationWindowId,
      stopExistingInWindow: true
    }).catch((error) => {
      console.error('[run] RUN_ANALYSIS failed:', error);
    });
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
    console.log('📩 Otrzymano MANUAL_SOURCE_SUBMIT:', { 
      titleLength: message.title?.length, 
      textLength: message.text?.length, 
      instances: message.instances 
    });
    runManualSourceAnalysis(message.text, message.title, message.instances);
    sendResponse({ success: true });
    return true; // Utrzymuj kanał otwarty dla async
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
  } else if (message.type === 'SET_WATCHLIST_DISPATCH_TOKEN') {
    setWatchlistDispatchToken(message?.token)
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
    runResetScanStartAllTabs({
      origin: typeof message?.origin === 'string' ? message.origin : 'runtime-message'
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
    resumeFromStage(message.startIndex)
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

    if (!isChatGptUrl(activeTab.url || '')) {
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

    const resumed = await resumeFromStageOnTab(activeTab.id, activeTab.windowId, startIndex, {
      processTitle
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
      const isManualSource = tab.url === "manual://source";
      let extractedText;
      let transcriptLang = null; // Może być ustawiony przez YouTube content script
      
      if (isManualSource) {
        // Użyj tekstu przekazanego bezpośrednio
        extractedText = tab.manualText;
        console.log(`[${analysisType}] [${index + 1}/${tabs.length}] Używam ręcznie wklejonego tekstu: ${extractedText?.length || 0} znaków`);
        
        // Dla manual source: brak walidacji długości (zgodnie z planem)
        if (!extractedText || extractedText.length === 0) {
          console.log(`[${analysisType}] [${index + 1}/${tabs.length}] Pominięto - pusty tekst`);
          return { success: false, reason: 'pusty tekst' };
        }
      } else {
        // Wykryj źródło najpierw, aby wiedzieć czy to YouTube
        const url = new URL(tab.url);
        const hostname = url.hostname;
        let isYouTube = hostname.includes('youtube.com') || hostname.includes('youtu.be');
        
        if (isYouTube) {
          // === YOUTUBE: Użyj content script przez sendMessage ===
          console.log(`[${analysisType}] [${index + 1}/${tabs.length}] YouTube wykryty - używam content script`);
          
          try {
            const response = await chrome.tabs.sendMessage(tab.id, {
              type: 'GET_TRANSCRIPT'
            });
            
            console.log(`[${analysisType}] [${index + 1}/${tabs.length}] Odpowiedź z content script:`, {
              length: response.transcript?.length || 0,
              method: response.method,
              error: response.error
            });
            
            if (!response.transcript) {
              console.error(`[${analysisType}] [${index + 1}/${tabs.length}] Brak transkrypcji: ${response.error || 'unknown'}`);
              return { success: false, reason: `YouTube: ${response.error || 'no transcript'}` };
            }
            
            extractedText = response.transcript;
            transcriptLang = response.lang || response.langName || 'unknown';
            
            console.log(`[${analysisType}] [${index + 1}/${tabs.length}] ✓ Transkrypcja: ${extractedText.length} znaków, język: ${transcriptLang}, metoda: ${response.method}`);
            
          } catch (e) {
            console.error(`[${analysisType}] [${index + 1}/${tabs.length}] ❌ Błąd komunikacji z content script:`, e);
            return { success: false, reason: 'YouTube: content script error' };
          }
          
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
          return { success: false, reason: 'za mało tekstu' };
        }
      }

      // Pobierz tytuł
      const title = tab.title || "Bez tytułu";
      processTitle = title;
      
      // Wykryj źródło artykułu (dla non-YouTube lub dla payload metadata)
      let sourceName;
      
      if (isManualSource) {
        sourceName = "Manual Source";
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
      const companyPromptCatalog = (analysisType === 'company')
        ? buildPromptSignatureCatalog(PROMPTS_COMPANY)
        : null;

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
        sourceUrl: isManualSource ? 'manual://source' : (tab.url || ''),
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
            }
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
          statusText: `Auto-reload ${autoRecoveryAttempt}/${AUTO_RECOVERY_MAX_ATTEMPTS}`,
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

        console.warn(`[${analysisType}] [${index + 1}/${tabs.length}] Auto-recovery ${autoRecoveryAttempt}/${AUTO_RECOVERY_MAX_ATTEMPTS} (${recoveryReasonBase}) dla prompta ${recoveryCurrentPrompt}`);
        const reloadResult = await forceReloadTab(chatTabId, {
          timeoutMs: AUTO_RECOVERY_RELOAD_TIMEOUT_MS,
          bypassCache: true
        });
        if (!reloadResult.ok) {
          console.warn('[auto-recovery] Nie udalo sie potwierdzic reloadu karty:', reloadResult);
        }
        await sleep(AUTO_RECOVERY_DELAY_MS);

        let alignedState = {
          applied: false,
          reason: 'base_state',
          promptOffset: nextPromptOffset,
          remainingPrompts: nextRemainingPrompts
        };
        if (analysisType === 'company') {
          const detectedRecoveryPoint = await detectCompanyRecoveryPointFromLastMessage(
            chatTabId,
            nextPromptOffset,
            companyPromptCatalog
          );
          alignedState = alignExecutionStateWithDetectedPrompt(
            nextPromptOffset,
            nextRemainingPrompts,
            detectedRecoveryPoint
          );

          if (alignedState.applied) {
            const syncedCurrentPrompt = Number.isInteger(alignedState.promptOffset) && alignedState.promptOffset >= 0
              ? alignedState.promptOffset + 1
              : recoveryCurrentPrompt;
            const syncedStageIndex = syncedCurrentPrompt > 0 ? (syncedCurrentPrompt - 1) : null;
            await upsertProcess(processId, {
              title: processTitle,
              analysisType,
              status: 'running',
              needsAction: false,
              currentPrompt: syncedCurrentPrompt,
              totalPrompts: processTotalPrompts,
              ...(Number.isInteger(syncedStageIndex) ? { stageIndex: syncedStageIndex } : {}),
              ...(syncedCurrentPrompt > 0 ? { stageName: `Prompt ${syncedCurrentPrompt}` } : {}),
              statusText: `Auto-recovery sync: prompt ${syncedCurrentPrompt}`,
              reason: 'auto_recovery_sync_last_message',
              autoRecovery: {
                attempt: autoRecoveryAttempt,
                maxAttempts: AUTO_RECOVERY_MAX_ATTEMPTS,
                delayMs: AUTO_RECOVERY_DELAY_MS,
                reason: recoveryReasonBase,
                currentPrompt: syncedCurrentPrompt,
                ...(Number.isInteger(syncedStageIndex) ? { stageIndex: syncedStageIndex } : {}),
                updatedAt: Date.now()
              },
              timestamp: Date.now()
            });
          }
        }

        executionPayload = '';
        executionPromptChain = alignedState.remainingPrompts;
        executionPromptOffset = alignedState.promptOffset;
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
        
        const savedResponse = await saveResponse(resultLastResponse, title, analysisType, processId);
        if (Object.keys(completedResponsePatch).length > 0) {
          completedResponsePatch.completedResponseSaved = !!savedResponse;
        }
        
        console.log(`✅ ✅ ✅ saveResponse ZAKOŃCZONY ✅ ✅ ✅`);
        console.log(`${'='.repeat(80)}\n`);
      } else if (result && result.success && !hasResultLastResponse) {
        console.warn(`\n⚠️ ⚠️ ⚠️ Proces SUKCES ale lastResponse jest pusta lub null ⚠️ ⚠️ ⚠️`);
        console.warn(`lastResponse: "${result.lastResponse}" (długość: ${result.lastResponse?.length || 0})`);
        finalStatusText = 'Zakonczono (pusta odpowiedz)';
        finalReason = 'empty_response';
        console.log(`${'='.repeat(80)}\n`);
      } else if (result && !result.success) {
        console.warn(`\n⚠️ ⚠️ ⚠️ Proces zakończony BEZ SUKCESU (success=false) ⚠️ ⚠️ ⚠️`);
        finalStatus = 'failed';
        finalStatusText = 'Blad procesu';
        finalReason = 'inject_failed';
        finalError = result?.error || '';
        console.log(`${'='.repeat(80)}\n`);
      } else {
        console.error(`\n❌ ❌ ❌ NIEOCZEKIWANY STAN ❌ ❌ ❌`);
        console.error(`hasResult: ${!!result}`);
        console.error(`success: ${result?.success}`);
        console.error(`lastResponse: ${result?.lastResponse}`);
        finalStatus = 'failed';
        finalStatusText = 'Nieoczekiwany wynik';
        finalReason = 'invalid_result';
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

      console.log(`[${analysisType}] [${index + 1}/${tabs.length}] ✅ Rozpoczęto przetwarzanie: ${title}`);
      return { success: true, title };

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
      const stopResult = await stopActiveProcesses({
        windowId: invocationWindowId,
        reason: 'restarted_in_same_window',
        statusText: 'Zatrzymano przez ponowne uruchomienie',
        origin: 'run-analysis-restart'
      });
      if (stopResult.stopped > 0) {
        console.log(`[run] Zatrzymano ${stopResult.stopped} aktywnych procesow w oknie ${invocationWindowId}`);
        await sleep(250);
      }
    }
    
    // KROK 1: Sprawdź czy prompty są wczytane
    console.log("\n📝 Krok 1: Sprawdzanie promptów");
    if (PROMPTS_COMPANY.length === 0) {
      console.error("❌ Brak promptów dla analizy spółki w prompts-company.txt");
      alert("Błąd: Brak promptów dla analizy spółki. Sprawdź plik prompts-company.txt");
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
      alert("Nie znaleziono otwartych artykułów z obsługiwanych źródeł.\n\nObsługiwane źródła:\n- The Economist\n- Nikkei Asia\n- Caixin Global\n- The Africa Report\n- NZZ\n- Project Syndicate\n- The Ken\n- Wall Street Journal\n- Foreign Affairs\n- YouTube");
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
async function runManualSourceAnalysis(text, title, instances) {
  try {
    console.log("\n=== ROZPOCZYNAM ANALIZĘ Z RĘCZNEGO ŹRÓDŁA ===");
    console.log(`Tytuł: ${title}`);
    console.log(`Tekst: ${text.length} znaków`);
    console.log(`Instancje: ${instances}`);
    
    // Sprawdź czy prompty są wczytane
    if (PROMPTS_COMPANY.length === 0) {
      console.error("❌ Brak promptów dla analizy spółki");
      alert("Błąd: Brak promptów dla analizy spółki. Sprawdź plik prompts-company.txt");
      return;
    }
    
    console.log(`✅ Prompty załadowane: ${PROMPTS_COMPANY.length}`);
    
    // Stwórz pseudo-taby (N kopii tego samego źródła)
    const timestamp = Date.now();
    const pseudoTabs = [];
    
    for (let i = 0; i < instances; i++) {
      pseudoTabs.push({
        id: `manual-${timestamp}-${i}`,
        title: title,
        url: "manual://source",
        manualText: text  // Przechowuj tekst bezpośrednio
      });
    }
    
    console.log(`✅ Utworzono ${pseudoTabs.length} pseudo-tabów`);
    
    // Uruchom proces analizy
    await processArticles(pseudoTabs, PROMPTS_COMPANY, CHAT_URL, 'company');
    
    console.log("\n✅ ZAKOŃCZONO URUCHAMIANIE ANALIZY Z RĘCZNEGO ŹRÓDŁA");
    
  } catch (error) {
    console.error("❌ Błąd w runManualSourceAnalysis:", error);
  }
}

// Uwaga: chrome.action.onClicked NIE działa gdy jest default_popup w manifest
// Ikona uruchamia popup, a popup wysyła message RUN_ANALYSIS

// Funkcja ekstrakcji tekstu (content script) - tylko dla non-YouTube sources
// YouTube używa dedykowanego content script (youtube-content.js)
async function extractText() {
  const hostname = window.location.hostname;
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
    'open.spotify.com': [
      '.NavBar__NavBarPage-sc-1guraqe-0.ejVULV',
      '.NavBar__NavBarPage-sc-1guraqe-0',
      'article',
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
    '.article-content',
    '#content'
  ];
  selectorsToTry = [...selectorsToTry, ...universalSelectors];
  
  // Próbuj ekstrahować tekst
  for (const selector of selectorsToTry) {
    const element = document.querySelector(selector);
    if (element) {
      const text = element.innerText || element.textContent;
      if (text && text.length > 100) {
        console.log(`Znaleziono tekst przez selector: ${selector}, długość: ${text.length}`);
        return text;
      }
    }
  }
  
  // Fallback: cała strona
  const bodyText = document.body.innerText || document.body.textContent;
  console.log(`Fallback do body, długość: ${bodyText.length}`);
  return bodyText;
}

// Funkcja wklejania do ChatGPT (content script)
async function injectToChat(payload, promptChain, textareaWaitMs, responseWaitMs, retryIntervalMs, articleTitle, analysisType = 'company', runId = null, progressContext = null, autoRecoveryContext = null) {
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
    const forceStopResult = () => ({
      success: false,
      lastResponse: '',
      error: 'force_stopped',
      stopped: true,
      reason: forceStopReason,
      origin: forceStopOrigin
    });

    // Shared helpers for injected context
    function compactText(text) {
      return (text || '').replace(/\s+/g, ' ').trim();
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
        `Auto-reload ${nextAttempt}/${autoRecoveryMaxAttempts} za ${delaySec}s...`
      );
      notifyProcess('PROCESS_PROGRESS', {
        status: 'running',
        currentPrompt: safePrompt,
        totalPrompts: totalPromptsForRun,
        stageIndex: safeStageIndex,
        stageName,
        statusText: `Auto-reload ${nextAttempt}/${autoRecoveryMaxAttempts}`,
        reason: `auto_recovery_${reason}`,
        needsAction: false
      });

      return buildAutoRecoveryHandoff(reason, localPromptIndex, promptChainSnapshot);
    }

    function getPromptProbeFragment(promptText) {
      if (typeof promptText !== 'string') return '';
      return compactText(promptText).slice(0, 60);
    }

    function getPromptDomSnapshot() {
      const userMessages = document.querySelectorAll('[data-message-author-role="user"]');
      const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
      const lastUser = userMessages.length > 0 ? userMessages[userMessages.length - 1] : null;
      const lastAssistant = assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1] : null;
      return {
        userCount: userMessages.length,
        assistantCount: assistantMessages.length,
        lastUserText: compactText(lastUser ? (lastUser.innerText || lastUser.textContent || '') : ''),
        lastAssistantText: compactText(lastAssistant ? (lastAssistant.innerText || lastAssistant.textContent || '') : '')
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
      if (!prevText && !nextText) return false;
      if (prevText !== nextText && Math.abs(nextText.length - prevText.length) >= minDelta) {
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
      const errorCandidates = [
        ...document.querySelectorAll('[class*="text"]'),
        ...document.querySelectorAll('[role="alert"]'),
        ...document.querySelectorAll('[class*="error"]')
      ];
      for (const node of errorCandidates) {
        const text = compactText(node?.textContent || '');
        if (!text) continue;
        const lowered = text.toLowerCase();
        if (
          lowered.includes('something went wrong while generating the response') ||
          lowered === 'something went wrong' ||
          lowered.includes('an error occurred while generating') ||
          lowered.includes('network error') ||
          (
            lowered.includes('streaming interrupted') &&
            lowered.includes('waiting for the complete message')
          )
        ) {
          return true;
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
        if (userAdvanced && userMatchesPrompt) {
          return true;
        }

        if (hasAssistantAdvancedSince(base, 20)) {
          return true;
        }

        const generation = isGenerating();
        if (generation.generating) {
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
        if (validateResponse(extracted) || compactText(extracted).length > 0) {
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
  function createCounter() {
    const counter = document.createElement('div');
    counter.id = 'economist-prompt-counter';
    
    // Pobierz zapisaną pozycję i stan z localStorage
    const savedPosition = JSON.parse(localStorage.getItem('economist-counter-position') || '{"top": "20px", "right": "20px"}');
    const isMinimized = localStorage.getItem('economist-counter-minimized') === 'true';
    
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
      min-width: ${isMinimized ? '60px' : '200px'};
      cursor: ${isMinimized ? 'pointer' : 'default'};
      transition: all 0.3s ease;
    `;
    
    // Utwórz kontener nagłówka (dla przeciągania)
    const header = document.createElement('div');
    header.style.cssText = `
      padding: 8px 12px;
      cursor: move;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: ${isMinimized ? 'none' : '1px solid rgba(255,255,255,0.3)'};
      user-select: none;
    `;
    
    const dragHandle = document.createElement('span');
    dragHandle.textContent = '⋮⋮';
    dragHandle.style.cssText = 'opacity: 0.7; font-size: 16px;';
    
    const minimizeBtn = document.createElement('button');
    minimizeBtn.textContent = isMinimized ? '□' : '−';
    minimizeBtn.style.cssText = `
      background: none;
      border: none;
      color: white;
      font-size: 18px;
      cursor: pointer;
      padding: 0;
      width: 20px;
      height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0.7;
      transition: opacity 0.2s;
    `;
    minimizeBtn.onmouseover = () => minimizeBtn.style.opacity = '1';
    minimizeBtn.onmouseout = () => minimizeBtn.style.opacity = '0.7';
    
    header.appendChild(dragHandle);
    header.appendChild(minimizeBtn);
    counter.appendChild(header);
    
    // Utwórz kontener zawartości
    const content = document.createElement('div');
    content.id = 'economist-counter-content';
    content.style.cssText = `
      padding: ${isMinimized ? '0' : '8px 24px 16px 24px'};
      text-align: center;
      display: ${isMinimized ? 'none' : 'block'};
    `;
    counter.appendChild(content);
    
    // Obsługa minimalizacji
    minimizeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isCurrentlyMinimized = content.style.display === 'none';
      
      if (isCurrentlyMinimized) {
        content.style.display = 'block';
        counter.style.minWidth = '200px';
        counter.style.cursor = 'default';
        header.style.borderBottom = '1px solid rgba(255,255,255,0.3)';
        content.style.padding = '8px 24px 16px 24px';
        minimizeBtn.textContent = '−';
        localStorage.setItem('economist-counter-minimized', 'false');
      } else {
        content.style.display = 'none';
        counter.style.minWidth = '60px';
        counter.style.cursor = 'pointer';
        header.style.borderBottom = 'none';
        content.style.padding = '0';
        minimizeBtn.textContent = '□';
        localStorage.setItem('economist-counter-minimized', 'true');
      }
    });
    
    // Obsługa przeciągania
    let isDragging = false;
    let startX, startY, startLeft, startTop;
    
    header.addEventListener('mousedown', (e) => {
      if (e.target === minimizeBtn) return;
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      
      const rect = counter.getBoundingClientRect();
      startLeft = rect.left;
      startTop = rect.top;
      
      counter.style.transition = 'none';
      e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      
      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;
      
      const newLeft = startLeft + deltaX;
      const newTop = startTop + deltaY;
      
      counter.style.left = `${newLeft}px`;
      counter.style.right = 'auto';
      counter.style.top = `${newTop}px`;
    });
    
    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        counter.style.transition = 'all 0.3s ease';
        
        // Zapisz pozycję do localStorage
        const position = {
          top: counter.style.top,
          left: counter.style.left
        };
        localStorage.setItem('economist-counter-position', JSON.stringify(position));
      }
    });
    
    // Kliknięcie w zminimalizowany licznik rozwinięć
    counter.addEventListener('click', () => {
      if (content.style.display === 'none') {
        minimizeBtn.click();
      }
    });
    
    document.body.appendChild(counter);
    return counter;
  }
  
  // Funkcja aktualizująca licznik
  function updateCounter(counter, current, total, status = '') {
    const content = document.getElementById('economist-counter-content');
    if (!content) return;
    
    if (current === 0) {
      content.innerHTML = `
        <div style="font-size: 16px; margin-bottom: 4px;">📝 Przetwarzanie artykułu</div>
        <div style="font-size: 12px; opacity: 0.9;">${status}</div>
      `;
    } else {
      const percent = Math.round((current / total) * 100);
      content.innerHTML = `
        <div style="font-size: 16px; margin-bottom: 4px;">Prompt Chain</div>
        <div style="font-size: 24px; margin-bottom: 4px;">${current} / ${total}</div>
        <div style="background: rgba(255,255,255,0.3); height: 6px; border-radius: 3px; margin-bottom: 4px;">
          <div style="background: white; height: 100%; border-radius: 3px; width: ${percent}%; transition: width 0.3s;"></div>
        </div>
        <div style="font-size: 12px; opacity: 0.9;">${status}</div>
      `;
    }
  }
  
  // Funkcja usuwająca licznik
  function removeCounter(counter, success = true) {
    if (success) {
      const content = document.getElementById('economist-counter-content');
      if (content) {
        content.innerHTML = `
          <div style="font-size: 18px;">🎉 Zakończono!</div>
        `;
        content.style.display = 'block';
        content.style.padding = '8px 24px 16px 24px';
        counter.style.minWidth = '200px';
      }
      setTimeout(() => counter.remove(), 3000);
    } else {
      counter.remove();
    }
  }
  
  // Funkcja próbująca naprawić błąd przez Edit+Resend
  async function tryEditResend() {
    try {
      console.log('🔧 [tryEditResend] Próbuję naprawić przez Edit+Resend...');
      
      // === 1. ZNAJDŹ OSTATNIĄ WIADOMOŚĆ UŻYTKOWNIKA ===
      console.log('🔍 [tryEditResend] Szukam ostatniej wiadomości użytkownika...');
      
      // Próba 1: standardowy selektor
      let userMessages = document.querySelectorAll('[data-message-author-role="user"]');
      console.log(`  Próba 1: [data-message-author-role="user"] → ${userMessages.length} wyników`);
      
      // Fallback 1: conversation-turn containers
      if (userMessages.length === 0) {
        console.log('  Próba 2: szukam w conversation-turn containers...');
        const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
        console.log(`    Znaleziono ${turns.length} conversation turns`);
        userMessages = Array.from(turns).filter(turn => 
          turn.querySelector('[data-message-author-role="user"]')
        );
        console.log(`    Znaleziono ${userMessages.length} user turns`);
      }
      
      // Fallback 2: szukaj przez article + klasy
      if (userMessages.length === 0) {
        console.log('  Próba 3: szukam przez article[class*="message"]...');
        const allMessages = document.querySelectorAll('article, [class*="message"], [class*="Message"]');
        console.log(`    Znaleziono ${allMessages.length} potencjalnych wiadomości`);
        userMessages = Array.from(allMessages).filter(msg => {
          const role = msg.getAttribute('data-message-author-role');
          const hasUserIndicator = msg.querySelector('[data-message-author-role="user"]') ||
                                   msg.textContent?.includes('You') ||
                                   msg.classList.toString().includes('user');
          return role === 'user' || hasUserIndicator;
        });
        console.log(`    Znaleziono ${userMessages.length} user messages`);
      }
      
      if (userMessages.length === 0) {
        console.warn('❌ [tryEditResend] Brak wiadomości użytkownika - nie mogę znaleźć Edit');
        return false;
      }
      
      const lastUserMessage = userMessages[userMessages.length - 1];
      console.log(`✓ [tryEditResend] Znaleziono ostatnią wiadomość użytkownika (${userMessages.length} total)`);
      
      // === 2. SYMULUJ HOVER ŻEBY POKAZAĆ EDIT ===
      console.log('🖱️ [tryEditResend] Symuluję hover aby pokazać Edit...');
      lastUserMessage.dispatchEvent(new MouseEvent('mouseenter', { 
        view: window,
        bubbles: true, 
        cancelable: true 
      }));
      lastUserMessage.dispatchEvent(new MouseEvent('mouseover', { 
        view: window,
        bubbles: true, 
        cancelable: true 
      }));
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // === 3. ZNAJDŹ PRZYCISK EDIT ===
      console.log('🔍 [tryEditResend] Szukam przycisku Edit...');
      
      let editButton = null;
      const editSelectors = [
        'button[aria-label="Edit message"]',
        'button[aria-label*="Edit"]',
        'button.right-full[aria-label*="Edit"]',
        'button[aria-label*="Edytuj"]',  // Polska lokalizacja
        'button[title*="Edit"]',
        'button[title*="edit"]'
      ];
      
      for (const selector of editSelectors) {
        editButton = lastUserMessage.querySelector(selector);
        if (editButton) {
          console.log(`✓ [tryEditResend] Znaleziono Edit przez: ${selector}`);
          break;
        }
      }
      
      // Fallback 1: conversation-turn container
      if (!editButton) {
        console.log('  Fallback 1: szukam w conversation-turn container...');
        const turnContainer = lastUserMessage.closest('[data-testid^="conversation-turn-"]');
        if (turnContainer) {
          for (const selector of editSelectors) {
            editButton = turnContainer.querySelector(selector);
            if (editButton) {
              console.log(`✓ [tryEditResend] Znaleziono Edit w turn container przez: ${selector}`);
              break;
            }
          }
        }
      }
      
      // Fallback 2: toolbar
      if (!editButton) {
        console.log('  Fallback 2: szukam w toolbar...');
        const toolbar = lastUserMessage.querySelector('[role="toolbar"]') ||
                       lastUserMessage.querySelector('[class*="toolbar"]');
        if (toolbar) {
          for (const selector of editSelectors) {
            editButton = toolbar.querySelector(selector);
            if (editButton) {
              console.log(`✓ [tryEditResend] Znaleziono Edit w toolbar przez: ${selector}`);
              break;
            }
          }
        }
      }
      
      if (!editButton) {
        console.warn('❌ [tryEditResend] Nie znaleziono przycisku Edit');
        return false;
      }
      
      // Usuń klasy ukrywające i wymuś widoczność
      if (editButton.classList.contains('invisible')) {
        editButton.classList.remove('invisible');
        console.log('  ✓ Usunięto klasę invisible');
      }
      if (editButton.classList.contains('hidden')) {
        editButton.classList.remove('hidden');
        console.log('  ✓ Usunięto klasę hidden');
      }
      
      const originalStyle = editButton.style.cssText;
      editButton.style.visibility = 'visible';
      editButton.style.display = 'block';
      
      console.log('👆 [tryEditResend] Klikam przycisk Edit...');
      editButton.click();
      
      setTimeout(() => {
        editButton.style.cssText = originalStyle;
      }, 100);
      
      // === 4. CZEKAJ NA EDYTOR I ZNAJDŹ SEND W KONTEKŚCIE ===
      console.log('⏳ [tryEditResend] Czekam na pojawienie się edytora po Edit...');
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Znajdź conversation turn container dla kontekstu
      const turnContainer = lastUserMessage.closest('[data-testid^="conversation-turn-"]') ||
                           lastUserMessage.closest('[class*="turn"]') ||
                           lastUserMessage.closest('article') ||
                           lastUserMessage.parentElement;
      
      console.log('🔍 [tryEditResend] Szukam przycisku Send w kontekście edytowanej wiadomości...');
      
      const sendSelectors = [
        '[data-testid="send-button"]',
        'button[aria-label="Send"]',
        'button[aria-label*="Send"]',
        'button[name="Send"]',
        'button[type="submit"]',
        '#composer-submit-button',
        'button[data-testid*="send"]'
      ];
      
      // Aktywne czekanie na Send button (max 10s)
      let sendButton = null;
      const maxWaitForSend = 10000;
      const checkInterval = 100;
      const maxIterations = maxWaitForSend / checkInterval;
      
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        // Najpierw szukaj w turn container
        for (const selector of sendSelectors) {
          sendButton = turnContainer.querySelector(selector);
          if (sendButton && !sendButton.disabled) {
            console.log(`✓ [tryEditResend] Znaleziono Send w turn container po ${iteration * checkInterval}ms: ${selector}`);
            break;
          }
        }
        
        // Jeśli nie znaleziono, szukaj w całym dokumencie
        if (!sendButton) {
          for (const selector of sendSelectors) {
            sendButton = document.querySelector(selector);
            if (sendButton && !sendButton.disabled) {
              console.log(`✓ [tryEditResend] Znaleziono Send globalnie po ${iteration * checkInterval}ms: ${selector}`);
              break;
            }
          }
        }
        
        if (sendButton) break;
        
        if (iteration > 0 && iteration % 10 === 0) {
          console.log(`  ⏳ Czekam na Send... ${iteration * checkInterval}ms / ${maxWaitForSend}ms`);
        }
        
        await new Promise(resolve => setTimeout(resolve, checkInterval));
      }
      
      if (!sendButton) {
        console.warn('❌ [tryEditResend] Nie znaleziono przycisku Send po Edit');
        return false;
      }
      
      if (sendButton.disabled) {
        console.warn('⚠️ [tryEditResend] Przycisk Send jest disabled');
        return false;
      }
      
      console.log('👆 [tryEditResend] Klikam przycisk Send...');
      sendButton.click();
      
      // === 5. WERYFIKACJA WYSŁANIA ===
      console.log('🔍 [tryEditResend] Weryfikuję czy prompt został wysłany...');
      let verified = false;
      const maxVerifyTime = 3000;
      const verifyInterval = 100;
      const maxVerifyIterations = maxVerifyTime / verifyInterval;
      
      for (let iteration = 0; iteration < maxVerifyIterations; iteration++) {
        const editor = document.querySelector('[role="textbox"]') || 
                      document.querySelector('[contenteditable]');
        
        // Fallbacki dla stopButton
        const stopBtn = document.querySelector('button[aria-label*="Stop"]') || 
                       document.querySelector('[data-testid="stop-button"]') ||
                       document.querySelector('button[aria-label*="stop"]') ||
                       document.querySelector('button[aria-label="Zatrzymaj"]');
        
        const currentSendBtn = document.querySelector('[data-testid="send-button"]') ||
                              document.querySelector('button[aria-label="Send"]');
        
        const editorDisabled = editor && editor.getAttribute('contenteditable') === 'false';
        const editorEmpty = editor && (editor.textContent || '').trim().length === 0;
        const sendDisabled = currentSendBtn && currentSendBtn.disabled;
        
        // Weryfikacja DOM
        const messages = document.querySelectorAll('[data-message-author-role]');
        const hasMessages = messages.length > 0;
        
        // GŁÓWNY wskaźnik: stopButton (najbardziej pewny)
        const hasStopButton = !!stopBtn;
        
        // ALTERNATYWNY: interface zablokowany + wiadomości w DOM
        const interfaceBlocked = (editorDisabled || (editorEmpty && sendDisabled)) && hasMessages;
        
        if (hasStopButton || interfaceBlocked) {
          verified = true;
          console.log(`✅ [tryEditResend] Weryfikacja SUKCES po ${iteration * verifyInterval}ms:`, {
            stopBtn: !!stopBtn,
            editorDisabled,
            editorEmpty,
            sendDisabled,
            hasMessages,
            msgCount: messages.length
          });
          break;
        }
        
        if (iteration > 0 && iteration % 5 === 0) {
          console.log(`  ⏳ Weryfikacja... ${iteration * verifyInterval}ms / ${maxVerifyTime}ms`);
        }
        
        await new Promise(resolve => setTimeout(resolve, verifyInterval));
      }
      
      if (!verified) {
        console.warn(`⚠️ [tryEditResend] Weryfikacja FAILED - prompt może nie zostać wysłany po ${maxVerifyTime}ms`);
        return false;
      }
      
      console.log('✅ [tryEditResend] Edit+Resend wykonane pomyślnie i zweryfikowane');
      return true;
      
    } catch (error) {
      console.error('❌ [tryEditResend] Błąd:', error);
      return false;
    }
  }
  
  // Funkcja sprawdzająca czy ChatGPT generuje odpowiedź (rozszerzona detekcja)
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
    console.log("⏳ Czekam na odpowiedź ChatGPT...");
    
    // ===== FAZA 1: Detekcja STARTU odpowiedzi =====
    // Czekaj aż ChatGPT zacznie generować odpowiedź
    // Chain-of-thought model może myśleć 4-5 min przed startem
    const phase1StartTime = Date.now(); // ✅ OSOBNY timer dla FAZY 1
    let responseStarted = false;
    let editAttemptedPhase1 = false; // Flaga: czy już próbowaliśmy Edit w tej fazie
    const checkedFixedErrorsPhase1 = new Set(); // Cache dla już sprawdzonych i naprawionych błędów
    const startTimeout = Math.min(maxWaitMs, 7200000); // 120 minut na start (zwiększono dla długich deep thinking sessions)
    
    console.log(`📊 [FAZA 1] Timeout dla detekcji startu: ${Math.round(startTimeout/1000)}s (${Math.round(startTimeout/60000)} min)`);
    
    while (Date.now() - phase1StartTime < startTimeout) {
      if (shouldStopNow()) return false;
      if (hasStreamingInterruptedState()) {
        console.error('❌ [FAZA 1] Wykryto przerwany stream odpowiedzi (Stopped thinking / Streaming interrupted).');
        return false;
      }

      // Sprawdź czy pojawił się komunikat błędu - TYLKO OSTATNI
      const errorMessages = document.querySelectorAll('[class*="text"]');
      
      // Znajdź ostatni komunikat błędu (od końca)
      let lastErrorMsg = null;
      let lastErrorIndex = -1;
      for (let i = errorMessages.length - 1; i >= 0; i--) {
        const msg = errorMessages[i];
        if (msg.textContent.includes('Something went wrong while generating the response') || 
            msg.textContent.includes('Something went wrong')) {
          lastErrorMsg = msg;
          lastErrorIndex = i;
          break; // Zatrzymaj się na pierwszym (ostatnim) znalezionym
        }
      }
      
      // Jeśli znaleziono błąd, sprawdź czy nie został już naprawiony
      if (lastErrorMsg) {
        // Unikalne ID błędu (pozycja + fragment tekstu)
        const errorId = `${lastErrorIndex}_${lastErrorMsg.textContent.substring(0, 50)}`;
        
        // Jeśli już sprawdzaliśmy ten błąd i był naprawiony - pomiń bez logowania
        if (checkedFixedErrorsPhase1.has(errorId)) {
          // Ciche pominięcie - nie spamuj logów
        } else {
          // Pierwszy raz widzimy ten błąd - sprawdź go
          console.log(`🔍 [FAZA 1] Znaleziono ostatni komunikat błędu (${lastErrorIndex + 1}/${errorMessages.length})`);
          
          // Znajdź kontener błędu w strukturze DOM
          const errorContainer = lastErrorMsg.closest('article') || 
                                lastErrorMsg.closest('[data-testid^="conversation-turn-"]') ||
                                lastErrorMsg.closest('[class*="message"]') ||
                                lastErrorMsg.parentElement;
          
          // Sprawdź czy po błędzie jest już nowa odpowiedź assistant
          const allMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
          let errorAlreadyFixed = false;
          
          if (errorContainer && allMessages.length > 0) {
            const lastAssistantMsg = allMessages[allMessages.length - 1];
            
            // Porównaj pozycję błędu z ostatnią odpowiedzią
            try {
              const errorPosition = errorContainer.compareDocumentPosition(lastAssistantMsg);
              
              // Jeśli ostatnia odpowiedź jest AFTER błędu (Node.DOCUMENT_POSITION_FOLLOWING = 4)
              if (errorPosition & Node.DOCUMENT_POSITION_FOLLOWING) {
                errorAlreadyFixed = true;
                console.log('✓ [FAZA 1] Błąd już naprawiony - jest nowa odpowiedź po nim, pomijam');
                // Dodaj do cache żeby nie sprawdzać ponownie
                checkedFixedErrorsPhase1.add(errorId);
              }
            } catch (e) {
              console.warn('⚠️ [FAZA 1] Nie udało się porównać pozycji błędu:', e);
            }
          }
          
          // Jeśli błąd został naprawiony, pomiń całą logikę Edit/Retry
          if (!errorAlreadyFixed) {
          // Jeśli już próbowaliśmy Edit - NIE próbuj ponownie
          if (editAttemptedPhase1) {
            console.log('⚠️ [FAZA 1] Błąd wykryty ale editAttempted=true - pomijam Edit, szukam Retry...');
          } else {
            console.log('⚠️ [FAZA 1] Znaleziono komunikat błędu - uruchamiam retry loop Edit+Resend...');
            editAttemptedPhase1 = true; // Oznacz że próbujemy
            
            // Retry loop: max 3 próby Edit+Resend
            let editSuccess = false;
            for (let attempt = 1; attempt <= 3 && !editSuccess; attempt++) {
              console.log(`🔧 [FAZA 1] Próba ${attempt}/3 wywołania tryEditResend()...`);
              editSuccess = await tryEditResend();
              console.log(`📊 [FAZA 1] Próba ${attempt}/3: ${editSuccess ? '✅ SUKCES' : '❌ PORAŻKA'}`);
              
              if (editSuccess) {
                console.log('✅ [FAZA 1] Edit+Resend SUKCES - przerywam retry loop');
                break;
              }
              
              if (!editSuccess && attempt < 3) {
                console.log(`⏳ [FAZA 1] Próba ${attempt} nieudana, czekam 2s przed kolejną...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
              }
            }
            
            if (editSuccess) {
              console.log('✅ [FAZA 1] Naprawiono przez Edit+Resend - kontynuuję czekanie...');
              await new Promise(resolve => setTimeout(resolve, 2000));
              continue; // Kontynuuj czekanie w tej samej pętli
            }
            
            console.log('⚠️ [FAZA 1] Wszystkie 3 próby Edit+Resend nieudane, próbuję Retry button...');
          }
          
          // Jeśli Edit nie zadziałał (lub już próbowaliśmy), spróbuj Retry
          console.log('🔍 [FAZA 1] Szukam przycisku Retry...');
          let retryButton = lastErrorMsg.parentElement?.querySelector('button[aria-label="Retry"]');
          if (!retryButton) {
            retryButton = lastErrorMsg.closest('[class*="group"]')?.querySelector('button[aria-label="Retry"]');
          }
          if (!retryButton) {
            // Szukaj w całym dokumencie jako fallback
            retryButton = document.querySelector('button[aria-label="Retry"]');
          }
          
          if (retryButton) {
            console.log('🔄 [FAZA 1] Klikam przycisk Retry - wznawiam czekanie na odpowiedź...');
            retryButton.click();
            await new Promise(resolve => setTimeout(resolve, 2000));
            // Zwróć false aby zewnętrzna pętla wywołała waitForResponse ponownie (jak Continue)
            return false;
          } else {
            console.warn('⚠️ [FAZA 1] Nie znaleziono przycisku Retry');
          }
          }
        }
      }
      
      // Użyj rozszerzonej funkcji wykrywania generowania
      const genStatus = isGenerating();
      
      // Weryfikacja: Czy faktycznie jest nowa aktywność w DOM?
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
      
      // ChatGPT zaczął odpowiadać jeśli:
      // 1. isGenerating() wykryło wskaźniki generowania (stop/thinking/update/streaming)
      // 2. LUB jest nowa treść w DOM (faktyczna odpowiedź)
      
      if (genStatus.generating || hasNewContent || meaningfulTextChange) {
        console.log("✓ ChatGPT zaczął odpowiadać", {
          generating: genStatus.generating,
          reason: genStatus.reason,
          hasNewContent: hasNewContent,
          lastTextChanged: lastTextChanged,
          lengthDelta: lengthDelta,
          meaningfulTextChange: meaningfulTextChange,
          initialAssistantCount: initialAssistantCount,
          assistantMsgCount: assistantMessages.length
        });
        responseStarted = true;
        break;
      }
      
      // Loguj co 30s że czekamy z rozszerzonym statusem
      if ((Date.now() - phase1StartTime) % 30000 < 500) {
        const elapsed = Math.round((Date.now() - phase1StartTime) / 1000);
        const currentGenStatus = isGenerating();
        console.log(`⏳ [FAZA 1] Czekam na start odpowiedzi... (${elapsed}s)`, {
          generating: currentGenStatus.generating,
          reason: currentGenStatus.reason,
          hasNewContent: hasNewContent,
          lastTextChanged: lastTextChanged,
          lengthDelta: lengthDelta,
          meaningfulTextChange: meaningfulTextChange,
          assistantMsgCount: assistantMessages.length,
          initialAssistantCount: initialAssistantCount
        });
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    const phase1Duration = Math.round((Date.now() - phase1StartTime) / 1000);
    console.log(`📊 [FAZA 1] Zakończona po ${phase1Duration}s (${Math.round(phase1Duration/60)} min)`);
    
    if (!responseStarted) {
      console.error(`❌ [FAZA 1] ChatGPT nie zaczął odpowiadać po ${Math.round(startTimeout/1000)}s - prompt prawdopodobnie nie został wysłany!`);
      return false;
    }
    
    // ===== FAZA 2: Detekcja ZAKOŃCZENIA odpowiedzi =====
    // Czekaj aż ChatGPT skończy i interface będzie gotowy na kolejny prompt
    const phase2StartTime = Date.now(); // ✅ NOWY timer dla FAZY 2 (niezależny od FAZY 1!)
    const phase2Timeout = Math.min(maxWaitMs, 7200000); // 120 minut na zakończenie (zwiększono dla długich deep thinking sessions)
    let consecutiveReady = 0;
    let logInterval = 0;
    let lastAssistantText = initialAssistantText;
    let lastAssistantChangeAt = Date.now();
    let editAttemptedPhase2 = false; // Flaga: czy już próbowaliśmy Edit w tej fazie
    const checkedFixedErrors = new Set(); // Cache dla już sprawdzonych i naprawionych błędów
    
    console.log(`📊 [FAZA 2] Timeout dla detekcji zakończenia: ${Math.round(phase2Timeout/1000)}s (${Math.round(phase2Timeout/60000)} min)`);
    
    while (Date.now() - phase2StartTime < phase2Timeout) {
      if (shouldStopNow()) return false;
      if (hasStreamingInterruptedState()) {
        console.error('❌ [FAZA 2] Wykryto przerwany stream odpowiedzi (Stopped thinking / Streaming interrupted).');
        return false;
      }

      // Sprawdź czy pojawił się komunikat błędu - TYLKO OSTATNI
      const errorMessages = document.querySelectorAll('[class*="text"]');
      
      // Znajdź ostatni komunikat błędu (od końca)
      let lastErrorMsg = null;
      let lastErrorIndex = -1;
      for (let i = errorMessages.length - 1; i >= 0; i--) {
        const msg = errorMessages[i];
        if (msg.textContent.includes('Something went wrong while generating the response') || 
            msg.textContent.includes('Something went wrong')) {
          lastErrorMsg = msg;
          lastErrorIndex = i;
          break; // Zatrzymaj się na pierwszym (ostatnim) znalezionym
        }
      }
      
      // Jeśli znaleziono błąd, sprawdź czy nie został już naprawiony
      if (lastErrorMsg) {
        // Unikalne ID błędu (pozycja + fragment tekstu)
        const errorId = `${lastErrorIndex}_${lastErrorMsg.textContent.substring(0, 50)}`;
        
        // Jeśli już sprawdzaliśmy ten błąd i był naprawiony - pomiń bez logowania
        if (checkedFixedErrors.has(errorId)) {
          // Ciche pominięcie - nie spamuj logów
        } else {
          // Pierwszy raz widzimy ten błąd - sprawdź go
          console.log(`🔍 [FAZA 2] Znaleziono ostatni komunikat błędu (${lastErrorIndex + 1}/${errorMessages.length})`);
          
          // Znajdź kontener błędu w strukturze DOM
          const errorContainer = lastErrorMsg.closest('article') || 
                                lastErrorMsg.closest('[data-testid^="conversation-turn-"]') ||
                                lastErrorMsg.closest('[class*="message"]') ||
                                lastErrorMsg.parentElement;
          
          // Sprawdź czy po błędzie jest już nowa odpowiedź assistant
          const allMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
          let errorAlreadyFixed = false;
          
          if (errorContainer && allMessages.length > 0) {
            const lastAssistantMsg = allMessages[allMessages.length - 1];
            
            // Porównaj pozycję błędu z ostatnią odpowiedzią
            try {
              const errorPosition = errorContainer.compareDocumentPosition(lastAssistantMsg);
              
              // Jeśli ostatnia odpowiedź jest AFTER błędu (Node.DOCUMENT_POSITION_FOLLOWING = 4)
              if (errorPosition & Node.DOCUMENT_POSITION_FOLLOWING) {
                errorAlreadyFixed = true;
                console.log('✓ [FAZA 2] Błąd już naprawiony - jest nowa odpowiedź po nim, pomijam');
                // Dodaj do cache żeby nie sprawdzać ponownie
                checkedFixedErrors.add(errorId);
              }
            } catch (e) {
              console.warn('⚠️ [FAZA 2] Nie udało się porównać pozycji błędu:', e);
            }
          }
          
          // Jeśli błąd został naprawiony, pomiń całą logikę Edit/Retry
          if (!errorAlreadyFixed) {
          // Jeśli już próbowaliśmy Edit - NIE próbuj ponownie
          if (editAttemptedPhase2) {
            console.log('⚠️ [FAZA 2] Błąd wykryty ale editAttempted=true - pomijam Edit, szukam Retry...');
          } else {
            console.log('⚠️ [FAZA 2] Znaleziono komunikat błędu - uruchamiam retry loop Edit+Resend...');
            editAttemptedPhase2 = true; // Oznacz że próbujemy
            
            // Retry loop: max 3 próby Edit+Resend
            let editSuccess = false;
            for (let attempt = 1; attempt <= 3 && !editSuccess; attempt++) {
              console.log(`🔧 [FAZA 2] Próba ${attempt}/3 wywołania tryEditResend()...`);
              editSuccess = await tryEditResend();
              console.log(`📊 [FAZA 2] Próba ${attempt}/3: ${editSuccess ? '✅ SUKCES' : '❌ PORAŻKA'}`);
              
              if (editSuccess) {
                console.log('✅ [FAZA 2] Edit+Resend SUKCES - przerywam retry loop');
                break;
              }
              
              if (!editSuccess && attempt < 3) {
                console.log(`⏳ [FAZA 2] Próba ${attempt} nieudana, czekam 2s przed kolejną...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
              }
            }
            
            if (editSuccess) {
              console.log('✅ [FAZA 2] Naprawiono przez Edit+Resend - kontynuuję czekanie...');
              await new Promise(resolve => setTimeout(resolve, 2000));
              continue; // Kontynuuj czekanie w tej samej pętli
            }
            
            console.log('⚠️ [FAZA 2] Wszystkie 3 próby Edit+Resend nieudane, próbuję Retry button...');
          }
          
          // Jeśli Edit nie zadziałał (lub już próbowaliśmy), spróbuj Retry
          console.log('🔍 [FAZA 2] Szukam przycisku Retry...');
          let retryButton = lastErrorMsg.parentElement?.querySelector('button[aria-label="Retry"]');
          if (!retryButton) {
            retryButton = lastErrorMsg.closest('[class*="group"]')?.querySelector('button[aria-label="Retry"]');
          }
          if (!retryButton) {
            // Szukaj w całym dokumencie jako fallback
            retryButton = document.querySelector('button[aria-label="Retry"]');
          }
          
          if (retryButton) {
            console.log('🔄 [FAZA 2] Klikam przycisk Retry - wznawiam czekanie na odpowiedź...');
            retryButton.click();
            await new Promise(resolve => setTimeout(resolve, 2000));
            // Zwróć false aby zewnętrzna pętla wywołała waitForResponse ponownie (jak Continue)
            return false;
          } else {
            console.warn('⚠️ [FAZA 2] Nie znaleziono przycisku Retry');
          }
          }
        }
      }
      
      // Szukaj wszystkich elementów interfejsu
      const editor = document.querySelector('[role="textbox"][contenteditable="true"]') ||
                     document.querySelector('div[contenteditable="true"]') ||
                     document.querySelector('[data-testid="composer-input"][contenteditable="true"]');
      
      const sendButton = document.querySelector('[data-testid="send-button"]') ||
                        document.querySelector('#composer-submit-button') ||
                        document.querySelector('button[aria-label="Send"]') ||
                        document.querySelector('button[aria-label*="Send"]');
      
      // Użyj rozszerzonej funkcji wykrywania generowania
      const genStatus = isGenerating();
      
      // Co 10 iteracji (5s) loguj stan
      if (logInterval % 10 === 0) {
        const phase2Elapsed = Math.round((Date.now() - phase2StartTime) / 1000);
        console.log(`🔍 [FAZA 2] Stan interfejsu:`, {
          editor_exists: !!editor,
          editor_enabled: editor?.getAttribute('contenteditable') === 'true',
          generating: genStatus.generating,
          genReason: genStatus.reason,
          sendButton_exists: !!sendButton,
          sendButton_disabled: sendButton?.disabled,
          consecutiveReady: consecutiveReady,
          elapsed: phase2Elapsed + 's'
        });
      }
      logInterval++;
      
      // ===== WARUNKI GOTOWOŚCI =====
      // Interface jest gotowy gdy ChatGPT skończył generować:
      // 1. BRAK wskaźników generowania (isGenerating() == false)
      // 2. Editor ISTNIEJE i jest ENABLED (contenteditable="true")
      // 3. BRAK wskaźników "thinking" w ostatniej wiadomości
      // 
      // UWAGA: SendButton może nie istnieć gdy editor jest pusty - sprawdzimy go dopiero w sendPrompt()
      
      const editorReady = editor && editor.getAttribute('contenteditable') === 'true';
      const noGeneration = !genStatus.generating;
      
      // Sprawdź czy nie ma wskaźników "thinking" w ostatniej wiadomości
      const lastMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
      const lastAssistantMsg = lastMessages.length > 0 ? lastMessages[lastMessages.length - 1] : null;
      const currentLastText = lastAssistantMsg ? compactText(lastAssistantMsg.innerText || lastAssistantMsg.textContent || '') : '';
      if (currentLastText && currentLastText !== lastAssistantText) {
        lastAssistantText = currentLastText;
        lastAssistantChangeAt = Date.now();
      }
      const hasNewAssistantMessage = lastMessages.length > initialAssistantCount;
      const lastTextChanged = currentLastText && currentLastText !== initialAssistantText;
      const lengthDelta = Math.abs(currentLastText.length - initialAssistantLength);
      const meaningfulTextChange = lastTextChanged && lengthDelta >= MIN_RESPONSE_DELTA;
      if (hasNewAssistantMessage || meaningfulTextChange) {
        responseSeenInDOM = true;
      }
      const textStable = Date.now() - lastAssistantChangeAt >= 2500;
      const hasThinkingInMessage = lastAssistantMsg && lastAssistantMsg.querySelector('[class*="thinking"]');
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
        consecutiveReady++;
        console.log(`✓ [FAZA 2] Interface ready (${consecutiveReady}/1) - warunki OK`);
        
        // Potwierdź stan przez 1 sprawdzenie (0.5s)
        // Zmniejszono z 3 do 1 dla szybszej reakcji (oszczędza 1s na każdy prompt)
        if (consecutiveReady >= 1) {
          console.log("✅ ChatGPT zakończył odpowiedź - interface gotowy");
          // Dodatkowe czekanie dla stabilizacji UI
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          // WERYFIKACJA: Sprawdź czy faktycznie jest jakaś odpowiedź w DOM (max 1 próba)
          console.log("🔍 Weryfikuję obecność odpowiedzi w DOM...");
          let domCheckAttempts = 0;
          const MAX_DOM_CHECKS = 1;
          
          while (domCheckAttempts < MAX_DOM_CHECKS) {
            const messages = document.querySelectorAll('[data-message-author-role="assistant"]');
            const articles = document.querySelectorAll('article');
            
            if (messages.length > 0 || articles.length > 0) {
              console.log(`✓ Znaleziono ${messages.length} wiadomości assistant i ${articles.length} articles`);
              return true;
            }
            
            domCheckAttempts++;
            console.warn(`⚠️ DOM check ${domCheckAttempts}/${MAX_DOM_CHECKS} - brak odpowiedzi, czekam 1s...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
          
          // Po 1 próbie (1s) - zakładamy że OK, walidacja później wyłapie błąd
          console.warn("⚠️ DOM nie gotowy po 1 próbie (1s), ale kontynuuję - walidacja tekstu wyłapie jeśli faktyczny błąd");
          return true;
        }
      } else {
        // Reset licznika jeśli którykolwiek warunek nie jest spełniony
        if (consecutiveReady > 0) {
          console.log(`⚠️ Interface NOT ready, resetuję licznik (był: ${consecutiveReady})`);
          console.log(`  Powód: noGeneration=${noGeneration}, editorReady=${editorReady}, hasThinkingInMessage=${hasThinkingInMessage}, responseSeenInDOM=${responseSeenInDOM}, textStable=${textStable}, minResponseLengthReached=${minResponseLengthReached}, hasProgressText=${hasProgressText}`);
          if (genStatus.generating) {
            console.log(`  Detekcja generowania: ${genStatus.reason}`);
          }
        }
        consecutiveReady = 0;
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    const phase2Duration = Math.round((Date.now() - phase2StartTime) / 1000);
    console.error(`❌ [FAZA 2] TIMEOUT czekania na zakończenie odpowiedzi po ${phase2Duration}s (${Math.round(phase2Duration/60)} min)`);
    console.error(`📊 Łączny czas (FAZA 1 + FAZA 2): ${phase1Duration + phase2Duration}s (${Math.round((phase1Duration + phase2Duration)/60)} min)`);
    return false;
  }

  // Funkcja sprawdzająca czy ChatGPT działa (brak błędów połączenia)
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
  async function sendPrompt(promptText, maxWaitForReady = responseWaitMs, counter = null, promptIndex = 0, promptTotal = 0) {
    if (shouldStopNow()) return false;
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
    const interfaceReady = await waitForInterfaceReady(maxWaitForReady, counter, promptIndex, promptTotal); // Pełny timeout (domyślnie 60 minut)
    
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
        // Normalny tryb - wyślij payload (artykuł)
        updateCounter(counter, promptOffset, totalPromptsForRun, 'Wysyłam artykuł...');
        
        // Wyślij tekst Economist
        console.log("📤 Wysyłam artykuł do ChatGPT...");
        await sendPrompt(payload, responseWaitMs, counter, promptOffset, totalPromptsForRun);
        if (shouldStopNow()) {
          return forceStopResult();
        }
        
        // Czekaj na odpowiedź ChatGPT
        updateCounter(counter, promptOffset, totalPromptsForRun, 'Czekam na odpowiedź...');
        await waitForResponse(responseWaitMs);
        if (shouldStopNow()) {
          return forceStopResult();
        }
        console.log("✅ Artykuł przetworzony");

        // Pobierz odpowiedź Stage 0 do wstawienia w kolejne prompty
        stage0Response = await getLastResponseText();
        if (stage0Response && stage0Response.trim().length > 0) {
          console.log(`🧩 Stage 0 captured (${stage0Response.length} znaków) - będzie wstawione w prompt chain`);
        } else {
          console.warn('⚠️ Nie udało się pobrać Stage 0 (pusty tekst) - prompt chain bez wstawienia');
          stage0Response = '';
        }
        
        // NIE zapisujemy początkowej odpowiedzi - zapisujemy tylko ostatnią z prompt chain
        
        // Anti-automation delay przed prompt chain - czekanie na gotowość jest w sendPrompt
        const delay = getRandomDelay();
        console.log(`⏸️ Anti-automation delay: ${(delay/1000).toFixed(1)}s przed rozpoczęciem prompt chain...`);
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
        
        const resumeInterfaceReady = await waitForInterfaceReady(responseWaitMs, counter, promptOffset, totalPromptsForRun);
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
          return { success: false, lastResponse: '', error: 'Interface nie gotowy w trybie resume' };
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
          const sent = await sendPrompt(prompt, responseWaitMs, counter, absoluteCurrentPrompt, totalPromptsForRun);
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
            } else {
            
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
                continue; // Pomiń resztę tego prompta, idź do następnego
              }
            
              // User naprawił, spróbuj wysłać ponownie ten sam prompt
              console.log(`🔄 Kontynuacja po naprawie - ponowne wysyłanie prompta ${i + 1}...`);
              const retried = await sendPrompt(prompt, responseWaitMs, counter, absoluteCurrentPrompt, totalPromptsForRun);
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
                return { success: false, lastResponse: '', error: 'Nie udało się wysłać prompta po retry' };
              }
            
              console.log(`✅ Ponowne wysyłanie udane - kontynuuję chain`);
            }
          }
          
          // Aktualizuj licznik - czekanie
          updateCounter(counter, absoluteCurrentPrompt, totalPromptsForRun, 'Czekam na odpowiedź...');
          
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
              updateCounter(counter, absoluteCurrentPrompt, totalPromptsForRun, '⏱️ Timeout - czekam...');
              const timeoutOutcome = await classifyTimeoutOutcome(promptSnapshotBeforeSend, prompt);
              if (timeoutOutcome === 'response_ready') {
                console.warn(`⚠️ Timeout heurystyki, ale wykryto odpowiedź - pomijam auto-reload dla prompta ${absoluteCurrentPrompt}`);
                responseCompleted = true;
                break;
              }
              if (timeoutOutcome === 'still_generating') {
                console.warn(`⚠️ Timeout heurystyki, ale ChatGPT nadal generuje - kontynuuję czekanie bez auto-reload`);
                updateCounter(counter, absoluteCurrentPrompt, totalPromptsForRun, '⏳ ChatGPT nadal generuje...');
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
              updateCounter(counter, absoluteCurrentPrompt, totalPromptsForRun, 'Czekam na odpowiedź...');
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
              updateCounter(counter, absoluteCurrentPrompt, totalPromptsForRun, '❌ Odpowiedź za krótka');
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
              updateCounter(counter, absoluteCurrentPrompt, totalPromptsForRun, 'Czekam na odpowiedź...');
              
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
              console.log(`💾 Przygotowano ostatnią odpowiedź z prompta ${i + 1}/${promptChain.length} do zapisu (${window._lastResponseToSave.length} znaków)`);
              console.log(`[copy-flow] [capture:last-prompt] prompt=${absoluteCurrentPrompt} len=${window._lastResponseToSave.length} fp=${captureFingerprint} rawLen=${rawResponseText.length} rawFp=${rawFingerprint} changed=${window._lastResponseToSave !== rawResponseText}`);
            } else {
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
        removeCounter(counter, true);
        
        // Zwróć ostatnią odpowiedź do zapisania
        const lastResponse = window._lastResponseToSave || '';
        delete window._lastResponseToSave;
        console.log(`🔙 Zwracam odpowiedź do zapisu (${lastResponse.length} znaków)`);
        console.log(`[copy-flow] [capture:return] prompt=${promptChain.length} len=${lastResponse.length} fp=${computeCopyFingerprint(lastResponse)}`);
        const completedPrompt = getAbsolutePromptIndex(promptChain.length);
        const selectedPrompt = completedPrompt;
        const selectedStageIndex = selectedPrompt > 0 ? (selectedPrompt - 1) : null;
        notifyProcess('PROCESS_PROGRESS', {
          status: 'completed',
          currentPrompt: completedPrompt,
          totalPrompts: totalPromptsForRun,
          stageIndex: completedPrompt > 0 ? (completedPrompt - 1) : null,
          stageName: completedPrompt > 0 ? `Prompt ${completedPrompt}` : 'Start',
          statusText: 'Zakonczono',
          needsAction: false
        });
        
        return {
          success: true,
          lastResponse: lastResponse,
          selectedResponsePrompt: selectedPrompt,
          selectedResponseStageIndex: selectedStageIndex,
          selectedResponseReason: 'last_prompt'
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
        return { success: true, lastResponse: '' };
      }
      
      // Ten return nigdy nie powinien zostać osiągnięty
      return { success: false, lastResponse: '', error: 'unexpected_code_path' };
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
  return { success: false, lastResponse: '', error: 'Nie znaleziono textarea' };
  
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
    return { success: false, error: `Critical error: ${error.message}` };
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


