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
    PROMPTS_COMPANY: ['company prompt'],
    PROMPTS_PORTFOLIO: ['portfolio prompt'],
    CHAT_URL: 'https://chat.example',
    PORTFOLIO_CHAT_URL: 'https://chatgpt.com/g/g-p-69f5df201ec08191bdffe0376f17191e/project',
    processArticleCalls: [],
    sourceMaterialSubmissions: [],
    ensureCompanyPromptsReady: async () => true,
    ensurePortfolioPromptsReady: async () => true,
    normalizeRemoteExecutionMode: (value) => (value === 'remote' ? 'remote' : 'local'),
    getStoredRemoteExecutionMode: async () => 'local',
    getStoredSelectedRemoteRunnerId: async () => '',
    collectSupportedAnalysisTabs: async () => [
      { id: 1, title: 'Article 1', url: 'https://example.test/a' },
      { id: 2, title: 'Article 2', url: 'https://example.test/b' }
    ],
    processArticles: async (tabs, promptChain, chatUrl, analysisType, options) => {
      context.processArticleCalls.push({ tabs, promptChain, chatUrl, analysisType, options });
      return {
        success: true,
        queuedCount: tabs.length,
        queueSize: context.processArticleCalls.length,
        activeSlots: 1,
        reservedSlots: 1,
        liveSlots: 0,
        startingSlots: 0
      };
    },
    submitSourceMaterialForProcess: async (source, options) => {
      context.sourceMaterialSubmissions.push({ source, options });
      return {
        success: true,
        payload: {
          sourceMaterialId: 'srcmat:sha256:portfolio-test',
          sourceMaterialHash: 'sha256:portfolio-test',
          sourceMaterialLength: source?.text?.length || 0
        }
      };
    }
  };

  vm.createContext(context);
  [
    'normalizeAnalysisTypeForPromptChain',
    'getPromptChainForAnalysisType',
    'getChatUrlForAnalysisType',
    'shouldRunPortfolioAlongsideCompany',
    'getAnalysisLaunchQueuedCount',
    'pickAnalysisLaunchMetric',
    'mergeAnalysisLaunchResults',
    'sanitizeManualTextSourceId',
    'generateManualTextSourceId',
    'sanitizeManualTextSourceRecord',
    'buildManualTextSourceRecord',
    'normalizeManualInstances',
    'normalizeSourceMaterialLength',
    'normalizeSourceMaterialSubmitFailure',
    'reportManualSourceMaterialSaveEvent',
    'submitManualSourceMaterialForQueue',
    'runManualSourceAnalysis',
    'runManualSourceAnalysisWithPortfolio',
    'runAnalysis'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
      filename: 'background.js'
    });
  });
  return context;
}

async function testPopupRunQueuesPortfolioAutomatically() {
  const context = buildContext();
  const result = await context.runAnalysis({ remote: false });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.queuedCount, 4);
  assert.strictEqual(result.companyQueuedCount, 2);
  assert.strictEqual(result.portfolioQueuedCount, 2);
  assert.strictEqual(result.extraPortfolioQueued, true);
  assert.strictEqual(context.processArticleCalls.length, 2);
  assert.strictEqual(context.processArticleCalls[0].analysisType, 'company');
  assert.strictEqual(context.processArticleCalls[0].chatUrl, 'https://chat.example');
  assert.deepStrictEqual(context.processArticleCalls[0].promptChain, ['company prompt']);
  assert.strictEqual(context.processArticleCalls[0].options.reason, 'run_analysis_enqueue');
  assert.strictEqual(context.processArticleCalls[1].analysisType, 'portfolio');
  assert.strictEqual(
    context.processArticleCalls[1].chatUrl,
    'https://chatgpt.com/g/g-p-69f5df201ec08191bdffe0376f17191e/project'
  );
  assert.deepStrictEqual(context.processArticleCalls[1].promptChain, ['portfolio prompt']);
  assert.strictEqual(context.processArticleCalls[1].options.reason, 'run_analysis_portfolio_enqueue');
}

