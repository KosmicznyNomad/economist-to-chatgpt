const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const backgroundPath = path.join(__dirname, 'background.js');
const backgroundSource = fs.readFileSync(backgroundPath, 'utf8');

function extractFunctionSource(source, functionName) {
  const pattern = new RegExp(`(?:async\\s+)?function\\s+${functionName}\\s*\\(`);
  const match = pattern.exec(source);
  if (!match) {
    throw new Error(`Function not found: ${functionName}`);
  }
  const startIndex = match.index;
  let parenDepth = 0;
  let braceStart = -1;
  for (let index = match.index; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') {
      parenDepth += 1;
      continue;
    }
    if (char === ')') {
      parenDepth -= 1;
      continue;
    }
    if (char === '{' && parenDepth === 0) {
      braceStart = index;
      break;
    }
  }
  if (braceStart === -1) {
    throw new Error(`Function body not found: ${functionName}`);
  }

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
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
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
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
        return source.slice(startIndex, index + 1);
      }
    }
  }

  throw new Error(`Function end not found: ${functionName}`);
}

function buildVmContext(overrides = {}) {
  return vm.createContext({
    console,
    Date,
    Math,
    Set,
    Map,
    Number,
    String,
    Array,
    JSON,
    processRegistry: new Map(),
    normalizeWatchlistVerifyState(value) {
      return typeof value === 'string' ? value.trim().toLowerCase() : '';
    },
    isExplicitlyVerifiedDispatch(dispatch) {
      const state = typeof dispatch?.state === 'string' ? dispatch.state.trim().toLowerCase() : '';
      const verifyState = typeof dispatch?.verifyState === 'string' ? dispatch.verifyState.trim().toLowerCase() : '';
      return state === 'dispatch_confirmed' || verifyState === 'verified';
    },
    isAcceptedWatchlistDispatch(dispatch) {
      const accepted = Number.isInteger(dispatch?.accepted) ? dispatch.accepted : 0;
      const sent = Number.isInteger(dispatch?.sent) ? dispatch.sent : 0;
      const verifyState = typeof dispatch?.verifyState === 'string' ? dispatch.verifyState.trim().toLowerCase() : '';
      return accepted > 0
        || sent > 0
        || ['http_accepted', 'verified', 'materialization_pending', 'materialization_partial', 'materialization_unavailable', 'expected_records_missing', 'missing_fields', 'mismatch', 'ingest_failed', 'ingest_quarantined'].includes(verifyState);
    },
    isTerminalWatchlistDispatchFailure(dispatch) {
      const failed = Number.isInteger(dispatch?.failed) ? dispatch.failed : 0;
      const verifyState = typeof dispatch?.verifyState === 'string' ? dispatch.verifyState.trim().toLowerCase() : '';
      return failed > 0
        || dispatch?.queueSkipped === true
        || ['materialization_unavailable', 'expected_records_missing', 'missing_fields', 'mismatch', 'ingest_failed', 'ingest_quarantined'].includes(verifyState);
    },
    getProcessPersistenceDispatchSnapshot(process) {
      return process?.persistenceStatus?.dispatch || process?.completedResponseDispatch || null;
    },
    getProcessQueueDeliveryState(process) {
      const dispatch = process?.persistenceStatus?.dispatch || process?.completedResponseDispatch || null;
      const saveOk = process?.persistenceStatus?.saveOk === true || process?.completedResponseSaved === true;
      const deferred = Number.isInteger(dispatch?.deferred) ? dispatch.deferred : 0;
      const remaining = Number.isInteger(dispatch?.remaining) ? dispatch.remaining : 0;
      return {
        saveOk,
        state: typeof dispatch?.state === 'string' ? dispatch.state : '',
        failed: Number.isInteger(dispatch?.failed) ? dispatch.failed : 0,
        pending: deferred + remaining,
        deferred,
        remaining,
        confirmed: (typeof dispatch?.state === 'string' && dispatch.state === 'dispatch_confirmed')
          || (typeof dispatch?.verifyState === 'string' && dispatch.verifyState.trim().toLowerCase() === 'verified')
      };
    },
    resolveCompletedProcessPersistenceRetryPlan(process) {
      const dispatch = process?.persistenceStatus?.dispatch || process?.completedResponseDispatch || null;
      const deferred = Number.isInteger(dispatch?.deferred) ? dispatch.deferred : 0;
      const remaining = Number.isInteger(dispatch?.remaining) ? dispatch.remaining : 0;
      const delivery = {
        saveOk: process?.persistenceStatus?.saveOk === true || process?.completedResponseSaved === true,
        state: typeof dispatch?.state === 'string' ? dispatch.state : '',
        failed: Number.isInteger(dispatch?.failed) ? dispatch.failed : 0,
        pending: deferred + remaining,
        deferred,
        remaining,
        confirmed: (typeof dispatch?.state === 'string' && dispatch.state === 'dispatch_confirmed')
          || (typeof dispatch?.verifyState === 'string' && dispatch.verifyState.trim().toLowerCase() === 'verified')
      };
      return {
        needed: false,
        mode: '',
        reason: delivery.confirmed ? 'already_confirmed' : '',
        delivery
      };
    },
    replayCompletedResponseForProcess: async () => ({
      attempted: true,
      success: true,
      reason: 'saved',
      recoveryMode: 'replayed'
    }),
    runCompletedProcessPersistenceRetry: async () => ({
      success: true,
      confirmed: false,
      pending: true,
      delivery: null
    }),
    ...overrides
  });
}

