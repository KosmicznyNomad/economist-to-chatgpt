(function attachRemoteContractUtils(root, factory) {
  const api = factory(root);
  root.RemoteContractUtils = api;
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRemoteContractUtils(root) {
  const REMOTE_JOB_SCHEMA = 'iskra.remote_job.v1';
  const REMOTE_SOURCE_MODE_MANUAL_TEXT = 'manual_text';
  const REMOTE_ANALYSIS_TYPE_COMPANY = 'company';
  const REMOTE_JOB_STATUS_QUEUED = 'queued';
  const REMOTE_JOB_STATUS_CLAIMED = 'claimed';
  const REMOTE_JOB_STATUS_RECEIVED = 'received';
  const REMOTE_JOB_STATUS_STARTED = 'started';
  const REMOTE_JOB_STATUS_COMPLETED = 'completed';
  const REMOTE_JOB_STATUS_FAILED = 'failed';
  const REMOTE_RUNNER_STATE_READY = 'ready';
  const REMOTE_RUNNER_STATE_BUSY = 'busy';
  const REMOTE_RUNNER_STATE_DISABLED = 'disabled';
  const REMOTE_RUNNER_STATE_OFFLINE = 'offline';
  const REMOTE_RUNNER_STATE_STALE = 'stale';
  const REMOTE_RUNNER_STATE_BLOCKED = 'blocked';
  const REMOTE_RUNNER_STATE_NOT_FOUND = 'not_found';
  const REMOTE_ERROR_PDF_NOT_SUPPORTED = 'remote_pdf_not_supported_yet';
  const PROMPT_SEPARATOR = '\n\nPROMPT_SEPARATOR\n\n';

  function normalizeText(value, fallback = '') {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || fallback;
  }

  function toInt(value, fallback = 0) {
    if (Number.isInteger(value)) return value;
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) ? parsed : fallback;
  }

  function getNodeCrypto() {
    if (typeof module === 'object' && module && module.exports && typeof require === 'function') {
      try {
        return require('crypto');
      } catch {
        return null;
      }
    }
    return null;
  }

  async function sha256Hex(value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    const nodeCrypto = getNodeCrypto();
    if (nodeCrypto) {
      return nodeCrypto.createHash('sha256').update(text).digest('hex');
    }
    const encoder = new TextEncoder();
    const digest = await root.crypto.subtle.digest('SHA-256', encoder.encode(text));
    return Array.from(new Uint8Array(digest)).map((item) => item.toString(16).padStart(2, '0')).join('');
  }

  async function buildPromptSnapshotHash(promptChainSnapshot) {
    const prompts = Array.isArray(promptChainSnapshot)
      ? promptChainSnapshot.map((item) => normalizeText(item)).filter(Boolean)
      : [];
    const digest = await sha256Hex(prompts.join(PROMPT_SEPARATOR));
    return digest ? `sha256:${digest}` : '';
  }

  function buildDisplayTitle(title, instanceIndex = 1, instanceTotal = 1) {
    const normalizedTitle = normalizeText(title, 'Recznie wklejony artykul');
    const safeIndex = Math.max(1, toInt(instanceIndex, 1));
    const safeTotal = Math.max(safeIndex, toInt(instanceTotal, 1));
    return safeTotal > 1
      ? `${normalizedTitle} [${safeIndex}/${safeTotal}]`
      : normalizedTitle;
  }

  function buildPreparedRemoteTab(jobPayload = {}) {
    const jobId = normalizeText(jobPayload.jobId || jobPayload.job_id);
    const instanceIndex = Math.max(1, toInt(jobPayload.instanceIndex || jobPayload.instance_index, 1));
    const instanceTotal = Math.max(instanceIndex, toInt(jobPayload.instanceTotal || jobPayload.instance_total, 1));
    return {
      id: jobId ? `remote-${jobId}` : `remote-${Date.now()}`,
      title: buildDisplayTitle(
        jobPayload.submittedTitle || jobPayload.submitted_title || 'Recznie wklejony artykul',
        instanceIndex,
        instanceTotal
      ),
      url: 'manual://remote-text',
      manualText: typeof jobPayload.text === 'string' ? jobPayload.text : ''
    };
  }

  function buildRequestDedupeKey(submissionId, instanceIndex = 1) {
    const normalizedSubmissionId = normalizeText(submissionId);
    const safeIndex = Math.max(1, toInt(instanceIndex, 1));
    return normalizedSubmissionId
      ? `${normalizedSubmissionId}:${safeIndex}`
      : '';
  }

  function buildSubmissionScopedEntityId(prefix, submissionId, instanceIndex = null) {
    const normalizedPrefix = normalizeText(prefix, 'remote').replace(/[^a-zA-Z0-9._-]/g, '-');
    const normalizedSubmissionId = normalizeText(submissionId).replace(/[^a-zA-Z0-9._-]/g, '-');
    const safeIndex = Number.isInteger(instanceIndex) || /^[0-9]+$/.test(String(instanceIndex || ''))
      ? Math.max(1, toInt(instanceIndex, 1))
      : null;
    if (!normalizedSubmissionId) {
      return safeIndex === null
        ? `${normalizedPrefix}-${Date.now()}`
        : `${normalizedPrefix}-${Date.now()}-${safeIndex}`;
    }
    return safeIndex === null
      ? `${normalizedPrefix}-${normalizedSubmissionId}`
      : `${normalizedPrefix}-${normalizedSubmissionId}-${safeIndex}`;
  }

  function normalizeRemoteRunnerState(rawState) {
    const state = normalizeText(rawState).toLowerCase();
    if (!state) return REMOTE_RUNNER_STATE_NOT_FOUND;
    return state;
  }

  function isRunnerQueueable(rawState, explicitQueueable = null) {
    if (explicitQueueable === true || explicitQueueable === false) return explicitQueueable;
    const state = normalizeRemoteRunnerState(rawState);
    return state === REMOTE_RUNNER_STATE_READY || state === REMOTE_RUNNER_STATE_BUSY;
  }

  function summarizeBatchJobs(jobs) {
    const list = Array.isArray(jobs) ? jobs : [];
    const summary = {
      total: list.length,
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0
    };
    for (const job of list) {
      const status = normalizeText(job?.status).toLowerCase();
      if (status === REMOTE_JOB_STATUS_QUEUED || status === REMOTE_JOB_STATUS_CLAIMED || status === REMOTE_JOB_STATUS_RECEIVED) {
        summary.queued += 1;
      } else if (status === REMOTE_JOB_STATUS_STARTED) {
        summary.running += 1;
      } else if (status === REMOTE_JOB_STATUS_COMPLETED) {
        summary.completed += 1;
      } else if (status === REMOTE_JOB_STATUS_FAILED) {
        summary.failed += 1;
      }
    }
    return summary;
  }

  function deriveBatchState(batch = {}) {
    const jobs = Array.isArray(batch.jobs) ? batch.jobs : [];
    const errors = Array.isArray(batch.errors) ? batch.errors : [];
    const summary = summarizeBatchJobs(jobs);
    if (summary.total === 0 && errors.length > 0) return 'failed';
    if (errors.length > 0 && summary.completed + summary.failed + summary.queued + summary.running < (toInt(batch.requestedInstances, 0) || jobs.length)) {
      return 'partial';
    }
    if (summary.running > 0) return 'running';
    if (summary.queued > 0) return 'queued';
    if (summary.completed > 0 && summary.failed > 0) return 'partial';
    if (summary.failed > 0 && summary.completed === 0 && summary.queued === 0 && summary.running === 0) return 'failed';
    if (summary.completed > 0 && summary.completed === summary.total && errors.length === 0) return 'completed';
    return normalizeText(batch.batchState || batch.batch_state, summary.total > 0 ? 'created' : 'idle');
  }

  return {
    REMOTE_JOB_SCHEMA,
    REMOTE_SOURCE_MODE_MANUAL_TEXT,
    REMOTE_ANALYSIS_TYPE_COMPANY,
    REMOTE_JOB_STATUS_QUEUED,
    REMOTE_JOB_STATUS_CLAIMED,
    REMOTE_JOB_STATUS_RECEIVED,
    REMOTE_JOB_STATUS_STARTED,
    REMOTE_JOB_STATUS_COMPLETED,
    REMOTE_JOB_STATUS_FAILED,
    REMOTE_RUNNER_STATE_READY,
    REMOTE_RUNNER_STATE_BUSY,
    REMOTE_RUNNER_STATE_DISABLED,
    REMOTE_RUNNER_STATE_OFFLINE,
    REMOTE_RUNNER_STATE_STALE,
    REMOTE_RUNNER_STATE_BLOCKED,
    REMOTE_RUNNER_STATE_NOT_FOUND,
    REMOTE_ERROR_PDF_NOT_SUPPORTED,
    PROMPT_SEPARATOR,
    normalizeText,
    toInt,
    sha256Hex,
    buildPromptSnapshotHash,
    buildDisplayTitle,
    buildPreparedRemoteTab,
    buildRequestDedupeKey,
    buildSubmissionScopedEntityId,
    normalizeRemoteRunnerState,
    isRunnerQueueable,
    summarizeBatchJobs,
    deriveBatchState
  };
});
