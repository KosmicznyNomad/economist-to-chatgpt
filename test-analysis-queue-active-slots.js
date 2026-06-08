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

let context = null;

async function testCountsAllLiveProcesses() {
  context = buildScenarioContext();
  const now = Date.now();
  context.analysisQueueState = {
    waitingJobs: [{ jobId: 'aq-wait-1', runId: 'run-wait-1', sequence: 8, createdAt: now }],
    activeJobs: [],
    maxConcurrent: 1,
    lastSequence: 8
  };
  for (let index = 1; index <= 4; index += 1) {
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
  assert.strictEqual(status.activeSlots, 4, 'Queue status should count all live process windows.');

  context.startedJobs = [];
  await context.reconcileAnalysisQueueState('live_slots_full');
  assert.strictEqual(context.startedJobs.length, 0, 'Queue must not start when 4 live processes already occupy all slots.');
  assert.strictEqual(context.analysisQueueState.waitingJobs.length, 1, 'Waiting job should stay queued when slots are full.');
}

async function testOpenAnalysisTabsBlockNewQueueStarts() {
  context = buildScenarioContext();
  const now = Date.now();
  context.analysisQueueState = {
    waitingJobs: [{ jobId: 'aq-wait-open-tabs', runId: 'run-wait-open-tabs', sequence: 1, createdAt: now }],
    activeJobs: [],
    maxConcurrent: 3,
    lastSequence: 1
  };
  context.countOpenAnalysisChatTabs = async () => 3;

  const status = await context.getAnalysisQueueStatusSnapshot();
  assert.strictEqual(status.activeSlots, 3, 'Open ChatGPT analysis tabs should occupy queue slots.');
  assert.strictEqual(status.reservedSlots, 3, 'Open ChatGPT analysis tabs should reserve queue capacity.');
  assert.strictEqual(status.openAnalysisChatTabs, 3, 'Queue status should expose the open analysis tab count.');

  context.startedJobs = [];
  await context.reconcileAnalysisQueueState('open_analysis_tabs_full');
  assert.strictEqual(context.startedJobs.length, 0, 'Queue must not start new jobs when open analysis tabs fill the cap.');
  assert.deepStrictEqual(
    context.analysisQueueState.waitingJobs.map((job) => job.runId),
    ['run-wait-open-tabs'],
    'Waiting job should stay queued until existing analysis tabs are closed.'
  );
}

async function testOpenAnalysisTabCounterIgnoresGenericChatGptTabs() {
  context = buildScenarioContext();
  context.chrome = {
    tabs: {
      query: async () => [
        { id: 1, url: 'https://chatgpt.com/' },
        { id: 2, url: 'https://chatgpt.com/c/regular-user-chat' },
        { id: 3, url: 'https://chat.openai.com/c/another-regular-chat' },
        { id: 4, url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/c/company-run' },
        { id: 5, url: 'https://chatgpt.com/g/g-p-69f5df201ec08191bdffe0376f17191e/c/portfolio-run' },
        { id: 6, pendingUrl: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/project' },
        { id: 7, url: 'https://example.com/' }
      ]
    }
  };

  const openAnalysisTabs = await context.countOpenAnalysisChatTabs();

  assert.strictEqual(
    openAnalysisTabs,
    3,
    'Only Iskierka/Portfolio GPT tabs should reserve queue slots; generic ChatGPT tabs must not block the queue.'
  );
}

async function testResumeJobAdoptsItsOpenTargetAnalysisTab() {
  context = buildScenarioContext();
  const now = Date.now();
  context.analysisQueueState = {
    waitingJobs: [{
      jobId: 'aq-resume-open-tab',
      runId: 'run-resume-open-tab',
      kind: 'resume_stage',
      sequence: 1,
      createdAt: now,
      resumeTargetTabId: 501,
      resumeTargetWindowId: 601,
      resumeStartIndex: 4
    }],
    activeJobs: [],
    maxConcurrent: 1,
    lastSequence: 1
  };
  context.chrome = {
    tabs: {
      query: async () => [
        { id: 501, windowId: 601, url: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka/c/company-resume' },
        { id: 777, windowId: 777, url: 'https://chatgpt.com/c/regular-user-chat' }
      ]
    }
  };

  context.startedJobs = [];
  await context.reconcileAnalysisQueueState('resume_adopts_open_target_tab');

  assert.deepStrictEqual(
    context.startedJobs.map((job) => job.runId),
    ['run-resume-open-tab'],
    'Resume job should be allowed to adopt its already-open target Iskierka tab.'
  );
  assert.deepStrictEqual(context.analysisQueueState.activeJobs.map((job) => job.runId), ['run-resume-open-tab']);
  assert.deepStrictEqual(context.analysisQueueState.waitingJobs, []);
}

async function testOrphanOpenAnalysisTabBlocksAfterConfirmedRelease() {
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
        state: 'dispatch_confirmed',
        sent: 1,
        failed: 0,
        pending: 0,
        verifyState: 'verified'
      }
    },
    timestamp: now
  });
  context.countOpenAnalysisChatTabs = async () => 1;
  context.closeWindowResult = false;

  context.startedJobs = [];
  context.upserts = [];
  context.closedRuns = [];
  await context.reconcileAnalysisQueueState('orphan_open_analysis_tab_after_confirmed_release');
  assert.deepStrictEqual(
    context.startedJobs.map((job) => job.runId),
    [],
    'Queue must not start the next job while an orphan analysis tab is still open.'
  );
  assert.deepStrictEqual(
    context.analysisQueueState.waitingJobs.map((job) => job.runId),
    ['run-2'],
    'Waiting job should stay queued until the orphan analysis tab is gone.'
  );
  assert.deepStrictEqual(
    context.closedRuns,
    [],
    'Confirmed process without a concrete window context should not request a synthetic close.'
  );
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

async function testReleasedRunningQueueManagedProcessDoesNotConsumeSlot() {
  context = buildScenarioContext();
  const now = Date.now();
  context.analysisQueueState = {
    waitingJobs: [{ jobId: 'aq-2', runId: 'run-2', sequence: 2, createdAt: now }],
    activeJobs: [],
    maxConcurrent: 1,
    lastSequence: 2
  };
  context.processRegistry.set('run-released', {
    id: 'run-released',
    status: 'running',
    queueManaged: true,
    slotReserved: false,
    currentPrompt: 2,
    totalPrompts: 10,
    stageIndex: 1,
    tabId: 330,
    windowId: 430,
    timestamp: now
  });
  context.liveTabs.add(330);

  const status = await context.getAnalysisQueueStatusSnapshot();
  assert.strictEqual(
    status.activeSlots,
    0,
    'Queue-managed running process with a released slot must not consume another queue slot.'
  );

  context.startedJobs = [];
  await context.reconcileAnalysisQueueState('released_slot_not_counted');
  assert.deepStrictEqual(
    context.startedJobs.map((job) => job.runId),
    ['run-2'],
    'Queue should be able to reuse a slot released by a still-running ghost process.'
  );
}

async function testPortfolioProcessConsumesSequentialQueueSlot() {
  context = buildScenarioContext();
  const now = Date.now();
  context.analysisQueueState = {
    waitingJobs: [{ jobId: 'aq-company-1', runId: 'run-company-1', sequence: 1, createdAt: now }],
    activeJobs: [],
    maxConcurrent: 1,
    lastSequence: 1
  };
  context.processRegistry.set('run-portfolio-1', {
    id: 'run-portfolio-1',
    status: 'running',
    analysisType: 'portfolio',
    currentPrompt: 1,
    totalPrompts: 3,
    stageIndex: 0,
    tabId: 350,
    windowId: 450,
    timestamp: now
  });
  context.liveTabs.add(350);

  const status = await context.getAnalysisQueueStatusSnapshot();
  assert.strictEqual(status.activeSlots, 1, 'Portfolio analysis must consume the sequential analysis queue slot.');

  context.startedJobs = [];
  await context.reconcileAnalysisQueueState('portfolio_slot_exempt');
  assert.deepStrictEqual(
    context.startedJobs.map((job) => job.runId),
    [],
    'Company queue must wait while portfolio analysis is already running.'
  );
  assert.deepStrictEqual(
    context.analysisQueueState.waitingJobs.map((job) => job.runId),
    ['run-company-1'],
    'Waiting company job should stay queued until portfolio completes.'
  );
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
    'Completed process with pending DB dispatch should still occupy its queue slot.'
  );
  const pendingStatus = await context.getAnalysisQueueStatusSnapshot();
  assert.strictEqual(pendingStatus.activeSlots, 1);
  assert.strictEqual(pendingStatus.reservedSlots, 1);

  context.startedJobs = [];
  context.upserts = [];
  await context.reconcileAnalysisQueueState('completed_dispatch_pending');
  assert.strictEqual(
    context.startedJobs.length,
    0,
    'Queue must not reuse the slot until DB dispatch is confirmed.'
  );
  assert.deepStrictEqual(context.startedJobs.map((job) => job.runId), []);
  assert.deepStrictEqual(context.analysisQueueState.activeJobs.map((job) => job.runId), ['run-1']);
  assert.deepStrictEqual(context.analysisQueueState.waitingJobs.map((job) => job.runId), ['run-2']);
  assert.deepStrictEqual(context.closedRuns, []);
  assert(
    context.upserts.some((entry) => entry.runId === 'run-1' && entry.patch.queueState === 'awaiting_dispatch_confirmation'),
    'Pending dispatch should keep the active queue slot marked as awaiting DB confirmation.'
  );
}

