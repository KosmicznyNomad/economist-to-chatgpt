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
  const paramsStart = source.indexOf('(', startIndex);
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

function createCompletedProcess() {
  return {
    id: 'run-persist',
    status: 'completed',
    lifecycleStatus: 'completed',
    currentPrompt: 15,
    totalPrompts: 15,
    stageIndex: 14,
    completedResponseSaved: true,
    completedResponseText: '{"schema":"economist.response.v2","records":[{"ticker":"ABC","decision":"PRIMARY"}]}',
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
  };
}

async function testScheduleCreatesDurableAlarm() {
  const timers = [];
  const createCalls = [];
  const clearCalls = [];
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
    COMPLETED_PROCESS_PERSISTENCE_RETRY: {
      initialDelayMs: 2000,
      maxDelayMs: 5 * 60 * 1000,
      maxAttempts: 96,
      alarmName: 'completed-process-persistence-retry'
    },
    completedProcessPersistenceRetryTimersByRunId: new Map(),
    completedProcessPersistenceRetryAttemptCountByRunId: new Map(),
    completedProcessPersistenceRetryDueAtByRunId: new Map(),
    completedProcessPersistenceRetryInFlight: new Set(),
    chrome: {
      alarms: {
        create(name, info) {
          createCalls.push({ name, info });
        }
      }
    },
    clearAlarmSafe: async (alarmName) => {
      clearCalls.push(alarmName);
      return true;
    },
    processRegistry: new Map(),
    normalizeWatchlistVerifyState(value) {
      return typeof value === 'string' ? value.trim().toLowerCase() : '';
    },
    extractAssistantTextFromProcess(process) {
      return process && typeof process.completedResponseText === 'string' ? process.completedResponseText : '';
    },
    buildProcessCopyTrace() {
      return 'run-persist/resp';
    },
    emitWatchlistDispatchProcessLog() {},
    setTimeout(callback, delayMs) {
      const id = timers.length + 1;
      timers.push({ id, callback, delayMs });
      return id;
    },
    clearTimeout() {}
  });

  [
    'getCompletedProcessFinalityState',
    'normalizeProcessLifecycleStatus',
    'normalizeProcessStatus',
    'resolveProcessStageSnapshot',
    'hasProcessReachedFinalStage',
    'isExplicitlyVerifiedDispatch',
    'getProcessPersistenceDispatchSnapshot',
    'getProcessQueueDeliveryState',
    'getCompletedProcessPersistenceRetryDelayMs',
    'resolveCompletedProcessPersistenceRetryPlan',
    'computeProcessRetryAlarmAt',
    'syncCompletedProcessPersistenceRetryAlarm',
    'clearCompletedProcessPersistenceRetry',
    'scheduleCompletedProcessPersistenceRetry'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
      filename: 'background.js'
    });
  });

  const scheduled = context.scheduleCompletedProcessPersistenceRetry(createCompletedProcess(), {
    origin: 'test-schedule',
    force: true
  });

  assert.strictEqual(scheduled, true);
  assert.strictEqual(timers.length, 1);
  assert.strictEqual(createCalls.length, 1);
  assert.strictEqual(createCalls[0].name, 'completed-process-persistence-retry');
  assert.strictEqual(clearCalls.length, 1);
}

async function testAlarmFallbackRunsPendingProcessWhenDueMapIsEmpty() {
  const attempts = [];
  const clearCalls = [];
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
    COMPLETED_PROCESS_PERSISTENCE_RETRY: {
      initialDelayMs: 2000,
      maxDelayMs: 5 * 60 * 1000,
      maxAttempts: 96,
      alarmName: 'completed-process-persistence-retry'
    },
    completedProcessPersistenceRetryTimersByRunId: new Map(),
    completedProcessPersistenceRetryAttemptCountByRunId: new Map(),
    completedProcessPersistenceRetryDueAtByRunId: new Map(),
    completedProcessPersistenceRetryInFlight: new Set(),
    processRegistry: new Map([
      ['run-persist', createCompletedProcess()]
    ]),
    chrome: {
      alarms: {
        create() {}
      }
    },
    clearAlarmSafe: async (alarmName) => {
      clearCalls.push(alarmName);
      return true;
    },
    ensureProcessRegistryReady: async () => {},
    pruneProcessRecords(items) {
      return items;
    },
    normalizeWatchlistVerifyState(value) {
      return typeof value === 'string' ? value.trim().toLowerCase() : '';
    },
    extractAssistantTextFromProcess(process) {
      return process && typeof process.completedResponseText === 'string' ? process.completedResponseText : '';
    },
    runCompletedProcessPersistenceRetry: async (runId, options) => {
      attempts.push({ runId, options });
      return { success: true, confirmed: false };
    }
  });

  [
    'getCompletedProcessFinalityState',
    'normalizeProcessLifecycleStatus',
    'normalizeProcessStatus',
    'resolveProcessStageSnapshot',
    'hasProcessReachedFinalStage',
    'isExplicitlyVerifiedDispatch',
    'getProcessPersistenceDispatchSnapshot',
    'getProcessQueueDeliveryState',
    'resolveCompletedProcessPersistenceRetryPlan',
    'computeProcessRetryAlarmAt',
    'syncCompletedProcessPersistenceRetryAlarm',
    'clearCompletedProcessPersistenceRetry',
    'runDueCompletedProcessPersistenceRetries'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
      filename: 'background.js'
    });
  });

  const result = await context.runDueCompletedProcessPersistenceRetries('test');

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.attempted, 1);
  assert.strictEqual(attempts.length, 1);
  assert.strictEqual(attempts[0].runId, 'run-persist');
  assert.strictEqual(attempts[0].options.origin, 'test_alarm');
  assert(clearCalls.includes('completed-process-persistence-retry'));
}

async function main() {
  await testScheduleCreatesDurableAlarm();
  await testAlarmFallbackRunsPendingProcessWhenDueMapIsEmpty();
  console.log('test-completed-process-retry-alarm.js: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