async function testCopyLatestInvestRequestsClosedProcesses() {
  let capturedOptions = null;
  const context = buildVmContext({
    resolveInvestCopyTargets: async (options) => {
      capturedOptions = { ...options };
      return {
        success: false,
        error: 'invest_tab_not_found',
        scope: options.scope || 'latest',
        investTabCount: 0,
        windowCount: 0,
        targets: []
      };
    },
    reportCopyLatestInvestFinalResponseEvent() {}
  });

  vm.runInContext(extractFunctionSource(backgroundSource, 'copyLatestInvestFinalResponse'), context);

  const result = await context.copyLatestInvestFinalResponse({
    origin: 'test-copy',
    scope: 'all_open_windows'
  });

  assert.ok(capturedOptions, 'resolveInvestCopyTargets should be called');
  assert.strictEqual(capturedOptions.includeClosedProcesses, true);
  assert.strictEqual(capturedOptions.scope, 'all_open_windows');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error, 'invest_tab_not_found');
}

async function testResolveInvestCopyTargetsAcceptsLegacyInvestUrls() {
  const legacyInvestUrl = 'https://chatgpt.com/g/g-p-6970fbfa4c348191ba16b549b09ce706-inwestycje/c/69d2262e-06fc-8387-8f6d-aa81c3e325e9';
  const context = buildVmContext({
    CHAT_GPT_HOSTS: new Set([
      'chatgpt.com',
      'www.chatgpt.com',
      'chat.openai.com',
      'www.chat.openai.com'
    ]),
    INVEST_GPT_URL_BASE: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-inwestycje',
    INVEST_GPT_PATH_BASE: '/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-inwestycje',
    chrome: {
      tabs: {
        query: async (queryInfo = {}) => {
          const tab = {
            id: 701,
            windowId: 77,
            url: legacyInvestUrl,
            active: true,
            lastAccessed: 250,
            title: 'Invest legacy'
          };
          if (queryInfo?.active === true && queryInfo?.currentWindow === true) {
            return [tab];
          }
          return [tab];
        }
      }
    },
    getProcessSnapshot: async () => [],
    compareProcessesForRestore() {
      return 0;
    },
    isClosedProcessStatus() {
      return false;
    },
    isQueuedProcessStatus() {
      return false;
    },
    compareTabsByWindowAndIndex(left, right) {
      return (left?.id || 0) - (right?.id || 0);
    },
    compareTabsByRecentAccess(left, right) {
      return (right?.lastAccessed || 0) - (left?.lastAccessed || 0);
    },
    getTabEffectiveUrl(tab) {
      return typeof tab?.url === 'string' ? tab.url.trim() : '';
    },
    normalizeChatConversationUrl(value) {
      return typeof value === 'string' ? value.trim() : '';
    },
    normalizeConversationUrlList(values) {
      const seen = new Set();
      const result = [];
      (Array.isArray(values) ? values : []).forEach((value) => {
        const normalized = typeof value === 'string' ? value.trim() : '';
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        result.push(normalized);
      });
      return result;
    },
    getCompletedProcessFinalityState() {
      return {
        ready: false,
        completedResponseText: ''
      };
    },
    buildResponseContractValidation() {
      return {
        valid: false,
        kind: 'invalid'
      };
    }
  });

  [
    'isInvestGptUrl',
    'collectCompanyInvestContextSnapshot',
    'getActiveInvestTabIdInCurrentWindow',
    'findInvestCopyProcessForTab',
    'compareInvestCopyTargets',
    'buildInvestCopyTargetFromTab',
    'resolveInvestCopyTargets'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context);
  });

  const result = await context.resolveInvestCopyTargets({
    scope: 'all_open_windows',
    includeClosedProcesses: true
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.investTabCount, 1);
  assert.strictEqual(result.windowCount, 1);
  assert.strictEqual(result.activeInvestTabId, 701);
  assert.strictEqual(result.targets.length, 1);
  assert.strictEqual(result.targets[0].tabId, 701);
  assert.strictEqual(result.targets[0].url, legacyInvestUrl);
}

