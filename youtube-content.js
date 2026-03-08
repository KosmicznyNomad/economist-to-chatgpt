// YouTube content script: captures caption tracks and returns transcript on demand.
// Loaded automatically on youtube.com / youtu.be pages.

const CAPTURE_DELAY_MS = 500;
const CAPTURE_RETRY_DELAY_MS = 350;
const CAPTURE_MAX_ATTEMPTS = 16;
const URL_POLL_INTERVAL_MS = 4000;
const MIN_TRANSCRIPT_CHARS = 30;
const TRANSCRIPT_CACHE_TTL_MS = 5 * 60 * 1000;
const TRANSCRIPT_CACHE_MAX_ITEMS = 20;

let captureTimerId = null;
let lastObservedUrl = window.location.href;
const transcriptResponseCache = new Map();
window.__iskraYtTranscriptScriptReady = true;

console.log('[yt-transcript] content script initialized');

function summarizeContentErrorValue(rawValue) {
  if (rawValue == null) return '';
  if (typeof rawValue === 'string') return rawValue.trim();
  if (rawValue instanceof Error) return (rawValue.stack || rawValue.message || rawValue.name || '').trim();
  try {
    return JSON.stringify(rawValue);
  } catch {
    return String(rawValue);
  }
}

function reportProblemLogFromContent(rawEntry = {}) {
  const source = typeof rawEntry?.source === 'string' && rawEntry.source.trim()
    ? rawEntry.source.trim()
    : 'youtube-content';
  const message = typeof rawEntry?.message === 'string' && rawEntry.message.trim()
    ? rawEntry.message.trim()
    : 'youtube_content_problem';
  const error = typeof rawEntry?.error === 'string' ? rawEntry.error.trim() : '';
  const reason = typeof rawEntry?.reason === 'string' ? rawEntry.reason.trim() : '';
  const signature = typeof rawEntry?.signature === 'string' && rawEntry.signature.trim()
    ? rawEntry.signature.trim()
    : ['youtube-content', source, rawEntry?.title || '', reason, error, message].join('|');
  try {
    chrome.runtime.sendMessage({
      type: 'REPORT_PROBLEM_LOG',
      entry: {
        level: rawEntry?.level === 'warn' ? 'warn' : 'error',
        source,
        title: typeof rawEntry?.title === 'string' ? rawEntry.title : '',
        reason,
        error,
        message,
        signature
      }
    }, () => {});
  } catch {
    // Ignore runtime bridge errors in content script.
  }
}

