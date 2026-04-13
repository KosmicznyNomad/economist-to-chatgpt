// responses.js - zarzÄ…dzanie listÄ… odpowiedzi z podziaĹ‚em na analiza spĂłĹ‚ki i portfela

const companyResponsesList = document.getElementById('companyResponsesList');
const companyEmptyState = document.getElementById('companyEmptyState');
const responseCount = document.getElementById('responseCount');
const companyCount = document.getElementById('companyCount');
const marketCount = document.getElementById('marketCount');
const marketStatus = document.getElementById('marketStatus');
const companyEmptyStateTitle = companyEmptyState ? companyEmptyState.querySelector('h2') : null;
const companyEmptyStateBody = companyEmptyState ? companyEmptyState.querySelector('p') : null;
const marketTable = document.getElementById('marketTable');
const marketTableBody = marketTable ? marketTable.querySelector('tbody') : null;
const marketToolbar = document.getElementById('marketToolbar');
const marketFilterLabel = document.getElementById('marketFilterLabel');
const marketSectorFilters = document.getElementById('marketSectorFilters');
const marketCompanySearch = document.getElementById('marketCompanySearch');
const marketSearchSuggestions = document.getElementById('marketSearchSuggestions');
const marketSortableHeaders = marketTable
  ? Array.from(marketTable.querySelectorAll('th.sortable[data-sort-key]'))
  : [];
const clearBtn = document.getElementById('clearBtn');
const copyAllCompanyBtn = document.getElementById('copyAllCompanyBtn');
const copyAllCompanyWithLinkBtn = document.getElementById('copyAllCompanyWithLinkBtn');
const companySortSelect = document.getElementById('companySortSelect');

const DecisionContractUtils = globalThis.DecisionContractUtils || {};
const ResponseStorageUtils = globalThis.ResponseStorageUtils || {};
const DecisionViewModelUtils = globalThis.DecisionViewModelUtils || {};
const RESPONSE_STORAGE_KEY = ResponseStorageUtils.RESPONSE_STORAGE_KEY || 'responses';
let responseStorageReady = Promise.resolve();
let marketRows = [];
let marketSortState = {
  key: 'composite',
  direction: 'desc'
};
let marketFilters = {
  companyQuery: '',
  sector: ''
};
let marketSuggestionItems = [];
let marketSuggestionActiveIndex = -1;
let companySortMode = 'latest';
let lastLoadedResponses = [];
let scheduledResponsesReloadTimer = null;
let responsesReloadInFlight = false;
let responsesReloadQueued = false;

// Clipboard copy counters (in-memory per tab open).
const clipboardCounters = {
  ops: 0,
  opsOk: 0,
  opsFail: 0,
  messagesAttempted: 0,
  messagesCopiedOk: 0,
  messagesCopiedFail: 0
};

function logClipboard(event, extra = {}) {
  // Keep logs ASCII to avoid mojibake in some consoles.
  console.log(`[clipboard] ${event}`, { ...clipboardCounters, ...extra });
}

function getStorageAreas() {
  return typeof ResponseStorageUtils.getStorageAreas === 'function'
    ? ResponseStorageUtils.getStorageAreas()
    : {
      local: chrome.storage?.local || null,
      session: chrome.storage?.session || null
    };
}

function makeResponseKey(response) {
  if (typeof ResponseStorageUtils.buildResponseIdentityKeys !== 'function') return '';
  return ResponseStorageUtils.buildResponseIdentityKeys(response).join('|');
}

function mergeResponses(primary, secondary) {
  return typeof ResponseStorageUtils.mergeResponseCollections === 'function'
    ? ResponseStorageUtils.mergeResponseCollections(primary, secondary, DecisionContractUtils)
    : [];
}

