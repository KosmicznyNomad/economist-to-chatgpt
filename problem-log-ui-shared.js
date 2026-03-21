(function attachProblemLogUiUtils(root, factory) {
  const api = factory(root);
  root.ProblemLogUiUtils = api;
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createProblemLogUiUtils(root) {
  function summarizeClientErrorValue(rawValue) {
    if (rawValue == null) return '';
    if (typeof rawValue === 'string') return rawValue.trim();
    if (rawValue instanceof Error) return (rawValue.stack || rawValue.message || rawValue.name || '').trim();
    try {
      return JSON.stringify(rawValue);
    } catch {
      return String(rawValue);
    }
  }

  function normalizeLevel(level, allowInfo = false) {
    const normalized = typeof level === 'string' ? level.trim().toLowerCase() : '';
    if (normalized === 'warn' || normalized === 'warning') return 'warn';
    if (allowInfo && normalized === 'info') return 'info';
    return 'error';
  }

  function reportProblemLogFromUi(rawEntry = {}, options = {}) {
    const defaultSource = typeof options.defaultSource === 'string' && options.defaultSource.trim()
      ? options.defaultSource.trim()
      : 'ui';
    const defaultMessage = typeof options.defaultMessage === 'string' && options.defaultMessage.trim()
      ? options.defaultMessage.trim()
      : 'ui_problem';
    const signatureNamespace = typeof options.signatureNamespace === 'string' && options.signatureNamespace.trim()
      ? options.signatureNamespace.trim()
      : defaultSource;
    const allowInfo = options.allowInfo === true;

    const source = typeof rawEntry?.source === 'string' && rawEntry.source.trim()
      ? rawEntry.source.trim()
      : defaultSource;
    const message = typeof rawEntry?.message === 'string' && rawEntry.message.trim()
      ? rawEntry.message.trim()
      : defaultMessage;
    const error = typeof rawEntry?.error === 'string' ? rawEntry.error.trim() : '';
    const reason = typeof rawEntry?.reason === 'string' ? rawEntry.reason.trim() : '';
    const signature = typeof rawEntry?.signature === 'string' && rawEntry.signature.trim()
      ? rawEntry.signature.trim()
      : [signatureNamespace, source, rawEntry?.title || '', reason, error, message].join('|');

    try {
      root.chrome.runtime.sendMessage({
        type: 'REPORT_PROBLEM_LOG',
        entry: {
          level: normalizeLevel(rawEntry?.level, allowInfo),
          source,
          title: typeof rawEntry?.title === 'string' ? rawEntry.title : '',
          status: typeof rawEntry?.status === 'string' ? rawEntry.status : '',
          reason,
          error,
          message,
          signature,
          tabId: Number.isInteger(rawEntry?.tabId) ? rawEntry.tabId : null,
          windowId: Number.isInteger(rawEntry?.windowId) ? rawEntry.windowId : null
        }
      }, () => {});
    } catch {
      // Ignore runtime bridge errors inside extension UI surfaces.
    }
  }

  return {
    summarizeClientErrorValue,
    reportProblemLogFromUi
  };
});
