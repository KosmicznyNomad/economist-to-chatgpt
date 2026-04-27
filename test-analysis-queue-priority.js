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

function createArticleJob(runId, sequence, createdAt, tabId) {
  return {
    jobId: `aq-${runId}`,
    runId,
    kind: 'article_analysis',
    sequence,
    createdAt,
    analysisType: 'company',
    title: runId,
    tabSnapshot: {
      id: tabId,
      title: runId,
      url: `https://example.com/${runId}`
    }
  };
}

function createResumeJob(runId, sequence, createdAt, tabId, startIndex) {
  return {
    jobId: `aq-${runId}`,
    runId,
    kind: 'resume_stage',
    sequence,
    createdAt,
    analysisType: 'company',
    title: runId,
    resumeTargetTabId: tabId,
    resumeTargetWindowId: tabId + 1000,
    resumeStartIndex: startIndex
  };
}

function buildPriorityContext() {
  const context = {
    console,
    Date,
    Promise,
    Map,
    Set,
    ProcessContractUtils,
    ANALYSIS_QUEUE_KIND_ARTICLE: 'article_analysis',
    ANALYSIS_QUEUE_KIND_RESUME_STAGE: 'resume_stage',
    ANALYSIS_QUEUE_MAX_CONCURRENT: 7,
    ANALYSIS_QUEUE_DISPATCH_CONFIRM_TIMEOUT_MS: 5 * 60 * 1000,
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
    analysisQueueVersion: 0,
    processRegistry: new Map(),
    startedJobs: [],
    upserts: [],
    closedRuns: [],
    sanitizeManualPdfAttachmentContext: () => null,
    sanitizePromptChainSnapshot: (value) => Array.isArray(value)
      ? value.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
      : [],
    sanitizeRemoteAnalysisQueueJobMetadata: (value) => {
      if (!value || typeof value !== 'object') return null;
      const remoteJobId = typeof value.remoteJobId === 'string'
        ? value.remoteJobId.trim()
        : (typeof value.jobId === 'string' ? value.jobId.trim() : '');
      if (!remoteJobId) return null;
      return {
        remoteJobId,
        remoteAttemptId: typeof value.remoteAttemptId === 'string'
          ? value.remoteAttemptId.trim()
          : (typeof value.attemptId === 'string' ? value.attemptId.trim() : ''),
        remoteRunnerId: typeof value.remoteRunnerId === 'string'
          ? value.remoteRunnerId.trim()
          : '',
        controllerId: typeof value.controllerId === 'string' ? value.controllerId.trim() : '',
        batchId: typeof value.batchId === 'string' ? value.batchId.trim() : '',
        submissionId: typeof value.submissionId === 'string' ? value.submissionId.trim() : ''
      };
    },
    ensureAnalysisQueueReady: async () => context.analysisQueueState,
    ensureProcessRegistryReady: async () => context.processRegistry,
    withAnalysisQueueMutationLock: async (task) => task(),
    cloneAnalysisQueueState: () => clone(context.analysisQueueState),
    getAnalysisQueueSnapshot: async () => clone(context.analysisQueueState),
    persistAnalysisQueueState: async (state) => {
      context.analysisQueueState = clone(state);
      return context.analysisQueueState;
    },
    pruneProcessRecords: (records) => clone(records),
    getTabByIdSafe: async () => null,
    queryTabsInWindowSafe: async () => ({ ok: true, tabs: [] }),
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
    ensureAnalysisQueuePauseReady: async () => false,
    getAnalysisQueuePaused: async () => false,
    requestAnalysisQueueReconcile: () => {},
    requestRemoteRunnerCycle: () => {},
    buildStaleQueueReleasePatch: async () => null,
    runQueuedAnalysisJob: (job, reason) => {
      context.startedJobs.push({ runId: job.runId, jobId: job.jobId, reason });
    }
  };

  const functionNames = [
    'sanitizeManualTextSourceId',
    'sanitizeManualTextSourceRecord',
    'buildManualTextSourceRecord',
    'sanitizeManualTextSourceRecords',
    'collectManualTextSourceIdsFromJobs',
    'pruneManualTextSourcesForJobs',
    'generateManualTextSourceId',
    'mergeManualTextSourceRecords',
    'compactManualTextSnapshotsForQueueState',
    'sanitizeAnalysisQueueTabSnapshot',
    'sanitizeAnalysisQueueJob',
    'getAnalysisQueueJobPriority',
    'compareAnalysisQueueJobs',
    'sortAnalysisQueueWaitingJobs',
    'sanitizeAnalysisQueueState',
    'normalizeProcessLifecycleStatus',
    'normalizeProcessStatus',
    'isClosedProcessStatus',
    'resolveProcessStageSnapshot',
    'hasProcessReachedFinalStage',
    'normalizeWatchlistVerifyState',
    'isExplicitlyVerifiedDispatch',
    'getProcessPersistenceDispatchSnapshot',
    'getProcessQueueDeliveryState',
    'getAnalysisQueueCompletionTimestamp',
    'resolveAnalysisQueueDispatchDeadlineAt',
    'getProcessLastActivityTimestamp',
    'getAnalysisQueueProcessContextKey',
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

  vm.createContext(context);
  for (const functionName of functionNames) {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
      filename: 'background.js'
    });
  }
  return context;
}

