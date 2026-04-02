const assert = require('assert');

const RemoteContractUtils = require('./remote-contract.js');

async function testBuildPromptSnapshotHashUsesCanonicalSeparator() {
  const first = await RemoteContractUtils.buildPromptSnapshotHash(['prompt 1', 'prompt 2']);
  const second = await RemoteContractUtils.buildPromptSnapshotHash(['prompt 1', 'prompt 2']);
  const third = await RemoteContractUtils.buildPromptSnapshotHash(['prompt 1', 'prompt  2']);

  assert.match(first, /^sha256:[a-f0-9]{64}$/i);
  assert.strictEqual(first, second);
  assert.notStrictEqual(first, third);
}

function testBuildPreparedRemoteTabUsesManualTextShape() {
  const tab = RemoteContractUtils.buildPreparedRemoteTab({
    jobId: 'rjob-1',
    submittedTitle: 'Acme',
    text: 'hello',
    instanceIndex: 2,
    instanceTotal: 3
  });

  assert.strictEqual(tab.id, 'remote-rjob-1');
  assert.strictEqual(tab.url, 'manual://remote-text');
  assert.strictEqual(tab.title, 'Acme [2/3]');
  assert.strictEqual(tab.manualText, 'hello');
}

function testIsRunnerQueueableRecognizesBusyAndReady() {
  assert.strictEqual(RemoteContractUtils.isRunnerQueueable('ready'), true);
  assert.strictEqual(RemoteContractUtils.isRunnerQueueable('busy'), true);
  assert.strictEqual(RemoteContractUtils.isRunnerQueueable('offline'), false);
}

function testSubmissionScopedHelpersStayDeterministic() {
  assert.strictEqual(
    RemoteContractUtils.buildRequestDedupeKey('rsubmit-1', 3),
    'rsubmit-1:3'
  );
  assert.strictEqual(
    RemoteContractUtils.buildSubmissionScopedEntityId('rjob', 'rsubmit-1', 2),
    'rjob-rsubmit-1-2'
  );
}

async function main() {
  await testBuildPromptSnapshotHashUsesCanonicalSeparator();
  testBuildPreparedRemoteTabUsesManualTextShape();
  testIsRunnerQueueableRecognizesBusyAndReady();
  testSubmissionScopedHelpersStayDeterministic();
  console.log('test-remote-contract.js: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