function installYoutubeContentRuntimeProblemLogging() {
  window.addEventListener('error', (event) => {
    const fileName = typeof event?.filename === 'string' ? event.filename.trim() : '';
    const lineNo = Number.isInteger(event?.lineno) ? event.lineno : null;
    const colNo = Number.isInteger(event?.colno) ? event.colno : null;
    const location = fileName
      ? `${fileName}${lineNo !== null ? `:${lineNo}` : ''}${colNo !== null ? `:${colNo}` : ''}`
      : '';
    const errorText = summarizeContentErrorValue(event?.error || event?.message || '');
    reportProblemLogFromContent({
      source: 'youtube-content-window',
      title: 'YouTube content runtime error',
      reason: location || 'youtube_content_error',
      error: errorText,
      message: typeof event?.message === 'string' && event.message.trim()
        ? event.message.trim()
        : (errorText || 'youtube_content_runtime_error')
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reasonText = summarizeContentErrorValue(event?.reason);
    reportProblemLogFromContent({
      source: 'youtube-content-window',
      title: 'YouTube content unhandled rejection',
      reason: 'unhandledrejection',
      error: reasonText,
      message: reasonText || 'youtube_content_unhandled_rejection'
    });
  });
}

installYoutubeContentRuntimeProblemLogging();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractVideoId(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = (url.hostname || '').toLowerCase();
    if (host.includes('youtube.com')) {
      const queryVideoId = (url.searchParams.get('v') || '').trim();
      if (queryVideoId) return queryVideoId;
      const pathParts = (url.pathname || '').split('/').filter(Boolean);
      if (pathParts[0] === 'shorts' || pathParts[0] === 'live' || pathParts[0] === 'embed' || pathParts[0] === 'v') {
        const pathVideoId = String(pathParts[1] || '').trim();
        return pathVideoId || null;
      }
      return null;
    }
    if (host.includes('youtu.be')) {
      const videoId = (url.pathname || '').replace(/^\/+/, '').split('/')[0].trim();
      return videoId || null;
    }
    return null;
  } catch (error) {
    console.warn('[yt-transcript] extractVideoId failed:', error);
    return null;
  }
}

function decodeEntities(value) {
  if (!value) return '';
  const textarea = document.createElement('textarea');
  textarea.innerHTML = String(value);
  return textarea.value;
}

function normalizeTranscriptText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function setTranscriptData(payload) {
  window._ytTranscriptData = payload;
}

function setCaptureError(videoId, errorCode, error, attempt = 0) {
  setTranscriptData({
    success: false,
    videoId: videoId || '',
    captionTracks: [],
    capturedAt: Date.now(),
    attempt,
    errorCode,
    error: String(error || errorCode || 'capture_failed'),
  });
}

function getCaptionTracksFromPlayerResponse(playerResponse) {
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  return Array.isArray(tracks) ? tracks : [];
}

function extractJsonObjectAfterToken(source, token) {
  if (typeof source !== 'string' || !source) return null;
  const tokenIndex = source.indexOf(token);
  if (tokenIndex < 0) return null;

  const startIndex = source.indexOf('{', tokenIndex);
  if (startIndex < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < source.length; i += 1) {
    const char = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startIndex, i + 1);
      }
    }
  }

  return null;
}

function readPlayerResponseFromScripts() {
  const scripts = document.querySelectorAll('script');
  const tokens = [
    'ytInitialPlayerResponse =',
    'window.ytInitialPlayerResponse =',
    '"ytInitialPlayerResponse":',
  ];

  for (const script of scripts) {
    const content = script.textContent || script.innerText || '';
    if (!content) continue;

    for (const token of tokens) {
      const objectText = extractJsonObjectAfterToken(content, token);
      if (!objectText) continue;
      try {
        return JSON.parse(objectText);
      } catch (error) {
        // Keep scanning; YouTube script payload shape may vary.
      }
    }
  }

  return null;
}

function readPlayerResponse() {
  if (window.ytInitialPlayerResponse && typeof window.ytInitialPlayerResponse === 'object') {
    return window.ytInitialPlayerResponse;
  }

  const ytPlayerResponseText = window?.ytplayer?.config?.args?.player_response;
  if (typeof ytPlayerResponseText === 'string' && ytPlayerResponseText.trim()) {
    try {
      return JSON.parse(ytPlayerResponseText);
    } catch (error) {
      // Keep fallback path.
    }
  }

  return readPlayerResponseFromScripts();
}

function normalizeCaptionTrack(rawTrack) {
  if (!rawTrack || typeof rawTrack !== 'object') return null;
  const languageCode = String(rawTrack.languageCode || '').trim();
  const baseUrl = String(rawTrack.baseUrl || '').trim();
  if (!languageCode || !baseUrl) return null;
  return {
    languageCode,
    baseUrl,
    kind: String(rawTrack.kind || '').trim(),
    vssId: String(rawTrack.vssId || '').trim(),
    name: {
      simpleText: String(rawTrack?.name?.simpleText || rawTrack.languageName || languageCode).trim(),
    },
  };
}