function testSanitizeRestoresPriorityOrderAndLastSequence() {
  const context = buildPriorityContext();
  const state = context.sanitizeAnalysisQueueState({
    waitingJobs: [
      createArticleJob('article-1', 1, 100, 1),
      createResumeJob('resume-1', 3, 300, 101, 4),
      createArticleJob('article-2', 2, 200, 2),
      createResumeJob('resume-2', 4, 400, 102, 5)
    ],
    activeJobs: [
      createArticleJob('active-1', 7, 700, 7)
    ],
    lastSequence: 2
  });

  assert.deepStrictEqual(
    clone(state.waitingJobs.map((job) => job.runId)),
    ['resume-1', 'resume-2', 'article-1', 'article-2'],
    'Sanitized queue should place resume jobs before article jobs while keeping FIFO within each type.'
  );
  assert.strictEqual(
    state.lastSequence,
    7,
    'Sanitized queue should preserve the highest observed sequence even when stored lastSequence is stale.'
  );
}

async function testReconcileStartsResumesBeforeArticles() {
  const context = buildPriorityContext();
  const now = Date.now();
  context.analysisQueueState = {
    waitingJobs: [
      createArticleJob('article-1', 1, now - 5000, 1),
      createArticleJob('article-2', 2, now - 4000, 2),
      createResumeJob('resume-1', 3, now - 3000, 101, 4),
      createResumeJob('resume-2', 4, now - 2000, 102, 5),
      createResumeJob('resume-3', 5, now - 1000, 103, 6)
    ],
    activeJobs: [],
    maxConcurrent: 4,
    lastSequence: 5
  };

  await context.reconcileAnalysisQueueState('priority_mix');

  assert.deepStrictEqual(
    clone(context.startedJobs.map((job) => job.runId)),
    ['resume-1', 'resume-2', 'resume-3', 'article-1'],
    'Reconcile should dispatch queued resumes before older article jobs.'
  );
  assert.deepStrictEqual(
    clone(context.analysisQueueState.activeJobs.map((job) => job.runId)),
    ['resume-1', 'resume-2', 'resume-3', 'article-1']
  );
  assert.deepStrictEqual(
    clone(context.analysisQueueState.waitingJobs.map((job) => job.runId)),
    ['article-2']
  );
}

async function testReconcileKeepsArticleFifoWithoutResumes() {
  const context = buildPriorityContext();
  const now = Date.now();
  context.analysisQueueState = {
    waitingJobs: [
      createArticleJob('article-2', 2, now - 2000, 2),
      createArticleJob('article-1', 1, now - 3000, 1),
      createArticleJob('article-3', 3, now - 1000, 3)
    ],
    activeJobs: [],
    maxConcurrent: 2,
    lastSequence: 3
  };

  await context.reconcileAnalysisQueueState('article_fifo');

  assert.deepStrictEqual(
    clone(context.startedJobs.map((job) => job.runId)),
    ['article-1', 'article-2'],
    'Without queued resumes, article jobs should keep FIFO ordering.'
  );
  assert.deepStrictEqual(
    clone(context.analysisQueueState.waitingJobs.map((job) => job.runId)),
    ['article-3']
  );
}

async function main() {
  testSanitizeRestoresPriorityOrderAndLastSequence();
  await testReconcileStartsResumesBeforeArticles();
  await testReconcileKeepsArticleFifoWithoutResumes();
  console.log('analysis queue priority test: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
