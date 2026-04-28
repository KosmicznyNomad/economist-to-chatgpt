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
  const paramsStart = source.indexOf('(', match.index);
  let parenDepth = 0;
  let braceStart = -1;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let index = paramsStart; index < source.length; index += 1) {
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
      if (!escaped && char === "'") inSingle = false;
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
    if (char === "'") {
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
        braceStart = source.indexOf('{', index);
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
      if (!escaped && char === "'") inSingle = false;
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
    if (char === "'") {
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

function createContext({ tabs = [], processes = [] } = {}) {
  const context = {
    console,
    URL,
    Set,
    Map,
    Date,
    Math,
    Number,
    String,
    Array,
    RegExp,
    JSON,
    CHAT_GPT_HOSTS: new Set(['chatgpt.com', 'chat.openai.com']),
    INVEST_GPT_URL_BASE: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-inwestycje',
    INVEST_GPT_PATH_BASE: '/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-inwestycje',
    PROMPTS_COMPANY: new Array(12).fill('prompt'),
    processRegistry: new Map(),
    chrome: {
      tabs: {
        async query() {
          return tabs;
        }
      }
    },
    async getProcessSnapshot() {
      return processes;
    },
    normalizeProcessStatus(status) {
      return String(status || '').trim().toLowerCase() || 'running';
    },
    isClosedProcessStatus(status) {
      return ['completed', 'failed', 'stopped'].includes(String(status || '').trim().toLowerCase());
    },
    isQueuedProcessStatus(status) {
      return String(status || '').trim().toLowerCase() === 'queued';
    },
    normalizeConversationUrlList(urls) {
      return (Array.isArray(urls) ? urls : [])
        .map((url) => context.normalizeChatConversationUrl(url))
        .filter(Boolean);
    },
    compareProcessesForRestore(left, right) {
      return String(left?.id || '').localeCompare(String(right?.id || ''));
    },
    async ensureProcessRegistryReady() {},
    sanitizeReloadResumeMonitorAutoCloseStatus(value) {
      return value;
    }
  };

  vm.createContext(context);
  [
    'normalizeChatConversationUrl',
    'isChatGptUrl',
    'isInvestGptUrl',
    'getTabEffectiveUrl',
    'compareTabsByWindowAndIndex',
    'getCompanyInvestProcessUrls',
    'processHasInvestChatContext',
    'isLikelyActiveCompanyInvestProcess',
    'canResumeCompanyInvestContextFromUrl',
    'collectCompanyInvestContextSnapshot',
    'getReloadResumeMonitorRowIdentity',
    'isReloadResumeRowLaunchConfirmed',
    'buildReloadResumeAutoCloseTabLabel',
    'evaluateReloadResumeAutoCloseForTab',
    'buildReloadResumeMonitorAutoCloseStatus'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
      filename: 'background.js'
    });
  });
  return context;
}

async function testResumeAllFindsProcessWhenTabIsGenericChatGptConversation() {
  const process = {
    id: 'queue-article-test',
    analysisType: 'company',
    status: 'finalizing',
    tabId: 10,
    windowId: 1,
    currentPrompt: 9,
    totalPrompts: 12,
    chatUrl: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-inwestycje/c/abc',
    title: 'AI source'
  };
  const context = createContext({
    tabs: [
      {
        id: 10,
        windowId: 1,
        index: 0,
        title: 'AI source - ChatGPT',
        url: 'https://chatgpt.com/c/abc'
      }
    ],
    processes: [process]
  });

  const snapshot = await context.collectCompanyInvestContextSnapshot({
    includeClosedProcesses: false,
    includeInvestTabs: true,
    includeProcessContextFallback: true
  });

  assert.strictEqual(snapshot.investTabs.length, 0);
  assert.strictEqual(snapshot.processCandidates.length, 1);
  assert.strictEqual(snapshot.targets.length, 1);
  assert.strictEqual(snapshot.targets[0].source, 'process_context');
  assert.strictEqual(snapshot.targets[0].tabId, 10);
  assert.strictEqual(context.canResumeCompanyInvestContextFromUrl('https://chatgpt.com/c/abc', process), true);
}

async function testResumeAllUsesInvocationWindowFallbackForProcessContext() {
  const process = {
    id: 'queue-article-window-only',
    analysisType: 'company',
    status: 'running',
    invocationWindowId: 22,
    currentPrompt: 3,
    totalPrompts: 12,
    chatUrl: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-inwestycje/c/window-only',
    title: 'Window-only process'
  };
  const context = createContext({
    tabs: [
      {
        id: 222,
        windowId: 22,
        index: 0,
        title: 'Generic ChatGPT',
        url: 'https://chatgpt.com/c/window-only'
      }
    ],
    processes: [process]
  });

  const snapshot = await context.collectCompanyInvestContextSnapshot({
    includeClosedProcesses: false,
    includeInvestTabs: true,
    includeProcessContextFallback: true
  });

  assert.strictEqual(snapshot.processCandidates.length, 1);
  assert.strictEqual(snapshot.targets.length, 1);
  assert.strictEqual(snapshot.targets[0].source, 'process_context');
  assert.strictEqual(snapshot.targets[0].tabId, null);
  assert.strictEqual(snapshot.targets[0].windowId, 22);
}

async function testAutoCloseWaitsForRowOnlyStartedProcessConfirmation() {
  const context = createContext({ tabs: [], processes: [] });
  const state = {
    status: 'completed',
    rows: [
      {
        key: 'run:queue-article-test',
        runId: 'queue-article-test',
        action: 'started',
        title: 'AI source'
      }
    ]
  };

  let status = await context.buildReloadResumeMonitorAutoCloseStatus(state);
  assert.strictEqual(status.ready, false);
  assert.strictEqual(status.matchedTabs, 1);
  assert.strictEqual(status.launchRequired, 1);
  assert.strictEqual(status.launchConfirmed, 0);

  context.processRegistry.set('queue-article-test', {
    id: 'queue-article-test',
    status: 'running'
  });
  status = await context.buildReloadResumeMonitorAutoCloseStatus(state);
  assert.strictEqual(status.ready, true);
  assert.strictEqual(status.matchedTabs, 1);
  assert.strictEqual(status.launchRequired, 1);
  assert.strictEqual(status.launchConfirmed, 1);
}

async function main() {
  await testResumeAllFindsProcessWhenTabIsGenericChatGptConversation();
  await testResumeAllUsesInvocationWindowFallbackForProcessContext();
  await testAutoCloseWaitsForRowOnlyStartedProcessConfirmation();
  console.log('test-resume-all-process-fallback.js passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
