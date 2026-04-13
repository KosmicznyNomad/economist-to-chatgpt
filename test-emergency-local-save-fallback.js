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

async function main() {
  const setCalls = [];
  const queuedPayloads = [];
  const context = {
    console,
    Promise,
    runId: 'run-1',
    sourceTitleForSave: 'Article title',
    articleTitle: 'Article title',
    analysisType: 'company',
    sourceNameForSave: 'Economist',
    sourceUrlForSave: 'https://example.com/article',
    location: {
      href: 'https://chatgpt.com/c/test'
    },
    buildInjectedResponseId: () => 'generated-response-id',
    buildCopyTrace: (runId, responseId) => `${runId || 'no-run'}/${responseId || 'no-response'}`,
    normalizeWatchlistDispatchPayload: (payload) => ({
      ...payload,
      schema: 'dispatch.v1'
    }),
    applyChatGptComputationStatePatch(target, source) {
      if (!target || typeof target !== 'object' || !source || typeof source !== 'object') {
        return target;
      }
      Object.assign(target, source);
      return target;
    },
    detectChatGptComputationState: () => ({
      composerThinkingEffort: 'heavy',
      chatGptModeKind: 'thinking',
      chatGptModelSwitcherLabel: 'ChatGPT Pro',
      chatGptThinkingEffortDetected: 'heavy',
      chatGptComputationLabel: 'ChatGPT Pro | Thinking | Heavy',
      chatGptComputationDetectedAt: 1_710_000_123_456
    }),
    enqueueWatchlistDispatchPayload: async (payload, trace) => {
      queuedPayloads.push({ payload, trace });
      return {
        queued: true,
        queueSize: 3
      };
    },
    chrome: {
      storage: {
        local: {
          get: async () => ({
            responses: []
          }),
          set: async (payload) => {
            setCalls.push(payload);
          }
        },
        session: {}
      }
    },
    ResponseStorageUtils: null,
    DecisionContractUtils: null,
    globalThis: null
  };
  context.globalThis = context;

  vm.createContext(context);
  vm.runInContext(extractFunctionSource(backgroundSource, 'persistResponseViaLocalEmergencyFallback'), context, {
    filename: 'background.js'
  });

  const result = await context.persistResponseViaLocalEmergencyFallback(
    'Final response text',
    'resp-1',
    {
      selected_response_prompt: 7
    }
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.outboxQueued, true);
  assert.strictEqual(result.queueSize, 3);
  assert.strictEqual(queuedPayloads.length, 1, 'Emergency fallback should use shared outbox enqueue helper.');
  assert.strictEqual(queuedPayloads[0].payload.composerThinkingEffort, 'heavy');
  assert.strictEqual(queuedPayloads[0].payload.chatGptModeKind, 'thinking');
  assert.strictEqual(queuedPayloads[0].payload.chatGptModelSwitcherLabel, 'ChatGPT Pro');
  assert.strictEqual(queuedPayloads[0].payload.chatGptComputationLabel, 'ChatGPT Pro | Thinking | Heavy');
  assert.strictEqual(
    setCalls.some((payload) => Object.prototype.hasOwnProperty.call(payload, 'watchlist_dispatch_outbox')),
    false,
    'Emergency fallback must not overwrite dispatch outbox directly.'
  );

  console.log('emergency local save fallback test: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