async function testManualTextSharesOneSourceAcrossCompanyAndPortfolio() {
  const context = buildContext();
  const sourceText = 'A'.repeat(10000);
  const result = await context.runManualSourceAnalysisWithPortfolio(sourceText, 'Manual source', 5, 'company');

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.queuedCount, 6);
  assert.strictEqual(result.companyQueuedCount, 5);
  assert.strictEqual(result.portfolioQueuedCount, 1);
  assert.strictEqual(result.extraPortfolioQueued, true);
  assert.strictEqual(context.sourceMaterialSubmissions.length, 1);
  assert.strictEqual(context.sourceMaterialSubmissions[0].source.text, sourceText);
  assert.strictEqual(context.sourceMaterialSubmissions[0].source.processKind, 'manual_source_enqueue');
  assert.strictEqual(context.processArticleCalls.length, 2);

  const companyCall = context.processArticleCalls[0];
  const portfolioCall = context.processArticleCalls[1];
  assert.strictEqual(companyCall.analysisType, 'company');
  assert.strictEqual(portfolioCall.analysisType, 'portfolio');
  assert.strictEqual(companyCall.chatUrl, 'https://chat.example');
  assert.strictEqual(
    portfolioCall.chatUrl,
    'https://chatgpt.com/g/g-p-69f5df201ec08191bdffe0376f17191e/project'
  );
  assert.strictEqual(companyCall.tabs.length, 5);
  assert.strictEqual(portfolioCall.tabs.length, 1);
  assert.strictEqual(companyCall.options.manualTextSources.length, 1);
  assert.strictEqual(portfolioCall.options.manualTextSources.length, 1);
  assert.strictEqual(companyCall.options.manualTextSources[0].text, sourceText);
  assert.strictEqual(companyCall.tabs[0].sourceMaterialId, 'srcmat:sha256:portfolio-test');
  assert.strictEqual(portfolioCall.tabs[0].sourceMaterialId, 'srcmat:sha256:portfolio-test');
  assert.strictEqual(companyCall.tabs[0].sourceMaterialNeedsProcessLink, true);
  assert.strictEqual(portfolioCall.tabs[0].sourceMaterialNeedsProcessLink, true);
  assert.strictEqual(
    companyCall.options.manualTextSources[0].id,
    portfolioCall.options.manualTextSources[0].id
  );
  assert.strictEqual(
    companyCall.tabs[0].manualTextSourceId,
    portfolioCall.tabs[0].manualTextSourceId
  );
  assert.strictEqual(Object.prototype.hasOwnProperty.call(companyCall.tabs[0], 'manualText'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(portfolioCall.tabs[0], 'manualText'), false);
}

async function testManualPortfolioOnlyQueuesOnePortfolioProcess() {
  const context = buildContext();
  const sourceText = 'P'.repeat(10000);
  const result = await context.runManualSourceAnalysis(sourceText, 'Manual portfolio', 5, 'portfolio');

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.queuedCount, 1);
  assert.strictEqual(context.sourceMaterialSubmissions.length, 1);
  assert.strictEqual(context.sourceMaterialSubmissions[0].source.metadata.analysis_type, 'portfolio');
  assert.strictEqual(context.sourceMaterialSubmissions[0].source.metadata.requested_instances, 1);
  assert.strictEqual(context.sourceMaterialSubmissions[0].source.metadata.includes_portfolio, false);
  assert.strictEqual(context.processArticleCalls.length, 1);
  assert.strictEqual(context.processArticleCalls[0].analysisType, 'portfolio');
  assert.strictEqual(
    context.processArticleCalls[0].chatUrl,
    'https://chatgpt.com/g/g-p-69f5df201ec08191bdffe0376f17191e/project'
  );
  assert.deepStrictEqual(context.processArticleCalls[0].promptChain, ['portfolio prompt']);
  assert.strictEqual(context.processArticleCalls[0].tabs.length, 1);
}

