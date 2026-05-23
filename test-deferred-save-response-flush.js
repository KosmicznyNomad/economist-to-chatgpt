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

function truncateDispatchLogText(value, maxLen = 180) {
  const normalized = typeof value === 'string' ? value : String(value ?? '');
  return normalized.length > maxLen ? normalized.slice(0, maxLen) : normalized;
}

const context = vm.createContext({
  console,
  Date,
  Math,
  Number,
  String,
  Array,
  truncateDispatchLogText,
  normalizeWatchlistEventId(value) {
    return typeof value === 'string' ? value.trim() : '';
  },
  normalizeWatchlistVerifyState(value) {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  },
  isWatchlistVerificationPendingState(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return normalized === 'http_accepted' || normalized === 'materialization_pending' || normalized === 'pending';
  },
  isWatchlistVerificationTerminalState(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return normalized === 'failed' || normalized === 'verify_failed' || normalized === 'terminal_failure';
  }
});

[
  'formatDispatchUiSummary',
  'formatVerifyDbUiSummary',
  'normalizeDispatchProcessLog',
  'isExplicitlyVerifiedDispatch',
  'summarizeFinalStagePersistence',
  'buildSaveResponseProcessPersistencePatch',
  'resolveSaveResponseDispatchPipelineState',
  'normalizeSaveResponseDispatchOutcome',
  'mergeSaveResponseDispatchWithFlushResult',
  'shouldStartDeferredSaveResponseFlush'
].forEach((functionName) => {
  vm.runInContext(extractFunctionSource(backgroundSource, functionName), context);
});

assert.match(backgroundSource, /deferDispatchFlush:\s*true/);
assert.match(backgroundSource, /deferredFlushReason:\s*'runtime_bridge_fast_ack'/);
assert.match(backgroundSource, /startDeferredSaveResponseFlush\(saveResult\)/);
assert.match(backgroundSource, /await updateProcessDispatchAfterFlushOutcome\(saveResult,\s*mergedDispatch,\s*mergedLog\);/);

const deferredDispatch = {
  queued: true,
  queueSize: 2,
  queueSkipped: false,
  flushDeferred: true,
  flushDeferredReason: 'runtime_bridge_fast_ack',
  flushSkipped: false,
  flushFollowUpScheduled: true,
  accepted: 0,
  sent: 0,
  failed: 0,
  deferred: 0,
  remaining: 2,
  verifyState: '',
  verifyReason: '',
  conversationLogCount: 40,
  hasConversationUrl: false,
  conversationSnapshotRefreshed: false,
  conversationSnapshotSource: 'save_snapshot'
};

assert.strictEqual(
  context.shouldStartDeferredSaveResponseFlush({
    success: true,
    dispatch: deferredDispatch
  }),
  true
);

const deferredDispatchSummary = context.formatDispatchUiSummary(deferredDispatch);
assert.match(deferredDispatchSummary, /WAIT@flush/);
assert.match(deferredDispatchSummary, /flush w tle/);

const deferredVerifySummary = context.formatVerifyDbUiSummary(deferredDispatch);
assert.match(deferredVerifySummary, /oczekiwanie na flush/);

const mergedPendingDispatch = context.mergeSaveResponseDispatchWithFlushResult(
  deferredDispatch,
  {
    accepted: 1,
    sent: 0,
    failed: 0,
    deferred: 1,
    remaining: 1,
    verifyState: 'materialization_pending',
    verifyReason: 'materialization_pending',
    verifyAttemptCount: 2,
    verifyEventId: 'evt-1',
    conversationLogCount: 5,
    hasConversationUrl: true,
    conversationSnapshotRefreshed: true,
    conversationSnapshotSource: 'verify_refresh'
  },
  {
    hasConversationUrl: false,
    conversationLogCount: 1,
    snapshotRefreshedBeforeSend: false,
    snapshotSource: 'save_snapshot'
  }
);

