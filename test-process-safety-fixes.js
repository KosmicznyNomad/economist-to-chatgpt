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

function loadFunctionList(context, functionNames) {
  functionNames.forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
      filename: 'background.js'
    });
  });
}

function createTrimProblemLogText(value, maxLength = 260) {
  const safe = typeof value === 'string' ? value.trim() : '';
  if (!safe) return '';
  if (!Number.isInteger(maxLength) || maxLength <= 0 || safe.length <= maxLength) return safe;
  return `${safe.slice(0, Math.max(0, maxLength - 3))}...`;
}

function testHeartbeatProblemLogEntryUsesNeutralStateReason() {
  const nowTs = 1_773_918_050_000;
  const context = {
    console,
    Math,
    Number,
    Date: createFixedDate(nowTs),
    normalizeProcessLifecycleStatus: (value, fallback = 'running') => {
      const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
      return normalized || fallback;
    },
    normalizeProcessActionRequired: (value, fallback = 'none') => {
      const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
      return normalized || fallback;
    },
    deriveProcessActionRequired: (record = {}) => (record?.needsAction === true ? 'manual_resume' : 'none'),
    normalizeProcessStatus: (status) => {
      const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
      return normalized || 'running';
    },
    isFailedProcessStatus: (status) => status === 'failed',
    isClosedProcessStatus: (status) => status === 'completed' || status === 'failed' || status === 'stopped',
    extractProcessChatUrl: () => '',
    normalizeProblemLogSourceUrl: (value) => (typeof value === 'string' ? value.trim() : ''),
    trimProblemLogText: createTrimProblemLogText
  };

  vm.createContext(context);
  loadFunctionList(context, [
    'shouldRecordIssueForProcess',
    'shouldRecordSuccessForProcess',
    'buildProcessSuccessReason',
    'buildProcessSuccessStatusText',
    'buildProcessStateReason',
    'buildProcessStateStatusText',
    'resolveProcessStageSnapshot',
    'buildProcessProblemLogEntry'
  ]);

  const normalEntry = context.buildProcessProblemLogEntry('run-heartbeat', {
    status: 'running',
    currentPrompt: 1,
    totalPrompts: 13,
    timestamp: nowTs
  });
  const heartbeatEntry = context.buildProcessProblemLogEntry('run-heartbeat', {
    status: 'running',
    currentPrompt: 1,
    totalPrompts: 13,
    timestamp: nowTs
  }, { heartbeat: true });

  assert.strictEqual(normalEntry.reason, 'ok_progress');
  assert.strictEqual(heartbeatEntry.reason, 'state_progress');
  assert.strictEqual(heartbeatEntry.heartbeat, true);
  assert.strictEqual(heartbeatEntry.statusText, 'running 1/13');
  assert.strictEqual(heartbeatEntry.signature, normalEntry.signature, 'Heartbeat entries should preserve the canonical signature.');
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

async function testHeartbeatReleasesQueueProcessWithMissingLocalContext() {
  const nowTs = 1_773_918_200_000;
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
      ['run-queue-orphan', {
        id: 'run-queue-orphan',
        status: 'running',
        queueManaged: true,
        queueJobId: 'job-queue-orphan',
        timestamp: nowTs - 120_000,
        lastProgressAt: nowTs - 120_000
      }]
    ]),
    ensureProcessRegistryReady: async () => {},
    pruneProcessRecords: (items) => items,
    isClosedProcessStatus: (status) => status === 'completed' || status === 'failed' || status === 'stopped',
    isQueuedProcessStatus: (status) => status === 'queued',
    getAnalysisQueueProcessActivityState: async () => ({
      active: false,
      live: false,
      recent: false,
      contextKey: 'run:run-queue-orphan',
      reason: 'local_context_missing'
    }),
    buildStaleQueueReleasePatch: async (_process, now) => ({
      status: 'stopped',
      statusText: 'Brak aktywnej lokalnej karty procesu - slot zwolniony',
      reason: 'local_context_missing',
      needsAction: false,
      autoRecovery: null,
      finishedAt: now,
      timestamp: now
    }),
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
  assert.strictEqual(result.released, 1);
  assert.strictEqual(result.staleDetected, 0);
  assert.strictEqual(warnings.length, 0);
  assert.strictEqual(touches.length, 1);
  assert.strictEqual(touches[0].runId, 'run-queue-orphan');
  assert.strictEqual(touches[0].patch.status, 'stopped');
  assert.strictEqual(touches[0].patch.queueState, 'slot_released');
  assert.strictEqual(touches[0].patch.slotReleaseReason, 'local_context_missing');
}

