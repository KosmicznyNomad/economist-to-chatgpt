const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DecisionContractUtils = require('./decision-contract.js');
const ProcessContractUtils = require('./process-contract.js');

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

function makeStructuredV2Response(company = 'Alpha Corp') {
  return JSON.stringify({
    records: [
      {
        decision_role: 'PRIMARY',
        fields: {
          data_decyzji: '2026-03-20',
          spolka: `${company} (ALP:NASDAQ)`,
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
      }
    ]
  });
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
  getCompletedProcessLocalSaveState(process) {
    if (!process || typeof process !== 'object') return null;
    if (typeof process?.persistenceStatus?.saveOk === 'boolean') {
      return process.persistenceStatus.saveOk;
    }
    if (typeof process?.completedResponseSaved === 'boolean') {
      return process.completedResponseSaved;
    }
    if (typeof process?.finalStagePersistence?.success === 'boolean') {
      return process.finalStagePersistence.success;
    }
    return null;
  },
  hasCompletedProcessLocalSave(process) {
    if (!process || typeof process !== 'object') return false;
    if (typeof process?.persistenceStatus?.saveOk === 'boolean') {
      return process.persistenceStatus.saveOk === true;
    }
    if (typeof process?.completedResponseSaved === 'boolean') {
      return process.completedResponseSaved === true;
    }
    return process?.finalStagePersistence?.success === true;
  },
  extractLastAssistantResponseFromTab() {
    throw new Error('DOM fallback should not be used in this test');
  }
};

vm.createContext(context);
[
  'extractResponseIdFromCopyTrace',
  'collectKnownProcessResponseIds',
  'findStoredCompletedResponseForProcess',
  'normalizeStructuredWatchlistValue',
  'normalizeStructuredWatchlistObject',
  'normalizeStructuredWatchlistNamedSection',
  'sanitizeStructuredWatchlistRecord',
  'extractStructuredWatchlistJsonCandidates',
  'extractStructuredWatchlistResponseFromText',
  'buildResponseContractValidation',
  'getCompletedProcessLocalSaveState',
  'hasCompletedProcessLocalSave',
  'getCompletedProcessFinalityState',
  'resolveCompletedProcessFinalResponseText'
].forEach((functionName) => {
  vm.runInContext(extractFunctionSource(backgroundSource, functionName), context);
});

async function testRequiresCompletedPayload() {
  const result = await context.resolveCompletedProcessFinalResponseText({
    currentPrompt: 15,
    totalPrompts: 15,
    completedResponseText: ''
  });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, 'completed_response_missing');
}

async function testAcceptsCompletedPayloadEvenWhenPromptCountersLag() {
  const result = await context.resolveCompletedProcessFinalResponseText({
    currentPrompt: 11,
    totalPrompts: 15,
    completedResponseText: makeStructuredV2Response('Alpha Corp')
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.contractKind, 'economist.response.v2');
}

async function testRejectsInvalidFinalContract() {
  const result = await context.resolveCompletedProcessFinalResponseText({
    currentPrompt: 15,
    totalPrompts: 15,
    completedResponseText: 'plain text without final contract'
  });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reason, 'invalid_final_response_contract');
}

async function testAcceptsStructuredV2FinalContract() {
  const result = await context.resolveCompletedProcessFinalResponseText({
    currentPrompt: 15,
    totalPrompts: 15,
    completedResponseText: makeStructuredV2Response('Alpha Corp')
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.contractKind, 'economist.response.v2');
}

async function testFallsBackToCanonicalStorageWhenProcessPayloadMissing() {
  context.readCanonicalResponsesFromStorage = async () => ([
    {
      responseId: 'resp-alpha',
      runId: 'run-alpha',
      analysisType: 'company',
      conversationUrl: 'https://chatgpt.com/c/alpha',
      timestamp: 1775987605000,
      text: makeStructuredV2Response('Alpha Corp')
    }
  ]);

  const result = await context.resolveCompletedProcessFinalResponseText({
    id: 'run-alpha',
    analysisType: 'company',
    currentPrompt: 15,
    totalPrompts: 15,
    completedResponseText: '',
    chatUrl: 'https://chatgpt.com/c/alpha',
    finalStagePersistence: {
      responseId: 'resp-alpha'
    }
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.resolutionSource, 'canonical_storage');
  assert.strictEqual(result.storageResponseId, 'resp-alpha');
  assert.strictEqual(result.responseText, makeStructuredV2Response('Alpha Corp'));
  assert.strictEqual(result.processPatch.completedResponseText, makeStructuredV2Response('Alpha Corp'));
}

function testCriticalCompletedResponsePatchFlushesImmediately() {
  const flushContext = vm.createContext({
    console,
    isClosedProcessStatus(status) {
      return ['completed', 'failed', 'stopped'].includes(String(status || '').trim().toLowerCase());
    },
    normalizeProcessActionRequired(value, fallback = 'none') {
      const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
      return normalized || fallback;
    },
    deriveProcessActionRequired() {
      return 'none';
    }
  });

  vm.runInContext(extractFunctionSource(backgroundSource, 'shouldFlushProcessUpdateImmediately'), flushContext);

  const shouldFlush = flushContext.shouldFlushProcessUpdateImmediately(
    {
      id: 'run-alpha',
      lifecycleStatus: 'finalizing',
      currentPrompt: 15,
      queueState: ''
    },
    {
      id: 'run-alpha',
      lifecycleStatus: 'finalizing',
      currentPrompt: 15,
      queueState: ''
    },
    {
      completedResponseText: makeStructuredV2Response('Alpha Corp'),
      completedResponseCapturedAt: 1775987605000
    }
  );

  assert.strictEqual(shouldFlush, true);

  const shouldFlushWindowClose = flushContext.shouldFlushProcessUpdateImmediately(
    {
      id: 'run-alpha',
      lifecycleStatus: 'completed',
      currentPrompt: 15,
      queueState: 'dispatch_pending'
    },
    {
      id: 'run-alpha',
      lifecycleStatus: 'completed',
      currentPrompt: 15,
      queueState: 'dispatch_pending'
    },
    {
      windowClose: {
        state: 'retrying',
        attemptCount: 1
      }
    }
  );

  assert.strictEqual(shouldFlushWindowClose, true);
}

function testCompletedPersistenceRetryAcceptsLegacyFinalizingSnapshot() {
  const retryContext = vm.createContext({
    console,
    ProcessContractUtils,
    normalizeWatchlistVerifyState(value) {
      return typeof value === 'string' ? value.trim().toLowerCase() : '';
    },
    extractAssistantTextFromProcess(process) {
      if (!process || typeof process !== 'object') return '';
      return typeof process.completedResponseText === 'string' ? process.completedResponseText : '';
    }
  });

  [
    'getCompletedProcessLocalSaveState',
    'hasCompletedProcessLocalSave',
    'getCompletedProcessFinalityState',
    'normalizeProcessLifecycleStatus',
    'normalizeProcessStatus',
    'resolveProcessStageSnapshot',
    'hasProcessReachedFinalStage',
    'isExplicitlyVerifiedDispatch',
    'getProcessPersistenceDispatchSnapshot',
    'getProcessQueueDeliveryState',
    'resolveCompletedProcessPersistenceRetryPlan'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), retryContext);
  });

  const plan = retryContext.resolveCompletedProcessPersistenceRetryPlan({
    id: 'run-alpha',
    status: 'finalizing',
    lifecycleStatus: 'finalizing',
    currentPrompt: 15,
    totalPrompts: 15,
    stageIndex: 14,
    completedResponseSaved: true,
    persistenceStatus: {
      saveOk: true,
      dispatch: {
        state: 'dispatch_pending',
        accepted: 1,
        sent: 1,
        failed: 0,
        deferred: 0,
        remaining: 0,
        verifyState: 'http_accepted'
      }
    }
  });

  assert.strictEqual(plan.needed, true);
  assert.strictEqual(plan.mode, 'flush');
  assert.strictEqual(plan.reason, 'dispatch_pending');
}

