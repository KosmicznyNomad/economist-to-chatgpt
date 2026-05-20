const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const backgroundPath = path.join(__dirname, 'background.js');
const backgroundSource = fs.readFileSync(backgroundPath, 'utf8');

function extractFunctionSource(source, functionName) {
  const pattern = new RegExp(`function\\s+${functionName}\\s*\\(`);
  const match = pattern.exec(source);
  if (!match) {
    throw new Error(`Function not found: ${functionName}`);
  }
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
        return source.slice(match.index, index + 1);
      }
    }
  }
  throw new Error(`Function end not found: ${functionName}`);
}

const context = {
  console,
  Date,
  Math,
  PROBLEM_LOG_MAX_TEXT_LENGTH: 600,
  WATCHLIST_DISPATCH: { verifyTimeoutMs: 120_000 },
  normalizeProcessStatus(value) {
    return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : 'running';
  },
  normalizeProcessLifecycleStatus(value, fallback = 'running') {
    return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : fallback;
  },
  isFailedProcessStatus(status) {
    return ['failed', 'error', 'stopped'].includes(String(status || '').trim().toLowerCase());
  },
  isClosedProcessStatus(status) {
    return ['completed', 'failed', 'stopped'].includes(String(status || '').trim().toLowerCase());
  },
  normalizeProcessActionRequired(value, fallback = 'none') {
    return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : fallback;
  },
  deriveProcessActionRequired() {
    return 'none';
  },
  extractProcessChatUrl(process) {
    return typeof process?.chatUrl === 'string' ? process.chatUrl : '';
  },
  normalizeProblemLogSourceUrl(value) {
    return typeof value === 'string' ? value.trim() : '';
  },
  normalizeChatConversationUrl(value) {
    return typeof value === 'string' ? value.trim() : '';
  },
  normalizeProcessWindowCloseState(value) {
    return value && typeof value === 'object' ? value : null;
  },
  getProcessPersistenceDispatchSnapshot(process) {
    if (process?.persistenceStatus?.dispatch && typeof process.persistenceStatus.dispatch === 'object') {
      return process.persistenceStatus.dispatch;
    }
    if (process?.finalStagePersistence && typeof process.finalStagePersistence === 'object') {
      return process.finalStagePersistence;
    }
    return null;
  },
  isExplicitlyVerifiedDispatch(dispatch) {
    return dispatch?.state === 'dispatch_confirmed' || dispatch?.verifyState === 'verified';
  }
};

vm.createContext(context);
[
  'trimProblemLogText',
  'normalizeProblemLogLevel',
  'problemLogSourceMatches',
  'processProblemLogBlob',
  'hasOperationalProblemLogMarker',
  'isNormalProcessProblemLogEntry',
  'isLowSignalProblemLogEntry',
  'shouldDispatchProblemLogRemotely',
  'shouldRecordIssueForProcess',
  'resolveProcessDispatchProblemReason',
  'resolveProcessOperationalProblemReason',
  'problemLogLevelForOperationalReason',
  'shouldRecordSuccessForProcess',
  'buildProcessSuccessReason',
  'buildProcessSuccessStatusText',
  'buildProcessStateReason',
  'buildProcessStateStatusText',
  'resolveProcessStageSnapshot',
  'buildProcessProblemLogEntry'
].forEach((functionName) => {
  vm.runInContext(extractFunctionSource(backgroundSource, functionName), context);
});

function testNormalCompletedProcessIsNotLogged() {
  const entry = context.buildProcessProblemLogEntry('run-ok', {
    status: 'completed',
    lifecycleStatus: 'completed',
    currentPrompt: 3,
    totalPrompts: 3,
    title: 'Normal process'
  });

  assert.strictEqual(entry, null);
  assert.strictEqual(context.shouldDispatchProblemLogRemotely({
    source: 'process-monitor',
    category: 'process_state',
    level: 'info',
    status: 'completed',
    reason: 'ok_completed',
    message: 'completed 3/3'
  }), false);
}

function testDispatchPendingProcessIsLogged() {
  const entry = context.buildProcessProblemLogEntry('run-dispatch', {
    status: 'completed',
    lifecycleStatus: 'completed',
    currentPrompt: 4,
    totalPrompts: 4,
    title: 'Dispatch pending process',
    completedResponseSaved: true,
    persistenceStatus: {
      saveOk: true,
      dispatch: {
        state: 'queued',
        sent: 0,
        failed: 0,
        pending: 1,
        updatedAt: Date.now()
      }
    }
  });

  assert.ok(entry);
  assert.strictEqual(entry.reason, 'dispatch_pending');
  assert.strictEqual(entry.level, 'warn');
  assert.strictEqual(context.shouldDispatchProblemLogRemotely(entry), true);
}

function testQueueSkippedProcessIsNotMisclassifiedAsDispatchFailed() {
  const entry = context.buildProcessProblemLogEntry('run-skipped', {
    status: 'completed',
    lifecycleStatus: 'completed',
    currentPrompt: 3,
    totalPrompts: 3,
    title: 'Portfolio final JSON',
    completedResponseSaved: true,
    persistenceStatus: {
      saveOk: true,
      dispatch: {
        state: 'dispatch_skipped',
        queueSkipped: true,
        queueSkipReason: 'portfolio_analysis_saved_locally',
        failureStage: 'queue',
        failureReason: 'portfolio_analysis_saved_locally',
        sent: 0,
        failed: 0,
        pending: 0,
        updatedAt: Date.now()
      }
    }
  });

  assert.ok(entry);
  assert.strictEqual(entry.reason, 'dispatch_skipped');
  assert.strictEqual(entry.level, 'info');
  assert.strictEqual(context.shouldDispatchProblemLogRemotely(entry), false);
}

function testRetryProcessIsLogged() {
  const entry = context.buildProcessProblemLogEntry('run-retry', {
    status: 'running',
    lifecycleStatus: 'running',
    currentPrompt: 2,
    totalPrompts: 4,
    title: 'Retry process',
    reason: 'chat.retry_generation_error',
    statusText: 'Clicked Retry after ChatGPT generation error'
  });

  assert.ok(entry);
  assert.strictEqual(entry.reason, 'chat.retry_generation_error');
  assert.strictEqual(context.shouldDispatchProblemLogRemotely(entry), true);
}

testNormalCompletedProcessIsNotLogged();
testDispatchPendingProcessIsLogged();
testQueueSkippedProcessIsNotMisclassifiedAsDispatchFailed();
testRetryProcessIsLogged();

console.log('test-problem-log-remote-filter.js: ok');
