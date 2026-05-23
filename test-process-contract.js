const assert = require('assert');

const ProcessContractUtils = require('./process-contract.js');

function testQueueContract() {
  const contract = ProcessContractUtils.getProcessContract({
    status: 'queued',
    queuePosition: 3
  });

  assert.strictEqual(contract.lifecycleStatus, 'queued');
  assert.strictEqual(contract.phase, 'queue_wait');
  assert.strictEqual(contract.actionRequired, 'none');
  assert.strictEqual(contract.statusCode, 'queue.waiting');
  assert.match(contract.statusText, /Pozycja 3/);
}

function testLegacyFailureBackfill() {
  const contract = ProcessContractUtils.getProcessContract({
    status: 'error',
    reason: 'textarea_not_found'
  });

  assert.strictEqual(contract.lifecycleStatus, 'failed');
  assert.strictEqual(contract.statusCode, 'chat.editor_not_found');
  assert.match(contract.statusText, /edytora ChatGPT/i);
}

function testNeedsActionInference() {
  const contract = ProcessContractUtils.getProcessContract({
    status: 'running',
    needsAction: true,
    statusText: 'Continue button visible'
  });

  assert.strictEqual(contract.lifecycleStatus, 'running');
  assert.strictEqual(contract.actionRequired, 'continue_button');
  assert.strictEqual(contract.statusCode, 'chat.continue_button');
  assert.match(contract.statusText, /Continue/i);
}

function testFinalizingCompletionSemantics() {
  const finalizing = ProcessContractUtils.getProcessContract({
    lifecycleStatus: 'finalizing',
    phase: 'dispatch_remote'
  });
  const completed = ProcessContractUtils.getProcessContract({
    lifecycleStatus: 'completed',
    phase: 'verify_remote'
  });

  assert.strictEqual(finalizing.statusCode, 'dispatch.pending');
  assert.match(finalizing.statusText, /Watchlist/i);
  assert.strictEqual(completed.statusCode, 'dispatch.confirmed');
  assert.match(completed.statusText, /sync do Watchlist gotowe/i);
}

function testRateLimitNeedsActionContract() {
  const contract = ProcessContractUtils.getProcessContract({
    lifecycleStatus: 'running',
    phase: 'response_wait',
    actionRequired: 'rate_limit'
  });

  assert.strictEqual(contract.lifecycleStatus, 'running');
  assert.strictEqual(contract.actionRequired, 'rate_limit');
  assert.strictEqual(contract.statusCode, 'chat.rate_limited');
  assert.match(contract.statusText, /limit|restriction/i);
}

function testForceStoppedLegacyFailureBackfill() {
  const contract = ProcessContractUtils.getProcessContract({
    lifecycleStatus: 'failed',
    status: 'failed',
    reason: 'inject_failed',
    error: 'force_stopped',
    statusText: 'Blad procesu'
  });

  assert.strictEqual(contract.lifecycleStatus, 'stopped');
  assert.strictEqual(contract.statusCode, 'process.stopped');
  assert.match(contract.statusText, /zatrzymany/i);
  assert.strictEqual(ProcessContractUtils.isFailedLifecycleStatus(contract.lifecycleStatus), false);
}

function main() {
  testQueueContract();
  testLegacyFailureBackfill();
  testNeedsActionInference();
  testFinalizingCompletionSemantics();
  testRateLimitNeedsActionContract();
  testForceStoppedLegacyFailureBackfill();
  console.log('test-process-contract.js passed');
}

main();
