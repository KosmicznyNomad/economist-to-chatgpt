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

function loadContext() {
  const createCalls = [];
  const clearCalls = [];
  const setCalls = [];
  const context = {
    console,
    Date,
    WATCHLIST_DISPATCH: {
      enabled: true,
      outboxStorageKey: 'watchlist_dispatch_outbox',
      retryAlarmName: 'watchlist-dispatch-retry',
      retryAlarmImmediateDelayMs: 1500
    },
    chrome: {
      alarms: {
        create: (name, info) => {
          createCalls.push({ name, info });
        }
      },
      storage: {
        local: {
          set: async (payload) => {
            setCalls.push(payload);
          }
        }
      }
    },
    clearAlarmSafe: async (alarmName) => {
      clearCalls.push(alarmName);
      return true;
    },
    sanitizeWatchlistOutbox: (items) => (Array.isArray(items) ? items : [])
  };

  vm.createContext(context);
  [
    'computeWatchlistDispatchRetryAlarmAt',
    'syncWatchlistDispatchRetryAlarm',
    'writeWatchlistOutbox'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
      filename: 'background.js'
    });
  });

  context.__createCalls = createCalls;
  context.__clearCalls = clearCalls;
  context.__setCalls = setCalls;
  return context;
}

async function testReadyItemsScheduleImmediateRetry() {
  const context = loadContext();
  const now = 1_700_000_000_000;
  const when = context.computeWatchlistDispatchRetryAlarmAt([
    {
      payload: { responseId: 'resp-ready' },
      nextAttemptAt: now - 250
    }
  ], now);
  assert.strictEqual(when, now + 1500);
}

async function testFutureRetryUsesEarliestNextAttempt() {
  const context = loadContext();
  const now = 1_700_000_000_000;
  const expectedWhen = now + 45_000;
  const result = await context.syncWatchlistDispatchRetryAlarm([
    {
      payload: { responseId: 'resp-future-a' },
      nextAttemptAt: now + 60_000
    },
    {
      payload: { responseId: 'resp-future-b' },
      nextAttemptAt: expectedWhen
    }
  ], now);

  assert.strictEqual(result.scheduled, true);
  assert.strictEqual(result.when, expectedWhen);
  assert.strictEqual(context.__createCalls.length, 1);
  assert.strictEqual(context.__createCalls[0].name, 'watchlist-dispatch-retry');
  assert.strictEqual(context.__createCalls[0].info.when, expectedWhen);
  assert.strictEqual(context.__clearCalls.length, 0);
}

async function testVerifiedItemsClearRetryAlarm() {
  const context = loadContext();
  const now = 1_700_000_000_000;
  const result = await context.syncWatchlistDispatchRetryAlarm([
    {
      payload: { responseId: 'resp-verified' },
      nextAttemptAt: now - 1000,
      verifiedAt: now - 100
    }
  ], now);

  assert.strictEqual(result.scheduled, false);
  assert.strictEqual(result.reason, 'no_retry_needed');
  assert.deepStrictEqual(context.__createCalls, []);
  assert.deepStrictEqual(context.__clearCalls, ['watchlist-dispatch-retry']);
}

async function testWriteWatchlistOutboxPersistsAndSchedulesRetry() {
  const context = loadContext();
  const now = Date.now();
  const items = [
    {
      payload: { responseId: 'resp-write' },
      nextAttemptAt: now + 30_000
    }
  ];

  const result = await context.writeWatchlistOutbox(items);
  assert.strictEqual(result, items);
  assert.strictEqual(context.__setCalls.length, 1);
  assert.strictEqual(context.__setCalls[0].watchlist_dispatch_outbox, items);
  assert.strictEqual(context.__createCalls.length, 1);
  assert.strictEqual(context.__createCalls[0].name, 'watchlist-dispatch-retry');
  assert.strictEqual(context.__createCalls[0].info.when, items[0].nextAttemptAt);
}

async function main() {
  await testReadyItemsScheduleImmediateRetry();
  await testFutureRetryUsesEarliestNextAttempt();
  await testVerifiedItemsClearRetryAlarm();
  await testWriteWatchlistOutboxPersistsAndSchedulesRetry();
  console.log('watchlist retry alarm test: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
