const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DecisionContractUtils = require('./decision-contract.js');
const WatchlistDispatchShapeUtils = require('./watchlist-dispatch-shape.js');

const backgroundPath = path.join(__dirname, 'background.js');
const backgroundSource = fs.readFileSync(backgroundPath, 'utf8');

function extractFunctionSource(source, functionName) {
  const pattern = new RegExp(`function\\s+${functionName}\\s*\\(`);
  const match = pattern.exec(source);
  if (!match) {
    throw new Error(`Function not found: ${functionName}`);
  }
  const startIndex = match.index;
  const braceStart = source.indexOf('{', match.index);
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inSingle) {
      if (!escaped && char === '\\') {
        escaped = true;
        continue;
      }
      if (!escaped && char === '\'') inSingle = false;
      escaped = false;
      continue;
    }
    if (inDouble) {
      if (!escaped && char === '\\') {
        escaped = true;
        continue;
      }
      if (!escaped && char === '"') inDouble = false;
      escaped = false;
      continue;
    }
    if (inTemplate) {
      if (!escaped && char === '\\') {
        escaped = true;
        continue;
      }
      if (!escaped && char === '`') inTemplate = false;
      escaped = false;
      continue;
    }
    if (char === '/' && next === '/') {
      inLineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      index += 1;
      continue;
    }
    if (char === '\'') {
      inSingle = true;
      continue;
    }
    if (char === '"') {
      inDouble = true;
      continue;
    }
    if (char === '`') {
      inTemplate = true;
      continue;
    }

    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startIndex, index + 1);
      }
    }
  }

  throw new Error(`Function end not found: ${functionName}`);
}

function makeCurrent16Line(role, company) {
  return [
    '2026-03-20',
    'WATCH',
    role,
    company,
    'THESIS_SOURCE example',
    `${company} thesis text`,
    'Bear_TOTAL: 10',
    'Base_TOTAL: 20',
    'Bull_TOTAL: 30',
    'VOI: backlog > 10%, Fals: churn > 5%, Primary risk: pricing reset, Composite: 4.2/5.0, EntryScore: 8.1/10, Sizing: 3%',
    'Technology',
    'Technology',
    'Software',
    'Subscription',
    'USA',
    'USD',
    'FQ:8,TE:7,CM:9,VS:6,TQ:7,PP:8,CP:5,CD:7,NO:8,MR:6'
  ].join('; ');
}

function makeStructuredV2Record(overrides = {}) {
  const base = {
    decision_role: 'PRIMARY',
    fields: {
      data_decyzji: '2026-04-12',
      spolka: 'Camtek (CAMT:NASDAQ)',
      material_zrodlowy_podcast: 'SemiAnalysis Rubin Ultra',
      teza_inwestycyjna: 'Camtek thesis',
      bear_scenario_total: 'Bear_TOTAL: 34.40',
      base_scenario_total: 'Base_TOTAL: 44.64',
      bull_scenario_total: 'Bull_TOTAL: 57.04',
      voi_falsy_kluczowe_ryzyka: 'VOI: orders'
    },
    taxonomy: {
      sector: 'Semiconductors',
      worldview_bucket: 'Fizyczne waskie gardla dyktuja wartosc',
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
      quality_state: 'ELITE'
    },
    kpi: {
      schema_id: 'core10',
      items: [
        { key: 'FQ', value: 9 }
      ]
    },
    extras: {
      identity: {
        decision_category: 'WATCH'
      }
    }
  };
  return {
    ...base,
    ...overrides,
    fields: {
      ...base.fields,
      ...(overrides.fields || {})
    },
    taxonomy: {
      ...base.taxonomy,
      ...(overrides.taxonomy || {})
    },
    opportunity: {
      ...base.opportunity,
      ...(overrides.opportunity || {})
    },
    character: {
      ...base.character,
      ...(overrides.character || {})
    },
    kpi: {
      ...base.kpi,
      ...(overrides.kpi || {}),
      items: Array.isArray(overrides?.kpi?.items) ? overrides.kpi.items : base.kpi.items
    },
    extras: {
      ...base.extras,
      ...(overrides.extras || {})
    }
  };
}

