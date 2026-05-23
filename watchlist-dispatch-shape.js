(function attachWatchlistDispatchShapeUtils(root, factory) {
  const api = factory();
  root.WatchlistDispatchShapeUtils = api;
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createWatchlistDispatchShapeUtils() {
  const DECISION_ROLES = new Set(['PRIMARY', 'SECONDARY']);
  const CANONICAL_FIELD_KEYS = [
    'data_decyzji',
    'spolka',
    'zrodlo_tezy',
    'material_zrodlowy_podcast',
    'teza_inwestycyjna',
    'bear_scenario_total',
    'base_scenario_total',
    'bull_scenario_total',
    'voi_falsy_kluczowe_ryzyka',
    'sektor',
    'rodzina_spolki',
    'typ_spolki',
    'model_przychodu',
    'region',
    'waluta',
    'decision_role'
  ];
  const STRUCTURED_FIELD_ALIASES = {
    data_decyzji: ['decision_date', 'date'],
    spolka: ['nazwa_spolki', 'nazwa', 'company_name', 'company', 'issuer_name', 'issuer'],
    zrodlo_tezy: ['source_thesis'],
    material_zrodlowy_podcast: ['source_material', 'material'],
    decision_role: ['rola_na_watchliscie', 'role']
  };
  const STRUCTURED_TICKER_KEYS = ['ticker', 'symbol'];
  const STRUCTURED_EXCHANGE_KEYS = ['gielda', 'exchange', 'listing_exchange'];
  const STRUCTURED_EXCHANGE_ALIASES = {
    WBAG: 'VIE',
    VI: 'VIE',
    XNAS: 'NASDAQ',
    XNYS: 'NYSE'
  };
  const TAXONOMY_KEY_ALIASES = {
    sector: ['sektor'],
    worldview_bucket: ['worldviewBucket', 'theme', 'thesis_theme'],
    company_family: ['companyFamily', 'rodzina_spolki'],
    company_type: ['companyType', 'typ_spolki'],
    revenue_model: ['revenueModel', 'model_przychodu'],
    region: [],
    currency: ['waluta']
  };

  function normalizeText(value, fallback = '') {
    if (typeof value === 'string') {
      const text = value.trim();
      return text || fallback;
    }
    if (value === null || value === undefined) return fallback;
    const text = String(value).trim();
    return text || fallback;
  }

  function normalizeStructuredJsonValue(value) {
    if (Array.isArray(value)) {
      return value.map((item) => normalizeStructuredJsonValue(item));
    }
    if (value && typeof value === 'object') {
      const normalized = {};
      Object.entries(value).forEach(([rawKey, rawValue]) => {
        const key = normalizeText(rawKey);
        if (!key) return;
        normalized[key] = normalizeStructuredJsonValue(rawValue);
      });
      return normalized;
    }
    if (typeof value === 'string') {
      return value.trim();
    }
    return value;
  }

  function cloneStructuredObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const normalized = normalizeStructuredJsonValue(value);
    return normalized && typeof normalized === 'object' && !Array.isArray(normalized)
      ? normalized
      : {};
  }

  function firstNonEmptyStructuredValue(source, keys) {
    const safeSource = source && typeof source === 'object' ? source : {};
    for (const key of Array.isArray(keys) ? keys : []) {
      const value = normalizeText(safeSource?.[key]);
      if (value) return value;
    }
    return '';
  }

  function normalizeStructuredDecisionStatus(value) {
    const normalized = normalizeText(value).toUpperCase();
    if (!normalized) return '';
    if (normalized === 'BUY' || normalized === 'WATCH' || normalized === 'AVOID') return normalized;
    if (normalized === 'KUPUJ') return 'BUY';
    if (normalized === 'OBSERWUJ') return 'WATCH';
    if (normalized === 'SPRZEDAJ' || normalized === 'UNIKAJ') return 'AVOID';
    return normalized;
  }

  function normalizeStructuredDecisionAction(value) {
    const normalized = normalizeText(value).toUpperCase();
    if (!normalized) return '';
    if (normalized.includes('AVOID')) return 'AVOID';
    if (normalized.includes('WATCH')) return 'WATCH';
    if (normalized.includes('BUY')) return 'BUY';
    return normalizeStructuredDecisionStatus(normalized);
  }

  function deriveStructuredDecisionStatus(record, fields, extras) {
    const safeRecord = record && typeof record === 'object' ? record : {};
    const safeFields = fields && typeof fields === 'object' ? fields : {};
    const safeExtras = extras && typeof extras === 'object' ? extras : {};
    const identity = safeExtras.identity && typeof safeExtras.identity === 'object' ? safeExtras.identity : {};
    const candidates = [
      safeRecord.decisionStatus,
      safeRecord.decision_status,
      safeRecord.decision,
      safeRecord.decisionAction,
      safeRecord.decision_action,
      safeFields.status_decyzji,
      safeFields.decyzja,
      safeFields.decision,
      safeFields.status,
      safeFields.decision_action,
      identity.decision_category,
      identity.decision_action
    ];
    for (const candidate of candidates) {
      const normalized = normalizeStructuredDecisionAction(candidate);
      if (normalized) return normalized;
    }
    return 'WATCH';
  }

  function normalizeStructuredExchange(value) {
    const normalized = normalizeText(value).toUpperCase();
    if (!normalized) return '';
    return STRUCTURED_EXCHANGE_ALIASES[normalized] || normalized;
  }

  function normalizeStructuredTicker(rawTicker, exchange = '') {
    const ticker = normalizeText(rawTicker).toUpperCase();
    if (!ticker) return '';
    const safeExchange = normalizeStructuredExchange(exchange);
    const parts = ticker.split('.');
    if (parts.length >= 2) {
      const suffix = normalizeStructuredExchange(parts[parts.length - 1]);
      if (suffix && safeExchange && suffix === safeExchange) {
        return parts.slice(0, -1).join('.');
      }
    }
    return ticker;
  }

  function synthesizeStructuredCompany(fields) {
    const safeFields = fields && typeof fields === 'object' ? fields : {};
    const company = firstNonEmptyStructuredValue(safeFields, ['spolka', ...STRUCTURED_FIELD_ALIASES.spolka]);
    const exchange = normalizeStructuredExchange(
      firstNonEmptyStructuredValue(safeFields, STRUCTURED_EXCHANGE_KEYS)
    );
    const ticker = normalizeStructuredTicker(
      firstNonEmptyStructuredValue(safeFields, STRUCTURED_TICKER_KEYS),
      exchange
    );
    if (!company) {
      if (ticker && exchange) return `${ticker}:${exchange}`;
      return ticker;
    }
    if (ticker && exchange) {
      const normalizedCompany = company.replace(/\s+/g, ' ').trim();
      const companyPattern = new RegExp(`\\(${ticker}\\s*:\\s*${exchange}\\)$`, 'i');
      if (companyPattern.test(normalizedCompany)) {
        return normalizedCompany;
      }
      return `${normalizedCompany} (${ticker}:${exchange})`;
    }
    if (ticker) {
      const normalizedCompany = company.replace(/\s+/g, ' ').trim();
      const companyPattern = new RegExp(`\\(${ticker}\\)$`, 'i');
      if (companyPattern.test(normalizedCompany)) {
        return normalizedCompany;
      }
      return `${normalizedCompany} (${ticker})`;
    }
    return company;
  }

  function normalizeStructuredSection(section, aliasMap = {}) {
    const normalized = cloneStructuredObject(section);
    Object.entries(aliasMap).forEach(([canonicalKey, aliases]) => {
      if (normalizeText(normalized[canonicalKey])) return;
      const value = firstNonEmptyStructuredValue(normalized, [canonicalKey, ...(Array.isArray(aliases) ? aliases : [])]);
      if (value) normalized[canonicalKey] = value;
    });
    return normalized;
  }

  function mapDecisionRecordForDispatch(record) {
    if (!record || typeof record !== 'object') return null;
    const field10Meta = record.field10Meta && typeof record.field10Meta === 'object'
      ? record.field10Meta
      : {};
    const fields = cloneStructuredObject(record.fields);
    const taxonomy = cloneStructuredObject(record.taxonomy);
    const opportunity = cloneStructuredObject(record.opportunity);
    const character = cloneStructuredObject(record.character);
    const kpi = cloneStructuredObject(record.kpi);
    const extras = cloneStructuredObject(record.extras);
    const decisionStatus = deriveStructuredDecisionStatus(record, fields, extras);
    const compositeValue = Number.isFinite(record.compositeValue)
      ? record.compositeValue
      : (Number.isFinite(field10Meta.compositeValue) ? field10Meta.compositeValue : null);
    const entryScoreValue = Number.isFinite(record.entryScoreValue)
      ? record.entryScoreValue
      : (Number.isFinite(field10Meta.entryScoreValue) ? field10Meta.entryScoreValue : null);
    const sizingPercent = Number.isFinite(record.sizingPercent)
      ? record.sizingPercent
      : (Number.isFinite(field10Meta.sizingPercent) ? field10Meta.sizingPercent : null);
    return {
      recordFormat: normalizeText(record.recordFormat),
      record_format: normalizeText(record.recordFormat),
      decisionDate: normalizeText(record.decisionDate),
      decision_date: normalizeText(record.decisionDate),
      decisionStatus,
      decision_status: decisionStatus,
      decisionRole: normalizeText(record.decisionRole),
      decision_role: normalizeText(record.decisionRole),
      company: normalizeText(record.company),
      spolka: normalizeText(record.company),
      sourceMaterial: normalizeText(record.sourceMaterial),
      source_material: normalizeText(record.sourceMaterial),
      thesis: normalizeText(record.thesis),
      teza_inwestycyjna: normalizeText(record.thesis),
      asymmetry: normalizeText(record.asymmetry),
      bear: normalizeText(record.bear),
      bear_scenario_total: normalizeText(record.bear),
      base: normalizeText(record.base),
      base_scenario_total: normalizeText(record.base),
      bull: normalizeText(record.bull),
      bull_scenario_total: normalizeText(record.bull),
      voi: normalizeText(record.voi || field10Meta.voi),
      fals: normalizeText(record.fals || field10Meta.fals),
      primaryRisk: normalizeText(record.primaryRisk || field10Meta.primaryRisk),
      primary_risk: normalizeText(record.primaryRisk || field10Meta.primaryRisk),
      composite: normalizeText(record.composite || field10Meta.composite),
      compositeValue,
      composite_value: compositeValue,
      entryScore: normalizeText(record.entryScore || field10Meta.entryScore),
      entryScoreValue,
      entry_score: normalizeText(record.entryScore || field10Meta.entryScore),
      entry_score_value: entryScoreValue,
      sizing: normalizeText(record.sizing || field10Meta.sizing),
      sizingPercent,
      sizing_percent: sizingPercent,
      voi_falsy_kluczowe_ryzyka: normalizeText(record.voi || field10Meta.voi),
      sector: normalizeText(record.sector),
      sektor: normalizeText(record.sector),
      companyFamily: normalizeText(record.companyFamily || record.sector),
      company_family: normalizeText(record.companyFamily || record.sector),
      companyType: normalizeText(record.companyType),
      company_type: normalizeText(record.companyType),
      revenueModel: normalizeText(record.revenueModel),
      revenue_model: normalizeText(record.revenueModel),
      region: normalizeText(record.region),
      currency: normalizeText(record.currency),
      kpiScorecard: normalizeText(record.kpiScorecard),
      kpi_scorecard: normalizeText(record.kpiScorecard),
      valueChainPosition: normalizeText(record.valueChainPosition || opportunity.value_chain_position),
      value_chain_position: normalizeText(record.valueChainPosition || opportunity.value_chain_position),
      priceDislocationReason: normalizeText(record.priceDislocationReason || opportunity.price_dislocation_reason),
      price_dislocation_reason: normalizeText(record.priceDislocationReason || opportunity.price_dislocation_reason),
      reratingCatalystType: normalizeText(record.reratingCatalystType || opportunity.rerating_catalyst_type),
      rerating_catalyst_type: normalizeText(record.reratingCatalystType || opportunity.rerating_catalyst_type),
      timeHorizonType: normalizeText(record.timeHorizonType || opportunity.time_horizon_type),
      time_horizon_type: normalizeText(record.timeHorizonType || opportunity.time_horizon_type),
      entryConditionType: normalizeText(record.entryConditionType || opportunity.entry_condition_type),
      entry_condition_type: normalizeText(record.entryConditionType || opportunity.entry_condition_type),
      qualityState: normalizeText(record.qualityState || character.quality_state),
      quality_state: normalizeText(record.qualityState || character.quality_state),
      safetyState: normalizeText(record.safetyState || character.safety_state),
      safety_state: normalizeText(record.safetyState || character.safety_state),
      thesisStockRelationship: normalizeText(record.thesisStockRelationship || character.thesis_stock_relationship),
      thesis_stock_relationship: normalizeText(record.thesisStockRelationship || character.thesis_stock_relationship),
      proofClass: normalizeText(record.proofClass || character.proof_class),
      proof_class: normalizeText(record.proofClass || character.proof_class),
      confidenceInThesis: normalizeText(record.confidenceInThesis || character.confidence_in_thesis),
      confidence_in_thesis: normalizeText(record.confidenceInThesis || character.confidence_in_thesis),
      primaryKillRisk: normalizeText(record.primaryKillRisk || character.primary_kill_risk),
      primary_kill_risk: normalizeText(record.primaryKillRisk || character.primary_kill_risk),
      fields,
      taxonomy,
      opportunity,
      character,
      kpi,
      extras
    };
  }

  function normalizeWatchlistDecisionRecords(records) {
    return (Array.isArray(records) ? records : [])
      .map((record) => mapDecisionRecordForDispatch(record))
      .filter(Boolean);
  }

  function normalizeStructuredRole(value) {
    const role = normalizeText(value).toUpperCase();
    return DECISION_ROLES.has(role) ? role : '';
  }

  function normalizeStructuredFields(fields, decisionRole) {
    const source = normalizeStructuredSection(fields, STRUCTURED_FIELD_ALIASES);
    const normalized = { ...source };
    CANONICAL_FIELD_KEYS.forEach((key) => {
      if (!normalizeText(normalized[key])) {
        normalized[key] = '';
      } else {
        normalized[key] = normalizeText(normalized[key]);
      }
    });
    const normalizedRole = normalizeStructuredRole(
      decisionRole || normalized.decision_role || firstNonEmptyStructuredValue(source, STRUCTURED_FIELD_ALIASES.decision_role)
    );
    if (normalized.status_decyzji) {
      normalized.status_decyzji = normalizeStructuredDecisionStatus(normalized.status_decyzji);
    }
    if (normalizedRole) normalized.decision_role = normalizedRole;
    const synthesizedCompany = synthesizeStructuredCompany(source);
    if (synthesizedCompany) {
      normalized.spolka = synthesizedCompany;
    }
    if (normalizedRole) normalized.decision_role = normalizedRole;
    return normalized;
  }

  function normalizeStructuredTaxonomy(taxonomy) {
    const normalized = normalizeStructuredSection(taxonomy, TAXONOMY_KEY_ALIASES);
    Object.keys(normalized).forEach((key) => {
      normalized[key] = typeof normalized[key] === 'string'
        ? normalized[key].trim()
        : normalized[key];
    });
    return normalized;
  }

  function normalizeStructuredOpportunity(opportunity) {
    return cloneStructuredObject(opportunity);
  }

  function normalizeStructuredCharacter(character) {
    return cloneStructuredObject(character);
  }

  function normalizeStructuredKpi(kpi) {
    const source = cloneStructuredObject(kpi);
    return {
      schema_id: normalizeText(source.schema_id || source.schemaId),
      items: Array.isArray(source.items)
        ? source.items.map((item) => ({
          key: normalizeText(item?.key).toUpperCase(),
          label: normalizeText(item?.label),
          value: Number.isFinite(item?.value)
            ? item.value
            : (
              Number.isFinite(item?.score)
                ? item.score
                : (
                  item?.value == null
                    ? (item?.score == null ? null : Number.parseInt(item.score, 10))
                    : Number.parseInt(item.value, 10)
                )
            )
        })).filter((item) => item.key)
        : []
    };
  }

  function normalizeStructuredExtras(extras) {
    return cloneStructuredObject(extras);
  }

  function normalizeStructuredWatchlistRecord(record) {
    if (!record || typeof record !== 'object') return null;
    const rawFields = record.fields && typeof record.fields === 'object' ? record.fields : {};
    const decisionRole = normalizeStructuredRole(
      record.decision_role
      || record.decisionRole
      || rawFields.decision_role
      || rawFields.rola_na_watchliscie
      || rawFields.role
    );
    const normalizedFields = normalizeStructuredFields(rawFields, decisionRole);
    const hasFieldContent = Object.values(normalizedFields).some((value) => normalizeText(value));
    if (!hasFieldContent) return null;
    return {
      decision_role: decisionRole,
      fields: normalizedFields,
      taxonomy: normalizeStructuredTaxonomy(record.taxonomy),
      opportunity: normalizeStructuredOpportunity(record.opportunity),
      character: normalizeStructuredCharacter(record.character),
      kpi: normalizeStructuredKpi(record.kpi),
      extras: normalizeStructuredExtras(record.extras)
    };
  }

  function normalizeStructuredWatchlistRecords(records) {
    return (Array.isArray(records) ? records : [])
      .map((record) => normalizeStructuredWatchlistRecord(record))
      .filter(Boolean);
  }

  return {
    mapDecisionRecordForDispatch,
    normalizeStructuredWatchlistRecord,
    normalizeStructuredWatchlistRecords,
    normalizeWatchlistDecisionRecords
  };
});