async function testResolveInvestCopyTargetsFallsBackToProcessContextWhenNoInvestTabs() {
  const conversationUrl = 'https://chatgpt.com/c/invest-process-only';
  const context = buildVmContext({
    CHAT_GPT_HOSTS: new Set([
      'chatgpt.com',
      'www.chatgpt.com',
      'chat.openai.com',
      'www.chat.openai.com'
    ]),
    INVEST_GPT_URL_BASE: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-inwestycje',
    INVEST_GPT_PATH_BASE: '/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-inwestycje',
    chrome: {
      tabs: {
        query: async (queryInfo = {}) => {
          const tab = {
            id: 901,
            windowId: 44,
            url: conversationUrl,
            active: true,
            lastAccessed: 880,
            title: 'Invest process only'
          };
          if (queryInfo?.active === true && queryInfo?.currentWindow === true) {
            return [tab];
          }
          return [tab];
        }
      }
    },
    getProcessSnapshot: async () => [
      {
        id: 'run-process-only',
        tabId: 901,
        windowId: 44,
        status: 'completed',
        title: 'Invest process only',
        chatUrl: conversationUrl,
        sourceUrl: 'https://chatgpt.com/g/g-p-legacy-inwestycje',
        completedResponseText: 'VALID FINAL RESPONSE',
        timestamp: 990
      }
    ],
    compareProcessesForRestore() {
      return 0;
    },
    isClosedProcessStatus() {
      return false;
    },
    isQueuedProcessStatus() {
      return false;
    },
    compareTabsByWindowAndIndex(left, right) {
      return (left?.id || 0) - (right?.id || 0);
    },
    compareTabsByRecentAccess(left, right) {
      return (right?.lastAccessed || 0) - (left?.lastAccessed || 0);
    },
    getTabEffectiveUrl(tab) {
      return typeof tab?.url === 'string' ? tab.url.trim() : '';
    },
    normalizeChatConversationUrl(value) {
      return typeof value === 'string' ? value.trim() : '';
    },
    normalizeConversationUrlList(values) {
      const seen = new Set();
      const result = [];
      (Array.isArray(values) ? values : []).forEach((value) => {
        const normalized = typeof value === 'string' ? value.trim() : '';
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        result.push(normalized);
      });
      return result;
    },
    getCompletedProcessFinalityState(process) {
      return {
        ready: !!process?.completedResponseText,
        completedResponseText: process?.completedResponseText || ''
      };
    },
    buildResponseContractValidation(text) {
      return {
        valid: text === 'VALID FINAL RESPONSE',
        kind: text === 'VALID FINAL RESPONSE' ? 'current16' : 'invalid'
      };
    }
  });

  [
    'isInvestGptUrl',
    'collectCompanyInvestContextSnapshot',
    'getActiveInvestTabIdInCurrentWindow',
    'findInvestCopyProcessForTab',
    'compareInvestCopyTargets',
    'buildInvestCopyTargetFromTab',
    'buildInvestCopyTargetFromProcess',
    'resolveInvestCopyTargets'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context);
  });

  const result = await context.resolveInvestCopyTargets({
    scope: 'latest',
    includeClosedProcesses: true
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.investTabCount, 0);
  assert.strictEqual(result.windowCount, 1);
  assert.strictEqual(result.activeInvestTabId, 901);
  assert.strictEqual(result.targets.length, 1);
  assert.strictEqual(result.targets[0].tabId, 901);
  assert.strictEqual(result.targets[0].windowId, 44);
  assert.strictEqual(result.targets[0].process.id, 'run-process-only');
  assert.strictEqual(result.targets[0].url, conversationUrl);
}

async function testResolveInvestCopyTargetsIgnoresNonInvestProcessFromSameWindow() {
  const legacyInvestUrl = 'https://chatgpt.com/g/g-p-6970fbfa4c348191ba16b549b09ce706-inwestycje/c/69d2262e-06fc-8387-8f6d-aa81c3e325e9';
  const context = buildVmContext({
    CHAT_GPT_HOSTS: new Set([
      'chatgpt.com',
      'www.chatgpt.com',
      'chat.openai.com',
      'www.chat.openai.com'
    ]),
    INVEST_GPT_URL_BASE: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-inwestycje',
    INVEST_GPT_PATH_BASE: '/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-inwestycje',
    chrome: {
      tabs: {
        query: async (queryInfo = {}) => {
          const tab = {
            id: 701,
            windowId: 77,
            url: legacyInvestUrl,
            active: true,
            lastAccessed: 250,
            title: 'Invest live'
          };
          if (queryInfo?.active === true && queryInfo?.currentWindow === true) {
            return [tab];
          }
          return [tab];
        }
      }
    },
    getProcessSnapshot: async () => [
      {
        id: 'run-non-invest',
        windowId: 77,
        status: 'running',
        title: 'Auto Start: Prompt 2',
        chatUrl: 'https://chatgpt.com/c/non-invest-chat',
        sourceUrl: 'https://www.barrons.com/articles/example',
        currentPrompt: 2,
        totalPrompts: 10,
        timestamp: 500
      }
    ],
    compareProcessesForRestore() {
      return 0;
    },
    isClosedProcessStatus() {
      return false;
    },
    isQueuedProcessStatus() {
      return false;
    },
    compareTabsByWindowAndIndex(left, right) {
      return (left?.id || 0) - (right?.id || 0);
    },
    compareTabsByRecentAccess(left, right) {
      return (right?.lastAccessed || 0) - (left?.lastAccessed || 0);
    },
    getTabEffectiveUrl(tab) {
      return typeof tab?.url === 'string' ? tab.url.trim() : '';
    },
    normalizeChatConversationUrl(value) {
      return typeof value === 'string' ? value.trim() : '';
    },
    normalizeConversationUrlList(values) {
      const seen = new Set();
      const result = [];
      (Array.isArray(values) ? values : []).forEach((value) => {
        const normalized = typeof value === 'string' ? value.trim() : '';
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        result.push(normalized);
      });
      return result;
    },
    getCompletedProcessFinalityState() {
      return {
        ready: false,
        completedResponseText: ''
      };
    },
    buildResponseContractValidation() {
      return {
        valid: false,
        kind: 'invalid'
      };
    }
  });

  [
    'isInvestGptUrl',
    'collectCompanyInvestContextSnapshot',
    'getActiveInvestTabIdInCurrentWindow',
    'findInvestCopyProcessForTab',
    'compareInvestCopyTargets',
    'buildInvestCopyTargetFromTab',
    'buildInvestCopyTargetFromProcess',
    'resolveInvestCopyTargets'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context);
  });

  const result = await context.resolveInvestCopyTargets({
    scope: 'latest',
    includeClosedProcesses: true
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.targets.length, 1);
  assert.strictEqual(result.targets[0].tabId, 701);
  assert.strictEqual(result.targets[0].windowId, 77);
  assert.strictEqual(result.targets[0].process, null);
  assert.strictEqual(result.targets[0].url, legacyInvestUrl);
}

