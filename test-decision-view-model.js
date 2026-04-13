const assert = require('assert');

const DecisionContractUtils = require('./decision-contract.js');
const DecisionViewModelUtils = require('./decision-view-model.js');

function makeCurrent16Line(role, company, options = {}) {
  const decisionStatus = options.decisionStatus || 'WATCH';
  const composite = options.composite || '4.2/5.0';
  const entryScore = options.entryScore || '8.1/10';
  const sizing = options.sizing || '3%';
  const field10 = options.field10 || `VOI: backlog > 10%, Fals: churn > 5%, Primary risk: pricing reset, Composite: ${composite}, EntryScore: ${entryScore}, Sizing: ${sizing}`;
  return [
    '2026-03-20',
    decisionStatus,
    role,
    company,
    'THESIS_SOURCE example',
    `${company} thesis text`,
    'Bear_TOTAL: 10',
    'Base_TOTAL: 20',
    'Bull_TOTAL: 30',
    field10,
    'Technology',
    'Technology',
    'Software',
    'Subscription',
    'USA',
    'USD',
    options.kpiScorecard || 'FQ:8,TE:7,CM:9,VS:6,TQ:7,PP:8,CP:5,CD:7,NO:8,MR:6'
  ].join('; ');
}

function testValidatedStage12StateCurrentAndLegacy() {
  const currentText = [
    makeCurrent16Line('PRIMARY', 'Alpha Corp (ALFA)'),
    makeCurrent16Line('SECONDARY', 'Beta Corp (BETA)', { composite: '3.5/5.0', sizing: '2%' })
  ].join('\n');
  const legacyText = '2026-03-20;WATCH;Gamma Corp (GAMM);Source;Thesis;Bear_TOTAL: 1;Base_TOTAL: 2;Bull_TOTAL: 3;VOI: trigger;Technology;USA;USD';

  const currentState = DecisionViewModelUtils.buildValidatedStage12State({
    responseId: 'resp-current',
    timestamp: 1_710_000_000_000,
    source: 'Current source',
    text: currentText
  }, DecisionContractUtils);
  const legacyState = DecisionViewModelUtils.buildValidatedStage12State({
    responseId: 'resp-legacy',
    timestamp: 1_710_000_100_000,
    source: 'Legacy source',
    text: legacyText
  }, DecisionContractUtils);

  assert.strictEqual(currentState.status, 'current');
  assert.strictEqual(currentState.recordCount, 2);
  assert.strictEqual(currentState.primaryRecord.company, 'Alpha Corp (ALFA)');
  assert.strictEqual(currentState.secondaryRecord.company, 'Beta Corp (BETA)');

  assert.strictEqual(legacyState.status, 'legacy');
  assert.strictEqual(legacyState.records.length, 1);
  assert.strictEqual(legacyState.records[0].company, 'Gamma Corp (GAMM)');
}

function testMarketRowDedupPrefersHigherContractScoreThenSignal() {
  const primaryCurrent = {
    key: 'alpha|alfa|primary',
    contractStatus: 'current',
    compositeValue: 3.8,
    sizingPercent: 2,
    decisionTs: 100,
    responseTs: 100
  };
  const primaryLegacy = {
    key: 'alpha|alfa|primary',
    contractStatus: 'legacy',
    compositeValue: 4.9,
    sizingPercent: 5,
    decisionTs: 200,
    responseTs: 200
  };
  const strongerCurrent = {
    key: 'alpha|alfa|primary',
    contractStatus: 'current',
    compositeValue: 4.4,
    sizingPercent: 3,
    decisionTs: 90,
    responseTs: 90
  };

  assert.strictEqual(
    DecisionViewModelUtils.pickPreferredMarketRow(primaryCurrent, primaryLegacy, DecisionContractUtils),
    primaryCurrent
  );
  assert.strictEqual(
    DecisionViewModelUtils.pickPreferredMarketRow(primaryCurrent, strongerCurrent, DecisionContractUtils),
    strongerCurrent
  );
}

function testValidatedStage12StateStructuredV2() {
  const structuredText = JSON.stringify({
    schema: 'economist.response.v2',
    records: [
      {
        decision_role: 'PRIMARY',
        fields: {
          data_decyzji: '2026-04-12',
          status_decyzji: 'WATCH',
          spolka: 'Camtek (CAMT:NASDAQ)',
          material_zrodlowy_podcast: 'SemiAnalysis Rubin Ultra',
          teza_inwestycyjna: 'Camtek thesis',
          bear_scenario_total: 'Bear_TOTAL: 34.40',
          base_scenario_total: 'Base_TOTAL: 44.64',
          bull_scenario_total: 'Bull_TOTAL: 57.04',
          voi_falsy_kluczowe_ryzyka: 'VOI: orders, Fals: delay, Primary risk: memory cycle, Composite: 4.3/5.0, EntryScore: 8.2/10, Sizing: 3%'
        },
        taxonomy: {
          sector: 'Technologia',
          company_family: 'Polprzewodniki',
          company_type: 'Metrologia',
          revenue_model: 'Sprzet i software',
          region: 'USA',
          currency: 'USD'
        },
        opportunity: {
          value_chain_position: 'Tool-of-record'
        },
        character: {
          quality_state: 'ELITE',
          proof_class: 'FUNDED',
          primary_kill_risk: 'memory cycle'
        },
        kpi: {
          schema_id: 'core10',
          items: [
            { key: 'FQ', value: 9 },
            { key: 'TE', value: 8 },
            { key: 'CM', value: 8 },
            { key: 'VS', value: 7 },
            { key: 'TQ', value: 8 },
            { key: 'PP', value: 7 },
            { key: 'CP', value: 6 },
            { key: 'CD', value: 8 },
            { key: 'NO', value: 8 },
            { key: 'MR', value: 7 }
          ]
        },
        extras: {
          record_version: 'watchlist.v3_decision_rich'
        }
      }
    ]
  });

  const state = DecisionViewModelUtils.buildValidatedStage12State({
    responseId: 'resp-structured-v2',
    timestamp: 1_712_874_400_000,
    source: 'Structured source',
    text: structuredText
  }, DecisionContractUtils);

  assert.strictEqual(state.status, 'shortfall');
  assert.strictEqual(state.recordCount, 1);
  assert.strictEqual(state.primaryRecord.company, 'Camtek (CAMT:NASDAQ)');
  assert.strictEqual(state.primaryRecord.composite, '4.3/5.0');
  assert.strictEqual(state.primaryRecord.entryScore, '8.2/10');
  assert.strictEqual(state.primaryRecord.sizing, '3%');
  assert.strictEqual(state.primaryRecord.sector, 'Technologia');
}

function main() {
  testValidatedStage12StateCurrentAndLegacy();
  testMarketRowDedupPrefersHigherContractScoreThenSignal();
  testValidatedStage12StateStructuredV2();
  console.log('test-decision-view-model.js: ok');
}

main();
