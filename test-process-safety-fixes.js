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

function createFixedDate(nowTs) {
  return class FixedDate extends Date {
    constructor(...args) {
      if (args.length === 0) {
        super(nowTs);
        return;
      }
      super(...args);
    }

    static now() {
      return nowTs;
    }
  };
}

async function testHeartbeatUsesRealProgressTimestamp() {
  const nowTs = 1_773_918_000_000;
  const warnings = [];
  const touches = [];
  const context = {
    console,
    Math,
    Number,
    Date: createFixedDate(nowTs),
    PROCESS_MONITOR_HEARTBEAT: {
      touchIntervalMs: 30_000,
      staleTtlMs: 90_000,
      staleWarnCooldownMs: 60_000
    },
    processMonitorHeartbeatSweepInProgress: false,
    processStaleWarnLastEmitTsByRunId: new Map(),
    processRegistry: new Map([
      ['run-recent-progress', {
        id: 'run-recent-progress',
        status: 'running',
        timestamp: nowTs - 120_000,
        lastProgressAt: nowTs - 10_000
      }]
    ]),
    ensureProcessRegistryReady: async () => {},
    pruneProcessRecords: (items) => items,
    isClosedProcessStatus: (status) => status === 'completed' || status === 'failed' || status === 'stopped',
    isQueuedProcessStatus: (status) => status === 'queued',
    shouldEmitProcessStaleWarning: () => true,
    appendProcessHeartbeatStaleWarning: async (...args) => {
      warnings.push(args);
      return true;
    },
    upsertProcess: async (runId, patch) => {
      touches.push({ runId, patch });
      return { id: runId, ...patch };
    },
    pruneProcessStaleWarnMap: () => {}
  };

  vm.createContext(context);
  vm.runInContext(extractFunctionSource(backgroundSource, 'getProcessLastActivityTimestamp'), context);
  vm.runInContext(extractFunctionSource(backgroundSource, 'getProcessLastProgressTimestamp'), context);
  vm.runInContext(extractFunctionSource(backgroundSource, 'runProcessMonitorHeartbeatSweep'), context);

  const result = await context.runProcessMonitorHeartbeatSweep('test');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.staleDetected, 0);
  assert.strictEqual(warnings.length, 0);
  assert.strictEqual(touches.length, 1);
  assert.strictEqual(touches[0].runId, 'run-recent-progress');
}

async function testHeartbeatStillFlagsOldProgressWhenRecordWasTouched() {
  const nowTs = 1_773_918_100_000;
  const warnings = [];
  const touches = [];
  const context = {
    console,
    Math,
    Number,
    Date: createFixedDate(nowTs),
    PROCESS_MONITOR_HEARTBEAT: {
      touchIntervalMs: 30_000,
      staleTtlMs: 90_000,
      staleWarnCooldownMs: 60_000
    },
    processMonitorHeartbeatSweepInProgress: false,
    processStaleWarnLastEmitTsByRunId: new Map(),
    processRegistry: new Map([
      ['run-stale-progress', {
        id: 'run-stale-progress',
        status: 'running',
        timestamp: nowTs - 5_000,
        lastProgressAt: nowTs - 120_000
      }]
    ]),
    ensureProcessRegistryReady: async () => {},
    pruneProcessRecords: (items) => items,
    isClosedProcessStatus: (status) => status === 'completed' || status === 'failed' || status === 'stopped',
    isQueuedProcessStatus: (status) => status === 'queued',
    shouldEmitProcessStaleWarning: () => true,
    appendProcessHeartbeatStaleWarning: async (...args) => {
      warnings.push(args);
      return true;
    },
    upsertProcess: async (runId, patch) => {
      touches.push({ runId, patch });
      return { id: runId, ...patch };
    },
    pruneProcessStaleWarnMap: () => {}
  };

  vm.createContext(context);
  vm.runInContext(extractFunctionSource(backgroundSource, 'getProcessLastActivityTimestamp'), context);
  vm.runInContext(extractFunctionSource(backgroundSource, 'getProcessLastProgressTimestamp'), context);
  vm.runInContext(extractFunctionSource(backgroundSource, 'runProcessMonitorHeartbeatSweep'), context);

  const result = await context.runProcessMonitorHeartbeatSweep('test');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.staleDetected, 1);
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(touches.length, 0);
}

function testCompanyAuditFrontierSkipsFuturePrompts() {
  const context = {
    console,
    Math,
    Number,
    normalizeProcessStatus: (status) => String(status || '').trim().toLowerCase()
  };
  vm.createContext(context);
  vm.runInContext(extractFunctionSource(backgroundSource, 'extractPromptProgressFromChatTitle'), context);
  vm.runInContext(extractFunctionSource(backgroundSource, 'resolveCompanyConversationAuditPromptFrontier'), context);
  vm.runInContext(extractFunctionSource(backgroundSource, 'filterCompanyConversationMissingPromptNumbers'), context);
  vm.runInContext(extractFunctionSource(backgroundSource, 'isCompanyConversationActiveProcess'), context);
  vm.runInContext(extractFunctionSource(backgroundSource, 'isCompanyConversationFrontierPromptPending'), context);

  const parsed = context.extractPromptProgressFromChatTitle('[P5/14] ChatGPT - inwestycje', 14);
  assert.strictEqual(parsed.currentPrompt, 5);
  assert.strictEqual(parsed.totalPrompts, 14);

  const frontier = context.resolveCompanyConversationAuditPromptFrontier({
    promptCount: 14,
    recognizedPromptNumbers: [1, 2, 3, 4],
    targetTabTitle: '[P5/14] ChatGPT - inwestycje'
  });
  assert.strictEqual(frontier, 5);

  const missing = context.filterCompanyConversationMissingPromptNumbers(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
    new Set([1, 2, 3, 4, 5]),
    frontier
  );
  assert.deepStrictEqual(missing, []);

  assert.strictEqual(
    context.isCompanyConversationFrontierPromptPending(
      5,
      { status: 'running', currentPrompt: 5, needsAction: false },
      5
    ),
    true
  );
  assert.strictEqual(
    context.isCompanyConversationFrontierPromptPending(
      5,
      { status: 'running', currentPrompt: 5, needsAction: true },
      5
    ),
    false
  );
}

async function main() {
  await testHeartbeatUsesRealProgressTimestamp();
  await testHeartbeatStillFlagsOldProgressWhenRecordWasTouched();
  testCompanyAuditFrontierSkipsFuturePrompts();
  console.log('test-process-safety-fixes: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
