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

function computeTimeout(watchlistDispatch) {
  const context = vm.createContext({
    Math,
    Number,
    WATCHLIST_DISPATCH: watchlistDispatch
  });
  vm.runInContext(extractFunctionSource(backgroundSource, 'computeFinalResponseSaveTimeoutMs'), context);
  return vm.runInContext('computeFinalResponseSaveTimeoutMs()', context);
}

assert.match(backgroundSource, /const FINAL_RESPONSE_SAVE_TIMEOUT_MS = computeFinalResponseSaveTimeoutMs\(\);/);
assert.strictEqual(
  (backgroundSource.match(/saveTimeoutMs:\s*FINAL_RESPONSE_SAVE_TIMEOUT_MS/g) || []).length,
  3
);

const defaultTimeout = computeTimeout({
  timeoutMs: 20000,
  verifyEnabled: true,
  verifyTimeoutMs: 12000,
  flushMaxRuntimeMs: 25000,
  enableLocalTunnelFallback: false
});
assert.strictEqual(defaultTimeout, 40000);

const fallbackTimeout = computeTimeout({
  timeoutMs: 20000,
  verifyEnabled: true,
  verifyTimeoutMs: 12000,
  flushMaxRuntimeMs: 25000,
  enableLocalTunnelFallback: true
});
assert.strictEqual(fallbackTimeout, 60000);

const verifyDisabledTimeout = computeTimeout({
  timeoutMs: 20000,
  verifyEnabled: false,
  verifyTimeoutMs: 12000,
  flushMaxRuntimeMs: 25000,
  enableLocalTunnelFallback: false
});
assert.strictEqual(verifyDisabledTimeout, 28000);

console.log('test-save-response-timeout-config.js: ok');
