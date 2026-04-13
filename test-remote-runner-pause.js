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
    getStoredRemoteRunnerEnabled: async () => true,
    getConfiguredRemoteRunnerIdentity: async () => ({
      runnerId: 'runner-1'
    }),
    getRemoteRunnerLocalState: async () => ({
      localBusy: false,
      queuedRemoteJob: null
    }),
    getAnalysisQueuePaused: async () => true,
    claimCalls: 0,
    enqueueCalls: 0,
    claimRemoteJobViaApi: async () => {
      context.claimCalls += 1;
      return {
        success: true,
        payload: {
          claimed: false,
          reason: 'queue_empty'
        }
      };
    },
    enqueueClaimedRemoteJob: async () => {
      context.enqueueCalls += 1;
      return {
        success: true
      };
    },
    reportRemoteJobEnqueueFailure: async () => ({
      error: 'enqueue_failed'
    })
  };

  vm.createContext(context);
  vm.runInContext(extractFunctionSource(backgroundSource, 'pollAndClaimRemoteJob'), context, {
    filename: 'background.js'
  });

  const result = await context.pollAndClaimRemoteJob({ origin: 'test' });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.skipped, true);
  assert.strictEqual(result.reason, 'queue_paused');
  assert.strictEqual(context.claimCalls, 0, 'Paused queue must not claim another remote job.');
  assert.strictEqual(context.enqueueCalls, 0, 'Paused queue must not enqueue remote work locally.');

  const latePauseContext = {
    console,
    Promise,
    pauseReads: 0,
    claimCalls: 0,
    enqueueCalls: 0,
    getStoredRemoteRunnerEnabled: async () => true,
    getConfiguredRemoteRunnerIdentity: async () => ({
      runnerId: 'runner-1'
    }),
    getRemoteRunnerLocalState: async () => ({
      localBusy: false,
      queuedRemoteJob: null
    }),
    getAnalysisQueuePaused: async () => {
      latePauseContext.pauseReads += 1;
      return latePauseContext.pauseReads >= 2;
    },
    claimRemoteJobViaApi: async () => {
      latePauseContext.claimCalls += 1;
      return {
        success: true,
        payload: {
          claimed: false,
          reason: 'queue_empty'
        }
      };
    },
    enqueueClaimedRemoteJob: async () => {
      latePauseContext.enqueueCalls += 1;
      return {
        success: true
      };
    },
    reportRemoteJobEnqueueFailure: async () => ({
      error: 'enqueue_failed'
    })
  };

  vm.createContext(latePauseContext);
  vm.runInContext(extractFunctionSource(backgroundSource, 'pollAndClaimRemoteJob'), latePauseContext, {
    filename: 'background.js'
  });

  const latePauseResult = await latePauseContext.pollAndClaimRemoteJob({ origin: 'test-late-pause' });
  assert.strictEqual(latePauseResult.success, true);
  assert.strictEqual(latePauseResult.skipped, true);
  assert.strictEqual(latePauseResult.reason, 'queue_paused');
  assert.strictEqual(latePauseContext.claimCalls, 0, 'Late pause should stop claim before request is sent.');
  assert.strictEqual(latePauseContext.enqueueCalls, 0, 'Late pause should not enqueue remote work locally.');

  console.log('remote runner pause test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