async function testResolveInvestCopyTargetsPrefersLiveTabOverProcessFallbackInSameWindow() {
  const liveConversationUrl = 'https://chatgpt.com/g/g-p-6970fbfa4c348191ba16b549b09ce706-inwestycje/c/invest-live';
  const fallbackConversationUrl = 'https://chatgpt.com/c/invest-stale';
  const context = buildVmContext({
    CHAT_GPT_HOSTS: new Set([
      'chatgpt.com',
      'www.chatgpt.com',
      'chat.openai.com',
      'www.chat.openai.com'
    ]),
    INVEST_GPT_URL_BASE: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-inwestycje',
    INVEST_GPT_PATH_BASE: '/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-inwestycje',
    chrome: {
      tabs: {
        query: async (queryInfo = {}) => {
          const tab = {
            id: 811,
            windowId: 91,
            url: liveConversationUrl,
            active: true,
            lastAccessed: 900,
            title: 'Invest live'
          };
          if (queryInfo?.active === true && queryInfo?.currentWindow === true) {
            return [tab];
          }
          return [tab];
        }
      }
    },
    getProcessSnapshot: async () => [
      {
        id: 'run-stale',
        tabId: 912,
        windowId: 91,
        status: 'completed',
        title: 'Invest stale',
        chatUrl: fallbackConversationUrl,
        sourceUrl: fallbackConversationUrl,
        completedResponseText: 'VALID FINAL RESPONSE',
        timestamp: 100
      }
    ],
    compareProcessesForRestore() {
      return 0;
    },
    isClosedProcessStatus() {
      return false;
    },
    isQueuedProcessStatus() {
      return false;
    },
    compareTabsByWindowAndIndex(left, right) {
      return (left?.id || 0) - (right?.id || 0);
    },
    compareTabsByRecentAccess(left, right) {
      return (right?.lastAccessed || 0) - (left?.lastAccessed || 0);
    },
    getTabEffectiveUrl(tab) {
      return typeof tab?.url === 'string' ? tab.url.trim() : '';
    },
    normalizeChatConversationUrl(value) {
      return typeof value === 'string' ? value.trim() : '';
    },
    normalizeConversationUrlList(values) {
      const seen = new Set();
      const result = [];
      (Array.isArray(values) ? values : []).forEach((value) => {
        const normalized = typeof value === 'string' ? value.trim() : '';
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        result.push(normalized);
      });
      return result;
    },
    getCompletedProcessFinalityState(process) {
      return {
        ready: !!process?.completedResponseText,
        completedResponseText: process?.completedResponseText || ''
      };
    },
    buildResponseContractValidation(text) {
      return {
        valid: text === 'VALID FINAL RESPONSE',
        kind: text === 'VALID FINAL RESPONSE' ? 'current16' : 'invalid'
      };
    }
  });

  [
    'isInvestGptUrl',
    'collectCompanyInvestContextSnapshot',
    'getActiveInvestTabIdInCurrentWindow',
    'findInvestCopyProcessForTab',
    'compareInvestCopyTargets',
    'buildInvestCopyTargetFromTab',
    'buildInvestCopyTargetFromProcess',
    'resolveInvestCopyTargets'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context);
  });

  const result = await context.resolveInvestCopyTargets({
    scope: 'all_open_windows',
    includeClosedProcesses: true
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.targets.length, 1);
  assert.strictEqual(result.targets[0].tabId, 811);
  assert.strictEqual(result.targets[0].targetSource, 'live_tab');
}

