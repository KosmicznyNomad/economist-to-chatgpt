const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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

function loadResponsesHelpers() {
  const source = fs.readFileSync(path.join(__dirname, 'responses.js'), 'utf8');
  const context = {
    console,
    buildResponseDecisionContractView(response) {
      return response.stage12View || {
        primaryRecord: null,
        secondaryRecord: null
      };
    },
    describeResponseSource(response) {
      return response.sourceInfo || {
        display: response.source || 'Artykuł',
        detail: '',
        tag: ''
      };
    }
  };
  vm.createContext(context);

  [
    'normalizeMarketText',
    'normalizeMarketToken',
    'normalizeFuzzyText',
    'tokenizeFuzzyText',
    'levenshteinDistanceWithLimit',
    'scoreTokenSimilarity',
    'scoreCompanyQueryAgainstRow',
    'extractTickerFromCompany',
    'buildResponseCompanyEntries',
    'responseMatchesCompanyQuery',
    'buildResponseCardHeaderModel',
    'flattenResponseTextForExport'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(source, functionName), context);
  });

  return context;
}

function testCompanyHelpersFollowStage12Companies() {
  const context = loadResponsesHelpers();
  const response = {
    source: 'The Economist',
    sourceInfo: {
      display: 'The Economist Podcast: Babbage',
      detail: 'AI chips special',
      tag: 'Economist Podcast'
    },
    stage12View: {
      primaryRecord: {
        company: 'Nvidia (NVDA)',
        role: 'PRIMARY',
        decisionStatus: 'WATCH',
        sector: 'Technology',
        region: 'USA',
        currency: 'USD'
      },
      secondaryRecord: {
        company: 'Taiwan Semiconductor (TSM)',
        role: 'SECONDARY',
        decisionStatus: 'WATCH',
        sector: 'Technology',
        region: 'Taiwan',
        currency: 'TWD'
      }
    }
  };

  const entries = context.buildResponseCompanyEntries(response);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].company, 'Nvidia (NVDA)');
  assert.strictEqual(entries[0].ticker, 'NVDA');
  assert.strictEqual(entries[1].company, 'Taiwan Semiconductor (TSM)');
  assert.strictEqual(entries[1].ticker, 'TSM');

  assert.strictEqual(context.responseMatchesCompanyQuery(response, 'Nvidia'), true);
  assert.strictEqual(context.responseMatchesCompanyQuery(response, 'TSM'), true);
  assert.strictEqual(context.responseMatchesCompanyQuery(response, 'ASML'), false);

  const header = context.buildResponseCardHeaderModel(response);
  assert.strictEqual(header.title, 'Nvidia (NVDA) / Taiwan Semiconductor (TSM)');
  assert.strictEqual(header.detail, 'The Economist Podcast: Babbage | AI chips special');
  assert.strictEqual(header.tag, 'Economist Podcast');
}

function testCompanyQueryFallsBackToSourceAndText() {
  const context = loadResponsesHelpers();
  const response = {
    source: 'Manual source',
    text: 'Nvidia remains the key beneficiary of AI capex acceleration.',
    stage12View: {
      primaryRecord: null,
      secondaryRecord: null
    }
  };

  assert.strictEqual(context.responseMatchesCompanyQuery(response, 'Nvidia'), true);
  assert.strictEqual(context.responseMatchesCompanyQuery(response, 'TSMC'), false);
}

function testExportFlattensMultilineResponses() {
  const context = loadResponsesHelpers();
  const flattened = context.flattenResponseTextForExport('Line 1\nLine 2\tTabbed\n\nLine 3');
  assert.strictEqual(flattened, 'Line 1 ⏎ Line 2 Tabbed ⏎ Line 3');
}

function main() {
  testCompanyHelpersFollowStage12Companies();
  testCompanyQueryFallsBackToSourceAndText();
  testExportFlattensMultilineResponses();
  console.log('test-responses-company-browser.js: ok');
}

main();
