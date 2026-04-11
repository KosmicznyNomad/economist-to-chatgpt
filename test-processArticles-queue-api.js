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
    ANALYSIS_QUEUE_KIND_ARTICLE: 'article_analysis',
    captured: null,
    getAnalysisQueueStatusSnapshot: async () => ({
      success: true,
      queuedCount: 0,
      maxConcurrent: 8,
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
        maxConcurrent: 8,
        queueSize: jobs.length,
        activeSlots: 1,
        reservedSlots: 2,
        liveSlots: 1,
        startingSlots: 1
      };
    }
  };

  vm.createContext(context);
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
  assert.strictEqual(result.maxConcurrent, 8);
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
    manualPdfProviderId: 'provider-1'
  });

  assert.strictEqual(result.maxConcurrent, 8);
  assert.strictEqual(result.queuedCount, 2);
  assert.ok(context.captured, 'enqueueAnalysisJobs should be called');
  assert.strictEqual(context.captured.options.reason, 'process_articles_enqueue');
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
    queueBatchId: 'batch-1',
    manualPdfBatchId: 'pdf-batch-1',
    manualPdfProviderId: 'provider-1'
  });
}

async function main() {
  await testReturnsQueueSnapshotForEmptyInput();
  await testBuildsQueueJobsInsteadOfDirectExecution();
  console.log('processArticles queue api test: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
