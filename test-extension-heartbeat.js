const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const backgroundPath = path.join(__dirname, 'background.js');
const backgroundSource = fs.readFileSync(backgroundPath, 'utf8');

function extractFunctionSource(source, functionName) {
  const pattern = new RegExp(`(?:async\\s+)?function\\s+${functionName}\\s*\\(`);
  const match = pattern.exec(source);
  if (!match) {
    throw new Error(`Function not found: ${functionName}`);
  }
  const startIndex = match.index;
  const paramsStart = source.indexOf('(', match.index);
  if (paramsStart < 0) {
    throw new Error(`Function params not found: ${functionName}`);
  }

  let parenDepth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;
  let braceStart = -1;

  for (let i = paramsStart; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
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
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
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
        braceStart = source.indexOf('{', i);
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

  for (let i = braceStart; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
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
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
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
        return source.slice(startIndex, i + 1);
      }
    }
  }

  throw new Error(`Function end not found: ${functionName}`);
}

function buildContext() {
  const stored = {};
  const context = {
    console,
    Date,
    Math,
    Object,
    Promise,
    ANALYSIS_QUEUE_MAX_CONCURRENT: 7,
    ANALYSIS_TYPE_COMPANY: 'company',
    CHAT_URL: 'https://chatgpt.com/company',
    EXTENSION_FEATURE_REVISION: 'source-materials-heartbeat-v1',
    EXTENSION_HEARTBEAT_STORAGE_KEY: 'iskra_extension_heartbeat',
    EXTENSION_SERVICE_WORKER_STARTED_AT: Date.now() - 1000,
    PORTFOLIO_CHAT_URL: 'https://chatgpt.com/g/g-p-69f5df201ec08191bdffe0376f17191e/project',
    PROMPTS_COMPANY: ['company prompt'],
    PROMPTS_PORTFOLIO: ['portfolio prompt'],
    SOURCE_MATERIALS_API_PATH: '/api/v1/source-materials',
    ProcessContractUtils: { loaded: true },
    DecisionContractUtils: { loaded: true },
    ResponseStorageUtils: { loaded: true },
    WatchlistDispatchShapeUtils: { loaded: true },
    WatchlistApiUtils: { buildSignedJsonRequest: async () => ({}) },
    chrome: {
      runtime: {
        id: 'extension-id',
        getManifest: () => ({ name: 'Iskra', version: '1.2.3' })
      },
      storage: {
        local: {
          set: async (payload) => {
            Object.assign(stored, payload);
          }
        }
      }
    },
    ensureExtensionInstallationId: async () => 'ext-test-support',
    getAnalysisQueueStatusSnapshot: async () => ({
      success: true,
      maxConcurrent: 7,
      activeSlots: 1,
      queueSize: 2,
      waitingJobs: 2,
      totalJobs: 3
    }),
    getWatchlistDispatchStatus: async () => ({
      enabled: true,
      configured: true,
      hasToken: true,
      tokenSource: 'inline_config',
      intakeUrl: 'https://iskierka-watchlist.duckdns.org/api/v1/intake/economist-response',
      keyId: 'extension-primary',
      queueSize: 0,
      supportId: 'ext-test-support'
    }),
    performSignedIskraApiRequest: async () => ({ success: true }),
    shouldRunPortfolioAlongsideCompany: () => true,
    submitManualSourceMaterialForQueue: async () => ({ success: true }),
    submitSourceMaterialForProcess: async () => ({ success: true }),
    stored
  };
  vm.createContext(context);
  [
    'buildExtensionHeartbeatCheck',
    'sanitizeExtensionHeartbeatWatchlistStatus',
    'sanitizeExtensionHeartbeatQueueStatus',
    'persistExtensionHeartbeatStatus',
    'buildExtensionHeartbeatStatus'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
      filename: 'background.js'
    });
  });
  return context;
}

async function main() {
  const context = buildContext();
  const heartbeat = await context.buildExtensionHeartbeatStatus({ forceReload: true });

  assert.strictEqual(heartbeat.success, true);
  assert.strictEqual(heartbeat.ok, true);
  assert.strictEqual(heartbeat.readyForDb, true);
  assert.strictEqual(heartbeat.featureRevision, 'source-materials-heartbeat-v1');
  assert.strictEqual(heartbeat.features.sourceMaterialsSubmitFunction, true);
  assert.strictEqual(heartbeat.features.manualSourceQueueSubmitFunction, true);
  assert.strictEqual(heartbeat.features.manualSourceFailClosed, true);
  assert.strictEqual(heartbeat.features.portfolioAutoCompany, true);
  assert.strictEqual(heartbeat.prompts.companyCount, 1);
  assert.strictEqual(heartbeat.prompts.portfolioCount, 1);
  assert.strictEqual(heartbeat.watchlist.ready, true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(heartbeat.watchlist, 'secret'), false);
  assert.ok(context.stored.iskra_extension_heartbeat);

  context.getWatchlistDispatchStatus = async () => ({
    enabled: true,
    configured: false,
    hasToken: false,
    reason: 'missing_dispatch_credentials'
  });
  const notReady = await context.buildExtensionHeartbeatStatus({ forceReload: true });
  assert.strictEqual(notReady.ok, false);
  assert.strictEqual(notReady.readyForDb, false);
  assert.ok(notReady.checks.some((check) => check.name === 'watchlist_dispatch_configured' && check.ok === false));

  console.log('extension heartbeat test: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
