const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ProcessContractUtils = require('./process-contract.js');

const backgroundPath = path.join(__dirname, 'background.js');
const backgroundSource = fs.readFileSync(backgroundPath, 'utf8');

function extractFunctionSource(source, functionName) {
  const pattern = new RegExp(`(?:async\\s+)?function\\s+${functionName}\\s*\\(`);
  const match = pattern.exec(source);
  if (!match) {
    throw new Error(`Function not found: ${functionName}`);
  }
  const startIndex = match.index;
  const paramsStart = source.indexOf('(', match.index);
  if (paramsStart < 0) {
    throw new Error(`Function params not found: ${functionName}`);
  }

  let parenDepth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;
  let braceStart = -1;

  for (let i = paramsStart; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inSingle) {
      if (!escaped && char === '\\') {
        escaped = true;
        continue;
      }
      if (!escaped && char === '\'') inSingle = false;
      escaped = false;
      continue;
    }
    if (inDouble) {
      if (!escaped && char === '\\') {
        escaped = true;
        continue;
      }
      if (!escaped && char === '"') inDouble = false;
      escaped = false;
      continue;
    }
    if (inTemplate) {
      if (!escaped && char === '\\') {
        escaped = true;
        continue;
      }
      if (!escaped && char === '`') inTemplate = false;
      escaped = false;
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (char === '\'') {
      inSingle = true;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      continue;
    }
    if (char === '`') {
      inTemplate = true;
      continue;
    }

    if (char === '(') {
      parenDepth += 1;
      continue;
    }
    if (char === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        braceStart = source.indexOf('{', i);
        break;
      }
    }
  }

  if (braceStart < 0) {
    throw new Error(`Function body not found: ${functionName}`);
  }

  let depth = 0;
  inSingle = false;
  inDouble = false;
  inTemplate = false;
  inLineComment = false;
  inBlockComment = false;
  escaped = false;

  for (let i = braceStart; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inSingle) {
      if (!escaped && char === '\\') {
        escaped = true;
        continue;
      }
      if (!escaped && char === '\'') inSingle = false;
      escaped = false;
      continue;
    }
    if (inDouble) {
      if (!escaped && char === '\\') {
        escaped = true;
        continue;
      }
      if (!escaped && char === '"') inDouble = false;
      escaped = false;
      continue;
    }
    if (inTemplate) {
      if (!escaped && char === '\\') {
        escaped = true;
        continue;
      }
      if (!escaped && char === '`') inTemplate = false;
      escaped = false;
      continue;
    }

    if (char === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (char === '\'') {
      inSingle = true;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      continue;
    }
    if (char === '`') {
      inTemplate = true;
      continue;
    }

    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startIndex, i + 1);
      }
    }
  }

  throw new Error(`Function end not found: ${functionName}`);
}