const context = {
  console,
  DecisionContractUtils,
  WatchlistDispatchShapeUtils,
  RESPONSE_CONVERSATION_LOG_MAX_ITEMS: 40,
  extractDecisionRecordsFromText: DecisionContractUtils.extractDecisionRecordsFromText,
  normalizeResponseSourceMeta(rawPayload, source) {
    return {
      sourceTitle: typeof rawPayload?.sourceTitle === 'string' ? rawPayload.sourceTitle : '',
      sourceName: typeof rawPayload?.sourceName === 'string' ? rawPayload.sourceName : '',
      sourceUrl: typeof rawPayload?.sourceUrl === 'string' ? rawPayload.sourceUrl : (typeof source === 'string' ? source : '')
    };
  },
  normalizeChatConversationUrl(value) {
    return typeof value === 'string' ? value.trim() : '';
  },
  normalizeConversationLogSnapshot(value) {
    return Array.isArray(value) ? value : [];
  },
  generateResponseId(runId = '') {
    return `generated-${runId || 'none'}`;
  },
  trimProblemLogText(value, max = 9999) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.slice(0, max);
  }
};

vm.createContext(context);
[
  'normalizeComposerThinkingEffort',
  'normalizeChatGptMonitoringLabel',
  'normalizeChatGptModeKind',
  'normalizeChatGptPlanHint',
  'applyChatGptComputationStatePatch',
  'normalizeStructuredWatchlistValue',
  'normalizeStructuredWatchlistObject',
  'serializeStructuredWatchlistKpiScorecard',
  'sanitizeStructuredWatchlistRecord',
  'extractStructuredWatchlistJsonCandidates',
  'extractStructuredWatchlistResponseFromText',
  'mapDispatchDecisionRecord',
  'normalizeWatchlistDispatchPayload',
  'normalizeOutboundWatchlistDispatchPayload'
]
  .forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context);
  });

function testCurrentPairPayload() {
  const text = [
    makeCurrent16Line('PRIMARY', 'Alpha Corp'),
    makeCurrent16Line('SECONDARY', 'Beta Corp')
  ].join('\n');
  const payload = context.normalizeWatchlistDispatchPayload({
    text,
    source: 'Alpha source',
    analysisType: 'company',
    responseId: 'resp-pair',
    runId: 'run-pair',
    timestamp: 1_710_000_000_000
  });

  assert.strictEqual(payload.decisionRecord.decisionRole, 'PRIMARY');
  assert.strictEqual(payload.decisionRecordCount, 2);
  assert.strictEqual(payload.decisionRecords.length, 2);
  assert.strictEqual(payload.text, text);

  const outbound = context.normalizeOutboundWatchlistDispatchPayload(payload);
  assert.strictEqual(outbound.decisionRecordCount, 2);
  assert.strictEqual(outbound.decisionRecords.length, 2);
}

function testShortfallPayload() {
  const text = [
    makeCurrent16Line('PRIMARY', 'Solo Corp'),
    DecisionContractUtils.SHORTFALL_MARKER
  ].join('\n');
  const payload = context.normalizeWatchlistDispatchPayload({
    text,
    source: 'Solo source',
    analysisType: 'company',
    responseId: 'resp-shortfall',
    runId: 'run-shortfall',
    timestamp: 1_710_000_000_000
  });

  assert.strictEqual(payload.decisionRecordCount, 1);
  assert.strictEqual(payload.decisionRecords.length, 1);
  assert.ok(payload.text.endsWith(DecisionContractUtils.SHORTFALL_MARKER));

  const outbound = context.normalizeOutboundWatchlistDispatchPayload(payload);
  assert.strictEqual(outbound.decisionRecordCount, 1);
  assert.strictEqual(outbound.decisionRecords.length, 1);
  assert.ok(outbound.text.endsWith(DecisionContractUtils.SHORTFALL_MARKER));
}

