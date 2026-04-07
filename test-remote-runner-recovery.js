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

async function main() {
  const context = {
    console,
    Promise,
    Date,
    Map,
    Set,
    processRegistry: new Map(),
    ISKRA_REMOTE_RUNNER: {
      requestTimeoutMs: 20000
    },
    isClosedProcessStatus: (status) => ['completed', 'failed', 'stopped', 'cancelled'].includes(String(status || '').trim()),
    ensureProcessRegistryReady: async () => true,
    createEmptyAnalysisQueueState: () => ({
      waitingJobs: [],
      activeJobs: [],
      lastSequence: 0
    }),
    getAnalysisQueueStatusSnapshot: async () => ({
      totalJobs: 0,
      queueSize: 0,
      activeJobs: 0
    }),
    getAnalysisQueueSnapshot: async () => ({
      waitingJobs: [],
      activeJobs: []
    }),
    getConfiguredRemoteRunnerIdentity: async () => ({
      runnerId: 'runner-1'
    }),
    getRemoteRunnerStatusViaApi: async (runnerId, options = {}) => {
      context.runnerStatusCalls.push({ runnerId, options });
      return {
        success: true,
        payload: {
          runner: {
            runnerId,
            activeRemoteJobId: 'remote-job-1'
          }
        }
      };
    },
    getRemoteJobViaApi: async (jobId) => {
      context.jobFetchCalls.push(jobId);
      return {
        success: true,
        payload: {
          job: {
            jobId,
            runId: 'run-1',
            runnerId: 'runner-1',
            attemptId: 'attempt-1',
            status: 'claimed',
            promptChainSnapshot: ['prompt a'],
            text: 'manual text'
          }
        }
      };
    },
    enqueueClaimedRemoteJob: async (job) => {
      context.enqueuedJobs.push(job);
      return {
        success: true,
        queueSize: 1
      };
    },
    reportRemoteJobEnqueueFailure: async (job, error) => ({
      error: error?.message || String(error),
      job
    }),
    runnerStatusCalls: [],
    jobFetchCalls: [],
    enqueuedJobs: []
  };

  context.processRegistry.set('run-process-1', {
    id: 'run-process-1',
    status: 'running',
    title: 'Remote active process',
    promptHash: 'sha256:test',
    remote: {
      remoteJobId: 'remote-process-job',
      remoteAttemptId: 'attempt-process-1',
      remoteRunnerId: 'runner-1'
    }
  });

  vm.createContext(context);
  [
    'findRemoteAnalysisQueueJob',
    'findActiveRemoteProcessRecord',
    'buildRemoteQueueJobLikeFromProcess',
    'getRemoteRunnerLocalState',
    'recoverAssignedRemoteJob'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
      filename: 'background.js'
    });
  });

  const localStateWithProcess = await context.getRemoteRunnerLocalState();
  assert.strictEqual(localStateWithProcess.localBusy, true);
  assert.strictEqual(localStateWithProcess.localQueueSize, 1);
  assert.strictEqual(localStateWithProcess.activeRemoteJob.remote.remoteJobId, 'remote-process-job');

  context.processRegistry.clear();

  const recoveryResult = await context.recoverAssignedRemoteJob({
    origin: 'test'
  });

  assert.strictEqual(recoveryResult.success, true);
  assert.strictEqual(recoveryResult.recovered, true);
  assert.strictEqual(recoveryResult.reason, 'assigned_remote_job_recovered');
  assert.strictEqual(context.runnerStatusCalls.length, 1);
  assert.strictEqual(context.jobFetchCalls.length, 1);
  assert.strictEqual(context.enqueuedJobs.length, 1);
  assert.strictEqual(context.enqueuedJobs[0].jobId, 'remote-job-1');
  assert.strictEqual(context.enqueuedJobs[0].attemptId, 'attempt-1');

  console.log('remote runner recovery test: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