function testManualSourceShowsSinglePortfolioActionWithoutModeToggle() {
  const popupHtml = fs.readFileSync(path.join(__dirname, 'popup.html'), 'utf8');
  const manualSourceHtml = fs.readFileSync(path.join(__dirname, 'manual-source.html'), 'utf8');
  const manualSourceJs = fs.readFileSync(path.join(__dirname, 'manual-source.js'), 'utf8');
  const popupJs = fs.readFileSync(path.join(__dirname, 'popup.js'), 'utf8');

  assert.strictEqual(popupHtml.includes('portfolioSourceBtn'), false);
  assert.strictEqual(manualSourceHtml.includes('analysisModePortfolioInput'), false);
  assert.strictEqual(manualSourceHtml.includes('portfolioAddonInput'), false);
  assert.strictEqual(manualSourceHtml.includes('analysis-mode'), false);
  assert.strictEqual(manualSourceHtml.includes('portfolioOnlyBtn'), true);
  assert.strictEqual(manualSourceHtml.includes('Uruchom tylko portfolio'), true);
  assert.strictEqual(manualSourceJs.includes('analysisModeCompanyInput'), false);
  assert.strictEqual(manualSourceJs.includes('includePortfolioAnalysis'), false);
  assert.strictEqual(manualSourceJs.includes('getSelectedAnalysisType'), false);
  assert.strictEqual(popupJs.includes('options.analysisType'), false);
  assert.strictEqual(manualSourceHtml.includes('Uruchom zestaw promptow'), true);
  assert.strictEqual(manualSourceJs.includes('analysisType: normalizedLaunchType'), true);
  assert.strictEqual(manualSourceJs.includes('PORTFOLIO_ONLY_LOCAL_LABEL'), true);
}

function testPortfolioPromptChainHasFourPrompts() {
  const promptText = fs.readFileSync(path.join(__dirname, 'prompts-portfolio.txt'), 'utf8');
  const separator = /^\s*(?:◄\s*PROMPT_SEPARATOR\s*►|---\s*PROMPT\s*SEPARATOR\s*---)\s*$/gim;
  const prompts = promptText.split(separator).map((item) => item.trim()).filter(Boolean);

  assert.strictEqual(prompts.length, 4);
  assert.ok(prompts[0].includes('{{article}}'));
  assert.ok(prompts[0].includes('Ranking warstw value chain'));
  assert.ok(prompts[1].includes('PORTFOLIO_REFLECTION_REPORT'));
  assert.ok(prompts[1].includes('account.positions.analysis_context'));
  assert.ok(prompts[1].includes('include_context_text'));
  assert.ok(prompts[1].includes('nie używaj broker.positions.list({})'));
  assert.ok(prompts[1].includes('nie używaj list_resources'));
  assert.ok(prompts[1].includes('Nie generuj jeszcze konkretnych zleceń, Take Profit ani Stop Loss'));
  assert.ok(!prompts[1].includes('mcp__codex_apps__iskierka._stage12_research_rows_upsert'));
  assert.ok(prompts[2].includes('Finalny sizing, TP/SL i zapis feedbacku przez MCP'));
  assert.ok(prompts[2].includes('portfolio.feedback.submit'));
  assert.ok(prompts[2].includes('portfolio.feedback.sizing_monitor'));
  assert.ok(prompts[2].includes('stop_loss_price'));
  assert.ok(prompts[2].includes('take_profit_price'));
  assert.ok(prompts[3].includes('Wykonawczy przelicznik akcji i zapis draft planu'));
  assert.ok(prompts[3].includes('qty_change'));
  assert.ok(prompts[3].includes('action_plan'));
  assert.ok(prompts[3].includes('portfolio.feedback.submit'));
  assert.ok(prompts[3].includes('portfolio.feedback.sizing_monitor'));
}

async function main() {
  await testPopupRunQueuesPortfolioAutomatically();
  await testManualTextSharesOneSourceAcrossCompanyAndPortfolio();
  await testManualPortfolioOnlyQueuesOnePortfolioProcess();
  testManualSourceShowsSinglePortfolioActionWithoutModeToggle();
  testPortfolioPromptChainHasFourPrompts();
  console.log('portfolio auto company test: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
