(function attachRemoteRunnerUtils(root, factory) {
  const api = factory(root);
  root.RemoteRunnerUtils = api;
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRemoteRunnerUtils(root) {
  const REMOTE_RUNNER_TICK_ALARM = 'remote-runner-tick';
  const REMOTE_RUNNER_TICK_PERIOD_MINUTES = 1;
  const REMOTE_JOB_HEARTBEAT_INTERVAL_MS = 60 * 1000;

  function normalizeText(value, fallback = '') {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || fallback;
  }

  function normalizeRunnerConfig(config = {}) {
    return {
      remoteRunnerEnabled: config.remoteRunnerEnabled === true || config.remote_runner_enabled === true,
      remoteRunnerName: normalizeText(config.remoteRunnerName || config.remote_runner_name),
      remoteDefaultRunnerId: normalizeText(config.remoteDefaultRunnerId || config.remote_default_runner_id)
    };
  }

  function shouldAttemptClaim(options = {}) {
    const config = normalizeRunnerConfig(options.config);
    const lastPreflightResult = normalizeText(options.lastPreflightResult || options?.preflight?.lastPreflightResult);
    const promptsLoaded = options.promptsLoaded === true || options?.preflight?.promptsLoaded === true;
    const chatgptReady = options.chatgptReady === true || options?.preflight?.chatgptReady === true;
    if (!config.remoteRunnerEnabled) return false;
    if (options.activeExecution) return false;
    if (options.localBusy === true) return false;
    if (!promptsLoaded) return false;
    if (!chatgptReady) return false;
    if (lastPreflightResult !== 'ok') return false;
    return true;
  }

  function buildHeartbeatPayload(options = {}) {
    return {
      runnerId: normalizeText(options.runnerId),
      runnerName: normalizeText(options.runnerName),
      enabled: options.enabled === true,
      promptsLoaded: options.promptsLoaded === true,
      promptHash: normalizeText(options.promptHash),
      chatgptReady: options.chatgptReady === true,
      localBusy: options.localBusy === true,
      localQueueSize: Number.isInteger(options.localQueueSize) ? Math.max(0, options.localQueueSize) : 0,
      lastPreflightAt: Number.isInteger(options.lastPreflightAt) ? options.lastPreflightAt : null,
      lastPreflightResult: normalizeText(options.lastPreflightResult),
      capabilities: options.capabilities && typeof options.capabilities === 'object' ? options.capabilities : {},
      extensionVersion: normalizeText(options.extensionVersion),
      activeJobId: normalizeText(options.activeJobId) || null
    };
  }

  return {
    REMOTE_RUNNER_TICK_ALARM,
    REMOTE_RUNNER_TICK_PERIOD_MINUTES,
    REMOTE_JOB_HEARTBEAT_INTERVAL_MS,
    normalizeRunnerConfig,
    shouldAttemptClaim,
    buildHeartbeatPayload
  };
});
