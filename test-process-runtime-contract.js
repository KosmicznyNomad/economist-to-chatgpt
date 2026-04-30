const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DecisionContractUtils = require('./decision-contract.js');

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

function makeCurrent16Line(role, company) {
  return [
    '2026-03-20',
    'WATCH',
    role,
    company,
    'THESIS_SOURCE example',
    `${company} thesis text`,
    'Bear_TOTAL: 10',
    'Base_TOTAL: 20',
    'Bull_TOTAL: 30',
    'VOI: backlog > 10%, Fals: churn > 5%, Primary risk: pricing reset, Composite: 4.2/5.0, EntryScore: 8.1/10, Sizing: 3%',
    'Technology',
    'Technology',
    'Software',
    'Subscription',
    'USA',
    'USD',
    'FQ:8,TE:7,CM:9,VS:6,TQ:7,PP:8,CP:5,CD:7,NO:8,MR:6'
  ].join('; ');
}

const context = {
  console,
  DecisionContractUtils,
  isClosedProcessStatus(status) {
    return status === 'completed' || status === 'failed' || status === 'stopped';
  },
  normalizeProcessActionRequired(value, fallback = 'none') {
    const normalized = typeof value === 'string' && value.trim() ? value.trim() : '';
    return normalized || fallback || 'none';
  },
  deriveProcessActionRequired(process = {}) {
    if (typeof process?.actionRequired === 'string' && process.actionRequired.trim()) {
      return process.actionRequired.trim();
    }
    return process?.needsAction ? 'manual_resume' : 'none';
  }
};

vm.createContext(context);
[
  'shouldFlushProcessUpdateImmediately',
  'buildCompletedStage12Snapshot'
].forEach((functionName) => {
  vm.runInContext(extractFunctionSource(backgroundSource, functionName), context);
});

function testBatchedHeartbeatDoesNotForceFlush() {
  const shouldFlush = context.shouldFlushProcessUpdateImmediately(
    {
      lifecycleStatus: 'running',
      currentPrompt: 4,
      queueState: 'active',
      actionRequired: 'none'
    },
    {
      lifecycleStatus: 'running',
      currentPrompt: 4,
      queueState: 'active',
      actionRequired: 'none'
    },
    {}
  );

  assert.strictEqual(shouldFlush, false);
}

function testPromptCheckpointAndFinalizingDoForceFlush() {
  assert.strictEqual(
    context.shouldFlushProcessUpdateImmediately(
      { lifecycleStatus: 'running', currentPrompt: 4, queueState: 'active', actionRequired: 'none' },
      { lifecycleStatus: 'running', currentPrompt: 5, queueState: 'active', actionRequired: 'none' },
      {}
    ),
    true
  );

  assert.strictEqual(
    context.shouldFlushProcessUpdateImmediately(
      { lifecycleStatus: 'running', currentPrompt: 15, queueState: 'active', actionRequired: 'none' },
      { lifecycleStatus: 'finalizing', currentPrompt: 15, queueState: 'active', actionRequired: 'none' },
      {}
    ),
    false
  );

  assert.strictEqual(
    context.shouldFlushProcessUpdateImmediately(
      { lifecycleStatus: 'finalizing', currentPrompt: 15, queueState: 'active', actionRequired: 'none' },
      { lifecycleStatus: 'completed', currentPrompt: 15, queueState: 'active', actionRequired: 'none' },
      {}
    ),
    true
  );
}

function testActionRequiredAndQueuePatchForceFlush() {
  assert.strictEqual(
    context.shouldFlushProcessUpdateImmediately(
      { lifecycleStatus: 'running', currentPrompt: 3, queueState: 'active', actionRequired: 'none' },
      { lifecycleStatus: 'running', currentPrompt: 3, queueState: 'active', actionRequired: 'continue_button' },
      {}
    ),
    true
  );

  assert.strictEqual(
    context.shouldFlushProcessUpdateImmediately(
      { lifecycleStatus: 'queued', currentPrompt: 0, queueState: 'waiting', actionRequired: 'none' },
      { lifecycleStatus: 'queued', currentPrompt: 0, queueState: 'waiting', actionRequired: 'none' },
      { queuePosition: 2 }
    ),
    true
  );
}

function testStage12SnapshotUsesDecisionContract() {
  const snapshot = context.buildCompletedStage12Snapshot(
    [
      makeCurrent16Line('PRIMARY', 'Alpha Corp (ALP)'),
      makeCurrent16Line('SECONDARY', 'Beta Corp (BET)')
    ].join('\n'),
    'Fallback Source'
  );

  assert(snapshot);
  assert.strictEqual(snapshot.status, 'current');
  assert.strictEqual(snapshot.recordCount, 2);
  assert.strictEqual(snapshot.hasDecisionRecord, true);
  assert.strictEqual(snapshot.company, 'Fallback Source');
  assert.strictEqual(snapshot.records[0].decisionRole, 'PRIMARY');
  assert(Array.isArray(snapshot.recordFormats));
}

function main() {
  testBatchedHeartbeatDoesNotForceFlush();
  testPromptCheckpointAndFinalizingDoForceFlush();
  testActionRequiredAndQueuePatchForceFlush();
  testStage12SnapshotUsesDecisionContract();
  console.log('test-process-runtime-contract.js passed');
}

main();
