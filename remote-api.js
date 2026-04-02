(function attachRemoteApiUtils(root, factory) {
  const api = factory(root);
  root.RemoteApiUtils = api;
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRemoteApiUtils(root) {
  const API_RUNNERS_HEARTBEAT_PATH = '/api/v1/iskra/runners/heartbeat';
  const API_JOBS_PATH = '/api/v1/iskra/jobs';
  const API_JOBS_CLAIM_PATH = '/api/v1/iskra/jobs/claim';

  function normalizeText(value, fallback = '') {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || fallback;
  }

  function isLoopbackHost(rawHost) {
    const host = normalizeText(rawHost).toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  }

  function normalizeIntakeUrl(rawUrl) {
    if (root?.WatchlistApiUtils?.normalizeWatchlistIntakeUrl) {
      return root.WatchlistApiUtils.normalizeWatchlistIntakeUrl(rawUrl);
    }
    const value = normalizeText(rawUrl);
    if (!value) return '';
    try {
      const parsed = new URL(value);
      const protocol = String(parsed.protocol || '').toLowerCase();
      const hostname = String(parsed.hostname || '').toLowerCase();
      if (protocol === 'https:') return parsed.toString();
      if (protocol === 'http:' && isLoopbackHost(hostname)) return parsed.toString();
      return '';
    } catch {
      return '';
    }
  }

  function buildIskraUrl(rawIntakeUrl, endpointPath) {
    const normalized = normalizeIntakeUrl(rawIntakeUrl);
    const path = normalizeText(endpointPath);
    if (!normalized || !path) return '';
    try {
      const parsed = new URL(normalized);
      parsed.pathname = path.startsWith('/') ? path : `/${path}`;
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return '';
    }
  }

  function buildRunnerStatusUrl(rawIntakeUrl, runnerId) {
    const normalizedRunnerId = encodeURIComponent(normalizeText(runnerId));
    if (!normalizedRunnerId) return '';
    return buildIskraUrl(rawIntakeUrl, `/api/v1/iskra/runners/${normalizedRunnerId}/status`);
  }

  function buildJobEventUrl(rawIntakeUrl, jobId) {
    const normalizedJobId = encodeURIComponent(normalizeText(jobId));
    if (!normalizedJobId) return '';
    return buildIskraUrl(rawIntakeUrl, `/api/v1/iskra/jobs/${normalizedJobId}/event`);
  }

  function buildJobGetUrl(rawIntakeUrl, jobId) {
    const normalizedJobId = encodeURIComponent(normalizeText(jobId));
    if (!normalizedJobId) return '';
    return buildIskraUrl(rawIntakeUrl, `/api/v1/iskra/jobs/${normalizedJobId}`);
  }

  async function sha256Hex(value) {
    if (root?.WatchlistApiUtils?.sha256Hex) {
      return root.WatchlistApiUtils.sha256Hex(value);
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
    if (typeof module === 'object' && module && module.exports && typeof require === 'function') {
      return require('crypto').createHash('sha256').update(text).digest('hex');
    }
    const digest = await root.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest)).map((item) => item.toString(16).padStart(2, '0')).join('');
  }

  async function hmacSha256Hex(secret, canonical) {
    if (root?.WatchlistApiUtils?.hmacSha256Hex) {
      return root.WatchlistApiUtils.hmacSha256Hex(secret, canonical);
    }
    const secretText = normalizeText(secret);
    const canonicalText = typeof canonical === 'string' ? canonical : String(canonical ?? '');
    if (typeof module === 'object' && module && module.exports && typeof require === 'function') {
      return require('crypto').createHmac('sha256', secretText).update(canonicalText).digest('hex');
    }
    const encoder = new TextEncoder();
    const key = await root.crypto.subtle.importKey(
      'raw',
      encoder.encode(secretText),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signature = await root.crypto.subtle.sign('HMAC', key, encoder.encode(canonicalText));
    return Array.from(new Uint8Array(signature)).map((item) => item.toString(16).padStart(2, '0')).join('');
  }

  function buildCanonicalString({ method, path, timestamp, nonce, bodyHash }) {
    if (root?.WatchlistApiUtils?.buildCanonicalString) {
      return root.WatchlistApiUtils.buildCanonicalString({
        method,
        path,
        timestamp,
        nonce,
        bodyHash
      });
    }
    return [
      String(method || 'POST').toUpperCase(),
      String(path || '/'),
      String(timestamp || ''),
      String(nonce || ''),
      String(bodyHash || '')
    ].join('\n');
  }

  function createNonce(nowMs = Date.now()) {
    if (root?.WatchlistApiUtils?.createNonce) {
      return root.WatchlistApiUtils.createNonce(nowMs);
    }
    if (root?.crypto?.randomUUID) return root.crypto.randomUUID();
    return `nonce-${Number(nowMs).toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }

  async function buildSignedJsonRequest(options = {}) {
    const method = normalizeText(options.method, 'POST').toUpperCase();
    const url = normalizeText(options.url);
    const keyId = normalizeText(options.keyId);
    const secret = normalizeText(options.secret);
    if (!url) throw new Error('missing_remote_url');
    if (!keyId || !secret) throw new Error('missing_remote_credentials');
    const endpoint = new URL(url);
    const body = method === 'GET'
      ? ''
      : JSON.stringify(options.body && typeof options.body === 'object' ? options.body : {});
    const timestamp = String(Number.isInteger(options.timestamp) ? options.timestamp : Math.floor(Date.now() / 1000));
    const nonce = normalizeText(options.nonce) || createNonce();
    const bodyHash = await sha256Hex(body);
    const canonical = buildCanonicalString({
      method,
      path: endpoint.pathname || '/',
      timestamp,
      nonce,
      bodyHash
    });
    const signature = await hmacSha256Hex(secret, canonical);
    const headers = {
      'X-Watchlist-Key-Id': keyId,
      'X-Watchlist-Timestamp': timestamp,
      'X-Watchlist-Nonce': nonce,
      'X-Watchlist-Signature': signature
    };
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/json';
    }
    return {
      url: endpoint.toString(),
      method,
      body,
      headers,
      timestamp,
      nonce,
      bodyHash,
      canonical
    };
  }

  return {
    API_RUNNERS_HEARTBEAT_PATH,
    API_JOBS_PATH,
    API_JOBS_CLAIM_PATH,
    normalizeIntakeUrl,
    buildIskraUrl,
    buildRunnerStatusUrl,
    buildJobEventUrl,
    buildJobGetUrl,
    buildSignedJsonRequest
  };
});
