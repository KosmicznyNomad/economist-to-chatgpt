const assert = require('assert');

const DecisionContractUtils = require('./decision-contract.js');

function makeCurrent16Line(role, company, field10 = 'VOI: backlog > 10%, Fals: churn > 5%, Primary risk: pricing reset, Composite: 4.2/5.0, EntryScore: 8.1/10, Sizing: 3%') {
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
    field10,
    'Technology',
    'Technology',
    'Software',
    'Subscription',
    'USA',
    'USD',
    'FQ:8,TE:7,CM:9,VS:6,TQ:7,PP:8,CP:5,CD:7,NO:8,MR:6'
  ].join('; ');
}

function makeLegacy12Line(company) {
  return [
    '2026-03-20',
    'WATCH',
    company,
    'Legacy source',
    `${company} thesis. Asymmetry: 2.0x`,
    'Bear_TOTAL: 10',
    'Base_TOTAL: 20',
    'Bull_TOTAL: 30',
    'VOI: signal, Fals: trigger, Primary risk: drawdown',
    'Technology',
    'USA',
    'USD'
  ].join('; ');
}

function makeLegacy13RoleLine(role, company) {
  return [
    '2026-03-20',
    'WATCH',
    role,
    company,
    'Legacy source',
    `${company} thesis`,
    'Bear_TOTAL: 10',
    'Base_TOTAL: 20',
    'Bull_TOTAL: 30',
    'VOI: signal, Fals: trigger, Primary risk: drawdown',
    'Technology',
    'USA',
    'USD'
  ].join('; ');
}

function testCurrentContract() {
  const text = [
    makeCurrent16Line('PRIMARY', 'Alpha Corp'),
    makeCurrent16Line('SECONDARY', 'Beta Corp', 'VOI: margin > 20%, Fals: backlog < 1x, Primary risk: demand reset, Composite: 3.8/5.0, EntryScore: 6.7/10, Sizing: 2%')
  ].join('\n');
  const validation = DecisionContractUtils.validateDecisionContractText(text);

  assert.strictEqual(validation.status, 'current');
  assert.strictEqual(validation.recordCount, 2);
  assert.strictEqual(validation.primaryRecord.decisionRole, 'PRIMARY');
  assert.strictEqual(validation.primaryRecord.recordFormat, 'current_17_role');
  assert.strictEqual(validation.records[1].decisionRole, 'SECONDARY');
  assert.strictEqual(validation.primaryRecord.field10Meta.composite, '4.2/5.0');
  assert.strictEqual(validation.primaryRecord.field10Meta.entryScore, '8.1/10');
  assert.strictEqual(validation.primaryRecord.field10Meta.sizing, '3%');
  assert.strictEqual(validation.canonicalText, text);
}

function testShortfallContract() {
  const text = [
    makeCurrent16Line('PRIMARY', 'Solo Corp'),
    DecisionContractUtils.SHORTFALL_MARKER
  ].join('\n');
  const validation = DecisionContractUtils.validateDecisionContractText(text);

  assert.strictEqual(validation.status, 'shortfall');
  assert.strictEqual(validation.recordCount, 1);
  assert.strictEqual(validation.primaryRecord.company, 'Solo Corp');
  assert.strictEqual(validation.canonicalText, text);
}

function testInvalidCurrentShapes() {
  const reversed = [
    makeCurrent16Line('SECONDARY', 'Wrong First'),
    makeCurrent16Line('PRIMARY', 'Wrong Second')
  ].join('\n');
  const reversedValidation = DecisionContractUtils.validateDecisionContractText(reversed);
  assert.strictEqual(reversedValidation.status, 'invalid');
  assert.ok(reversedValidation.issueCodes.includes('invalid_role_order'));

  const oneLine = makeCurrent16Line('PRIMARY', 'Lonely Corp');
  const oneLineValidation = DecisionContractUtils.validateDecisionContractText(oneLine);
  assert.strictEqual(oneLineValidation.status, 'invalid');
  assert.ok(oneLineValidation.issueCodes.includes('expected_two_record_lines'));

  const malformedField10 = [
    makeCurrent16Line('PRIMARY', 'Broken Corp', 'VOI: signal, Composite: 4.1/5.0, EntryScore: 7.5/10, Sizing: 3%'),
    makeCurrent16Line('SECONDARY', 'Okay Corp')
  ].join('\n');
  const malformedValidation = DecisionContractUtils.validateDecisionContractText(malformedField10);
  assert.strictEqual(malformedValidation.status, 'invalid');
  assert.ok(malformedValidation.issueCodes.includes('field10_invalid'));

  const fifteenFields = makeCurrent16Line('PRIMARY', 'Fifteen Corp')
    .split('; ')
    .slice(0, 15)
    .join('; ');
  const fifteenValidation = DecisionContractUtils.validateDecisionContractText(fifteenFields);
  assert.strictEqual(fifteenValidation.status, 'invalid');
  assert.ok(
    fifteenValidation.issueCodes.includes('no_decision_records')
      || fifteenValidation.issueCodes.includes('unparsed_record_lines')
  );
}