async function testProcessProgressCarriesCompletedResponsePayload() {
  const upsertCalls = [];
  const responseText = makeStructuredV2Response('Alpha Corp');
  const progressContext = vm.createContext({
    console,
    Date,
    Math,
    Number,
    String,
    Array,
    JSON,
    Map,
    resolveProcessId: async () => 'run-progress',
    normalizeProcessLifecycleStatus(value, fallback = 'running') {
      const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
      return normalized || fallback;
    },
    normalizeProcessActionRequired(value, fallback = 'none') {
      const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
      return normalized || fallback;
    },
    deriveProcessActionRequired() {
      return 'none';
    },
    resolveProcessConversationUrlFromMessage() {
      return 'https://chatgpt.com/c/progress';
    },
    ensureProcessRegistryReady: async () => {},
    processRegistry: new Map([
      ['run-progress', { id: 'run-progress', currentPrompt: 15, totalPrompts: 15 }]
    ]),
    applyChatGptComputationStatePatch(target, source) {
      if (!target || typeof target !== 'object' || !source || typeof source !== 'object') {
        return target;
      }
      if (typeof source.chatGptModeKind === 'string' && source.chatGptModeKind.trim()) {
        target.chatGptModeKind = source.chatGptModeKind.trim();
      }
      return target;
    },
    applyMonotonicProcessPatch(existing, patch) {
      return patch;
    },
    upsertProcess: async (runId, patch) => {
      upsertCalls.push({ runId, patch });
    }
  });

  vm.runInContext(extractFunctionSource(backgroundSource, 'handleProcessProgressMessage'), progressContext);

  const handled = await progressContext.handleProcessProgressMessage({
    lifecycleStatus: 'finalizing',
    phase: 'save_local',
    statusCode: 'storage.saving_local',
    responseId: 'resp-progress',
    completedResponseText: responseText,
    completedResponseLength: responseText.length,
    completedResponseCapturedAt: 1775987605000,
    completedResponseSaved: false
  }, null);

  assert.strictEqual(handled, true);
  assert.strictEqual(upsertCalls.length, 1);
  assert.strictEqual(upsertCalls[0].runId, 'run-progress');
  assert.strictEqual(upsertCalls[0].patch.responseId, 'resp-progress');
  assert.strictEqual(upsertCalls[0].patch.completedResponseText, responseText);
  assert.strictEqual(upsertCalls[0].patch.completedResponseLength, responseText.length);
  assert.strictEqual(upsertCalls[0].patch.completedResponseCapturedAt, 1775987605000);
  assert.strictEqual(upsertCalls[0].patch.completedResponseSaved, false);
  assert.strictEqual(upsertCalls[0].patch.chatGptModeKind, undefined);
}

async function main() {
  await testRequiresCompletedPayload();
  await testAcceptsCompletedPayloadEvenWhenPromptCountersLag();
  await testRejectsInvalidFinalContract();
  await testAcceptsStructuredV2FinalContract();
  await testFallsBackToCanonicalStorageWhenProcessPayloadMissing();
  testCriticalCompletedResponsePatchFlushesImmediately();
  testCompletedPersistenceRetryAcceptsLegacyFinalizingSnapshot();
  await testProcessProgressCarriesCompletedResponsePayload();
  console.log('test-final-response-persistence.js: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