function countWords(text) {
  if (!text) return 0;
  const cleaned = text.trim().replace(/\s+/g, ' ');
  if (!cleaned) return 0;
  return cleaned.split(' ').length;
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms)) return '';
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${seconds} s`;
}

function formatStageLine(response) {
  const stage = response?.stage;
  if (!stage) return '';
  const number = Number.isInteger(stage.number)
    ? stage.number
    : Number.isInteger(stage.index)
      ? stage.index + 1
      : null;
  const name = stage.name || (number ? `Prompt ${number}` : 'Prompt');
  const label = number ? `Etap ${number}: ${name}` : `Etap: ${name}`;
  const parts = [label];
  const durationText = formatDurationMs(stage.durationMs);
  if (durationText) parts.push(durationText);
  const words = Number.isFinite(stage.wordCount) ? stage.wordCount : countWords(response.text || '');
  if (Number.isFinite(words)) parts.push(`${words} slow`);
  return parts.join(' | ');
}

function getResponseDecisionContract(response) {
  return typeof ResponseStorageUtils.buildDecisionContractSummaryForResponse === 'function'
    ? ResponseStorageUtils.buildDecisionContractSummaryForResponse(response, DecisionContractUtils)
    : null;
}

function normalizeDecisionContractSummaryForView(summary) {
  return typeof DecisionContractUtils.normalizeDecisionContractSummary === 'function'
    ? DecisionContractUtils.normalizeDecisionContractSummary(summary)
    : (summary && typeof summary === 'object' ? summary : null);
}

function getDecisionContractRecordByRole(summary, role) {
  if (!summary || typeof summary !== 'object') return null;
  if (role === 'PRIMARY' && typeof DecisionContractUtils.getDecisionContractPrimaryRecord === 'function') {
    return DecisionContractUtils.getDecisionContractPrimaryRecord(summary);
  }
  if (role === 'SECONDARY' && typeof DecisionContractUtils.getDecisionContractSecondaryRecord === 'function') {
    return DecisionContractUtils.getDecisionContractSecondaryRecord(summary);
  }
  const records = Array.isArray(summary.records) ? summary.records : [];
  if (role === 'PRIMARY') {
    return records.find((record) => record?.role === 'PRIMARY') || records[0] || null;
  }
  if (role === 'SECONDARY') {
    return records.find((record) => record?.role === 'SECONDARY') || null;
  }
  return null;
}

function mergeDecisionContractViewRecord(primary, fallback) {
  const left = primary && typeof primary === 'object' ? primary : null;
  const right = fallback && typeof fallback === 'object' ? fallback : null;
  if (!left && !right) return null;
  const result = { ...(right || {}), ...(left || {}) };
  [
    'role',
    'format',
    'decisionDate',
    'decisionStatus',
    'company',
    'composite',
    'entryScore',
    'sizing',
    'voi',
    'fals',
    'primaryRisk',
    'sector',
    'companyFamily',
    'companyType',
    'revenueModel',
    'region',
    'currency'
  ].forEach((key) => {
    const leftValue = typeof left?.[key] === 'string' ? left[key].trim() : '';
    const rightValue = typeof right?.[key] === 'string' ? right[key].trim() : '';
    result[key] = leftValue || rightValue || '';
  });
  ['compositeValue', 'entryScoreValue', 'sizingPercent'].forEach((key) => {
    const leftValue = Number.isFinite(left?.[key]) ? left[key] : Number.NaN;
    const rightValue = Number.isFinite(right?.[key]) ? right[key] : Number.NaN;
    result[key] = Number.isFinite(leftValue) ? leftValue : rightValue;
  });
  return result;
}

function buildResponseDecisionContractView(response) {
  if (typeof DecisionViewModelUtils.buildValidatedStage12State === 'function') {
    return DecisionViewModelUtils.buildValidatedStage12State(response, DecisionContractUtils);
  }
  const storedSummary = response?.decisionContract && typeof response.decisionContract === 'object'
    ? response.decisionContract
    : getResponseDecisionContract(response);
  const summary = normalizeDecisionContractSummaryForView(storedSummary);
  const shouldUseFallbackValidation = typeof DecisionContractUtils.validateDecisionContractText === 'function'
    && typeof response?.text === 'string'
    && response.text.trim()
    && (
      !summary
      || !Array.isArray(summary.records)
      || summary.records.length === 0
      || summary.records.some((record) => !record?.decisionStatus || !record?.decisionDate || !record?.sector)
    );
  const validation = shouldUseFallbackValidation
    ? DecisionContractUtils.validateDecisionContractText(response.text)
    : null;
  const fallbackSummary = normalizeDecisionContractSummaryForView(validation?.decisionContract);
  const effectiveSummary = summary || fallbackSummary;
  const snapshot = typeof DecisionContractUtils.buildDecisionContractSnapshot === 'function'
    ? DecisionContractUtils.buildDecisionContractSnapshot(effectiveSummary)
    : null;
  const fallbackSnapshot = typeof DecisionContractUtils.buildDecisionContractSnapshot === 'function'
    ? DecisionContractUtils.buildDecisionContractSnapshot(fallbackSummary)
    : null;
  const primaryRecord = mergeDecisionContractViewRecord(
    snapshot?.primaryRecord || getDecisionContractRecordByRole(effectiveSummary, 'PRIMARY'),
    fallbackSnapshot?.primaryRecord || getDecisionContractRecordByRole(fallbackSummary, 'PRIMARY')
  );
  const secondaryRecord = mergeDecisionContractViewRecord(
    snapshot?.secondaryRecord || getDecisionContractRecordByRole(effectiveSummary, 'SECONDARY'),
    fallbackSnapshot?.secondaryRecord || getDecisionContractRecordByRole(fallbackSummary, 'SECONDARY')
  );
  const company = normalizeMarketText(
    primaryRecord?.company
      || secondaryRecord?.company
      || snapshot?.company
      || fallbackSnapshot?.company
      || response?.source
      || '',
    ''
  );
  const status = typeof effectiveSummary?.status === 'string'
    ? effectiveSummary.status
    : (typeof fallbackSummary?.status === 'string' ? fallbackSummary.status : 'invalid');
  const issueCodes = Array.isArray(effectiveSummary?.issueCodes) && effectiveSummary.issueCodes.length > 0
    ? effectiveSummary.issueCodes
    : (Array.isArray(fallbackSummary?.issueCodes) ? fallbackSummary.issueCodes : []);
  const recordCount = Number.isInteger(effectiveSummary?.recordCount)
    ? effectiveSummary.recordCount
    : (Number.isInteger(fallbackSummary?.recordCount) ? fallbackSummary.recordCount : 0);

  return {
    summary: effectiveSummary,
    status,
    issueCodes,
    recordCount,
    company,
    primaryRecord,
    secondaryRecord,
    hasDecisionRecord: !!primaryRecord || !!secondaryRecord || recordCount > 0
  };
}

function buildResponseCompanyEntries(response) {
  const view = buildResponseDecisionContractView(response);
  const records = [view?.primaryRecord, view?.secondaryRecord].filter(Boolean);
  const seen = new Set();

  return records
    .map((record) => {
      const company = normalizeMarketText(record?.company);
      if (!company) return null;

      const ticker = normalizeMarketText(extractTickerFromCompany(company));
      const key = `${normalizeMarketToken(company)}|${normalizeMarketToken(ticker || '-')}`;
      if (seen.has(key)) return null;
      seen.add(key);

      const haystack = [
        company,
        ticker,
        record?.role,
        record?.decisionStatus,
        record?.sector,
        record?.region,
        record?.currency
      ].filter(Boolean).join(' ');

      return {
        key,
        company,
        ticker,
        companyFuzzy: normalizeFuzzyText(company),
        tickerFuzzy: normalizeFuzzyText(ticker),
        searchHaystack: normalizeFuzzyText(haystack),
        searchTokens: tokenizeFuzzyText(haystack)
      };
    })
    .filter(Boolean);
}

function responseMatchesCompanyQuery(response, query) {
  const normalizedQuery = normalizeMarketText(query);
  if (!normalizedQuery) return true;

  const entries = buildResponseCompanyEntries(response);
  if (entries.length > 0) {
    return entries.some((entry) => scoreCompanyQueryAgainstRow(normalizedQuery, entry).matched);
  }

  const fallbackHaystack = normalizeFuzzyText(`${response?.source || ''} ${response?.text || ''}`);
  return fallbackHaystack.includes(normalizeFuzzyText(normalizedQuery));
}

function buildResponseCardHeaderModel(response) {
  const sourceInfo = describeResponseSource(response);
  const companyEntries = buildResponseCompanyEntries(response);
  const companies = companyEntries
    .map((entry) => normalizeMarketText(entry?.company))
    .filter(Boolean);
  const title = companies.length > 0 ? companies.join(' / ') : sourceInfo.display;
  const detailParts = [];

  if (companies.length > 0 && sourceInfo.display) {
    detailParts.push(sourceInfo.display);
  }
  if (sourceInfo.detail) {
    detailParts.push(sourceInfo.detail);
  }

  return {
    title,
    detail: detailParts.join(' | '),
    tag: sourceInfo.tag || '',
    source: sourceInfo,
    companyEntries
  };
}

function filterResponsesByAnalysisType(responses, analysisType, companyQuery = marketFilters.companyQuery) {
  const filtered = Array.isArray(responses)
    ? responses.filter((response) => (response.analysisType || 'company') === analysisType)
    : [];
  if (analysisType !== 'company') return filtered;
  return filtered.filter((response) => responseMatchesCompanyQuery(response, companyQuery));
}

function flattenResponseTextForExport(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\r?\n+/g, ' ⏎ ')
    .replace(/\t+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function buildResponseStage12PairSummary(response) {
  if (typeof DecisionViewModelUtils.buildStage12PairSummary === 'function') {
    return DecisionViewModelUtils.buildStage12PairSummary(response, DecisionContractUtils);
  }
  return { status: 'invalid', issueCodes: [], lines: [], shortfall: false };
}

function describeDecisionContractBadge(summary, options = {}) {
  const status = typeof summary?.status === 'string' ? summary.status : 'invalid';
  const compact = options?.compact === true;
  if (status === 'current') {
    return {
      text: compact ? 'current' : 'Stage 12: current',
      className: 'response-contract-badge ok'
    };
  }
  if (status === 'shortfall') {
    return {
      text: compact ? 'shortfall' : 'Stage 12: shortfall',
      className: 'response-contract-badge info'
    };
  }
  if (status === 'legacy') {
    return {
      text: compact ? 'legacy' : 'Stage 12: legacy read-only',
      className: 'response-contract-badge warn'
    };
  }
  const issueCodes = Array.isArray(summary?.issueCodes) && summary.issueCodes.length > 0
    ? summary.issueCodes.join(', ')
    : 'invalid_contract';
  return {
    text: compact ? 'invalid' : `Stage 12: invalid (${issueCodes})`,
    className: 'response-contract-badge error'
  };
}

function createStage12SummaryElement(response) {
  const pairSummary = buildResponseStage12PairSummary(response);
  if (!pairSummary || !Array.isArray(pairSummary.lines) || pairSummary.lines.length === 0) {
    return null;
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'response-stage12-summary';
  pairSummary.lines.forEach((line) => {
    const item = document.createElement('div');
    item.className = 'response-stage12-line';
    item.textContent = line;
    wrapper.appendChild(item);
  });
  return wrapper;
}

const ECONOMIST_PODCAST_NAMES = [
  'The Intelligence',
  'Checks and Balance',
  'Drum Tower',
  'Money Talks',
  'Babbage',
  'The Weekend Intelligence',
  'Boss Class',
  'Gamechangers'
];

function normalizeSourceText(value, fallback = '') {
  const text = typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim()
    : '';
  return text || fallback;
}

function foldSourceSortText(value) {
  const text = normalizeSourceText(value).toLowerCase();
  if (!text) return '';
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function escapeRegExpLiteral(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripEconomistBrandSuffix(sourceText) {
  return normalizeSourceText(sourceText)
    .replace(/\s*\|\s*the economist podcasts?\s*$/i, '')
    .replace(/\s*[-–—]\s*the economist podcasts?\s*$/i, '')
    .replace(/\s*\|\s*the economist\s*$/i, '')
    .replace(/\s*[-–—]\s*the economist\s*$/i, '')
    .replace(/\s*\|\s*economist podcasts?\s*$/i, '')
    .replace(/\s*[-–—]\s*economist podcasts?\s*$/i, '')
    .trim();
}

function detectEconomistPodcastName(sourceText) {
  const raw = normalizeSourceText(sourceText);
  if (!raw) return '';

  const lowered = raw.toLowerCase();
  const hasEconomist = lowered.includes('economist');
  const hasPodcastToken = lowered.includes('podcast');
  if (!hasEconomist && !hasPodcastToken) return '';

  const cleaned = stripEconomistBrandSuffix(raw);
  for (const podcastName of ECONOMIST_PODCAST_NAMES) {
    const pattern = new RegExp(`\\b${escapeRegExpLiteral(podcastName)}\\b`, 'i');
    if (pattern.test(cleaned)) return podcastName;
  }

  const genericMatch = cleaned.match(/^(.+?)\s+podcast\b/i);
  if (genericMatch?.[1]) {
    const candidate = normalizeSourceText(genericMatch[1]);
    if (candidate) return candidate;
  }

  return hasEconomist && hasPodcastToken ? 'Unknown' : '';
}

function extractEconomistPodcastEpisode(sourceText, podcastName) {
  const base = stripEconomistBrandSuffix(sourceText);
  const safeName = normalizeSourceText(podcastName);
  if (!base || !safeName) return '';

  const fullPattern = new RegExp(`^${escapeRegExpLiteral(safeName)}(?:\\s+podcast)?\\s*[:\\-]\\s*(.+)$`, 'i');
  const fullMatch = base.match(fullPattern);
  if (fullMatch?.[1]) {
    return normalizeSourceText(fullMatch[1]);
  }

  const tailPattern = new RegExp(`^(.+)\\s*[|\\-]\\s*${escapeRegExpLiteral(safeName)}(?:\\s+podcast)?$`, 'i');
  const tailMatch = base.match(tailPattern);
  if (tailMatch?.[1]) {
    return normalizeSourceText(tailMatch[1]);
  }

  return '';
}

function describeResponseSource(response) {
  const raw = normalizeSourceText(response?.source, 'Artykul');
  const lowered = raw.toLowerCase();

  const podcastName = detectEconomistPodcastName(raw);
  if (podcastName) {
    const episode = extractEconomistPodcastEpisode(raw, podcastName);
    return {
      raw,
      display: podcastName === 'Unknown'
        ? 'The Economist Podcast'
        : `The Economist Podcast: ${podcastName}`,
      detail: episode || '',
      tag: 'Economist Podcast',
      sortKey: [
        'economist podcast',
        foldSourceSortText(podcastName === 'Unknown' ? '' : podcastName),
        foldSourceSortText(episode)
      ].filter(Boolean).join(' ')
    };
  }

  if (lowered.includes('youtube')) {
    return {
      raw,
      display: raw,
      detail: '',
      tag: 'YouTube',
      sortKey: `youtube ${foldSourceSortText(raw)}`
    };
  }

  if (lowered.includes('spotify')) {
    return {
      raw,
      display: raw,
      detail: '',
      tag: 'Spotify',
      sortKey: `spotify ${foldSourceSortText(raw)}`
    };
  }

  if (lowered.includes('manual source') || lowered.includes('manual pdf') || lowered.includes('recznie wklej')) {
    return {
      raw,
      display: raw,
      detail: '',
      tag: 'Manual',
      sortKey: `manual ${foldSourceSortText(raw)}`
    };
  }

  if (lowered.includes('economist')) {
    return {
      raw,
      display: raw,
      detail: '',
      tag: 'The Economist',
      sortKey: `economist ${foldSourceSortText(raw)}`
    };
  }

  return {
    raw,
    display: raw,
    detail: '',
    tag: '',
    sortKey: foldSourceSortText(raw)
  };
}

function compareTextForSort(left, right) {
  return String(left || '').localeCompare(String(right || ''), 'pl', { sensitivity: 'base' });
}

function compareByTimestampDesc(left, right) {
  const leftTs = Number.isInteger(left?.timestamp) ? left.timestamp : 0;
  const rightTs = Number.isInteger(right?.timestamp) ? right.timestamp : 0;
  return rightTs - leftTs;
}

function normalizeCompanySortMode(value) {
  const normalized = normalizeSourceText(value).toLowerCase();
  if (normalized === 'source_asc') return 'source_asc';
  if (normalized === 'source_desc') return 'source_desc';
  return 'latest';
}

function sortCompanyResponses(responses) {
  const safe = Array.isArray(responses) ? responses.slice() : [];
  const mode = normalizeCompanySortMode(companySortMode);

  safe.sort((left, right) => {
    if (mode === 'source_asc' || mode === 'source_desc') {
      const leftSource = describeResponseSource(left);
      const rightSource = describeResponseSource(right);
      const sourceDiff = compareTextForSort(leftSource.sortKey, rightSource.sortKey);
      if (sourceDiff !== 0) {
        return mode === 'source_desc' ? -sourceDiff : sourceDiff;
      }
    }

    const tsDiff = compareByTimestampDesc(left, right);
    if (tsDiff !== 0) return tsDiff;

    const leftSourceRaw = describeResponseSource(left).raw;
    const rightSourceRaw = describeResponseSource(right).raw;
    return compareTextForSort(leftSourceRaw, rightSourceRaw);
  });

  return safe;
}

function getSortedResponsesForAnalysis(responses, analysisType) {
  const safe = Array.isArray(responses) ? responses.slice() : [];
  const normalizedType = normalizeSourceText(analysisType, 'company').toLowerCase();
  if (normalizedType === 'company') {
    return sortCompanyResponses(safe);
  }
  return safe.sort(compareByTimestampDesc);
}

function parseDecisionRecordParts(raw) {
  return typeof DecisionContractUtils.parseDecisionRecordParts === 'function'
    ? DecisionContractUtils.parseDecisionRecordParts(raw)
    : null;
}

function parseDecisionRecordLine(rawLine) {
  return typeof DecisionContractUtils.parseDecisionRecordLine === 'function'
    ? DecisionContractUtils.parseDecisionRecordLine(rawLine)
    : null;
}

function extractDecisionRecordsFromText(text) {
  return typeof DecisionContractUtils.extractDecisionRecordsFromText === 'function'
    ? DecisionContractUtils.extractDecisionRecordsFromText(text)
    : [];
}

function extractDecisionRecordFromText(text) {
  return typeof DecisionContractUtils.extractDecisionRecordFromText === 'function'
    ? DecisionContractUtils.extractDecisionRecordFromText(text)
    : null;
}

function formatDecisionRecordTable(text) {
  return typeof DecisionContractUtils.formatDecisionRecordTable === 'function'
    ? DecisionContractUtils.formatDecisionRecordTable(text)
    : null;
}

async function migrateResponsesToLocal() {
  return Promise.resolve();
}

function ensureResponseStorageReady() {
  return responseStorageReady;
}

function clearStage12ViewCache() {
  if (typeof DecisionViewModelUtils.clearStage12ViewCache === 'function') {
    DecisionViewModelUtils.clearStage12ViewCache();
  }
}

async function readResponsesFromStorage() {
  return typeof ResponseStorageUtils.readCanonicalResponses === 'function'
    ? ResponseStorageUtils.readCanonicalResponses(getStorageAreas(), DecisionContractUtils)
    : [];
}

// Wczytaj i wyświetl odpowiedzi przy starcie
setupCompanyInteractions();
setupMarketInteractions();
loadResponses();

function scheduleLoadResponses(reason = 'manual', delayMs = 0) {
  if (scheduledResponsesReloadTimer !== null) {
    clearTimeout(scheduledResponsesReloadTimer);
    scheduledResponsesReloadTimer = null;
  }
  const nextDelayMs = Number.isInteger(delayMs) && delayMs >= 0 ? delayMs : 0;
  scheduledResponsesReloadTimer = setTimeout(() => {
    scheduledResponsesReloadTimer = null;
    void runScheduledLoadResponses(reason);
  }, nextDelayMs);
}

async function runScheduledLoadResponses(reason = 'manual') {
  if (responsesReloadInFlight) {
    responsesReloadQueued = true;
    return;
  }
  responsesReloadInFlight = true;
  try {
    await loadResponses();
  } catch (error) {
    console.warn('[responses.js] Scheduled reload failed:', reason, error);
  } finally {
    responsesReloadInFlight = false;
    if (responsesReloadQueued) {
      responsesReloadQueued = false;
      scheduleLoadResponses('queued_follow_up', 120);
    }
  }
}

// Obsługa przycisku "Wyczyść wszystkie"
if (clearBtn) {
  clearBtn.addEventListener('click', async () => {
    if (confirm('Czy na pewno chcesz wyczyścić wszystkie zebrane odpowiedzi?')) {
      await ensureResponseStorageReady();
      if (typeof ResponseStorageUtils.clearCanonicalResponses === 'function') {
        await ResponseStorageUtils.clearCanonicalResponses(getStorageAreas());
      }
      loadResponses();
    }
  });
}

// Obsługa przycisku "Kopiuj wszystkie" dla analizy spółki
if (copyAllCompanyBtn) {
  copyAllCompanyBtn.addEventListener('click', async () => {
    await copyAllByType('company', copyAllCompanyBtn);
  });
}

if (copyAllCompanyWithLinkBtn) {
  copyAllCompanyWithLinkBtn.addEventListener('click', async () => {
    await copyAllByTypeWithLink('company', copyAllCompanyWithLinkBtn);
  });
}

function normalizeConversationUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (!/^https?:\/\//i.test(raw)) return '';
  return raw;
}

function resolveConversationUrl(response) {
  if (!response || typeof response !== 'object') return '';
  return (
    normalizeConversationUrl(response.conversationUrl) ||
    normalizeConversationUrl(response.conversation_url) ||
    ''
  );
}

// Funkcja kopiująca wszystkie odpowiedzi danego typu
async function copyAllByType(analysisType, button) {
  let opCounted = false;
  let attemptedCount = 0;
  let attemptedChars = 0;
  try {
    await ensureResponseStorageReady();
    const responses = await readResponsesFromStorage();
    
    const filteredResponses = filterResponsesByAnalysisType(responses, analysisType);
    
    if (filteredResponses.length === 0) {
      return;
    }
    
    // Sort order mirrors current UI for company responses.
    const sortedResponses = getSortedResponsesForAnalysis(filteredResponses, analysisType);
    
    const allText = sortedResponses
      .map((response) => flattenResponseTextForExport(response?.text))
      .join('\n');

    attemptedCount = sortedResponses.length;
    attemptedChars = allText.length;
    clipboardCounters.ops += 1;
    opCounted = true;
    clipboardCounters.messagesAttempted += attemptedCount;
    
    await navigator.clipboard.writeText(allText);
    clipboardCounters.opsOk += 1;
    clipboardCounters.messagesCopiedOk += attemptedCount;
    
    // Wizualna informacja
    const originalText = button.textContent;
    button.textContent = `\u2713 Skopiowano (${attemptedCount})`;
    button.classList.add('copied');
    
    setTimeout(() => {
      button.textContent = originalText;
      button.classList.remove('copied');
    }, 2000);
    
    logClipboard('OK copy_all', {
      analysisType,
      copiedMessages: attemptedCount,
      chars: attemptedChars
    });
  } catch (error) {
    if (!opCounted) {
      clipboardCounters.ops += 1;
      opCounted = true;
      clipboardCounters.messagesAttempted += attemptedCount;
    }
    clipboardCounters.opsFail += 1;
    clipboardCounters.messagesCopiedFail += attemptedCount;
    console.error('[clipboard] ERROR copy_all:', error);
    button.textContent = '\u2717 Błąd';
    setTimeout(() => {
      button.textContent = 'Kopiuj wszystkie';
    }, 2000);
    logClipboard('FAIL copy_all', { analysisType, attemptedMessages: attemptedCount, attemptedChars });
  }
}

// Kopiuje wszystkie odpowiedzi danego typu jako TSV: text<TAB>conversationUrl (po jednej odpowiedzi na wiersz).
async function copyAllByTypeWithLink(analysisType, button) {
  let opCounted = false;
  let attemptedCount = 0;
  let attemptedChars = 0;
  try {
    await ensureResponseStorageReady();
    const responses = await readResponsesFromStorage();

    const filteredResponses = filterResponsesByAnalysisType(responses, analysisType);
    if (filteredResponses.length === 0) {
      return;
    }

    const sortedResponses = getSortedResponsesForAnalysis(filteredResponses, analysisType);
    const allText = sortedResponses
      .map((response) => {
        const text = flattenResponseTextForExport(response?.text);
        const url = resolveConversationUrl(response);
        return `${text}\t${url}`;
      })
      .join('\n');

    attemptedCount = sortedResponses.length;
    attemptedChars = allText.length;
    clipboardCounters.ops += 1;
    opCounted = true;
    clipboardCounters.messagesAttempted += attemptedCount;

    await navigator.clipboard.writeText(allText);
    clipboardCounters.opsOk += 1;
    clipboardCounters.messagesCopiedOk += attemptedCount;

    const originalText = button.textContent;
    button.textContent = `\u2713 Skopiowano (${attemptedCount})`;
    button.classList.add('copied');

    setTimeout(() => {
      button.textContent = originalText;
      button.classList.remove('copied');
    }, 2000);

    logClipboard('OK copy_all_with_link', {
      analysisType,
      copiedMessages: attemptedCount,
      chars: attemptedChars
    });
  } catch (error) {
    if (!opCounted) {
      clipboardCounters.ops += 1;
      opCounted = true;
      clipboardCounters.messagesAttempted += attemptedCount;
    }
    clipboardCounters.opsFail += 1;
    clipboardCounters.messagesCopiedFail += attemptedCount;
    console.error('[clipboard] ERROR copy_all_with_link:', error);
    button.textContent = '\u2717 Błąd';
    setTimeout(() => {
      button.textContent = 'Kopiuj z linkiem';
    }, 2000);
    logClipboard('FAIL copy_all_with_link', { analysisType, attemptedMessages: attemptedCount, attemptedChars });
  }
}

// Funkcja wczytująca odpowiedzi z storage
async function loadResponses() {
  try {
    console.log('[loadResponses] Wczytuję odpowiedzi z storage...');
    clearStage12ViewCache();
    await ensureResponseStorageReady();
    const responses = await readResponsesFromStorage();
    lastLoadedResponses = Array.isArray(responses) ? responses.slice() : [];
    
    console.log(`[loadResponses] Wczytano ${responses.length} odpowiedzi:`, responses);
    
    renderResponses(responses);
    loadMarketData(responses);
  } catch (error) {
    console.error('[loadResponses] Błąd wczytywania odpowiedzi:', error);
    console.error('Stack trace:', error.stack);
    lastLoadedResponses = [];
    showEmptyStates();
  }
}

// Funkcja renderująca listę odpowiedzi
function renderResponses(responses) {
  const safeResponses = Array.isArray(responses) ? responses : [];
  console.log(`[renderResponses] Renderuję ${safeResponses.length} odpowiedzi`);
  
  // Starsze odpowiedzi bez analysisType domyślnie 'company'
  const companyResponses = filterResponsesByAnalysisType(safeResponses, 'company');
  
  console.log(`   Company: ${companyResponses.length}`);
  
  // Aktualizuj liczniki
  const totalCount = safeResponses.length;
  if (responseCount) {
    responseCount.textContent = totalCount === 0
      ? '0 odpowiedzi'
      : totalCount === 1
        ? '1 odpowiedź'
        : `${totalCount} odpowiedzi`;
  }
  
  updateSectionCount(companyCount, companyResponses.length);
  
  if (clearBtn) {
    clearBtn.disabled = totalCount === 0;
  }
  if (copyAllCompanyBtn) {
    copyAllCompanyBtn.disabled = companyResponses.length === 0;
  }
  if (copyAllCompanyWithLinkBtn) {
    copyAllCompanyWithLinkBtn.disabled = companyResponses.length === 0;
  }
  updateCompanyEmptyState(marketFilters.companyQuery);
  
  if (companyResponses.length === 0) {
    showEmptyState(companyEmptyState);
    hideResponsesList(companyResponsesList);
  } else {
    hideEmptyState(companyEmptyState);
    showResponsesList(companyResponsesList);
    renderResponsesInSection(companyResponsesList, companyResponses);
  }
}

// Funkcja aktualizująca licznik sekcji
function updateSectionCount(element, count) {
  if (!element) return;
  element.textContent = count === 0 
    ? '0 odpowiedzi' 
    : count === 1 
      ? '1 odpowiedź' 
      : `${count} odpowiedzi`;
}

function updateCompanyEmptyState(query) {
  if (!companyEmptyStateTitle || !companyEmptyStateBody) return;
  const normalizedQuery = normalizeMarketText(query);
  if (!normalizedQuery) {
    companyEmptyStateTitle.textContent = 'Brak raportów spółek';
    companyEmptyStateBody.textContent = 'Raporty spółek będą pojawiać się tutaj.';
    return;
  }
  companyEmptyStateTitle.textContent = 'Brak raportów dla tej spółki';
  companyEmptyStateBody.textContent = `Nie znaleziono raportów pasujących do: ${normalizedQuery}`;
}

// Funkcja renderująca odpowiedzi w danej sekcji
function renderResponsesInSection(listElement, responses) {
  const sortedResponses = sortCompanyResponses(responses);
  
  // Wyczyść listę
  listElement.innerHTML = '';
  
  // Renderuj każdą odpowiedź
  sortedResponses.forEach((response) => {
    const item = createResponseItem(response);
    listElement.appendChild(item);
  });
}

// Funkcja tworząca element odpowiedzi
function createResponseItem(response) {
  const item = document.createElement('div');
  item.className = 'response-item';
  
  const header = document.createElement('div');
  header.className = 'response-header';
  
  const meta = document.createElement('div');
  meta.className = 'response-meta';

  const headerModel = buildResponseCardHeaderModel(response);

  if (headerModel.tag) {
    const sourceTag = document.createElement('div');
    sourceTag.className = 'response-source-tag';
    sourceTag.textContent = headerModel.tag;
    meta.appendChild(sourceTag);
  }

  const source = document.createElement('div');
  source.className = 'response-source';
  source.textContent = headerModel.title;

  meta.appendChild(source);

  if (headerModel.detail) {
    const sourceDetail = document.createElement('div');
    sourceDetail.className = 'response-source-detail';
    sourceDetail.textContent = headerModel.detail;
    meta.appendChild(sourceDetail);
  }

  const time = document.createElement('div');
  time.className = 'response-time';
  time.textContent = formatTimestamp(response.timestamp);

  meta.appendChild(time);

  const stageLineText = formatStageLine(response);
  if (stageLineText) {
    const stageLine = document.createElement('div');
    stageLine.className = 'response-stage';
    stageLine.textContent = stageLineText;
    meta.appendChild(stageLine);
  }

  const decisionContractBadge = describeDecisionContractBadge(getResponseDecisionContract(response));
  if (decisionContractBadge) {
    const badge = document.createElement('div');
    badge.className = decisionContractBadge.className;
    badge.textContent = decisionContractBadge.text;
    meta.appendChild(badge);
  }
  const stage12Summary = createStage12SummaryElement(response);
  if (stage12Summary) {
    meta.appendChild(stage12Summary);
  }
  
  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.textContent = 'Kopiuj';
  const formattedText = response.formattedText || response.formatted_text || formatDecisionRecordTable(response.text);
  const displayText = formattedText || response.text;
  copyBtn.addEventListener('click', () => copyToClipboard(displayText, copyBtn));
  
  header.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'response-actions';
  actions.appendChild(copyBtn);

  const conversationUrl = resolveConversationUrl(response);
  if (conversationUrl) {
    const openChatBtn = document.createElement('button');
    openChatBtn.className = 'toggle-btn';
    openChatBtn.textContent = 'Otwórz chat';
    openChatBtn.addEventListener('click', () => {
      try {
        if (chrome?.tabs?.create) {
          chrome.tabs.create({ url: conversationUrl });
          return;
        }
      } catch (error) {
        // Ignore and fallback below.
      }
      window.open(conversationUrl, '_blank', 'noopener,noreferrer');
    });
    actions.appendChild(openChatBtn);
  }
  
  const text = document.createElement('div');
  text.className = 'response-text';
  text.textContent = displayText;
  if (formattedText) {
    text.classList.add('formatted');
  }

  if (stageLineText) {
    text.style.display = 'none';
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'toggle-btn';
    toggleBtn.textContent = 'Rozwiń';
    toggleBtn.addEventListener('click', () => {
      const isHidden = text.style.display === 'none';
      text.style.display = isHidden ? 'block' : 'none';
      toggleBtn.textContent = isHidden ? 'Ukryj' : 'Rozwiń';
    });
    actions.appendChild(toggleBtn);
  }

  header.appendChild(actions);
  
  item.appendChild(header);
  item.appendChild(text);
  
  return item;
}

// Funkcja kopiująca tekst do clipboard
async function copyToClipboard(text, button) {
  const attemptedCount = 1;
  const attemptedChars = typeof text === 'string' ? text.length : 0;
  try {
    clipboardCounters.ops += 1;
    clipboardCounters.messagesAttempted += attemptedCount;
    await navigator.clipboard.writeText(text);
    clipboardCounters.opsOk += 1;
    clipboardCounters.messagesCopiedOk += attemptedCount;
    
    // Wizualna informacja o skopiowaniu
    const originalText = button.textContent;
    button.textContent = '\u2713 Skopiowano (1)';
    button.classList.add('copied');
    
    setTimeout(() => {
      button.textContent = originalText;
      button.classList.remove('copied');
    }, 2000);
    
    logClipboard('OK copy_one', { chars: typeof text === 'string' ? text.length : 0 });
  } catch (error) {
    clipboardCounters.opsFail += 1;
    clipboardCounters.messagesCopiedFail += attemptedCount;
    console.error('[clipboard] ERROR copy_one:', error);
    button.textContent = '\u2717 Błąd';
    setTimeout(() => {
      button.textContent = 'Kopiuj';
    }, 2000);
    logClipboard('FAIL copy_one', { attemptedChars });
  }
}

// Funkcja formatujÄ…ca timestamp na czytelnÄ… datÄ™
function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  
  const isToday = date.toDateString() === now.toDateString();
  
  const timeStr = date.toLocaleTimeString('pl-PL', {
    hour: '2-digit',
    minute: '2-digit'
  });
  
  if (isToday) {
    return `Dzisiaj o ${timeStr}`;
  }
  
  const dateStr = date.toLocaleDateString('pl-PL', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
  
  return `${dateStr} o ${timeStr}`;
}

// Funkcje pokazujÄ…ce/ukrywajÄ…ce empty state
function showEmptyState(element) {
  element.style.display = 'block';
}

function hideEmptyState(element) {
  element.style.display = 'none';
}

function showResponsesList(element) {
  element.style.display = 'flex';
}

function hideResponsesList(element) {
  element.style.display = 'none';
}

function showEmptyStates() {
  showEmptyState(companyEmptyState);
  hideResponsesList(companyResponsesList);
}

function setCompanySortMode(value) {
  companySortMode = normalizeCompanySortMode(value);
  if (companySortSelect && companySortSelect.value !== companySortMode) {
    companySortSelect.value = companySortMode;
  }
}

function setupCompanyInteractions() {
  if (!companySortSelect) return;
  setCompanySortMode(companySortSelect.value);
  companySortSelect.addEventListener('change', () => {
    setCompanySortMode(companySortSelect.value);
    renderResponses(lastLoadedResponses);
  });
}

function normalizeMarketText(value, fallback = '') {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || fallback;
}

function normalizeMarketToken(value) {
  return normalizeMarketText(value).toLowerCase();
}

function normalizeFuzzyText(value) {
  const source = normalizeMarketText(value).toLowerCase();
  if (!source) return '';
  return source
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeFuzzyText(value) {
  const normalized = normalizeFuzzyText(value);
  if (!normalized) return [];
  return normalized.split(' ').filter(Boolean);
}

function levenshteinDistanceWithLimit(left, right, maxDistance = 3) {
  const a = typeof left === 'string' ? left : '';
  const b = typeof right === 'string' ? right : '';
  if (!a) return b.length;
  if (!b) return a.length;
  if (Math.abs(a.length - b.length) > maxDistance) return Number.POSITIVE_INFINITY;

  const cols = b.length + 1;
  const prev = new Array(cols);
  const curr = new Array(cols);

  for (let j = 0; j < cols; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const insert = curr[j - 1] + 1;
      const remove = prev[j] + 1;
      const substitute = prev[j - 1] + cost;
      const value = Math.min(insert, remove, substitute);
      curr[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > maxDistance) return Number.POSITIVE_INFINITY;
    for (let j = 0; j < cols; j += 1) prev[j] = curr[j];
  }
  return prev[b.length];
}

function scoreTokenSimilarity(query, token) {
  if (!query || !token) return Number.NEGATIVE_INFINITY;
  if (token === query) return 250;
  if (token.startsWith(query)) return 220 - Math.min(20, token.length - query.length);
  if (token.includes(query)) return 190 - Math.min(30, token.length - query.length);

  const maxLen = Math.max(query.length, token.length);
  const limit = Math.max(1, Math.floor(maxLen * 0.45));
  const distance = levenshteinDistanceWithLimit(query, token, limit);
  if (!Number.isFinite(distance)) return Number.NEGATIVE_INFINITY;
  const similarity = 1 - (distance / maxLen);
  if (similarity < 0.55) return Number.NEGATIVE_INFINITY;
  return Math.round(130 + similarity * 90);
}

function scoreCompanyQueryAgainstRow(query, row) {
  const normalizedQuery = normalizeFuzzyText(query);
  if (!normalizedQuery) {
    return {
      matched: true,
      score: 0
    };
  }

  const company = typeof row?.companyFuzzy === 'string' ? row.companyFuzzy : '';
  const ticker = typeof row?.tickerFuzzy === 'string' ? row.tickerFuzzy : '';
  const haystack = typeof row?.searchHaystack === 'string' ? row.searchHaystack : '';
  const rowTokens = Array.isArray(row?.searchTokens) ? row.searchTokens : [];
  const queryTokens = tokenizeFuzzyText(normalizedQuery);
  let bestScore = Number.NEGATIVE_INFINITY;

  if (company && company.startsWith(normalizedQuery)) {
    bestScore = Math.max(bestScore, 240 - Math.min(35, company.length - normalizedQuery.length));
  }
  if (ticker && ticker.startsWith(normalizedQuery)) {
    bestScore = Math.max(bestScore, 230);
  }
  if (haystack && haystack.includes(normalizedQuery)) {
    bestScore = Math.max(bestScore, 195);
  }

  const evaluateSingle = (token) => {
    let localBest = Number.NEGATIVE_INFINITY;
    rowTokens.forEach((rowToken) => {
      const score = scoreTokenSimilarity(token, rowToken);
      if (score > localBest) localBest = score;
    });
    if (ticker) {
      const tickerScore = scoreTokenSimilarity(token, ticker);
      if (tickerScore > localBest) localBest = tickerScore;
    }
    return localBest;
  };

  const singleScore = evaluateSingle(normalizedQuery);
  if (singleScore > bestScore) bestScore = singleScore;

  if (queryTokens.length > 1) {
    const tokenScores = queryTokens.map((token) => evaluateSingle(token));
    if (tokenScores.every((score) => Number.isFinite(score) && score > 120)) {
      const avgScore = tokenScores.reduce((sum, score) => sum + score, 0) / tokenScores.length;
      bestScore = Math.max(bestScore, Math.round(avgScore));
    }
  }

  return {
    matched: Number.isFinite(bestScore) && bestScore >= 128,
    score: Number.isFinite(bestScore) ? bestScore : 0
  };
}

function safeLocaleCompare(left, right) {
  return String(left || '').localeCompare(String(right || ''), 'pl', { sensitivity: 'base' });
}

function extractTickerFromCompany(companyLabel) {
  const source = normalizeMarketText(companyLabel);
  if (!source) return '';

  const blocked = new Set(['SA', 'SPA', 'AG', 'NV', 'PLC', 'INC', 'CORP', 'LTD', 'LLC', 'SE']);
  const fromParen = source.match(/\(([A-Z0-9.\-]{1,10})\)/);
  if (fromParen && !blocked.has(fromParen[1])) return fromParen[1];

  const fromExchange = source.match(/\b(?:NYSE|NASDAQ|LSE|XETRA|GPW|ASX|TSX)\s*[:\-]\s*([A-Z0-9.\-]{1,10})\b/i);
  if (fromExchange) return fromExchange[1].toUpperCase();

  const fromSuffix = source.match(/\b([A-Z0-9.\-]{1,10})\s*$/);
  if (fromSuffix && !blocked.has(fromSuffix[1])) {
    return fromSuffix[1].toUpperCase();
  }

  return '';
}

function parseDecisionDateToTimestamp(decisionDate, fallbackTimestamp = 0) {
  const source = normalizeMarketText(decisionDate);
  if (source) {
    const direct = Date.parse(source);
    if (Number.isFinite(direct)) return direct;

    const matched = source.match(/^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})(?:\s+(\d{1,2}):(\d{2}))?$/);
    if (matched) {
      const day = Number.parseInt(matched[1], 10);
      const month = Number.parseInt(matched[2], 10) - 1;
      const year = Number.parseInt(matched[3], 10);
      const hour = Number.parseInt(matched[4] || '0', 10);
      const minute = Number.parseInt(matched[5] || '0', 10);
      const parsed = new Date(year, month, day, hour, minute).getTime();
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  return Number.isInteger(fallbackTimestamp) && fallbackTimestamp > 0
    ? fallbackTimestamp
    : 0;
}

function parseAsymmetryValue(rawAsymmetry, thesisText = '') {
  const sources = [normalizeMarketText(rawAsymmetry), normalizeMarketText(thesisText)].filter(Boolean);
  if (sources.length === 0) return Number.NaN;
  const merged = sources.join(' | ').replace(/,/g, '.');

  const ratioMatch = merged.match(/(-?\d+(?:\.\d+)?)\s*:\s*1/i);
  if (ratioMatch) return Number.parseFloat(ratioMatch[1]);

  const xMatch = merged.match(/(-?\d+(?:\.\d+)?)\s*x\b/i);
  if (xMatch) return Number.parseFloat(xMatch[1]);

  const pctMatch = merged.match(/(-?\d+(?:\.\d+)?)\s*%/);
  if (pctMatch) return Number.parseFloat(pctMatch[1]) / 100;

  const plainMatch = merged.match(/-?\d+(?:\.\d+)?/);
  if (plainMatch) return Number.parseFloat(plainMatch[0]);

  return Number.NaN;
}

function formatMarketDate(timestamp, fallbackDate = '') {
  if (Number.isFinite(timestamp) && timestamp > 0) {
    const date = new Date(timestamp);
    return date.toLocaleString('pl-PL', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }
  return normalizeMarketText(fallbackDate, '-');
}

function compareMarketRowsByDefault(left, right) {
  if (typeof DecisionViewModelUtils.compareMarketRowsDefault === 'function') {
    return DecisionViewModelUtils.compareMarketRowsDefault(left, right, DecisionContractUtils);
  }
  const leftTs = Number.isFinite(left?.decisionTs) ? left.decisionTs : 0;
  const rightTs = Number.isFinite(right?.decisionTs) ? right.decisionTs : 0;
  if (rightTs !== leftTs) return rightTs - leftTs;
  return safeLocaleCompare(left?.company, right?.company);
}

function buildMarketRowsFromResponses(responses) {
  if (typeof DecisionViewModelUtils.buildMarketRowsFromResponses === 'function') {
    return DecisionViewModelUtils.buildMarketRowsFromResponses(responses, DecisionContractUtils);
  }
  return [];
}

function getMarketDefaultSortDirection(key) {
  if (
    key === 'composite'
    || key === 'sizing'
    || key === 'role'
    || key === 'decisionTs'
  ) {
    return 'desc';
  }
  return 'asc';
}

function getMarketSortValue(row, sortKey) {
  switch (sortKey) {
    case 'rank':
      return Number.isInteger(row?.baseRank) ? row.baseRank : Number.MAX_SAFE_INTEGER;
    case 'company':
      return normalizeMarketToken(row?.company);
    case 'ticker':
      return normalizeMarketToken(row?.ticker);
    case 'decisionStatus':
      return normalizeMarketToken(row?.decisionStatus);
    case 'role':
      return Number.isFinite(row?.rolePriority) ? row.rolePriority : 0;
    case 'composite':
      return Number.isFinite(row?.compositeValue) ? row.compositeValue : Number.NEGATIVE_INFINITY;
    case 'sizing':
      return Number.isFinite(row?.sizingPercent) ? row.sizingPercent : Number.NEGATIVE_INFINITY;
    case 'sector':
      return normalizeMarketToken(row?.sector);
    case 'region':
      return normalizeMarketToken(row?.region);
    case 'currency':
      return normalizeMarketToken(row?.currency);
    case 'decisionTs':
      return Number.isFinite(row?.decisionTs) ? row.decisionTs : 0;
    default:
      return '';
  }
}

function sortMarketRows(rows) {
  const source = Array.isArray(rows) ? rows.slice() : [];
  const sortKey = normalizeMarketText(marketSortState?.key, 'rank');
  const direction = marketSortState?.direction === 'desc' ? 'desc' : 'asc';

  source.sort((left, right) => {
    const leftValue = getMarketSortValue(left, sortKey);
    const rightValue = getMarketSortValue(right, sortKey);
    let diff = 0;

    if (typeof leftValue === 'number' || typeof rightValue === 'number') {
      const safeLeft = Number.isFinite(leftValue) ? leftValue : Number.NEGATIVE_INFINITY;
      const safeRight = Number.isFinite(rightValue) ? rightValue : Number.NEGATIVE_INFINITY;
      diff = safeLeft === safeRight ? 0 : (safeLeft < safeRight ? -1 : 1);
    } else {
      diff = safeLocaleCompare(leftValue, rightValue);
    }

    if (diff === 0) {
      diff = compareMarketRowsByDefault(left, right);
    }
    return direction === 'desc' ? -diff : diff;
  });

  return source;
}

function hasActiveMarketFilters() {
  return Object.values(marketFilters).some((value) => normalizeMarketText(value).length > 0);
}

function getNormalizedFilterValue(value) {
  const normalized = normalizeMarketText(value);
  if (!normalized || normalized === '-') return '';
  return normalized;
}

function getActiveMarketFilterLabels() {
  const entries = [];
  if (marketFilters.companyQuery) entries.push(`Spółka: ${marketFilters.companyQuery}`);
  if (marketFilters.sector) entries.push(`Sektor: ${marketFilters.sector}`);
  return entries;
}

function applyMarketFilters(rows) {
  const source = Array.isArray(rows) ? rows : [];
  return source.filter((row) => {
    if (marketFilters.companyQuery) {
      const match = scoreCompanyQueryAgainstRow(marketFilters.companyQuery, row);
      if (!match.matched) return false;
    }
    if (marketFilters.sector && normalizeMarketToken(row?.sector) !== normalizeMarketToken(marketFilters.sector)) {
      return false;
    }
    return true;
  });
}

function updateMarketStatus(message) {
  if (!marketStatus) return;
  marketStatus.textContent = message;
}

function updateMarketCountLabel(filteredCount, totalCount) {
  if (!marketCount) return;
  if (totalCount <= 0) {
    marketCount.textContent = '0 rekordów';
    return;
  }
  marketCount.textContent = filteredCount === totalCount
    ? `${totalCount} rekordów`
    : `${filteredCount}/${totalCount} rekordów`;
}

function updateMarketFilterLabel(filteredCount, totalCount) {
  if (!marketFilterLabel) return;
  const labels = getActiveMarketFilterLabels();
  if (labels.length === 0) {
    marketFilterLabel.textContent = `Filtry: brak | Widoczne ${filteredCount}/${totalCount}`;
    return;
  }
  marketFilterLabel.textContent = `Filtry: ${labels.join(', ')} | Widoczne ${filteredCount}/${totalCount}`;
}

function updateMarketSortHeaders() {
  marketSortableHeaders.forEach((header) => {
    const key = normalizeMarketText(header?.dataset?.sortKey);
    header.classList.remove('sorted-asc', 'sorted-desc');
    if (!key || key !== marketSortState.key) return;
    header.classList.add(marketSortState.direction === 'desc' ? 'sorted-desc' : 'sorted-asc');
  });
}

function createMarketFilterChip(columnKey, rawValue, emptyFallback = '-') {
  const value = getNormalizedFilterValue(rawValue);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'market-chip';
  button.textContent = value || emptyFallback;

  if (!value) {
    button.disabled = true;
    return button;
  }

  if (normalizeMarketToken(marketFilters[columnKey]) === normalizeMarketToken(value)) {
    button.classList.add('active');
  }

  button.addEventListener('click', () => {
    toggleMarketFilter(columnKey, value);
  });
  return button;
}

function renderMarketSectorButtons() {
  if (!marketSectorFilters) return;
  marketSectorFilters.innerHTML = '';

  if (marketRows.length === 0) return;

  const allButton = document.createElement('button');
  allButton.type = 'button';
  allButton.className = 'market-filter-btn';
  allButton.textContent = `Wszystkie sektory (${marketRows.length})`;
  if (!marketFilters.sector) allButton.classList.add('active');
  allButton.addEventListener('click', () => {
    if (!marketFilters.sector) return;
    marketFilters.sector = '';
    renderMarketTable();
  });
  marketSectorFilters.appendChild(allButton);

  const counters = new Map();
  marketRows.forEach((row) => {
    const sector = getNormalizedFilterValue(row?.sector);
    if (!sector) return;
    counters.set(sector, (counters.get(sector) || 0) + 1);
  });

  const sectors = Array.from(counters.entries()).sort((left, right) => {
    const countDiff = right[1] - left[1];
    if (countDiff !== 0) return countDiff;
    return safeLocaleCompare(left[0], right[0]);
  });

  sectors.forEach(([sector, count]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'market-filter-btn';
    button.textContent = `${sector} (${count})`;
    if (normalizeMarketToken(marketFilters.sector) === normalizeMarketToken(sector)) {
      button.classList.add('active');
    }
    button.addEventListener('click', () => {
      toggleMarketFilter('sector', sector);
    });
    marketSectorFilters.appendChild(button);
  });
}

function renderMarketRows(rows) {
  if (!marketTableBody) return;
  marketTableBody.innerHTML = '';

  rows.forEach((row) => {
    const tr = document.createElement('tr');

    const rank = document.createElement('td');
    rank.textContent = String(row.baseRank || '-');

    const company = document.createElement('td');
    const companyName = document.createElement('button');
    companyName.type = 'button';
    companyName.className = 'market-company-link';
    companyName.textContent = row.company || '-';
    companyName.title = 'Pokaż raporty dla tej spółki';
    companyName.addEventListener('click', () => {
      activateCompanyQuery(row.company || row.ticker);
    });
    company.appendChild(companyName);
    const badgeMeta = describeDecisionContractBadge({
      status: row.contractStatus,
      issueCodes: row.contractIssueCodes
    }, { compact: true });
    if (badgeMeta) {
      const badge = document.createElement('div');
      badge.className = badgeMeta.className;
      badge.textContent = badgeMeta.text;
      company.appendChild(badge);
    }

    const ticker = document.createElement('td');
    ticker.textContent = row.ticker || '-';

    const decisionStatus = document.createElement('td');
    decisionStatus.textContent = row.decisionStatus || '-';

    const role = document.createElement('td');
    role.textContent = row.role || '-';

    const composite = document.createElement('td');
    composite.textContent = row.compositeText || '-';

    const sizing = document.createElement('td');
    sizing.textContent = row.sizingText || '-';

    const sector = document.createElement('td');
    sector.appendChild(createMarketFilterChip('sector', row.sector));

    const region = document.createElement('td');
    region.textContent = row.region || '-';

    const currency = document.createElement('td');
    currency.textContent = row.currency || '-';

    const date = document.createElement('td');
    date.textContent = formatMarketDate(row.decisionTs, row.decisionDateRaw);

    tr.appendChild(rank);
    tr.appendChild(company);
    tr.appendChild(ticker);
    tr.appendChild(decisionStatus);
    tr.appendChild(role);
    tr.appendChild(composite);
    tr.appendChild(sizing);
    tr.appendChild(sector);
    tr.appendChild(region);
    tr.appendChild(currency);
    tr.appendChild(date);
    marketTableBody.appendChild(tr);
  });
}

function hideMarketSuggestions() {
  if (!marketSearchSuggestions) return;
  marketSearchSuggestions.classList.remove('show');
  marketSearchSuggestions.innerHTML = '';
  marketSuggestionItems = [];
  marketSuggestionActiveIndex = -1;
}

function buildMarketCompanySuggestions(query, limit = 8) {
  const normalizedQuery = normalizeMarketText(query);
  if (!normalizedQuery) return [];
  const byKey = new Map();
  marketRows.forEach((row) => {
    const match = scoreCompanyQueryAgainstRow(normalizedQuery, row);
    if (!match.matched) return;
    const key = row.companyKey || row.key;
    const existing = byKey.get(key);
    const candidate = {
      key,
      company: row.company || '-',
      ticker: row.ticker || '-',
      sector: row.sector || '-',
      score: match.score
    };
    if (!existing || candidate.score > existing.score) {
      byKey.set(key, candidate);
    }
  });
  return Array.from(byKey.values())
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return safeLocaleCompare(left.company, right.company);
    })
    .slice(0, limit);
}

function renderMarketSuggestions(items) {
  if (!marketSearchSuggestions) return;
  const suggestions = Array.isArray(items) ? items : [];
  marketSearchSuggestions.innerHTML = '';
  marketSuggestionItems = suggestions;
  marketSuggestionActiveIndex = -1;

  if (suggestions.length === 0) {
    marketSearchSuggestions.classList.remove('show');
    return;
  }

  suggestions.forEach((item, index) => {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('role', 'option');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'market-search-suggestion';
    button.dataset.index = String(index);

    const left = document.createElement('span');
    left.textContent = item.company || '-';
    const right = document.createElement('span');
    right.className = 'market-search-meta';
    right.textContent = `${item.ticker || '-'} | ${item.sector || '-'}`;

    button.appendChild(left);
    button.appendChild(right);
    button.addEventListener('click', () => {
      applyMarketCompanySuggestion(index);
    });

    wrapper.appendChild(button);
    marketSearchSuggestions.appendChild(wrapper);
  });

  marketSearchSuggestions.classList.add('show');
}

function updateMarketSuggestionActiveState() {
  if (!marketSearchSuggestions) return;
  const buttons = Array.from(marketSearchSuggestions.querySelectorAll('.market-search-suggestion'));
  buttons.forEach((button, index) => {
    button.classList.toggle('active', index === marketSuggestionActiveIndex);
  });
}

function applyMarketCompanySuggestion(index) {
  const numericIndex = Number.isInteger(index) ? index : Number.parseInt(index, 10);
  if (!Number.isInteger(numericIndex) || numericIndex < 0 || numericIndex >= marketSuggestionItems.length) {
    return;
  }
  const picked = marketSuggestionItems[numericIndex];
  activateCompanyQuery(picked?.company || picked?.ticker);
}

function setCompanyQuery(value, options = {}) {
  const nextValue = normalizeMarketText(value);
  marketFilters.companyQuery = nextValue;

  if (options.syncInput !== false && marketCompanySearch) {
    marketCompanySearch.value = nextValue;
  }

  if (options.hideSuggestions !== false) {
    hideMarketSuggestions();
  }

  renderMarketTable();
  renderResponses(lastLoadedResponses);

  if (options.scroll === true && companyResponsesList) {
    companyResponsesList.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function activateCompanyQuery(value) {
  setCompanyQuery(value, {
    syncInput: true,
    hideSuggestions: true,
    scroll: true
  });
}

function renderMarketTable() {
  if (!marketStatus || !marketTable || !marketTableBody) return;

  if (marketRows.length === 0) {
    marketTableBody.innerHTML = '';
    marketTable.style.display = 'none';
    if (marketToolbar) marketToolbar.hidden = true;
    hideMarketSuggestions();
    updateMarketCountLabel(0, 0);
    updateMarketStatus('Brak finalnych rekordów kontraktu Stage 12.');
    updateMarketSortHeaders();
    return;
  }

  const filtered = applyMarketFilters(marketRows);
  const sorted = sortMarketRows(filtered);
  renderMarketRows(sorted);

  renderMarketSectorButtons();
  updateMarketSortHeaders();

  if (marketToolbar) marketToolbar.hidden = false;
  updateMarketCountLabel(filtered.length, marketRows.length);
  updateMarketFilterLabel(filtered.length, marketRows.length);

  if (sorted.length === 0) {
    marketTable.style.display = 'none';
    updateMarketStatus('Brak spółek dla wybranego filtra.');
    return;
  }

  marketTable.style.display = 'table';
  if (hasActiveMarketFilters()) {
    updateMarketStatus('Filtrowanie aktywne: tabela i raporty poniżej pokazują tylko pasujące spółki.');
    return;
  }
  updateMarketStatus('Kliknij nazwę spółki w tabeli, aby od razu zobaczyć wszystkie pasujące raporty poniżej.');
}

function toggleMarketSort(sortKey) {
  const key = normalizeMarketText(sortKey);
  if (!key) return;

  if (marketSortState.key === key) {
    marketSortState.direction = marketSortState.direction === 'asc' ? 'desc' : 'asc';
  } else {
    marketSortState.key = key;
    marketSortState.direction = getMarketDefaultSortDirection(key);
  }

  renderMarketTable();
}

function toggleMarketFilter(columnKey, value) {
  if (!marketFilters || !(columnKey in marketFilters)) return;
  const normalized = getNormalizedFilterValue(value);
  if (!normalized) return;

  if (normalizeMarketToken(marketFilters[columnKey]) === normalizeMarketToken(normalized)) {
    marketFilters[columnKey] = '';
  } else {
    marketFilters[columnKey] = normalized;
  }

  renderMarketTable();
}

function resetMarketFilters() {
  marketFilters = {
    companyQuery: '',
    sector: ''
  };
  if (marketCompanySearch) {
    marketCompanySearch.value = '';
  }
  hideMarketSuggestions();
  renderMarketTable();
  renderResponses(lastLoadedResponses);
}

function handleMarketCompanySearchInput() {
  if (!marketCompanySearch) return;
  const rawQuery = normalizeMarketText(marketCompanySearch.value);
  setCompanyQuery(rawQuery, {
    syncInput: false,
    hideSuggestions: false,
    scroll: false
  });

  if (!rawQuery) {
    hideMarketSuggestions();
    return;
  }
  const suggestions = buildMarketCompanySuggestions(rawQuery);
  renderMarketSuggestions(suggestions);
}

function handleMarketCompanySearchKeydown(event) {
  if (!marketCompanySearch) return;
  if (!marketSearchSuggestions?.classList.contains('show') || marketSuggestionItems.length === 0) {
    if (event.key === 'Enter') {
      event.preventDefault();
      activateCompanyQuery(marketCompanySearch.value);
    }
    return;
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    marketSuggestionActiveIndex = (marketSuggestionActiveIndex + 1) % marketSuggestionItems.length;
    updateMarketSuggestionActiveState();
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    marketSuggestionActiveIndex = marketSuggestionActiveIndex <= 0
      ? (marketSuggestionItems.length - 1)
      : (marketSuggestionActiveIndex - 1);
    updateMarketSuggestionActiveState();
    return;
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    if (marketSuggestionActiveIndex >= 0 && marketSuggestionActiveIndex < marketSuggestionItems.length) {
      applyMarketCompanySuggestion(marketSuggestionActiveIndex);
      return;
    }
    activateCompanyQuery(marketCompanySearch.value);
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    hideMarketSuggestions();
  }
}

function setupMarketInteractions() {
  if (marketCompanySearch) {
    marketCompanySearch.addEventListener('input', () => {
      handleMarketCompanySearchInput();
    });
    marketCompanySearch.addEventListener('focus', () => {
      const query = normalizeMarketText(marketCompanySearch.value);
      if (!query) return;
      renderMarketSuggestions(buildMarketCompanySuggestions(query));
    });
    marketCompanySearch.addEventListener('keydown', (event) => {
      handleMarketCompanySearchKeydown(event);
    });
  }

  marketSortableHeaders.forEach((header) => {
    header.addEventListener('click', () => {
      const sortKey = normalizeMarketText(header?.dataset?.sortKey);
      if (!sortKey) return;
      toggleMarketSort(sortKey);
    });
  });

  document.addEventListener('click', (event) => {
    if (!marketSearchSuggestions || !marketCompanySearch) return;
    const target = event.target;
    if (!(target instanceof Node)) {
      hideMarketSuggestions();
      return;
    }
    if (marketSearchSuggestions.contains(target) || marketCompanySearch.contains(target)) return;
    hideMarketSuggestions();
  });

  updateMarketSortHeaders();
}

async function loadMarketData(responsesOverride = null) {
  if (!marketStatus || !marketTable || !marketTableBody) return;

  let responses = Array.isArray(responsesOverride) ? responsesOverride : null;
  if (!responses) {
    await ensureResponseStorageReady();
    responses = await readResponsesFromStorage();
  }

  marketRows = buildMarketRowsFromResponses(responses);
  renderMarketTable();
}

chrome.storage.onChanged.addListener((changes, namespace) => {
  console.log('[responses.js] Storage changed:', { namespace, changes });
  if ((namespace === 'local' || namespace === 'session') && changes[RESPONSE_STORAGE_KEY]) {
    console.log('[responses.js] Responses changed, reloading...');
    console.log(`   Old length: ${changes[RESPONSE_STORAGE_KEY].oldValue?.length || 0}`);
    console.log(`   New length: ${changes[RESPONSE_STORAGE_KEY].newValue?.length || 0}`);
    scheduleLoadResponses('storage_changed', 100);
  }
});

if (typeof document?.addEventListener === 'function') {
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      scheduleLoadResponses('visibility_change', 0);
    }
  });
}

if (typeof window?.addEventListener === 'function') {
  ['focus', 'pageshow', 'online'].forEach((eventName) => {
    window.addEventListener(eventName, () => {
      scheduleLoadResponses(eventName, 0);
    });
  });
}