function testFallbackMapperPreservesKpiScorecard() {
  const originalShapeUtils = context.WatchlistDispatchShapeUtils;
  context.WatchlistDispatchShapeUtils = {};
  const mapped = context.mapDispatchDecisionRecord({
    recordFormat: 'current_17_role',
    decisionDate: '2026-03-20',
    decisionStatus: 'WATCH',
    decisionRole: 'PRIMARY',
    company: 'Alpha Corp',
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
  context.WatchlistDispatchShapeUtils = originalShapeUtils;

  assert.strictEqual(mapped.kpiScorecard, 'FQ:8,TE:7,CM:9,VS:6,TQ:7,PP:8,CP:5,CD:7,NO:8,MR:6');
}

function testStructuredV2PayloadPreservesRecords() {
  const text = JSON.stringify({
    records: [
      {
        decision_role: 'PRIMARY',
        fields: {
          data_decyzji: '2026-03-20',
          spolka: 'Alpha Corp (ALP:NASDAQ)',
          zrodlo_tezy: 'Alpha source',
          material_zrodlowy_podcast: 'Alpha source',
          teza_inwestycyjna: 'Alpha thesis',
          bear_scenario_total: 'Bear_TOTAL: 10',
          base_scenario_total: 'Base_TOTAL: 20',
          bull_scenario_total: 'Bull_TOTAL: 30',
          voi_falsy_kluczowe_ryzyka: 'VOI: alpha, Fals: beta, Primary risk: gamma, Composite: 4.2/5.0, EntryScore: 8.1/10, Sizing: 3%',
          sektor: 'Software',
          rodzina_spolki: 'Technologia i oprogramowanie',
          typ_spolki: 'Software',
          model_przychodu: 'Subscription',
          region: 'USA',
          waluta: 'USD'
        },
        taxonomy: {
          sector: 'Software',
          worldview_bucket: 'Software steruje praca, pieniedzmi i ryzykiem',
          company_family: 'Technologia i oprogramowanie',
          company_type: 'Software',
          revenue_model: 'Subscription',
          region: 'USA',
          currency: 'USD'
        },
        opportunity: {
          value_chain_position: 'Platforma',
          entry_condition_type: 'Already met'
        },
        character: {
          quality_state: 'STRONG',
          primary_kill_risk: 'gamma'
        },
        kpi: {
          schema_id: 'core10',
          items: [
            { key: 'FQ', value: 8 },
            { key: 'TE', value: 7 },
            { key: 'CM', value: 9 },
            { key: 'VS', value: 6 },
            { key: 'TQ', value: 7 },
            { key: 'PP', value: 8 },
            { key: 'CP', value: 5 },
            { key: 'CD', value: 7 },
            { key: 'NO', value: 8 },
            { key: 'MR', value: 6 }
          ]
        },
        extras: {
          identity: {
            decision_category: 'WATCH'
          }
        }
      },
      {
        decision_role: 'SECONDARY',
        fields: {
          data_decyzji: '2026-03-20',
          spolka: 'Beta Corp (BET:NASDAQ)',
          zrodlo_tezy: 'Beta source',
          material_zrodlowy_podcast: 'Beta source',
          teza_inwestycyjna: 'Beta thesis',
          bear_scenario_total: 'Bear_TOTAL: 11',
          base_scenario_total: 'Base_TOTAL: 21',
          bull_scenario_total: 'Bull_TOTAL: 31',
          voi_falsy_kluczowe_ryzyka: 'VOI: alpha, Fals: beta, Primary risk: gamma, Composite: 4.0/5.0, EntryScore: 7.9/10, Sizing: 2%',
          sektor: 'Software',
          rodzina_spolki: 'Technologia i oprogramowanie',
          typ_spolki: 'Software',
          model_przychodu: 'Subscription',
          region: 'USA',
          waluta: 'USD'
        },
        taxonomy: {
          sector: 'Software',
          worldview_bucket: 'Software steruje praca, pieniedzmi i ryzykiem',
          company_family: 'Technologia i oprogramowanie',
          company_type: 'Software',
          revenue_model: 'Subscription',
          region: 'USA',
          currency: 'USD'
        },
        opportunity: {
          value_chain_position: 'Integrator',
          entry_condition_type: 'Proof only'
        },
        character: {
          quality_state: 'MIXED',
          primary_kill_risk: 'procurement delay'
        },
        kpi: {
          schema_id: 'core10',
          items: [
            { key: 'FQ', value: 7 },
            { key: 'TE', value: 7 },
            { key: 'CM', value: 8 },
            { key: 'VS', value: 6 },
            { key: 'TQ', value: 6 },
            { key: 'PP', value: 7 },
            { key: 'CP', value: 5 },
            { key: 'CD', value: 7 },
            { key: 'NO', value: 6 },
            { key: 'MR', value: 6 }
          ]
        },
        extras: {
          shortfall_reason: '',
          identity: {
            decision_category: 'WATCH'
          }
        }
      }
    ]
  });

  const payload = context.normalizeWatchlistDispatchPayload({
    text,
    source: 'Prompt chain',
    analysisType: 'company',
    responseId: 'resp-v2',
    runId: 'run-v2',
    timestamp: 1_710_000_000_000
  });

  assert.strictEqual(payload.schema, 'economist.response.v2');
  assert.strictEqual(payload.decisionRecordCount, 2);
  assert.strictEqual(payload.records.length, 2);
  assert.strictEqual(payload.decisionRecords.length, 2);
  assert.strictEqual(payload.records[0].decision_role, 'PRIMARY');
  assert.strictEqual(payload.records[0].fields.spolka, 'Alpha Corp (ALP:NASDAQ)');
  assert.strictEqual(payload.records[0].fields.status_decyzji, undefined);
  assert.strictEqual(payload.records[0].taxonomy.sector, 'Software');
  assert.strictEqual(payload.records[0].taxonomy.worldview_bucket, 'Software steruje praca, pieniedzmi i ryzykiem');
  assert.strictEqual(payload.records[0].kpi.items.length, 10);
  assert.strictEqual(payload.records[0].opportunity.value_chain_position, 'Platforma');
  assert.strictEqual(payload.records[1].character.primary_kill_risk, 'procurement delay');
  assert.strictEqual(payload.decisionRecords[0].valueChainPosition, 'Platforma');
  assert.strictEqual(payload.decisionRecords[0].entryConditionType, 'Already met');
  assert.strictEqual(payload.decisionRecords[1].qualityState, 'MIXED');
  assert.strictEqual(payload.decisionRecords[1].primaryKillRisk, 'procurement delay');

  const outbound = context.normalizeOutboundWatchlistDispatchPayload(payload);
  assert.strictEqual(outbound.schema, 'economist.response.v2');
  assert.strictEqual(outbound.decisionRecordCount, 2);
  assert.strictEqual(outbound.records.length, 2);
  assert.strictEqual(outbound.decisionRecords.length, 2);
  assert.strictEqual(outbound.records[1].decision_role, 'SECONDARY');
  assert.strictEqual(outbound.records[1].fields.spolka, 'Beta Corp (BET:NASDAQ)');
  assert.strictEqual(outbound.records[0].opportunity.entry_condition_type, 'Already met');
  assert.strictEqual(outbound.records[1].character.quality_state, 'MIXED');
  assert.strictEqual(outbound.decisionRecords[0].valueChainPosition, 'Platforma');
  assert.strictEqual(outbound.decisionRecords[1].qualityState, 'MIXED');
}

function testStructuredJsonDispatchPayload() {
  const text = JSON.stringify({
    schema: 'economist.response.v2',
    records: [
      {
        decision_role: 'PRIMARY',
        fields: {
          data_decyzji: '2026-03-29',
          status_decyzji: 'WATCH',
          spolka: 'Leidos Holdings Inc. (LDOS:NYSE)',
          material_zrodlowy_podcast: 'a16z',
          teza_inwestycyjna: 'Primary',
          bear_scenario_total: 'Bear_TOTAL: 90',
          base_scenario_total: 'Base_TOTAL: 120',
          bull_scenario_total: 'Bull_TOTAL: 160',
          voi_falsy_kluczowe_ryzyka: 'VOI: backlog, Fals: budget cut, Primary risk: execution, Composite: 4.1/5.0, EntryScore: 7.8/10, Sizing: 3%'
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
          value_chain_position: 'Platforma'
        },
        character: {
          proof_class: 'FUNDED'
        },
        kpi: { schema_id: 'core10', items: [] },
        extras: {}
      },
      {
        decision_role: 'SECONDARY',
        fields: {
          data_decyzji: '2026-03-29',
          status_decyzji: 'WATCH',
          spolka: 'KBR (KBR:NYSE)',
          material_zrodlowy_podcast: 'a16z',
          teza_inwestycyjna: 'Secondary',
          bear_scenario_total: 'Bear_TOTAL: 40',
          base_scenario_total: 'Base_TOTAL: 55',
          bull_scenario_total: 'Bull_TOTAL: 70',
          voi_falsy_kluczowe_ryzyka: 'VOI: task orders, Fals: margin compression, Primary risk: procurement delay, Composite: 3.8/5.0, EntryScore: 6.9/10, Sizing: 2%'
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
          value_chain_position: 'Integrator'
        },
        character: {
          proof_class: 'AWARDED'
        },
        kpi: { schema_id: 'core10', items: [] },
        extras: {}
      }
    ]
  });

  const payload = context.normalizeWatchlistDispatchPayload({
    text,
    source: 'a16z',
    analysisType: 'company',
    responseId: 'resp-v2-structured',
    runId: 'run-v2-structured',
    timestamp: 1_710_000_000_000
  });

  assert.strictEqual(payload.schema, 'economist.response.v2');
  assert.strictEqual(payload.records.length, 2);
  assert.strictEqual(payload.decisionRecords.length, 2);
  assert.strictEqual(payload.records[0].decision_role, 'PRIMARY');
  assert.strictEqual(payload.records[1].decision_role, 'SECONDARY');
  assert.strictEqual(payload.records[0].opportunity.value_chain_position, 'Platforma');
  assert.strictEqual(payload.records[1].character.proof_class, 'AWARDED');
  assert.strictEqual(payload.decisionRecords[0].valueChainPosition, 'Platforma');
  assert.strictEqual(payload.decisionRecords[1].proofClass, 'AWARDED');
}

function testStructuredJsonDispatchPayloadBackfillsAliasFields() {
  const text = JSON.stringify({
    schema: 'economist.response.v2',
    records: [
      {
        decision_role: 'SECONDARY',
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
          entry_condition_type: 'DURATION'
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
    ]
  });

  const payload = context.normalizeWatchlistDispatchPayload({
    text,
    source: 'SemiAnalysis Rubin Ultra',
    analysisType: 'company',
    responseId: 'resp-v2-alias-structured',
    runId: 'run-v2-alias-structured',
    timestamp: 1_710_000_000_000
  });

  assert.strictEqual(payload.schema, 'economist.response.v2');
  assert.strictEqual(payload.records.length, 1);
  assert.strictEqual(payload.decisionRecords.length, 1);
  assert.strictEqual(payload.records[0].decision_role, 'SECONDARY');
  assert.strictEqual(payload.records[0].fields.spolka, 'AT&S (ATS:VIE)');
  assert.strictEqual(payload.records[0].fields.decyzja, 'WATCH');
  assert.strictEqual(payload.records[0].fields.status_decyzji, undefined);
  assert.strictEqual(payload.records[0].opportunity.invoice_issuer, 'AT&S Austria Technologie & Systemtechnik AG');
  assert.strictEqual(payload.records[0].character.market_expectation_state, 'Rynek dyskontuje duration');
  assert.strictEqual(payload.records[0].kpi.items[0].value, 5);
  assert.strictEqual(payload.decisionRecords[0].valueChainPosition, 'Dostawca substratow');
  assert.strictEqual(payload.decisionRecords[0].qualityState, 'MIXED');

  const outbound = context.normalizeOutboundWatchlistDispatchPayload(payload);
  assert.strictEqual(outbound.schema, 'economist.response.v2');
  assert.strictEqual(outbound.records.length, 1);
  assert.strictEqual(outbound.decisionRecords.length, 1);
  assert.strictEqual(outbound.records[0].fields.spolka, 'AT&S (ATS:VIE)');
  assert.strictEqual(outbound.records[0].opportunity.invoice_issuer, 'AT&S Austria Technologie & Systemtechnik AG');
  assert.strictEqual(outbound.records[0].kpi.items[0].value, 5);
  assert.strictEqual(outbound.decisionRecords[0].entryConditionType, 'DURATION');
}

function testStructuredV2DispatchWithoutTextSynthesizesPayloadText() {
  const payload = context.normalizeWatchlistDispatchPayload({
    text: '',
    schema: 'economist.response.v2',
    records: [
      makeStructuredV2Record()
    ],
    source: 'SemiAnalysis Rubin Ultra',
    analysisType: 'company',
    responseId: 'resp-v2-no-text',
    runId: 'run-v2-no-text',
    timestamp: 1_710_000_000_000
  });

  assert.strictEqual(payload.schema, 'economist.response.v2');
  assert.strictEqual(payload.records.length, 1);
  assert.strictEqual(payload.decisionRecords.length, 1);
  assert.ok(payload.text.includes('"schema":"economist.response.v2"'));
  assert.ok(payload.text.includes('"spolka":"Camtek (CAMT:NASDAQ)"'));
  assert.strictEqual(payload.decisionRecords[0].company, 'Camtek (CAMT:NASDAQ)');
  assert.strictEqual(payload.decisionRecords[0].qualityState, 'ELITE');

  const outbound = context.normalizeOutboundWatchlistDispatchPayload(payload);
  assert.strictEqual(outbound.schema, 'economist.response.v2');
  assert.strictEqual(outbound.records.length, 1);
  assert.strictEqual(outbound.decisionRecords.length, 1);
  assert.ok(outbound.text.includes('"schema":"economist.response.v2"'));
  assert.strictEqual(outbound.decisionRecords[0].company, 'Camtek (CAMT:NASDAQ)');
}

function testOutboundStructuredV2WithoutTextAcceptsDirectRecords() {
  const outbound = context.normalizeOutboundWatchlistDispatchPayload({
    schema: 'economist.response.v2',
    text: '',
    records: [
      makeStructuredV2Record({
        decision_role: 'SECONDARY',
        fields: {
          spolka: 'AT&S (ATS:VIE)',
          status_decyzji: 'WATCH'
        }
      })
    ],
    source: 'SemiAnalysis Rubin Ultra',
    analysisType: 'company',
    responseId: 'resp-outbound-v2-no-text',
    runId: 'run-outbound-v2-no-text',
    conversationUrl: ' https://chatgpt.com/c/abc ',
    conversationLogs: [{ role: 'assistant', content: 'structured payload' }],
    timestamp: 1_710_000_000_000
  });

  assert.strictEqual(outbound.schema, 'economist.response.v2');
  assert.strictEqual(outbound.records.length, 1);
  assert.strictEqual(outbound.decisionRecords.length, 1);
  assert.strictEqual(outbound.records[0].decision_role, 'SECONDARY');
  assert.strictEqual(outbound.conversationUrl, 'https://chatgpt.com/c/abc');
  assert.strictEqual(outbound.conversationLogCount, 1);
  assert.ok(outbound.text.includes('"spolka":"AT&S (ATS:VIE)"'));
  assert.strictEqual(outbound.decisionRecords[0].company, 'AT&S (ATS:VIE)');
}

function testDispatchPayloadPreservesChatGptComputationTelemetry() {
  const payload = context.normalizeWatchlistDispatchPayload({
    schema: 'economist.response.v2',
    text: '',
    records: [makeStructuredV2Record()],
    source: 'SemiAnalysis Rubin Ultra',
    analysisType: 'company',
    responseId: 'resp-chatgpt-telemetry',
    runId: 'run-chatgpt-telemetry',
    timestamp: 1_710_000_000_000,
    composerThinkingEffort: ' HEAVY ',
    chatGptModeKind: 'Thinking',
    chatGptPlanHint: ' Pro ',
    chatGptModeLabel: ' Thinking ',
    chatGptModelSwitcherLabel: ' ChatGPT Pro ',
    chatGptThinkingEffortDetected: ' HEAVY ',
    chatGptThinkingEffortLabel: ' Heavy ',
    chatGptComputationLabel: ' ChatGPT Pro | Thinking | Heavy ',
    chatGptComputationDetectedAt: 1_710_000_123_456
  });

  assert.strictEqual(payload.schema, 'economist.response.v2');
  assert.strictEqual(payload.composerThinkingEffort, 'heavy');
  assert.strictEqual(payload.chatGptModeKind, 'thinking');
  assert.strictEqual(payload.chatGptPlanHint, 'pro');
  assert.strictEqual(payload.chatGptModeLabel, 'Thinking');
  assert.strictEqual(payload.chatGptModelSwitcherLabel, 'ChatGPT Pro');
  assert.strictEqual(payload.chatGptThinkingEffortDetected, 'heavy');
  assert.strictEqual(payload.chatGptThinkingEffortLabel, 'Heavy');
  assert.strictEqual(payload.chatGptComputationLabel, 'ChatGPT Pro | Thinking | Heavy');
  assert.strictEqual(payload.chatGptComputationDetectedAt, 1_710_000_123_456);

  const outbound = context.normalizeOutboundWatchlistDispatchPayload(payload);
  assert.strictEqual(outbound.composerThinkingEffort, 'heavy');
  assert.strictEqual(outbound.chatGptModeKind, 'thinking');
  assert.strictEqual(outbound.chatGptPlanHint, 'pro');
  assert.strictEqual(outbound.chatGptModeLabel, 'Thinking');
  assert.strictEqual(outbound.chatGptModelSwitcherLabel, 'ChatGPT Pro');
  assert.strictEqual(outbound.chatGptThinkingEffortDetected, 'heavy');
  assert.strictEqual(outbound.chatGptThinkingEffortLabel, 'Heavy');
  assert.strictEqual(outbound.chatGptComputationLabel, 'ChatGPT Pro | Thinking | Heavy');
  assert.strictEqual(outbound.chatGptComputationDetectedAt, 1_710_000_123_456);
}

function main() {
  testCurrentPairPayload();
  testShortfallPayload();
  testFallbackMapperPreservesKpiScorecard();
  testStructuredV2PayloadPreservesRecords();
  testStructuredJsonDispatchPayload();
  testStructuredJsonDispatchPayloadBackfillsAliasFields();
  testStructuredV2DispatchWithoutTextSynthesizesPayloadText();
  testOutboundStructuredV2WithoutTextAcceptsDirectRecords();
  testDispatchPayloadPreservesChatGptComputationTelemetry();
  console.log('test-watchlist-dispatch-decision-contract.js: ok');
}

main();
