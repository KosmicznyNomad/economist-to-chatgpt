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
    'USD'
  ].join('; ');
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
['mapDispatchDecisionRecord', 'normalizeWatchlistDispatchPayload', 'normalizeOutboundWatchlistDispatchPayload']
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

function main() {
  testCurrentPairPayload();
  testShortfallPayload();
  console.log('test-watchlist-dispatch-decision-contract.js: ok');
}

main();