async function testFindInvestCopyProcessUsesConversationHistory() {
  const context = buildVmContext({
    getTabEffectiveUrl(tab) {
      return typeof tab?.url === 'string' ? tab.url.trim() : '';
    },
    normalizeChatConversationUrl(value) {
      return typeof value === 'string' ? value.trim() : '';
    },
    normalizeConversationUrlList(values) {
      const seen = new Set();
      const result = [];
      (Array.isArray(values) ? values : []).forEach((value) => {
        const normalized = typeof value === 'string' ? value.trim() : '';
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        result.push(normalized);
      });
      return result;
    }
  });

  vm.runInContext(extractFunctionSource(backgroundSource, 'findInvestCopyProcessForTab'), context);

  const process = context.findInvestCopyProcessForTab(
    {
      id: 77,
      windowId: 11,
      url: 'https://chatgpt.com/c/invest-alpha'
    },
    {
      processByTabId: new Map(),
      processByWindowId: new Map(),
      processCandidates: [
        {
          id: 'run-alpha',
          tabId: 31,
          windowId: 22,
          chatUrl: '',
          sourceUrl: '',
          conversationUrls: ['https://chatgpt.com/c/invest-alpha']
        }
      ]
    }
  );

  assert.ok(process, 'conversation history should match the process');
  assert.strictEqual(process.id, 'run-alpha');
}

async function testCopyLatestInvestFallsBackToDirectSaveWithoutProcess() {
  const eventCalls = [];
  const saveCalls = [];
  const context = buildVmContext({
    normalizeChatConversationUrl(value) {
      return typeof value === 'string' ? value.trim() : '';
    },
    extractLastAssistantResponseFromTab: async () => 'VALID FINAL RESPONSE',
    buildResponseContractValidation(text) {
      return {
        valid: text === 'VALID FINAL RESPONSE',
        kind: text === 'VALID FINAL RESPONSE' ? 'current16' : 'invalid'
      };
    },
    reportCopyLatestInvestFinalResponseEvent(payload) {
      eventCalls.push(payload);
    },
    saveResponse: async (...args) => {
      saveCalls.push(args);
      return {
        success: true,
        copyTrace: 'copy/manual',
        dispatch: {
          sent: 1,
          failed: 0
        },
        conversationAnalysis: {
          conversationLogCount: 4
        }
      };
    },
    generateResponseId(prefix) {
      return `${prefix}_test-response-id`;
    },
    formatDispatchUiSummary(dispatch) {
      return dispatch && dispatch.sent === 1 ? 'sent=1' : '';
    }
  });

  [
    'resolveInvestCopyDomFallback',
    'resolveCopyLatestInvestResponsePayload',
    'copyLatestInvestFinalResponseForTarget'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context);
  });

  const result = await context.copyLatestInvestFinalResponseForTarget(
    {
      tabId: 7,
      windowId: 3,
      title: 'Invest Alpha',
      url: 'https://chatgpt.com/c/invest-alpha',
      conversationUrl: 'https://chatgpt.com/c/invest-alpha',
      process: null
    },
    {
      origin: 'test-copy',
      scope: 'all_open_windows',
      targetOrdinal: 1,
      targetTotal: 1,
      tabReadTimeoutMs: 1200
    }
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.text, 'VALID FINAL RESPONSE');
  assert.strictEqual(result.processId, '');
  assert.strictEqual(result.persistence.mode, 'direct_save');
  assert.strictEqual(result.persistence.success, true);
  assert.strictEqual(result.persistence.dispatchSummary, 'sent=1');
  assert.strictEqual(saveCalls.length, 1, 'manual copy should perform a direct save');
  assert.strictEqual(saveCalls[0][4], 'manual_copy_fallback_test-response-id');
  assert.ok(eventCalls.length > 0, 'copy flow should emit a telemetry event');
}

async function testResolveCopyLatestInvestReturnsFinalProcessNotFoundWhenDomIsEmpty() {
  const context = buildVmContext({
    extractLastAssistantResponseFromTab: async () => '',
    buildResponseContractValidation() {
      return {
        valid: false,
        kind: 'invalid'
      };
    }
  });

  [
    'resolveInvestCopyDomFallback',
    'resolveCopyLatestInvestResponsePayload'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context);
  });

  const result = await context.resolveCopyLatestInvestResponsePayload(
    {
      tabId: 15,
      windowId: 4
    },
    null,
    {
      tabReadTimeoutMs: 500
    }
  );

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, 'final_process_not_found');
}

async function testResolveCopyLatestInvestRetriesProcessDomFallbackAfterActivation() {
  let extractCalls = 0;
  let prepareCalls = 0;
  const context = buildVmContext({
    resolveCompletedProcessFinalResponseText: async () => ({
      success: false,
      reason: 'invalid_final_response_contract'
    }),
    extractLastAssistantResponseFromTab: async () => {
      extractCalls += 1;
      return extractCalls === 1 ? 'PARTIAL RESPONSE' : 'VALID FINAL RESPONSE';
    },
    buildResponseContractValidation(text) {
      return {
        valid: text === 'VALID FINAL RESPONSE',
        kind: text === 'VALID FINAL RESPONSE' ? 'current16' : 'invalid'
      };
    },
    prepareTabForDetection: async (tabId, windowId) => {
      prepareCalls += 1;
      assert.strictEqual(tabId, 41);
      assert.strictEqual(windowId, 9);
      return true;
    }
  });

  [
    'resolveInvestCopyDomFallback',
    'resolveCopyLatestInvestResponsePayload'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context);
  });

  const result = await context.resolveCopyLatestInvestResponsePayload(
    {
      tabId: 41,
      windowId: 9
    },
    {
      id: 'run-blackwell'
    },
    {
      tabReadTimeoutMs: 1200
    }
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.resolutionMode, 'process_dom_contract');
  assert.strictEqual(result.responseText, 'VALID FINAL RESPONSE');
  assert.strictEqual(prepareCalls, 1, 'process flow should activate the tab before retrying');
  assert.strictEqual(extractCalls, 2, 'process flow should retry DOM extraction after activation');
}

