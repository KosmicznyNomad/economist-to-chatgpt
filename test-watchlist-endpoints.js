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

function buildContext(overrides = {}) {
  const context = {
    console,
    Promise,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    WATCHLIST_DISPATCH: {
      enabled: true,
      timeoutMs: 20000
    },
    ISKRA_REMOTE_RUNNER: {
      requestTimeoutMs: 20000,
      retryCount: 2,
      backoffMs: 100
    },
    WatchlistApiUtils: {
      ISKRA_RUNNERS_PATH: '/api/v1/iskra/runners',
      ISKRA_RUNNERS_HEARTBEAT_PATH: '/api/v1/iskra/runners/heartbeat',
      ISKRA_JOBS_PATH: '/api/v1/iskra/jobs',
      ISKRA_JOBS_CLAIM_PATH: '/api/v1/iskra/jobs/claim'
    },
    resolveWatchlistDispatchConfiguration: async () => ({
      ok: true,
      intakeUrl: 'https://iskierka-watchlist.duckdns.org/api/v1/intake/economist-response',
      keyId: 'extension-primary',
      secret: 'secret'
    }),
    sleep: async () => {},
    trimProblemLogText(value, maxLength = 9999) {
      const text = typeof value === 'string' ? value.trim() : '';
      return text.slice(0, maxLength);
    },
    ensureExtensionInstallationId: async () => 'ext-installation',
    createDispatchTimeoutError(timeoutMs) {
      const error = new Error(`timeout ${timeoutMs}`);
      error.name = 'TimeoutError';
      return error;
    },
    normalizeRemoteProblemLogEntries(items) {
      return Array.isArray(items) ? items.map((item) => ({
        id: item.event_id,
        title: item.title
      })) : [];
    },
    buildWatchlistProblemLogUrlCandidates() {
      return ['https://iskierka-watchlist.duckdns.org/api/v1/intake/problem-logs/query'];
    },
    fetch: async () => {
      throw new Error('fetch not stubbed');
    },
    ...overrides
  };

  vm.createContext(context);
  [
    'getIskraApiPath',
    'buildRemoteRunnerStatusApiPath',
    'buildRemoteJobApiPath',
    'normalizeRemoteApiErrorText',
    'performSignedIskraApiRequest',
    'listRemoteRunnersViaApi',
    'getRemoteRunnerStatusViaApi',
    'createRemoteJobViaApi',
    'claimRemoteJobViaApi',
    'postRemoteJobEventViaApi',
    'getRemoteJobViaApi',
    'listRemoteJobsViaApi',
    'fetchRemoteProblemLogs'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
      filename: 'background.js'
    });
  });

  return context;
}

function toPlainJson(value) {
  return JSON.parse(JSON.stringify(value));
}

async function testPerformSignedIskraApiRequestReturnsParsedSuccess() {
  const fetchCalls = [];
  const context = buildContext({
    WatchlistApiUtils: {
      ISKRA_RUNNERS_PATH: '/api/v1/iskra/runners',
      ISKRA_RUNNERS_HEARTBEAT_PATH: '/api/v1/iskra/runners/heartbeat',
      ISKRA_JOBS_PATH: '/api/v1/iskra/jobs',
      ISKRA_JOBS_CLAIM_PATH: '/api/v1/iskra/jobs/claim',
      buildSignedJsonRequest: async (options) => ({
        url: `https://iskierka-watchlist.duckdns.org${options.path}?limit=5`,
        method: options.method,
        headers: { 'X-Test': '1' },
        body: '',
        requestPayload: options.payload || {},
        query: options.query || null
      })
    },
    fetch: async (url, init) => {
      fetchCalls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ items: [{ id: 'runner-1' }] })
      };
    }
  });

  const result = await context.performSignedIskraApiRequest({
    method: 'GET',
    path: '/api/v1/iskra/runners',
    query: { limit: 5 },
    retryCount: 0
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.status, 200);
  assert.deepStrictEqual(toPlainJson(result.payload), {
    items: [{ id: 'runner-1' }]
  });
  assert.strictEqual(fetchCalls.length, 1);
  assert.strictEqual(fetchCalls[0].url, 'https://iskierka-watchlist.duckdns.org/api/v1/iskra/runners?limit=5');
  assert.strictEqual(fetchCalls[0].init.method, 'GET');
}

