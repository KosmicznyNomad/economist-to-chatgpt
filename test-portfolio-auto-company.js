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
    SOURCE_TEXT_PLACEHOLDER_REGEX: /\{\{\s*(?:articlecontent|article)\s*\}\}/gi,
    PROMPTS_COMPANY: ['company prompt'],
    PROMPTS_PORTFOLIO: ['portfolio prompt'],
    CHAT_URL: 'https://chat.example',
    PORTFOLIO_CHAT_URL: 'https://chatgpt.com/g/g-p-69f5df201ec08191bdffe0376f17191e/project',
    processArticleCalls: [],
    sourceMaterialSubmissions: [],
    ensureCompanyPromptsReady: async () => true,
    ensurePortfolioPromptsReady: async () => true,
    ensurePromptChainReadyForAnalysisType: async () => true,
    normalizeRemoteExecutionMode: (value) => (value === 'remote' ? 'remote' : 'local'),
    getStoredRemoteExecutionMode: async () => 'local',
    getStoredSelectedRemoteRunnerId: async () => '',
    collectSupportedAnalysisTabs: async () => [
      { id: 1, title: 'Article 1', url: 'https://example.test/a' },
      { id: 2, title: 'Article 2', url: 'https://example.test/b' }
    ],
    processArticles: async (tabs, promptChain, chatUrl, analysisType, options) => {
      context.processArticleCalls.push({ tabs, promptChain, chatUrl, analysisType, options });
      const isPortfolio = analysisType === 'portfolio';
      return {
        success: true,
        queuedCount: isPortfolio ? 0 : tabs.length,
        launchedCount: isPortfolio ? tabs.length : 0,
        queueBypassCount: isPortfolio ? tabs.length : 0,
        queueBypass: isPortfolio,
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
    'getPortfolioPromptSnapshotStatus',
    'getChatUrlForAnalysisType',
    'shouldRunPortfolioAlongsideCompany',
    'getAnalysisLaunchQueuedCount',
    'getAnalysisLaunchBypassCount',
    'pickAnalysisLaunchMetric',
    'mergeAnalysisLaunchResults',
    'sanitizeManualTextSourceId',
    'generateManualTextSourceId',
    'sanitizeManualTextSourceRecord',
    'buildManualTextSourceRecord',
    'normalizeManualInstances',
    'normalizeSourceMaterialLength',
    'normalizeSourceMaterialSubmitFailure',
    'injectSourceTextIntoPromptTemplate',
    'removeSourceTextPlaceholdersFromPromptTemplate',
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
  assert.strictEqual(result.queuedCount, 2);
  assert.strictEqual(result.companyQueuedCount, 2);
  assert.strictEqual(result.portfolioQueuedCount, 0);
  assert.strictEqual(result.portfolioLaunchedCount, 2);
  assert.strictEqual(result.extraPortfolioQueued, false);
  assert.strictEqual(result.extraPortfolioLaunched, true);
  assert.strictEqual(result.extraPortfolioStarted, true);
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
  assert.strictEqual(result.queuedCount, 5);
  assert.strictEqual(result.companyQueuedCount, 5);
  assert.strictEqual(result.portfolioQueuedCount, 0);
  assert.strictEqual(result.portfolioLaunchedCount, 1);
  assert.strictEqual(result.extraPortfolioQueued, false);
  assert.strictEqual(result.extraPortfolioLaunched, true);
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
  assert.strictEqual(result.queuedCount, 0);
  assert.strictEqual(result.launchedCount, 1);
  assert.strictEqual(result.queueBypassCount, 1);
  assert.strictEqual(result.queueBypass, true);
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

function testSourceTextPlaceholderInjectionSupportsPortfolioArticleAlias() {
  const context = buildContext();
  const sourceText = 'Tekst artykulu do analizy';

  assert.strictEqual(
    context.injectSourceTextIntoPromptTemplate('ARTYKUL:\n{{article}}', sourceText),
    `ARTYKUL:\n${sourceText}`
  );
  assert.strictEqual(
    context.injectSourceTextIntoPromptTemplate('ARTYKUL:\n{{ articlecontent }}\n{{ ARTICLE }}', sourceText),
    `ARTYKUL:\n${sourceText}\n${sourceText}`
  );
  assert.strictEqual(
    context.removeSourceTextPlaceholdersFromPromptTemplate('Start {{article}} / {{ articlecontent }} koniec'),
    'Start  /  koniec'
  );
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

function testPortfolioPromptChainHasThreePrompts() {
  const promptText = fs.readFileSync(path.join(__dirname, 'prompts-portfolio.txt'), 'utf8');
  const separator = /^\s*(?:◄\s*PROMPT_SEPARATOR\s*►|---\s*PROMPT\s*SEPARATOR\s*---)\s*$/gim;
  const prompts = promptText.split(separator).map((item) => item.trim()).filter(Boolean);

  assert.strictEqual(prompts.length, 3);
  assert.ok(prompts[0].includes('{{article}}'));
  assert.ok(prompts[0].includes('Ranking warstw value chain'));

  const context = buildContext();
  const injectedFirstPrompt = context.injectSourceTextIntoPromptTemplate(prompts[0], 'SOURCE_BODY');
  assert.ok(injectedFirstPrompt.includes('SOURCE_BODY'));
  assert.ok(!/\{\{\s*(?:articlecontent|article)\s*\}\}/i.test(injectedFirstPrompt));

  assert.ok(prompts[1].includes('PORTFOLIO_REFLECTION_REPORT'));
  assert.ok(prompts[1].includes('PORTFOLIO_SNAPSHOT_FROM_DB_BEGIN'));
  assert.ok(prompts[1].includes('PORTFOLIO_SNAPSHOT_FROM_DB_END'));
  assert.ok(prompts[1].includes('Format: portfolio.prompt_snapshot.simple.v1.'));
  assert.ok(prompts[1].includes('Source: postgresql_latest_snapshot.'));
  assert.ok(prompts[1].includes('Snapshot:'));
  assert.ok(prompts[1].includes('POSITIONS ('));
  assert.ok(prompts[1].includes('1. META'));
  assert.ok(!prompts[1].includes('META - META'));
  assert.ok(prompts[1].includes('teza:'));
  assert.ok(prompts[1].includes('brak w bazie'));
  assert.ok(prompts[1].includes('czytelny tekst, nie JSON'));
  assert.ok(prompts[1].includes('value'));
  assert.ok(prompts[1].includes('weight'));
  assert.ok(!prompts[1].includes('value_base'));
  assert.ok(!prompts[1].includes('weight_pct'));
  assert.ok(!prompts[1].includes('nie używaj `tool_search` w Prompcie 2'));
  assert.ok(!prompts[1].includes('nie używaj `account.positions.analysis_context` w Prompcie 2'));
  assert.ok(!prompts[1].includes('portfolio snapshot account positions analysis_context feedback sizing_monitor'));
  assert.ok(!prompts[1].includes('include_context_text'));
  assert.ok(!prompts[1].includes('"compact": true'));
  assert.ok(!prompts[1].includes('nie używaj broker.positions.list({})'));
  assert.ok(!prompts[1].includes('nie używaj list_resources'));
  assert.ok(!prompts[1].includes('Nie generuj jeszcze konkretnych zleceń, Take Profit ani Stop Loss'));
  assert.ok(prompts[1].includes('Nie zwracaj JSON'));
  assert.ok(prompts[1].includes('THESIS_CONSTRUCTION_SUMMARY'));
  assert.ok(prompts[1].includes('PORTFOLIO_CONSTRUCTION_COMMENTARY'));
  assert.ok(prompts[1].includes('layer_business_thesis'));
  assert.ok(!prompts[1].includes('OUT_OF_SCOPE_POSITIONS'));
  assert.ok(!prompts[1].toLowerCase().includes('dokładnie dwa merytoryczne zdania'));
  assert.ok(!prompts[1].includes('"prompt_1_response_copy"'));
  assert.ok(!prompts[1].includes('"author_thesis_commentary"'));
  assert.ok(!prompts[1].includes('overweight'));
  assert.ok(!prompts[1].includes('unrelated sleeve'));
  assert.ok(!prompts[1].includes('Zmniejszyć proxy'));
  assert.ok(!prompts[1].includes('"unknown_scope_positions"'));
  assert.ok(!prompts[1].includes('"data_quality"'));
  assert.ok(!prompts[1].includes('"target_weight_pct"'));
  assert.ok(!prompts[1].includes('"current_weight_pct"'));
  assert.ok(prompts[1].includes('current_qty'));
  assert.ok(prompts[1].includes('target_qty'));
  assert.ok(prompts[1].includes('Nie używaj pól action ani priority'));
  assert.ok(!prompts[1].includes('"business_model"'));
  assert.ok(!prompts[1].includes('"valuation_anchor"'));
  assert.ok(!prompts[1].includes('"answers"'));
  assert.ok(!prompts[1].includes('## 1. Odpowiedź wprost na dwa pytania'));
  assert.ok(!prompts[1].includes('mcp__codex_apps__iskierka._stage12_research_rows_upsert'));
  assert.ok(prompts[2].includes('Finalny tekstowy feedback JSON'));
  assert.ok(prompts[2].includes('dwóch wcześniejszych odpowiedzi'));
  assert.ok(!prompts[2].includes('KROK 1 - WCZYTAJ SNAPSHOT I NORMALIZUJ SKALĘ'));
  assert.ok(!prompts[2].includes('"scale_normalization"'));
  assert.ok(!prompts[2].includes('"out_of_scope_passthrough"'));
  assert.ok(!prompts[2].includes('"prompt_1_response_copy"'));
  assert.ok(!prompts[2].includes('"author_thesis_commentary"'));
  assert.ok(!prompts[2].includes('"portfolio_decision_narrative"'));
  assert.ok(prompts[2].includes('"thesis_construction_summary"'));
  assert.ok(prompts[2].includes('"portfolio_construction_commentary"'));
  assert.ok(prompts[2].includes('"layer_business_thesis"'));
  assert.ok(prompts[2].includes('"current_qty"'));
  assert.ok(prompts[2].includes('"target_qty"'));
  assert.ok(prompts[2].includes('Pozycje nie mają pól action ani priority'));
  assert.ok(!prompts[2].toLowerCase().includes('dokładnie dwa merytoryczne zdania'));
  assert.ok(!prompts[2].includes('overweight'));
  assert.ok(!prompts[2].includes('unrelated sleeve'));
  assert.ok(!prompts[2].includes('Zmniejszyć proxy'));
  assert.ok(prompts[2].includes('Zwróć wyłącznie jeden poprawny JSON'));
  const finalJsonShape = prompts[2].slice(prompts[2].indexOf('Struktura finalnego JSON:'));
  assert.ok(!finalJsonShape.includes('"status"'));
  assert.ok(!finalJsonShape.includes('"human_status"'));
  assert.ok(!finalJsonShape.includes('"scope"'));
  assert.ok(!finalJsonShape.includes('"out_of_scope_passthrough"'));
  assert.ok(!finalJsonShape.includes('"prompt_1_response_copy"'));
  assert.ok(!finalJsonShape.includes('"author_thesis_commentary"'));
  assert.ok(prompts[2].includes('Nie dodawaj pól status ani human_status'));
  assert.ok(!prompts[2].includes('"db_write"'));
  assert.ok(!prompts[2].includes('SANITY CHECKS PRZED ZAMKNIĘCIEM JSON'));
  assert.ok(!prompts[2].includes('TABELA POZYCJI'));
  assert.ok(!prompts[2].includes('portfolio snapshot account positions analysis_context feedback sizing_monitor'));
  assert.ok(!prompts[2].includes('account.positions.analysis_context({'));
  assert.ok(!prompts[2].includes('hashed callable connectora'));
  assert.ok(!prompts[2].includes('"compact": true'));
  assert.ok(prompts[2].includes('warnings'));
  assert.ok(!prompts[2].includes('portfolio.feedback.submit'));
  assert.ok(!prompts[2].includes('portfolio.feedback.sizing_monitor'));
  assert.ok(!prompts[2].includes('stop_loss_price'));
  assert.ok(!prompts[2].includes('take_profit_price'));
  assert.ok(!prompts[2].includes('"execution"'));
  assert.ok(!prompts[2].includes('"feedback_payload"'));
  assert.ok(backgroundSource.includes('getPortfolioPromptSnapshotStatus'));
  assert.ok(backgroundSource.includes('portfolio_prompt_snapshot_placeholder'));
  assert.ok(backgroundSource.includes('portfolio_prompt_snapshot_empty_positions'));
  assert.ok(backgroundSource.includes('extractPortfolioFinalJsonText'));
  assert.ok(backgroundSource.includes('portfolio_final_json'));
  assert.ok(backgroundSource.includes('portfolio.final_response.v2'));
  assert.ok(backgroundSource.includes('useStage12InvestmentResponse = !isPortfolioAnalysis'));
}

function testPortfolioPromptSnapshotStatusUsesLineMarkers() {
  const context = buildContext();
  const readyPrompt = [
    'prompt one',
    [
      'Instrukcja wspomina `PORTFOLIO_SNAPSHOT_FROM_DB_BEGIN` i `PORTFOLIO_SNAPSHOT_FROM_DB_END`.',
      'PORTFOLIO_SNAPSHOT_FROM_DB_BEGIN',
      'Format: portfolio.prompt_snapshot.simple.v1. Source: postgresql_latest_snapshot. Context: loaded. Prompt generated: 2026-05-07T11:28:00Z.',
      'Snapshot: id=ibkrps-test, account=DU123, generated_utc=2026-05-07T11:27:25Z, age_h=1.0, stale=false, positions=1, with_thesis=1.',
      '',
      'POSITIONS (1)',
      '1. AAPL - Apple Inc',
      '   qty 2, price 200 USD, value 400, weight 40%, chg 5d 1.2%',
      '   teza: Position thesis tied to the holding.',
      'PORTFOLIO_SNAPSHOT_FROM_DB_END'
    ].join('\n')
  ];
  const readyStatus = context.getPortfolioPromptSnapshotStatus(readyPrompt);
  assert.strictEqual(readyStatus.ok, true);
  assert.strictEqual(readyStatus.reason, 'portfolio_prompt_snapshot_ready');

  const placeholderPrompt = [
    'prompt one',
    [
      'PORTFOLIO_SNAPSHOT_FROM_DB_BEGIN',
      'Format: portfolio.prompt_snapshot.simple.v1. Source: placeholder_until_snapshot_refresh. Context: not_loaded.',
      'Snapshot: id=brak, generated_utc=brak, positions=0, with_thesis=0.',
      'POSITIONS (0)',
      'Brak pozycji.',
      'PORTFOLIO_SNAPSHOT_FROM_DB_END'
    ].join('\n')
  ];
  const placeholderStatus = context.getPortfolioPromptSnapshotStatus(placeholderPrompt);
  assert.strictEqual(placeholderStatus.ok, false);
  assert.strictEqual(placeholderStatus.reason, 'portfolio_prompt_snapshot_placeholder');
}

function testPortfolioPromptOneResponseIsCopiedToDatabase() {
  assert.ok(backgroundSource.includes('copyPortfolioPromptOneResponseToDatabase'));
  assert.ok(backgroundSource.includes('portfolio.layer_ranking.v1'));
  assert.ok(backgroundSource.includes('portfolio_layer_ranking'));
  assert.match(
    backgroundSource,
    /stage0Response\s*=\s*await getLastResponseText\(\)[\s\S]{0,900}copyPortfolioPromptOneResponseToDatabase\(stage0Response\)/
  );
  assert.ok(backgroundSource.includes('skipProcessPersistencePatch: true'));
}

async function main() {
  await testPopupRunQueuesPortfolioAutomatically();
  await testManualTextSharesOneSourceAcrossCompanyAndPortfolio();
  await testManualPortfolioOnlyQueuesOnePortfolioProcess();
  testSourceTextPlaceholderInjectionSupportsPortfolioArticleAlias();
  testManualSourceShowsSinglePortfolioActionWithoutModeToggle();
  testPortfolioPromptChainHasThreePrompts();
  testPortfolioPromptSnapshotStatusUsesLineMarkers();
  testPortfolioPromptOneResponseIsCopiedToDatabase();
  console.log('portfolio auto company test: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
