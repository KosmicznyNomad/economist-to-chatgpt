const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DecisionContractUtils = require('./decision-contract.js');
const DecisionViewModelUtils = require('./decision-view-model.js');

function extractFunctionSource(source, functionName) {
  const pattern = new RegExp(`(?:async\\s+)?function\\s+${functionName}\\s*\\(`);
  const match = pattern.exec(source);
  if (!match) {
    throw new Error(`Function not found: ${functionName}`);
  }

  const startIndex = match.index;
  const paramsStart = source.indexOf('(', match.index);
  let parenDepth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;
  let braceStart = -1;

  for (let index = paramsStart; index < source.length; index += 1) {
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
    if (char === '(') {
      parenDepth += 1;
      continue;
    }
    if (char === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        braceStart = source.indexOf('{', index);
        break;
      }
    }
  }

  if (braceStart < 0) {
    throw new Error(`Function body not found: ${functionName}`);
  }

  let depth = 0;
  inSingle = false;
  inDouble = false;
  inTemplate = false;
  inLineComment = false;
  inBlockComment = false;
  escaped = false;

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

function loadProcessMonitorContext() {
  const monitorPath = path.join(__dirname, 'process-monitor.js');
  const monitorSource = fs.readFileSync(monitorPath, 'utf8');
  const context = { console };
  vm.createContext(context);
  ['formatDecisionContractStatusLabel', 'formatCompanySnapshotText'].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(monitorSource, functionName), context);
  });
  return context;
}

function testMarketRowsFollowStage12RecordModel() {
  const alphaText = [
    makeCurrent16Line('PRIMARY', 'Alpha Corp (ALFA)', { composite: '4.2/5.0', sizing: '3%' }),
    makeCurrent16Line('SECONDARY', 'Beta Corp (BETA)', { composite: '3.8/5.0', sizing: '2%' })
  ].join('\n');
  const omegaText = [
    makeCurrent16Line('PRIMARY', 'Omega Corp (OMEG)', { composite: '4.6/5.0', sizing: '1%' }),
    DecisionContractUtils.SHORTFALL_MARKER
  ].join('\n');

  const rows = DecisionViewModelUtils.buildMarketRowsFromResponses([
    {
      analysisType: 'company',
      source: 'Alpha source',
      text: alphaText,
      timestamp: 1_710_000_000_000,
      decisionContract: DecisionContractUtils.buildDecisionContractSummary(alphaText)
    },
    {
      analysisType: 'company',
      source: 'Omega source',
      text: omegaText,
      timestamp: 1_710_000_500_000,
      decisionContract: DecisionContractUtils.buildDecisionContractSummary(omegaText)
    },
    {
      analysisType: 'company',
      source: 'Broken source',
      text: 'not a decision contract',
      timestamp: 1_710_000_900_000
    }
  ], DecisionContractUtils);

  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].company, 'Alpha Corp (ALFA)');
  assert.strictEqual(rows[0].role, 'PRIMARY');
  assert.strictEqual(rows[0].contractStatus, 'current');
  assert.strictEqual(rows[0].compositeText, '4.2/5.0');
  assert.strictEqual(rows[0].sizingText, '3%');
  assert.strictEqual(rows[0].baseRank, 1);

  assert.strictEqual(rows[1].company, 'Beta Corp (BETA)');
  assert.strictEqual(rows[1].role, 'SECONDARY');
  assert.strictEqual(rows[1].contractStatus, 'current');
  assert.strictEqual(rows[1].baseRank, 2);

  assert.strictEqual(rows[2].company, 'Omega Corp (OMEG)');
  assert.strictEqual(rows[2].role, 'PRIMARY');
  assert.strictEqual(rows[2].contractStatus, 'shortfall');
  assert.strictEqual(rows[2].baseRank, 3);
}

function testStage12PairSummaryShowsCurrentAndShortfall() {
  const currentText = [
    makeCurrent16Line('PRIMARY', 'Richemont (CFR:SW)', { composite: '4.1/5.0', sizing: '3%' }),
    makeCurrent16Line('SECONDARY', 'Swatch Group (UHR:SW)', { composite: '3.4/5.0', sizing: '2%' })
  ].join('\n');
  const shortfallText = [
    makeCurrent16Line('PRIMARY', 'Only One (ONE:NYSE)', { composite: '4.7/5.0', sizing: '4%' }),
    DecisionContractUtils.SHORTFALL_MARKER
  ].join('\n');

  const currentSummary = DecisionViewModelUtils.buildStage12PairSummary({
    text: currentText,
    timestamp: 1_710_001_000_000
  }, DecisionContractUtils);
  const shortfallSummary = DecisionViewModelUtils.buildStage12PairSummary({
    text: shortfallText,
    timestamp: 1_710_001_100_000
  }, DecisionContractUtils);

  assert.strictEqual(currentSummary.status, 'current');
  assert.strictEqual(currentSummary.lines.length, 2);
  assert.ok(currentSummary.lines[0].includes('PRIMARY - Richemont (CFR:SW)'));
  assert.ok(currentSummary.lines[1].includes('SECONDARY - Swatch Group (UHR:SW)'));

  assert.strictEqual(shortfallSummary.status, 'shortfall');
  assert.strictEqual(shortfallSummary.lines.length, 2);
  assert.ok(shortfallSummary.lines[0].includes('PRIMARY - Only One (ONE:NYSE)'));
  assert.ok(shortfallSummary.lines[1].includes('SHORTFALL'));
}

function testProcessMonitorSnapshotFormattingUsesStage12Records() {
  const context = loadProcessMonitorContext();
  const text = context.formatCompanySnapshotText({
    company: 'Alpha Corp',
    hasDecisionRecord: true,
    hasCompletedResponse: true,
    decisionContractStatus: 'current',
    decisionContractIssues: [],
    decisionRecordCount: 2,
    stage12Records: [
      {
        decisionRole: 'PRIMARY',
        company: 'Alpha Corp',
        decisionStatus: 'WATCH',
        composite: '4.2/5.0',
        sizing: '3%',
        voi: 'backlog > 10%',
        fals: 'churn > 5%',
        primaryRisk: 'pricing reset',
        sector: 'Technology',
        companyFamily: 'Technology',
        companyType: 'Software',
        revenueModel: 'Subscription',
        region: 'USA',
        currency: 'USD'
      },
      {
        decisionRole: 'SECONDARY',
        company: 'Beta Corp',
        decisionStatus: 'TRIM',
        composite: '3.8/5.0',
        sizing: '2%',
        sector: 'Technology',
        companyFamily: 'Technology',
        companyType: 'Software',
        revenueModel: 'Subscription',
        region: 'USA',
        currency: 'USD'
      }
    ]
  });

  assert.ok(text.includes('Kontrakt Stage 12: current | Rekordy: 2'));
  assert.ok(text.includes('PRIMARY: Alpha Corp | WATCH | Composite: 4.2/5.0 | Sizing: 3%'));
  assert.ok(text.includes('SECONDARY: Beta Corp | TRIM | Composite: 3.8/5.0 | Sizing: 2%'));
  assert.ok(text.includes('VOI/Fals/Risk PRIMARY:'));
  assert.ok(text.includes('Taxonomia PRIMARY:'));
  assert.ok(text.includes('Region/Waluta PRIMARY:'));
  assert.ok(!text.includes('Asymetria'));
}

function main() {
  testMarketRowsFollowStage12RecordModel();
  testStage12PairSummaryShowsCurrentAndShortfall();
  testProcessMonitorSnapshotFormattingUsesStage12Records();
  console.log('test-dashboard-decision-contract-ui.js: ok');
}

main();
