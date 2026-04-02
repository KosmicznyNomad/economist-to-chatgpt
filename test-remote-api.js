const assert = require('assert');

const RemoteApiUtils = require('./remote-api.js');
const WatchlistApiUtils = require('./watchlist-api.js');

global.WatchlistApiUtils = WatchlistApiUtils;

function testBuildRunnerStatusUrlFromIntakeBase() {
  const url = RemoteApiUtils.buildRunnerStatusUrl(
    'https://iskierka-watchlist.duckdns.org/api/v1/intake/economist-response',
    'ext-runner'
  );
  assert.strictEqual(
    url,
    'https://iskierka-watchlist.duckdns.org/api/v1/iskra/runners/ext-runner/status'
  );
}

async function testBuildSignedJsonRequestSupportsGet() {
  const signed = await RemoteApiUtils.buildSignedJsonRequest({
    url: 'https://iskierka-watchlist.duckdns.org/api/v1/iskra/jobs/rjob-1',
    method: 'GET',
    keyId: 'extension-primary',
    secret: 'top-secret',
    timestamp: 1710000000,
    nonce: 'nonce-fixed'
  });

  assert.strictEqual(signed.method, 'GET');
  assert.strictEqual(signed.body, '');
  assert.strictEqual(signed.headers['X-Watchlist-Key-Id'], 'extension-primary');
  assert.strictEqual(signed.headers['X-Watchlist-Timestamp'], '1710000000');
  assert.strictEqual(signed.headers['X-Watchlist-Nonce'], 'nonce-fixed');
  assert.ok(/^[a-f0-9]{64}$/i.test(signed.headers['X-Watchlist-Signature']));
}

async function main() {
  testBuildRunnerStatusUrlFromIntakeBase();
  await testBuildSignedJsonRequestSupportsGet();
  console.log('test-remote-api.js: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
