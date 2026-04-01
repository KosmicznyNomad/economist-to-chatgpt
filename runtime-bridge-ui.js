(function attachRuntimeBridgeUi(root, factory) {
  const api = factory(root);
  root.RuntimeBridgeUi = api;
  root.sendRuntimeMessage = api.sendMessage;
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRuntimeBridgeUi(root) {
  function normalizeRuntimeErrorCode(rawMessage = '') {
    const normalized = typeof rawMessage === 'string' ? rawMessage.trim() : String(rawMessage ?? '').trim();
    const lowered = normalized.toLowerCase();
    if (!lowered) return 'runtime_error';
    if (lowered.includes('before a response was received')) return 'runtime_no_response';
    if (lowered.includes('receiving end does not exist')) return 'runtime_unavailable';
    if (lowered.includes('extension context invalidated')) return 'runtime_unavailable';
    if (lowered.includes('message port closed')) return 'runtime_no_response';
    return 'runtime_error';
  }

  function buildEnvelope(ok, data, errorCode = '', errorMessage = '') {
    const base = {
      ok: ok === true,
      data: data && typeof data === 'object' ? data : {},
      errorCode: typeof errorCode === 'string' ? errorCode : '',
      errorMessage: typeof errorMessage === 'string' ? errorMessage : ''
    };
    if (base.ok) {
      return {
        ...base,
        ...(base.data && typeof base.data === 'object' ? base.data : {})
      };
    }
    return {
      ...base,
      success: false,
      error: base.errorCode || base.errorMessage || 'runtime_error'
    };
  }

  function sendMessage(payload) {
    return new Promise((resolve) => {
      try {
        root.chrome.runtime.sendMessage(payload, (response) => {
          const lastError = root.chrome?.runtime?.lastError;
          if (lastError) {
            const message = lastError.message || 'runtime_error';
            const code = normalizeRuntimeErrorCode(message);
            if (code === 'runtime_no_response') {
              resolve(buildEnvelope(true, {}));
              return;
            }
            resolve(buildEnvelope(false, {}, code, message));
            return;
          }
          const data = response && typeof response === 'object' ? response : {};
          resolve(buildEnvelope(true, data));
        });
      } catch (error) {
        const message = error?.message || String(error);
        resolve(buildEnvelope(false, {}, normalizeRuntimeErrorCode(message), message));
      }
    });
  }

  return {
    buildEnvelope,
    normalizeRuntimeErrorCode,
    sendMessage
  };
});
