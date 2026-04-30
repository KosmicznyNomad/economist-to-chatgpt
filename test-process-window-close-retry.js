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
    getTabByIdSafe: async () => ({ id: 11, windowId: 22 }),
    queryTabsInWindowSafe: async () => ({ ok: true, tabs: [{ id: 11 }], reason: '' }),
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
    emitWatchlistDispatchProcessLog(level, code, message, details) {
      auditLogs.push({ level, code, message, details });
    },
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
    'findOpenProcessTabByConversationUrl',
    'normalizeProcessLifecycleStatus',
    'normalizeProcessStatus',
    'resolveProcessStageSnapshot',
    'hasProcessReachedFinalStage',
    'isExplicitlyVerifiedDispatch',
    'getProcessPersistenceDispatchSnapshot',
    'getProcessQueueDeliveryState',
    'hasProcessCloseableSavedResponse',
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
    'runProcessWindowCloseRetry',
    'closeProcessWindowAfterQueueSuccess'
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
        state: 'dispatch_pending',
        accepted: 1,
        sent: 1,
        failed: 0,
        deferred: 0,
        remaining: 0,
        verifyState: 'http_accepted'
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
  assert.strictEqual(context.processRegistry.get('run-close').windowClose.attemptCount, 1);
  assert.strictEqual(context.processRegistry.get('run-close').windowClose.nextAttemptAt > 0, true);
  assert.strictEqual(createCalls[0].name, 'completed-process-window-close-retry');

  const retryClose = await context.runProcessWindowCloseRetry('run-close', {
    origin: 'test-retry'
  });

  assert.strictEqual(retryClose.closed, true);
  assert.strictEqual(removeAttempt, 2);
  assert.strictEqual(context.processRegistry.get('run-close').windowClose.state, 'closed');
  assert.ok(Number.isInteger(context.processRegistry.get('run-close').windowClose.closedAt));
  assert(context.processRegistry.get('run-close').windowClose.nextAttemptAt === 0);
  assert(
    auditLogs.some((entry) => entry.code === 'completed_process_window_close_result' && entry.details?.state === 'retrying'),
    'Should log pending window-close retries.'
  );
  assert(
    auditLogs.some((entry) => entry.code === 'completed_process_window_close_result' && entry.details?.state === 'closed'),
    'Should log successful window-close completion.'
  );
  assert(
    clearCalls.includes('completed-process-window-close-retry'),
    'Successful completion should clear the durable window-close retry alarm.'
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

  const fallbackRemovedTabIds = [];
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
  assert.strictEqual(context.processRegistry.get('run-window-missing').windowClose.state, 'closed');
  assert.strictEqual(context.processRegistry.get('run-window-missing').windowClose.lastReason, 'window_missing');

  const urlOnlyPlan = context.resolveProcessWindowCloseRetryPlan({
    id: 'run-url-only',
    status: 'completed',
    lifecycleStatus: 'completed',
    currentPrompt: 15,
    totalPrompts: 15,
    chatUrl: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/c/69ef2120-5ba0-83eb-bf2e-13893c147e32',
    persistenceStatus: {
      saveOk: true
    }
  });

  assert.strictEqual(urlOnlyPlan.needed, true);
  assert.strictEqual(urlOnlyPlan.reason, 'local_save_completed');

  console.log('test-process-window-close-retry.js: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