async function readCaptionTracksFromPageContext(videoId, timeoutMs = 1200) {
  const requestId = `iskra-yt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  return new Promise((resolve) => {
    let done = false;
    let timeoutId = null;

    function finish(result) {
      if (done) return;
      done = true;
      if (timeoutId) clearTimeout(timeoutId);
      window.removeEventListener('message', onMessage);
      resolve(result);
    }

    function onMessage(event) {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.source !== 'iskra-yt-transcript') return;
      if (data.requestId !== requestId) return;

      const tracksRaw = Array.isArray(data.captionTracks) ? data.captionTracks : [];
      const tracks = tracksRaw
        .map((track) => normalizeCaptionTrack(track))
        .filter(Boolean);

      if (tracks.length > 0) {
        finish({
          success: true,
          videoId: String(data.videoId || videoId || '').trim(),
          captionTracks: tracks,
          errorCode: '',
          error: '',
        });
        return;
      }

      finish({
        success: false,
        videoId: String(videoId || '').trim(),
        captionTracks: [],
        errorCode: 'player_response_missing',
        error: String(data.error || 'No caption tracks from page context'),
      });
    }

    window.addEventListener('message', onMessage);

    const script = document.createElement('script');
    script.textContent = `
      (function () {
        var payload = {
          source: 'iskra-yt-transcript',
          requestId: ${JSON.stringify(requestId)},
          videoId: '',
          captionTracks: [],
          error: ''
        };
        try {
          var url = new URL(window.location.href);
          payload.videoId = (url.searchParams.get('v') || '').trim();
          if (!payload.videoId) {
            var pathParts = (url.pathname || '').split('/').filter(Boolean);
            if (
              pathParts[0] === 'shorts'
              || pathParts[0] === 'live'
              || pathParts[0] === 'embed'
              || pathParts[0] === 'v'
            ) {
              payload.videoId = String(pathParts[1] || '').trim();
            }
          }
          var playerResponse = null;
          if (window.ytInitialPlayerResponse && typeof window.ytInitialPlayerResponse === 'object') {
            playerResponse = window.ytInitialPlayerResponse;
          } else if (window.ytcfg && typeof window.ytcfg.get === 'function') {
            var cfgResponse = window.ytcfg.get('PLAYER_RESPONSE');
            if (cfgResponse && typeof cfgResponse === 'object') {
              playerResponse = cfgResponse;
            } else if (typeof cfgResponse === 'string' && cfgResponse) {
              try { playerResponse = JSON.parse(cfgResponse); } catch (cfgError) {}
            }
          }
          if (!playerResponse && window.ytplayer && window.ytplayer.config && window.ytplayer.config.args) {
            var raw = window.ytplayer.config.args.player_response;
            if (typeof raw === 'string' && raw) {
              try { playerResponse = JSON.parse(raw); } catch (jsonError) {}
            }
          }
          var tracks = playerResponse && playerResponse.captions && playerResponse.captions.playerCaptionsTracklistRenderer
            ? playerResponse.captions.playerCaptionsTracklistRenderer.captionTracks
            : [];
          if (Array.isArray(tracks)) {
            payload.captionTracks = tracks.map(function (track) {
              return {
                languageCode: track && track.languageCode ? track.languageCode : '',
                baseUrl: track && track.baseUrl ? track.baseUrl : '',
                kind: track && track.kind ? track.kind : '',
                vssId: track && track.vssId ? track.vssId : '',
                name: track && track.name && track.name.simpleText ? { simpleText: track.name.simpleText } : { simpleText: '' }
              };
            });
          }
          if (!payload.captionTracks || payload.captionTracks.length === 0) {
            payload.error = 'No caption tracks in page context';
          }
        } catch (error) {
          payload.error = error && error.message ? error.message : 'page_context_error';
        }
        window.postMessage(payload, '*');
      })();
    `;

    script.addEventListener('error', () => {
      finish({
        success: false,
        videoId: String(videoId || '').trim(),
        captionTracks: [],
        errorCode: 'player_response_missing',
        error: 'Failed to execute page context script',
      });
    });

    (document.documentElement || document.head || document.body).appendChild(script);
    script.remove();

    timeoutId = setTimeout(() => {
      finish({
        success: false,
        videoId: String(videoId || '').trim(),
        captionTracks: [],
        errorCode: 'player_response_missing',
        error: 'Page context transcript probe timeout',
      });
    }, Math.max(250, timeoutMs));
  });
}

function buildTimedtextTrackBaseUrl(videoId, trackMeta) {
  const params = new URLSearchParams();
  params.set('v', String(videoId || '').trim());
  params.set('lang', String(trackMeta?.languageCode || '').trim());

  const kind = String(trackMeta?.kind || '').trim();
  if (kind) {
    params.set('kind', kind);
  }

  const name = String(trackMeta?.name || '').trim();
  if (name) {
    params.set('name', name);
  }

  return `https://www.youtube.com/api/timedtext?${params.toString()}`;
}

