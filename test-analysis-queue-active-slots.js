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

let context = null;

async function testCountsAllLiveProcesses() {
  context = buildScenarioContext();
  const now = Date.now();
  context.analysisQueueState = {
    waitingJobs: [{ jobId: 'aq-wait-1', runId: 'run-wait-1', sequence: 8, createdAt: now }],
    activeJobs: [],
    maxConcurrent: 7,
    lastSequence: 8
  };
  for (let index = 1; index <= 7; index += 1) {
    const runId = `run-live-${index}`;
    context.processRegistry.set(runId, {
      id: runId,
      status: 'running',
      currentPrompt: index,
      totalPrompts: 10,
      stageIndex: index - 1,
      tabId: 100 + index,
      windowId: 200 + index,
      timestamp: now
    });
    context.liveTabs.add(100 + index);
  }

  const status = await context.getAnalysisQueueStatusSnapshot();
  assert.strictEqual(status.activeSlots, 7, 'Queue status should count all live process windows.');

  context.startedJobs = [];
  await context.reconcileAnalysisQueueState('live_slots_full');
  assert.strictEqual(context.startedJobs.length, 0, 'Queue must not start when 7 live processes already occupy all slots.');
  assert.strictEqual(context.analysisQueueState.waitingJobs.length, 1, 'Waiting job should stay queued when slots are full.');
}

async function testGracePreventsPrematureSlotRelease() {
  context = buildScenarioContext();
  const now = Date.now();
  context.analysisQueueState = {
    waitingJobs: [{ jobId: 'aq-2', runId: 'run-2', sequence: 2, createdAt: now }],
    activeJobs: [{ jobId: 'aq-1', runId: 'run-1', sequence: 1, createdAt: now, slotReservedAt: now }],
    maxConcurrent: 1,
    lastSequence: 2
  };
  context.processRegistry.set('run-1', {
    id: 'run-1',
    status: 'queued',
    queueManaged: true,
    slotReserved: true,
    currentPrompt: 0,
    totalPrompts: 10,
    timestamp: now
  });

  context.startedJobs = [];
  context.upserts = [];
  await context.reconcileAnalysisQueueState('recent_grace');
  assert.strictEqual(context.startedJobs.length, 0, 'Freshly reserved slot without tab/window must not release immediately.');
  assert.deepStrictEqual(context.analysisQueueState.activeJobs.map((job) => job.runId), ['run-1']);
  assert.deepStrictEqual(context.analysisQueueState.waitingJobs.map((job) => job.runId), ['run-2']);
}

async function testClosedWindowDoesNotConsumeSlot() {
  context = buildScenarioContext();
  const now = Date.now();
  context.processRegistry.set('run-closed-window', {
    id: 'run-closed-window',
    status: 'running',
    currentPrompt: 3,
    totalPrompts: 10,
    stageIndex: 2,
    tabId: 301,
    windowId: 401,
    timestamp: now
  });

  const status = await context.getAnalysisQueueStatusSnapshot();
  assert.strictEqual(status.activeSlots, 0, 'Process with missing tab/window should stop consuming a slot immediately.');
}

async function testCompletedPendingDispatchKeepsSlotReserved() {
  context = buildScenarioContext();
  const now = Date.now();
  context.analysisQueueState = {
    waitingJobs: [{ jobId: 'aq-2', runId: 'run-2', sequence: 2, createdAt: now }],
    activeJobs: [{ jobId: 'aq-1', runId: 'run-1', sequence: 1, createdAt: now, slotReservedAt: now }],
    maxConcurrent: 1,
    lastSequence: 2
  };
  context.processRegistry.set('run-1', {
    id: 'run-1',
    status: 'completed',
    queueManaged: true,
    slotReserved: true,
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
    },
    timestamp: now
  });

  const activity = await context.getAnalysisQueueProcessActivityState(
    context.processRegistry.get('run-1'),
    now
  );
  assert.strictEqual(
    activity.active,
    true,
    'Completed process waiting for dispatch confirmation should keep occupying its slot.'
  );

  context.startedJobs = [];
  context.upserts = [];
  await context.reconcileAnalysisQueueState('completed_dispatch_pending');
  assert.strictEqual(
    context.startedJobs.length,
    0,
    'Queue must not start the next job while completed run still waits for dispatch confirmation.'
  );
  assert.deepStrictEqual(context.analysisQueueState.activeJobs.map((job) => job.runId), ['run-1']);
  assert.deepStrictEqual(context.analysisQueueState.waitingJobs.map((job) => job.runId), ['run-2']);
}