async function testPerformSignedIskraApiRequestRetriesTransientErrors() {
  let attempt = 0;
  const context = buildContext({
    WatchlistApiUtils: {
      ISKRA_RUNNERS_PATH: '/api/v1/iskra/runners',
      ISKRA_RUNNERS_HEARTBEAT_PATH: '/api/v1/iskra/runners/heartbeat',
      ISKRA_JOBS_PATH: '/api/v1/iskra/jobs',
      ISKRA_JOBS_CLAIM_PATH: '/api/v1/iskra/jobs/claim',
      buildSignedJsonRequest: async (options) => ({
        url: `https://iskierka-watchlist.duckdns.org${options.path}`,
        method: options.method,
        headers: { 'X-Test': '1' },
        body: '',
        requestPayload: options.payload || {}
      })
    },
    fetch: async () => {
      attempt += 1;
      if (attempt === 1) {
        return {
          ok: false,
          status: 500,
          text: async () => JSON.stringify({ detail: 'temporary_failure' })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true })
      };
    }
  });

  const result = await context.performSignedIskraApiRequest({
    method: 'GET',
    path: '/api/v1/iskra/jobs',
    retryCount: 1,
    backoffMs: 0
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(attempt, 2);
  assert.deepStrictEqual(toPlainJson(result.payload), { ok: true });
}

async function testRemoteApiWrappersBuildExpectedRequests() {
  const calls = [];
  const context = buildContext();
  context.performSignedIskraApiRequest = async (options) => {
    calls.push(options);
    return { success: true, options };
  };

  await context.listRemoteRunnersViaApi({ limit: 5 });
  await context.getRemoteRunnerStatusViaApi('runner-1', { timeoutMs: 777, retryCount: 1 });
  await context.createRemoteJobViaApi({ jobId: 'job-1' });
  await context.claimRemoteJobViaApi('runner-1');
  await context.postRemoteJobEventViaApi('job-1', { eventType: 'started' });
  await context.getRemoteJobViaApi('job-1');
  await context.listRemoteJobsViaApi({
    runnerId: 'runner-1',
    status: 'queued',
    batchId: 'batch-1',
    limit: 9
  });

  assert.deepStrictEqual(toPlainJson(calls), [
    {
      method: 'GET',
      path: '/api/v1/iskra/runners',
      query: { limit: 5 }
    },
    {
      method: 'GET',
      path: '/api/v1/iskra/runners/runner-1/status',
      timeoutMs: 777,
      retryCount: 1
    },
    {
      method: 'POST',
      path: '/api/v1/iskra/jobs',
      payload: { jobId: 'job-1' }
    },
    {
      method: 'POST',
      path: '/api/v1/iskra/jobs/claim',
      payload: { runnerId: 'runner-1' }
    },
    {
      method: 'POST',
      path: '/api/v1/iskra/jobs/job-1/event',
      payload: { eventType: 'started' }
    },
    {
      method: 'GET',
      path: '/api/v1/iskra/jobs/job-1'
    },
    {
      method: 'GET',
      path: '/api/v1/iskra/jobs',
      query: {
        runnerId: 'runner-1',
        status: 'queued',
        batchId: 'batch-1',
        limit: 9
      }
    }
  ]);
}

async function testFetchRemoteProblemLogsLoadsEntriesFromSignedEndpoint() {
  const fetchCalls = [];
  const context = buildContext({
    WatchlistApiUtils: {
      buildSignedProblemLogsQueryRequest: async (options) => ({
        url: `https://iskierka-watchlist.duckdns.org/api/v1/intake/problem-logs/query?supportId=${options.supportId}`,
        headers: { 'Content-Type': 'application/json', 'X-Test': '1' },
        body: JSON.stringify({
          limit: options.limit,
          minutes: options.minutes,
          supportId: options.supportId
        })
      })
    },
    fetch: async (url, init) => {
      fetchCalls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          count: 1,
          items: [{ event_id: 11, title: 'Dispatch warning' }]
        })
      };
    }
  });

  const result = await context.fetchRemoteProblemLogs({
    limit: 25,
    minutes: 90
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.supportId, 'ext-installation');
  assert.strictEqual(result.total, 1);
  assert.deepStrictEqual(toPlainJson(result.entries), [
    { id: 11, title: 'Dispatch warning' }
  ]);
  assert.strictEqual(fetchCalls.length, 1);
  assert.ok(fetchCalls[0].url.includes('/api/v1/intake/problem-logs/query?supportId=ext-installation'));
  assert.deepStrictEqual(JSON.parse(fetchCalls[0].init.body), {
    limit: 25,
    minutes: 90,
    supportId: 'ext-installation'
  });
}

async function testFetchRemoteProblemLogsFallsBackToNextCandidate() {
  const fetchCalls = [];
  const context = buildContext({
    buildWatchlistProblemLogUrlCandidates() {
      return [
        'https://primary.example/api/v1/intake/problem-logs/query',
        'https://fallback.example/api/v1/intake/problem-logs/query'
      ];
    },
    WatchlistApiUtils: {
      buildSignedProblemLogsQueryRequest: async (options) => ({
        url: options.intakeUrl,
        headers: { 'Content-Type': 'application/json', 'X-Test': '1' },
        body: JSON.stringify({
          limit: options.limit,
          minutes: options.minutes,
          supportId: options.supportId
        })
      })
    },
    fetch: async (url) => {
      fetchCalls.push(url);
      if (url.includes('primary.example')) {
        return {
          ok: false,
          status: 500,
          text: async () => 'temporary upstream failure'
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          count: 1,
          items: [{ event_id: 12, title: 'Recovered from fallback' }]
        })
      };
    }
  });

  const result = await context.fetchRemoteProblemLogs({
    supportId: 'ext-manual',
    limit: 10,
    minutes: 30
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.supportId, 'ext-manual');
  assert.strictEqual(result.intakeUrl, 'https://fallback.example/api/v1/intake/problem-logs/query');
  assert.deepStrictEqual(fetchCalls, [
    'https://primary.example/api/v1/intake/problem-logs/query',
    'https://fallback.example/api/v1/intake/problem-logs/query'
  ]);
}

async function main() {
  await testPerformSignedIskraApiRequestReturnsParsedSuccess();
  await testPerformSignedIskraApiRequestRetriesTransientErrors();
  await testRemoteApiWrappersBuildExpectedRequests();
  await testFetchRemoteProblemLogsLoadsEntriesFromSignedEndpoint();
  await testFetchRemoteProblemLogsFallsBackToNextCandidate();
  console.log('test-watchlist-endpoints.js: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