async function testResolveCopyLatestInvestPassesThroughProcessPatchFromStrictResolution() {
  const context = buildVmContext({
    resolveCompletedProcessFinalResponseText: async () => ({
      success: true,
      responseText: 'VALID FINAL RESPONSE',
      processPatch: {
        completedResponseText: 'VALID FINAL RESPONSE',
        completedResponseCapturedAt: 1775987605000
      }
    })
  });

  [
    'resolveCopyLatestInvestResponsePayload'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context);
  });

  const result = await context.resolveCopyLatestInvestResponsePayload(
    {
      tabId: 41,
      windowId: 9
    },
    {
      id: 'run-strict'
    },
    {
      tabReadTimeoutMs: 1200
    }
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.resolutionMode, 'process_strict');
  assert.strictEqual(result.responseText, 'VALID FINAL RESPONSE');
  assert.strictEqual(result.processPatch.completedResponseText, 'VALID FINAL RESPONSE');
  assert.strictEqual(result.processPatch.completedResponseCapturedAt, 1775987605000);
}

async function testResolveCopyLatestInvestReportsInvalidContractForRejectedDomFallback() {
  const context = buildVmContext({
    resolveCompletedProcessFinalResponseText: async () => ({
      success: false,
      reason: 'invalid_final_response_contract'
    }),
    extractLastAssistantResponseFromTab: async () => 'PARTIAL RESPONSE',
    buildResponseContractValidation() {
      return {
        valid: false,
        kind: 'invalid'
      };
    },
    prepareTabForDetection: async () => false
  });

  [
    'resolveInvestCopyDomFallback',
    'resolveCopyLatestInvestResponsePayload'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context);
  });

  const result = await context.resolveCopyLatestInvestResponsePayload(
    {
      tabId: 61,
      windowId: 14
    },
    {
      id: 'run-invalid'
    },
    {
      tabReadTimeoutMs: 900
    }
  );

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, 'invalid_final_response_contract');
}

async function testResolveCopyLatestInvestRetriesDirectFallbackAfterActivation() {
  let extractCalls = 0;
  let prepareCalls = 0;
  const context = buildVmContext({
    extractLastAssistantResponseFromTab: async () => {
      extractCalls += 1;
      return extractCalls === 1 ? '' : 'VALID FINAL RESPONSE';
    },
    buildResponseContractValidation(text) {
      return {
        valid: text === 'VALID FINAL RESPONSE',
        kind: text === 'VALID FINAL RESPONSE' ? 'current16' : 'invalid'
      };
    },
    prepareTabForDetection: async (tabId, windowId) => {
      prepareCalls += 1;
      assert.strictEqual(tabId, 52);
      assert.strictEqual(windowId, 12);
      return true;
    }
  });

  [
    'resolveInvestCopyDomFallback',
    'resolveCopyLatestInvestResponsePayload'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context);
  });

  const result = await context.resolveCopyLatestInvestResponsePayload(
    {
      tabId: 52,
      windowId: 12
    },
    null,
    {
      tabReadTimeoutMs: 1200
    }
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.resolutionMode, 'direct_save');
  assert.strictEqual(result.responseText, 'VALID FINAL RESPONSE');
  assert.strictEqual(prepareCalls, 1, 'direct fallback should activate the tab before retrying');
  assert.strictEqual(extractCalls, 2, 'direct fallback should retry DOM extraction after activation');
}

