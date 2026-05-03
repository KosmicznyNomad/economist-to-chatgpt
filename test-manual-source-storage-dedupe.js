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
    ANALYSIS_TYPE_COMPANY: 'company',
    ANALYSIS_TYPE_PORTFOLIO: 'portfolio',
    PROMPTS_COMPANY: ['prompt'],
    PROMPTS_PORTFOLIO: ['portfolio prompt'],
    CHAT_URL: 'https://chat.example',
    PORTFOLIO_CHAT_URL: 'https://chatgpt.com/g/g-p-69f5df201ec08191bdffe0376f17191e/project',
    captured: null,
    sourceMaterialSubmissions: [],
    normalizeAnalysisTypeForPromptChain: (value) => {
      const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
      return normalized === 'portfolio' || normalized === 'portfolio_analysis' ? 'portfolio' : 'company';
    },
    getPromptChainForAnalysisType: (analysisType) => {
      const normalized = typeof analysisType === 'string' ? analysisType.trim().toLowerCase() : '';
      return normalized === 'portfolio' ? ['portfolio prompt'] : ['prompt'];
    },
    getChatUrlForAnalysisType: (analysisType) => {
      const normalized = typeof analysisType === 'string' ? analysisType.trim().toLowerCase() : '';
      return normalized === 'portfolio'
        ? 'https://chatgpt.com/g/g-p-69f5df201ec08191bdffe0376f17191e/project'
        : 'https://chat.example';
    },
    processArticles: async (tabs, promptChain, chatUrl, analysisType, options) => {
      context.captured = { tabs, promptChain, chatUrl, analysisType, options };
      return {
        success: true,
        queuedCount: tabs.length,
        queueSize: tabs.length
      };
    },
    submitSourceMaterialForProcess: async (source, options) => {
      context.sourceMaterialSubmissions.push({ source, options });
      return {
        success: true,
        payload: {
          sourceMaterialId: 'srcmat:sha256:test',
          sourceMaterialHash: 'sha256:test',
          sourceMaterialLength: source?.text?.length || 0
        }
      };
    }
  };

  vm.createContext(context);
  [
    'sanitizeManualTextSourceId',
    'generateManualTextSourceId',
    'sanitizeManualTextSourceRecord',
    'buildManualTextSourceRecord',
    'sanitizeManualTextSourceRecords',
    'collectManualTextSourceIdsFromJobs',
    'pruneManualTextSourcesForJobs',
    'mergeManualTextSourceRecords',
    'compactManualTextSnapshotsForQueueState',
    'normalizeManualInstances',
    'normalizeSourceMaterialLength',
    'normalizeSourceMaterialSubmitFailure',
    'reportManualSourceMaterialSaveEvent',
    'submitManualSourceMaterialForQueue',
    'runManualSourceAnalysis'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
      filename: 'background.js'
    });
  });
  return context;
}

async function main() {
  const context = buildContext();
  const sourceText = 'A'.repeat(50000);
  const result = await context.runManualSourceAnalysis(sourceText, 'Manual large source', 20);

  assert.strictEqual(result.queuedCount, 20);
  assert.strictEqual(context.sourceMaterialSubmissions.length, 1);
  assert.strictEqual(context.sourceMaterialSubmissions[0].source.text, sourceText);
  assert.strictEqual(context.sourceMaterialSubmissions[0].source.processKind, 'manual_source_enqueue');
  assert.ok(context.captured, 'processArticles should be called');
  assert.strictEqual(context.captured.tabs.length, 20);
  assert.strictEqual(context.captured.options.manualTextSources.length, 1);
  assert.strictEqual(context.captured.options.manualTextSources[0].text, sourceText);
  assert.ok(context.captured.options.manualTextSources[0].id.startsWith('manual-text-'));

  const sourceId = context.captured.options.manualTextSources[0].id;
  context.captured.tabs.forEach((tab) => {
    assert.strictEqual(tab.manualTextSourceId, sourceId);
    assert.strictEqual(tab.sourceMaterialId, 'srcmat:sha256:test');
    assert.strictEqual(tab.sourceMaterialHash, 'sha256:test');
    assert.strictEqual(tab.sourceMaterialLength, sourceText.length);
    assert.strictEqual(tab.sourceMaterialStored, true);
    assert.strictEqual(tab.sourceMaterialNeedsProcessLink, true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(tab, 'manualText'), false);
  });

  const serializedTabs = JSON.stringify(context.captured.tabs);
  assert.ok(
    serializedTabs.length < sourceText.length,
    'queued tab snapshots should not duplicate the full manual text'
  );

  const portfolioResult = await context.runManualSourceAnalysis(sourceText, 'Manual portfolio source', 20, 'portfolio');
  assert.strictEqual(portfolioResult.queuedCount, 1);
  assert.strictEqual(context.sourceMaterialSubmissions.length, 2);
  assert.strictEqual(context.captured.tabs.length, 1);
  assert.strictEqual(context.captured.analysisType, 'portfolio');
  assert.strictEqual(context.captured.tabs[0].sourceMaterialId, 'srcmat:sha256:test');
  assert.strictEqual(
    context.captured.chatUrl,
    'https://chatgpt.com/g/g-p-69f5df201ec08191bdffe0376f17191e/project'
  );
  assert.deepStrictEqual(context.captured.promptChain, ['portfolio prompt']);

  const migrated = context.compactManualTextSnapshotsForQueueState([
    {
      jobId: 'job-1',
      runId: 'run-1',
      title: 'Migrated source 1',
      tabSnapshot: {
        id: 'manual-1',
        title: 'Migrated source 1',
        url: 'manual://source',
        manualText: sourceText
      }
    },
    {
      jobId: 'job-2',
      runId: 'run-2',
      title: 'Migrated source 2',
      tabSnapshot: {
        id: 'manual-2',
        title: 'Migrated source 2',
        url: 'manual://source',
        manualText: sourceText
      }
    }
  ], [], []);

  assert.strictEqual(migrated.manualTextSources.length, 1);
  assert.strictEqual(migrated.manualTextSources[0].text, sourceText);
  assert.strictEqual(migrated.waitingJobs[0].tabSnapshot.manualText, undefined);
  assert.strictEqual(migrated.waitingJobs[1].tabSnapshot.manualText, undefined);
  assert.strictEqual(
    migrated.waitingJobs[0].tabSnapshot.manualTextSourceId,
    migrated.waitingJobs[1].tabSnapshot.manualTextSourceId
  );

  console.log('manual source storage dedupe test: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
