const assert = require('assert');

const RemoteBatchStorageUtils = require('./remote-batch-storage.js');

function testBuildAndMergeBatchRecords() {
  const batch = RemoteBatchStorageUtils.buildBatchRecord({
    batchId: 'rbatch-1',
    runnerId: 'ext-runner',
    title: 'Acme',
    requestedInstances: 2,
    createdCount: 2,
    failedCount: 0,
    batchState: 'created',
    jobs: [
      { jobId: 'rjob-1', instanceIndex: 1, instanceTotal: 2, status: 'queued' },
      { jobId: 'rjob-2', instanceIndex: 2, instanceTotal: 2, status: 'queued' },
    ],
  });

  const merged = RemoteBatchStorageUtils.mergeJobIntoBatch(batch, {
    jobId: 'rjob-1',
    instanceIndex: 1,
    instanceTotal: 2,
    status: 'completed',
    conversationUrl: 'https://chatgpt.com/c/1'
  });

  assert.strictEqual(merged.jobs.length, 2);
  assert.strictEqual(merged.jobs[0].status, 'completed');
  assert.strictEqual(merged.batchState, 'queued');
}

function testUpsertBatchRecordKeepsLatestFirst() {
  const first = RemoteBatchStorageUtils.buildBatchRecord({ batchId: 'rbatch-1', title: 'One' });
  const second = RemoteBatchStorageUtils.buildBatchRecord({ batchId: 'rbatch-2', title: 'Two' });
  const updated = RemoteBatchStorageUtils.upsertBatchRecord([first], second);

  assert.strictEqual(updated[0].batchId, 'rbatch-2');
  assert.strictEqual(updated[1].batchId, 'rbatch-1');
}

function main() {
  testBuildAndMergeBatchRecords();
  testUpsertBatchRecordKeepsLatestFirst();
  console.log('test-remote-batch-storage.js: ok');
}

main();
