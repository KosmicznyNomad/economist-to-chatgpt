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
  const braceStart = source.indexOf('{', paramsStart);
  if (paramsStart < 0 || braceStart < 0) {
    throw new Error(`Function body not found: ${functionName}`);
  }

  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;

  for (let i = braceStart; i < source.length; i += 1) {
    const char = source[i];
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
  const context = {
    console,
    Date,
    WATCHLIST_DISPATCH: { historyMaxItems: 200 },
    truncateDispatchLogText: (value, maxLength = 240) => {
      const text = typeof value === 'string' ? value : '';
      return text.length > maxLength ? text.slice(0, maxLength) : text;
    }
  };
  vm.createContext(context);
  vm.runInContext(extractFunctionSource(backgroundSource, 'sanitizeWatchlistDispatchHistory'), context, {
    filename: 'background.js'
  });

  const items = context.sanitizeWatchlistDispatchHistory([
    {
      ts: 1_760_000_000_000,
      kind: 'send',
      reason: 'http_ok',
      success: true,
      queued: 0,
      accepted: 1,
      sent: 0,
      failed: 0,
      deferred: 0,
      remaining: 0,
      trace: 'run-1/resp-1',
      runId: 'run-1',
      responseId: 'resp-1',
      eventId: '42',
      requestId: 'req-42',
      intakeUrl: 'https://watchlist.example/intake',
      status: 202
    }
  ]);

  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].accepted, 1);
  assert.strictEqual(items[0].status, 202);
  console.log('test-watchlist-dispatch-history.js: ok');
}

main();
