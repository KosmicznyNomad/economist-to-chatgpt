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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function main() {
  const buildContext = () => {
    const scenarioContext = {
      console,
      Date,
      Promise,
      Map,
      Set,
      analysisQueueState: {
        waitingJobs: [
          {
            jobId: 'aq-remote-1',
            runId: 'run-remote-1',
            remote: {
              remoteJobId: 'remote-job-1',
              remoteAttemptId: 'attempt-1'
            }
          }
        ]
      },
      processRegistry: new Map(),
      reportedEvents: [],
      rememberedSuppressions: [],
      upserts: [],
      ensureAnalysisQueueReady: async () => scenarioContext.analysisQueueState,
      withAnalysisQueueMutationLock: async (task) => task(),
      cloneAnalysisQueueState: () => clone(scenarioContext.analysisQueueState),
      persistAnalysisQueueState: async (state) => {
        scenarioContext.analysisQueueState = clone(state);
        return scenarioContext.analysisQueueState;
      },
      sortAnalysisQueueWaitingJobs: (jobs) => jobs,
      upsertProcess: async (runId, patch) => {
        scenarioContext.upserts.push({ runId, patch: clone(patch) });
        return { id: runId, ...clone(patch) };
      },
      reportRemoteJobEvent: async (jobId, eventType, attemptId, payload, error) => {
        scenarioContext.reportedEvents.push({
          jobId,
          eventType,
          attemptId,
          payload: clone(payload),
          error
        });
        return { success: true };
      },
      rememberRemoteJobSuppression: async (job, details) => {
        scenarioContext.rememberedSuppressions.push({
          jobId: job?.remote?.remoteJobId || job?.jobId || '',
          reason: details?.reason || ''
        });
        return { success: true };
      },
      reconcileAnalysisQueueState: async () => ({ success: true }),
      getAnalysisQueueStatusSnapshot: async () => ({
        queueSize: scenarioContext.analysisQueueState.waitingJobs.length,
        activeSlots: 0
      })
    };
    return scenarioContext;
  };

  let context = buildContext();

  vm.createContext(context);
  ['buildRemoteJobFailureDetails', 'cancelQueuedAnalysisJobs'].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
      filename: 'background.js'
    });
  });

  const result = await context.cancelQueuedAnalysisJobs(() => true, {
    reason: 'stop_window_queued_cancelled',
    statusText: 'Anulowano oczekujace joby'
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.cancelledCount, 1);
  assert.strictEqual(context.reportedEvents.length, 1);
  assert.deepStrictEqual(context.reportedEvents[0], {
    jobId: 'remote-job-1',
    eventType: 'failed',
    attemptId: 'attempt-1',
    payload: {
      failure: {
        statusCode: 'stop_window_queued_cancelled',
        reason: 'stop_window_queued_cancelled',
        error: 'Anulowano oczekujace joby'
      },
      queueState: '',
      runId: 'run-remote-1',
      jobId: 'aq-remote-1'
    },
    error: 'Anulowano oczekujace joby'
  });
  assert.strictEqual(context.analysisQueueState.waitingJobs.length, 0);
  assert.strictEqual(context.upserts.length, 1);
  assert.strictEqual(context.upserts[0].patch.status, 'cancelled');
  assert.strictEqual(context.rememberedSuppressions.length, 1);

  context = buildContext();
  context.upsertProcess = async () => {
    throw new Error('upsert_failed');
  };
  vm.createContext(context);
  ['buildRemoteJobFailureDetails', 'cancelQueuedAnalysisJobs'].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
      filename: 'background.js'
    });
  });
  const failedResult = await context.cancelQueuedAnalysisJobs(() => true, {
    reason: 'stop_window_queued_cancelled',
    statusText: 'Anulowano oczekujace joby'
  });
  assert.strictEqual(failedResult.success, false);
  assert.strictEqual(failedResult.cancelledCount, 0);
  assert.strictEqual(failedResult.requeuedCount, 1);
  assert.strictEqual(context.analysisQueueState.waitingJobs.length, 1, 'Failed cancellation should restore the queued job.');
  assert.strictEqual(context.reportedEvents.length, 0, 'Failed local cancellation must not report remote failure.');

  console.log('analysis queue remote cancel test: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
