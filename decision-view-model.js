(function attachDecisionViewModelUtils(root, factory) {
  const api = factory(root);
  root.DecisionViewModelUtils = api;
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createDecisionViewModelUtils(root) {
  const stage12ViewCache = new Map();
  const CACHE_LIMIT = 1000;

  function normalizeText(value, fallback = '') {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || fallback;
  }

  function normalizeToken(value) {
    return normalizeText(value).toLowerCase();
  }

  function normalizeFuzzyText(value) {
    const source = normalizeText(value).toLowerCase();
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
    return normalized ? normalized.split(' ').filter(Boolean) : [];
  }

  function safeLocaleCompare(left, right) {
    return String(left || '').localeCompare(String(right || ''), 'pl', { sensitivity: 'base' });
  }

  function uniqueStrings(values) {
    return Array.from(new Set((Array.isArray(values) ? values : []).filter((value) => typeof value === 'string' && value.trim())));
  }

  function pickFiniteNumber(...values) {
    for (const value of values) {
      if (Number.isFinite(value)) return value;
    }
    return Number.NaN;
  }

  function getContractStatusScore(status, decisionUtils) {
    if (decisionUtils && typeof decisionUtils.getDecisionContractStatusScore === 'function') {
      return decisionUtils.getDecisionContractStatusScore(status);
    }
    if (status === 'current') return 4;
    if (status === 'shortfall') return 3;
    if (status === 'legacy') return 2;
    return 1;
  }

  function getRolePriority(role) {
    const normalized = normalizeText(role).toUpperCase();
    if (normalized === 'PRIMARY') return 2;
    if (normalized === 'SECONDARY') return 1;
    return 0;
  }

  function parseCompositeValue(text) {
    const normalized = normalizeText(text).replace(',', '.');
    if (!normalized) return Number.NaN;
    const ratioMatch = normalized.match(/(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/);
    if (ratioMatch) return Number.parseFloat(ratioMatch[1]);
    const match = normalized.match(/-?\d+(?:\.\d+)?/);
    return match ? Number.parseFloat(match[0]) : Number.NaN;
  }

  function parseSizingPercent(text) {
    const normalized = normalizeText(text).replace(',', '.');
    if (!normalized) return Number.NaN;
    const match = normalized.match(/(-?\d+(?:\.\d+)?)\s*%/);
    return match ? Number.parseFloat(match[1]) : Number.NaN;
  }

  function parseAsymmetryValue(rawAsymmetry, thesisText = '') {
    const merged = [normalizeText(rawAsymmetry), normalizeText(thesisText)]
      .filter(Boolean)
      .join(' | ')
      .replace(/,/g, '.');
    if (!merged) return Number.NaN;

    const ratioMatch = merged.match(/(-?\d+(?:\.\d+)?)\s*:\s*1/i);
    if (ratioMatch) return Number.parseFloat(ratioMatch[1]);

    const xMatch = merged.match(/(-?\d+(?:\.\d+)?)\s*x\b/i);
    if (xMatch) return Number.parseFloat(xMatch[1]);

    const pctMatch = merged.match(/(-?\d+(?:\.\d+)?)\s*%/);
    if (pctMatch) return Number.parseFloat(pctMatch[1]) / 100;

    const plainMatch = merged.match(/-?\d+(?:\.\d+)?/);
    return plainMatch ? Number.parseFloat(plainMatch[0]) : Number.NaN;
  }

  function parseDecisionDateToTimestamp(decisionDate, fallbackTimestamp = 0) {
    const source = normalizeText(decisionDate);
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
    return Number.isInteger(fallbackTimestamp) && fallbackTimestamp > 0 ? fallbackTimestamp : 0;
  }

  function extractTickerFromCompany(companyLabel) {
    const source = normalizeText(companyLabel);
    if (!source) return '';

    const blocked = new Set(['SA', 'SPA', 'AG', 'NV', 'PLC', 'INC', 'CORP', 'LTD', 'LLC', 'SE']);
    const fromParen = source.match(/\(([A-Z0-9.\-]{1,10})\)/);
    if (fromParen && !blocked.has(fromParen[1])) return fromParen[1];

    const fromExchange = source.match(/\b(?:NYSE|NASDAQ|LSE|XETRA|GPW|ASX|TSX|SGX)\s*[:\-]\s*([A-Z0-9.\-]{1,10})\b/i);
    if (fromExchange) return fromExchange[1].toUpperCase();

    const fromSuffix = source.match(/\b([A-Z0-9.\-]{1,10})\s*$/);
    if (fromSuffix && !blocked.has(fromSuffix[1])) return fromSuffix[1].toUpperCase();

    return '';
  }

  function resolveCacheKey(response) {
    if (!response || typeof response !== 'object') return '';
    const responseId = normalizeText(response.responseId);
    const timestamp = Number.isInteger(response.timestamp) ? response.timestamp : 0;
    const source = normalizeText(response.source);
    if (responseId || timestamp) return `${responseId}|${timestamp}`;
    return `${source}|${normalizeText(response.text).slice(0, 120)}`;
  }

  function setCachedState(key, value) {
    if (!key) return value;
    if (stage12ViewCache.size >= CACHE_LIMIT) {
      const oldestKey = stage12ViewCache.keys().next().value;
      if (oldestKey) stage12ViewCache.delete(oldestKey);
    }
    stage12ViewCache.set(key, value);
    return value;
  }

  function normalizeSummary(summary, decisionUtils) {
    if (!summary || typeof summary !== 'object') return null;
    if (decisionUtils && typeof decisionUtils.normalizeDecisionContractSummary === 'function') {
      return decisionUtils.normalizeDecisionContractSummary(summary);
    }
    return summary;
  }

  function normalizeSnapshot(summary, decisionUtils) {
    if (decisionUtils && typeof decisionUtils.buildDecisionContractSnapshot === 'function') {
      return decisionUtils.buildDecisionContractSnapshot(summary);
    }
    const normalizedSummary = normalizeSummary(summary, decisionUtils);
    const records = Array.isArray(normalizedSummary?.records) ? normalizedSummary.records.slice() : [];
    const primaryRecord = records.find((record) => normalizeText(record?.role).toUpperCase() === 'PRIMARY') || records[0] || null;
    const secondaryRecord = records.find((record) => normalizeText(record?.role).toUpperCase() === 'SECONDARY') || null;
    return {
      status: normalizeText(normalizedSummary?.status, 'invalid'),
      issueCodes: Array.isArray(normalizedSummary?.issueCodes) ? normalizedSummary.issueCodes.slice() : [],
      recordCount: Number.isInteger(normalizedSummary?.recordCount) ? normalizedSummary.recordCount : records.length,
      recordFormats: Array.isArray(normalizedSummary?.recordFormats) ? normalizedSummary.recordFormats.slice() : [],
      records,
      primaryRecord,
      secondaryRecord,
      company: normalizeText(primaryRecord?.company || secondaryRecord?.company || records[0]?.company),
      hasDecisionRecord: records.length > 0,
      secondaryPresent: !!secondaryRecord
    };
  }

  function findRawRecordForSummary(summaryRecord, rawRecords, usedIndexes) {
    const normalizedRole = normalizeText(summaryRecord?.role).toUpperCase();
    const normalizedCompany = normalizeText(summaryRecord?.company);
    for (let index = 0; index < rawRecords.length; index += 1) {
      if (usedIndexes.has(index)) continue;
      const candidate = rawRecords[index];
      if (
        normalizeText(candidate?.company) === normalizedCompany
        && normalizeText(candidate?.decisionRole).toUpperCase() === normalizedRole
      ) {
        usedIndexes.add(index);
        return candidate;
      }
    }
    for (let index = 0; index < rawRecords.length; index += 1) {
      if (usedIndexes.has(index)) continue;
      const candidate = rawRecords[index];
      if (normalizeText(candidate?.company) === normalizedCompany) {
        usedIndexes.add(index);
        return candidate;
      }
    }
    for (let index = 0; index < rawRecords.length; index += 1) {
      if (usedIndexes.has(index)) continue;
      usedIndexes.add(index);
      return rawRecords[index];
    }
    return null;
  }

  function mergeRecordView(summaryRecord, rawRecord) {
    const summary = summaryRecord && typeof summaryRecord === 'object' ? summaryRecord : {};
    const raw = rawRecord && typeof rawRecord === 'object' ? rawRecord : {};
    const role = normalizeText(summary.role || raw.decisionRole).toUpperCase();
    const composite = normalizeText(summary.composite || raw.composite);
    const sizing = normalizeText(summary.sizing || raw.sizing);
    const asymmetry = normalizeText(raw.asymmetry || summary.asymmetry);
    return {
      role,
      format: normalizeText(summary.format || raw.recordFormat),
      decisionDate: normalizeText(summary.decisionDate || raw.decisionDate),
      decisionStatus: normalizeText(summary.decisionStatus || raw.decisionStatus),
      company: normalizeText(summary.company || raw.company),
      composite,
      compositeValue: pickFiniteNumber(summary.compositeValue, parseCompositeValue(composite)),
      entryScore: normalizeText(summary.entryScore || raw.entryScore),
      entryScoreValue: pickFiniteNumber(summary.entryScoreValue),
      sizing,
      sizingPercent: pickFiniteNumber(summary.sizingPercent, parseSizingPercent(sizing)),
      voi: normalizeText(summary.voi || raw.voi),
      fals: normalizeText(summary.fals || raw.fals),
      primaryRisk: normalizeText(summary.primaryRisk || raw.primaryRisk),
      asymmetry,
      asymmetryValue: parseAsymmetryValue(asymmetry, raw.thesis),
      sourceMaterial: normalizeText(raw.sourceMaterial),
      thesis: normalizeText(raw.thesis),
      bear: normalizeText(raw.bear),
      base: normalizeText(raw.base),
      bull: normalizeText(raw.bull),
      sector: normalizeText(summary.sector || raw.sector),
      companyFamily: normalizeText(summary.companyFamily || raw.companyFamily || raw.sector),
      companyType: normalizeText(summary.companyType || raw.companyType),
      revenueModel: normalizeText(summary.revenueModel || raw.revenueModel),
      region: normalizeText(summary.region || raw.region),
      currency: normalizeText(summary.currency || raw.currency),
      canonicalLine: normalizeText(raw.canonicalLine)
    };
  }

  function buildValidatedStage12State(response, decisionUtils) {
    const cacheKey = resolveCacheKey(response);
    if (cacheKey && stage12ViewCache.has(cacheKey)) {
      return stage12ViewCache.get(cacheKey);
    }

    const text = normalizeText(response?.text);
    const validation = decisionUtils && typeof decisionUtils.validateDecisionContractText === 'function'
      ? decisionUtils.validateDecisionContractText(text)
      : null;
    const storedSummary = normalizeSummary(response?.decisionContract, decisionUtils);
    const validationSummary = normalizeSummary(validation?.decisionContract, decisionUtils);
    const effectiveSummary = validationSummary || storedSummary;
    const snapshot = normalizeSnapshot(effectiveSummary, decisionUtils);
    const rawRecords = Array.isArray(validation?.records) ? validation.records : [];
    const summaryRecords = Array.isArray(snapshot?.records) ? snapshot.records : [];
    const usedIndexes = new Set();
    const records = summaryRecords.map((summaryRecord) => mergeRecordView(
      summaryRecord,
      findRawRecordForSummary(summaryRecord, rawRecords, usedIndexes)
    ));
    const primaryRecord = records.find((record) => record.role === 'PRIMARY') || records[0] || null;
    const secondaryRecord = records.find((record) => record.role === 'SECONDARY') || null;
    const status = normalizeText(validation?.status || snapshot?.status, 'invalid');
    const issueCodes = uniqueStrings(
      []
        .concat(Array.isArray(validation?.issueCodes) ? validation.issueCodes : [])
        .concat(Array.isArray(snapshot?.issueCodes) ? snapshot.issueCodes : [])
    );
    const company = normalizeText(
      primaryRecord?.company
      || secondaryRecord?.company
      || snapshot?.company
      || response?.source
      || ''
    );

    return setCachedState(cacheKey, {
      cacheKey,
      responseId: normalizeText(response?.responseId),
      runId: normalizeText(response?.runId),
      responseTs: Number.isInteger(response?.timestamp) ? response.timestamp : 0,
      text,
      validation,
      storedSummary,
      summary: effectiveSummary,
      snapshot,
      status,
      issueCodes,
      recordCount: Number.isInteger(snapshot?.recordCount)
        ? snapshot.recordCount
        : (Number.isInteger(validation?.recordCount) ? validation.recordCount : records.length),
      recordFormats: uniqueStrings(
        []
          .concat(Array.isArray(snapshot?.recordFormats) ? snapshot.recordFormats : [])
          .concat(Array.isArray(validation?.recordFormats) ? validation.recordFormats : [])
      ),
      records,
      primaryRecord,
      secondaryRecord,
      shortfallDetected: validation?.shortfallDetected === true || status === 'shortfall',
      canonicalText: normalizeText(validation?.canonicalText || text),
      company,
      hasDecisionRecord: records.length > 0,
      hasRenderableCompany: Boolean(company)
    });
  }

  function buildStage12PairSummary(response, decisionUtils) {
    const state = buildValidatedStage12State(response, decisionUtils);
    if (!state || !state.hasDecisionRecord) {
      return {
        status: state?.status || 'invalid',
        issueCodes: Array.isArray(state?.issueCodes) ? state.issueCodes : [],
        lines: [],
        shortfall: false
      };
    }

    if (state.status !== 'current' && state.status !== 'shortfall') {
      return {
        status: state.status,
        issueCodes: state.issueCodes,
        lines: [],
        shortfall: state.shortfallDetected === true
      };
    }

    const lines = state.records
      .filter((record) => record && typeof record === 'object')
      .map((record) => {
        const left = `${record.role || 'RECORD'} - ${record.company || 'brak'}`;
        const middle = `${record.decisionStatus || '-'}`;
        const composite = `Composite ${record.composite || '-'}`;
        const sizing = `Sizing ${record.sizing || '-'}`;
        return [left, middle, composite, sizing].join(' | ');
      });
    if (state.shortfallDetected) {
      lines.push('SHORTFALL - only 1 company passed Stage 10 gates');
    }
    return {
      status: state.status,
      issueCodes: state.issueCodes,
      lines,
      shortfall: state.shortfallDetected === true
    };
  }

  function buildMarketRow(record, state) {
    const company = normalizeText(record?.company || state?.company);
    const ticker = extractTickerFromCompany(company);
    const responseTs = Number.isInteger(state?.responseTs) ? state.responseTs : 0;
    const decisionTs = parseDecisionDateToTimestamp(record?.decisionDate, responseTs);
    const role = normalizeText(record?.role);
    const contractStatus = normalizeText(state?.status, 'invalid');
    const contractScore = getContractStatusScore(contractStatus, null);
    const sector = normalizeText(record?.sector, '-');
    const region = normalizeText(record?.region, '-');
    const currency = normalizeText(record?.currency, '-');
    return {
      key: `${normalizeToken(company)}|${normalizeToken(ticker || '-')}` + `|${normalizeToken(role || 'record')}`,
      companyKey: `${normalizeToken(company)}|${normalizeToken(ticker || '-')}`,
      responseId: normalizeText(state?.responseId),
      runId: normalizeText(state?.runId),
      company,
      ticker: ticker || '-',
      role: role || '',
      rolePriority: getRolePriority(role),
      decisionStatus: normalizeText(record?.decisionStatus, '-'),
      contractStatus,
      contractScore,
      contractIssueCodes: Array.isArray(state?.issueCodes) ? state.issueCodes.slice() : [],
      compositeText: normalizeText(record?.composite, '-'),
      compositeValue: Number.isFinite(record?.compositeValue) ? record.compositeValue : Number.NaN,
      sizingText: normalizeText(record?.sizing, '-'),
      sizingPercent: Number.isFinite(record?.sizingPercent) ? record.sizingPercent : Number.NaN,
      voi: normalizeText(record?.voi),
      fals: normalizeText(record?.fals),
      primaryRisk: normalizeText(record?.primaryRisk),
      asymmetryText: normalizeText(record?.asymmetry),
      asymmetryValue: Number.isFinite(record?.asymmetryValue) ? record.asymmetryValue : Number.NaN,
      bear: normalizeText(record?.bear),
      base: normalizeText(record?.base),
      bull: normalizeText(record?.bull),
      sector,
      companyFamily: normalizeText(record?.companyFamily || record?.sector),
      companyType: normalizeText(record?.companyType),
      revenueModel: normalizeText(record?.revenueModel),
      region,
      currency,
      decisionDateRaw: normalizeText(record?.decisionDate),
      decisionTs,
      responseTs,
      companyFuzzy: normalizeFuzzyText(company),
      tickerFuzzy: normalizeFuzzyText(ticker || '-'),
      searchHaystack: normalizeFuzzyText([
        company,
        ticker,
        role,
        record?.decisionStatus,
        sector,
        region,
        currency,
        contractStatus
      ].join(' ')),
      searchTokens: tokenizeFuzzyText([
        company,
        ticker,
        role,
        record?.decisionStatus,
        sector,
        region,
        currency,
        contractStatus
      ].join(' '))
    };
  }

  function comparePreferredRows(left, right, decisionUtils) {
    const leftScore = getContractStatusScore(left?.contractStatus, decisionUtils);
    const rightScore = getContractStatusScore(right?.contractStatus, decisionUtils);
    if (leftScore !== rightScore) return leftScore - rightScore;

    const leftComposite = Number.isFinite(left?.compositeValue) ? left.compositeValue : Number.NEGATIVE_INFINITY;
    const rightComposite = Number.isFinite(right?.compositeValue) ? right.compositeValue : Number.NEGATIVE_INFINITY;
    if (leftComposite !== rightComposite) return leftComposite - rightComposite;

    const leftSizing = Number.isFinite(left?.sizingPercent) ? left.sizingPercent : Number.NEGATIVE_INFINITY;
    const rightSizing = Number.isFinite(right?.sizingPercent) ? right.sizingPercent : Number.NEGATIVE_INFINITY;
    if (leftSizing !== rightSizing) return leftSizing - rightSizing;

    const leftDecisionTs = Number.isFinite(left?.decisionTs) ? left.decisionTs : 0;
    const rightDecisionTs = Number.isFinite(right?.decisionTs) ? right.decisionTs : 0;
    if (leftDecisionTs !== rightDecisionTs) return leftDecisionTs - rightDecisionTs;

    const leftResponseTs = Number.isFinite(left?.responseTs) ? left.responseTs : 0;
    const rightResponseTs = Number.isFinite(right?.responseTs) ? right.responseTs : 0;
    if (leftResponseTs !== rightResponseTs) return leftResponseTs - rightResponseTs;

    return -safeLocaleCompare(left?.company, right?.company);
  }

  function pickPreferredMarketRow(left, right, decisionUtils) {
    if (!left) return right || null;
    if (!right) return left || null;
    return comparePreferredRows(left, right, decisionUtils) >= 0 ? left : right;
  }

  function compareMarketRowsDefault(left, right, decisionUtils) {
    const leftScore = getContractStatusScore(left?.contractStatus, decisionUtils);
    const rightScore = getContractStatusScore(right?.contractStatus, decisionUtils);
    if (rightScore !== leftScore) return rightScore - leftScore;

    const leftComposite = Number.isFinite(left?.compositeValue) ? left.compositeValue : Number.NEGATIVE_INFINITY;
    const rightComposite = Number.isFinite(right?.compositeValue) ? right.compositeValue : Number.NEGATIVE_INFINITY;
    if (rightComposite !== leftComposite) return rightComposite - leftComposite;

    const leftSizing = Number.isFinite(left?.sizingPercent) ? left.sizingPercent : Number.NEGATIVE_INFINITY;
    const rightSizing = Number.isFinite(right?.sizingPercent) ? right.sizingPercent : Number.NEGATIVE_INFINITY;
    if (rightSizing !== leftSizing) return rightSizing - leftSizing;

    const leftRole = getRolePriority(left?.role);
    const rightRole = getRolePriority(right?.role);
    if (rightRole !== leftRole) return rightRole - leftRole;

    const leftDecisionTs = Number.isFinite(left?.decisionTs) ? left.decisionTs : 0;
    const rightDecisionTs = Number.isFinite(right?.decisionTs) ? right.decisionTs : 0;
    if (rightDecisionTs !== leftDecisionTs) return rightDecisionTs - leftDecisionTs;

    return safeLocaleCompare(left?.company, right?.company);
  }

  function buildMarketRowsFromResponses(responses, decisionUtils) {
    const dedupedRows = new Map();
    (Array.isArray(responses) ? responses : []).forEach((response) => {
      if ((response?.analysisType || 'company') !== 'company') return;
      const state = buildValidatedStage12State(response, decisionUtils);
      if (!state || !state.hasDecisionRecord) return;
      if (state.status === 'invalid') return;

      state.records.forEach((record) => {
        if (!record || typeof record !== 'object') return;
        if (state.status === 'current' || state.status === 'shortfall' || state.status === 'legacy') {
          const row = buildMarketRow(record, state);
          if (!row.company) return;
          const existing = dedupedRows.get(row.key);
          dedupedRows.set(row.key, pickPreferredMarketRow(row, existing, decisionUtils));
        }
      });
    });

    const rows = Array.from(dedupedRows.values());
    rows.sort((left, right) => compareMarketRowsDefault(left, right, decisionUtils));
    rows.forEach((row, index) => {
      row.baseRank = index + 1;
    });
    return rows;
  }

  function clearStage12ViewCache() {
    stage12ViewCache.clear();
  }

  return {
    buildValidatedStage12State,
    buildMarketRowsFromResponses,
    buildStage12PairSummary,
    pickPreferredMarketRow,
    compareMarketRowsDefault,
    parseCompositeValue,
    parseSizingPercent,
    getContractStatusScore,
    clearStage12ViewCache,
    normalizeText,
    safeLocaleCompare
  };
});
