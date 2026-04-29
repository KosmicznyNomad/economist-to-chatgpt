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
      kpiScorecard: 'FQ:8,TE:7,CM:9,VS:6,TQ:7,PP:8,CP:5,CD:7,NO:8,MR:6',
      field10Meta: {
        fals: 'churn > 5%',
        primaryRisk: 'pricing reset',
        composite: '4.2/5.0',
        compositeValue: 4.2,
        entryScore: '8.1/10',
        entryScoreValue: 8.1,
        sizing: '3%',
        sizingPercent: 3
      },
      opportunity: {
        value_chain_position: 'Platforma',
        entry_condition_type: 'Already met'
      },
      character: {
        quality_state: 'STRONG',
        proof_class: 'FUNDED',
        primary_kill_risk: 'pricing reset'
      },
      extras: {
        note: 'legacy-compatible'
      }
    },
    null
  ]);

  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].recordFormat, 'current_17_role');
  assert.strictEqual(records[0].decisionDate, '2026-03-20');
  assert.strictEqual(records[0].decisionStatus, 'WATCH');
  assert.strictEqual(records[0].decisionRole, 'PRIMARY');
  assert.strictEqual(records[0].decision_role, 'PRIMARY');
  assert.strictEqual(records[0].company, 'Alpha Corp (ALFA)');
  assert.strictEqual(records[0].sourceMaterial, 'Source');
  assert.strictEqual(records[0].thesis, 'Thesis');
  assert.strictEqual(records[0].bear, 'Bear_TOTAL: 10');
  assert.strictEqual(records[0].base, 'Base_TOTAL: 20');
  assert.strictEqual(records[0].bull, 'Bull_TOTAL: 30');
  assert.strictEqual(records[0].voi, 'VOI: ok');
  assert.strictEqual(records[0].fals, 'churn > 5%');
  assert.strictEqual(records[0].primaryRisk, 'pricing reset');
  assert.strictEqual(records[0].composite, '4.2/5.0');
  assert.strictEqual(records[0].entryScore, '8.1/10');
  assert.strictEqual(records[0].sizing, '3%');
  assert.strictEqual(records[0].sector, 'Technology');
  assert.strictEqual(records[0].companyFamily, 'Technology');
  assert.strictEqual(records[0].companyType, 'Software');
  assert.strictEqual(records[0].revenueModel, 'Subscription');
  assert.strictEqual(records[0].region, 'USA');
  assert.strictEqual(records[0].currency, 'USD');
  assert.strictEqual(records[0].kpiScorecard, 'FQ:8,TE:7,CM:9,VS:6,TQ:7,PP:8,CP:5,CD:7,NO:8,MR:6');
  assert.strictEqual(records[0].valueChainPosition, 'Platforma');
  assert.strictEqual(records[0].value_chain_position, 'Platforma');
  assert.strictEqual(records[0].entryConditionType, 'Already met');
  assert.strictEqual(records[0].entry_condition_type, 'Already met');
  assert.strictEqual(records[0].qualityState, 'STRONG');
  assert.strictEqual(records[0].quality_state, 'STRONG');
  assert.strictEqual(records[0].proofClass, 'FUNDED');
  assert.strictEqual(records[0].proof_class, 'FUNDED');
  assert.strictEqual(records[0].primaryKillRisk, 'pricing reset');
  assert.strictEqual(records[0].recordVersion, undefined);
}