function testLegacyCompatibility() {
  const legacy12 = DecisionContractUtils.validateDecisionContractText(makeLegacy12Line('Legacy Twelve'));
  assert.strictEqual(legacy12.status, 'legacy');
  assert.strictEqual(legacy12.recordCount, 1);
  assert.ok(legacy12.issueCodes.includes('legacy_format_detected'));

  const legacy13 = DecisionContractUtils.validateDecisionContractText(makeLegacy13RoleLine('PRIMARY', 'Legacy Thirteen'));
  assert.strictEqual(legacy13.status, 'legacy');
  assert.strictEqual(legacy13.recordCount, 1);

  const oldCurrent16Text = [
    makeCurrent16Line('PRIMARY', 'Compat Sixteen A').split('; ').slice(0, 16).join('; '),
    makeCurrent16Line('SECONDARY', 'Compat Sixteen B').split('; ').slice(0, 16).join('; ')
  ].join('\n');
  const oldCurrent16 = DecisionContractUtils.validateDecisionContractText(oldCurrent16Text);
  assert.strictEqual(oldCurrent16.status, 'current');
  assert.strictEqual(oldCurrent16.primaryRecord.recordFormat, 'current_16_role');
}

function testFormattingAndExtraction() {
  const text = [
    makeCurrent16Line('PRIMARY', 'Alpha Corp'),
    makeCurrent16Line('SECONDARY', 'Beta Corp')
  ].join('\n');
  const formatted = DecisionContractUtils.formatDecisionRecordTable(text);
  assert.ok(formatted.includes('1 - Data decyzji - 2026-03-20'));
  assert.ok(formatted.includes('3 - Rola - PRIMARY'));

  const extracted = DecisionContractUtils.extractDecisionRecordFromText(text);
  assert.strictEqual(extracted.company, 'Alpha Corp');
}

function testViewHelpers() {
  const text = [
    makeCurrent16Line('PRIMARY', 'Alpha Corp'),
    makeCurrent16Line('SECONDARY', 'Beta Corp', 'VOI: margin > 20%, Fals: backlog < 1x, Primary risk: demand reset, Composite: 3.8/5.0, EntryScore: 6.7/10, Sizing: 2%')
  ].join('\n');
  const validation = DecisionContractUtils.validateDecisionContractText(text);
  const normalized = DecisionContractUtils.normalizeDecisionContractSummary(validation.decisionContract);
  const primary = DecisionContractUtils.getDecisionContractPrimaryRecord(normalized);
  const secondary = DecisionContractUtils.getDecisionContractSecondaryRecord(normalized);
  const snapshot = DecisionContractUtils.buildDecisionContractSnapshot(normalized);

  assert.strictEqual(normalized.status, 'current');
  assert.strictEqual(normalized.records.length, 2);
  assert.strictEqual(primary.company, 'Alpha Corp');
  assert.strictEqual(primary.decisionStatus, 'WATCH');
  assert.strictEqual(primary.sector, 'Technology');
  assert.strictEqual(primary.compositeValue, 4.2);
  assert.strictEqual(primary.sizingPercent, 3);
  assert.strictEqual(primary.kpiScorecard, 'FQ:8,TE:7,CM:9,VS:6,TQ:7,PP:8,CP:5,CD:7,NO:8,MR:6');
  assert.strictEqual(secondary.company, 'Beta Corp');
  assert.strictEqual(secondary.compositeValue, 3.8);
  assert.strictEqual(snapshot.company, 'Alpha Corp');
  assert.strictEqual(snapshot.secondaryPresent, true);
  assert.strictEqual(snapshot.recordCount, 2);
}