assert.strictEqual(mergedPendingDispatch.flushDeferred, false);
assert.strictEqual(mergedPendingDispatch.accepted, 1);
assert.strictEqual(mergedPendingDispatch.sent, 0);
assert.strictEqual(mergedPendingDispatch.deferred, 1);
assert.strictEqual(mergedPendingDispatch.remaining, 1);
assert.strictEqual(mergedPendingDispatch.verifyState, 'materialization_pending');
assert.strictEqual(mergedPendingDispatch.verifyEventId, 'evt-1');
assert.strictEqual(mergedPendingDispatch.conversationLogCount, 5);
assert.strictEqual(mergedPendingDispatch.hasConversationUrl, true);
assert.strictEqual(mergedPendingDispatch.conversationSnapshotRefreshed, true);
assert.strictEqual(mergedPendingDispatch.conversationSnapshotSource, 'verify_refresh');
assert.strictEqual(mergedPendingDispatch.state, 'dispatch_pending');

const mergedConfirmedDispatch = context.mergeSaveResponseDispatchWithFlushResult(
  deferredDispatch,
  {
    accepted: 1,
    sent: 1,
    failed: 0,
    deferred: 0,
    remaining: 0,
    verifyState: 'verified',
    verifyReason: 'verified',
    verifyEventId: 'evt-2'
  },
  null
);

assert.strictEqual(mergedConfirmedDispatch.state, 'dispatch_confirmed');
assert.strictEqual(mergedConfirmedDispatch.verifyState, 'verified');
assert.strictEqual(
  context.resolveSaveResponseDispatchPipelineState(mergedConfirmedDispatch),
  'dispatch_confirmed'
);

const processPatch = context.buildSaveResponseProcessPersistencePatch({
  responseId: 'resp-deferred-1',
  copyTrace: 'run-deferred/resp-deferred-1',
  verifiedCount: 83,
  dispatch: deferredDispatch,
  dispatchSummary: context.formatDispatchUiSummary(deferredDispatch),
  dispatchProcessLog: [
    'queue_result|queued|queueSize=2',
    'flush_deferred|queued_only|reason=runtime_bridge_fast_ack'
  ],
  conversationAnalysis: {
    hasConversationUrl: true,
    conversationLogCount: 40,
    snapshotRefreshedBeforeSend: false,
    snapshotSource: 'save_snapshot'
  },
  completedStage12Snapshot: {
    responseLength: 38676
  },
  lifecycleStatus: 'completed',
  phase: 'dispatch_remote',
  statusCode: 'dispatch.verify_pending',
  origin: 'save_response_deferred',
  now: 123456
});

assert.strictEqual(processPatch.completedResponseSaved, true);
assert.strictEqual(processPatch.completedResponseDispatch, deferredDispatch);
assert.strictEqual(processPatch.completedResponseDispatchSummary, deferredDispatchSummary);
assert.deepStrictEqual(processPatch.completedResponseDispatchProcessLog, [
  'queue_result|queued|queueSize=2',
  'flush_deferred|queued_only|reason=runtime_bridge_fast_ack'
]);
assert.strictEqual(processPatch.persistenceStatus.saveOk, true);
assert.strictEqual(processPatch.persistenceStatus.copyTrace, 'run-deferred/resp-deferred-1');
assert.strictEqual(processPatch.persistenceStatus.dispatch, deferredDispatch);
assert.strictEqual(processPatch.finalStagePersistence.success, true);
assert.strictEqual(processPatch.finalStagePersistence.responseId, 'resp-deferred-1');
assert.strictEqual(processPatch.finalStagePersistence.flushDeferred, true);
assert.strictEqual(processPatch.finalStagePersistence.flushDeferredReason, 'runtime_bridge_fast_ack');
assert.strictEqual(processPatch.finalStagePersistence.pending, 2);
assert.strictEqual(processPatch.finalStagePersistence.conversationLogCount, 40);
assert.strictEqual(processPatch.finalStagePersistence.hasConversationUrl, true);
assert.strictEqual(processPatch.finalStagePersistence.origin, 'save_response_deferred');
assert.strictEqual(processPatch.completedStage12Snapshot.responseLength, 38676);
assert.strictEqual(processPatch.timestamp, 123456);

console.log('test-deferred-save-response-flush.js: ok');