function testDispatchShapeNormalizesStructuredRecords() {
  const records = WatchlistDispatchShapeUtils.normalizeStructuredWatchlistRecords([
    {
      decision_role: 'primary',
      fields: {
        data_decyzji: '2026-03-29',
        spolka: 'Leidos Holdings Inc. (LDOS:NYSE)',
        material_zrodlowy_podcast: 'a16z podcast',
        teza_inwestycyjna: 'Primary thesis',
        bear_scenario_total: 'Bear_TOTAL: 90',
        base_scenario_total: 'Base_TOTAL: 120',
        bull_scenario_total: 'Bull_TOTAL: 160',
        voi_falsy_kluczowe_ryzyka: 'VOI: backlog'
      },
      taxonomy: {
        sector: 'Defense',
        worldview_bucket: 'Software steruje praca, pieniedzmi i ryzykiem',
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
  assert.strictEqual(records[0].fields.status_decyzji, undefined);
  assert.strictEqual(records[0].taxonomy.sector, 'Defense');
  assert.strictEqual(records[0].taxonomy.worldview_bucket, 'Software steruje praca, pieniedzmi i ryzykiem');
  assert.strictEqual(records[0].taxonomy.company_type, 'Oprogramowanie obronne');
  assert.strictEqual(records[0].opportunity.value_chain_position, 'Platforma');
  assert.strictEqual(records[0].character.primary_kill_risk, 'brak sily cenowej');
  assert.strictEqual(records[0].kpi.items[0].key, 'FQ');
  assert.strictEqual(records[0].kpi.items[0].value, 8);
  assert.deepStrictEqual(records[0].extras, { note: 'x' });
}

function testDispatchShapeBackfillsAliasStructuredRecords() {
  const records = WatchlistDispatchShapeUtils.normalizeStructuredWatchlistRecords([
    {
      decision_role: 'secondary',
      fields: {
        nazwa: 'AT&S',
        ticker: 'ATS.VI',
        gielda: 'WBAG',
        decyzja: 'WATCH',
        rola_na_watchliscie: 'SECONDARY',
        material_zrodlowy_podcast: 'SemiAnalysis Rubin Ultra',
        teza_inwestycyjna: 'Secondary thesis',
        bear_scenario_total: 'Bear_TOTAL: 57.68',
        base_scenario_total: 'Base_TOTAL: 74.06',
        bull_scenario_total: 'Bull_TOTAL: 94.75',
        voi_falsy_kluczowe_ryzyka: 'VOI: Kulim'
      },
      taxonomy: {
        sector: 'Przemysl',
        companyFamily: 'Infrastruktura polprzewodnikowa i substraty',
        companyType: 'Producent substratow IC',
        revenueModel: 'Kontrakty B2B',
        region: 'Austria',
        currency: 'EUR'
      },
      opportunity: {
        value_chain_position: 'Dostawca substratow',
        invoice_issuer: 'AT&S Austria Technologie & Systemtechnik AG',
        entry_condition_type: 'DURATION',
        catalyst_window: 'FY2026 H1/H2'
      },
      character: {
        quality_state: 'MIXED',
        market_expectation_state: 'Rynek dyskontuje duration',
        primary_kill_risk: 'Kulim ramp'
      },
      kpi: {
        schema_id: 'core10',
        items: [
          { key: 'fq', score: '5' }
        ]
      },
      extras: {
        note: 'alias-compatible'
      }
    }
  ]);

  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].decision_role, 'SECONDARY');
  assert.strictEqual(records[0].fields.decision_role, 'SECONDARY');
  assert.strictEqual(records[0].fields.decyzja, 'WATCH');
  assert.strictEqual(records[0].fields.status_decyzji, undefined);
  assert.strictEqual(records[0].fields.spolka, 'AT&S (ATS:VIE)');
  assert.strictEqual(records[0].taxonomy.company_family, 'Infrastruktura polprzewodnikowa i substraty');
  assert.strictEqual(records[0].taxonomy.company_type, 'Producent substratow IC');
  assert.strictEqual(records[0].taxonomy.revenue_model, 'Kontrakty B2B');
  assert.strictEqual(records[0].opportunity.invoice_issuer, 'AT&S Austria Technologie & Systemtechnik AG');
  assert.strictEqual(records[0].opportunity.catalyst_window, 'FY2026 H1/H2');
  assert.strictEqual(records[0].character.market_expectation_state, 'Rynek dyskontuje duration');
  assert.strictEqual(records[0].kpi.items[0].key, 'FQ');
  assert.strictEqual(records[0].kpi.items[0].value, 5);
  assert.deepStrictEqual(records[0].extras, { note: 'alias-compatible' });
}

function main() {
  testDispatchShapeNormalizesDecisionRecords();
  testDispatchShapeNormalizesStructuredRecords();
  testDispatchShapeBackfillsAliasStructuredRecords();
  console.log('test-watchlist-dispatch-shape.js: ok');
}

main();
