const assert = require('assert');

const WatchlistApiUtils = require('./watchlist-api.js');

function testBuildProblemLogsQueryUrlUsesCanonicalPostEndpoint() {
  const remote = WatchlistApiUtils.buildProblemLogsQueryUrl(
    'https://iskierka-watchlist.duckdns.org/api/v1/intake/economist-response'
  );
  const local = WatchlistApiUtils.buildProblemLogsQueryUrl(
    'http://127.0.0.1:18080/api/v1/intake/economist-response'
  );

  assert.strictEqual(
    remote,
    'https://iskierka-watchlist.duckdns.org/api/v1/intake/problem-logs/query'
  );
  assert.strictEqual(
    local,
    'http://127.0.0.1:18080/api/v1/intake/problem-logs/query'
  );
}

function testBuildProblemLogsQueryPayloadAcceptsCamelAndSnakeCase() {
  const camel = WatchlistApiUtils.buildProblemLogsQueryPayload({
    supportId: 'ext-abc',
    sinceEventId: 22,
    limit: 20,
    minutes: 180
  });
  const snake = WatchlistApiUtils.buildProblemLogsQueryPayload({
    support_id: 'ext-def',
    since_event_id: 33,
    limit: 10,
    minutes: 90
  });

  assert.deepStrictEqual(camel, {
    supportId: 'ext-abc',
    sinceEventId: 22,
    limit: 20,
    minutes: 180
  });
  assert.deepStrictEqual(snake, {
    supportId: 'ext-def',
    sinceEventId: 33,
    limit: 10,
    minutes: 90
  });
}

function testCreateNonceUsesSecureRandomShape() {
  const first = WatchlistApiUtils.createNonce(1_710_000_000_000);
  const second = WatchlistApiUtils.createNonce(1_710_000_000_000);

  assert.match(first, /^n-[0-9a-z]+-[0-9a-f]{24}$/i);
  assert.match(second, /^n-[0-9a-z]+-[0-9a-f]{24}$/i);
  assert.notStrictEqual(first, second);
}

function testBuildWatchlistApiUrlReplacesPathAndAddsQuery() {
  const url = WatchlistApiUtils.buildWatchlistApiUrl(
    'https://iskierka-watchlist.duckdns.org/api/v1/intake/economist-response',
    '/api/v1/iskra/jobs',
    {
      runnerId: 'ext-runner',
      status: 'queued',
      limit: 5
    }
  );

  assert.strictEqual(
    url,
    'https://iskierka-watchlist.duckdns.org/api/v1/iskra/jobs?runnerId=ext-runner&status=queued&limit=5'
  );
}

async function testBuildSignedProblemLogsQueryRequestProducesSignedPostRequest() {
  const signed = await WatchlistApiUtils.buildSignedProblemLogsQueryRequest({
    intakeUrl: 'https://iskierka-watchlist.duckdns.org/api/v1/intake/economist-response',
    keyId: 'extension-primary',
    secret: 'top-secret',
    supportId: 'ext-xyz',
    sinceEventId: 77,
    limit: 50,
    minutes: 120,
    timestamp: 1_710_000_000,
    nonce: 'nonce-fixed'
  });

  assert.strictEqual(
    signed.url,
    'https://iskierka-watchlist.duckdns.org/api/v1/intake/problem-logs/query'
  );
  assert.strictEqual(signed.method, 'POST');
  assert.deepStrictEqual(signed.requestPayload, {
    supportId: 'ext-xyz',
    sinceEventId: 77,
    limit: 50,
    minutes: 120
  });
  assert.strictEqual(signed.headers['Content-Type'], 'application/json');
  assert.strictEqual(signed.headers['X-Watchlist-Key-Id'], 'extension-primary');
  assert.strictEqual(signed.headers['X-Watchlist-Timestamp'], '1710000000');
  assert.strictEqual(signed.headers['X-Watchlist-Nonce'], 'nonce-fixed');
  assert.ok(/^[a-f0-9]{64}$/i.test(signed.headers['X-Watchlist-Signature']));
}

async function testBuildSignedJsonRequestUsesPathOnlyInCanonicalForGet() {
  const signed = await WatchlistApiUtils.buildSignedJsonRequest({
    intakeUrl: 'https://iskierka-watchlist.duckdns.org/api/v1/intake/economist-response',
    path: '/api/v1/iskra/jobs',
    method: 'GET',
    keyId: 'extension-primary',
    secret: 'top-secret',
    query: {
      runnerId: 'ext-runner',
      status: 'queued',
      limit: 5
    },
    timestamp: 1_710_000_000,
    nonce: 'nonce-fixed'
  });

  assert.strictEqual(
    signed.url,
    'https://iskierka-watchlist.duckdns.org/api/v1/iskra/jobs?runnerId=ext-runner&status=queued&limit=5'
  );
  assert.strictEqual(signed.method, 'GET');
  assert.strictEqual(signed.body, '');
  assert.strictEqual(
    signed.canonical,
    [
      'GET',
      '/api/v1/iskra/jobs',
      '1710000000',
      'nonce-fixed',
      signed.bodyHash
    ].join('\n')
  );
  assert.ok(!('Content-Type' in signed.headers));
}

async function testBuildSignedCreateAndListRemoteHelpers() {
  const createSigned = await WatchlistApiUtils.buildSignedCreateRemoteJobRequest({
    intakeUrl: 'https://iskierka-watchlist.duckdns.org/api/v1/intake/economist-response',
    keyId: 'extension-primary',
    secret: 'top-secret',
    payload: {
      jobId: 'rjob-1',
      runId: 'run-1'
    },
    timestamp: 1_710_000_000,
    nonce: 'nonce-create'
  });
  const listSigned = await WatchlistApiUtils.buildSignedListRemoteJobsRequest({
    intakeUrl: 'https://iskierka-watchlist.duckdns.org/api/v1/intake/economist-response',
    keyId: 'extension-primary',
    secret: 'top-secret',
    runnerId: 'ext-runner',
    status: 'started',
    batchId: 'rbatch-1',
    limit: 10,
    timestamp: 1_710_000_000,
    nonce: 'nonce-list'
  });

  assert.strictEqual(
    createSigned.url,
    'https://iskierka-watchlist.duckdns.org/api/v1/iskra/jobs'
  );
  assert.strictEqual(createSigned.method, 'POST');
  assert.deepStrictEqual(createSigned.requestPayload, {
    jobId: 'rjob-1',
    runId: 'run-1'
  });
  assert.strictEqual(
    listSigned.url,
    'https://iskierka-watchlist.duckdns.org/api/v1/iskra/jobs?runnerId=ext-runner&status=started&batchId=rbatch-1&limit=10'
  );
  assert.strictEqual(listSigned.method, 'GET');
  assert.ok(/^[a-f0-9]{64}$/i.test(listSigned.headers['X-Watchlist-Signature']));
}

async function main() {
  testBuildProblemLogsQueryUrlUsesCanonicalPostEndpoint();
  testBuildProblemLogsQueryPayloadAcceptsCamelAndSnakeCase();
  testCreateNonceUsesSecureRandomShape();
  testBuildWatchlistApiUrlReplacesPathAndAddsQuery();
  await testBuildSignedProblemLogsQueryRequestProducesSignedPostRequest();
  await testBuildSignedJsonRequestUsesPathOnlyInCanonicalForGet();
  await testBuildSignedCreateAndListRemoteHelpers();
  console.log('test-watchlist-api.js: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