async function testCopyLatestInvestBatchReportsPartialSuccessAcrossAllWindows() {
  const eventCalls = [];
  const targetCalls = [];
  const context = buildVmContext({
    buildCopyLatestInvestBatchClipboardText(results = []) {
      return results.map((row) => `${row.title}:${row.text}`).join(' | ');
    },
    resolveInvestCopyTargets: async (options) => {
      assert.strictEqual(options.scope, 'all_open_windows');
      assert.strictEqual(options.includeClosedProcesses, true);
      return {
        success: true,
        scope: 'all_open_windows',
        investTabCount: 3,
        windowCount: 3,
        targets: [
          { tabId: 101, windowId: 1, title: 'Alpha', url: 'https://chatgpt.com/c/alpha', process: null },
          { tabId: 102, windowId: 2, title: 'Beta', url: 'https://chatgpt.com/c/beta', process: null },
          { tabId: 103, windowId: 3, title: 'Gamma', url: 'https://chatgpt.com/c/gamma', process: null }
        ]
      };
    },
    copyLatestInvestFinalResponseForTarget: async (target, options) => {
      targetCalls.push({ target, options });
      if (target.tabId === 102) {
        return {
          success: false,
          error: 'invalid_final_response_contract',
          tabId: target.tabId,
          windowId: target.windowId,
          title: target.title,
          conversationUrl: '',
          processId: ''
        };
      }
      return {
        success: true,
        text: target.tabId === 101 ? 'ALPHA FINAL' : 'GAMMA FINAL',
        textLength: target.tabId === 101 ? 11 : 11,
        tabId: target.tabId,
        windowId: target.windowId,
        title: target.title,
        conversationUrl: `https://chatgpt.com/c/${target.title.toLowerCase()}`,
        processId: '',
        persistence: {
          attempted: true,
          success: true,
          mode: 'direct_save',
          reason: 'saved',
          copyTrace: `trace-${target.tabId}`,
          dispatchSummary: `sent=${target.tabId}`
        },
        scope: 'all_open_windows',
        targetOrdinal: options.targetOrdinal,
        targetTotal: options.targetTotal
      };
    },
    reportCopyLatestInvestFinalResponseEvent(payload) {
      eventCalls.push(payload);
    }
  });

  [
    'buildCopyLatestInvestBatchClipboardText',
    'copyLatestInvestFinalResponse'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context);
  });

  const result = await context.copyLatestInvestFinalResponse({
    origin: 'test-copy',
    scope: 'all_open_windows',
    tabReadTimeoutMs: 900
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.batch, true);
  assert.strictEqual(result.requested, 3);
  assert.strictEqual(result.copied, 2);
  assert.strictEqual(result.failed, 1);
  assert.strictEqual(result.title, 'Invest windows 2/3');
  assert.ok(result.text.includes('===== Invest 1/2 | Alpha | W:1 ====='));
  assert.ok(result.text.includes('ALPHA FINAL'));
  assert.ok(result.text.includes('===== Invest 2/2 | Gamma | W:3 ====='));
  assert.ok(result.text.includes('GAMMA FINAL'));
  assert.strictEqual(result.textLength, result.text.length);
  assert.strictEqual(targetCalls.length, 3);
  assert.strictEqual(eventCalls.length > 0, true);
  const summaryEvent = eventCalls[eventCalls.length - 1];
  assert.strictEqual(summaryEvent.status, 'completed_partial');
  assert.strictEqual(summaryEvent.reason, 'copy_latest_invest_final_response_partial');
  assert.strictEqual(summaryEvent.batchRequested, 3);
  assert.strictEqual(summaryEvent.batchSucceeded, 2);
  assert.strictEqual(summaryEvent.batchFailed, 1);
  assert.strictEqual(summaryEvent.persistenceMode, 'batch_all_open_windows');
  assert.strictEqual(summaryEvent.dispatchSummary, 'copied=2/3, failed=1, save=2/2, accepted=0, verified=0, terminal=0, urls=2');
}

async function testCopyLatestInvestUsesAlreadySavedProcessWithoutDuplicateDirectSave() {
  const saveCalls = [];
  const retryCalls = [];
  const context = buildVmContext({
    processRegistry: new Map([
      ['run-saved', {
        id: 'run-saved',
        completedResponseSaved: true,
        persistenceStatus: {
          saveOk: true,
          dispatch: {
            state: 'dispatch_pending',
            accepted: 1,
            sent: 1,
            failed: 0,
            deferred: 1,
            remaining: 0,
            verifyState: 'http_accepted'
          }
        }
      }]
    ]),
    normalizeChatConversationUrl(value) {
      return typeof value === 'string' ? value.trim() : '';
    },
    resolveCompletedProcessFinalResponseText: async () => ({
      success: true,
      responseText: 'VALID FINAL RESPONSE'
    }),
    replayCompletedResponseForProcess: async () => ({
      attempted: false,
      success: true,
      reason: 'already_saved_retryable',
      recoveryMode: 'retry_existing_dispatch',
      dispatch: {
        state: 'dispatch_pending',
        accepted: 1,
        sent: 1,
        failed: 0,
        deferred: 1,
        remaining: 0,
        verifyState: 'http_accepted'
      },
      dispatchSummary: 'accepted=1'
    }),
    runCompletedProcessPersistenceRetry: async (...args) => {
      retryCalls.push(args);
      return {
        success: true,
        pending: true,
        delivery: {
          saveOk: true,
          state: 'dispatch_pending',
          failed: 0,
          pending: 1,
          confirmed: false
        }
      };
    },
    upsertProcess: async () => true,
    buildResponseContractValidation(text) {
      return {
        valid: text === 'VALID FINAL RESPONSE',
        kind: text === 'VALID FINAL RESPONSE' ? 'current16' : 'invalid'
      };
    },
    reportCopyLatestInvestFinalResponseEvent() {},
    saveResponse: async (...args) => {
      saveCalls.push(args);
      return {
        success: true,
        copyTrace: 'unexpected/direct-save'
      };
    },
    formatDispatchUiSummary() {
      return '';
    }
  });

  [
    'resolveInvestCopyDomFallback',
    'resolveCopyLatestInvestResponsePayload',
    'copyLatestInvestFinalResponseForTarget'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context);
  });

  const result = await context.copyLatestInvestFinalResponseForTarget(
    {
      tabId: 88,
      windowId: 6,
      title: 'Invest Persisted',
      url: 'https://chatgpt.com/c/invest-persisted',
      conversationUrl: 'https://chatgpt.com/c/invest-persisted',
      process: {
        id: 'run-saved'
      }
    },
    {
      origin: 'test-copy',
      scope: 'latest',
      targetOrdinal: 1,
      targetTotal: 1,
      tabReadTimeoutMs: 900
    }
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.persistence.mode, 'retry_existing_dispatch');
  assert.strictEqual(result.persistence.success, true);
  assert.strictEqual(result.persistence.reason, 'dispatch_retry_pending');
  assert.strictEqual(retryCalls.length, 1, 'already-saved process should retry existing dispatch');
  assert.strictEqual(saveCalls.length, 0, 'already-saved process should not fall back to direct save');
}

