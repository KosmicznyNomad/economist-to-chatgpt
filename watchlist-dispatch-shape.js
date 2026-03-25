(function attachWatchlistDispatchShapeUtils(root, factory) {
  const api = factory();
  root.WatchlistDispatchShapeUtils = api;
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createWatchlistDispatchShapeUtils() {
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

  return {
    mapDecisionRecordForDispatch,
    normalizeWatchlistDecisionRecords
  };
});
