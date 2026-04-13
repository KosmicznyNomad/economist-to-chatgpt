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
  const auditLogs = [];
  let removeAttempt = 0;

  const context = vm.createContext({
    console,
    Date,
    Math,
    Number,
    String,
    Array,
    JSON,
    Map,
    Set,
    ProcessContractUtils,
    PROCESS_WINDOW_CLOSE_RETRY: {
      initialDelayMs: 1500,
      maxDelayMs: 60 * 1000,
      maxAttempts: 24
    },
    processRegistry: new Map(),
    processWindowCloseRetryTimersByRunId: new Map(),
    processWindowCloseRetryAttemptCountByRunId: new Map(),
    processWindowCloseRetryInFlight: new Set(),
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
    'normalizeProcessLifecycleStatus',
    'normalizeProcessStatus',
    'resolveProcessStageSnapshot',
    'hasProcessReachedFinalStage',
    'isExplicitlyVerifiedDispatch',
    'getProcessPersistenceDispatchSnapshot',
    'getProcessQueueDeliveryState',
    'normalizeProcessWindowCloseState',
    'inspectProcessWindowContext',
    'attemptProcessWindowClose',
    'getProcessWindowCloseRetryDelayMs',
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
    currentPrompt: 13,
    totalPrompts: 13,
    stageIndex: 12,
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

  const retryClose = await context.runProcessWindowCloseRetry('run-close', {
    origin: 'test-retry'
  });

  assert.strictEqual(retryClose.closed, true);
  assert.strictEqual(removeAttempt, 2);
  assert.strictEqual(context.processRegistry.get('run-close').windowClose.state, 'closed');
  assert.ok(Number.isInteger(context.processRegistry.get('run-close').windowClose.closedAt));
  assert(
    auditLogs.some((entry) => entry.code === 'completed_process_window_close_result' && entry.details?.state === 'retrying'),
    'Should log pending window-close retries.'
  );
  assert(
    auditLogs.some((entry) => entry.code === 'completed_process_window_close_result' && entry.details?.state === 'closed'),
    'Should log successful window-close completion.'
  );

  console.log('test-process-window-close-retry.js: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