async function testSavedProcessWithMissingLocalContextKeepsWindowOpen() {
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
    status: 'running',
    queueManaged: true,
    slotReserved: true,
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
    },
    tabId: 321,
    windowId: 421,
    timestamp: now - 120000
  });

  context.startedJobs = [];
  context.upserts = [];
  context.closedRuns = [];
  context.closeWindowResult = false;
  await context.reconcileAnalysisQueueState('saved_missing_context');

  assert.deepStrictEqual(context.closedRuns, ['run-1']);
  assert.deepStrictEqual(
    context.startedJobs.map((job) => job.runId),
    [],
    'Saved confirmed process with missing local context must still hold the slot until its window close succeeds.'
  );
  assert.deepStrictEqual(context.analysisQueueState.activeJobs.map((job) => job.runId), ['run-1']);
  assert.deepStrictEqual(context.analysisQueueState.waitingJobs.map((job) => job.runId), ['run-2']);
  assert(
    context.upserts.some((entry) => entry.runId === 'run-1' && entry.patch.queueState === 'awaiting_window_close'),
    'Saved process that lost local context should wait for confirmed process-window close before releasing.'
  );

  context.processRegistry.set('run-1', {
    ...context.processRegistry.get('run-1'),
    windowClose: {
      state: 'closed',
      closedAt: now
    }
  });
  context.startedJobs = [];
  context.upserts = [];
  context.closedRuns = [];
  context.closeWindowResult = true;
  await context.reconcileAnalysisQueueState('saved_missing_context_window_closed');
  assert.deepStrictEqual(context.startedJobs.map((job) => job.runId), ['run-2']);
  assert(
    context.upserts.some((entry) => (
      entry.runId === 'run-1'
      && entry.patch.slotReleaseReason === 'dispatch_confirmed_after_local_context_loss'
      && entry.patch.slotReserved === false
    )),
    'Saved process that lost local context should release only after its process window is closed.'
  );
}