function parseTimedtextTrackList(xmlText, videoId) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlText, 'text/xml');
  const parserErrors = xmlDoc.querySelectorAll('parsererror');
  if (parserErrors.length > 0) {
    return [];
  }

  const trackNodes = Array.from(xmlDoc.querySelectorAll('track'));
  const tracks = [];

  for (const node of trackNodes) {
    const languageCode = String(node.getAttribute('lang_code') || '').trim();
    if (!languageCode) continue;

    const name = decodeEntities(node.getAttribute('name') || '');
    const kind = String(node.getAttribute('kind') || '').trim();
    const vssId = String(node.getAttribute('vss_id') || '').trim();
    const simpleText = name || languageCode;

    tracks.push({
      languageCode,
      kind,
      vssId,
      name: { simpleText },
      baseUrl: buildTimedtextTrackBaseUrl(videoId, {
        languageCode,
        kind,
        name,
      }),
    });
  }

  return tracks;
}

async function fetchTimedtextTrackList(videoId) {
  const params = new URLSearchParams();
  params.set('type', 'list');
  params.set('v', String(videoId || '').trim());
  const url = `https://www.youtube.com/api/timedtext?${params.toString()}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: '*/*' },
    });
    if (!response.ok) {
      return {
        success: false,
        captionTracks: [],
        errorCode: 'timedtext_list_fetch_failed',
        error: `timedtext_list_http_${response.status}`,
      };
    }

    const bodyText = await response.text();
    if (!bodyText || bodyText.length < 5) {
      return {
        success: false,
        captionTracks: [],
        errorCode: 'caption_tracks_missing',
        error: 'Timedtext list is empty',
      };
    }

    const captionTracks = parseTimedtextTrackList(bodyText, videoId);
    if (!Array.isArray(captionTracks) || captionTracks.length === 0) {
      return {
        success: false,
        captionTracks: [],
        errorCode: 'caption_tracks_missing',
        error: 'No caption tracks in timedtext list',
      };
    }

    return {
      success: true,
      captionTracks,
      errorCode: '',
      error: '',
    };
  } catch (error) {
    return {
      success: false,
      captionTracks: [],
      errorCode: 'timedtext_list_fetch_failed',
      error: error?.message || 'timedtext_list_fetch_failed',
    };
  }
}

async function resolveCaptionTracks(videoId, attempt) {
  const resolvedVideoId = String(videoId || extractVideoId(window.location.href) || '').trim();
  if (!resolvedVideoId) {
    setCaptureError('', 'video_id_missing', 'No video ID in URL', attempt);
    return {
      success: false,
      videoId: '',
      captionTracks: [],
      errorCode: 'video_id_missing',
      error: 'No video ID in URL',
    };
  }

  const directCapture = captureYouTubeData(attempt);
  if (
    directCapture.success &&
    Array.isArray(directCapture.captionTracks) &&
    directCapture.captionTracks.length > 0
  ) {
    return directCapture;
  }

  const pageContextResult = await readCaptionTracksFromPageContext(resolvedVideoId);
  if (
    pageContextResult.success &&
    Array.isArray(pageContextResult.captionTracks) &&
    pageContextResult.captionTracks.length > 0
  ) {
    setTranscriptData({
      success: true,
      videoId: resolvedVideoId,
      captionTracks: pageContextResult.captionTracks,
      capturedAt: Date.now(),
      attempt,
      source: 'page_context',
      errorCode: '',
      error: '',
    });
    return {
      success: true,
      videoId: resolvedVideoId,
      captionTracks: pageContextResult.captionTracks,
      errorCode: '',
      error: '',
    };
  }

  const timedtextResult = await fetchTimedtextTrackList(resolvedVideoId);
  if (
    timedtextResult.success &&
    Array.isArray(timedtextResult.captionTracks) &&
    timedtextResult.captionTracks.length > 0
  ) {
    setTranscriptData({
      success: true,
      videoId: resolvedVideoId,
      captionTracks: timedtextResult.captionTracks,
      capturedAt: Date.now(),
      attempt,
      source: 'timedtext_list',
      errorCode: '',
      error: '',
    });
    return {
      success: true,
      videoId: resolvedVideoId,
      captionTracks: timedtextResult.captionTracks,
      errorCode: '',
      error: '',
    };
  }

  setCaptureError(
    resolvedVideoId,
    timedtextResult.errorCode || directCapture.errorCode,
    timedtextResult.error || directCapture.error,
    attempt
  );
  return {
    success: false,
    videoId: resolvedVideoId,
    captionTracks: [],
    errorCode: timedtextResult.errorCode || directCapture.errorCode || 'caption_tracks_missing',
    error: timedtextResult.error || directCapture.error || 'No caption tracks available',
  };
}

function captureYouTubeData(attempt = 1) {
  const videoId = extractVideoId(window.location.href);
  if (!videoId) {
    setCaptureError('', 'video_id_missing', 'No video ID in URL', attempt);
    return { success: false, videoId: '', captionTracks: [], errorCode: 'video_id_missing' };
  }

  const playerResponse = readPlayerResponse();
  if (!playerResponse) {
    setCaptureError(videoId, 'player_response_missing', 'ytInitialPlayerResponse not found', attempt);
    return { success: false, videoId, captionTracks: [], errorCode: 'player_response_missing' };
  }

  const captionTracks = getCaptionTracksFromPlayerResponse(playerResponse);
  if (captionTracks.length === 0) {
    setCaptureError(videoId, 'caption_tracks_missing', 'No caption tracks available', attempt);
    return { success: false, videoId, captionTracks: [], errorCode: 'caption_tracks_missing' };
  }

  setTranscriptData({
    success: true,
    videoId,
    captionTracks,
    capturedAt: Date.now(),
    attempt,
    errorCode: '',
    error: '',
  });

  return { success: true, videoId, captionTracks, errorCode: '' };
}

function normalizeLanguageCode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  return raw.split('-')[0];
}

function normalizePreferredLanguages(preferredLanguages) {
  return Array.from(
    new Set(
      (Array.isArray(preferredLanguages) ? preferredLanguages : [])
        .map((item) => normalizeLanguageCode(item))
        .filter(Boolean)
    )
  );
}

function buildTranscriptCacheKey(videoId, preferredLanguages) {
  const normalizedVideoId = String(videoId || '').trim();
  if (!normalizedVideoId) return '';
  const preferred = normalizePreferredLanguages(preferredLanguages);
  return `${normalizedVideoId}::${preferred.join(',') || 'default'}`;
}

function pruneTranscriptResponseCache() {
  const now = Date.now();
  for (const [cacheKey, entry] of transcriptResponseCache.entries()) {
    if (!entry || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= now) {
      transcriptResponseCache.delete(cacheKey);
    }
  }
  while (transcriptResponseCache.size > TRANSCRIPT_CACHE_MAX_ITEMS) {
    const oldestKey = transcriptResponseCache.keys().next().value;
    if (!oldestKey) break;
    transcriptResponseCache.delete(oldestKey);
  }
}

function getCachedTranscriptResponse(videoId, preferredLanguages) {
  const cacheKey = buildTranscriptCacheKey(videoId, preferredLanguages);
  if (!cacheKey) return null;
  pruneTranscriptResponseCache();
  const entry = transcriptResponseCache.get(cacheKey);
  if (!entry || !entry.response) return null;
  return {
    ...entry.response,
    cacheHit: true,
  };
}

function setCachedTranscriptResponse(response, preferredLanguages) {
  if (!response || response.success !== true) return;
  const cacheKey = buildTranscriptCacheKey(response.videoId, preferredLanguages);
  if (!cacheKey) return;
  pruneTranscriptResponseCache();
  if (transcriptResponseCache.has(cacheKey)) {
    transcriptResponseCache.delete(cacheKey);
  }
  transcriptResponseCache.set(cacheKey, {
    expiresAt: Date.now() + TRANSCRIPT_CACHE_TTL_MS,
    response: {
      ...response,
      cacheHit: false,
    },
  });
  pruneTranscriptResponseCache();
}

function isAutoGeneratedTrack(track) {
  if (!track || typeof track !== 'object') return false;
  if (String(track.kind || '').toLowerCase() === 'asr') return true;
  if (String(track.vssId || '').toLowerCase().startsWith('a.')) return true;
  const trackName = String(track?.name?.simpleText || '').toLowerCase();
  return trackName.includes('auto-generated') || trackName.includes('automatyczne');
}

function pickPreferredTrackVariant(trackCandidates) {
  if (!Array.isArray(trackCandidates) || trackCandidates.length === 0) return null;
  const manualTrack = trackCandidates.find((track) => !isAutoGeneratedTrack(track));
  return manualTrack || trackCandidates[0] || null;
}

function pickCaptionTrack(captionTracks, preferredLanguages) {
  const tracks = Array.isArray(captionTracks) ? captionTracks : [];
  if (tracks.length === 0) return null;
  const preferred = normalizePreferredLanguages(preferredLanguages);

  for (const lang of preferred) {
    const exactMatches = tracks.filter((track) => normalizeLanguageCode(track?.languageCode) === lang);
    const exactPreferred = pickPreferredTrackVariant(exactMatches);
    if (exactPreferred) return exactPreferred;
  }

  for (const lang of preferred) {
    const prefixMatches = tracks.filter((track) => String(track?.languageCode || '').toLowerCase().startsWith(`${lang}-`));
    const prefixPreferred = pickPreferredTrackVariant(prefixMatches);
    if (prefixPreferred) return prefixPreferred;
  }

  const manualTrack = tracks.find((track) => !isAutoGeneratedTrack(track));
  if (manualTrack) return manualTrack;

  return tracks[0];
}

function parseJson3Transcript(bodyText) {
  const parsed = JSON.parse(bodyText);
  const events = Array.isArray(parsed?.events) ? parsed.events : [];
  const chunks = [];

  for (const event of events) {
    if (!Array.isArray(event?.segs)) continue;
    for (const seg of event.segs) {
      const utf8 = decodeEntities(seg?.utf8 || '');
      if (!utf8) continue;
      chunks.push(utf8);
    }
  }

  return normalizeTranscriptText(chunks.join(' '));
}

function parseXmlTranscript(bodyText) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(bodyText, 'text/xml');
  if (xmlDoc.querySelector('parsererror')) return '';
  const textNodes = xmlDoc.querySelectorAll('text');
  const chunks = [];

  for (const textNode of textNodes) {
    const value = decodeEntities(textNode?.textContent || '');
    if (!value) continue;
    chunks.push(value);
  }

  return normalizeTranscriptText(chunks.join(' '));
}

function buildCaptionFetchUrl(baseUrl, format) {
  try {
    const url = new URL(baseUrl);
    if (!format || format === 'xml') {
      url.searchParams.delete('fmt');
    } else {
      url.searchParams.set('fmt', format);
    }
    return url.toString();
  } catch (error) {
    if (!format || format === 'xml') return baseUrl;
    const separator = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${separator}fmt=${encodeURIComponent(format)}`;
  }
}

