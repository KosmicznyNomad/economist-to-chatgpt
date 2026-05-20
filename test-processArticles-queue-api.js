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
  const context = {
    console,
    Date,
    Math,
    ANALYSIS_QUEUE_KIND_ARTICLE: 'article_analysis',
    ANALYSIS_TYPE_COMPANY: 'company',
    ANALYSIS_TYPE_PORTFOLIO: 'portfolio',
    captured: null,
    launched: [],
    getAnalysisQueueStatusSnapshot: async () => ({
      success: true,
      queuedCount: 0,
      maxConcurrent: 7,
      queueSize: 0,
      activeSlots: 0,
      reservedSlots: 0,
      liveSlots: 0,
      startingSlots: 0
    }),
    enqueueAnalysisJobs: async (jobs, options) => {
      context.captured = { jobs, options };
      return {
        success: true,
        jobs,
        queuedCount: jobs.length,
        maxConcurrent: 7,
        queueSize: jobs.length,
        activeSlots: 1,
        reservedSlots: 2,
        liveSlots: 1,
        startingSlots: 1
      };
    },
    sanitizePromptChainSnapshot: (promptChain) => Array.isArray(promptChain)
      ? promptChain.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
      : [],
    sleep: async () => undefined,
    executeAnalysisProcessJob: async (tab, promptChain, chatUrl, analysisType, options) => {
      context.launched.push({ tab, promptChain, chatUrl, analysisType, options });
      return { success: true };
    },
    upsertProcess: async () => true
  };

  vm.createContext(context);
  [
    'normalizeAnalysisTypeForPromptChain',
    'sanitizeManualTextSourceId',
    'sanitizeManualTextSourceRecord',
    'sanitizeManualTextSourceRecords',
    'shouldBypassAnalysisQueueForAnalysisType',
    'findManualTextSourceForQueueBypass',
    'hydrateManualTextForQueueBypass',
    'generateAnalysisQueueBypassRunId',
    'launchAnalysisJobsOutsideQueue'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
      filename: 'background.js'
    });
  });
  vm.runInContext(extractFunctionSource(backgroundSource, 'normalizeSourceMaterialLength'), context, {
    filename: 'background.js'
  });
  vm.runInContext(extractFunctionSource(backgroundSource, 'processArticles'), context, {
    filename: 'background.js'
  });
  return context;
}

function toPlainJson(value) {
  return JSON.parse(JSON.stringify(value));
}

async function testReturnsQueueSnapshotForEmptyInput() {
  const context = buildContext();
  const result = await context.processArticles([], [], '', 'company');
  assert.strictEqual(result.maxConcurrent, 7);
  assert.strictEqual(result.queuedCount, 0);
  assert.strictEqual(context.captured, null);
}

async function testBuildsQueueJobsInsteadOfDirectExecution() {
  const context = buildContext();
  const tabs = [
    { id: 1, title: 'Manual text', url: 'manual://source' },
    { id: 2, title: 'Manual pdf', url: 'manual://pdf', windowId: 9 }
  ];

  const result = await context.processArticles(tabs, ['p1'], 'https://chat.example', 'company', {
    invocationWindowId: 44,
    queueBatchId: 'batch-1',
    manualPdfBatchId: 'pdf-batch-1',
    manualPdfProviderId: 'provider-1',
    manualTextSources: [{ id: 'manual-src-1', text: 'manual source body' }]
  });

  assert.strictEqual(result.maxConcurrent, 7);
  assert.strictEqual(result.queuedCount, 2);
  assert.ok(context.captured, 'enqueueAnalysisJobs should be called');
  assert.strictEqual(context.captured.options.reason, 'process_articles_enqueue');
  assert.deepStrictEqual(context.captured.options.manualTextSources, [
    { id: 'manual-src-1', text: 'manual source body' }
  ]);
  assert.strictEqual(context.captured.jobs.length, 2);
  assert.deepStrictEqual(toPlainJson(context.captured.jobs[0]), {
    kind: 'article_analysis',
    analysisType: 'company',
    title: 'Manual text',
    sourceKind: 'manual_text',
    tabSnapshot: tabs[0],
    invocationWindowId: 44,
    sourceWindowId: null,
    sourceUrl: 'manual://source',
    chatUrl: 'https://chat.example',
    promptChainSnapshot: ['p1'],
    queueBatchId: 'batch-1',
    manualPdfBatchId: 'pdf-batch-1',
    manualPdfProviderId: 'provider-1'
  });
  assert.deepStrictEqual(toPlainJson(context.captured.jobs[1]), {
    kind: 'article_analysis',
    analysisType: 'company',
    title: 'Manual pdf',
    sourceKind: 'manual_pdf',
    tabSnapshot: tabs[1],
    invocationWindowId: 44,
    sourceWindowId: 9,
    sourceUrl: 'manual://pdf',
    chatUrl: 'https://chat.example',
    promptChainSnapshot: ['p1'],
    queueBatchId: 'batch-1',
    manualPdfBatchId: 'pdf-batch-1',
    manualPdfProviderId: 'provider-1'
  });
}

async function testPortfolioBypassesQueueSlots() {
  const context = buildContext();
  const tabs = [
    { id: 'manual-portfolio-1', title: 'Portfolio text', url: 'manual://source', manualTextSourceId: 'manual-src-1' }
  ];

  const result = await context.processArticles(tabs, ['p1'], 'https://portfolio.example', 'portfolio', {
    invocationWindowId: 44,
    manualTextSources: [{ id: 'manual-src-1', text: 'portfolio body' }],
    reason: 'portfolio_direct_test'
  });

  assert.strictEqual(result.queuedCount, 0);
  assert.strictEqual(result.launchedCount, 1);
  assert.strictEqual(result.queueBypassCount, 1);
  assert.strictEqual(result.queueBypass, true);
  assert.strictEqual(context.captured, null, 'Portfolio process should not be enqueued.');
  assert.strictEqual(context.launched.length, 1);
  assert.strictEqual(context.launched[0].analysisType, 'portfolio');
  assert.strictEqual(context.launched[0].chatUrl, 'https://portfolio.example');
  assert.deepStrictEqual(context.launched[0].promptChain, ['p1']);
  assert.strictEqual(context.launched[0].options.queueBypass, true);
  assert.strictEqual(context.launched[0].options.queueBypassReason, 'portfolio_direct_test');
  assert.strictEqual(context.launched[0].tab.manualText, 'portfolio body');
}

async function main() {
  await testReturnsQueueSnapshotForEmptyInput();
  await testBuildsQueueJobsInsteadOfDirectExecution();
  await testPortfolioBypassesQueueSlots();
  console.log('processArticles queue api test: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