async function testCopyLatestInvestAllowsProcessOnlyTargetWithoutTabId() {
  const eventCalls = [];
  const saveCalls = [];
  const context = buildVmContext({
    normalizeChatConversationUrl(value) {
      return typeof value === 'string' ? value.trim() : '';
    },
    resolveCompletedProcessFinalResponseText: async () => ({
      success: true,
      responseText: 'VALID FINAL RESPONSE'
    }),
    replayCompletedResponseForProcess: async () => ({
      attempted: false,
      success: true,
      reason: 'already_saved_replay_required',
      recoveryMode: 'replay_missing_dispatch'
    }),
    ensureCompletedProcessResponsePersisted: async () => ({
      attempted: true,
      success: true,
      reason: 'saved',
      recoveryMode: 'replayed',
      copyTrace: 'process/replayed',
      dispatchSummary: 'accepted=1',
      dispatch: {
        state: 'dispatch_pending',
        accepted: 1,
        sent: 1,
        failed: 0,
        verifyState: 'http_accepted'
      },
      conversationAnalysis: {
        conversationLogCount: 1
      }
    }),
    upsertProcess: async () => true,
    reportCopyLatestInvestFinalResponseEvent(payload) {
      eventCalls.push(payload);
    },
    saveResponse: async (...args) => {
      saveCalls.push(args);
      return {
        success: true,
        copyTrace: 'unexpected/direct-save'
      };
    },
    formatDispatchUiSummary() {
      return '';
    }
  });

  [
    'resolveInvestCopyDomFallback',
    'resolveCopyLatestInvestResponsePayload',
    'copyLatestInvestFinalResponseForTarget'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context);
  });

  const result = await context.copyLatestInvestFinalResponseForTarget(
    {
      tabId: null,
      windowId: 14,
      title: 'Invest process only',
      url: 'https://chatgpt.com/c/invest-process-only',
      conversationUrl: 'https://chatgpt.com/c/invest-process-only',
      process: {
        id: 'run-process-only'
      }
    },
    {
      origin: 'test-copy',
      scope: 'latest',
      targetOrdinal: 1,
      targetTotal: 1,
      tabReadTimeoutMs: 900
    }
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.text, 'VALID FINAL RESPONSE');
  assert.strictEqual(result.processId, 'run-process-only');
  assert.strictEqual(result.persistence.mode, 'replay_missing_dispatch');
  assert.strictEqual(result.persistence.success, true);
  assert.strictEqual(result.persistence.reason, 'saved');
  assert.strictEqual(saveCalls.length, 0, 'process-only target should not fall back to direct save');
  assert.ok(eventCalls.length > 0, 'copy flow should emit a telemetry event');
}

async function main() {
  await testCopyLatestInvestRequestsClosedProcesses();
  await testResolveInvestCopyTargetsAcceptsLegacyInvestUrls();
  await testResolveInvestCopyTargetsFallsBackToProcessContextWhenNoInvestTabs();
  await testResolveInvestCopyTargetsIgnoresNonInvestProcessFromSameWindow();
  await testResolveInvestCopyTargetsPrefersLiveTabOverProcessFallbackInSameWindow();
  await testFindInvestCopyProcessUsesConversationHistory();
  await testCopyLatestInvestFallsBackToDirectSaveWithoutProcess();
  await testResolveCopyLatestInvestReturnsFinalProcessNotFoundWhenDomIsEmpty();
  await testResolveCopyLatestInvestRetriesProcessDomFallbackAfterActivation();
  await testResolveCopyLatestInvestPassesThroughProcessPatchFromStrictResolution();
  await testResolveCopyLatestInvestReportsInvalidContractForRejectedDomFallback();
  await testResolveCopyLatestInvestRetriesDirectFallbackAfterActivation();
  await testCopyLatestInvestBatchReportsPartialSuccessAcrossAllWindows();
  await testCopyLatestInvestUsesAlreadySavedProcessWithoutDuplicateDirectSave();
  await testCopyLatestInvestAllowsProcessOnlyTargetWithoutTabId();
  console.log('test-copy-latest-invest-final-response.js: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
