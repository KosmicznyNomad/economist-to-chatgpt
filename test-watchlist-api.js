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

async function main() {
  testBuildProblemLogsQueryUrlUsesCanonicalPostEndpoint();
  testBuildProblemLogsQueryPayloadAcceptsCamelAndSnakeCase();
  await testBuildSignedProblemLogsQueryRequestProducesSignedPostRequest();
  console.log('test-watchlist-api.js: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
