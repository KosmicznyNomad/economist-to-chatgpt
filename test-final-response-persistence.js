const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DecisionContractUtils = require('./decision-contract.js');

const backgroundPath = path.join(__dirname, 'background.js');
const backgroundSource = fs.readFileSync(backgroundPath, 'utf8');

function extractFunctionSource(source, functionName) {
  const pattern = new RegExp(`(?:async\\s+)?function\\s+${functionName}\\s*\\(`);
  const match = pattern.exec(source);
  if (!match) {
    throw new Error(`Function not found: ${functionName}`);
  }
  const startIndex = match.index;
  let parenDepth = 0;
  let braceStart = -1;
  for (let index = match.index; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') {
      parenDepth += 1;
      continue;
    }
    if (char === ')') {
      parenDepth -= 1;
      continue;
    }
    if (char === '{' && parenDepth === 0) {
      braceStart = index;
      break;
    }
  }
  if (braceStart === -1) {
    throw new Error(`Function body not found: ${functionName}`);
  }
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
    'Software steruje praca, pieniedzmi i ryzykiem',
    'Technologia i oprogramowanie',
    'Software',
    'Subscription',
    'USA',
    'USD',
    'FQ:8,TE:7,CM:9,VS:6,TQ:7,PP:8,CP:5,CD:7,NO:8,MR:6'
  ].join('; ');
}

const context = {
  console,
  JSON,
  DecisionContractUtils,
  STRUCTURED_WATCHLIST_OPPORTUNITY_KEYS: [
    'value_chain_position',
    'price_dislocation_reason',
    'rerating_catalyst_type',
    'time_horizon_type',
    'entry_condition_type'
  ],
  STRUCTURED_WATCHLIST_CHARACTER_KEYS: [
    'quality_state',
    'safety_state',
    'thesis_stock_relationship',
    'proof_class',
    'confidence_in_thesis',
    'primary_kill_risk'
  ],
  extractAssistantTextFromProcess(process) {
    if (!process || typeof process !== 'object') return '';
    if (typeof process.completedResponseText === 'string' && process.completedResponseText.trim()) {
      return process.completedResponseText.trim();
    }
    return '';
  },
  extractLastAssistantResponseFromTab() {
    throw new Error('DOM fallback should not be used in this test');
  }
};

vm.createContext(context);
[
  'normalizeStructuredWatchlistValue',
  'normalizeStructuredWatchlistObject',
  'normalizeStructuredWatchlistNamedSection',
  'sanitizeStructuredWatchlistRecord',
  'extractStructuredWatchlistJsonCandidates',
  'extractStructuredWatchlistResponseFromText',
  'buildResponseContractValidation',
  'getCompletedProcessFinalityState',
  'resolveCompletedProcessFinalResponseText'
].forEach((functionName) => {
  vm.runInContext(extractFunctionSource(backgroundSource, functionName), context);
});

async function testRequiresCompletedPayload() {
  const result = await context.resolveCompletedProcessFinalResponseText({
    currentPrompt: 12,
    totalPrompts: 12,
    completedResponseText: ''
  });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, 'completed_response_missing');
}

async function testRequiresFinalPromptCompletion() {
  const result = await context.resolveCompletedProcessFinalResponseText({
    currentPrompt: 11,
    totalPrompts: 12,
    completedResponseText: makeCurrent16Line('PRIMARY', 'Alpha Corp')
  });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, 'not_final_stage');
}

async function testRejectsInvalidFinalContract() {
  const result = await context.resolveCompletedProcessFinalResponseText({
    currentPrompt: 12,
    totalPrompts: 12,
    completedResponseText: 'plain text without final contract'
  });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, 'invalid_final_response_contract');
}

async function testAcceptsStructuredV2FinalContract() {
  const result = await context.resolveCompletedProcessFinalResponseText({
    currentPrompt: 12,
    totalPrompts: 12,
    completedResponseText: JSON.stringify({
      schema: 'economist.response.v2',
      records: [
        {
          decision_role: 'PRIMARY',
          fields: {
            data_decyzji: '2026-03-20',
            status_decyzji: 'WATCH',
            spolka: 'Alpha Corp (ALP:NASDAQ)',
            zrodlo_tezy: 'Alpha source',
            material_zrodlowy_podcast: 'Alpha source',
            teza_inwestycyjna: 'Alpha thesis',
            bear_scenario_total: 'Bear_TOTAL: 10',
            base_scenario_total: 'Base_TOTAL: 20',
            bull_scenario_total: 'Bull_TOTAL: 30',
            voi_falsy_kluczowe_ryzyka: 'VOI: alpha, Fals: beta, Primary risk: gamma, Composite: 4.2/5.0, EntryScore: 8.1/10, Sizing: 3%',
            sektor: 'Software steruje praca, pieniedzmi i ryzykiem',
            rodzina_spolki: 'Technologia i oprogramowanie',
            typ_spolki: 'Software',
            model_przychodu: 'Subscription',
            region: 'USA',
            waluta: 'USD'
          },
          taxonomy: {
            sector: 'Software steruje praca, pieniedzmi i ryzykiem',
            company_family: 'Technologia i oprogramowanie',
            company_type: 'Software',
            revenue_model: 'Subscription',
            region: 'USA',
            currency: 'USD'
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
          extras: {}
        }
      ]
    })
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.contractKind, 'economist.response.v2');
}

async function main() {
  await testRequiresCompletedPayload();
  await testRequiresFinalPromptCompletion();
  await testRejectsInvalidFinalContract();
  await testAcceptsStructuredV2FinalContract();
  console.log('test-final-response-persistence.js: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
