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

function loadFunctions(functionNames) {
  const context = {
    console,
    Date,
    Map,
    WATCHLIST_DISPATCH: { outboxMaxItems: 200 },
    isLowSignalProblemLogPayload: () => false,
    normalizeWatchlistIntakeUrl: (value) => (typeof value === 'string' ? value.trim() : ''),
    truncateDispatchLogText: (value, maxLength = 240) => {
      const text = typeof value === 'string' ? value : '';
      return text.length > maxLength ? text.slice(0, maxLength) : text;
    },
    textFingerprint: (value) => String(value || '')
  };
  vm.createContext(context);
  functionNames.forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
      filename: 'background.js'
    });
  });
  return context;
}

function testAcceptedDuplicatePreservesAcceptedState() {
  const context = loadFunctions([
    'getWatchlistOutboxDedupKey',
    'normalizeWatchlistEventId',
    'normalizeWatchlistVerifyState',
    'normalizeWatchlistOutboxPositiveInt',
    'normalizeWatchlistOutboxNonNegativeInt',
    'rankWatchlistOutboxItem',
    'choosePreferredWatchlistOutboxItem',
    'mergeWatchlistOutboxItems',
    'sanitizeWatchlistOutbox'
  ]);
  const now = Date.now();
  const items = context.sanitizeWatchlistOutbox([
    {
      payload: { responseId: 'resp-accepted', text: 'accepted payload' },
      queuedAt: now - 5000,
      attemptCount: 1,
      nextAttemptAt: now + 3000,
      lastError: 'http_timeout',
      deliveryAcceptedAt: now - 4000,
      deliveryEventId: 77,
      deliveryRequestId: 'req-77',
      deliveryIntakeUrl: 'https://watchlist.example/intake',
      verifyState: 'materialization_pending',
      verifyReason: 'materialization_pending',
      verifyAttemptCount: 2,
      verifyLastCheckedAt: now - 1000,
      verifyLastError: 'pending',
      verifiedAt: 0,
      materializedRowCount: 1
    },
    {
      payload: { responseId: 'resp-accepted', text: 'fresh duplicate payload' },
      queuedAt: now - 1000,
      attemptCount: 0,
      nextAttemptAt: 0,
      lastError: '',
      deliveryAcceptedAt: 0,
      deliveryEventId: '',
      verifyState: '',
      verifyAttemptCount: 0,
      verifyLastCheckedAt: 0,
      verifiedAt: 0,
      materializedRowCount: 0
    }
  ]);

  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].payload.text, 'accepted payload');
  assert.strictEqual(items[0].deliveryAcceptedAt, now - 4000);
  assert.strictEqual(items[0].deliveryEventId, '77');
  assert.strictEqual(items[0].verifyState, 'materialization_pending');
  assert.strictEqual(items[0].verifyAttemptCount, 2);
}

function testVerifyPendingDuplicatePreservesRetryState() {
  const context = loadFunctions([
    'getWatchlistOutboxDedupKey',
    'normalizeWatchlistEventId',
    'normalizeWatchlistVerifyState',
    'normalizeWatchlistOutboxPositiveInt',
    'normalizeWatchlistOutboxNonNegativeInt',
    'rankWatchlistOutboxItem',
    'choosePreferredWatchlistOutboxItem',
    'mergeWatchlistOutboxItems',
    'sanitizeWatchlistOutbox'
  ]);
  const now = Date.now();
  const items = context.sanitizeWatchlistOutbox([
    {
      payload: { responseId: 'resp-verify', text: 'verify pending payload' },
      queuedAt: now - 7000,
      attemptCount: 1,
      nextAttemptAt: now + 60_000,
      deliveryAcceptedAt: now - 6000,
      deliveryEventId: '92',
      verifyState: 'materialization_partial',
      verifyReason: 'materialization_partial',
      verifyAttemptCount: 3,
      verifyLastCheckedAt: now - 500,
      verifiedAt: 0,
      materializedRowCount: 1
    },
    {
      payload: { responseId: 'resp-verify', text: 'fresh duplicate payload' },
      queuedAt: now - 1000,
      attemptCount: 0,
      nextAttemptAt: 0,
      deliveryAcceptedAt: 0,
      deliveryEventId: '',
      verifyState: '',
      verifyAttemptCount: 0,
      verifyLastCheckedAt: 0,
      verifiedAt: 0,
      materializedRowCount: 0
    }
  ]);

  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].nextAttemptAt, now + 60_000);
  assert.strictEqual(items[0].verifyAttemptCount, 3);
  assert.strictEqual(items[0].verifyLastCheckedAt, now - 500);
  assert.strictEqual(items[0].verifyState, 'materialization_partial');
}

