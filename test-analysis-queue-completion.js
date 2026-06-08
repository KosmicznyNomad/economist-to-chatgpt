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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function main() {
  const completionMatches = backgroundSource.match(
    /finalStatus === 'completed'[\s\S]{0,500}?currentPrompt:\s*processTotalPrompts[\s\S]{0,200}?stageIndex:\s*processTotalPrompts - 1/g
  ) || [];
  assert(
    completionMatches.length >= 1,
    'Expected the queued execution completion path to stamp the process with the final prompt/stage.'
  );

  const context = {
    console,
    Date,
    Promise,
    Map,
    Set,
    ProcessContractUtils,
    ANALYSIS_QUEUE_KIND_ARTICLE: 'article_analysis',
    ANALYSIS_QUEUE_KIND_RESUME_STAGE: 'resume_stage',
    ANALYSIS_QUEUE_DISPATCH_CONFIRM_TIMEOUT_MS: 5 * 60 * 1000,
    PROCESS_WINDOW_CLOSE_RETRY: {
      enabled: true
    },
    CLOSED_PROCESS_STATUSES: new Set([
      'completed',
      'failed',
      'closed',
      'error',
      'cancelled',
      'canceled',
      'aborted',
      'stopped',
      'interrupted'
    ]),
    analysisQueueReconcileInProgress: false,
    analysisQueueReconcileRequested: false,
    analysisQueueState: {
      waitingJobs: [],
      activeJobs: [],
      maxConcurrent: 1,
      lastSequence: 2
    },
    ANALYSIS_QUEUE_LOCAL_CONTEXT_GRACE_MS: 45 * 1000,
    processRegistry: new Map(),
    startedJobs: [],
    upserts: [],
    closedRuns: [],
    closeWindowResult: true,
    reconcileRequests: [],
    ensureAnalysisQueueReady: async () => context.analysisQueueState,
    ensureProcessRegistryReady: async () => context.processRegistry,
    withAnalysisQueueMutationLock: async (task) => task(),
    cloneAnalysisQueueState: () => clone(context.analysisQueueState),
    isLocalProcessActiveForQueue: async () => true,
    getAnalysisQueueProcessActivityState: async (process) => ({
      active: true,
      live: true,
      recent: false,
      contextKey: typeof process?.id === 'string' ? `run:${process.id}` : '',
      reason: 'test_stub'
    }),
    getAnalysisQueueJobContextKey: (job) => (typeof job?.runId === 'string' ? `run:${job.runId}` : ''),
    shouldReplaceAnalysisQueueActiveJob: () => false,
    getAnalysisQueueStatusSnapshot: async () => ({
      activeSlots: context.analysisQueueState.activeJobs.length,
      waitingJobs: context.analysisQueueState.waitingJobs.length,
      maxConcurrent: context.analysisQueueState.maxConcurrent
    }),
    collectAnalysisQueueActiveProcesses: async ({ excludedRunIds } = {}) => {
      const excluded = excludedRunIds instanceof Set ? excludedRunIds : new Set();
      return Array.from(context.processRegistry.values())
        .filter((process) => {
          const runId = typeof process?.id === 'string' ? process.id.trim() : '';
          if (!runId || excluded.has(runId)) return false;
          const status = context.normalizeProcessStatus(process.status);
          if (status === 'completed') {
            if (!context.hasProcessReachedFinalStage(process)) return true;
            const delivery = context.getProcessQueueDeliveryState(process);
            if (delivery.confirmed === true) return false;
            if (delivery.saveOk !== true) return false;
            if (delivery.queueSkipped === true || delivery.flushSkipped === true) return false;
            return true;
          }
          if (context.isClosedProcessStatus(status)) return false;
          return true;
        })
        .map((process) => ({
          process,
          activity: {
            active: true,
            live: true,
            recent: false,
            contextKey: typeof process?.id === 'string' ? process.id : ''
          }
        }));
    },
    buildStaleQueueReleasePatch: async () => null,
    ensureAnalysisQueuePauseReady: async () => false,
    getAnalysisQueuePaused: async () => false,
    normalizeProcessWindowCloseState: (value) => (value && typeof value === 'object' ? value : null),
    resolveProcessWindowCloseRetryPlan: (process) => {
      const windowClose = context.normalizeProcessWindowCloseState(process?.windowClose);
      if (windowClose?.state === 'closed') {
        return { needed: false, reason: 'already_closed', delivery: context.getProcessQueueDeliveryState(process) };
      }
      if (windowClose?.state === 'failed') {
        const delivery = context.getProcessQueueDeliveryState(process);
        if (process?.queueManaged === true
          && (delivery?.confirmed === true || context.isDataGapTerminalProcess(process))) {
          return { needed: true, reason: 'close_retry_exhausted_retrying', delivery };
        }
        return { needed: false, reason: 'close_retry_exhausted', delivery: context.getProcessQueueDeliveryState(process) };
      }
      return {
        needed: process?.requiresWindowClose === true,
        reason: process?.requiresWindowClose === true ? 'test_window_close_needed' : 'missing_window_context',
        delivery: context.getProcessQueueDeliveryState(process)
      };
    },
    sanitizeAnalysisQueueJob: (job) => clone(job),
    persistAnalysisQueueState: async (state) => {
      context.analysisQueueState = clone(state);
      return context.analysisQueueState;
    },
    upsertProcess: async (runId, patch) => {
      const current = context.processRegistry.get(runId) || { id: runId };
      const next = { ...current, ...clone(patch) };
      context.processRegistry.set(runId, next);
      context.upserts.push({ runId, patch: clone(patch) });
      if (
        next.queueManaged === true
        || current?.queueManaged === true
        || context.analysisQueueState?.waitingJobs?.length
        || context.analysisQueueState?.activeJobs?.length
      ) {
        context.requestAnalysisQueueReconcile('process_upsert');
      }
      return next;
    },
    closeProcessWindowAfterQueueSuccess: async (process) => {
      const runId = typeof process?.id === 'string' ? process.id : '';
      context.closedRuns.push(runId);
      const closed = context.closeWindowResult !== false;
      if (closed && runId) {
        await context.upsertProcess(runId, {
          windowClose: {
            state: 'closed',
            closedAt: Date.now()
          }
        });
      }
      return closed;
    },
    reportAnalysisQueueEvent: async () => true,
    runQueuedAnalysisJob: (job, reason) => {
      context.startedJobs.push({ runId: job.runId, jobId: job.jobId, reason });
    },
    requestAnalysisQueueReconcile: (reason) => {
      context.reconcileRequests.push(reason);
      context.analysisQueueReconcileRequested = true;
    },
    requestRemoteRunnerCycle: () => {},
    normalizeWatchlistEventId: (value) => {
      if (typeof value === 'string') return value.trim();
      if (Number.isInteger(value)) return String(value);
      return '';
    },
    formatDispatchUiSummary: (dispatch) => `state=${dispatch?.state || ''}`,
    clearCompletedProcessPersistenceRetry: () => {},
    closeCompletedProcessAfterDispatchConfirmed: async () => false
  };

  vm.createContext(context);
  const functionNames = [
    'getAnalysisQueueJobPriority',
    'compareAnalysisQueueJobs',
    'sortAnalysisQueueWaitingJobs',
    'normalizeProcessLifecycleStatus',
    'normalizeProcessActionRequired',
    'deriveProcessActionRequired',
    'normalizeProcessStatus',
    'isClosedProcessStatus',
    'resolveProcessStageSnapshot',
    'hasProcessReachedFinalStage',
    'extractResponseIdFromCopyTrace',
    'collectKnownProcessResponseIds',
    'createDeliveredDispatchSnapshot',
    'normalizeWatchlistVerifyState',
    'isExplicitlyVerifiedDispatch',
    'getProcessPersistenceDispatchSnapshot',
    'getProcessQueueDeliveryState',
    'hasProcessCloseableSavedResponse',
    'isDataGapTerminalProcess',
    'isProcessWindowAutoCloseEnabled',
    'shouldHoldAnalysisQueueSlotForWindowClose',
    'shouldAttemptAnalysisQueueWindowClose',
    'getAnalysisQueueCompletionTimestamp',
    'resolveAnalysisQueueDispatchDeadlineAt',
    'updateProcessDispatchAfterSendSuccess',
    'countAnalysisTabsById',
    'countAdoptableOpenAnalysisTabsForWaitingResumeJobs',
    'isQueuedExecutionSetupFailureResult',
    'markQueuedExecutionSetupFailureIfUnsettled',
    'resolveAnalysisQueueReleaseDecision',
    'reconcileAnalysisQueueState'
  ];
  for (const functionName of functionNames) {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
      filename: 'background.js'
    });
  }

  assert.strictEqual(
    context.hasProcessReachedFinalStage({
      status: 'completed',
      currentPrompt: 5,
      totalPrompts: 5,
      stageIndex: 4
    }),
    false,
    'Prompt counters alone should not mark the process as finished.'
  );
  assert.strictEqual(
    context.hasProcessReachedFinalStage({
      status: 'completed',
      currentPrompt: 4,
      totalPrompts: 5,
      stageIndex: 3
    }),
    false,
    'Completed process before the last stage must not be recognized as finished.'
  );

  const keepDecision = context.resolveAnalysisQueueReleaseDecision(
    { jobId: 'aq-1', runId: 'run-1' },
    {
      id: 'run-1',
      status: 'completed',
      currentPrompt: 4,
      totalPrompts: 5,
      stageIndex: 3,
      completedResponseSaved: true
    }
  );
  assert.strictEqual(keepDecision.action, 'keep');
  assert.strictEqual(keepDecision.queueState, 'awaiting_dispatch_confirmation');
  assert.strictEqual(keepDecision.reason, 'dispatch_pending');

  const releaseDecision = context.resolveAnalysisQueueReleaseDecision(
    { jobId: 'aq-1', runId: 'run-1' },
    {
      id: 'run-1',
      status: 'completed',
      currentPrompt: 5,
      totalPrompts: 5,
      stageIndex: 4,
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
    }
  );
  assert.strictEqual(releaseDecision.action, 'release');
  assert.strictEqual(releaseDecision.closeWindow, false);
  assert.strictEqual(releaseDecision.reason, 'dispatch_confirmed');

  assert.strictEqual(
    context.isExplicitlyVerifiedDispatch({
      state: 'dispatch_confirmed',
      failed: 0,
      verifyState: ''
    }),
    true,
    'Legacy dispatch_confirmed records without verifyState should still be accepted.'
  );
  assert.strictEqual(
    context.isExplicitlyVerifiedDispatch({
      state: 'dispatch_confirmed',
      failed: 0,
      verifyState: 'expected_records_missing'
    }),
    false,
    'Contradictory terminal verify failures must not be accepted as DB-confirmed dispatch.'
  );
  const contradictoryDispatchDecision = context.resolveAnalysisQueueReleaseDecision(
    { jobId: 'aq-1', runId: 'run-1' },
    {
      id: 'run-1',
      status: 'completed',
      currentPrompt: 5,
      totalPrompts: 5,
      stageIndex: 4,
      completedResponseSaved: true,
      persistenceStatus: {
        saveOk: true,
        dispatch: {
          state: 'dispatch_confirmed',
          sent: 1,
          failed: 0,
          pending: 0,
          verifyState: 'expected_records_missing'
        }
      }
    }
  );
  assert.strictEqual(contradictoryDispatchDecision.action, 'keep');
  assert.strictEqual(contradictoryDispatchDecision.closeWindow, false);
  assert.strictEqual(contradictoryDispatchDecision.reason, 'dispatch_pending');
  assert.strictEqual(contradictoryDispatchDecision.queueState, 'awaiting_dispatch_confirmation');

  const pendingDispatchDecision = context.resolveAnalysisQueueReleaseDecision(
    { jobId: 'aq-1', runId: 'run-1' },
    {
      id: 'run-1',
      status: 'completed',
      currentPrompt: 5,
      totalPrompts: 5,
      stageIndex: 4,
      completedResponseSaved: true,
      persistenceStatus: {
        saveOk: true,
        dispatch: {
          state: 'queued',
          sent: 0,
          failed: 0,
          pending: 1
        }
      }
    },
    1000
  );
  assert.strictEqual(pendingDispatchDecision.action, 'keep');
  assert.strictEqual(pendingDispatchDecision.closeWindow, false);
  assert.strictEqual(pendingDispatchDecision.reason, 'dispatch_pending');
  assert.strictEqual(pendingDispatchDecision.queueState, 'awaiting_dispatch_confirmation');

  const localSaveFailedDecision = context.resolveAnalysisQueueReleaseDecision(
    { jobId: 'aq-1', runId: 'run-1' },
    {
      id: 'run-1',
      status: 'completed',
      currentPrompt: 5,
      totalPrompts: 5,
      stageIndex: 4,
      completedResponseCapturedAt: 1000,
      completedResponseSaved: false,
      persistenceStatus: {
        saveOk: false,
        dispatch: {
          state: 'dispatch_pending',
          sent: 0,
          failed: 0,
          pending: 1
        }
      }
    },
    1000
  );
  assert.strictEqual(localSaveFailedDecision.action, 'keep');
  assert.strictEqual(localSaveFailedDecision.closeWindow, false);
  assert.strictEqual(localSaveFailedDecision.reason, 'local_save_failed');
  assert.strictEqual(localSaveFailedDecision.queueState, 'awaiting_local_save');

  const cappedDispatchDeadlineDecision = context.resolveAnalysisQueueReleaseDecision(
    { jobId: 'aq-1', runId: 'run-1', dispatchDeadlineAt: 601000 },
    {
      id: 'run-1',
      status: 'completed',
      currentPrompt: 5,
      totalPrompts: 5,
      stageIndex: 4,
      finishedAt: 1000,
      completedResponseSaved: true,
      persistenceStatus: {
        saveOk: true,
        dispatch: {
          state: 'queued',
          sent: 0,
          failed: 0,
          pending: 1
        }
      }
    },
    1000
  );
  assert.strictEqual(cappedDispatchDeadlineDecision.action, 'keep');
  assert.strictEqual(cappedDispatchDeadlineDecision.closeWindow, false);
  assert.strictEqual(cappedDispatchDeadlineDecision.reason, 'dispatch_pending');
  assert.strictEqual(cappedDispatchDeadlineDecision.queueState, 'awaiting_dispatch_confirmation');

  const timedOutDispatchDecision = context.resolveAnalysisQueueReleaseDecision(
    { jobId: 'aq-1', runId: 'run-1', dispatchDeadlineAt: 999 },
    {
      id: 'run-1',
      status: 'completed',
      currentPrompt: 5,
      totalPrompts: 5,
      stageIndex: 4,
      completedResponseSaved: true,
      persistenceStatus: {
        saveOk: true,
        dispatch: {
          state: 'queued',
          sent: 0,
          failed: 0,
          pending: 1
        }
      }
    },
    1000
  );
  assert.strictEqual(timedOutDispatchDecision.action, 'keep');
  assert.strictEqual(timedOutDispatchDecision.closeWindow, false);
  assert.strictEqual(timedOutDispatchDecision.reason, 'dispatch_pending');
  assert.strictEqual(timedOutDispatchDecision.queueState, 'awaiting_dispatch_confirmation');

  const savedStoppedDecision = context.resolveAnalysisQueueReleaseDecision(
    { jobId: 'aq-1', runId: 'run-1' },
    {
      id: 'run-1',
      status: 'stopped',
      reason: 'local_context_missing',
      currentPrompt: 5,
      totalPrompts: 5,
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
    },
    1000
  );
  assert.strictEqual(savedStoppedDecision.action, 'release');
  assert.strictEqual(savedStoppedDecision.closeWindow, false);
  assert.strictEqual(savedStoppedDecision.reason, 'dispatch_confirmed');

  const failedWindowCloseDecision = context.resolveAnalysisQueueReleaseDecision(
    { jobId: 'aq-1', runId: 'run-1' },
    {
      id: 'run-1',
      status: 'failed',
      lifecycleStatus: 'failed',
      queueManaged: true,
      slotReserved: true,
      requiresWindowClose: true,
      tabId: 701,
      windowId: 702,
      reason: 'queue_execution_exception'
    },
    1000
  );
  assert.strictEqual(failedWindowCloseDecision.action, 'keep');
  assert.strictEqual(failedWindowCloseDecision.closeWindow, true);
  assert.strictEqual(failedWindowCloseDecision.reason, 'window_close_pending');
  assert.strictEqual(failedWindowCloseDecision.queueState, 'awaiting_window_close');

  const dataGapStoppedDecision = context.resolveAnalysisQueueReleaseDecision(
    { jobId: 'aq-1', runId: 'run-1' },
    {
      id: 'run-1',
      status: 'stopped',
      lifecycleStatus: 'stopped',
      reason: 'data_gap_stage',
      statusCode: 'process.data_gap_stage',
      dataGapDetected: true,
      dataGapStageId: '4',
      requiresWindowClose: true
    },
    1000
  );
  assert.strictEqual(dataGapStoppedDecision.action, 'keep');
  assert.strictEqual(dataGapStoppedDecision.closeWindow, true);
  assert.strictEqual(dataGapStoppedDecision.reason, 'window_close_pending');
  assert.strictEqual(dataGapStoppedDecision.queueState, 'awaiting_window_close');

  const dataGapFailedWindowDecision = context.resolveAnalysisQueueReleaseDecision(
    { jobId: 'aq-1', runId: 'run-1' },
    {
      id: 'run-1',
      status: 'stopped',
      lifecycleStatus: 'stopped',
      reason: 'data_gap_stage',
      statusCode: 'process.data_gap_stage',
      dataGapDetected: true,
      dataGapStageId: '4',
      queueManaged: true,
      slotReserved: true,
      requiresWindowClose: true,
      windowClose: {
        state: 'failed',
        attemptCount: 24,
        lastError: 'window_remove_failed'
      }
    },
    1000
  );
  assert.strictEqual(dataGapFailedWindowDecision.action, 'keep');
  assert.strictEqual(dataGapFailedWindowDecision.closeWindow, true);
  assert.strictEqual(dataGapFailedWindowDecision.reason, 'window_close_pending');
  assert.strictEqual(dataGapFailedWindowDecision.queueState, 'awaiting_window_close');

  const dataGapNoWindowDecision = context.resolveAnalysisQueueReleaseDecision(
    { jobId: 'aq-1', runId: 'run-1' },
    {
      id: 'run-1',
      status: 'stopped',
      lifecycleStatus: 'stopped',
      reason: 'data_gap_stage',
      statusCode: 'process.data_gap_stage',
      dataGapDetected: true,
      dataGapStageId: '4'
    },
    1000
  );
  assert.strictEqual(dataGapNoWindowDecision.action, 'release');
  assert.strictEqual(dataGapNoWindowDecision.closeWindow, false);
  assert.strictEqual(dataGapNoWindowDecision.reason, 'data_gap_stage');
  assert.strictEqual(dataGapNoWindowDecision.slotReleaseReason, 'data_gap_stage');

  context.processRegistry = new Map([
    ['run-setup-fail', {
      id: 'run-setup-fail',
      status: 'running',
      lifecycleStatus: 'running',
      queueManaged: true,
      queueJobId: 'aq-setup-fail',
      queueState: 'active',
      slotReserved: true
    }]
  ]);
  context.upserts = [];
  const setupFailureMarked = await context.markQueuedExecutionSetupFailureIfUnsettled(
    { jobId: 'aq-setup-fail', runId: 'run-setup-fail', title: 'Setup Fail', analysisType: 'company' },
    { success: false, reason: 'invalid_tab', error: 'invalid_tab' }
  );
  assert.strictEqual(setupFailureMarked, true);
  assert.strictEqual(context.processRegistry.get('run-setup-fail')?.status, 'failed');
  assert.strictEqual(context.processRegistry.get('run-setup-fail')?.reason, 'invalid_tab');
  assert.strictEqual(context.processRegistry.get('run-setup-fail')?.queueState, 'active');
  assert.strictEqual(context.processRegistry.get('run-setup-fail')?.slotReserved, true);

  context.processRegistry = new Map([
    ['run-rate-limit', {
      id: 'run-rate-limit',
      status: 'running',
      lifecycleStatus: 'running',
      actionRequired: 'rate_limit',
      needsAction: true,
      queueManaged: true,
      queueJobId: 'aq-rate-limit',
      queueState: 'active',
      slotReserved: true
    }]
  ]);
  context.upserts = [];
  const rateLimitMarked = await context.markQueuedExecutionSetupFailureIfUnsettled(
    { jobId: 'aq-rate-limit', runId: 'run-rate-limit', title: 'Rate Limit', analysisType: 'company' },
    { success: false, reason: 'limit_or_restriction', error: 'rate_limit_blocked' }
  );
  assert.strictEqual(rateLimitMarked, false);
  assert.deepStrictEqual(context.upserts, []);

  context.analysisQueueState = {
    waitingJobs: [
      { jobId: 'aq-2', runId: 'run-2', sequence: 2, createdAt: 2 }
    ],
    activeJobs: [
      { jobId: 'aq-1', runId: 'run-1', sequence: 1, createdAt: 1, slotReservedAt: 1 }
    ],
    maxConcurrent: 1,
    lastSequence: 2
  };
  context.processRegistry = new Map([
    ['run-1', {
      id: 'run-1',
      status: 'completed',
      currentPrompt: 5,
      totalPrompts: 5,
      stageIndex: 4,
      queueState: 'active',
      completedResponseSaved: true,
      persistenceStatus: {
        saveOk: true,
        dispatch: {
          state: 'queued',
          sent: 0,
          failed: 0,
          pending: 1
        }
      }
    }]
  ]);
  context.startedJobs = [];
  context.upserts = [];
  await context.reconcileAnalysisQueueState('test_await_dispatch');
  assert.deepStrictEqual(context.startedJobs.map((entry) => entry.runId), []);
  assert.deepStrictEqual(context.closedRuns, []);
  assert.deepStrictEqual(context.analysisQueueState.activeJobs.map((job) => job.runId), ['run-1']);
  assert.deepStrictEqual(context.analysisQueueState.waitingJobs.map((job) => job.runId), ['run-2']);
  assert(
    context.upserts.some((entry) => entry.runId === 'run-1' && entry.patch.queueState === 'awaiting_dispatch_confirmation'),
    'Completed process with pending dispatch should hold the slot until DB dispatch confirmation.'
  );

  context.analysisQueueState = {
    waitingJobs: [
      { jobId: 'aq-2', runId: 'run-2', sequence: 2, createdAt: 2 }
    ],
    activeJobs: [
      { jobId: 'aq-1', runId: 'run-1', sequence: 1, createdAt: 1, slotReservedAt: 1, dispatchDeadlineAt: 1 }
    ],
    maxConcurrent: 1,
    lastSequence: 2
  };
  context.processRegistry = new Map([
    ['run-1', {
      id: 'run-1',
      status: 'completed',
      currentPrompt: 5,
      totalPrompts: 5,
      stageIndex: 4,
      queueState: 'awaiting_dispatch',
      completedResponseSaved: true,
      persistenceStatus: {
        saveOk: true,
        dispatch: {
          state: 'queued',
          sent: 0,
          failed: 0,
          pending: 1
        }
      }
    }]
  ]);
  context.startedJobs = [];
  context.upserts = [];
  context.closedRuns = [];
  await context.reconcileAnalysisQueueState('test_dispatch_timeout_close');
  assert.deepStrictEqual(context.startedJobs.map((entry) => entry.runId), []);
  assert.deepStrictEqual(context.closedRuns, []);
  assert.deepStrictEqual(context.analysisQueueState.activeJobs.map((job) => job.runId), ['run-1']);
  assert.deepStrictEqual(context.analysisQueueState.waitingJobs.map((job) => job.runId), ['run-2']);
  assert(
    context.upserts.some((entry) => entry.runId === 'run-1' && entry.patch.queueState === 'awaiting_dispatch_confirmation'),
    'Timed-out dispatch should still hold the slot until DB dispatch confirmation.'
  );

  context.analysisQueueState = {
    waitingJobs: [
      { jobId: 'aq-2', runId: 'run-2', sequence: 2, createdAt: 2 }
    ],
    activeJobs: [
      { jobId: 'aq-1', runId: 'run-1', sequence: 1, createdAt: 1, slotReservedAt: 1 }
    ],
    maxConcurrent: 1,
    lastSequence: 2
  };
  context.processRegistry = new Map([
    ['run-1', {
      id: 'run-1',
      status: 'completed',
      currentPrompt: 5,
      totalPrompts: 5,
      stageIndex: 4,
      queueState: 'active',
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
    }]
  ]);
  context.startedJobs = [];
  context.upserts = [];
  context.closedRuns = [];
  await context.reconcileAnalysisQueueState('test_final_stage');
  assert.deepStrictEqual(context.startedJobs.map((entry) => entry.runId), ['run-2']);
  assert.deepStrictEqual(context.closedRuns, []);
  assert.deepStrictEqual(context.analysisQueueState.activeJobs.map((job) => job.runId), ['run-2']);
  assert.deepStrictEqual(context.analysisQueueState.waitingJobs.map((job) => job.runId), []);
  assert(
    context.upserts.some((entry) => entry.runId === 'run-1' && entry.patch.queueState === 'dispatch_confirmed'),
    'Finished dispatched process should release its slot after send confirmation.'
  );
  assert(
    context.upserts.some((entry) => entry.runId === 'run-2' && entry.patch.queueState === 'active'),
    'Next queued process should become active after slot release.'
  );

  context.analysisQueueState = {
    waitingJobs: [
      { jobId: 'aq-2', runId: 'run-2', sequence: 2, createdAt: 2 }
    ],
    activeJobs: [
      { jobId: 'aq-1', runId: 'run-1', sequence: 1, createdAt: 1, slotReservedAt: 1 }
    ],
    maxConcurrent: 1,
    lastSequence: 2
  };
  context.processRegistry = new Map([
    ['run-1', {
      id: 'run-1',
      status: 'completed',
      currentPrompt: 5,
      totalPrompts: 5,
      stageIndex: 4,
      queueManaged: true,
      queueJobId: 'aq-1',
      queueState: 'awaiting_dispatch_confirmation',
      slotReserved: true,
      requiresWindowClose: true,
      tabId: 101,
      windowId: 201,
      completedResponseSaved: true,
      persistenceStatus: {
        saveOk: true,
        dispatch: {
          state: 'dispatch_confirmed',
          sent: 1,
          failed: 0,
          pending: 0,
          verifyState: 'verified'
        }
      }
    }]
  ]);
  context.startedJobs = [];
  context.upserts = [];
  context.closedRuns = [];
  context.closeWindowResult = false;
  await context.reconcileAnalysisQueueState('test_dispatch_confirmed_window_close_pending');
  assert.deepStrictEqual(
    context.startedJobs.map((entry) => entry.runId),
    [],
    'Queue must not start the next process while the confirmed previous process window is still closing.'
  );
  assert(
    context.closedRuns.length >= 1 && context.closedRuns.every((runId) => runId === 'run-1'),
    'Queue should keep attempting to close only the confirmed previous process window.'
  );
  assert.deepStrictEqual(context.analysisQueueState.activeJobs.map((job) => job.runId), ['run-1']);
  assert.deepStrictEqual(context.analysisQueueState.waitingJobs.map((job) => job.runId), ['run-2']);
  assert(
    context.upserts.some((entry) => entry.runId === 'run-1' && entry.patch.queueState === 'awaiting_window_close'),
    'Confirmed process should hold the slot as awaiting_window_close until the close succeeds.'
  );

  context.analysisQueueState = {
    waitingJobs: [
      { jobId: 'aq-2', runId: 'run-2', sequence: 2, createdAt: 2 }
    ],
    activeJobs: [
      { jobId: 'aq-1', runId: 'run-1', sequence: 1, createdAt: 1, slotReservedAt: 1 }
    ],
    maxConcurrent: 1,
    lastSequence: 2
  };
  context.processRegistry = new Map([
    ['run-1', {
      id: 'run-1',
      status: 'completed',
      currentPrompt: 5,
      totalPrompts: 5,
      stageIndex: 4,
      queueManaged: true,
      queueJobId: 'aq-1',
      queueState: 'awaiting_window_close',
      slotReserved: true,
      requiresWindowClose: true,
      tabId: 101,
      windowId: 201,
      completedResponseSaved: true,
      windowClose: {
        state: 'failed',
        attemptCount: 24,
        lastError: 'window_remove_failed'
      },
      persistenceStatus: {
        saveOk: true,
        dispatch: {
          state: 'dispatch_confirmed',
          sent: 1,
          failed: 0,
          pending: 0,
          verifyState: 'verified'
        }
      }
    }]
  ]);
  context.startedJobs = [];
  context.upserts = [];
  context.closedRuns = [];
  context.closeWindowResult = false;
  await context.reconcileAnalysisQueueState('test_window_close_failed_still_blocks_queue');
  assert.deepStrictEqual(
    context.startedJobs.map((entry) => entry.runId),
    [],
    'Queue must not start the next process after window-close retries are exhausted.'
  );
  assert.deepStrictEqual(context.analysisQueueState.activeJobs.map((job) => job.runId), ['run-1']);
  assert.deepStrictEqual(context.analysisQueueState.waitingJobs.map((job) => job.runId), ['run-2']);
  assert.strictEqual(
    context.processRegistry.get('run-1')?.queueState,
    'awaiting_window_close',
    'Exhausted close retry should keep the process in awaiting_window_close instead of releasing the slot.'
  );

  context.processRegistry.set('run-1', {
    ...context.processRegistry.get('run-1'),
    windowClose: {
      state: 'closed',
      closedAt: Date.now()
    }
  });
  context.startedJobs = [];
  context.upserts = [];
  context.closedRuns = [];
  context.closeWindowResult = true;
  await context.reconcileAnalysisQueueState('test_dispatch_confirmed_window_closed');
  assert.deepStrictEqual(
    context.startedJobs.map((entry) => entry.runId),
    ['run-2'],
    'Queue should start the next process after the previous confirmed process window is closed.'
  );
  assert.deepStrictEqual(context.analysisQueueState.activeJobs.map((job) => job.runId), ['run-2']);
  assert(
    context.upserts.some((entry) => entry.runId === 'run-1' && entry.patch.queueState === 'dispatch_confirmed' && entry.patch.slotReserved === false),
    'Closed confirmed process should release its reserved slot.'
  );

  context.analysisQueueState = {
    waitingJobs: [
      { jobId: 'aq-2', runId: 'run-2', sequence: 2, createdAt: 2 }
    ],
    activeJobs: [
      { jobId: 'aq-1', runId: 'run-1', sequence: 1, createdAt: 1, slotReservedAt: 1 }
    ],
    maxConcurrent: 1,
    lastSequence: 2
  };
  context.processRegistry = new Map([
    ['run-1', {
      id: 'run-1',
      status: 'completed',
      currentPrompt: 5,
      totalPrompts: 5,
      stageIndex: 4,
      queueManaged: true,
      queueJobId: 'aq-1',
      queueState: 'awaiting_dispatch_confirmation',
      slotReserved: true,
      completedResponseSaved: true,
      completedResponseSaveTrace: 'run-1/resp-1',
      persistenceStatus: {
        hasResponse: true,
        saveOk: true,
        copyTrace: 'run-1/resp-1',
        dispatch: {
          state: 'queued',
          sent: 0,
          failed: 0,
          pending: 1
        }
      }
    }]
  ]);
  context.startedJobs = [];
  context.upserts = [];
  context.closedRuns = [];
  context.reconcileRequests = [];
  const dispatchConfirmed = await context.updateProcessDispatchAfterSendSuccess('run-1', 'resp-1', {
    status: 200,
    eventId: 'evt-1',
    requestId: 'req-1',
    intakeUrl: 'https://watchlist.test/intake'
  });
  assert.strictEqual(dispatchConfirmed, true);
  assert(
    context.reconcileRequests.includes('process_upsert'),
    'Dispatch confirmation upsert should wake the queue reconciler.'
  );
  assert.strictEqual(
    context.processRegistry.get('run-1')?.persistenceStatus?.dispatch?.state,
    'dispatch_confirmed'
  );
  await context.reconcileAnalysisQueueState('test_dispatch_confirm_helper');
  assert.deepStrictEqual(context.startedJobs.map((entry) => entry.runId), ['run-2']);
  assert.deepStrictEqual(context.closedRuns, []);
  assert(
    context.upserts.some((entry) => entry.runId === 'run-1' && entry.patch.queueState === 'dispatch_confirmed'),
    'Dispatch helper confirmation should let reconcile release the previous slot.'
  );

  context.analysisQueueState = {
    waitingJobs: [
      { jobId: 'aq-2', runId: 'run-2', sequence: 2, createdAt: 2 }
    ],
    activeJobs: [
      { jobId: 'aq-1', runId: 'run-1', sequence: 1, createdAt: 1, slotReservedAt: 1 }
    ],
    maxConcurrent: 1,
    lastSequence: 2
  };
  context.processRegistry = new Map([
    ['run-1', {
      id: 'run-1',
      status: 'completed',
      lifecycleStatus: 'completed',
      currentPrompt: 5,
      totalPrompts: 5,
      stageIndex: 4,
      queueManaged: true,
      queueJobId: 'aq-1',
      queueState: 'awaiting_dispatch_confirmation',
      slotReserved: true,
      requiresWindowClose: true,
      tabId: 141,
      windowId: 241,
      completedResponseSaved: true,
      completedResponseSaveTrace: 'run-1/resp-1',
      persistenceStatus: {
        hasResponse: true,
        saveOk: true,
        copyTrace: 'run-1/resp-1',
        dispatch: {
          state: 'queued',
          sent: 0,
          failed: 0,
          pending: 1
        }
      }
    }]
  ]);
  context.startedJobs = [];
  context.upserts = [];
  context.closedRuns = [];
  context.reconcileRequests = [];
  context.closeWindowResult = true;
  const e2eDispatchConfirmed = await context.updateProcessDispatchAfterSendSuccess('run-1', 'resp-1', {
    status: 200,
    eventId: 'evt-e2e',
    requestId: 'req-e2e',
    intakeUrl: 'https://watchlist.test/intake'
  });
  assert.strictEqual(e2eDispatchConfirmed, true);
  await context.reconcileAnalysisQueueState('test_dispatch_confirmed_then_close');
  assert.deepStrictEqual(
    context.startedJobs.map((entry) => entry.runId),
    ['run-2'],
    'Queue should start the next process only after the previous process window is closed.'
  );
  assert(
    context.closedRuns.length >= 1 && context.closedRuns.every((runId) => runId === 'run-1'),
    'Queue should close only the confirmed previous process window before starting the next job.'
  );
  assert.strictEqual(context.processRegistry.get('run-1')?.windowClose?.state, 'closed');
  assert.deepStrictEqual(context.analysisQueueState.activeJobs.map((job) => job.runId), ['run-2']);
  assert.deepStrictEqual(context.analysisQueueState.waitingJobs.map((job) => job.runId), []);
  assert(
    context.reconcileRequests.includes('queue_window_close_finished'),
    'Successful window close should request a follow-up reconcile before releasing the slot.'
  );
  assert(
    context.upserts.some((entry) => entry.runId === 'run-1'
      && entry.patch.queueState === 'dispatch_confirmed'
      && entry.patch.slotReserved === false),
    'Dispatch-confirmed closed process should release its slot before the next process starts.'
  );

  context.startedJobs = [];
  context.upserts = [];
  context.closedRuns = [];
  await context.reconcileAnalysisQueueState('test_start_after_confirmed_window_closed');
  assert.deepStrictEqual(
    context.startedJobs.map((entry) => entry.runId),
    [],
    'Follow-up reconcile should not start the same next process twice.'
  );
  assert.deepStrictEqual(context.analysisQueueState.activeJobs.map((job) => job.runId), ['run-2']);

  context.analysisQueueState = {
    waitingJobs: [
      { jobId: 'aq-2', runId: 'run-2', sequence: 2, createdAt: 2 }
    ],
    activeJobs: [
      { jobId: 'aq-1', runId: 'run-1', sequence: 1, createdAt: 1, slotReservedAt: 1 }
    ],
    maxConcurrent: 1,
    lastSequence: 2
  };
  context.processRegistry = new Map([
    ['run-1', {
      id: 'run-1',
      status: 'completed',
      lifecycleStatus: 'completed',
      currentPrompt: 5,
      totalPrompts: 5,
      stageIndex: 4,
      queueManaged: true,
      queueJobId: 'aq-1',
      queueState: 'awaiting_window_close',
      slotReserved: true,
      requiresWindowClose: true,
      tabId: 101,
      windowId: 201,
      windowClose: {
        state: 'closed',
        closedAt: 3000
      },
      completedResponseSaved: true,
      persistenceStatus: {
        saveOk: true,
        dispatch: {
          state: 'dispatch_confirmed',
          sent: 1,
          failed: 0,
          pending: 0,
          verifyState: 'verified'
        }
      }
    }]
  ]);
  context.startedJobs = [];
  context.upserts = [];
  context.closedRuns = [];
  context.closeWindowResult = false;
  await context.reconcileAnalysisQueueState('test_restart_after_worker_seen_closed_window');
  assert.deepStrictEqual(
    context.startedJobs.map((entry) => entry.runId),
    ['run-2'],
    'Recovered process with an already closed window should release its slot and start the next job.'
  );
  assert.deepStrictEqual(
    context.closedRuns,
    [],
    'Recovered already-closed window must not request another close before releasing the slot.'
  );
  assert.deepStrictEqual(context.analysisQueueState.activeJobs.map((job) => job.runId), ['run-2']);
  assert(
    context.upserts.some((entry) => entry.runId === 'run-1'
      && entry.patch.queueState === 'dispatch_confirmed'
      && entry.patch.slotReserved === false
      && entry.patch.slotReleaseReason === 'dispatch_confirmed'),
    'Recovered already-closed confirmed process should persist a dispatch_confirmed slot release.'
  );

  context.analysisQueueState = {
    waitingJobs: [
      { jobId: 'aq-2', runId: 'run-2', sequence: 2, createdAt: 2 }
    ],
    activeJobs: [
      { jobId: 'aq-1', runId: 'run-1', sequence: 1, createdAt: 1, slotReservedAt: 1 }
    ],
    maxConcurrent: 1,
    lastSequence: 2
  };
  context.processRegistry = new Map([
    ['run-1', {
      id: 'run-1',
      status: 'failed',
      lifecycleStatus: 'failed',
      reason: 'invalid_tab',
      queueManaged: true,
      queueJobId: 'aq-1',
      queueState: 'active',
      slotReserved: true
    }]
  ]);
  context.startedJobs = [];
  context.upserts = [];
  context.closedRuns = [];
  context.closeWindowResult = false;
  await context.reconcileAnalysisQueueState('test_setup_failure_without_window_releases_slot');
  assert.deepStrictEqual(
    context.startedJobs.map((entry) => entry.runId),
    ['run-2'],
    'Setup failure without a process window should release the slot and start the next queued job.'
  );
  assert.deepStrictEqual(context.closedRuns, []);
  assert(
    context.upserts.some((entry) => entry.runId === 'run-1'
      && entry.patch.queueState === 'slot_released'
      && entry.patch.slotReserved === false
      && entry.patch.slotReleaseReason === 'failed'),
    'Setup failure without a window should persist a slot_released state.'
  );

  context.analysisQueueState = {
    waitingJobs: [
      { jobId: 'aq-2', runId: 'run-2', sequence: 2, createdAt: 2 }
    ],
    activeJobs: [
      { jobId: 'aq-1', runId: 'run-1', sequence: 1, createdAt: 1, slotReservedAt: 1 }
    ],
    maxConcurrent: 1,
    lastSequence: 2
  };
  context.processRegistry = new Map([
    ['run-1', {
      id: 'run-1',
      status: 'failed',
      lifecycleStatus: 'failed',
      reason: 'queue_execution_exception',
      queueManaged: true,
      queueJobId: 'aq-1',
      queueState: 'active',
      slotReserved: true,
      requiresWindowClose: true,
      tabId: 301,
      windowId: 401
    }]
  ]);
  context.startedJobs = [];
  context.upserts = [];
  context.closedRuns = [];
  context.closeWindowResult = false;
  await context.reconcileAnalysisQueueState('test_failed_process_window_close_pending');
  assert.deepStrictEqual(
    context.startedJobs.map((entry) => entry.runId),
    [],
    'Queue must not start the next process while a failed queued process window is still closing.'
  );
  assert(
    context.closedRuns.length >= 1 && context.closedRuns.every((runId) => runId === 'run-1'),
    'Queue should keep attempting to close only the failed queued process window.'
  );
  assert.deepStrictEqual(context.analysisQueueState.activeJobs.map((job) => job.runId), ['run-1']);
  assert.deepStrictEqual(context.analysisQueueState.waitingJobs.map((job) => job.runId), ['run-2']);
  assert(
    context.upserts.some((entry) => entry.runId === 'run-1' && entry.patch.queueState === 'awaiting_window_close'),
    'Failed queued process should hold the slot as awaiting_window_close until its window closes.'
  );

  context.analysisQueueState = {
    waitingJobs: [
      { jobId: 'aq-2', runId: 'run-2', sequence: 2, createdAt: 2 }
    ],
    activeJobs: [
      { jobId: 'aq-1', runId: 'run-1', sequence: 1, createdAt: 1, slotReservedAt: 1 }
    ],
    maxConcurrent: 1,
    lastSequence: 2
  };
  context.processRegistry = new Map([
    ['run-1', {
      id: 'run-1',
      status: 'stopped',
      lifecycleStatus: 'stopped',
      reason: 'data_gap_stage',
      statusCode: 'process.data_gap_stage',
      dataGapDetected: true,
      dataGapStageId: '4',
      requiresWindowClose: true,
      queueState: 'active',
      slotReserved: true
    }]
  ]);
  context.startedJobs = [];
  context.upserts = [];
  context.closedRuns = [];
  context.closeWindowResult = false;
  await context.reconcileAnalysisQueueState('test_data_gap_stage_release');
  assert.deepStrictEqual(context.startedJobs.map((entry) => entry.runId), []);
  assert(
    context.closedRuns.length >= 1 && context.closedRuns.every((runId) => runId === 'run-1'),
    'Queue should keep attempting to close only the data-gap process window.'
  );
  assert(
    context.upserts.some((entry) => entry.runId === 'run-1' && entry.patch.queueState === 'awaiting_window_close'),
    'DATA_GAP_STAGE with an open window should hold the active slot until close succeeds.'
  );

  context.startedJobs = [];
  context.upserts = [];
  context.closedRuns = [];
  context.closeWindowResult = true;
  await context.reconcileAnalysisQueueState('test_data_gap_stage_close_finished');
  assert.deepStrictEqual(context.closedRuns, ['run-1']);
  assert.deepStrictEqual(context.startedJobs.map((entry) => entry.runId), ['run-2']);
  assert(
    context.upserts.some((entry) => entry.runId === 'run-1' && entry.patch.queueState === 'slot_released' && entry.patch.slotReleaseReason === 'data_gap_stage'),
    'DATA_GAP_STAGE should release the slot only after its window has closed.'
  );

  console.log('analysis queue completion test: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
