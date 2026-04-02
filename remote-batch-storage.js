(function attachRemoteBatchStorageUtils(root, factory) {
  const api = factory(root);
  root.RemoteBatchStorageUtils = api;
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRemoteBatchStorageUtils(root) {
  const STORAGE_KEY = 'remote_manual_batches';
  const MAX_BATCHES = 20;

  function normalizeText(value, fallback = '') {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || fallback;
  }

  function toInt(value, fallback = 0) {
    if (Number.isInteger(value)) return value;
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) ? parsed : fallback;
  }

  function normalizeBatchJob(job = {}) {
    return {
      jobId: normalizeText(job.jobId || job.job_id),
      runId: normalizeText(job.runId || job.run_id),
      instanceIndex: Math.max(0, toInt(job.instanceIndex || job.instance_index, 0)),
      instanceTotal: Math.max(0, toInt(job.instanceTotal || job.instance_total, 0)),
      status: normalizeText(job.status, 'queued'),
      attemptId: normalizeText(job.attemptId || job.attempt_id),
      title: normalizeText(job.title || job.submittedTitle || job.submitted_title),
      conversationUrl: normalizeText(job.conversationUrl || job.conversation_url || job?.result?.conversationUrl),
      responseId: normalizeText(job.responseId || job.response_id || job?.result?.responseId),
      result: job.result && typeof job.result === 'object' ? job.result : null,
      failure: job.failure && typeof job.failure === 'object' ? job.failure : null,
      createdAt: toInt(job.createdAt || job.created_at, 0),
      updatedAt: toInt(job.updatedAt || job.updated_at, 0) || Date.now()
    };
  }

  function normalizeBatchError(item = {}) {
    return {
      instanceIndex: Math.max(0, toInt(item.instanceIndex || item.instance_index, 0)),
      reason: normalizeText(item.reason, 'unknown_error')
    };
  }

  function normalizeBatchRecord(record = {}) {
    const jobs = Array.isArray(record.jobs) ? record.jobs.map(normalizeBatchJob).filter((item) => item.jobId) : [];
    const errors = Array.isArray(record.errors) ? record.errors.map(normalizeBatchError) : [];
    return {
      batchId: normalizeText(record.batchId || record.batch_id),
      runnerId: normalizeText(record.runnerId || record.runner_id),
      title: normalizeText(record.title, 'Recznie wklejony artykul'),
      requestedInstances: Math.max(0, toInt(record.requestedInstances || record.requested_instances, jobs.length)),
      createdCount: Math.max(0, toInt(record.createdCount || record.created_count, jobs.length)),
      failedCount: Math.max(0, toInt(record.failedCount || record.failed_count, errors.length)),
      batchState: normalizeText(record.batchState || record.batch_state, 'created'),
      submittedAt: Math.max(0, toInt(record.submittedAt || record.submitted_at, Date.now())),
      updatedAt: Math.max(0, toInt(record.updatedAt || record.updated_at, Date.now())),
      jobs,
      errors
    };
  }

  function buildBatchRecord(options = {}) {
    return normalizeBatchRecord({
      batchId: options.batchId,
      runnerId: options.runnerId,
      title: options.title,
      requestedInstances: options.requestedInstances,
      createdCount: options.createdCount,
      failedCount: options.failedCount,
      batchState: options.batchState,
      submittedAt: options.submittedAt || Date.now(),
      updatedAt: options.updatedAt || Date.now(),
      jobs: options.jobs || [],
      errors: options.errors || []
    });
  }

  function deriveBatchState(batch = {}) {
    const jobs = Array.isArray(batch.jobs) ? batch.jobs : [];
    const errors = Array.isArray(batch.errors) ? batch.errors : [];
    const counts = {
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0
    };
    jobs.forEach((job) => {
      const status = normalizeText(job?.status).toLowerCase();
      if (status === 'started') counts.running += 1;
      else if (status === 'completed') counts.completed += 1;
      else if (status === 'failed') counts.failed += 1;
      else counts.queued += 1;
    });
    if (jobs.length === 0 && errors.length > 0) return 'failed';
    if (counts.running > 0) return 'running';
    if (counts.queued > 0) return errors.length > 0 ? 'partial' : 'queued';
    if (counts.failed > 0 && counts.completed > 0) return 'partial';
    if (counts.failed > 0) return 'failed';
    if (counts.completed > 0 && errors.length === 0) return 'completed';
    return errors.length > 0 ? 'partial' : normalizeText(batch.batchState, 'created');
  }

  function upsertBatchRecord(records, record) {
    const list = Array.isArray(records) ? records.map(normalizeBatchRecord) : [];
    const incoming = normalizeBatchRecord(record);
    if (!incoming.batchId) return pruneBatchRecords(list);
    const next = list.filter((item) => item.batchId !== incoming.batchId);
    next.unshift({
      ...incoming,
      batchState: deriveBatchState(incoming),
      updatedAt: Date.now()
    });
    return pruneBatchRecords(next);
  }

  function mergeJobIntoBatch(batch, jobSnapshot) {
    const normalizedBatch = normalizeBatchRecord(batch);
    const normalizedJob = normalizeBatchJob(jobSnapshot);
    if (!normalizedJob.jobId) return normalizedBatch;
    const nextJobs = normalizedBatch.jobs.filter((item) => item.jobId !== normalizedJob.jobId);
    nextJobs.push(normalizedJob);
    nextJobs.sort((left, right) => {
      const leftIndex = toInt(left.instanceIndex, 0);
      const rightIndex = toInt(right.instanceIndex, 0);
      if (leftIndex !== rightIndex) return leftIndex - rightIndex;
      return normalizeText(left.jobId).localeCompare(normalizeText(right.jobId));
    });
    return {
      ...normalizedBatch,
      jobs: nextJobs,
      createdCount: nextJobs.length,
      batchState: deriveBatchState({
        ...normalizedBatch,
        jobs: nextJobs
      }),
      updatedAt: Date.now()
    };
  }

  function findBatchRecord(records, batchId) {
    const normalizedBatchId = normalizeText(batchId);
    const list = Array.isArray(records) ? records.map(normalizeBatchRecord) : [];
    return list.find((item) => item.batchId === normalizedBatchId) || null;
  }

  function pruneBatchRecords(records) {
    const list = Array.isArray(records) ? records.map(normalizeBatchRecord) : [];
    return list
      .sort((left, right) => toInt(right.updatedAt, 0) - toInt(left.updatedAt, 0))
      .slice(0, MAX_BATCHES);
  }

  return {
    STORAGE_KEY,
    MAX_BATCHES,
    normalizeBatchJob,
    normalizeBatchError,
    normalizeBatchRecord,
    buildBatchRecord,
    deriveBatchState,
    upsertBatchRecord,
    mergeJobIntoBatch,
    findBatchRecord,
    pruneBatchRecords
  };
});
