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

const context = {
  console,
  Date,
  Map,
  Set,
  ProcessContractUtils,
  analysisQueueState: { waitingJobs: [] },
  normalizePromptCounters(_status, currentPrompt, totalPrompts, stageIndex) {
    return {
      currentPrompt: Number.isInteger(currentPrompt) ? currentPrompt : 0,
      totalPrompts: Number.isInteger(totalPrompts) ? totalPrompts : 0,
      stageIndex: Number.isInteger(stageIndex) ? stageIndex : null
    };
  },
  normalizeComposerThinkingEffort(value) {
    return typeof value === 'string' ? value.trim() : '';
  },
  normalizeChatGptModeKind(value) {
    return typeof value === 'string' ? value.trim() : '';
  },
  normalizeChatGptPlanHint(value) {
    return typeof value === 'string' ? value.trim() : '';
  },
  normalizeChatGptMonitoringLabel(value) {
    return typeof value === 'string' ? value.trim() : '';
  },
  normalizeChatConversationUrl(value) {
    return typeof value === 'string' ? value.trim() : '';
  },
  normalizeConversationUrlList(values) {
    return Array.isArray(values)
      ? values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim())
      : [];
  },
  normalizeSourceUrl(value) {
    return typeof value === 'string' ? value.trim() : '';
  },
  normalizeAnalysisQueueTabId(value) {
    return Number.isInteger(value) ? value : null;
  },
  normalizeAnalysisQueueWindowId(value) {
    return Number.isInteger(value) ? value : null;
  },
  normalizeCompanyStageIdentifier(value) {
    return typeof value === 'string' ? value.trim() : '';
  },
  normalizeAutoRecoveryState(value) {
    return value && typeof value === 'object' ? { ...value } : null;
  }
};

vm.createContext(context);
[
  'normalizeProcessLifecycleStatus',
  'normalizeProcessPhase',
  'normalizeProcessActionRequired',
  'deriveProcessActionRequired',
  'deriveProcessStatusCode',
  'buildOperatorStatusText',
  'normalizeProcessStatus',
  'isClosedProcessStatus',
  'normalizeProcessWindowCloseState',
  'trimProcessAuditText',
  'buildProcessCompletionAudit',
  'normalizeProcessRecord',
  'applyQueuePositionsToProcesses'
].forEach((functionName) => {
  vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
    filename: 'background.js'
  });
});

function testNormalizeProcessRecordBackfillsLegacyFields() {
  const normalized = context.normalizeProcessRecord({
    id: 'run-1',
    status: 'error',
    reason: 'textarea_not_found',
    needsAction: true,
    timestamp: 1000
  });

  assert(normalized);
  assert.strictEqual(normalized.lifecycleStatus, 'failed');
  assert.strictEqual(normalized.status, 'failed');
  assert.strictEqual(normalized.actionRequired, 'none');
  assert.strictEqual(normalized.needsAction, false);
  assert.strictEqual(normalized.statusCode, 'chat.editor_not_found');
  assert.strictEqual(normalized.lastActivityAt, 1000);
  assert.strictEqual(normalized.phaseStartedAt, 1000);
  assert.strictEqual(normalized.version, 1);
}

function testNormalizeProcessRecordPreservesOpenActionRequired() {
  const normalized = context.normalizeProcessRecord({
    id: 'run-2',
    status: 'running',
    statusText: 'Continue button visible',
    timestamp: 2000
  });

  assert.strictEqual(normalized.lifecycleStatus, 'running');
  assert.strictEqual(normalized.actionRequired, 'continue_button');
  assert.strictEqual(normalized.needsAction, true);
  assert.strictEqual(normalized.statusCode, 'chat.continue_button');
}

function testNormalizeProcessRecordBuildsCompletionAudit() {
  const normalized = context.normalizeProcessRecord({
    id: 'run-3',
    status: 'completed',
    lifecycleStatus: 'completed',
    currentPrompt: 13,
    totalPrompts: 13,
    completedResponseText: '{"schema":"economist.response.v2"}',
    completedResponseCapturedAt: 3000,
    completedResponseSaved: true,
    persistenceStatus: {
      hasResponse: true,
      saveOk: true,
      updatedAt: 3010,
      dispatch: {
        state: 'dispatch_pending',
        accepted: 1,
        sent: 1,
        failed: 0,
        deferred: 0,
        remaining: 0,
        verifyState: 'http_accepted'
      }
    },
    windowClose: {
      state: 'retrying',
      requestedAt: 3020,
      lastAttemptAt: 3030,
      attemptCount: 2,
      lastError: 'window_contains_other_tabs'
    },
    timestamp: 3040
  });

  assert(normalized?.completionAudit);
  assert.strictEqual(normalized.completionAudit.hasResponse, true);
  assert.strictEqual(normalized.completionAudit.saveState, 'saved');
  assert.strictEqual(normalized.completionAudit.dispatchState, 'dispatch_pending');
  assert.strictEqual(normalized.completionAudit.dispatchConfirmed, false);
  assert.strictEqual(normalized.completionAudit.windowCloseState, 'retrying');
  assert.strictEqual(normalized.completionAudit.windowCloseAttempts, 2);
  assert.strictEqual(normalized.completionAudit.overallState, 'dispatch_pending');
  assert(Array.isArray(normalized.completionAudit.checkpoints));
  assert(normalized.completionAudit.checkpoints.some((entry) => entry.code === 'dispatch'));
}

function testApplyQueuePositionsToProcessesAddsAndClearsPositions() {
  const records = [
    { id: 'run-a', title: 'A' },
    { id: 'run-b', title: 'B', queuePosition: 9 }
  ];
  const applied = context.applyQueuePositionsToProcesses(records, {
    waitingJobs: [
      { runId: 'run-a' }
    ]
  });

  assert.strictEqual(applied[0].queuePosition, 1);
  assert.strictEqual('queuePosition' in applied[1], false);
}

function testNormalizeProcessRecordNormalizesPerformanceTelemetry() {
  const normalized = context.normalizeProcessRecord({
    id: 'run-4',
    status: 'running',
    phase: 'response_wait',
    currentPrompt: 2,
    timestamp: 5000,
    performanceTelemetry: {
      phaseTotalsMs: {
        prompt_send: 1800,
        bogus_phase: 999
      },
      promptTimings: {
        count: 2,
        firstAt: 1200,
        lastAt: 4200,
        lastPromptNumber: 2,
        gapCount: 1,
        totalGapMs: 3000,
        maxGapMs: 3000,
        lastGapMs: 3000
      },
      phaseTransitionCount: 4
    }
  });

  assert(normalized?.performanceTelemetry);
  assert.deepStrictEqual(normalized.performanceTelemetry.phaseTotalsMs, {
    prompt_send: 1800
  });
  assert.strictEqual(normalized.performanceTelemetry.promptTimings.count, 2);
  assert.strictEqual(normalized.performanceTelemetry.promptTimings.gapCount, 1);
  assert.strictEqual(normalized.performanceTelemetry.promptTimings.lastPromptNumber, 2);
  assert.strictEqual(normalized.performanceTelemetry.phaseTransitionCount, 4);
}

function main() {
  testNormalizeProcessRecordBackfillsLegacyFields();
  testNormalizeProcessRecordPreservesOpenActionRequired();
  testNormalizeProcessRecordBuildsCompletionAudit();
  testApplyQueuePositionsToProcessesAddsAndClearsPositions();
  testNormalizeProcessRecordNormalizesPerformanceTelemetry();
  console.log('test-process-snapshot-normalization.js passed');
}

main();
