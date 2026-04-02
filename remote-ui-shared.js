(function attachRemoteUiSharedUtils(root, factory) {
  const api = factory(root);
  root.RemoteUiSharedUtils = api;
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRemoteUiSharedUtils(root) {
  function normalizeText(value, fallback = '') {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || fallback;
  }

  function formatRunnerStatus(runner = {}) {
    const state = normalizeText(runner.state || runner.status, 'not_found');
    const queued = Number.isInteger(runner.queuedRemoteCount) ? runner.queuedRemoteCount : 0;
    const localBusy = runner.localBusy === true;
    const runnerName = normalizeText(runner.runnerName || runner.runnerId, 'runner');
    const reason = normalizeText(runner.reason, '');
    if (state === 'ready') {
      return { tone: 'success', text: `${runnerName}: gotowy${queued > 0 ? `, queued ${queued}` : ''}` };
    }
    if (state === 'busy') {
      return { tone: 'info', text: `${runnerName}: zajety${localBusy ? ' (lokalnie)' : ''}${queued > 0 ? `, queued ${queued}` : ''}` };
    }
    if (state === 'disabled') {
      return { tone: 'warn', text: `${runnerName}: runner mode wylaczony` };
    }
    if (state === 'offline' || state === 'stale') {
      return { tone: 'warn', text: `${runnerName}: ${state}` };
    }
    if (state === 'blocked') {
      return { tone: 'error', text: `${runnerName}: zablokowany${reason ? ` (${reason})` : ''}` };
    }
    return { tone: 'warn', text: `${runnerName}: nie znaleziono` };
  }

  function formatBatchStatus(batch = {}) {
    const state = normalizeText(batch.batchState || batch.batch_state, 'idle');
    const jobs = Array.isArray(batch.jobs) ? batch.jobs : [];
    const completed = jobs.filter((job) => normalizeText(job?.status) === 'completed').length;
    const failed = jobs.filter((job) => normalizeText(job?.status) === 'failed').length;
    const running = jobs.filter((job) => normalizeText(job?.status) === 'started').length;
    const queued = jobs.length - completed - failed - running;
    const total = Number.isInteger(batch.requestedInstances) ? batch.requestedInstances : jobs.length;
    if (state === 'completed') {
      return { tone: 'success', text: `Batch zakonczony: ${completed}/${total}` };
    }
    if (state === 'partial') {
      return { tone: 'warn', text: `Batch partial: ok ${completed}, failed ${failed}, queued ${queued}, running ${running}` };
    }
    if (state === 'failed') {
      return { tone: 'error', text: `Batch nieudany: ${failed}/${total}` };
    }
    if (state === 'running') {
      return { tone: 'info', text: `Batch w toku: running ${running}, queued ${queued}, done ${completed}/${total}` };
    }
    if (state === 'queued' || state === 'created') {
      return { tone: 'info', text: `Batch w kolejce: ${queued}/${total}` };
    }
    return { tone: 'info', text: 'Brak batcha' };
  }

  return {
    formatRunnerStatus,
    formatBatchStatus
  };
});