async function testLocalSaveFailureClosesCompletedProcessWindow() {
  context = buildScenarioContext();
  const now = Date.now();
  context.analysisQueueState = {
    waitingJobs: [{ jobId: 'aq-2', runId: 'run-2', sequence: 2, createdAt: now }],
    activeJobs: [{ jobId: 'aq-1', runId: 'run-1', sequence: 1, createdAt: now, slotReservedAt: now }],
    maxConcurrent: 1,
    lastSequence: 2
  };
  context.processRegistry.set('run-1', {
    id: 'run-1',
    status: 'completed',
    queueManaged: true,
    slotReserved: true,
    currentPrompt: 5,
    totalPrompts: 5,
    stageIndex: 4,
    completedResponseSaved: false,
    persistenceStatus: {
      saveOk: false,
      dispatch: null
    },
    tabId: 321,
    windowId: 421,
    timestamp: now
  });
  context.liveTabs.add(321);

  context.startedJobs = [];
  context.upserts = [];
  context.closedRuns = [];
  await context.reconcileAnalysisQueueState('completed_local_save_failed');
  assert.deepStrictEqual(
    context.closedRuns,
    ['run-1'],
    'Completed process with local save failure should still close its process window.'
  );
  assert.deepStrictEqual(
    context.startedJobs.map((job) => job.runId),
    ['run-2'],
    'Queue should immediately reuse the released slot after local save failure.'
  );
}

function buildScenarioContext() {
  const scenarioContext = {
    console,
    Date,
    Promise,
    Map,
    Set,
    ANALYSIS_QUEUE_MAX_CONCURRENT: 7,
    ANALYSIS_QUEUE_DISPATCH_CONFIRM_TIMEOUT_MS: 10 * 60 * 1000,
    ANALYSIS_QUEUE_LOCAL_CONTEXT_GRACE_MS: 45 * 1000,
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
      maxConcurrent: 7,
      lastSequence: 0
    },
    processRegistry: new Map(),
    liveTabs: new Set(),
    windowTabs: new Map(),
    startedJobs: [],
    upserts: [],
    closedRuns: [],
    ensureAnalysisQueueReady: async () => scenarioContext.analysisQueueState,
    ensureProcessRegistryReady: async () => scenarioContext.processRegistry,
    withAnalysisQueueMutationLock: async (task) => task(),
    cloneAnalysisQueueState: () => clone(scenarioContext.analysisQueueState),
    persistAnalysisQueueState: async (state) => {
      scenarioContext.analysisQueueState = clone(state);
      return scenarioContext.analysisQueueState;
    },
    getAnalysisQueueSnapshot: async () => clone(scenarioContext.analysisQueueState),
    sanitizeAnalysisQueueJob: (job) => clone(job),
    pruneProcessRecords: (records) => clone(records),
    getTabByIdSafe: async (tabId) => (scenarioContext.liveTabs.has(tabId) ? { id: tabId } : null),
    queryTabsInWindowSafe: async (windowId) => ({
      ok: true,
      tabs: clone(scenarioContext.windowTabs.get(windowId) || [])
    }),
    upsertProcess: async (runId, patch) => {
      const current = scenarioContext.processRegistry.get(runId) || { id: runId };
      const next = { ...current, ...clone(patch) };
      scenarioContext.processRegistry.set(runId, next);
      scenarioContext.upserts.push({ runId, patch: clone(patch) });
      return next;
    },
    closeProcessWindowAfterQueueSuccess: async (process) => {
      const runId = typeof process?.id === 'string' ? process.id : '';
      scenarioContext.closedRuns.push(runId);
      return true;
    },
    runQueuedAnalysisJob: (job, reason) => {
      scenarioContext.startedJobs.push({ runId: job.runId, jobId: job.jobId, reason });
    },
    requestAnalysisQueueReconcile: () => {}
  };

  const functionNames = [
    'normalizeProcessStatus',
    'isClosedProcessStatus',
    'resolveProcessStageSnapshot',
    'hasProcessReachedFinalStage',
    'getProcessPersistenceDispatchSnapshot',
    'getProcessQueueDeliveryState',
    'getProcessLastActivityTimestamp',
    'getAnalysisQueueProcessContextKey',
    'shouldProcessOccupyAnalysisQueueSlot',
    'isProcessWithinAnalysisQueueContextGrace',
    'getAnalysisQueueProcessActivityState',
    'isLocalProcessActiveForQueue',
    'shouldReplaceAnalysisQueueActiveProcess',
    'collectAnalysisQueueActiveProcesses',
    'getAnalysisQueueStatusSnapshot',
    'resolveAnalysisQueueReleaseDecision',
    'reconcileAnalysisQueueState'
  ];
  return loadScenarioFunctions(scenarioContext, functionNames);
}

function loadScenarioFunctions(scenarioContext, functionNames) {
  vm.createContext(scenarioContext);
  for (const functionName of functionNames) {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), scenarioContext, {
      filename: 'background.js'
    });
  }
  return scenarioContext;
}

async function main() {
  await testCountsAllLiveProcesses();
  await testGracePreventsPrematureSlotRelease();
  await testClosedWindowDoesNotConsumeSlot();
  await testCompletedPendingDispatchKeepsSlotReserved();
  await testLocalSaveFailureClosesCompletedProcessWindow();
  console.log('analysis queue active slot test: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