async function testSavedProcessWithMissingLocalContextPendingDispatchKeepsSlotReserved() {
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
    status: 'running',
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
    tabId: 321,
    windowId: 421,
    timestamp: now - 120000
  });

  context.startedJobs = [];
  context.upserts = [];
  context.closedRuns = [];
  await context.reconcileAnalysisQueueState('saved_missing_context_dispatch_pending');

  assert.deepStrictEqual(context.closedRuns, []);
  assert.deepStrictEqual(
    context.startedJobs.map((job) => job.runId),
    [],
    'Saved process with missing local context must still hold the slot while DB dispatch is pending.'
  );
  assert.deepStrictEqual(context.analysisQueueState.activeJobs.map((job) => job.runId), ['run-1']);
  assert.deepStrictEqual(context.analysisQueueState.waitingJobs.map((job) => job.runId), ['run-2']);
  assert(
    context.upserts.some((entry) => entry.runId === 'run-1' && entry.patch.queueState === 'awaiting_dispatch_confirmation'),
    'Missing local context must not override pending DB dispatch confirmation.'
  );
}

async function testRestoredPendingDispatchProcessReservesSlotWithoutActiveJob() {
  context = buildScenarioContext();
  const now = Date.now();
  context.analysisQueueState = {
    waitingJobs: [{ jobId: 'aq-2', runId: 'run-2', sequence: 2, createdAt: now }],
    activeJobs: [],
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

  const status = await context.getAnalysisQueueStatusSnapshot();
  assert.strictEqual(status.activeSlots, 1);
  assert.strictEqual(status.reservedSlots, 1);

  context.startedJobs = [];
  await context.reconcileAnalysisQueueState('restored_pending_dispatch_without_active_job');
  assert.deepStrictEqual(
    context.startedJobs.map((job) => job.runId),
    [],
    'Restored pending-dispatch process should reserve capacity even if activeJobs was lost.'
  );
  assert.deepStrictEqual(context.analysisQueueState.waitingJobs.map((job) => job.runId), ['run-2']);
}

async function testRestoredAwaitingWindowCloseProcessReservesSlotWithoutActiveJob() {
  context = buildScenarioContext();
  const now = Date.now();
  context.analysisQueueState = {
    waitingJobs: [{ jobId: 'aq-2', runId: 'run-2', sequence: 2, createdAt: now }],
    activeJobs: [],
    maxConcurrent: 1,
    lastSequence: 2
  };
  context.processRegistry.set('run-1', {
    id: 'run-1',
    status: 'completed',
    queueManaged: true,
    queueState: 'awaiting_window_close',
    slotReserved: true,
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
        verifyState: 'verified'
      }
    },
    windowClose: {
      state: 'retrying',
      attemptCount: 3,
      nextAttemptAt: now + 60000
    },
    tabId: 321,
    windowId: 421,
    timestamp: now
  });

  const status = await context.getAnalysisQueueStatusSnapshot();
  assert.strictEqual(status.activeSlots, 1);
  assert.strictEqual(status.reservedSlots, 1);
  assert.strictEqual(status.awaitingWindowCloseSlots, 1);
  const activeProcesses = await context.collectAnalysisQueueActiveProcesses();
  assert.strictEqual(
    activeProcesses[0]?.activity?.reason,
    'awaiting_window_close',
    'Restored window-close process should report the real slot-hold reason.'
  );

  context.startedJobs = [];
  await context.reconcileAnalysisQueueState('restored_window_close_without_active_job');
  assert.deepStrictEqual(
    context.startedJobs.map((job) => job.runId),
    [],
    'Restored window-close process should reserve capacity even if activeJobs was lost.'
  );
  assert.deepStrictEqual(context.analysisQueueState.waitingJobs.map((job) => job.runId), ['run-2']);
}