async function main() {
  const timers = [];
  const clearedTimers = [];
  const createCalls = [];
  const clearCalls = [];
  const auditLogs = [];
  const queueEventLogs = [];
  const reconcileRequests = [];
  let removeAttempt = 0;

  const context = vm.createContext({
    console,
    Date,
    Math,
    Number,
    String,
    Array,
    URL,
    JSON,
    Map,
    Set,
    ProcessContractUtils,
    CHAT_GPT_HOSTS: new Set([
      'chatgpt.com',
      'www.chatgpt.com',
      'chat.openai.com',
      'www.chat.openai.com'
    ]),
    PROCESS_WINDOW_CLOSE_RETRY: {
      enabled: true,
      initialDelayMs: 1500,
      maxDelayMs: 60 * 1000,
      maxAttempts: 24,
      alarmName: 'completed-process-window-close-retry'
    },
    processRegistry: new Map(),
    processWindowCloseRetryTimersByRunId: new Map(),
    processWindowCloseRetryAttemptCountByRunId: new Map(),
    processWindowCloseRetryDueAtByRunId: new Map(),
    processWindowCloseRetryInFlight: new Set(),
    chrome: {
      alarms: {
        create(name, info) {
          createCalls.push({ name, info });
        }
      },
      tabs: {
        query: async () => []
      }
    },
    clearAlarmSafe: async (alarmName) => {
      clearCalls.push(alarmName);
      return true;
    },
    normalizeWatchlistVerifyState(value) {
      return typeof value === 'string' ? value.trim().toLowerCase() : '';
    },
    ensureProcessRegistryReady: async () => {},
    pruneProcessRecords: (records) => (Array.isArray(records) ? records : []),
    getTabByIdSafe: async () => ({
      id: 11,
      windowId: 22,
      url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/project'
    }),
    queryTabsInWindowSafe: async () => ({
      ok: true,
      tabs: [
        {
          id: 11,
          windowId: 22,
          url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/project'
        }
      ],
      reason: ''
    }),
    removeTabSafe: async () => {
      removeAttempt += 1;
      return removeAttempt >= 2;
    },
    removeWindowSafe: async () => false,
    upsertProcess: async (runId, patch) => {
      const current = context.processRegistry.get(runId) || { id: runId };
      const next = {
        ...current,
        ...patch,
        windowClose: patch?.windowClose ? { ...(current.windowClose || {}), ...patch.windowClose } : current.windowClose
      };
      context.processRegistry.set(runId, next);
      return next;
    },
    reportAnalysisQueueEvent: async (event, payload) => {
      queueEventLogs.push({ event, payload });
      return true;
    },
    requestAnalysisQueueReconcile: (reason) => {
      reconcileRequests.push(reason);
    },
    emitWatchlistDispatchProcessLog(level, code, message, details) {
      auditLogs.push({ level, code, message, details });
    },
    clearCompletedProcessPersistenceRetry: () => {},
    setTimeout(callback, delayMs) {
      const id = timers.length + 1;
      timers.push({ id, callback, delayMs });
      return id;
    },
    clearTimeout(id) {
      clearedTimers.push(id);
    }
  });

  [
    'normalizeChatConversationUrl',
    'isChatGptUrl',
    'getTabEffectiveUrl',
    'isChromeMissingTabOrWindowError',
    'getChatConversationCloseKey',
    'collectProcessConversationCloseKeys',
    'isProcessTabCloseTarget',
    'findOpenProcessTabByConversationUrl',
    'normalizeProcessLifecycleStatus',
    'normalizeProcessStatus',
    'isClosedProcessStatus',
    'resolveProcessStageSnapshot',
    'hasProcessReachedFinalStage',
    'buildCopyTrace',
    'extractResponseIdFromCopyTrace',
    'collectKnownProcessResponseIds',
    'buildProcessCopyTrace',
    'normalizeWatchlistEventId',
    'createDeliveredDispatchSnapshot',
    'truncateDispatchLogText',
    'mergeDispatchProcessLogs',
    'formatDispatchUiSummary',
    'isExplicitlyVerifiedDispatch',
    'resolveSaveResponseDispatchPipelineState',
    'resolveSaveResponsePersistenceState',
    'summarizeFinalStagePersistence',
    'getProcessPersistenceDispatchSnapshot',
    'getProcessQueueDeliveryState',
    'hasProcessCloseableSavedResponse',
    'isDataGapTerminalProcess',
    'isProcessWindowAutoCloseEnabled',
    'hasProcessWindowCloseContext',
    'isTerminalQueueProcessWindowCloseCandidate',
    'normalizeProcessWindowCloseState',
    'inspectProcessWindowContext',
    'attemptProcessWindowClose',
    'getProcessWindowCloseRetryDelayMs',
    'computeProcessRetryAlarmAt',
    'syncProcessWindowCloseRetryAlarm',
    'clearProcessWindowCloseRetry',
    'resolveProcessWindowCloseRetryPlan',
    'scheduleProcessWindowCloseRetriesForSnapshot',
    'scheduleProcessWindowCloseRetry',
    'scheduleCompletedProcessWindowCloseAfterSave',
    'runProcessWindowCloseRetry',
    'runDueProcessWindowCloseRetries',
    'closeProcessWindowAfterQueueSuccess',
    'closeCompletedProcessAfterDispatchConfirmed',
    'updateProcessDispatchAfterSendSuccess',
    'updateProcessDispatchAfterFlushOutcome'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
      filename: 'background.js'
    });
  });

  context.processRegistry.set('run-close', {
    id: 'run-close',
    status: 'completed',
    lifecycleStatus: 'completed',
    currentPrompt: 15,
    totalPrompts: 15,
    stageIndex: 14,
    tabId: 11,
    windowId: 22,
    persistenceStatus: {
      saveOk: true,
      dispatch: {
        state: 'dispatch_confirmed',
        accepted: 1,
        sent: 1,
        failed: 0,
        deferred: 0,
        remaining: 0,
        verifyState: 'verified'
      }
    }
  });

  const firstClose = await context.closeProcessWindowAfterQueueSuccess(context.processRegistry.get('run-close'), {
    origin: 'test-first-close'
  });

  assert.strictEqual(firstClose, false);
  assert.strictEqual(removeAttempt, 1);
  assert.strictEqual(timers.length, 1);
  assert.strictEqual(context.processRegistry.get('run-close').windowClose.state, 'retrying');
  assert.strictEqual(createCalls.length, 1);

  const retryClose = await context.runProcessWindowCloseRetry('run-close', {
    origin: 'test-retry'
  });

  assert.strictEqual(retryClose.closed, true);
  assert.strictEqual(retryClose.reason, 'tab_closed');
  assert.strictEqual(removeAttempt, 2);
  assert.strictEqual(context.processRegistry.get('run-close').windowClose.state, 'closed');
  assert(auditLogs.some((entry) => entry.details?.state === 'closed'));
  assert(
    clearCalls.includes('completed-process-window-close-retry'),
    'Closed process should clear the durable window-close retry alarm.'
  );

  const removeAttemptBeforeQueuePending = removeAttempt;
  context.processRegistry.set('run-queue-dispatch-pending', {
    id: 'run-queue-dispatch-pending',
    status: 'completed',
    lifecycleStatus: 'completed',
    currentPrompt: 15,
    totalPrompts: 15,
    queueManaged: true,
    queueJobId: 'aq-dispatch-pending',
    queueState: 'awaiting_dispatch_confirmation',
    slotReserved: true,
    tabId: 31,
    windowId: 32,
    completedResponseSaved: true,
    persistenceStatus: {
      saveOk: true,
      dispatch: {
        state: 'dispatch_pending',
        accepted: 1,
        sent: 1,
        failed: 0,
        pending: 0,
        verifyState: 'http_accepted'
      }
    }
  });

  const queuePendingPlan = context.resolveProcessWindowCloseRetryPlan(
    context.processRegistry.get('run-queue-dispatch-pending')
  );
  const queuePendingScheduled = context.scheduleCompletedProcessWindowCloseAfterSave(
    'run-queue-dispatch-pending',
    'test-save-before-dispatch-confirmed'
  );
  const queuePendingClose = await context.closeProcessWindowAfterQueueSuccess(
    context.processRegistry.get('run-queue-dispatch-pending'),
    { origin: 'test-close-before-dispatch-confirmed' }
  );

  assert.strictEqual(queuePendingPlan.needed, false);
  assert.strictEqual(queuePendingPlan.reason, 'dispatch_not_confirmed');
  assert.strictEqual(queuePendingScheduled, false);
  assert.strictEqual(queuePendingClose, false);
  assert.strictEqual(removeAttempt, removeAttemptBeforeQueuePending);
  assert.strictEqual(
    context.processWindowCloseRetryTimersByRunId.has('run-queue-dispatch-pending'),
    false
  );

  const removedTabIds = [];
  context.getTabByIdSafe = async () => null;
  context.chrome.tabs.query = async () => [
    {
      id: 77,
      windowId: 88,
      url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/c/69ef2120-5ba0-83eb-bf2e-13893c147e32?model=gpt-5'
    }
  ];
  context.removeTabSafe = async (tabId) => {
    removedTabIds.push(tabId);
    return tabId === 77;
  };

  const staleTabClose = await context.attemptProcessWindowClose({
    id: 'run-stale-tab',
    tabId: 11,
    windowId: 22,
    chatUrl: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/c/69ef2120-5ba0-83eb-bf2e-13893c147e32',
    conversationUrls: [
      'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/project'
    ]
  });

  assert.strictEqual(staleTabClose.closed, true);
  assert.strictEqual(staleTabClose.reason, 'tab_closed_by_conversation_url');
  assert.deepStrictEqual(removedTabIds, [11, 77]);

  const staleIdMismatchRemovedTabIds = [];
  context.getTabByIdSafe = async () => ({
    id: 11,
    windowId: 22,
    url: 'https://example.com/reused-tab-id'
  });
  context.chrome.tabs.query = async () => [
    {
      id: 78,
      windowId: 89,
      url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/c/69ef2120-5ba0-83eb-bf2e-13893c147e32'
    }
  ];
  context.removeTabSafe = async (tabId) => {
    staleIdMismatchRemovedTabIds.push(tabId);
    return tabId === 78;
  };

  const staleIdMismatchClose = await context.attemptProcessWindowClose({
    id: 'run-stale-tab-id-mismatch',
    tabId: 11,
    windowId: 22,
    chatUrl: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/c/69ef2120-5ba0-83eb-bf2e-13893c147e32'
  });

  assert.strictEqual(staleIdMismatchClose.closed, true);
  assert.strictEqual(staleIdMismatchClose.reason, 'tab_closed_by_conversation_url');
  assert.deepStrictEqual(
    staleIdMismatchRemovedTabIds,
    [78],
    'A stale tabId that points to a non-ChatGPT tab must not be removed before matching by conversation URL.'
  );

  const unsafeMismatchRemovedTabIds = [];
  context.getTabByIdSafe = async () => ({
    id: 11,
    windowId: 22,
    url: 'https://example.com/reused-tab-id'
  });
  context.chrome.tabs.query = async () => [];
  context.queryTabsInWindowSafe = async () => ({
    ok: true,
    tabs: [
      { id: 11, windowId: 22, active: false, url: 'https://example.com/reused-tab-id' },
      { id: 79, windowId: 22, active: true, url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-inwestycje/project' }
    ],
    reason: ''
  });
  context.removeTabSafe = async (tabId) => {
    unsafeMismatchRemovedTabIds.push(tabId);
    return true;
  };

  const unsafeMismatchClose = await context.attemptProcessWindowClose({
    id: 'run-unsafe-tab-id-mismatch',
    tabId: 11,
    windowId: 22,
    chatUrl: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/c/69ef2120-5ba0-83eb-bf2e-13893c147e32'
  });

  assert.strictEqual(unsafeMismatchClose.closed, false);
  assert.strictEqual(unsafeMismatchClose.reason, 'process_tab_context_mismatch');
  assert.deepStrictEqual(
    unsafeMismatchRemovedTabIds,
    [],
    'A stale non-ChatGPT tabId without a matching conversation tab must not close any neighboring tab.'
  );

  const retryMismatchRemovedTabIds = [];
  context.processRegistry.set('run-retry-tab-context-mismatch', {
    id: 'run-retry-tab-context-mismatch',
    status: 'completed',
    lifecycleStatus: 'completed',
    currentPrompt: 15,
    totalPrompts: 15,
    tabId: 11,
    windowId: 22,
    completedResponseSaved: true,
    chatUrl: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/c/69ef2120-5ba0-83eb-bf2e-13893c147e32',
    persistenceStatus: {
      saveOk: true,
      dispatch: {
        state: 'dispatch_confirmed',
        sent: 1,
        failed: 0,
        pending: 0,
        verifyState: 'verified'
      }
    }
  });
  context.getTabByIdSafe = async () => ({
    id: 11,
    windowId: 22,
    url: 'https://example.com/reused-tab-id'
  });
  context.chrome.tabs.query = async () => [];
  context.queryTabsInWindowSafe = async () => ({
    ok: true,
    tabs: [
      { id: 11, windowId: 22, active: false, url: 'https://example.com/reused-tab-id' },
      { id: 80, windowId: 22, active: true, url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-inwestycje/project' }
    ],
    reason: ''
  });
  context.removeTabSafe = async (tabId) => {
    retryMismatchRemovedTabIds.push(tabId);
    return true;
  };

  const retryMismatchClose = await context.runProcessWindowCloseRetry('run-retry-tab-context-mismatch', {
    origin: 'test-tab-context-mismatch'
  });

  assert.strictEqual(retryMismatchClose.closed, true);
  assert.strictEqual(retryMismatchClose.reason, 'process_tab_context_mismatch');
  assert.deepStrictEqual(
    retryMismatchRemovedTabIds,
    [],
    'Window-close retry must mark a stale non-ChatGPT tabId as absent without removing any tab.'
  );
  assert.strictEqual(context.processRegistry.get('run-retry-tab-context-mismatch').windowClose.state, 'closed');

  const fallbackRemovedTabIds = [];
  context.getTabByIdSafe = async () => null;
  context.chrome.tabs.query = async () => [];
  context.queryTabsInWindowSafe = async () => ({
    ok: true,
    tabs: [
      { id: 99, windowId: 22, active: true, url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/project' },
      { id: 100, windowId: 22, active: false, url: 'https://example.com/' }
    ],
    reason: ''
  });
  context.removeTabSafe = async (tabId) => {
    fallbackRemovedTabIds.push(tabId);
    return tabId === 99;
  };

  const activeChatClose = await context.attemptProcessWindowClose({
    id: 'run-active-chat-tab',
    tabId: 11,
    windowId: 22
  });

  assert.strictEqual(activeChatClose.closed, true);
  assert.strictEqual(activeChatClose.reason, 'active_chatgpt_tab_closed_in_process_window');
  assert.deepStrictEqual(fallbackRemovedTabIds, [11, 99]);

  const wrongTabGuardRemovedTabIds = [];
  context.chrome.tabs.query = async () => [];
  context.queryTabsInWindowSafe = async () => ({
    ok: true,
    tabs: [
      { id: 111, windowId: 222, active: false, url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/project' },
      { id: 112, windowId: 222, active: true, url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-inwestycje/project' }
    ],
    reason: ''
  });
  context.removeTabSafe = async (tabId) => {
    wrongTabGuardRemovedTabIds.push(tabId);
    return false;
  };

  const wrongTabGuardClose = await context.attemptProcessWindowClose({
    id: 'run-known-tab-still-present',
    tabId: 111,
    windowId: 222
  });

  assert.strictEqual(wrongTabGuardClose.closed, false);
  assert.strictEqual(wrongTabGuardClose.reason, 'process_tab_remove_failed');
  assert.deepStrictEqual(
    wrongTabGuardRemovedTabIds,
    [111],
    'When the known process tab is still present, close retry must not close a neighboring active ChatGPT tab.'
  );

  const stoppedRemovedTabIds = [];
  context.processRegistry.set('run-stopped-saved', {
    id: 'run-stopped-saved',
    status: 'stopped',
    reason: 'local_context_missing',
    currentPrompt: 15,
    totalPrompts: 15,
    tabId: 501,
    windowId: 502,
    completedResponseSaved: true,
    persistenceStatus: {
      saveOk: true,
      dispatch: {
        state: 'dispatch_confirmed',
        sent: 1,
        failed: 0,
        pending: 0
      }
    }
  });
  context.getTabByIdSafe = async () => null;
  context.chrome.tabs.query = async () => [];
  context.queryTabsInWindowSafe = async () => ({
    ok: true,
    tabs: [
      { id: 503, windowId: 502, active: true, url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-inwestycje/project' },
      { id: 504, windowId: 502, active: false, url: 'https://example.com/' }
    ],
    reason: ''
  });
  context.removeTabSafe = async (tabId) => {
    stoppedRemovedTabIds.push(tabId);
    return tabId === 503;
  };

  const stoppedSavedClose = await context.closeProcessWindowAfterQueueSuccess(
    context.processRegistry.get('run-stopped-saved'),
    { origin: 'test-stopped-saved-close' }
  );

  assert.strictEqual(stoppedSavedClose, true);
  assert.deepStrictEqual(stoppedRemovedTabIds, [501, 503]);
  assert.strictEqual(context.processRegistry.get('run-stopped-saved').windowClose.state, 'closed');

  context.processRegistry.set('run-save-close', {
    id: 'run-save-close',
    status: 'completed',
    lifecycleStatus: 'completed',
    currentPrompt: 15,
    totalPrompts: 15,
    tabId: 701,
    windowId: 702,
    completedResponseSaved: true,
    persistenceStatus: {
      saveOk: true,
      dispatch: {
        state: 'dispatch_pending',
        sent: 1,
        failed: 0,
        pending: 0
      }
    }
  });
  const timerCountBeforeSaveClose = timers.length;
  const scheduledAfterSave = context.scheduleCompletedProcessWindowCloseAfterSave(
    'run-save-close',
    'test-save-response-completed'
  );
  const saveClosePlan = context.resolveProcessWindowCloseRetryPlan(
    context.processRegistry.get('run-save-close')
  );

  assert.strictEqual(saveClosePlan.needed, false);
  assert.strictEqual(saveClosePlan.reason, 'dispatch_not_confirmed');
  assert.strictEqual(scheduledAfterSave, false);
  assert.strictEqual(timers.length, timerCountBeforeSaveClose);
  assert.strictEqual(context.processWindowCloseRetryTimersByRunId.has('run-save-close'), false);
  assert.strictEqual(context.processWindowCloseRetryDueAtByRunId.has('run-save-close'), false);

  const confirmedReservedRemovedTabIds = [];
  context.processRegistry.set('run-confirmed-reserved', {
    id: 'run-confirmed-reserved',
    status: 'completed',
    lifecycleStatus: 'completed',
    currentPrompt: 15,
    totalPrompts: 15,
    queueManaged: true,
    queueJobId: 'aq-confirmed-reserved',
    queueState: 'awaiting_dispatch_confirmation',
    slotReserved: true,
    tabId: 801,
    windowId: 802,
    completedResponseSaved: true,
    completedResponseSaveTrace: 'run-confirmed-reserved/resp-confirmed-reserved',
    persistenceStatus: {
      saveOk: true,
      copyTrace: 'run-confirmed-reserved/resp-confirmed-reserved',
      dispatch: {
        state: 'dispatch_confirmed',
        sent: 1,
        failed: 0,
        pending: 0,
        verifyState: 'verified'
      }
    }
  });
  context.getTabByIdSafe = async () => ({ id: 801, windowId: 802, url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/project' });
  context.queryTabsInWindowSafe = async () => ({ ok: true, tabs: [{ id: 801, windowId: 802, url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/project' }], reason: '' });
  context.removeTabSafe = async (tabId) => {
    confirmedReservedRemovedTabIds.push(tabId);
    return tabId === 801;
  };

  const confirmedReservedClose = await context.closeCompletedProcessAfterDispatchConfirmed(
    'run-confirmed-reserved',
    { origin: 'test-confirmed-reserved' }
  );
  const confirmedReservedProcess = context.processRegistry.get('run-confirmed-reserved');

  assert.strictEqual(confirmedReservedClose, true);
  assert.deepStrictEqual(confirmedReservedRemovedTabIds, [801]);
  assert.strictEqual(confirmedReservedProcess.queueState, 'dispatch_confirmed');
  assert.strictEqual(confirmedReservedProcess.slotReserved, false);
  assert.strictEqual(confirmedReservedProcess.slotReleaseReason, 'dispatch_confirmed');
  assert.strictEqual(confirmedReservedProcess.windowClose.state, 'closed');
  assert(
    reconcileRequests.includes('dispatch_confirmed_window_closed'),
    'Successful dispatch-confirmed close should wake queue reconciliation after releasing the slot.'
  );
  assert(
    queueEventLogs.some((entry) => entry.event === 'job_window_close_after_confirm'
      && entry.payload?.runId === 'run-confirmed-reserved'
      && entry.payload?.dispatchConfirmed === true),
    'Confirmed process close should be reported after releasing a stale reserved slot.'
  );

  const dispatchSuccessRemovedTabIds = [];
  context.processRegistry.set('run-dispatch-success', {
    id: 'run-dispatch-success',
    status: 'completed',
    lifecycleStatus: 'completed',
    currentPrompt: 15,
    totalPrompts: 15,
    queueManaged: true,
    queueJobId: 'aq-dispatch-success',
    queueState: 'awaiting_dispatch_confirmation',
    slotReserved: true,
    tabId: 811,
    windowId: 812,
    completedResponseSaved: true,
    completedResponseSaveTrace: 'run-dispatch-success/resp-dispatch-success',
    persistenceStatus: {
      saveOk: true,
      copyTrace: 'run-dispatch-success/resp-dispatch-success',
      dispatch: {
        state: 'dispatch_pending',
        queued: true,
        accepted: 1,
        sent: 1,
        failed: 0,
        pending: 0,
        verifyState: 'http_accepted'
      }
    }
  });
  context.getTabByIdSafe = async () => ({ id: 811, windowId: 812, url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/project' });
  context.queryTabsInWindowSafe = async () => ({ ok: true, tabs: [{ id: 811, windowId: 812, url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/project' }], reason: '' });
  context.removeTabSafe = async (tabId) => {
    dispatchSuccessRemovedTabIds.push(tabId);
    return tabId === 811;
  };

  const dispatchSuccessUpdated = await context.updateProcessDispatchAfterSendSuccess(
    'run-dispatch-success',
    'resp-dispatch-success',
    { status: 200, eventId: 'evt-dispatch-success', requestId: 'req-dispatch-success' }
  );
  const dispatchSuccessProcess = context.processRegistry.get('run-dispatch-success');

  assert.strictEqual(dispatchSuccessUpdated, true);
  assert.deepStrictEqual(dispatchSuccessRemovedTabIds, [811]);
  assert.strictEqual(dispatchSuccessProcess.queueState, 'dispatch_confirmed');
  assert.strictEqual(dispatchSuccessProcess.slotReserved, false);
  assert.strictEqual(dispatchSuccessProcess.persistenceStatus.dispatch.state, 'dispatch_confirmed');
  assert.strictEqual(dispatchSuccessProcess.persistenceStatus.dispatch.verifyState, 'verified');
  assert.strictEqual(dispatchSuccessProcess.windowClose.state, 'closed');

  const deferredFlushRemovedTabIds = [];
  context.processRegistry.set('run-deferred-flush-success', {
    id: 'run-deferred-flush-success',
    status: 'completed',
    lifecycleStatus: 'completed',
    currentPrompt: 15,
    totalPrompts: 15,
    queueManaged: true,
    queueJobId: 'aq-deferred-flush-success',
    queueState: 'awaiting_dispatch_confirmation',
    slotReserved: true,
    tabId: 815,
    windowId: 816,
    completedResponseSaved: true,
    completedResponseSaveTrace: 'run-deferred-flush-success/resp-deferred-flush-success',
    persistenceStatus: {
      saveOk: true,
      copyTrace: 'run-deferred-flush-success/resp-deferred-flush-success',
      dispatch: {
        state: 'dispatch_pending',
        queued: true,
        flushDeferred: true,
        accepted: 0,
        sent: 0,
        failed: 0,
        deferred: 1,
        remaining: 1,
        verifyState: ''
      }
    }
  });
  context.getTabByIdSafe = async () => ({ id: 815, windowId: 816, url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/project' });
  context.queryTabsInWindowSafe = async () => ({ ok: true, tabs: [{ id: 815, windowId: 816, url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/project' }], reason: '' });
  context.removeTabSafe = async (tabId) => {
    deferredFlushRemovedTabIds.push(tabId);
    return tabId === 815;
  };

  const deferredFlushUpdated = await context.updateProcessDispatchAfterFlushOutcome(
    {
      success: true,
      copyTrace: 'run-deferred-flush-success/resp-deferred-flush-success',
      verifiedCount: 1,
      response: {
        runId: 'run-deferred-flush-success',
        responseId: 'resp-deferred-flush-success'
      },
      conversationAnalysis: {
        hasConversationUrl: true,
        conversationLogCount: 4,
        snapshotRefreshedBeforeSend: true,
        snapshotSource: 'test'
      }
    },
    {
      state: 'dispatch_confirmed',
      queued: true,
      accepted: 1,
      sent: 1,
      failed: 0,
      deferred: 0,
      remaining: 0,
      verifyState: 'verified',
      verifyReason: 'verified',
      verifyEventId: 'evt-deferred-flush-success'
    },
    ['flush_result|ok|verified']
  );
  const deferredFlushProcess = context.processRegistry.get('run-deferred-flush-success');

  assert.strictEqual(deferredFlushUpdated, true);
  assert.deepStrictEqual(deferredFlushRemovedTabIds, [815]);
  assert.strictEqual(deferredFlushProcess.queueState, 'dispatch_confirmed');
  assert.strictEqual(deferredFlushProcess.slotReserved, false);
  assert.strictEqual(deferredFlushProcess.persistenceStatus.dispatch.state, 'dispatch_confirmed');
  assert.strictEqual(deferredFlushProcess.persistenceStatus.dispatch.verifyState, 'verified');
  assert.strictEqual(deferredFlushProcess.finalStagePersistence.origin, 'runtime_bridge_deferred_flush');
  assert.strictEqual(deferredFlushProcess.windowClose.state, 'closed');

  const closeFailRemovedTabIds = [];
  context.processRegistry.set('run-confirmed-close-fails', {
    id: 'run-confirmed-close-fails',
    status: 'completed',
    lifecycleStatus: 'completed',
    currentPrompt: 15,
    totalPrompts: 15,
    queueManaged: true,
    queueJobId: 'aq-confirmed-close-fails',
    queueState: 'awaiting_dispatch_confirmation',
    slotReserved: true,
    tabId: 821,
    windowId: 822,
    completedResponseSaved: true,
    completedResponseSaveTrace: 'run-confirmed-close-fails/resp-confirmed-close-fails',
    persistenceStatus: {
      saveOk: true,
      copyTrace: 'run-confirmed-close-fails/resp-confirmed-close-fails',
      dispatch: {
        state: 'dispatch_confirmed',
        sent: 1,
        failed: 0,
        pending: 0,
        verifyState: 'verified'
      }
    }
  });
  context.getTabByIdSafe = async () => ({ id: 821, windowId: 822, url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/project' });
  context.queryTabsInWindowSafe = async () => ({ ok: true, tabs: [{ id: 821, windowId: 822, url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/project' }], reason: '' });
  context.removeTabSafe = async (tabId) => {
    closeFailRemovedTabIds.push(tabId);
    return false;
  };

  const confirmedCloseFails = await context.closeCompletedProcessAfterDispatchConfirmed(
    'run-confirmed-close-fails',
    { origin: 'test-confirmed-close-fails' }
  );
  const closeFailsProcess = context.processRegistry.get('run-confirmed-close-fails');

  assert.strictEqual(confirmedCloseFails, false);
  assert.deepStrictEqual(closeFailRemovedTabIds, [821]);
  assert.strictEqual(closeFailsProcess.queueState, 'awaiting_window_close');
  assert.strictEqual(closeFailsProcess.slotReserved, true);
  assert.strictEqual(closeFailsProcess.windowClose.state, 'retrying');
  assert.strictEqual(context.processWindowCloseRetryTimersByRunId.has('run-confirmed-close-fails'), true);

  const staleReleasedCloseFailRemovedTabIds = [];
  context.processRegistry.set('run-stale-released-close-fails', {
    id: 'run-stale-released-close-fails',
    status: 'completed',
    lifecycleStatus: 'completed',
    currentPrompt: 15,
    totalPrompts: 15,
    queueManaged: true,
    queueJobId: 'aq-stale-released-close-fails',
    queueState: 'dispatch_confirmed',
    slotReserved: false,
    tabId: 826,
    windowId: 827,
    completedResponseSaved: true,
    completedResponseSaveTrace: 'run-stale-released-close-fails/resp-stale-released-close-fails',
    persistenceStatus: {
      saveOk: true,
      copyTrace: 'run-stale-released-close-fails/resp-stale-released-close-fails',
      dispatch: {
        state: 'dispatch_confirmed',
        sent: 1,
        failed: 0,
        pending: 0,
        verifyState: 'verified'
      }
    }
  });
  context.getTabByIdSafe = async () => ({ id: 826, windowId: 827, url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/project' });
  context.queryTabsInWindowSafe = async () => ({ ok: true, tabs: [{ id: 826, windowId: 827, url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/project' }], reason: '' });
  context.removeTabSafe = async (tabId) => {
    staleReleasedCloseFailRemovedTabIds.push(tabId);
    return false;
  };

  const staleReleasedCloseFails = await context.closeCompletedProcessAfterDispatchConfirmed(
    'run-stale-released-close-fails',
    { origin: 'test-stale-released-close-fails' }
  );
  const staleReleasedCloseFailsProcess = context.processRegistry.get('run-stale-released-close-fails');

  assert.strictEqual(staleReleasedCloseFails, false);
  assert.deepStrictEqual(staleReleasedCloseFailRemovedTabIds, [826]);
  assert.strictEqual(
    staleReleasedCloseFailsProcess.queueState,
    'awaiting_window_close',
    'Dispatch-confirmed close recovery should re-reserve a stale released process while its tab is still open.'
  );
  assert.strictEqual(staleReleasedCloseFailsProcess.slotReserved, true);

  context.removeTabSafe = async (tabId) => {
    closeFailRemovedTabIds.push(tabId);
    return tabId === 821;
  };
  const closeFailRetry = await context.runProcessWindowCloseRetry('run-confirmed-close-fails', {
    origin: 'test-confirmed-close-fails-retry'
  });

  assert.strictEqual(closeFailRetry.closed, true);
  assert.strictEqual(context.processRegistry.get('run-confirmed-close-fails').windowClose.state, 'closed');
  assert(
    reconcileRequests.includes('process_window_close_confirmed'),
    'Successful close retry should wake queue reconciliation so the reserved slot can release.'
  );

  const maxAttemptRetryRemovedTabIds = [];
  context.processRegistry.set('run-confirmed-max-retry', {
    id: 'run-confirmed-max-retry',
    status: 'completed',
    lifecycleStatus: 'completed',
    currentPrompt: 15,
    totalPrompts: 15,
    queueManaged: true,
    queueJobId: 'aq-confirmed-max-retry',
    queueState: 'awaiting_window_close',
    slotReserved: true,
    tabId: 831,
    windowId: 832,
    completedResponseSaved: true,
    completedResponseSaveTrace: 'run-confirmed-max-retry/resp-confirmed-max-retry',
    persistenceStatus: {
      saveOk: true,
      copyTrace: 'run-confirmed-max-retry/resp-confirmed-max-retry',
      dispatch: {
        state: 'dispatch_confirmed',
        sent: 1,
        failed: 0,
        pending: 0,
        verifyState: 'verified'
      }
    }
  });
  context.processWindowCloseRetryAttemptCountByRunId.set(
    'run-confirmed-max-retry',
    context.PROCESS_WINDOW_CLOSE_RETRY.maxAttempts - 1
  );
  context.getTabByIdSafe = async () => ({ id: 831, windowId: 832, url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/project' });
  context.queryTabsInWindowSafe = async () => ({ ok: true, tabs: [{ id: 831, windowId: 832, url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/project' }], reason: '' });
  context.removeTabSafe = async (tabId) => {
    maxAttemptRetryRemovedTabIds.push(tabId);
    return false;
  };

  const maxAttemptRetry = await context.runProcessWindowCloseRetry('run-confirmed-max-retry', {
    origin: 'test-confirmed-max-retry'
  });
  const maxAttemptRetryProcess = context.processRegistry.get('run-confirmed-max-retry');

  assert.strictEqual(maxAttemptRetry.closed, false);
  assert.strictEqual(maxAttemptRetryProcess.windowClose.state, 'retrying');
  assert.strictEqual(maxAttemptRetryProcess.slotReserved, true);
  assert.strictEqual(
    context.processWindowCloseRetryTimersByRunId.has('run-confirmed-max-retry'),
    true,
    'Confirmed queue process should keep scheduling window-close retries after the generic max attempt count.'
  );
  assert.deepStrictEqual(maxAttemptRetryRemovedTabIds, [831]);

  const terminalFailedPlan = context.resolveProcessWindowCloseRetryPlan({
    id: 'run-terminal-failed-plan',
    status: 'failed',
    lifecycleStatus: 'failed',
    queueManaged: true,
    queueJobId: 'aq-terminal-failed-plan',
    queueState: 'awaiting_window_close',
    slotReserved: true,
    tabId: 841,
    windowId: 842,
    reason: 'queue_execution_exception'
  });

  assert.strictEqual(terminalFailedPlan.needed, true);
  assert.strictEqual(terminalFailedPlan.reason, 'terminal_queue_process');

  const terminalFailedRetryRemovedTabIds = [];
  context.processRegistry.set('run-terminal-failed-max-retry', {
    id: 'run-terminal-failed-max-retry',
    status: 'failed',
    lifecycleStatus: 'failed',
    reason: 'queue_execution_exception',
    queueManaged: true,
    queueJobId: 'aq-terminal-failed-max-retry',
    queueState: 'awaiting_window_close',
    slotReserved: true,
    tabId: 841,
    windowId: 842
  });
  context.processWindowCloseRetryAttemptCountByRunId.set(
    'run-terminal-failed-max-retry',
    context.PROCESS_WINDOW_CLOSE_RETRY.maxAttempts - 1
  );
  context.getTabByIdSafe = async () => ({ id: 841, windowId: 842, url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/project' });
  context.queryTabsInWindowSafe = async () => ({ ok: true, tabs: [{ id: 841, windowId: 842, url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/project' }], reason: '' });
  context.removeTabSafe = async (tabId) => {
    terminalFailedRetryRemovedTabIds.push(tabId);
    return false;
  };

  const terminalFailedMaxRetry = await context.runProcessWindowCloseRetry('run-terminal-failed-max-retry', {
    origin: 'test-terminal-failed-max-retry'
  });
  const terminalFailedMaxRetryProcess = context.processRegistry.get('run-terminal-failed-max-retry');

  assert.strictEqual(terminalFailedMaxRetry.closed, false);
  assert.strictEqual(terminalFailedMaxRetryProcess.windowClose.state, 'retrying');
  assert.strictEqual(terminalFailedMaxRetryProcess.slotReserved, true);
  assert.strictEqual(
    context.processWindowCloseRetryTimersByRunId.has('run-terminal-failed-max-retry'),
    true,
    'Terminal queue process should keep scheduling window-close retries after the generic max attempt count.'
  );
  assert.deepStrictEqual(terminalFailedRetryRemovedTabIds, [841]);

  const dataGapFailedPlan = context.resolveProcessWindowCloseRetryPlan({
    id: 'run-data-gap-failed-plan',
    status: 'stopped',
    lifecycleStatus: 'stopped',
    reason: 'data_gap_stage',
    statusCode: 'process.data_gap_stage',
    dataGapDetected: true,
    dataGapStageId: '4',
    queueManaged: true,
    queueJobId: 'aq-data-gap-failed-plan',
    queueState: 'awaiting_window_close',
    slotReserved: true,
    tabId: 845,
    windowId: 846,
    windowClose: {
      state: 'failed',
      attemptCount: 24,
      lastError: 'window_remove_failed'
    }
  });

  assert.strictEqual(dataGapFailedPlan.needed, true);
  assert.strictEqual(dataGapFailedPlan.reason, 'close_retry_exhausted_retrying');

  const dataGapRetryRemovedTabIds = [];
  context.processRegistry.set('run-data-gap-max-retry', {
    id: 'run-data-gap-max-retry',
    status: 'stopped',
    lifecycleStatus: 'stopped',
    reason: 'data_gap_stage',
    statusCode: 'process.data_gap_stage',
    dataGapDetected: true,
    dataGapStageId: '4',
    queueManaged: true,
    queueJobId: 'aq-data-gap-max-retry',
    queueState: 'awaiting_window_close',
    slotReserved: true,
    tabId: 845,
    windowId: 846
  });
  context.processWindowCloseRetryAttemptCountByRunId.set(
    'run-data-gap-max-retry',
    context.PROCESS_WINDOW_CLOSE_RETRY.maxAttempts - 1
  );
  context.getTabByIdSafe = async () => ({ id: 845, windowId: 846, url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/project' });
  context.queryTabsInWindowSafe = async () => ({ ok: true, tabs: [{ id: 845, windowId: 846, url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/project' }], reason: '' });
  context.removeTabSafe = async (tabId) => {
    dataGapRetryRemovedTabIds.push(tabId);
    return false;
  };

  const dataGapMaxRetry = await context.runProcessWindowCloseRetry('run-data-gap-max-retry', {
    origin: 'test-data-gap-max-retry'
  });
  const dataGapMaxRetryProcess = context.processRegistry.get('run-data-gap-max-retry');

  assert.strictEqual(dataGapMaxRetry.closed, false);
  assert.strictEqual(dataGapMaxRetryProcess.windowClose.state, 'retrying');
  assert.strictEqual(dataGapMaxRetryProcess.slotReserved, true);
  assert.strictEqual(
    context.processWindowCloseRetryTimersByRunId.has('run-data-gap-max-retry'),
    true,
    'DATA_GAP_STAGE queue process should keep scheduling window-close retries after the generic max attempt count.'
  );
  assert.deepStrictEqual(dataGapRetryRemovedTabIds, [845]);

  const alarmFallbackRemovedTabIds = [];
  context.processRegistry = new Map();
  context.processWindowCloseRetryTimersByRunId.clear();
  context.processWindowCloseRetryDueAtByRunId.clear();
  context.processWindowCloseRetryAttemptCountByRunId.delete('run-alarm-fallback-close');
  reconcileRequests.length = 0;
  context.processRegistry.set('run-alarm-fallback-close', {
    id: 'run-alarm-fallback-close',
    status: 'completed',
    lifecycleStatus: 'completed',
    currentPrompt: 15,
    totalPrompts: 15,
    queueManaged: true,
    queueJobId: 'aq-alarm-fallback-close',
    queueState: 'awaiting_window_close',
    slotReserved: true,
    tabId: 851,
    windowId: 852,
    completedResponseSaved: true,
    completedResponseSaveTrace: 'run-alarm-fallback-close/resp-alarm-fallback-close',
    persistenceStatus: {
      saveOk: true,
      copyTrace: 'run-alarm-fallback-close/resp-alarm-fallback-close',
      dispatch: {
        state: 'dispatch_confirmed',
        sent: 1,
        failed: 0,
        pending: 0,
        verifyState: 'verified'
      }
    }
  });
  context.getTabByIdSafe = async () => ({ id: 851, windowId: 852, url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/project' });
  context.queryTabsInWindowSafe = async () => ({ ok: true, tabs: [{ id: 851, windowId: 852, url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/project' }], reason: '' });
  context.removeTabSafe = async (tabId) => {
    alarmFallbackRemovedTabIds.push(tabId);
    return tabId === 851;
  };

  const alarmFallbackResult = await context.runDueProcessWindowCloseRetries('test-worker-restart');
  const alarmFallbackProcess = context.processRegistry.get('run-alarm-fallback-close');

  assert.strictEqual(alarmFallbackResult.success, true);
  assert.strictEqual(alarmFallbackResult.due, 1);
  assert.strictEqual(alarmFallbackResult.attempted, 1);
  assert.deepStrictEqual(alarmFallbackRemovedTabIds, [851]);
  assert.strictEqual(alarmFallbackProcess.windowClose.state, 'closed');
  assert(
    reconcileRequests.includes('process_window_close_confirmed'),
    'Alarm fallback close should wake queue reconciliation after closing the restored process window.'
  );

  context.processRegistry.set('run-window-missing', {
    id: 'run-window-missing',
    status: 'completed',
    currentPrompt: 15,
    totalPrompts: 15,
    tabId: 601,
    windowId: 602,
    completedResponseSaved: true,
    persistenceStatus: {
      saveOk: true,
      dispatch: {
        state: 'dispatch_confirmed',
        sent: 1,
        failed: 0,
        pending: 0
      }
    }
  });
  context.getTabByIdSafe = async () => null;
  context.queryTabsInWindowSafe = async () => ({
    ok: false,
    tabs: [],
    reason: 'No window with id: 602'
  });
  context.removeTabSafe = async () => false;

  const missingWindowClose = await context.runProcessWindowCloseRetry('run-window-missing', {
    origin: 'test-window-missing'
  });

  assert.strictEqual(missingWindowClose.closed, true);
  assert.strictEqual(missingWindowClose.reason, 'window_missing');
  assert.strictEqual(context.processRegistry.get('run-window-missing').windowClose.state, 'closed');

  const urlOnlyPlan = context.resolveProcessWindowCloseRetryPlan({
    id: 'run-url-only',
    status: 'completed',
    lifecycleStatus: 'completed',
    currentPrompt: 15,
    totalPrompts: 15,
    completedResponseSaved: true,
    chatUrl: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/c/69ef2120-5ba0-83eb-bf2e-13893c147e32',
    persistenceStatus: {
      saveOk: true,
      dispatch: {
        state: 'dispatch_confirmed',
        sent: 1,
        failed: 0,
        pending: 0
      }
    }
  });

  assert.strictEqual(urlOnlyPlan.needed, true);
  assert.strictEqual(urlOnlyPlan.reason, 'dispatch_confirmed');

  const dataGapPlan = context.resolveProcessWindowCloseRetryPlan({
    id: 'run-data-gap',
    status: 'stopped',
    lifecycleStatus: 'stopped',
    reason: 'data_gap_stage',
    statusCode: 'process.data_gap_stage',
    dataGapDetected: true,
    dataGapStageId: '4',
    tabId: 701,
    windowId: 702
  });

  assert.strictEqual(dataGapPlan.needed, true);
  assert.strictEqual(dataGapPlan.reason, 'data_gap_stage');

  console.log('test-process-window-close-retry.js: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
