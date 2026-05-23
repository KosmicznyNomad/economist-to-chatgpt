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
  let parenDepth = 0;
  let braceStart = -1;
  for (let index = match.index; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') {
      parenDepth += 1;
      continue;
    }
    if (char === ')') {
      parenDepth -= 1;
      continue;
    }
    if (char === '{' && parenDepth === 0) {
      braceStart = index;
      break;
    }
  }
  if (braceStart === -1) {
    throw new Error(`Function body not found: ${functionName}`);
  }

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

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
  const saveCalls = [];
  const context = vm.createContext({
    console,
    Number,
    String,
    Array,
    JSON,
    Date,
    Math,
    resolveCompletedProcessFinalResponseText: async () => ({
      success: true,
      responseText: 'VALID FINAL RESPONSE'
    }),
    getCompletedProcessLocalSaveState() {
      return false;
    },
    hasCompletedProcessLocalSave() {
      return false;
    },
    extractResponseIdFromCopyTrace() {
      return '';
    },
    buildRestartReplayResponseId(runId) {
      return `${runId}-replay-response`;
    },
    normalizeChatConversationUrl(value) {
      return typeof value === 'string' ? value.trim() : '';
    },
    resolveSupportedSourceNameFromUrl() {
      return 'ChatGPT Invest';
    },
    saveResponse: async (...args) => {
      saveCalls.push(args);
      return {
        success: true,
        copyTrace: 'trace/run-focused/run-focused-replay-response',
        dispatch: {
          state: 'dispatch_pending',
          accepted: 1,
          sent: 1,
          failed: 0,
          deferred: 0,
          remaining: 1,
          verifyState: 'http_accepted'
        },
        dispatchProcessLog: [],
        conversationAnalysis: {
          conversationLogCount: 2
        }
      };
    },
    formatDispatchUiSummary(dispatch) {
      return dispatch?.accepted === 1 ? 'accepted=1' : '';
    }
  });

  vm.runInContext(extractFunctionSource(backgroundSource, 'replayCompletedResponseForProcess'), context);

  const result = await context.replayCompletedResponseForProcess({
    id: 'run-focused',
    title: 'Focused replay',
    analysisType: 'company',
    currentPrompt: 15,
    stageIndex: 14,
    sourceUrl: 'https://chatgpt.com/c/run-focused',
    chatUrl: 'https://chatgpt.com/c/run-focused'
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(saveCalls.length, 1);
  assert.strictEqual(saveCalls[0][3], 'run-focused');
  assert.strictEqual(saveCalls[0][4], 'run-focused-replay-response');
  assert.ok(saveCalls[0][8] && typeof saveCalls[0][8] === 'object', 'saveResponse should receive options');
  assert.strictEqual(saveCalls[0][8].dispatchFlushFocus.runId, 'run-focused');
  assert.strictEqual(saveCalls[0][8].dispatchFlushFocus.responseId, 'run-focused-replay-response');
  assert.strictEqual(saveCalls[0][8].dispatchFlushFocus.forceMatchingReady, true);
  assert.strictEqual(saveCalls[0][8].dispatchFlushFocus.prioritizeMatching, true);

  console.log('test-replay-completed-response-focused-flush.js: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