async function testRestoredConfirmedWindowClosePlanReservesSlotBeforeQueueStateRewrite() {
  context = buildScenarioContext();
  const now = Date.now();
  context.analysisQueueState = {
    waitingJobs: [{ jobId: 'aq-2', runId: 'run-2', sequence: 2, createdAt: now }],
    activeJobs: [],
    maxConcurrent: 1,
    lastSequence: 2
  };
  context.processRegistry.set('run-1', {
    id: 'run-1',
    status: 'completed',
    queueManaged: true,
    queueState: 'awaiting_dispatch_confirmation',
    slotReserved: false,
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
        verifyState: 'verified'
      }
    },
    tabId: 321,
    windowId: 421,
    timestamp: now
  });

  const status = await context.getAnalysisQueueStatusSnapshot();
  assert.strictEqual(
    status.activeSlots,
    1,
    'Restored dispatch-confirmed process with a closeable window should occupy a slot before queueState is rewritten.'
  );
  assert.strictEqual(status.awaitingWindowCloseSlots, 1);

  const activeProcesses = await context.collectAnalysisQueueActiveProcesses();
  assert.strictEqual(
    activeProcesses[0]?.activity?.reason,
    'awaiting_window_close',
    'Pending close plan should be reported as awaiting_window_close even with stale queueState.'
  );

  context.startedJobs = [];
  context.upserts = [];
  context.closedRuns = [];
  await context.reconcileAnalysisQueueState('restored_window_close_plan_before_state_rewrite');
  assert.deepStrictEqual(
    context.startedJobs.map((job) => job.runId),
    [],
    'Queue must not start a waiting job while a restored confirmed process still needs window close.'
  );
  assert.deepStrictEqual(
    context.closedRuns,
    ['run-1'],
    'Restored confirmed process should immediately retry closing its process window.'
  );
  assert(
    context.upserts.some((entry) => entry.runId === 'run-1' && entry.patch.queueState === 'awaiting_window_close'),
    'Restored confirmed process should be rewritten to awaiting_window_close while close is pending.'
  );
  assert(
    context.upserts.some((entry) => (
      entry.runId === 'run-1'
      && entry.patch.queueState === 'dispatch_confirmed'
      && entry.patch.slotReserved === false
      && entry.patch.slotReleaseReason === 'dispatch_confirmed_window_closed'
    )),
    'Restored confirmed process should release its stale slot after the recovered window close succeeds.'
  );
  assert.deepStrictEqual(context.analysisQueueState.waitingJobs.map((job) => job.runId), ['run-2']);
}