function testVerifiedDuplicatePreservesVerifiedState() {
  const context = loadFunctions([
    'getWatchlistOutboxDedupKey',
    'normalizeWatchlistEventId',
    'normalizeWatchlistVerifyState',
    'normalizeWatchlistOutboxPositiveInt',
    'normalizeWatchlistOutboxNonNegativeInt',
    'rankWatchlistOutboxItem',
    'choosePreferredWatchlistOutboxItem',
    'mergeWatchlistOutboxItems',
    'sanitizeWatchlistOutbox'
  ]);
  const now = Date.now();
  const items = context.sanitizeWatchlistOutbox([
    {
      payload: { responseId: 'resp-verified', text: 'verified payload' },
      queuedAt: now - 9000,
      attemptCount: 2,
      nextAttemptAt: 0,
      deliveryAcceptedAt: now - 8000,
      deliveryEventId: '105',
      verifyState: 'verified',
      verifyAttemptCount: 4,
      verifyLastCheckedAt: now - 200,
      verifiedAt: now - 100,
      materializedRowCount: 2
    },
    {
      payload: { responseId: 'resp-verified', text: 'fresh duplicate payload' },
      queuedAt: now - 1000,
      attemptCount: 0,
      nextAttemptAt: 0,
      deliveryAcceptedAt: 0,
      deliveryEventId: '',
      verifyState: '',
      verifyAttemptCount: 0,
      verifyLastCheckedAt: 0,
      verifiedAt: 0,
      materializedRowCount: 0
    }
  ]);

  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].verifiedAt, now - 100);
  assert.strictEqual(items[0].materializedRowCount, 2);
  assert.strictEqual(items[0].payload.text, 'verified payload');
}

function testFreshDuplicatesCollapseToSingleItem() {
  const context = loadFunctions([
    'getWatchlistOutboxDedupKey',
    'normalizeWatchlistEventId',
    'normalizeWatchlistVerifyState',
    'normalizeWatchlistOutboxPositiveInt',
    'normalizeWatchlistOutboxNonNegativeInt',
    'rankWatchlistOutboxItem',
    'choosePreferredWatchlistOutboxItem',
    'mergeWatchlistOutboxItems',
    'sanitizeWatchlistOutbox'
  ]);
  const now = Date.now();
  const items = context.sanitizeWatchlistOutbox([
    {
      payload: { responseId: 'resp-fresh', text: 'fresh payload a' },
      queuedAt: now - 2000,
      attemptCount: 0,
      nextAttemptAt: 0
    },
    {
      payload: { responseId: 'resp-fresh', text: 'fresh payload b' },
      queuedAt: now - 1000,
      attemptCount: 0,
      nextAttemptAt: 0
    }
  ]);

  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].payload.responseId, 'resp-fresh');
}

function main() {
  testAcceptedDuplicatePreservesAcceptedState();
  testVerifyPendingDuplicatePreservesRetryState();
  testVerifiedDuplicatePreservesVerifiedState();
  testFreshDuplicatesCollapseToSingleItem();
  console.log('test-watchlist-outbox-merge.js: ok');
}

main();
