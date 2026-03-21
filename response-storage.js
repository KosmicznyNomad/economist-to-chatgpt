(function attachResponseStorageUtils(root, factory) {
  const api = factory(root);
  root.ResponseStorageUtils = api;
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createResponseStorageUtils(root) {
  const RESPONSE_STORAGE_KEY = 'responses';

  function normalizeText(value, fallback = '') {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || fallback;
  }

  function cloneJson(value, fallback) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return fallback;
    }
  }

  function getStorageAreas(override = null) {
    if (override && typeof override === 'object') {
      return {
        local: override.local || null,
        session: override.session || null
      };
    }
    return {
      local: root?.chrome?.storage?.local || null,
      session: root?.chrome?.storage?.session || null
    };
  }

  function resolveDecisionUtils(decisionUtils) {
    if (decisionUtils && typeof decisionUtils === 'object') return decisionUtils;
    return root?.DecisionContractUtils && typeof root.DecisionContractUtils === 'object'
      ? root.DecisionContractUtils
      : null;
  }

  function normalizeResponseTextForHash(text) {
    return normalizeText(text).replace(/\s+/g, ' ');
  }

  function stableHash(text) {
    const source = String(text || '');
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function normalizeDecisionContractSummary(summary) {
    if (!summary || typeof summary !== 'object') return null;
    const records = Array.isArray(summary.records) ? summary.records : [];
    return {
      version: normalizeText(summary.version),
      status: normalizeText(summary.status, 'invalid'),
      recordCount: Number.isInteger(summary.recordCount) ? summary.recordCount : 0,
      recordFormats: Array.isArray(summary.recordFormats)
        ? summary.recordFormats.filter((value) => typeof value === 'string' && value.trim())
        : [],
      issueCodes: Array.isArray(summary.issueCodes)
        ? summary.issueCodes.filter((value) => typeof value === 'string' && value.trim())
        : [],
      records: records.map((record) => ({
        role: normalizeText(record?.role),
        format: normalizeText(record?.format),
        decisionDate: normalizeText(record?.decisionDate),
        decisionStatus: normalizeText(record?.decisionStatus),
        company: normalizeText(record?.company),
        composite: normalizeText(record?.composite),
        compositeValue: Number.isFinite(record?.compositeValue) ? record.compositeValue : Number.NaN,
        entryScore: normalizeText(record?.entryScore),
        entryScoreValue: Number.isFinite(record?.entryScoreValue) ? record.entryScoreValue : Number.NaN,
        sizing: normalizeText(record?.sizing),
        sizingPercent: Number.isFinite(record?.sizingPercent) ? record.sizingPercent : Number.NaN,
        voi: normalizeText(record?.voi),
        fals: normalizeText(record?.fals),
        primaryRisk: normalizeText(record?.primaryRisk),
        sector: normalizeText(record?.sector),
        companyFamily: normalizeText(record?.companyFamily),
        companyType: normalizeText(record?.companyType),
        revenueModel: normalizeText(record?.revenueModel),
        region: normalizeText(record?.region),
        currency: normalizeText(record?.currency)
      }))
    };
  }

  function buildDecisionContractSummaryForResponse(response, decisionUtils) {
    const normalizedResponse = response && typeof response === 'object' ? response : null;
    if (!normalizedResponse) return null;
    if ((normalizedResponse.analysisType || 'company') !== 'company') {
      return normalizeDecisionContractSummary(normalizedResponse.decisionContract);
    }

    const utils = resolveDecisionUtils(decisionUtils);
    if (!utils || typeof utils.buildDecisionContractSummary !== 'function') {
      return normalizeDecisionContractSummary(normalizedResponse.decisionContract);
    }
    return normalizeDecisionContractSummary(utils.buildDecisionContractSummary(normalizedResponse.text || ''));
  }

  function normalizeResponseRecord(response, decisionUtils) {
    if (!response || typeof response !== 'object') return null;
    const text = typeof response.text === 'string' ? response.text : '';
    if (!text.trim()) return null;

    const normalized = { ...cloneJson(response, {}) };
    normalized.text = text;
    normalized.timestamp = Number.isInteger(response.timestamp) && response.timestamp > 0
      ? response.timestamp
      : Date.now();
    normalized.source = typeof response.source === 'string' ? response.source : '';
    normalized.analysisType = normalizeText(response.analysisType, 'company');
    normalized.responseId = normalizeText(response.responseId);

    if (normalizeText(response.runId)) {
      normalized.runId = response.runId.trim();
    } else {
      delete normalized.runId;
    }

    ['sourceTitle', 'sourceName', 'sourceUrl', 'conversationUrl', 'formattedText', 'formatted_text'].forEach((key) => {
      if (typeof response[key] === 'string' && response[key].trim()) {
        normalized[key] = response[key];
      }
    });

    if (response.stage && typeof response.stage === 'object' && !Array.isArray(response.stage)) {
      normalized.stage = cloneJson(response.stage, {});
    }
    if (Array.isArray(response.conversationLogs) && response.conversationLogs.length > 0) {
      normalized.conversationLogs = cloneJson(response.conversationLogs, []);
      normalized.conversationLogCount = normalized.conversationLogs.length;
    } else if (Number.isInteger(response.conversationLogCount) && response.conversationLogCount > 0) {
      normalized.conversationLogCount = response.conversationLogCount;
    }

    const decisionContract = buildDecisionContractSummaryForResponse(normalized, decisionUtils);
    if (decisionContract) {
      normalized.decisionContract = decisionContract;
    } else {
      delete normalized.decisionContract;
    }

    return normalized;
  }

  function buildResponseIdentityKeys(response) {
    if (!response || typeof response !== 'object') return [];
    const keys = [];
    const responseId = normalizeText(response.responseId);
    const runId = normalizeText(response.runId);
    const analysisType = normalizeText(response.analysisType, 'company');
    const source = normalizeText(response.source);
    const normalizedText = normalizeResponseTextForHash(response.text || '');
    const contentHash = normalizedText ? stableHash(normalizedText) : '';

    if (responseId) {
      keys.push(`response:${responseId}`);
    }
    if (runId && contentHash) {
      keys.push(`runhash:${runId}|${contentHash}`);
    }
    if (contentHash) {
      keys.push(`fallback:${stableHash([normalizedText, analysisType, source].join('|'))}`);
    }

    return Array.from(new Set(keys.filter(Boolean)));
  }

  function scoreDecisionContract(summary) {
    const normalized = normalizeDecisionContractSummary(summary);
    if (!normalized) return 0;
    let score = 0;
    if (normalized.status === 'current') score += 40;
    else if (normalized.status === 'shortfall') score += 32;
    else if (normalized.status === 'legacy') score += 14;
    score += Math.min(8, normalized.recordCount * 2);
    score += normalized.records.reduce((sum, record) => {
      let local = 0;
      if (record.composite) local += 2;
      if (record.entryScore) local += 1;
      if (record.sizing) local += 2;
      if (record.voi) local += 1;
      if (record.fals) local += 1;
      if (record.primaryRisk) local += 1;
      return sum + local;
    }, 0);
    return score;
  }

  function computeResponseRichness(response) {
    if (!response || typeof response !== 'object') return 0;
    let score = 0;
    if (normalizeText(response.responseId)) score += 14;
    if (normalizeText(response.runId)) score += 10;
    if (normalizeText(response.sourceTitle)) score += 3;
    if (normalizeText(response.sourceName)) score += 2;
    if (normalizeText(response.sourceUrl)) score += 4;
    if (normalizeText(response.conversationUrl)) score += 4;
    if (response.stage && typeof response.stage === 'object') score += Math.min(6, Object.keys(response.stage).length);
    if (Array.isArray(response.conversationLogs)) score += Math.min(10, response.conversationLogs.length);
    if (Number.isInteger(response.conversationLogCount) && response.conversationLogCount > 0) {
      score += Math.min(5, response.conversationLogCount);
    }
    if (typeof response.text === 'string' && response.text.trim()) {
      score += Math.min(20, Math.floor(response.text.trim().length / 240));
    }
    score += scoreDecisionContract(response.decisionContract);
    return score;
  }

  function mergeStageData(primary, secondary) {
    const left = primary && typeof primary === 'object' && !Array.isArray(primary) ? primary : null;
    const right = secondary && typeof secondary === 'object' && !Array.isArray(secondary) ? secondary : null;
    if (!left && !right) return undefined;
    return { ...(right || {}), ...(left || {}) };
  }

  function mergeConversationLogs(primary, secondary) {
    const left = Array.isArray(primary) ? primary : [];
    const right = Array.isArray(secondary) ? secondary : [];
    if (left.length === 0 && right.length === 0) return undefined;
    if (left.length >= right.length) return cloneJson(left, []);
    return cloneJson(right, []);
  }

  function mergeResponseFields(preferred, fallback, decisionUtils) {
    const left = normalizeResponseRecord(preferred, decisionUtils);
    const right = normalizeResponseRecord(fallback, decisionUtils);
    if (!left) return right;
    if (!right) return left;

    const merged = { ...right, ...left };
    merged.text = normalizeText(left.text) ? left.text : right.text;
    merged.source = normalizeText(left.source) ? left.source : right.source;
    merged.analysisType = normalizeText(left.analysisType, 'company') || normalizeText(right.analysisType, 'company');
    merged.responseId = normalizeText(left.responseId) ? left.responseId : right.responseId || '';
    if (normalizeText(left.runId) || normalizeText(right.runId)) {
      merged.runId = normalizeText(left.runId) ? left.runId : right.runId;
    } else {
      delete merged.runId;
    }
    merged.timestamp = Math.max(
      Number.isInteger(left.timestamp) ? left.timestamp : 0,
      Number.isInteger(right.timestamp) ? right.timestamp : 0
    );

    const stage = mergeStageData(left.stage, right.stage);
    if (stage) {
      merged.stage = stage;
    } else {
      delete merged.stage;
    }

    const conversationLogs = mergeConversationLogs(left.conversationLogs, right.conversationLogs);
    if (conversationLogs) {
      merged.conversationLogs = conversationLogs;
      merged.conversationLogCount = conversationLogs.length;
    } else if (Number.isInteger(left.conversationLogCount) || Number.isInteger(right.conversationLogCount)) {
      merged.conversationLogCount = Math.max(
        Number.isInteger(left.conversationLogCount) ? left.conversationLogCount : 0,
        Number.isInteger(right.conversationLogCount) ? right.conversationLogCount : 0
      );
    }

    const decisionContract = buildDecisionContractSummaryForResponse(merged, decisionUtils);
    if (decisionContract) {
      merged.decisionContract = decisionContract;
    }

    return merged;
  }

  function choosePreferredResponse(left, right, decisionUtils) {
    const normalizedLeft = normalizeResponseRecord(left, decisionUtils);
    const normalizedRight = normalizeResponseRecord(right, decisionUtils);
    if (!normalizedLeft) return normalizedRight;
    if (!normalizedRight) return normalizedLeft;

    const leftRichness = computeResponseRichness(normalizedLeft);
    const rightRichness = computeResponseRichness(normalizedRight);
    if (leftRichness > rightRichness) {
      return mergeResponseFields(normalizedLeft, normalizedRight, decisionUtils);
    }
    if (rightRichness > leftRichness) {
      return mergeResponseFields(normalizedRight, normalizedLeft, decisionUtils);
    }

    const leftTimestamp = Number.isInteger(normalizedLeft.timestamp) ? normalizedLeft.timestamp : 0;
    const rightTimestamp = Number.isInteger(normalizedRight.timestamp) ? normalizedRight.timestamp : 0;
    if (leftTimestamp > rightTimestamp) {
      return mergeResponseFields(normalizedLeft, normalizedRight, decisionUtils);
    }
    if (rightTimestamp > leftTimestamp) {
      return mergeResponseFields(normalizedRight, normalizedLeft, decisionUtils);
    }

    const leftLength = typeof normalizedLeft.text === 'string' ? normalizedLeft.text.length : 0;
    const rightLength = typeof normalizedRight.text === 'string' ? normalizedRight.text.length : 0;
    if (leftLength >= rightLength) {
      return mergeResponseFields(normalizedLeft, normalizedRight, decisionUtils);
    }
    return mergeResponseFields(normalizedRight, normalizedLeft, decisionUtils);
  }

  function mergeResponseCollections(primary, secondary, decisionUtils) {
    const merged = [];
    const identityToIndex = new Map();

    const add = (response) => {
      const normalized = normalizeResponseRecord(response, decisionUtils);
      if (!normalized) return;
      const keys = buildResponseIdentityKeys(normalized);
      if (keys.length === 0) return;

      let existingIndex = -1;
      for (let index = 0; index < keys.length; index += 1) {
        const existing = identityToIndex.get(keys[index]);
        if (Number.isInteger(existing)) {
          existingIndex = existing;
          break;
        }
      }

      if (existingIndex === -1) {
        const nextIndex = merged.length;
        merged.push(normalized);
        keys.forEach((key) => identityToIndex.set(key, nextIndex));
        return;
      }

      const current = merged[existingIndex];
      const chosen = choosePreferredResponse(current, normalized, decisionUtils);
      merged[existingIndex] = chosen;
      const mergedKeys = Array.from(new Set([
        ...buildResponseIdentityKeys(current),
        ...keys,
        ...buildResponseIdentityKeys(chosen)
      ]));
      mergedKeys.forEach((key) => identityToIndex.set(key, existingIndex));
    };

    (Array.isArray(primary) ? primary : []).forEach(add);
    (Array.isArray(secondary) ? secondary : []).forEach(add);
    return merged;
  }

  function findMatchingResponse(responses, candidate) {
    const keys = buildResponseIdentityKeys(candidate);
    if (keys.length === 0) return null;
    const safeResponses = Array.isArray(responses) ? responses : [];
    for (let index = 0; index < safeResponses.length; index += 1) {
      const response = safeResponses[index];
      const responseKeys = buildResponseIdentityKeys(response);
      if (responseKeys.some((key) => keys.includes(key))) {
        return response;
      }
    }
    return null;
  }

  async function readStorageArray(area, key) {
    if (!area || typeof area.get !== 'function') return [];
    const result = await area.get([key]);
    return Array.isArray(result?.[key]) ? result[key] : [];
  }

  async function writeStorageArray(area, key, values) {
    if (!area || typeof area.set !== 'function') return;
    await area.set({ [key]: values });
  }

  async function removeStorageKey(area, key) {
    if (!area || typeof area.remove !== 'function') return;
    await area.remove([key]);
  }

  async function readCanonicalResponses(storageOverride = null, decisionUtils) {
    const { local, session } = getStorageAreas(storageOverride);
    const [localResponses, sessionResponses] = await Promise.all([
      readStorageArray(local, RESPONSE_STORAGE_KEY),
      readStorageArray(session, RESPONSE_STORAGE_KEY)
    ]);
    return mergeResponseCollections(localResponses, sessionResponses, decisionUtils);
  }

  async function writeCanonicalResponses(responses, storageOverride = null, options = {}) {
    const { local, session } = getStorageAreas(storageOverride);
    const safeResponses = Array.isArray(responses) ? cloneJson(responses, []) : [];
    const tasks = [];
    if (local) {
      tasks.push(writeStorageArray(local, RESPONSE_STORAGE_KEY, safeResponses));
    }
    if (session) {
      if (options.mirrorToSession === true) {
        tasks.push(writeStorageArray(session, RESPONSE_STORAGE_KEY, safeResponses));
      } else if (options.clearSession !== false) {
        tasks.push(removeStorageKey(session, RESPONSE_STORAGE_KEY));
      }
    }
    await Promise.all(tasks);
    return safeResponses;
  }

  function shouldRewriteStorage(rawLocalResponses, rawSessionResponses, canonicalResponses) {
    const currentLocal = cloneJson(Array.isArray(rawLocalResponses) ? rawLocalResponses : [], []);
    const currentSession = cloneJson(Array.isArray(rawSessionResponses) ? rawSessionResponses : [], []);
    const canonical = cloneJson(Array.isArray(canonicalResponses) ? canonicalResponses : [], []);
    return JSON.stringify(currentLocal) !== JSON.stringify(canonical)
      || currentSession.length > 0;
  }

  async function migrateLegacyResponseStorage(storageOverride = null, decisionUtils, options = {}) {
    const { local, session } = getStorageAreas(storageOverride);
    const [rawLocalResponses, rawSessionResponses] = await Promise.all([
      readStorageArray(local, RESPONSE_STORAGE_KEY),
      readStorageArray(session, RESPONSE_STORAGE_KEY)
    ]);
    const canonicalResponses = mergeResponseCollections(rawLocalResponses, rawSessionResponses, decisionUtils);
    const shouldRewrite = shouldRewriteStorage(rawLocalResponses, rawSessionResponses, canonicalResponses);
    if (shouldRewrite) {
      await writeCanonicalResponses(canonicalResponses, { local, session }, options);
    }
    return {
      responses: canonicalResponses,
      migratedSessionCount: Array.isArray(rawSessionResponses) ? rawSessionResponses.length : 0,
      rewritten: shouldRewrite
    };
  }

  async function upsertCanonicalResponse(response, storageOverride = null, decisionUtils, options = {}) {
    const { local, session } = getStorageAreas(storageOverride);
    const [rawLocalResponses, rawSessionResponses] = await Promise.all([
      readStorageArray(local, RESPONSE_STORAGE_KEY),
      readStorageArray(session, RESPONSE_STORAGE_KEY)
    ]);
    const merged = mergeResponseCollections(rawLocalResponses, rawSessionResponses, decisionUtils);
    const nextResponses = mergeResponseCollections(merged, [response], decisionUtils);
    await writeCanonicalResponses(nextResponses, { local, session }, options);
    return {
      responses: nextResponses,
      savedResponse: findMatchingResponse(nextResponses, response),
      rewritten: true
    };
  }

  async function clearCanonicalResponses(storageOverride = null) {
    const { local, session } = getStorageAreas(storageOverride);
    const tasks = [];
    if (local) {
      tasks.push(writeStorageArray(local, RESPONSE_STORAGE_KEY, []));
    }
    if (session) {
      tasks.push(writeStorageArray(session, RESPONSE_STORAGE_KEY, []));
    }
    await Promise.all(tasks);
  }

  return {
    RESPONSE_STORAGE_KEY,
    buildDecisionContractSummaryForResponse,
    buildResponseIdentityKeys,
    choosePreferredResponse,
    clearCanonicalResponses,
    computeResponseRichness,
    findMatchingResponse,
    getStorageAreas,
    mergeResponseCollections,
    migrateLegacyResponseStorage,
    normalizeResponseRecord,
    normalizeResponseTextForHash,
    readCanonicalResponses,
    stableHash,
    upsertCanonicalResponse,
    writeCanonicalResponses
  };
});
