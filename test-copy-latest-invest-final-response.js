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
    URL,
    Date,
    Math,
    Set,
    Map,
    Number,
    String,
    Array,
    RegExp,
    JSON,
    CHAT_GPT_HOSTS: new Set(['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com', 'www.chat.openai.com']),
    INVEST_GPT_URL_BASE: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-inwestycje',
    INVEST_GPT_PATH_BASE: '/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-inwestycje',
    PROMPTS_COMPANY: new Array(15).fill('prompt'),
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
    getCompletedProcessLocalSaveState(process) {
      if (!process || typeof process !== 'object') return null;
      if (typeof process?.persistenceStatus?.saveOk === 'boolean') {
        return process.persistenceStatus.saveOk;
      }
      if (typeof process?.completedResponseSaved === 'boolean') {
        return process.completedResponseSaved;
      }
      if (typeof process?.finalStagePersistence?.success === 'boolean') {
        return process.finalStagePersistence.success;
      }
      return null;
    },
    hasCompletedProcessLocalSave(process) {
      if (!process || typeof process !== 'object') return false;
      if (typeof process?.persistenceStatus?.saveOk === 'boolean') {
        return process.persistenceStatus.saveOk === true;
      }
      if (typeof process?.completedResponseSaved === 'boolean') {
        return process.completedResponseSaved === true;
      }
      return process?.finalStagePersistence?.success === true;
    },
    getProcessPersistenceDispatchSnapshot(process) {
      return process?.persistenceStatus?.dispatch || process?.completedResponseDispatch || process?.finalStagePersistence || null;
    },
    getProcessQueueDeliveryState(process) {
      const dispatch = process?.persistenceStatus?.dispatch || process?.completedResponseDispatch || process?.finalStagePersistence || null;
      const saveOk = process?.persistenceStatus?.saveOk === true
        || process?.completedResponseSaved === true
        || process?.finalStagePersistence?.success === true;
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
      const dispatch = process?.persistenceStatus?.dispatch || process?.completedResponseDispatch || process?.finalStagePersistence || null;
      const deferred = Number.isInteger(dispatch?.deferred) ? dispatch.deferred : 0;
      const remaining = Number.isInteger(dispatch?.remaining) ? dispatch.remaining : 0;
      const delivery = {
        saveOk: process?.persistenceStatus?.saveOk === true
          || process?.completedResponseSaved === true
          || process?.finalStagePersistence?.success === true,
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
    extractLatestStage12InvestmentResponseFromTab: async () => ({
      text: '',
      contract: null,
      scannedCount: 0,
      sourceIndex: null,
      reason: 'not_found'
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
    'isChatGptUrl',
    'isInvestGptUrl',
    'getCompanyInvestProcessUrls',
    'processHasInvestChatContext',
    'isLikelyActiveCompanyInvestProcess',
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
    'isChatGptUrl',
    'isInvestGptUrl',
    'getCompanyInvestProcessUrls',
    'processHasInvestChatContext',
    'isLikelyActiveCompanyInvestProcess',
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
    'isChatGptUrl',
    'isInvestGptUrl',
    'getCompanyInvestProcessUrls',
    'processHasInvestChatContext',
    'isLikelyActiveCompanyInvestProcess',
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
    'isChatGptUrl',
    'isInvestGptUrl',
    'getCompanyInvestProcessUrls',
    'processHasInvestChatContext',
    'isLikelyActiveCompanyInvestProcess',
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

async function testCopyLatestInvestDirectSaveUsesStage12DomHistoryBeforeLastMessage() {
  const eventCalls = [];
  const saveCalls = [];
  const stage12Json = JSON.stringify({
    schema: 'economist.response.v2',
    records: [
      {
        decision_role: 'PRIMARY',
        fields: {
          spolka: 'Ajinomoto (2802.T:Tokyo)',
          status_decyzji: 'WATCH',
          teza_inwestycyjna: 'Valid Stage 12 JSON'
        }
      }
    ]
  });
  let lastAssistantReadCount = 0;
  const context = buildVmContext({
    normalizeChatConversationUrl(value) {
      return typeof value === 'string' ? value.trim() : '';
    },
    extractLatestStage12InvestmentResponseFromTab: async () => ({
      text: stage12Json,
      contract: {
        valid: true,
        kind: 'economist.response.v2'
      },
      scannedCount: 4,
      sourceIndex: 2,
      reason: 'economist_response_v2'
    }),
    extractLastAssistantResponseFromTab: async () => {
      lastAssistantReadCount += 1;
      return '[{"sektor":"ABF","podsektor":"Stage 13","opis":"not a Stage 12 record"}]';
    },
    buildResponseContractValidation(text) {
      return {
        valid: text === stage12Json,
        kind: text === stage12Json ? 'economist.response.v2' : 'invalid'
      };
    },
    reportCopyLatestInvestFinalResponseEvent(payload) {
      eventCalls.push(payload);
    },
    saveResponse: async (...args) => {
      saveCalls.push(args);
      return {
        success: true,
        copyTrace: 'copy/stage12-dom-history',
        dispatch: {
          accepted: 1,
          sent: 1,
          failed: 0,
          verifyState: 'http_accepted'
        },
        conversationAnalysis: {
          conversationLogCount: 5
        }
      };
    },
    generateResponseId(prefix) {
      return `${prefix}_stage12-test`;
    },
    formatDispatchUiSummary(dispatch) {
      return dispatch && dispatch.accepted === 1 ? 'accepted=1' : '';
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
      tabId: 17,
      windowId: 5,
      title: 'Invest Stage 12 History',
      url: 'https://chatgpt.com/c/invest-stage12-history',
      conversationUrl: 'https://chatgpt.com/c/invest-stage12-history',
      process: null
    },
    {
      origin: 'test-copy',
      scope: 'latest',
      tabReadTimeoutMs: 900
    }
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.text, stage12Json);
  assert.strictEqual(result.persistence.mode, 'direct_save');
  assert.strictEqual(result.persistence.success, true);
  assert.strictEqual(saveCalls.length, 1, 'manual copy should save the recovered Stage 12 JSON');
  assert.strictEqual(saveCalls[0][0], stage12Json);
  assert.strictEqual(saveCalls[0][5].selected_response_reason, 'manual_copy_stage12_dom_history');
  assert.strictEqual(saveCalls[0][5].selected_response_prompt, 12);
  assert.strictEqual(saveCalls[0][5].selected_response_stage_index, 11);
  assert.strictEqual(lastAssistantReadCount, 0, 'copy flow should not read the last assistant message when Stage 12 JSON is found');
  assert.ok(eventCalls.length > 0, 'copy flow should emit telemetry for Stage 12 history recovery');
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

async function testResolveCopyLatestInvestPrefersStage12DomHistoryForProcessFallback() {
  const stage12Json = JSON.stringify({
    schema: 'economist.response.v2',
    records: [
      {
        decision_role: 'PRIMARY',
        fields: {
          spolka: 'Ajinomoto (2802.T:Tokyo)',
          status_decyzji: 'WATCH',
          teza_inwestycyjna: 'Valid Stage 12 JSON'
        }
      }
    ]
  });
  let stage12ScanCalls = 0;
  let lastAssistantReadCount = 0;
  const context = buildVmContext({
    resolveCompletedProcessFinalResponseText: async () => ({
      success: false,
      reason: 'invalid_final_response_contract'
    }),
    extractLatestStage12InvestmentResponseFromTab: async () => {
      stage12ScanCalls += 1;
      return {
        text: stage12Json,
        contract: {
          valid: true,
          kind: 'economist.response.v2'
        },
        scannedCount: 5,
        sourceIndex: 3,
        reason: 'economist_response_v2'
      };
    },
    extractLastAssistantResponseFromTab: async () => {
      lastAssistantReadCount += 1;
      return '[{"sektor":"ABF","podsektor":"Stage 13","opis":"not a Stage 12 record"}]';
    },
    buildResponseContractValidation(text) {
      return {
        valid: text === stage12Json,
        kind: text === stage12Json ? 'economist.response.v2' : 'invalid'
      };
    },
    prepareTabForDetection: async () => {
      throw new Error('activation should not be needed when Stage 12 JSON is already in DOM history');
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
      tabId: 43,
      windowId: 10
    },
    {
      id: 'run-stage12-history'
    },
    {
      tabReadTimeoutMs: 900
    }
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.responseText, stage12Json);
  assert.strictEqual(result.resolutionMode, 'process_stage12_dom_history');
  assert.strictEqual(result.fromDom, true);
  assert.strictEqual(result.selectedPrompt, 12);
  assert.strictEqual(result.selectedResponseReason, 'manual_copy_stage12_dom_history');
  assert.strictEqual(result.processPatch.completedResponseText, stage12Json);
  assert.strictEqual(stage12ScanCalls, 1, 'process fallback should scan assistant history once');
  assert.strictEqual(lastAssistantReadCount, 0, 'process fallback should not use the last assistant text when Stage 12 JSON is found');
}

async function testReplayPreservesStage12CopySelectionMetadata() {
  const saveCalls = [];
  const stage12Json = JSON.stringify({
    schema: 'economist.response.v2',
    records: [
      {
        decision_role: 'PRIMARY',
        fields: {
          spolka: 'Ajinomoto (2802.T:Tokyo)',
          status_decyzji: 'WATCH',
          teza_inwestycyjna: 'Valid Stage 12 JSON'
        }
      }
    ]
  });
  const context = buildVmContext({
    resolveCompletedProcessFinalResponseText: async () => ({
      success: true,
      responseText: stage12Json
    }),
    getCompletedProcessLocalSaveState: () => false,
    hasCompletedProcessLocalSave: () => false,
    extractResponseIdFromCopyTrace: () => '',
    buildRestartReplayResponseId(runId, responseText, promptNumber) {
      return `${runId}_p${promptNumber}_${responseText.length}`;
    },
    normalizeChatConversationUrl(value) {
      return typeof value === 'string' ? value.trim() : '';
    },
    resolveSupportedSourceNameFromUrl() {
      return 'ChatGPT Invest';
    },
    saveResponse: async (...args) => {
      saveCalls.push(args);
      return {
        success: true,
        copyTrace: 'copy/replay-stage12',
        dispatch: {
          accepted: 1,
          sent: 1,
          failed: 0,
          verifyState: 'http_accepted'
        },
        conversationAnalysis: {
          conversationLogCount: 1
        }
      };
    },
    formatDispatchUiSummary(dispatch) {
      return dispatch && dispatch.accepted === 1 ? 'accepted=1' : '';
    }
  });

  vm.runInContext(extractFunctionSource(backgroundSource, 'replayCompletedResponseForProcess'), context);

  const result = await context.replayCompletedResponseForProcess(
    {
      id: 'run-stage12-replay',
      title: 'Stage 12 replay',
      analysisType: 'company',
      currentPrompt: 15,
      stageIndex: 14,
      chatUrl: 'https://chatgpt.com/c/stage12-replay'
    },
    {
      force: true,
      selectedPrompt: 12,
      selectedStageIndex: 11,
      selectedResponseReason: 'manual_copy_stage12_dom_history'
    }
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(saveCalls.length, 1, 'replay should save the selected Stage 12 response once');
  assert.strictEqual(saveCalls[0][0], stage12Json);
  assert.strictEqual(saveCalls[0][4], `run-stage12-replay_p12_${stage12Json.length}`);
  assert.strictEqual(saveCalls[0][5].selected_response_prompt, 12);
  assert.strictEqual(saveCalls[0][5].selected_response_stage_index, 11);
  assert.strictEqual(saveCalls[0][5].selected_response_reason, 'manual_copy_stage12_dom_history');
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

async function testCopyLatestInvestBatchSettleRetriesAcrossRounds() {
  const eventCalls = [];
  let retryCalls = 0;
  const processRegistry = new Map([
    ['run-batch-settle', {
      id: 'run-batch-settle',
      persistenceStatus: {
        saveOk: true,
        dispatch: {
          state: 'dispatch_pending',
          accepted: 0,
          sent: 0,
          failed: 0,
          deferred: 0,
          remaining: 1,
          verifyState: ''
        }
      }
    }]
  ]);
  const context = buildVmContext({
    processRegistry,
    resolveInvestCopyTargets: async (options) => ({
      success: true,
      scope: 'all_open_windows',
      investTabCount: 1,
      windowCount: 1,
      targets: [
        { tabId: 401, windowId: 41, title: 'Delta', url: 'https://chatgpt.com/c/delta', process: { id: 'run-batch-settle' } }
      ]
    }),
    copyLatestInvestFinalResponseForTarget: async (target, options) => ({
      success: true,
      text: 'DELTA FINAL',
      textLength: 11,
      tabId: target.tabId,
      windowId: target.windowId,
      title: target.title,
      conversationUrl: 'https://chatgpt.com/c/delta',
      processId: 'run-batch-settle',
      persistence: {
        attempted: true,
        success: true,
        localSaveOk: true,
        mode: 'retry_existing_dispatch',
        reason: 'dispatch_retry_pending',
        copyTrace: 'trace-401',
        dispatchSummary: 'pending',
        dispatch: {
          state: 'dispatch_pending',
          accepted: 0,
          sent: 0,
          failed: 0,
          deferred: 0,
          remaining: 1,
          verifyState: ''
        },
        acceptedByIntake: false,
        verifiedInDb: false,
        terminalFailure: false,
        verifyState: ''
      },
      scope: 'all_open_windows',
      targetOrdinal: options.targetOrdinal,
      targetTotal: options.targetTotal
    }),
    runCompletedProcessPersistenceRetry: async (runId) => {
      retryCalls += 1;
      if (retryCalls === 1) {
        processRegistry.set(runId, {
          id: runId,
          persistenceStatus: {
            saveOk: true,
            dispatch: {
              state: 'dispatch_pending',
              accepted: 1,
              sent: 1,
              failed: 0,
              deferred: 0,
              remaining: 1,
              verifyState: 'http_accepted'
            }
          }
        });
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
      }
      processRegistry.set(runId, {
        id: runId,
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
      return {
        success: true,
        confirmed: true,
        delivery: {
          saveOk: true,
          state: 'dispatch_confirmed',
          failed: 0,
          pending: 0,
          confirmed: true
        }
      };
    },
    formatDispatchUiSummary(dispatch) {
      if (!dispatch || typeof dispatch !== 'object') return '';
      if (dispatch.verifyState === 'verified') return 'verified=1';
      if (dispatch.accepted === 1) return 'accepted=1';
      return 'pending';
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
    batchPersistenceSettleBudgetMs: 5000,
    batchPersistenceSettleMaxRounds: 4,
    batchPersistenceSettlePollMs: 0
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.copied, 1);
  assert.strictEqual(result.localSaveSuccessCount, 1);
  assert.strictEqual(result.intakeAcceptedCount, 1);
  assert.strictEqual(result.verifiedDbCount, 1);
  assert.strictEqual(retryCalls, 2, 'batch settle should revisit the same process until it verifies');
  assert.strictEqual(result.results[0].persistence.acceptedByIntake, true);
  assert.strictEqual(result.results[0].persistence.verifiedInDb, true);
  const summaryEvent = eventCalls[eventCalls.length - 1];
  assert.strictEqual(summaryEvent.dispatchSummary, 'copied=1/1, failed=0, save=1/1, accepted=1, verified=1, terminal=0, urls=1');
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

async function testCopyLatestInvestCountsFinalStagePersistenceAsLocalSave() {
  const saveCalls = [];
  const retryCalls = [];
  const dispatch = {
    state: 'dispatch_pending',
    accepted: 1,
    sent: 0,
    failed: 0,
    deferred: 1,
    remaining: 0,
    verifyState: 'http_accepted'
  };
  const context = buildVmContext({
    processRegistry: new Map([
      ['run-final-stage', {
        id: 'run-final-stage',
        finalStagePersistence: {
          success: true,
          dispatch,
          state: 'dispatch_pending',
          verifyState: 'http_accepted'
        },
        completedResponseDispatch: dispatch
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
      dispatch,
      dispatchSummary: 'accepted=1'
    }),
    runCompletedProcessPersistenceRetry: async (...args) => {
      retryCalls.push(args);
      return {
        success: false,
        skipped: true,
        reason: 'retry_in_flight'
      };
    },
    upsertProcess: async () => true,
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
    'getCompletedProcessLocalSaveState',
    'hasCompletedProcessLocalSave',
    'resolveInvestCopyDomFallback',
    'resolveCopyLatestInvestResponsePayload',
    'copyLatestInvestFinalResponseForTarget'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context);
  });

  const result = await context.copyLatestInvestFinalResponseForTarget(
    {
      tabId: 98,
      windowId: 12,
      title: 'Invest final stage',
      url: 'https://chatgpt.com/c/invest-final-stage',
      conversationUrl: 'https://chatgpt.com/c/invest-final-stage',
      process: {
        id: 'run-final-stage'
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
  assert.strictEqual(result.persistence.localSaveOk, true);
  assert.strictEqual(result.persistence.acceptedByIntake, true);
  assert.strictEqual(result.persistence.reason, 'retry_in_flight');
  assert.strictEqual(retryCalls.length, 1, 'completed process should still attempt dispatch retry');
  assert.strictEqual(saveCalls.length, 0, 'finalStagePersistence-backed process should not fall back to direct save');
}

async function testCopyLatestInvestCountsRetryDeliverySaveOkAsLocalSave() {
  const saveCalls = [];
  const retryCalls = [];
  const dispatch = {
    state: 'dispatch_pending',
    accepted: 1,
    sent: 1,
    failed: 0,
    deferred: 1,
    remaining: 0,
    verifyState: 'http_accepted'
  };
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
      reason: 'already_saved_retryable',
      recoveryMode: 'retry_existing_dispatch',
      dispatch,
      dispatchSummary: 'accepted=1'
    }),
    runCompletedProcessPersistenceRetry: async (...args) => {
      retryCalls.push(args);
      return {
        success: false,
        reason: 'retry_in_flight',
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
      tabId: 108,
      windowId: 18,
      title: 'Invest retry delivery',
      url: 'https://chatgpt.com/c/invest-retry-delivery',
      conversationUrl: 'https://chatgpt.com/c/invest-retry-delivery',
      process: {
        id: 'run-retry-delivery'
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
  assert.strictEqual(result.persistence.localSaveOk, true);
  assert.strictEqual(result.persistence.acceptedByIntake, true);
  assert.strictEqual(result.persistence.reason, 'retry_in_flight');
  assert.strictEqual(retryCalls.length, 1, 'retryable process should still attempt dispatch retry');
  assert.strictEqual(saveCalls.length, 0, 'delivery.saveOk should prevent duplicate direct save');
}

async function testCopyLatestInvestRecoversUsingKnownResponseWhenReplayFails() {
  const saveCalls = [];
  const eventCalls = [];
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
      success: false,
      reason: 'missing_response_text'
    }),
    upsertProcess: async () => true,
    reportCopyLatestInvestFinalResponseEvent(payload) {
      eventCalls.push(payload);
    },
    saveResponse: async (...args) => {
      saveCalls.push(args);
      return {
        success: true,
        copyTrace: 'manual/recovered',
        verifiedCount: 7,
        dispatch: {
          state: 'dispatch_pending',
          accepted: 1,
          sent: 1,
          failed: 0,
          deferred: 1,
          remaining: 0,
          verifyState: 'http_accepted'
        },
        dispatchProcessLog: ['queue_attempt|start|responseId=manual'],
        conversationAnalysis: {
          conversationLogCount: 2
        }
      };
    },
    formatDispatchUiSummary(dispatch) {
      return dispatch && dispatch.accepted === 1 ? 'accepted=1' : '';
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
      tabId: 118,
      windowId: 19,
      title: 'Invest replay fallback',
      url: 'https://chatgpt.com/c/invest-replay-fallback',
      conversationUrl: 'https://chatgpt.com/c/invest-replay-fallback',
      process: {
        id: 'run-replay-fallback',
        stageIndex: 12,
        currentPrompt: 13
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
  assert.strictEqual(result.persistence.mode, 'manual_copy_recovered');
  assert.strictEqual(result.persistence.success, true);
  assert.strictEqual(result.persistence.localSaveOk, true);
  assert.strictEqual(result.persistence.acceptedByIntake, true);
  assert.strictEqual(result.persistence.reason, 'saved');
  assert.strictEqual(result.persistence.dispatchSummary, 'accepted=1');
  assert.strictEqual(saveCalls.length, 1, 'known response should be persisted directly when replay cannot recover');
  assert.strictEqual(saveCalls[0][0], 'VALID FINAL RESPONSE');
  assert.strictEqual(saveCalls[0][3], 'run-replay-fallback');
  assert.ok(/^run-replay-fallback_manual_copy_p13_[0-9a-f]{8}$/.test(saveCalls[0][4]));
  assert.ok(eventCalls.length > 0, 'copy flow should still emit telemetry for recovered save');
}

async function main() {
  await testCopyLatestInvestRequestsClosedProcesses();
  await testResolveInvestCopyTargetsAcceptsLegacyInvestUrls();
  await testResolveInvestCopyTargetsFallsBackToProcessContextWhenNoInvestTabs();
  await testResolveInvestCopyTargetsIgnoresNonInvestProcessFromSameWindow();
  await testResolveInvestCopyTargetsPrefersLiveTabOverProcessFallbackInSameWindow();
  await testFindInvestCopyProcessUsesConversationHistory();
  await testCopyLatestInvestFallsBackToDirectSaveWithoutProcess();
  await testCopyLatestInvestDirectSaveUsesStage12DomHistoryBeforeLastMessage();
  await testResolveCopyLatestInvestReturnsFinalProcessNotFoundWhenDomIsEmpty();
  await testResolveCopyLatestInvestRetriesProcessDomFallbackAfterActivation();
  await testResolveCopyLatestInvestPrefersStage12DomHistoryForProcessFallback();
  await testReplayPreservesStage12CopySelectionMetadata();
  await testResolveCopyLatestInvestPassesThroughProcessPatchFromStrictResolution();
  await testResolveCopyLatestInvestReportsInvalidContractForRejectedDomFallback();
  await testResolveCopyLatestInvestRetriesDirectFallbackAfterActivation();
  await testCopyLatestInvestBatchReportsPartialSuccessAcrossAllWindows();
  await testCopyLatestInvestBatchSettleRetriesAcrossRounds();
  await testCopyLatestInvestUsesAlreadySavedProcessWithoutDuplicateDirectSave();
  await testCopyLatestInvestAllowsProcessOnlyTargetWithoutTabId();
  await testCopyLatestInvestCountsFinalStagePersistenceAsLocalSave();
  await testCopyLatestInvestCountsRetryDeliverySaveOkAsLocalSave();
  await testCopyLatestInvestRecoversUsingKnownResponseWhenReplayFails();
  console.log('test-copy-latest-invest-final-response.js: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
