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
  const paramsStart = source.indexOf('(', startIndex);
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

async function main() {
  const saved = [];
  const auditLogs = [];
  const nowTs = 1_773_918_300_000;
  const context = vm.createContext({
    console,
    Date: createFixedDate(nowTs),
    Math,
    Number,
    String,
    Array,
    JSON,
    Map,
    Set,
    PROCESS_MONITOR_HEARTBEAT: {
      finalPromptRecoveryTtlMs: 10 * 60 * 1000,
      finalPromptRecoveryCooldownMs: 15 * 60 * 1000
    },
    finalPromptRecoveryInFlight: new Set(),
    finalPromptRecoveryLastAttemptAtByRunId: new Map(),
    normalizeProcessLifecycleStatus(value, fallback = 'running') {
      const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
      return normalized || fallback;
    },
    normalizeProcessPhase(value, fallback = '') {
      const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
      return normalized || fallback;
    },
    hasProcessReachedFinalStage: () => false,
    textFingerprint(value = '') {
      return value.length.toString(16).padStart(8, '0');
    },
    buildResponseContractValidation() {
      return { valid: true, kind: 'economist.response.v2' };
    },
    extractLatestStage12InvestmentResponseFromTab: async () => ({
      text: '',
      contract: null,
      scannedCount: 0,
      sourceIndex: null,
      reason: 'not_found'
    }),
    extractLastAssistantResponseFromTab: async () => '{"schema":"economist.response.v2","records":[{"ticker":"ABC","decision":"PRIMARY"}]}',
    normalizeChatConversationUrl(value) {
      return typeof value === 'string' && value.trim() ? value.trim() : '';
    },
    resolveSupportedSourceNameFromUrl() {
      return 'The Economist';
    },
    emitWatchlistDispatchProcessLog(level, code, message, details) {
      auditLogs.push({ level, code, message, details });
    },
    saveResponse: async (...args) => {
      saved.push(args);
      return { success: true };
    }
  });

  [
    'getProcessLastActivityTimestamp',
    'getProcessLastProgressTimestamp',
    'shouldAttemptStaleFinalPromptRecovery',
    'attemptStaleFinalPromptRecovery'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
      filename: 'background.js'
    });
  });

  const process = {
    id: 'run-final',
    status: 'running',
    lifecycleStatus: 'running',
    phase: 'prompt_send',
    currentPrompt: 18,
    totalPrompts: 18,
    stageIndex: 17,
    tabId: 55,
    title: 'Alpha Corp',
    analysisType: 'company',
    sourceUrl: 'https://www.economist.com/test',
    chatUrl: 'https://chatgpt.com/c/test',
    lastProgressAt: nowTs - (11 * 60 * 1000)
  };

  assert.strictEqual(context.shouldAttemptStaleFinalPromptRecovery(process, nowTs), true);
  const result = await context.attemptStaleFinalPromptRecovery(process, 'test', nowTs);

  assert.strictEqual(result.success, true);
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0][0], '{"schema":"economist.response.v2","records":[{"ticker":"ABC","decision":"PRIMARY"}]}');
  assert.strictEqual(saved[0][3], 'run-final');
  assert.strictEqual(saved[0][4], 'run-final_p15_00000054');
  assert.strictEqual(saved[0][5].selected_response_reason, 'stale_final_prompt_stage14_last_message');
  assert.strictEqual(saved[0][5].selected_response_prompt, 15);
  assert.strictEqual(saved[0][6], 'https://chatgpt.com/c/test');
  assert(
    auditLogs.some((entry) => entry.code === 'stale_final_prompt_recovered'),
    'Expected recovery audit log.'
  );

  saved.length = 0;
  const recoveredStage12Json = '{"schema":"economist.response.v2","records":[{"ticker":"XYZ","decision":"PRIMARY"}]}';
  context.extractLatestStage12InvestmentResponseFromTab = async () => ({
    text: recoveredStage12Json,
    contract: {
      valid: true,
      kind: 'economist.response.v2'
    },
    scannedCount: 3,
    sourceIndex: 1,
    reason: 'economist_response_v2'
  });
  context.buildResponseContractValidation = () => ({
    valid: true,
    kind: 'economist.response.v2'
  });
  const stage12HistoryProcess = {
    ...process,
    id: 'run-final-stage14-history',
    currentPrompt: 18,
    totalPrompts: 18,
    stageIndex: 17,
    lastProgressAt: nowTs - (12 * 60 * 1000)
  };

  const historyResult = await context.attemptStaleFinalPromptRecovery(stage12HistoryProcess, 'test', nowTs + 1000);
  assert.strictEqual(historyResult.success, true);
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0][0], recoveredStage12Json);
  assert.strictEqual(saved[0][4], 'run-final-stage14-history_p15_00000054');
  assert.strictEqual(saved[0][5].selected_response_reason, 'stale_final_prompt_stage14_dom_history');
  assert.strictEqual(saved[0][5].selected_response_prompt, 15);
  assert.strictEqual(saved[0][5].selected_response_stage_index, 14);

  console.log('test-stale-final-prompt-recovery.js: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
