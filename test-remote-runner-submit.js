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

function buildContext(overrides = {}) {
  const context = {
    console,
    createCalls: [],
    getRemoteRunnerStatusViaApi: async () => ({
      success: true,
      payload: {
        runner: {
          runnerId: 'runner-1',
          state: 'ready',
          queueable: true
        }
      }
    }),
    createRemoteJobViaApi: async (payload) => {
      context.createCalls.push(payload);
      return {
        success: true,
        payload: {
          success: true,
          created: true,
          idempotent: false,
          job: {
            jobId: payload.jobId,
            runnerId: payload.runnerId,
            status: 'queued'
          }
        }
      };
    },
    ...overrides
  };

  vm.createContext(context);
  vm.runInContext(extractFunctionSource(backgroundSource, 'submitPreparedAnalysisBatchToRemoteRunner'), context, {
    filename: 'background.js'
  });
  return context;
}

async function testRejectsBusyRunnerBeforeSubmittingJobs() {
  const context = buildContext({
    getRemoteRunnerStatusViaApi: async () => ({
      success: true,
      payload: {
        runner: {
          runnerId: 'runner-1',
          state: 'busy',
          queueable: false,
          reason: 'local_busy'
        }
      }
    })
  });

  const result = await context.submitPreparedAnalysisBatchToRemoteRunner({
    items: [
      { jobId: 'job-1', runId: 'run-1' },
      { jobId: 'job-2', runId: 'run-2' }
    ],
    skipped: []
  }, 'runner-1');

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error, 'runner_busy');
  assert.strictEqual(result.submittedCount, 0);
  assert.strictEqual(result.failedCount, 2);
  assert.strictEqual(context.createCalls.length, 0);
}

async function testSubmitsBatchWhenRunnerReady() {
  const context = buildContext();
  const result = await context.submitPreparedAnalysisBatchToRemoteRunner({
    batchId: 'batch-1',
    submissionId: 'submit-1',
    items: [
      { jobId: 'job-1', runId: 'run-1' },
      { jobId: 'job-2', runId: 'run-2' }
    ],
    skipped: [{ title: 'Skipped source' }]
  }, 'runner-1');

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.runnerId, 'runner-1');
  assert.strictEqual(result.submittedCount, 2);
  assert.strictEqual(result.createdCount, 2);
  assert.strictEqual(result.failedCount, 0);
  assert.strictEqual(result.skippedCount, 1);
  assert.strictEqual(context.createCalls.length, 2);
  assert.strictEqual(context.createCalls[0].runnerId, 'runner-1');
  assert.strictEqual(context.createCalls[1].runnerId, 'runner-1');
}

async function main() {
  await testRejectsBusyRunnerBeforeSubmittingJobs();
  await testSubmitsBatchWhenRunnerReady();
  console.log('remote runner submit test: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
