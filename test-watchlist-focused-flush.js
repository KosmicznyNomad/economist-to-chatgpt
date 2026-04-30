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

function main() {
  const context = vm.createContext({
    console,
    Date
  });

  [
    'isWatchlistOutboxDeliveryAccepted',
    'normalizeWatchlistFlushFocus',
    'watchlistOutboxItemMatchesFocus',
    'prepareWatchlistOutboxForFlush',
    'getWatchlistOutboxFlushPriority',
    'sortWatchlistOutboxForFlush'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
      filename: 'background.js'
    });
  });

  const now = Date.now();
  const focus = context.normalizeWatchlistFlushFocus({
    runId: 'run-target',
    responseId: 'resp-target',
    forceMatchingReady: true,
    prioritizeMatching: true
  });

  assert.strictEqual(focus.runId, 'run-target');
  assert.strictEqual(focus.responseId, 'resp-target');
  assert.strictEqual(focus.forceMatchingReady, true);
  assert.strictEqual(focus.prioritizeMatching, true);

  const items = [
    {
      payload: { runId: 'run-older', responseId: 'resp-older' },
      queuedAt: now - 30_000,
      deliveryAcceptedAt: 0,
      nextAttemptAt: 0,
      attemptCount: 0,
      verifyAttemptCount: 0,
      lastError: ''
    },
    {
      payload: { runId: 'run-target', responseId: 'resp-target' },
      queuedAt: now - 5_000,
      deliveryAcceptedAt: now - 4_000,
      nextAttemptAt: now + 120_000,
      attemptCount: 3,
      verifyAttemptCount: 3,
      lastError: 'verify:materialization_pending'
    },
    {
      payload: { runId: 'run-other', responseId: 'resp-other' },
      queuedAt: now - 10_000,
      deliveryAcceptedAt: now - 9_000,
      nextAttemptAt: now + 60_000,
      attemptCount: 2,
      verifyAttemptCount: 2,
      lastError: 'verify:materialization_pending'
    }
  ];

  assert.strictEqual(context.watchlistOutboxItemMatchesFocus(items[1], focus), true);
  assert.strictEqual(context.watchlistOutboxItemMatchesFocus(items[0], focus), false);

  const prepared = context.prepareWatchlistOutboxForFlush(items, focus);
  assert.notStrictEqual(prepared, items);
  assert.strictEqual(prepared[1].nextAttemptAt, 0, 'Focused item should bypass backoff.');
  assert.strictEqual(prepared[1].lastError, 'verify:materialization_pending', 'Accepted verify item should keep diagnostic error text.');
  assert.strictEqual(prepared[0].nextAttemptAt, 0, 'Non-focused ready item should remain unchanged.');
  assert.strictEqual(prepared[2].nextAttemptAt, now + 60_000, 'Non-focused deferred item should keep original retry window.');

  const sorted = context.sortWatchlistOutboxForFlush(prepared, now, focus);
  assert.deepStrictEqual(
    sorted.map((item) => item.payload.responseId),
    ['resp-target', 'resp-older', 'resp-other'],
    'Focused retry should prioritize the requested response ahead of older queue items.'
  );

  console.log('watchlist focused flush test: ok');
}

try {
  main();
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
}
