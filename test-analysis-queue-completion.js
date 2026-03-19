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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function main() {
  const completionMatches = backgroundSource.match(
    /finalStatus === 'completed'[\s\S]{0,500}?currentPrompt:\s*processTotalPrompts[\s\S]{0,200}?stageIndex:\s*processTotalPrompts - 1/g
  ) || [];
  assert(
    completionMatches.length >= 2,
    'Expected both completion paths to stamp the process with the final prompt/stage.'
  );

  const context = {
    console,
    Date,
    Promise,
    Map,
    Set,
    ANALYSIS_QUEUE_DISPATCH_CONFIRM_TIMEOUT_MS: 5 * 60 * 1000,
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
      return next;
    },
    closeProcessWindowAfterQueueSuccess: async (process) => {
      const runId = typeof process?.id === 'string' ? process.id : '';
      context.closedRuns.push(runId);
      return true;
    },
    reportAnalysisQueueEvent: async () => true,
    runQueuedAnalysisJob: (job, reason) => {
      context.startedJobs.push({ runId: job.runId, jobId: job.jobId, reason });
    },
    requestAnalysisQueueReconcile: () => {}
  };

  vm.createContext(context);
  const functionNames = [
    'normalizeProcessStatus',
    'isClosedProcessStatus',
    'resolveProcessStageSnapshot',
    'hasProcessReachedFinalStage',
    'getProcessPersistenceDispatchSnapshot',
    'getProcessQueueDeliveryState',
    'getAnalysisQueueCompletionTimestamp',
    'resolveAnalysisQueueDispatchDeadlineAt',
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
    true,
    'Completed process at the last stage should be recognized as finished.'
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
  assert.strictEqual(keepDecision.queueState, 'awaiting_final_stage');

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
  assert.strictEqual(releaseDecision.reason, 'dispatch_confirmed');

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
  assert.strictEqual(pendingDispatchDecision.queueState, 'awaiting_dispatch');
  assert.strictEqual(pendingDispatchDecision.dispatchDeadlineAt, 301000);

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
  assert.strictEqual(
    cappedDispatchDeadlineDecision.dispatchDeadlineAt,
    301000,
    'Stored queue deadlines should be capped to 5 minutes after analysis completion.'
  );

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
  assert.strictEqual(timedOutDispatchDecision.action, 'release');
  assert.strictEqual(timedOutDispatchDecision.closeWindow, true);
  assert.strictEqual(timedOutDispatchDecision.reason, 'pending_dispatch_timeout');

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
  assert.strictEqual(context.startedJobs.length, 0, 'Queue must not start the next job before dispatch gets space to finish.');
  assert.deepStrictEqual(context.analysisQueueState.activeJobs.map((job) => job.runId), ['run-1']);
  assert.deepStrictEqual(context.analysisQueueState.waitingJobs.map((job) => job.runId), ['run-2']);
  assert(
    context.analysisQueueState.activeJobs.every((job) => Number.isInteger(job.dispatchDeadlineAt) && job.dispatchDeadlineAt > Date.now()),
    'Completed process should keep a dispatch deadline while waiting for send confirmation.'
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
  assert.deepStrictEqual(context.startedJobs.map((entry) => entry.runId), ['run-2']);
  assert.deepStrictEqual(context.closedRuns, ['run-1']);
  assert(
    context.upserts.some((entry) => entry.runId === 'run-1' && entry.patch.queueState === 'slot_released'),
    'Timed-out dispatch should release the slot without pretending dispatch was confirmed.'
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
  await context.reconcileAnalysisQueueState('test_final_stage');
  assert.deepStrictEqual(context.startedJobs.map((entry) => entry.runId), ['run-2']);
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

  console.log('analysis queue completion test: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