function testViewHelpersFallbacks() {
  const legacy = DecisionContractUtils.validateDecisionContractText(makeLegacy12Line('Legacy Twelve'));
  const legacySnapshot = DecisionContractUtils.buildDecisionContractSnapshot(legacy.decisionContract);
  assert.strictEqual(legacySnapshot.status, 'legacy');
  assert.strictEqual(legacySnapshot.primaryRecord.company, 'Legacy Twelve');
  assert.strictEqual(legacySnapshot.secondaryRecord, null);

  const invalidSnapshot = DecisionContractUtils.buildDecisionContractSnapshot(null);
  assert.strictEqual(invalidSnapshot.status, 'invalid');
  assert.strictEqual(invalidSnapshot.hasDecisionRecord, false);
  assert.strictEqual(invalidSnapshot.hasRenderableCompany, false);
}

function testStructuredJsonV2Contract() {
  const text = JSON.stringify({
    records: [
      {
        decision_role: 'PRIMARY',
        fields: {
          data_decyzji: '2026-03-29',
          spolka: 'Leidos Holdings Inc. (LDOS:NYSE)',
          material_zrodlowy_podcast: 'a16z podcast',
          teza_inwestycyjna: 'Primary thesis',
          bear_scenario_total: 'Bear_TOTAL: 90',
          base_scenario_total: 'Base_TOTAL: 120',
          bull_scenario_total: 'Bull_TOTAL: 160',
          voi_falsy_kluczowe_ryzyka: 'VOI: backlog, Fals: budget cut, Primary risk: execution, Composite: 4.1/5.0, EntryScore: 7.8/10, Sizing: 3%'
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
          entry_condition_type: 'Already met'
        },
        character: {
          proof_class: 'FUNDED',
          primary_kill_risk: 'execution'
        },
        kpi: {
          schema_id: 'core10',
          items: [
            { key: 'FQ', label: 'Financial Quality', value: 8 },
            { key: 'TE', label: 'Thesis Exposure', value: 7 },
            { key: 'CM', label: 'Competitive Moat', value: 8 },
            { key: 'VS', label: 'Valuation Safety', value: 6 },
            { key: 'TQ', label: 'Traction Quality', value: 7 },
            { key: 'PP', label: 'Pricing Power', value: 7 },
            { key: 'CP', label: 'Catalyst Proximity', value: 5 },
            { key: 'CD', label: 'Capital Discipline', value: 7 },
            { key: 'NO', label: 'Non-Obviousness', value: 8 },
            { key: 'MR', label: 'Monetization Realism', value: 6 }
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
          data_decyzji: '2026-03-29',
          spolka: 'KBR (KBR:NYSE)',
          material_zrodlowy_podcast: 'a16z podcast',
          teza_inwestycyjna: 'Secondary thesis',
          bear_scenario_total: 'Bear_TOTAL: 40',
          base_scenario_total: 'Base_TOTAL: 55',
          bull_scenario_total: 'Bull_TOTAL: 70',
          voi_falsy_kluczowe_ryzyka: 'VOI: task orders, Fals: margin compression, Primary risk: procurement delay, Composite: 3.8/5.0, EntryScore: 6.9/10, Sizing: 2%'
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
          value_chain_position: 'Integrator',
          entry_condition_type: 'Proof only'
        },
        character: {
          proof_class: 'AWARDED',
          primary_kill_risk: 'procurement delay'
        },
        kpi: { schema_id: 'core10', items: [] },
        extras: {
          identity: {
            decision_category: 'WATCH'
          }
        }
      }
    ]
  });

  const validation = DecisionContractUtils.validateDecisionContractText(text);
  assert.strictEqual(validation.status, 'current');
  assert.strictEqual(validation.recordCount, 2);
  assert.strictEqual(validation.primaryRecord.company, 'Leidos Holdings Inc. (LDOS:NYSE)');
  assert.strictEqual(validation.primaryRecord.decisionStatus, 'WATCH');
  assert.strictEqual(validation.primaryRecord.sector, 'Defense');
  assert.strictEqual(validation.structuredPayload.records[0].taxonomy.worldview_bucket, 'Software steruje praca, pieniedzmi i ryzykiem');
  assert.strictEqual(validation.records[1].decisionRole, 'SECONDARY');
  assert.strictEqual(validation.primaryRecord.opportunity.value_chain_position, 'Platforma');
  assert.strictEqual(validation.records[1].character.primary_kill_risk, 'procurement delay');
}

function main() {
  testCurrentContract();
  testShortfallContract();
  testInvalidCurrentShapes();
  testLegacyCompatibility();
  testFormattingAndExtraction();
  testViewHelpers();
  testViewHelpersFallbacks();
  testStructuredJsonV2Contract();
  console.log('test-decision-contract.js: ok');
}

main();