async function fetchTranscriptForTrack(track) {
  const baseUrl = String(track?.baseUrl || '').trim();
  if (!baseUrl) {
    return {
      success: false,
      transcript: '',
      method: 'none',
      errorCode: 'track_base_url_missing',
      error: 'Missing baseUrl in caption track',
    };
  }

  const formats = [
    { method: 'json3', format: 'json3', parser: parseJson3Transcript },
    { method: 'srv3', format: 'srv3', parser: parseXmlTranscript },
    { method: 'xml', format: 'xml', parser: parseXmlTranscript },
  ];

  let lastError = null;

  for (const format of formats) {
    try {
      const response = await fetch(buildCaptionFetchUrl(baseUrl, format.format), {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: '*/*' },
      });

      if (!response.ok) {
        lastError = `${format.method}:http_${response.status}`;
        continue;
      }

      const bodyText = await response.text();
      if (!bodyText || bodyText.length < 10) {
        lastError = `${format.method}:empty_body`;
        continue;
      }

      const transcript = format.parser(bodyText);
      if (!transcript || transcript.length < MIN_TRANSCRIPT_CHARS) {
        lastError = `${format.method}:too_short`;
        continue;
      }

      return {
        success: true,
        transcript,
        method: format.method,
        errorCode: '',
        error: '',
      };
    } catch (error) {
      lastError = `${format.method}:${error?.message || 'fetch_failed'}`;
    }
  }

  return {
    success: false,
    transcript: '',
    method: 'none',
    errorCode: 'transcript_fetch_failed',
    error: lastError || 'Unable to fetch transcript from caption track',
  };
}