async function testRestoredStaleReleasedAwaitingWindowCloseProcessReservesSlot() {
  context = buildScenarioContext();
  const now = Date.now();
  context.analysisQueueState = {
    waitingJobs: [{ jobId: 'aq-2', runId: 'run-2', sequence: 2, createdAt: now }],
    activeJobs: [],
    maxConcurrent: 1,
    lastSequence: 2
  };
  context.processRegistry.set('run-1', {
    id: 'run-1',
    status: 'completed',
    queueManaged: true,
    queueState: 'awaiting_window_close',
    slotReserved: false,
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
        verifyState: 'verified'
      }
    },
    windowClose: {
      state: 'retrying',
      attemptCount: 1,
      nextAttemptAt: now + 60000
    },
    tabId: 321,
    windowId: 421,
    timestamp: now
  });

  const status = await context.getAnalysisQueueStatusSnapshot();
  assert.strictEqual(
    status.activeSlots,
    1,
    'Restored awaiting-window-close process should occupy a slot even when stale storage says slotReserved=false.'
  );
  assert.strictEqual(status.awaitingWindowCloseSlots, 1);

  context.startedJobs = [];
  await context.reconcileAnalysisQueueState('restored_stale_released_window_close');
  assert.deepStrictEqual(
    context.startedJobs.map((job) => job.runId),
    [],
    'Queue must not start a waiting job while restored awaiting-window-close process still needs tab closure.'
  );
  assert.deepStrictEqual(context.analysisQueueState.waitingJobs.map((job) => job.runId), ['run-2']);
}

async function testLocalSaveFailureKeepsCompletedProcessWindowOpen() {
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
    completedResponseCapturedAt: now,
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
    [],
    'Completed process with local save failure should keep its process window open for recovery.'
  );
  assert.deepStrictEqual(
    context.startedJobs.map((job) => job.runId),
    [],
    'Queue must not reuse the slot when the completed response failed local persistence.'
  );
  assert.deepStrictEqual(context.analysisQueueState.activeJobs.map((job) => job.runId), ['run-1']);
  assert.deepStrictEqual(context.analysisQueueState.waitingJobs.map((job) => job.runId), ['run-2']);
  assert(
    context.upserts.some((entry) => entry.runId === 'run-1' && entry.patch.queueState === 'awaiting_local_save'),
    'Local save failure should leave the active queue slot awaiting persistence recovery.'
  );
}

async function testDuplicateActiveJobsReleaseSupersededContext() {
  context = buildScenarioContext();
  const now = Date.now();
  context.analysisQueueState = {
    waitingJobs: [{ jobId: 'aq-3', runId: 'run-3', sequence: 3, createdAt: now }],
    activeJobs: [
      { jobId: 'aq-1', runId: 'run-1', sequence: 1, createdAt: now - 2000, startedAt: now - 2000, slotReservedAt: now - 2000, resumeTargetTabId: 501, resumeTargetWindowId: 601 },
      { jobId: 'aq-2', runId: 'run-2', sequence: 2, createdAt: now - 1000, startedAt: now - 1000, slotReservedAt: now - 1000, resumeTargetTabId: 501, resumeTargetWindowId: 601 }
    ],
    maxConcurrent: 1,
    lastSequence: 3
  };
  context.processRegistry.set('run-1', {
    id: 'run-1',
    status: 'running',
    queueManaged: true,
    slotReserved: true,
    currentPrompt: 5,
    totalPrompts: 10,
    stageIndex: 4,
    tabId: 501,
    windowId: 601,
    timestamp: now - 2000
  });
  context.processRegistry.set('run-2', {
    id: 'run-2',
    status: 'running',
    queueManaged: true,
    slotReserved: true,
    currentPrompt: 6,
    totalPrompts: 10,
    stageIndex: 5,
    tabId: 501,
    windowId: 601,
    timestamp: now
  });
  context.liveTabs.add(501);

  context.startedJobs = [];
  context.upserts = [];
  await context.reconcileAnalysisQueueState('duplicate_context');
  assert.deepStrictEqual(
    context.analysisQueueState.activeJobs.map((job) => job.runId),
    ['run-2'],
    'Reconcile should keep only the newest active job for the same tab/window context.'
  );
  assert.deepStrictEqual(
    context.analysisQueueState.waitingJobs.map((job) => job.runId),
    ['run-3'],
    'Duplicate slot cleanup must not accidentally start another waiting job.'
  );
  const releasedProcess = context.processRegistry.get('run-1');
  assert.strictEqual(releasedProcess.slotReserved, false, 'Superseded duplicate should release its queue slot.');
  assert.strictEqual(releasedProcess.status, 'stopped', 'Superseded duplicate should be marked as stopped.');
}