async function testHeartbeatEscalatesLiveQueueProcessToManualResume() {
  const nowTs = 1_773_918_250_000;
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
      staleWarnCooldownMs: 60_000,
      severeRemoteDispatchMs: 15 * 60 * 1000,
      stuckSamePromptMs: 15 * 60 * 1000
    },
    processMonitorHeartbeatSweepInProgress: false,
    processStaleWarnLastEmitTsByRunId: new Map(),
    processRegistry: new Map([
      ['run-stuck-live', {
        id: 'run-stuck-live',
        status: 'running',
        phase: 'response_wait',
        queueManaged: true,
        currentPrompt: 1,
        totalPrompts: 13,
        timestamp: nowTs - 120_000,
        lastProgressAt: nowTs - (16 * 60 * 1000)
      }]
    ]),
    normalizeProcessStatus: (status) => {
      const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
      return normalized || 'running';
    },
    normalizeProcessPhase: (value, fallback = '') => {
      const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
      return normalized || fallback;
    },
    normalizeProcessActionRequired: (value, fallback = 'none') => {
      const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
      return normalized || fallback;
    },
    deriveProcessActionRequired: (record = {}) => (record?.needsAction === true ? 'manual_resume' : 'none'),
    ensureProcessRegistryReady: async () => {},
    pruneProcessRecords: (items) => items,
    isClosedProcessStatus: (status) => status === 'completed' || status === 'failed' || status === 'stopped',
    isQueuedProcessStatus: (status) => status === 'queued',
    getAnalysisQueueProcessActivityState: async () => ({
      active: true,
      live: true,
      recent: false,
      contextKey: 'tab:77',
      reason: 'tab_exists'
    }),
    buildStaleQueueReleasePatch: async () => null,
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
  loadFunctionList(context, [
    'getProcessLastActivityTimestamp',
    'getProcessLastProgressTimestamp',
    'shouldEscalateQueueProcessToManualResume',
    'buildStuckSamePromptPatch',
    'runProcessMonitorHeartbeatSweep'
  ]);

  const result = await context.runProcessMonitorHeartbeatSweep('test');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.escalated, 1);
  assert.strictEqual(result.released, 0);
  assert.strictEqual(warnings.length, 0);
  assert.strictEqual(touches.length, 1);
  assert.strictEqual(touches[0].patch.needsAction, true);
  assert.strictEqual(touches[0].patch.actionRequired, 'manual_resume');
  assert.strictEqual(touches[0].patch.reason, 'stuck_same_prompt');
  assert.strictEqual(touches[0].patch.statusCode, 'process.stuck_same_prompt');
  assert.strictEqual(touches[0].patch.status, 'running');
}

async function testHeartbeatDoesNotEscalateContinueButtonProcess() {
  const nowTs = 1_773_918_300_000;
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
      staleWarnCooldownMs: 60_000,
      severeRemoteDispatchMs: 15 * 60 * 1000,
      stuckSamePromptMs: 15 * 60 * 1000
    },
    processMonitorHeartbeatSweepInProgress: false,
    processStaleWarnLastEmitTsByRunId: new Map(),
    processRegistry: new Map([
      ['run-continue-live', {
        id: 'run-continue-live',
        status: 'running',
        phase: 'response_wait',
        queueManaged: true,
        needsAction: true,
        actionRequired: 'continue_button',
        reason: 'continue_button',
        timestamp: nowTs - 5_000,
        lastProgressAt: nowTs - (16 * 60 * 1000)
      }]
    ]),
    normalizeProcessStatus: (status) => {
      const normalized = typeof status === 'string' ? status.trim().toLowerCase() : '';
      return normalized || 'running';
    },
    normalizeProcessPhase: (value, fallback = '') => {
      const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
      return normalized || fallback;
    },
    normalizeProcessActionRequired: (value, fallback = 'none') => {
      const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
      return normalized || fallback;
    },
    deriveProcessActionRequired: (record = {}) => (record?.needsAction === true ? 'manual_resume' : 'none'),
    ensureProcessRegistryReady: async () => {},
    pruneProcessRecords: (items) => items,
    isClosedProcessStatus: (status) => status === 'completed' || status === 'failed' || status === 'stopped',
    isQueuedProcessStatus: (status) => status === 'queued',
    getAnalysisQueueProcessActivityState: async () => ({
      active: true,
      live: true,
      recent: false,
      contextKey: 'tab:78',
      reason: 'tab_exists'
    }),
    buildStaleQueueReleasePatch: async () => null,
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
  loadFunctionList(context, [
    'getProcessLastActivityTimestamp',
    'getProcessLastProgressTimestamp',
    'shouldEscalateQueueProcessToManualResume',
    'buildStuckSamePromptPatch',
    'runProcessMonitorHeartbeatSweep'
  ]);

  const result = await context.runProcessMonitorHeartbeatSweep('test');
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.escalated, 0);
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
  testHeartbeatProblemLogEntryUsesNeutralStateReason();
  await testHeartbeatUsesRealProgressTimestamp();
  await testHeartbeatStillFlagsOldProgressWhenRecordWasTouched();
  await testHeartbeatReleasesQueueProcessWithMissingLocalContext();
  await testHeartbeatEscalatesLiveQueueProcessToManualResume();
  await testHeartbeatDoesNotEscalateContinueButtonProcess();
  testCompanyAuditFrontierSkipsFuturePrompts();
  console.log('test-process-safety-fixes: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
