const assert = require('assert');

const WatchlistDispatchShapeUtils = require('./watchlist-dispatch-shape.js');

function testDispatchShapeNormalizesDecisionRecords() {
  const records = WatchlistDispatchShapeUtils.normalizeWatchlistDecisionRecords([
    {
      recordFormat: 'current_17_role',
      decisionDate: '2026-03-20',
      decisionStatus: 'WATCH',
      decisionRole: 'PRIMARY',
      company: 'Alpha Corp (ALFA)',
      sourceMaterial: 'Source',
      thesis: 'Thesis',
      asymmetry: '',
      bear: 'Bear_TOTAL: 10',
      base: 'Base_TOTAL: 20',
      bull: 'Bull_TOTAL: 30',
      voi: 'VOI: ok',
      sector: 'Technology',
      companyFamily: '',
      companyType: 'Software',
      revenueModel: 'Subscription',
      region: 'USA',
      currency: 'USD',
      kpiScorecard: 'FQ:8,TE:7,CM:9,VS:6,TQ:7,PP:8,CP:5,CD:7,NO:8,MR:6'
    },
    null
  ]);

  assert.strictEqual(records.length, 1);
  assert.deepStrictEqual(records[0], {
    recordFormat: 'current_17_role',
    decisionDate: '2026-03-20',
    decisionStatus: 'WATCH',
    decisionRole: 'PRIMARY',
    company: 'Alpha Corp (ALFA)',
    sourceMaterial: 'Source',
    thesis: 'Thesis',
    asymmetry: '',
    bear: 'Bear_TOTAL: 10',
    base: 'Base_TOTAL: 20',
    bull: 'Bull_TOTAL: 30',
    voi: 'VOI: ok',
    sector: 'Technology',
    companyFamily: 'Technology',
    companyType: 'Software',
    revenueModel: 'Subscription',
    region: 'USA',
    currency: 'USD',
    kpiScorecard: 'FQ:8,TE:7,CM:9,VS:6,TQ:7,PP:8,CP:5,CD:7,NO:8,MR:6'
  });
}

function testDispatchShapeNormalizesStructuredRecords() {
  const records = WatchlistDispatchShapeUtils.normalizeStructuredWatchlistRecords([
    {
      decision_role: 'primary',
      fields: {
        data_decyzji: '2026-03-29',
        status_decyzji: 'WATCH',
        spolka: 'Leidos Holdings Inc. (LDOS:NYSE)',
        material_zrodlowy_podcast: 'a16z podcast',
        teza_inwestycyjna: 'Primary thesis',
        bear_scenario_total: 'Bear_TOTAL: 90',
        base_scenario_total: 'Base_TOTAL: 120',
        bull_scenario_total: 'Bull_TOTAL: 160',
        voi_falsy_kluczowe_ryzyka: 'VOI: backlog'
      },
      taxonomy: {
        sector: 'Software steruje praca, pieniedzmi i ryzykiem',
        company_family: 'Technologia i oprogramowanie',
        company_type: 'Oprogramowanie obronne',
        revenue_model: 'Integracja i wdrozenia',
        region: 'USA',
        currency: 'USD'
      },
      opportunity: {
        value_chain_position: 'Platforma',
        price_dislocation_reason: 'Misklasyfikacja'
      },
      character: {
        quality_state: 'STRONG',
        primary_kill_risk: 'brak sily cenowej'
      },
      kpi: {
        schema_id: 'core10',
        items: [
          { key: 'fq', label: 'Financial Quality', value: '8' }
        ]
      },
      extras: {
        note: 'x'
      }
    },
    null
  ]);

  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].decision_role, 'PRIMARY');
  assert.strictEqual(records[0].fields.decision_role, 'PRIMARY');
  assert.strictEqual(records[0].fields.spolka, 'Leidos Holdings Inc. (LDOS:NYSE)');
  assert.strictEqual(records[0].taxonomy.company_type, 'Oprogramowanie obronne');
  assert.strictEqual(records[0].opportunity.value_chain_position, 'Platforma');
  assert.strictEqual(records[0].character.primary_kill_risk, 'brak sily cenowej');
  assert.strictEqual(records[0].kpi.items[0].key, 'FQ');
  assert.strictEqual(records[0].kpi.items[0].value, 8);
  assert.deepStrictEqual(records[0].extras, { note: 'x' });
}

function main() {
  testDispatchShapeNormalizesDecisionRecords();
  testDispatchShapeNormalizesStructuredRecords();
  console.log('test-watchlist-dispatch-shape.js: ok');
}

main();