async function testManualPdfJobsRespectDedicatedConcurrencyCap() {
  context = buildScenarioContext();
  const now = Date.now();
  context.analysisQueueState = {
    waitingJobs: [
      { jobId: 'aq-pdf-1', runId: 'run-pdf-1', sequence: 1, createdAt: now, sourceKind: 'manual_pdf' },
      { jobId: 'aq-pdf-2', runId: 'run-pdf-2', sequence: 2, createdAt: now, sourceKind: 'manual_pdf' },
      { jobId: 'aq-pdf-3', runId: 'run-pdf-3', sequence: 3, createdAt: now, sourceKind: 'manual_pdf' },
      { jobId: 'aq-pdf-4', runId: 'run-pdf-4', sequence: 4, createdAt: now, sourceKind: 'manual_pdf' },
      { jobId: 'aq-web-1', runId: 'run-web-1', sequence: 5, createdAt: now, sourceKind: 'article' }
    ],
    activeJobs: [],
    maxConcurrent: 1,
    lastSequence: 5
  };

  context.startedJobs = [];
  await context.reconcileAnalysisQueueState('manual_pdf_cap');
  assert.deepStrictEqual(
    context.startedJobs.map((job) => job.runId),
    ['run-pdf-1'],
    'Sequential queue should start only one manual PDF job at a time.'
  );
  assert.deepStrictEqual(
    context.analysisQueueState.waitingJobs.map((job) => job.runId),
    ['run-pdf-2', 'run-pdf-3', 'run-pdf-4', 'run-web-1'],
    'Remaining jobs should stay queued until the active PDF process completes.'
  );
}

async function testPausedQueueKeepsWaitingJobsQueued() {
  context = buildScenarioContext();
  const now = Date.now();
  context.analysisQueueState = {
    waitingJobs: [{ jobId: 'aq-paused-1', runId: 'run-paused-1', sequence: 1, createdAt: now }],
    activeJobs: [],
    maxConcurrent: 1,
    lastSequence: 1
  };
  context.getAnalysisQueuePaused = async () => true;

  const status = await context.getAnalysisQueueStatusSnapshot();
  assert.strictEqual(status.paused, true, 'Queue status should expose the paused flag.');

  context.startedJobs = [];
  await context.reconcileAnalysisQueueState('queue_paused');
  assert.strictEqual(context.startedJobs.length, 0, 'Paused queue must not start waiting jobs.');
  assert.deepStrictEqual(
    context.analysisQueueState.waitingJobs.map((job) => job.runId),
    ['run-paused-1'],
    'Waiting jobs should stay queued while pause is active.'
  );
  assert.deepStrictEqual(context.analysisQueueState.activeJobs, []);
}

async function testPausedQueueAllowsBypassResumeJobs() {
  context = buildScenarioContext();
  const now = Date.now();
  context.analysisQueueState = {
    waitingJobs: [
      { jobId: 'aq-paused-article', runId: 'run-paused-article', kind: 'article_analysis', sequence: 1, createdAt: now },
      { jobId: 'aq-bypass-resume', runId: 'run-bypass-resume', kind: 'resume_stage', sequence: 2, createdAt: now, bypassPause: true }
    ],
    activeJobs: [],
    maxConcurrent: 1,
    lastSequence: 2
  };
  context.getAnalysisQueuePaused = async () => true;

  context.startedJobs = [];
  await context.reconcileAnalysisQueueState('queue_paused_manual_resume');
  assert.deepStrictEqual(
    context.startedJobs.map((job) => job.runId),
    ['run-bypass-resume'],
    'Paused queue should still start manual resume jobs that bypass pause.'
  );
  assert.deepStrictEqual(
    context.analysisQueueState.waitingJobs.map((job) => job.runId),
    ['run-paused-article'],
    'Paused queue should keep non-bypass jobs waiting.'
  );
}

async function testLatePauseRequeuesFreshlyActivatedJobs() {
  context = buildScenarioContext();
  const now = Date.now();
  context.analysisQueueState = {
    waitingJobs: [{ jobId: 'aq-late-pause-1', runId: 'run-late-pause-1', sequence: 1, createdAt: now }],
    activeJobs: [],
    maxConcurrent: 1,
    lastSequence: 1
  };
  context.pauseNow = false;
  context.getAnalysisQueuePaused = async () => context.pauseNow === true;
  context.withAnalysisQueueMutationLock = async (task) => {
    const result = await task();
    context.pauseNow = true;
    return result;
  };

  context.startedJobs = [];
  await context.reconcileAnalysisQueueState('queue_pause_race');
  assert.strictEqual(context.startedJobs.length, 0, 'Late pause should prevent freshly activated jobs from starting.');
  assert.deepStrictEqual(context.analysisQueueState.activeJobs, []);
  assert.deepStrictEqual(
    context.analysisQueueState.waitingJobs.map((job) => job.runId),
    ['run-late-pause-1'],
    'Late pause should move freshly activated jobs back to waiting.'
  );
}

