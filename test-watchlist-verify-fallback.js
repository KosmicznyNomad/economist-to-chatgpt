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

function truncateDispatchLogText(value, maxLength = 200) {
  const safe = typeof value === 'string' ? value.trim() : '';
  if (!safe) return '';
  if (!Number.isInteger(maxLength) || maxLength <= 0 || safe.length <= maxLength) return safe;
  return `${safe.slice(0, Math.max(0, maxLength - 3))}...`;
}

function createBaseContext(fetchImpl) {
  const context = {
    console,
    Date,
    Promise,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    WATCHLIST_DISPATCH: {
      enabled: true,
      verifyEnabled: true,
      verifyTimeoutMs: 12000
    },
    logs: [],
    history: [],
    processUpdates: [],
    normalizeWatchlistEventId: (value) => {
      if (typeof value === 'string') return value.trim();
      if (Number.isInteger(value)) return String(value);
      return '';
    },
    buildCopyTrace: (runId = '', responseId = '') => `${runId || 'no-run'}/${responseId || 'no-response'}`,
    buildWatchlistVerifyUrlCandidates: () => ['https://iskierka-watchlist.duckdns.org/api/v1/intake/economist-response/verify'],
    buildWatchlistVerifyPayload: (payload, item) => ({
      responseId: payload?.responseId || '',
      eventId: item?.deliveryEventId || ''
    }),
    resolveWatchlistDispatchConfiguration: async () => ({
      ok: true,
      intakeUrl: 'https://iskierka-watchlist.duckdns.org/api/v1/intake/economist-response',
      keyId: 'extension-primary',
      secret: 'secret'
    }),
    generateWatchlistNonce: () => 'nonce',
    sha256HexForDispatch: async () => 'body-hash',
    buildWatchlistCanonicalString: () => 'canonical',
    hmacSha256Hex: async () => 'signature',
    emitWatchlistDispatchProcessLog: (level, code, message, details) => {
      context.logs.push({ level, code, message, details });
    },
    appendWatchlistDispatchHistory: async (entry) => {
      context.history.push(entry);
    },
    updateProcessDispatchAfterSendSuccess: async (runId, responseId, details) => {
      context.processUpdates.push({ runId, responseId, details });
      return true;
    },
    truncateDispatchLogText,
    createDispatchTimeoutError: (timeoutMs) => {
      const error = new Error(`timeout ${timeoutMs}`);
      error.name = 'TimeoutError';
      return error;
    },
    fetch: fetchImpl
  };
  return context;
}

function loadVerifyHelpers(context) {
  vm.createContext(context);
  [
    'normalizeWatchlistVerifyState',
    'isWatchlistVerificationPendingState',
    'isWatchlistVerificationTerminalState',
    'verifyWatchlistDispatchDelivery'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
      filename: 'background.js'
    });
  });
}

async function testMissingVerifyEndpointFallsBackToAcceptedDelivery() {
  const context = createBaseContext(async () => ({
    ok: false,
    status: 404,
    headers: {
      get: () => ''
    },
    text: async () => '{"detail":"Not Found"}'
  }));
  loadVerifyHelpers(context);

  const result = await context.verifyWatchlistDispatchDelivery({
    deliveryAcceptedAt: Date.now(),
    deliveryEventId: '26992',
    deliveryIntakeUrl: 'https://iskierka-watchlist.duckdns.org/api/v1/intake/economist-response',
    payload: {
      responseId: 'resp-1',
      runId: 'run-1'
    }
  }, 'run-1/resp-1');

  assert.strictEqual(result.success, true, '404 on missing verify endpoint should fall back to accepted delivery.');
  assert.strictEqual(result.pending, false, '404 fallback should settle the delivery instead of retrying forever.');
  assert.strictEqual(result.state, 'http_accepted');
  assert.strictEqual(result.reason, 'verify_endpoint_missing');
  assert.strictEqual(context.processUpdates.length, 1, 'Fallback should still confirm the process dispatch state.');
  assert.strictEqual(
    context.history.some((entry) => entry.reason === 'verify_endpoint_missing' && entry.success === true),
    true,
    'Fallback should write a successful verify history entry.'
  );
  assert.strictEqual(
    context.logs.some((entry) => entry.code === 'verify_endpoint_missing'),
    true,
    'Fallback should emit a dedicated diagnostic log.'
  );
}

async function testQuarantinedVerifyStateIsTerminal() {
  const context = createBaseContext(async () => ({
    ok: true,
    status: 200,
    headers: {
      get: () => ''
    },
    json: async () => ({
      success: false,
      pending: false,
      state: 'ingest_quarantined',
      reason: 'structural_contract_validation_failed',
      event_id: 26993,
      materialized_row_count: 0,
      expected_materialized_row_count: 1
    })
  }));
  loadVerifyHelpers(context);

  const result = await context.verifyWatchlistDispatchDelivery({
    deliveryAcceptedAt: Date.now(),
    deliveryEventId: '26993',
    deliveryIntakeUrl: 'https://iskierka-watchlist.duckdns.org/api/v1/intake/economist-response',
    payload: {
      responseId: 'resp-2',
      runId: 'run-2'
    }
  }, 'run-2/resp-2');

  assert.strictEqual(result.success, false, 'Quarantined delivery should remain a failure.');
  assert.strictEqual(result.pending, false, 'Quarantined delivery should be terminal, not retried.');
  assert.strictEqual(result.state, 'ingest_quarantined');
  assert.strictEqual(result.stage, 'verify_state', 'Terminal verify states should be classified as verify_state.');
  assert.strictEqual(
    context.logs.some((entry) => entry.code === 'verify_attempt_failed' && entry.details?.state === 'ingest_quarantined'),
    true,
    'Quarantined verify responses should produce terminal verify diagnostics.'
  );
}

async function testMaterializationUnavailableVerifyStateStaysPending() {
  const context = createBaseContext(async () => ({
    ok: true,
    status: 200,
    headers: {
      get: () => ''
    },
    json: async () => ({
      success: false,
      pending: false,
      state: 'materialization_unavailable',
      reason: 'materialization_unavailable',
      event_id: 26994,
      materialized_row_count: 0,
      expected_materialized_row_count: 1
    })
  }));
  loadVerifyHelpers(context);

  const result = await context.verifyWatchlistDispatchDelivery({
    deliveryAcceptedAt: Date.now(),
    deliveryEventId: '26994',
    deliveryIntakeUrl: 'https://iskierka-watchlist.duckdns.org/api/v1/intake/economist-response',
    payload: {
      responseId: 'resp-3',
      runId: 'run-3'
    }
  }, 'run-3/resp-3');

  assert.strictEqual(result.success, false, 'Unavailable materialization should not be treated as verified.');
  assert.strictEqual(result.pending, true, 'Unavailable materialization should remain pending for retry.');
  assert.strictEqual(result.state, 'materialization_unavailable');
  assert.strictEqual(result.stage, 'verify_state');
  assert.strictEqual(
    context.logs.some((entry) => entry.code === 'verify_attempt_pending' && entry.details?.state === 'materialization_unavailable'),
    true,
    'Unavailable materialization should emit pending verification diagnostics.'
  );
}

async function main() {
  await testMissingVerifyEndpointFallsBackToAcceptedDelivery();
  await testQuarantinedVerifyStateIsTerminal();
  await testMaterializationUnavailableVerifyStateStaysPending();

  console.log('watchlist verify fallback test: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
