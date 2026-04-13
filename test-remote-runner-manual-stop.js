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
  const context = {
    console,
    Date,
    Promise,
    Map,
    Set,
    upserts: [],
    suppressions: [],
    remoteEvents: [],
    isClosedProcessStatus: () => false,
    upsertProcess: async (runId, patch) => {
      context.upserts.push({ runId, patch: clone(patch) });
      return { id: runId, ...clone(patch) };
    },
    rememberRemoteJobSuppression: async (job, details) => {
      context.suppressions.push({
        job: clone(job),
        details: clone(details)
      });
      return { success: true };
    },
    reportRemoteJobEvent: async (jobId, eventType, attemptId, payload, error) => {
      context.remoteEvents.push({
        jobId,
        eventType,
        attemptId,
        payload: clone(payload),
        error
      });
      return { success: true };
    }
  };

  vm.createContext(context);
  ['buildRemoteJobFailureDetails', 'stopSingleProcess'].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
      filename: 'background.js'
    });
  });

  const process = {
    id: 'run-stop-1',
    status: 'running',
    title: 'Stop me',
    promptHash: 'hash-stop-1',
    remote: {
      remoteJobId: 'remote-job-stop-1',
      remoteAttemptId: 'attempt-stop-1'
    }
  };

  const result = await context.stopSingleProcess(process, {
    reason: 'manual_stop',
    statusText: 'Przerwano przez uzytkownika'
  });

  assert.strictEqual(result, true);
  assert.strictEqual(context.upserts.length, 1);
  assert.strictEqual(context.upserts[0].patch.status, 'stopped');
  assert.strictEqual(context.suppressions.length, 1);
  assert.strictEqual(context.suppressions[0].job.jobId, 'remote-job-stop-1');
  assert.strictEqual(context.suppressions[0].details.reason, 'manual_stop');
  assert.strictEqual(context.remoteEvents.length, 1);
  assert.deepStrictEqual(context.remoteEvents[0], {
    jobId: 'remote-job-stop-1',
    eventType: 'failed',
    attemptId: 'attempt-stop-1',
    payload: {
      failure: {
        statusCode: 'manual_stop',
        reason: 'manual_stop',
        error: 'Przerwano przez uzytkownika'
      },
      queueState: '',
      runId: 'run-stop-1',
      jobId: 'remote-job-stop-1'
    },
    error: 'Przerwano przez uzytkownika'
  });

  console.log('remote runner manual stop test: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
