const assert = require('assert');

const RemoteRunnerUtils = require('./remote-runner.js');

function testShouldAttemptClaimRequiresPositivePreflight() {
  assert.strictEqual(RemoteRunnerUtils.shouldAttemptClaim({
    config: { remoteRunnerEnabled: true },
    localBusy: false,
    promptsLoaded: true,
    chatgptReady: true,
    lastPreflightResult: 'ok'
  }), true);

  assert.strictEqual(RemoteRunnerUtils.shouldAttemptClaim({
    config: { remoteRunnerEnabled: true },
    localBusy: false,
    promptsLoaded: true,
    chatgptReady: false,
    lastPreflightResult: 'chatgpt_editor_missing'
  }), false);

  assert.strictEqual(RemoteRunnerUtils.shouldAttemptClaim({
    config: { remoteRunnerEnabled: true },
    localBusy: true,
    promptsLoaded: true,
    chatgptReady: true,
    lastPreflightResult: 'ok'
  }), false);
}

function main() {
  testShouldAttemptClaimRequiresPositivePreflight();
  console.log('test-remote-runner.js: ok');
}

main();