async function waitForCaptionTracks(videoId, timeoutMs) {
  const startedAt = Date.now();
  let attempt = 0;

  while (Date.now() - startedAt < timeoutMs) {
    attempt += 1;
    const captureResult = await resolveCaptionTracks(videoId, attempt);

    if (
      captureResult.success &&
      captureResult.videoId === videoId &&
      Array.isArray(captureResult.captionTracks) &&
      captureResult.captionTracks.length > 0
    ) {
      return captureResult;
    }

    await sleep(CAPTURE_RETRY_DELAY_MS);
  }

  const data = window._ytTranscriptData || {};
  return {
    success: false,
    videoId,
    captionTracks: [],
    errorCode: data.errorCode || 'caption_tracks_timeout',
    error: data.error || 'Timed out while waiting for caption tracks',
  };
}

async function fetchTranscript(request = {}) {
  const preferredLanguages = normalizePreferredLanguages(
    Array.isArray(request?.preferredLanguages) ? request.preferredLanguages : ['pl', 'en']
  );
  const timeoutMsRaw = Number.isInteger(request?.timeoutMs) ? request.timeoutMs : CAPTURE_MAX_ATTEMPTS * CAPTURE_RETRY_DELAY_MS;
  const timeoutMs = Math.max(1000, Math.min(30000, timeoutMsRaw));

  const videoId = extractVideoId(window.location.href);
  if (!videoId) {
    return {
      success: false,
      transcript: '',
      lang: '',
      method: 'none',
      videoId: '',
      errorCode: 'not_video_page',
      error: 'Current page does not contain a YouTube video ID',
      title: document.title || '',
      cacheHit: false,
    };
  }

  const cachedResponse = getCachedTranscriptResponse(videoId, preferredLanguages);
  if (cachedResponse && cachedResponse.success) {
    return cachedResponse;
  }

  const captureResult = await waitForCaptionTracks(videoId, timeoutMs);
  if (!captureResult.success) {
    return {
      success: false,
      transcript: '',
      lang: '',
      method: 'none',
      videoId,
      errorCode: captureResult.errorCode || 'caption_tracks_missing',
      error: captureResult.error || 'No caption tracks available',
      title: document.title || '',
      cacheHit: false,
    };
  }

  const selectedTrack = pickCaptionTrack(captureResult.captionTracks, preferredLanguages);
  if (!selectedTrack) {
    return {
      success: false,
      transcript: '',
      lang: '',
      method: 'none',
      videoId,
      errorCode: 'caption_tracks_missing',
      error: 'No caption tracks available',
      title: document.title || '',
      cacheHit: false,
    };
  }

  const trackFetch = await fetchTranscriptForTrack(selectedTrack);
  if (!trackFetch.success) {
    return {
      success: false,
      transcript: '',
      lang: '',
      method: trackFetch.method || 'none',
      videoId,
      errorCode: trackFetch.errorCode || 'transcript_fetch_failed',
      error: trackFetch.error || 'Failed to fetch transcript',
      title: document.title || '',
      cacheHit: false,
    };
  }

  const languageCode = String(selectedTrack.languageCode || '').trim();
  const response = {
    success: true,
    transcript: trackFetch.transcript,
    lang: languageCode || 'unknown',
    method: trackFetch.method || 'unknown',
    videoId,
    errorCode: '',
    error: '',
    title: document.title || '',
    cacheHit: false,
  };
  setCachedTranscriptResponse(response, preferredLanguages);
  return response;
}

