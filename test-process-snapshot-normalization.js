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
  let parenDepth = 0;
  let braceStart = -1;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

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

const context = {
  console,
  Date,
  Map,
  Set,
  ProcessContractUtils,
  analysisQueueState: { waitingJobs: [] },
  normalizePromptCounters(_status, currentPrompt, totalPrompts, stageIndex) {
    return {
      currentPrompt: Number.isInteger(currentPrompt) ? currentPrompt : 0,
      totalPrompts: Number.isInteger(totalPrompts) ? totalPrompts : 0,
      stageIndex: Number.isInteger(stageIndex) ? stageIndex : null
    };
  },
  normalizeChatConversationUrl(value) {
    return typeof value === 'string' ? value.trim() : '';
  },
  normalizeConversationUrlList(values) {
    return Array.isArray(values)
      ? values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim())
      : [];
  },
  normalizeSourceUrl(value) {
    return typeof value === 'string' ? value.trim() : '';
  },
  normalizeAnalysisQueueTabId(value) {
    return Number.isInteger(value) ? value : null;
  },
  normalizeAnalysisQueueWindowId(value) {
    return Number.isInteger(value) ? value : null;
  },
  normalizeCompanyStageIdentifier(value) {
    return typeof value === 'string' ? value.trim() : '';
  },
  normalizeAutoRecoveryState(value) {
    return value && typeof value === 'object' ? { ...value } : null;
  }
};

vm.createContext(context);
[
  'normalizeProcessLifecycleStatus',
  'normalizeProcessPhase',
  'normalizeProcessActionRequired',
  'deriveProcessActionRequired',
  'deriveProcessStatusCode',
  'buildOperatorStatusText',
  'normalizeProcessStatus',
  'isClosedProcessStatus',
  'normalizeProcessRecord',
  'applyQueuePositionsToProcesses'
].forEach((functionName) => {
  vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
    filename: 'background.js'
  });
});

function testNormalizeProcessRecordBackfillsLegacyFields() {
  const normalized = context.normalizeProcessRecord({
    id: 'run-1',
    status: 'error',
    reason: 'textarea_not_found',
    needsAction: true,
    timestamp: 1000
  });

  assert(normalized);
  assert.strictEqual(normalized.lifecycleStatus, 'failed');
  assert.strictEqual(normalized.status, 'failed');
  assert.strictEqual(normalized.actionRequired, 'none');
  assert.strictEqual(normalized.needsAction, false);
  assert.strictEqual(normalized.statusCode, 'chat.editor_not_found');
  assert.strictEqual(normalized.lastActivityAt, 1000);
  assert.strictEqual(normalized.phaseStartedAt, 1000);
  assert.strictEqual(normalized.version, 1);
}

function testNormalizeProcessRecordPreservesOpenActionRequired() {
  const normalized = context.normalizeProcessRecord({
    id: 'run-2',
    status: 'running',
    statusText: 'Continue button visible',
    timestamp: 2000
  });

  assert.strictEqual(normalized.lifecycleStatus, 'running');
  assert.strictEqual(normalized.actionRequired, 'continue_button');
  assert.strictEqual(normalized.needsAction, true);
  assert.strictEqual(normalized.statusCode, 'chat.continue_button');
}

function testApplyQueuePositionsToProcessesAddsAndClearsPositions() {
  const records = [
    { id: 'run-a', title: 'A' },
    { id: 'run-b', title: 'B', queuePosition: 9 }
  ];
  const applied = context.applyQueuePositionsToProcesses(records, {
    waitingJobs: [
      { runId: 'run-a' }
    ]
  });

  assert.strictEqual(applied[0].queuePosition, 1);
  assert.strictEqual('queuePosition' in applied[1], false);
}

function main() {
  testNormalizeProcessRecordBackfillsLegacyFields();
  testNormalizeProcessRecordPreservesOpenActionRequired();
  testApplyQueuePositionsToProcessesAddsAndClearsPositions();
  console.log('test-process-snapshot-normalization.js passed');
}

main();