function buildScenarioContext() {
  const scenarioContext = {
    console,
    Date,
    Promise,
    Map,
    Set,
    ANALYSIS_QUEUE_KIND_ARTICLE: 'article_analysis',
    ANALYSIS_QUEUE_KIND_RESUME_STAGE: 'resume_stage',
    ANALYSIS_TYPE_COMPANY: 'company',
    ANALYSIS_TYPE_PORTFOLIO: 'portfolio',
    CHAT_GPT_HOSTS: new Set([
      'chatgpt.com',
      'www.chatgpt.com',
      'chat.openai.com',
      'www.chat.openai.com'
    ]),
    INVEST_GPT_URL_BASE: 'https://chatgpt.com/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka',
    INVEST_GPT_PATH_BASE: '/g/g-p-69d3b1343e508191a6d2fcd1aa139fb9-iskierka',
    PORTFOLIO_CHAT_URL: 'https://chatgpt.com/g/g-p-69f5df201ec08191bdffe0376f17191e/project',
    PORTFOLIO_GPT_PATH_BASE: '/g/g-p-69f5df201ec08191bdffe0376f17191e',
    ANALYSIS_QUEUE_MAX_CONCURRENT: 1,
    MANUAL_PDF_QUEUE_MAX_CONCURRENCY: 1,
    ANALYSIS_QUEUE_DISPATCH_CONFIRM_TIMEOUT_MS: 5 * 60 * 1000,
    ANALYSIS_QUEUE_LOCAL_CONTEXT_GRACE_MS: 45 * 1000,
    PROCESS_WINDOW_CLOSE_RETRY: {
      enabled: true,
      initialDelayMs: 1500,
      maxDelayMs: 60 * 1000,
      maxAttempts: 24,
      alarmName: 'completed-process-window-close-retry'
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
      lastSequence: 0
    },
    analysisQueueVersion: 0,
    processRegistry: new Map(),
    liveTabs: new Set(),
    windowTabs: new Map(),
    startedJobs: [],
    upserts: [],
    closedRuns: [],
    closeWindowResult: true,
    ensureAnalysisQueueReady: async () => scenarioContext.analysisQueueState,
    ensureProcessRegistryReady: async () => scenarioContext.processRegistry,
    withAnalysisQueueMutationLock: async (task) => task(),
    cloneAnalysisQueueState: () => clone(scenarioContext.analysisQueueState),
    persistAnalysisQueueState: async (state) => {
      scenarioContext.analysisQueueState = clone(state);
      return scenarioContext.analysisQueueState;
    },
    getAnalysisQueueSnapshot: async () => clone(scenarioContext.analysisQueueState),
    countOpenAnalysisChatTabs: async () => 0,
    sanitizeAnalysisQueueJob: (job) => clone(job),
    pruneProcessRecords: (records) => clone(records),
    getTabByIdSafe: async (tabId) => (scenarioContext.liveTabs.has(tabId) ? { id: tabId } : null),
    queryTabsInWindowSafe: async (windowId) => ({
      ok: true,
      tabs: clone(scenarioContext.windowTabs.get(windowId) || [])
    }),
    normalizeProcessWindowCloseState: (value) => (value && typeof value === 'object' ? value : null),
    resolveProcessWindowCloseRetryPlan: (process) => {
      const delivery = scenarioContext.getProcessQueueDeliveryState(process);
      const queueState = typeof process?.queueState === 'string' ? process.queueState.trim() : '';
      const windowClose = scenarioContext.normalizeProcessWindowCloseState(process?.windowClose);
      if (windowClose?.state === 'closed') {
        return { needed: false, reason: 'already_closed', delivery };
      }
      const hasWindowContext = Number.isInteger(process?.tabId) || Number.isInteger(process?.windowId);
      if (queueState === 'awaiting_window_close' || (delivery?.confirmed === true && hasWindowContext)) {
        return { needed: true, reason: 'test_window_close_needed', delivery };
      }
      return { needed: false, reason: 'test_window_close_not_needed', delivery };
    },
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
      return scenarioContext.closeWindowResult !== false;
    },
    reportAnalysisQueueEvent: async () => true,
    runQueuedAnalysisJob: (job, reason) => {
      scenarioContext.startedJobs.push({ runId: job.runId, jobId: job.jobId, reason });
    },
    ensureAnalysisQueuePauseReady: async () => false,
    getAnalysisQueuePaused: async () => false,
    requestAnalysisQueueReconcile: () => {},
    requestRemoteRunnerCycle: () => {}
  };

  const functionNames = [
    'getAnalysisQueueJobPriority',
    'compareAnalysisQueueJobs',
    'sortAnalysisQueueWaitingJobs',
    'normalizeAnalysisTypeForPromptChain',
    'shouldBypassAnalysisQueueForAnalysisType',
    'normalizeProcessLifecycleStatus',
    'normalizeProcessStatus',
    'isClosedProcessStatus',
    'resolveProcessStageSnapshot',
    'hasProcessReachedFinalStage',
    'normalizeWatchlistVerifyState',
    'isExplicitlyVerifiedDispatch',
    'getProcessPersistenceDispatchSnapshot',
    'getProcessQueueDeliveryState',
    'hasProcessCloseableSavedResponse',
    'isProcessWindowAutoCloseEnabled',
    'isDataGapTerminalProcess',
    'shouldHoldAnalysisQueueSlotForWindowClose',
    'shouldAttemptAnalysisQueueWindowClose',
    'buildStaleQueueReleasePatch',
    'getAnalysisQueueCompletionTimestamp',
    'resolveAnalysisQueueDispatchDeadlineAt',
    'getProcessLastActivityTimestamp',
    'getAnalysisQueueProcessContextKey',
    'isInvestGptUrl',
    'isPortfolioGptUrl',
    'isAnalysisGptUrl',
    'getTabEffectiveUrl',
    'getOpenAnalysisChatTabs',
    'countAnalysisTabsById',
    'countOpenAnalysisChatTabs',
    'countAdoptableOpenAnalysisTabsForWaitingResumeJobs',
    'shouldProcessOccupyAnalysisQueueSlot',
    'isProcessWithinAnalysisQueueContextGrace',
    'getAnalysisQueueProcessActivityState',
    'isLocalProcessActiveForQueue',
    'shouldReplaceAnalysisQueueActiveProcess',
    'getAnalysisQueueJobContextKey',
    'shouldReplaceAnalysisQueueActiveJob',
    'collectAnalysisQueueActiveProcesses',
    'getAnalysisQueueStatusSnapshot',
    'resolveAnalysisQueueReleaseDecision',
    'reconcileAnalysisQueueState'
  ];
  return loadScenarioFunctions(scenarioContext, functionNames);
}

