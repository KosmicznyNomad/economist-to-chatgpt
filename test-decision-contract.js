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
    'USD'
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

function main() {
  testCurrentContract();
  testShortfallContract();
  testInvalidCurrentShapes();
  testLegacyCompatibility();
  testFormattingAndExtraction();
  testViewHelpers();
  testViewHelpersFallbacks();
  console.log('test-decision-contract.js: ok');
}

main();