function scheduleCapture(reason) {
  if (captureTimerId) {
    clearTimeout(captureTimerId);
  }
  captureTimerId = setTimeout(() => {
    captureTimerId = null;
    resolveCaptionTracks(extractVideoId(window.location.href), 1).then((result) => {
      if (!result.success) {
        console.log('[yt-transcript] capture pending:', { reason, errorCode: result.errorCode, videoId: result.videoId });
      }
    }).catch((error) => {
      console.warn('[yt-transcript] scheduleCapture failed:', error);
    });
  }, CAPTURE_DELAY_MS);
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || typeof request !== 'object') return false;

  if (request.type === 'GET_TRANSCRIPT') {
    (async () => {
      try {
        const result = await fetchTranscript(request);
        sendResponse(result);
      } catch (error) {
        sendResponse({
          success: false,
          transcript: '',
          lang: '',
          method: 'none',
          videoId: extractVideoId(window.location.href) || '',
          errorCode: 'runtime_error',
          error: error?.message || 'runtime_error',
          title: document.title || '',
        });
      }
    })();
    return true;
  }

  if (request.type === 'CHECK_TRANSCRIPT_DATA') {
    const data = window._ytTranscriptData || {};
    sendResponse({
      success: !!data.success,
      hasData: !!window._ytTranscriptData,
      videoId: data.videoId || '',
      hasCaptionTracks: Array.isArray(data.captionTracks) && data.captionTracks.length > 0,
      captionTrackCount: Array.isArray(data.captionTracks) ? data.captionTracks.length : 0,
      errorCode: data.errorCode || '',
      error: data.error || '',
      capturedAt: data.capturedAt || 0,
      url: window.location.href,
    });
    return true;
  }

  return false;
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => scheduleCapture('dom_ready'), { once: true });
} else {
  scheduleCapture('ready_state_complete');
}

window.addEventListener('yt-navigate-finish', () => scheduleCapture('yt_navigate_finish'));
window.addEventListener('yt-page-data-updated', () => scheduleCapture('yt_page_data_updated'));
window.addEventListener('popstate', () => scheduleCapture('popstate'));

setInterval(() => {
  const currentUrl = window.location.href;
  if (currentUrl !== lastObservedUrl) {
    lastObservedUrl = currentUrl;
    scheduleCapture('url_changed');
  }
}, URL_POLL_INTERVAL_MS);