function loadScenarioFunctions(scenarioContext, functionNames) {
  scenarioContext.ProcessContractUtils = ProcessContractUtils;
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
  await testOpenAnalysisTabsBlockNewQueueStarts();
  await testOpenAnalysisTabCounterIgnoresGenericChatGptTabs();
  await testResumeJobAdoptsItsOpenTargetAnalysisTab();
  await testOrphanOpenAnalysisTabBlocksAfterConfirmedRelease();
  await testGracePreventsPrematureSlotRelease();
  await testClosedWindowDoesNotConsumeSlot();
  await testReleasedRunningQueueManagedProcessDoesNotConsumeSlot();
  await testPortfolioProcessConsumesSequentialQueueSlot();
  await testCompletedPendingDispatchKeepsSlotReserved();
  await testSavedProcessWithMissingLocalContextKeepsWindowOpen();
  await testSavedProcessWithMissingLocalContextPendingDispatchKeepsSlotReserved();
  await testRestoredPendingDispatchProcessReservesSlotWithoutActiveJob();
  await testRestoredAwaitingWindowCloseProcessReservesSlotWithoutActiveJob();
  await testRestoredConfirmedWindowClosePlanReservesSlotBeforeQueueStateRewrite();
  await testRestoredStaleReleasedAwaitingWindowCloseProcessReservesSlot();
  await testLocalSaveFailureKeepsCompletedProcessWindowOpen();
  await testDuplicateActiveJobsReleaseSupersededContext();
  await testManualPdfJobsRespectDedicatedConcurrencyCap();
  await testPausedQueueKeepsWaitingJobsQueued();
  await testPausedQueueAllowsBypassResumeJobs();
  await testLatePauseRequeuesFreshlyActivatedJobs();
  console.log('analysis queue active slot test: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
