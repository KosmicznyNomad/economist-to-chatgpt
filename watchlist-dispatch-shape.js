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
    'status_decyzji',
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
  const OPPORTUNITY_KEYS = [
    'value_chain_position',
    'price_dislocation_reason',
    'rerating_catalyst_type',
    'time_horizon_type',
    'entry_condition_type'
  ];
  const CHARACTER_KEYS = [
    'quality_state',
    'safety_state',
    'thesis_stock_relationship',
    'proof_class',
    'confidence_in_thesis',
    'primary_kill_risk'
  ];

  function normalizeText(value, fallback = '') {
    const text = typeof value === 'string' ? value.trim() : '';
    return text || fallback;
  }

  function mapDecisionRecordForDispatch(record) {
    if (!record || typeof record !== 'object') return null;
    return {
      recordFormat: normalizeText(record.recordFormat),
      decisionDate: normalizeText(record.decisionDate),
      decisionStatus: normalizeText(record.decisionStatus),
      decisionRole: normalizeText(record.decisionRole),
      company: normalizeText(record.company),
      sourceMaterial: normalizeText(record.sourceMaterial),
      thesis: normalizeText(record.thesis),
      asymmetry: normalizeText(record.asymmetry),
      bear: normalizeText(record.bear),
      base: normalizeText(record.base),
      bull: normalizeText(record.bull),
      voi: normalizeText(record.voi),
      sector: normalizeText(record.sector),
      companyFamily: normalizeText(record.companyFamily || record.sector),
      companyType: normalizeText(record.companyType),
      revenueModel: normalizeText(record.revenueModel),
      region: normalizeText(record.region),
      currency: normalizeText(record.currency),
      kpiScorecard: normalizeText(record.kpiScorecard)
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
    const source = fields && typeof fields === 'object' ? fields : {};
    const normalized = {};
    CANONICAL_FIELD_KEYS.forEach((key) => {
      normalized[key] = normalizeText(source[key]);
    });
    if (decisionRole) normalized.decision_role = decisionRole;
    return normalized;
  }

  function normalizeStructuredTaxonomy(taxonomy) {
    const source = taxonomy && typeof taxonomy === 'object' ? taxonomy : {};
    return {
      sector: normalizeText(source.sector),
      company_family: normalizeText(source.company_family),
      company_type: normalizeText(source.company_type),
      revenue_model: normalizeText(source.revenue_model),
      region: normalizeText(source.region),
      currency: normalizeText(source.currency)
    };
  }

  function normalizeStructuredNamedSection(section, keys) {
    const source = section && typeof section === 'object' ? section : {};
    const normalized = {};
    keys.forEach((key) => {
      normalized[key] = normalizeText(source[key]);
    });
    return normalized;
  }

  function normalizeStructuredOpportunity(opportunity) {
    return normalizeStructuredNamedSection(opportunity, OPPORTUNITY_KEYS);
  }

  function normalizeStructuredCharacter(character) {
    return normalizeStructuredNamedSection(character, CHARACTER_KEYS);
  }

  function normalizeStructuredKpi(kpi) {
    const source = kpi && typeof kpi === 'object' ? kpi : {};
    return {
      schema_id: normalizeText(source.schema_id || source.schemaId),
      items: Array.isArray(source.items)
        ? source.items.map((item) => ({
          key: normalizeText(item?.key).toUpperCase(),
          label: normalizeText(item?.label),
          value: Number.isFinite(item?.value)
            ? item.value
            : (item?.value == null ? null : Number.parseInt(item.value, 10))
        })).filter((item) => item.key)
        : []
    };
  }

  function normalizeStructuredExtras(extras) {
    return extras && typeof extras === 'object' && !Array.isArray(extras)
      ? JSON.parse(JSON.stringify(extras))
      : {};
  }

  function normalizeStructuredWatchlistRecord(record) {
    if (!record || typeof record !== 'object') return null;
    const rawFields = record.fields && typeof record.fields === 'object' ? record.fields : {};
    const decisionRole = normalizeStructuredRole(record.decision_role || rawFields.decision_role);
    return {
      decision_role: decisionRole,
      fields: normalizeStructuredFields(rawFields, decisionRole),
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
