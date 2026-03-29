(function attachWatchlistApiUtils(root, factory) {
  const api = factory(root);
  root.WatchlistApiUtils = api;
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createWatchlistApiUtils(root) {
  const PROBLEM_LOGS_QUERY_PATH = '/api/v1/intake/problem-logs/query';

  function normalizeText(value, fallback = '') {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || fallback;
  }

  function isLoopbackHost(rawHost) {
    const host = normalizeText(rawHost).toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  }

  function normalizeWatchlistIntakeUrl(rawUrl) {
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

  function buildProblemLogsQueryUrl(rawIntakeUrl) {
    const normalized = normalizeWatchlistIntakeUrl(rawIntakeUrl);
    if (!normalized) return '';
    try {
      const parsed = new URL(normalized);
      const pathname = typeof parsed.pathname === 'string' ? parsed.pathname : '';
      if (/\/problem-logs\/query\/?$/i.test(pathname)) {
        parsed.pathname = pathname.replace(/\/+$/, '');
      } else if (/\/economist-response\/?$/i.test(pathname)) {
        parsed.pathname = pathname.replace(/\/economist-response\/?$/i, '/problem-logs/query');
      } else {
        parsed.pathname = PROBLEM_LOGS_QUERY_PATH;
      }
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return '';
    }
  }

  function buildCanonicalString({ method, path, timestamp, nonce, bodyHash }) {
    return [
      String(method || 'POST').toUpperCase(),
      String(path || '/'),
      String(timestamp || ''),
      String(nonce || ''),
      String(bodyHash || '')
    ].join('\n');
  }

  function randomHex(byteCount = 12) {
    const safeByteCount = Number.isInteger(byteCount) && byteCount > 0 ? byteCount : 12;
    const nodeCrypto = getNodeCrypto();
    if (nodeCrypto && typeof nodeCrypto.randomBytes === 'function') {
      return nodeCrypto.randomBytes(safeByteCount).toString('hex');
    }
    if (root?.crypto?.getRandomValues) {
      const bytes = new Uint8Array(safeByteCount);
      root.crypto.getRandomValues(bytes);
      return Array.from(bytes).map((item) => item.toString(16).padStart(2, '0')).join('');
    }
    return '';
  }

  function createNonce(nowMs = Date.now()) {
    const randomPart = randomHex(12);
    if (randomPart) {
      return `n-${Number(nowMs || Date.now()).toString(36)}-${randomPart}`;
    }
    return `n-${Number(nowMs || Date.now()).toString(36)}-${Date.now().toString(16)}`;
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
    const data = encoder.encode(text);
    const digest = await root.crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest)).map((item) => item.toString(16).padStart(2, '0')).join('');
  }

  async function hmacSha256Hex(secret, canonical) {
    const secretText = normalizeText(secret);
    const canonicalText = typeof canonical === 'string' ? canonical : String(canonical ?? '');
    const nodeCrypto = getNodeCrypto();
    if (nodeCrypto) {
      return nodeCrypto.createHmac('sha256', secretText).update(canonicalText).digest('hex');
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

  function buildProblemLogsQueryPayload(options = {}) {
    const rawLimit = Number.isInteger(options.limit) ? options.limit : Number.parseInt(options.limit, 10);
    const rawMinutes = Number.isInteger(options.minutes) ? options.minutes : Number.parseInt(options.minutes, 10);
    const rawSinceEventId = Number.isInteger(options.sinceEventId)
      ? options.sinceEventId
      : (Number.isInteger(options.since_event_id) ? options.since_event_id : Number.parseInt(options.since_event_id, 10));
    const limit = Number.isInteger(rawLimit) ? Math.max(1, Math.min(rawLimit, 500)) : 100;
    const minutes = Number.isInteger(rawMinutes) ? Math.max(1, Math.min(rawMinutes, 14 * 24 * 60)) : (24 * 60);
    const sinceEventId = Number.isInteger(rawSinceEventId)
      ? Math.max(0, rawSinceEventId)
      : 0;
    const supportId = normalizeText(options.supportId || options.support_id);
    const payload = { limit, minutes };
    if (sinceEventId > 0) payload.sinceEventId = sinceEventId;
    if (supportId) payload.supportId = supportId;
    return payload;
  }

  async function buildSignedProblemLogsQueryRequest(options = {}) {
    const endpointUrl = buildProblemLogsQueryUrl(options.problemLogsUrl || options.intakeUrl || '');
    if (!endpointUrl) {
      throw new Error('invalid_problem_logs_url');
    }
    const keyId = normalizeText(options.keyId);
    const secret = normalizeText(options.secret);
    if (!keyId || !secret) {
      throw new Error('missing_problem_log_credentials');
    }

    const requestPayload = buildProblemLogsQueryPayload(options);
    const body = JSON.stringify(requestPayload);
    const timestamp = String(
      Number.isInteger(options.timestamp)
        ? options.timestamp
        : Math.floor(Date.now() / 1000)
    );
    const nonce = normalizeText(options.nonce) || createNonce();
    const endpoint = new URL(endpointUrl);
    const bodyHash = await sha256Hex(body);
    const canonical = buildCanonicalString({
      method: 'POST',
      path: endpoint.pathname || '/',
      timestamp,
      nonce,
      bodyHash
    });
    const signature = await hmacSha256Hex(secret, canonical);
    return {
      url: endpoint.toString(),
      method: 'POST',
      requestPayload,
      body,
      timestamp,
      nonce,
      bodyHash,
      canonical,
      headers: {
        'Content-Type': 'application/json',
        'X-Watchlist-Key-Id': keyId,
        'X-Watchlist-Timestamp': timestamp,
        'X-Watchlist-Nonce': nonce,
        'X-Watchlist-Signature': signature
      }
    };
  }

  return {
    PROBLEM_LOGS_QUERY_PATH,
    normalizeWatchlistIntakeUrl,
    buildProblemLogsQueryUrl,
    buildProblemLogsQueryPayload,
    buildCanonicalString,
    createNonce,
    sha256Hex,
    hmacSha256Hex,
    buildSignedProblemLogsQueryRequest
  };
});
