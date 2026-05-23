(function attachIskraDashboardBridge(root) {
  const PAGE_SOURCE = 'iskra-dashboard-page';
  const EXTENSION_SOURCE = 'iskra-dashboard-extension';
  const REQUEST_TYPE = 'ISKRA_DASHBOARD_BRIDGE_REQUEST';
  const RESPONSE_TYPE = 'ISKRA_DASHBOARD_BRIDGE_RESPONSE';

  function postResponse(requestId, ok, payload = {}, error = '') {
    try {
      root.postMessage({
        source: EXTENSION_SOURCE,
        type: RESPONSE_TYPE,
        requestId,
        ok: ok === true,
        payload: payload && typeof payload === 'object' ? payload : {},
        error: typeof error === 'string' ? error : ''
      }, root.location?.origin || '*');
    } catch (postError) {
      console.warn('[iskra-bridge] post response failed:', postError?.message || String(postError));
    }
  }

	  root.addEventListener('message', (event) => {
	    if (event.source !== root) return;
	    const data = event.data;
	    if (!data || typeof data !== 'object') return;
	    if (data.source !== PAGE_SOURCE) return;
	    const directHeartbeatRequest = data.type === 'GET_EXTENSION_HEARTBEAT' || data.type === 'ISKRA_GET_HEARTBEAT';
	    if (data.type !== REQUEST_TYPE && !directHeartbeatRequest) return;
	    const requestId = typeof data.requestId === 'string' && data.requestId
	      ? data.requestId
	      : (directHeartbeatRequest ? `heartbeat-${Date.now()}` : '');
	    const method = directHeartbeatRequest
	      ? 'iskra:getHeartbeat'
	      : (typeof data.method === 'string' ? data.method : '');
	    if (!requestId || !method) return;

	    if (method === 'iskra:isAvailable') {
	      postResponse(requestId, true, { success: true, heartbeat: true });
	      return;
	    }

	    if (method === 'iskra:getHeartbeat') {
	      try {
	        chrome.runtime.sendMessage({
	          type: 'GET_EXTENSION_HEARTBEAT',
	          forceReload: data.forceReload === true,
	          includeQueue: data.includeQueue !== false
	        }, (response) => {
	          const lastError = chrome.runtime?.lastError;
	          if (lastError) {
	            postResponse(requestId, false, {}, lastError.message || 'runtime_error');
	            return;
	          }
	          const payload = response && typeof response === 'object' ? response : {};
	          const ok = payload.success !== false && payload.ok === true;
	          postResponse(requestId, ok, payload, ok ? '' : (payload.error || 'extension_heartbeat_not_ready'));
	        });
	      } catch (error) {
	        postResponse(requestId, false, {}, error?.message || String(error || 'bridge_runtime_failed'));
	      }
	      return;
	    }

	    if (method === 'iskra:importOpenTabs') {
	      try {
        chrome.runtime.sendMessage({ type: 'IMPORT_REMOTE_QUEUE_TABS' }, (response) => {
          const lastError = chrome.runtime?.lastError;
          if (lastError) {
            postResponse(requestId, false, {}, lastError.message || 'runtime_error');
            return;
          }
          const payload = response && typeof response === 'object' ? response : {};
          const ok = payload.success !== false;
          postResponse(requestId, ok, payload, ok ? '' : (payload.error || 'remote_queue_tab_import_failed'));
        });
      } catch (error) {
        postResponse(requestId, false, {}, error?.message || String(error || 'bridge_runtime_failed'));
      }
    }
  });
})(window);
