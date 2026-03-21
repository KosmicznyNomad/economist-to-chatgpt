const assert = require('assert');

const DecisionContractUtils = require('./decision-contract.js');
const ResponseStorageUtils = require('./response-storage.js');

function createStorageArea(initialState = {}) {
  const state = JSON.parse(JSON.stringify(initialState));
  return {
    async get(keys) {
      const result = {};
      keys.forEach((key) => {
        result[key] = state[key];
      });
      return result;
    },
    async set(patch) {
      Object.keys(patch).forEach((key) => {
        state[key] = JSON.parse(JSON.stringify(patch[key]));
      });
    },
    async remove(keys) {
      keys.forEach((key) => {
        delete state[key];
      });
    },
    snapshot() {
      return JSON.parse(JSON.stringify(state));
    }
  };
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

function makeCompanyResponse(overrides = {}) {
  return {
    text: makeCurrent16Line('PRIMARY', 'Alpha Corp'),
    timestamp: 1_710_000_000_000,
    source: 'Alpha source',
    analysisType: 'company',
    responseId: 'resp-1',
    runId: 'run-1',
    ...overrides
  };
}

async function testResponseIdDedupe() {
  const merged = ResponseStorageUtils.mergeResponseCollections([
    makeCompanyResponse({ timestamp: 1_710_000_000_000 })
  ], [
    makeCompanyResponse({ timestamp: 1_710_000_100_000, sourceUrl: 'https://example.test/a' })
  ], DecisionContractUtils);

  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].timestamp, 1_710_000_100_000);
  assert.strictEqual(merged[0].sourceUrl, 'https://example.test/a');
  assert.strictEqual(merged[0].decisionContract.status, 'invalid');
}

async function testLocalSessionMergePrefersRicherRecord() {
  const local = createStorageArea({
    responses: [makeCompanyResponse({ sourceTitle: 'Alpha', conversationUrl: 'https://chatgpt.com/c/1' })]
  });
  const session = createStorageArea({
    responses: [makeCompanyResponse({ sourceTitle: '', sourceName: 'Economist' })]
  });

  const merged = await ResponseStorageUtils.readCanonicalResponses({ local, session }, DecisionContractUtils);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].sourceTitle, 'Alpha');
  assert.strictEqual(merged[0].sourceName, 'Economist');
  assert.strictEqual(merged[0].conversationUrl, 'https://chatgpt.com/c/1');
}

async function testFallbackDedupeWithoutResponseId() {
  const responseA = makeCompanyResponse({
    responseId: '',
    timestamp: 1_710_000_000_000,
    text: makeCurrent16Line('PRIMARY', 'Fallback Corp')
  });
  const responseB = makeCompanyResponse({
    responseId: '',
    timestamp: 1_710_000_050_000,
    text: ` ${makeCurrent16Line('PRIMARY', 'Fallback Corp')} `,
    sourceUrl: 'https://example.test/fallback'
  });

  const merged = ResponseStorageUtils.mergeResponseCollections([responseA], [responseB], DecisionContractUtils);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].sourceUrl, 'https://example.test/fallback');
}

async function testCanonicalUpsertConvergesNormalAndEmergencyPaths() {
  const local = createStorageArea();
  const session = createStorageArea();
  const storage = { local, session };

  await ResponseStorageUtils.upsertCanonicalResponse(
    makeCompanyResponse({ responseId: 'resp-converge', runId: 'run-converge' }),
    storage,
    DecisionContractUtils,
    { clearSession: true }
  );
  await ResponseStorageUtils.upsertCanonicalResponse(
    makeCompanyResponse({
      responseId: 'resp-converge',
      runId: 'run-converge',
      timestamp: 1_710_000_500_000,
      conversationUrl: 'https://chatgpt.com/c/converge'
    }),
    storage,
    DecisionContractUtils,
    { clearSession: true }
  );

  const merged = await ResponseStorageUtils.readCanonicalResponses(storage, DecisionContractUtils);
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].conversationUrl, 'https://chatgpt.com/c/converge');
  assert.strictEqual(merged[0].timestamp, 1_710_000_500_000);
}

async function testSessionMigrationWithoutUi() {
  const local = createStorageArea();
  const session = createStorageArea({
    responses: [makeCompanyResponse({ responseId: 'resp-migrate', runId: 'run-migrate' })]
  });
  const result = await ResponseStorageUtils.migrateLegacyResponseStorage(
    { local, session },
    DecisionContractUtils,
    { clearSession: true }
  );

  const localState = local.snapshot();
  const sessionState = session.snapshot();
  assert.strictEqual(result.responses.length, 1);
  assert.strictEqual(localState.responses.length, 1);
  assert.strictEqual(localState.responses[0].responseId, 'resp-migrate');
  assert.ok(localState.responses[0].decisionContract);
  assert.strictEqual(sessionState.responses, undefined);
}

async function main() {
  await testResponseIdDedupe();
  await testLocalSessionMergePrefersRicherRecord();
  await testFallbackDedupeWithoutResponseId();
  await testCanonicalUpsertConvergesNormalAndEmergencyPaths();
  await testSessionMigrationWithoutUi();
  console.log('test-response-storage.js: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
