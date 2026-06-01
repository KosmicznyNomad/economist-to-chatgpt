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
  const paramsStart = source.indexOf('(', startIndex);
  let parenDepth = 0;
  let braceStart = -1;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

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

function loadCompletionHelpers() {
  const context = vm.createContext({
    console,
    JSON,
    Number,
    Promise,
    RegExp,
    String,
    setTimeout: (callback) => {
      callback();
      return 0;
    },
    DATA_GAP_DIRECTIVE_REGEX: /^\s*DATA_GAP_STAGE\s*=\s*([0-9]+)\s*$/i
  });

  [
    'compactText',
    'normalizeDataGapStageId',
    'parseDataGapDirectiveResponse',
    'escapeRegexLocal',
    'validateResponse',
    'extractPromptStageIdForCompletionContract',
    'buildStageResponseCompletionContract',
    'responseTextContainsCompleteJsonArray',
    'responseTextContainsCompleteJsonObject',
    'getResponseCompletionReadiness',
    'validateStageResponseForPrompt',
    'getResponseDomNodes',
    'getLastResponseText'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
      filename: 'background.js'
    });
  });

  return context;
}

function parseCompanyPrompts() {
  const raw = fs.readFileSync(path.join(__dirname, 'prompts-company.txt'), 'utf8')
    .replace(/\uFEFF/g, '')
    .replace(/\r\n?/g, '\n');
  return raw
    .split(/\n(?:---\s*PROMPT\s+SEPARATOR\s*---|(?:\u25C4|\u00E2\u2014\u201E)?[ \t-]*PROMPT(?:[ _-]+)SEPARATOR[ \t-]*(?:\u25BA|\u00E2\u2013\u015F)?)\n/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePortfolioPrompts() {
  const raw = fs.readFileSync(path.join(__dirname, 'prompts-portfolio.txt'), 'utf8')
    .replace(/\uFEFF/g, '')
    .replace(/\r\n?/g, '\n');
  return raw
    .split(/^\s*(?:◄\s*PROMPT_SEPARATOR\s*►|---\s*PROMPT\s*SEPARATOR\s*---)\s*$/gim)
    .map((item) => item.trim())
    .filter(Boolean);
}

function makeAssistantElement(text) {
  return {
    innerText: text,
    textContent: text,
    children: [],
    className: '',
    innerHTML: text,
    cloneNode() {
      return {
        innerText: text,
        textContent: text,
        querySelectorAll() {
          return [];
        }
      };
    },
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    }
  };
}

function makeDomNode({ text = '', assistantChild = null, assistantAncestor = null, userAncestor = null, matchesAssistant = false } = {}) {
  return {
    innerText: text,
    textContent: text,
    matches(selector) {
      return selector === '[data-message-author-role="assistant"]' && matchesAssistant;
    },
    querySelector(selector) {
      if (selector === '[data-message-author-role="assistant"]') return assistantChild;
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest(selector) {
      if (selector === '[data-message-author-role="assistant"]') return assistantAncestor;
      if (selector === '[data-message-author-role="user"]') return userAncestor;
      return null;
    }
  };
}

function installAssistantTextSequence(ctx, texts) {
  let assistantSelectorCalls = 0;
  ctx.document = {
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') {
        const index = Math.min(assistantSelectorCalls, texts.length - 1);
        assistantSelectorCalls += 1;
        return [makeAssistantElement(texts[index])];
      }
      return [];
    }
  };
  return () => assistantSelectorCalls;
}

async function main() {
  const ctx = loadCompletionHelpers();
  const prompts = parseCompanyPrompts();
  const stage1Prompt = prompts[1];
  assert(stage1Prompt.includes('STAGE 1'), 'Expected real Stage 1 prompt fixture.');

  const userPromptNode = makeDomNode({ text: 'STAGE 15 prompt that asks for JSON array.' });
  ctx.document = {
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return [];
      if (selector === '[data-testid^="conversation-turn-"]') return [userPromptNode];
      if (selector === 'article') return [userPromptNode];
      if (selector === 'div[class*="markdown"]') {
        return [makeDomNode({ text: 'User prompt markdown', userAncestor: userPromptNode })];
      }
      return [];
    }
  };
  const userOnlyResponseNodes = ctx.getResponseDomNodes();
  assert.strictEqual(userOnlyResponseNodes.source, 'none');
  assert.strictEqual(userOnlyResponseNodes.nodes.length, 0);

  const assistantChild = makeDomNode({ text: 'Assistant response JSON: []', matchesAssistant: true });
  const turnWithAssistant = makeDomNode({ assistantChild });
  ctx.document = {
    querySelectorAll(selector) {
      if (selector === '[data-message-author-role="assistant"]') return [];
      if (selector === '[data-testid^="conversation-turn-"]') return [userPromptNode, turnWithAssistant];
      if (selector === 'article') return [];
      if (selector === 'div[class*="markdown"]') return [];
      return [];
    }
  };
  const assistantTurnResponseNodes = ctx.getResponseDomNodes();
  assert.strictEqual(assistantTurnResponseNodes.source, 'conversation_turn_assistant');
  assert.strictEqual(assistantTurnResponseNodes.nodes.length, 1);
  assert.strictEqual(assistantTurnResponseNodes.nodes[0].innerText, assistantChild.innerText);

  const truncatedStage1 = [
    'I found the Stage 0 handoff in the prior output and will treat it as locked input.',
    'The inherited mechanism splits naturally by contract economics: coupon books, secondary discounted claims, rescue amendments/refinancings, workouts/control rights, and new first-lien originations.',
    'STAGE'
  ].join('\n\n');

  const truncatedResult = ctx.validateStageResponseForPrompt(truncatedStage1, stage1Prompt, 2);
  assert.strictEqual(truncatedResult.valid, true);
  assert.strictEqual(truncatedResult.reason, 'ok_missing_soft_markers');
  assert(truncatedResult.missingMarkers.some((marker) => /STAGE 1/i.test(marker)));

  const wrongStageHandoff = `${truncatedStage1}

=== STAGE 0 HANDOFF ===
WINNING_THESIS: Prior-stage text that should not satisfy Stage 1 completion.
=== END HANDOFF ===`;
  const wrongStageResult = ctx.validateStageResponseForPrompt(wrongStageHandoff, stage1Prompt, 2);
  assert.strictEqual(wrongStageResult.valid, true);
  assert.strictEqual(wrongStageResult.reason, 'ok_missing_soft_markers');
  assert(wrongStageResult.missingMarkers.some((marker) => /STAGE 1/i.test(marker)));

  const completeStage1 = `${truncatedStage1}

=== STAGE 1 HANDOFF ===
WINNING_THESIS: Distressed private-credit refinancing mechanics create forced spend through specialist claim-control and rescue-financing channels.
THESIS_SOURCE: Economist credit-market article MEDIA_ARTICLE
SELECTED_SUB-SEGMENTS: rescue amendments, discounted secondary claims
=== END HANDOFF ===`;
  const completeResult = ctx.validateStageResponseForPrompt(completeStage1, stage1Prompt, 2);
  assert.strictEqual(completeResult.valid, true);

  const stage0PayloadPrompt = `
ROLE

STAGE 0 - ARTICLE MECHANISM LOCK

At the END of your Stage 0 output, include a clearly marked block:

=== STAGE 0 HANDOFF ===
WINNING_THESIS: [single sentence]
=== END HANDOFF ===
`;
  assert.strictEqual(ctx.extractPromptStageIdForCompletionContract(stage0PayloadPrompt, 0), '0');

  const oneLetterReadiness = ctx.getResponseCompletionReadiness('I', stage0PayloadPrompt, 0, {
    forStaleGenerating: true
  });
  assert.strictEqual(oneLetterReadiness.ready, false);
  assert.strictEqual(oneLetterReadiness.reason, 'too_short');

  const preambleOnlyReadiness = ctx.getResponseCompletionReadiness(
    'I will stay at Stage 0 and reconstruct the worldview before selecting the thesis.',
    stage0PayloadPrompt,
    0,
    { forStaleGenerating: true }
  );
  assert.strictEqual(preambleOnlyReadiness.ready, false);
  assert.strictEqual(preambleOnlyReadiness.reason, 'too_short_for_stale_generating_override');

  const completeStage0Readiness = ctx.getResponseCompletionReadiness(
    `## 0. Evidence Ledger & Author Worldview

=== STAGE 0 HANDOFF ===
WINNING_THESIS: If agentic computing becomes continuous, then data-center spend shifts toward rack-scale inference systems.
=== END HANDOFF ===`,
    stage0PayloadPrompt,
    0,
    { forStaleGenerating: true }
  );
  assert.strictEqual(completeStage0Readiness.ready, true);
  assert.strictEqual(completeStage0Readiness.reason, 'completion_contract_satisfied');

  const companyPrompts = parseCompanyPrompts();
  assert(companyPrompts.length >= 6);
  const companyPrompt6 = companyPrompts[5];
  const completeStage5 = `Synopsys, Inc. (SNPS)

Sector overlay reviewed the Stage 4 CORE boundary and kept current EDA revenue in CORE while reserving above-base pricing, RPO quality, and capacity-rent proof for later rebase work.

=== STAGE 5 MCP SECTOR OVERLAY HANDOFF ===
COMPANY: Synopsys, Inc.
TICKER: SNPS
CORE_DECISION_GRADE_AFTER_MCP: TRUE
=== END HANDOFF ===`;
  const completeStage5Readiness = ctx.getResponseCompletionReadiness(
    completeStage5,
    companyPrompt6,
    6,
    { forStaleGenerating: true }
  );
  assert.strictEqual(completeStage5Readiness.ready, true);
  assert.strictEqual(completeStage5Readiness.reason, 'completion_contract_satisfied');
  const completeStage5Validation = ctx.validateStageResponseForPrompt(completeStage5, companyPrompt6, 6);
  assert.strictEqual(completeStage5Validation.valid, true);

  const longNoHandoffReadiness = ctx.getResponseCompletionReadiness(
    'This is a long mechanically complete answer that has enough text to be treated as a finished DOM response after ChatGPT has stopped streaming. '.repeat(4),
    stage0PayloadPrompt,
    0,
    { forStaleGenerating: true }
  );
  assert.strictEqual(longNoHandoffReadiness.ready, true);
  assert.strictEqual(longNoHandoffReadiness.reason, 'basic_response_ready_missing_soft_markers');
  assert(longNoHandoffReadiness.missingMarkers.some((marker) => /STAGE 0/i.test(marker)));

  const portfolioPrompts = parsePortfolioPrompts();
  assert.strictEqual(portfolioPrompts.length, 3);
  assert(portfolioPrompts[0].includes('PORTFOLIO_PROMPT_1_COMPLETE'));
  assert(portfolioPrompts[1].includes('PORTFOLIO_PROMPT_2_COMPLETE'));

  const portfolioPrompt1WithoutMarker = [
    'PROMPT 1 - Ranking warstw value chain i proporcji',
    'Warstwa #1 przechwytuje wiecej marzy, bo ograniczona podaz laczy sie z nieelastycznym popytem.',
    'Warstwa #2 jest proxy i powinna miec nizsza wage, bo revenue rosnie szybciej niz FCF.'
  ].join('\n\n');
  const portfolioPrompt1MissingMarker = ctx.validateStageResponseForPrompt(
    portfolioPrompt1WithoutMarker,
    portfolioPrompts[0],
    1
  );
  assert.strictEqual(portfolioPrompt1MissingMarker.valid, true);
  assert.strictEqual(portfolioPrompt1MissingMarker.reason, 'ok_missing_completion_marker');
  assert.strictEqual(portfolioPrompt1MissingMarker.missingHardMarkers.length, 1);
  assert.strictEqual(portfolioPrompt1MissingMarker.missingHardMarkers[0], 'PORTFOLIO_PROMPT_1_COMPLETE');

  const portfolioPrompt1Complete = `${portfolioPrompt1WithoutMarker}

PORTFOLIO_PROMPT_1_COMPLETE`;
  const portfolioPrompt1CompleteResult = ctx.validateStageResponseForPrompt(
    portfolioPrompt1Complete,
    portfolioPrompts[0],
    1
  );
  assert.strictEqual(portfolioPrompt1CompleteResult.valid, true);

  const portfolioPrompt1Readiness = ctx.getResponseCompletionReadiness(
    portfolioPrompt1WithoutMarker,
    portfolioPrompts[0],
    1
  );
  assert.strictEqual(portfolioPrompt1Readiness.ready, true);
  assert.strictEqual(portfolioPrompt1Readiness.reason, 'basic_response_ready_missing_soft_markers');

  const portfolioPrompt1StaleReadiness = ctx.getResponseCompletionReadiness(
    portfolioPrompt1WithoutMarker,
    portfolioPrompts[0],
    1,
    { forStaleGenerating: true }
  );
  assert.strictEqual(portfolioPrompt1StaleReadiness.ready, false);
  assert.strictEqual(portfolioPrompt1StaleReadiness.reason, 'missing_completion_marker');

  const portfolioPrompt1StrictReadiness = ctx.getResponseCompletionReadiness(
    portfolioPrompt1WithoutMarker,
    portfolioPrompts[0],
    1,
    { strictCompletionMarkers: true }
  );
  assert.strictEqual(portfolioPrompt1StrictReadiness.ready, false);
  assert.strictEqual(portfolioPrompt1StrictReadiness.reason, 'missing_completion_marker');
  const portfolioPrompt1StrictMissingMarkers = portfolioPrompt1StrictReadiness.missingHardMarkers || [];
  assert.strictEqual(portfolioPrompt1StrictMissingMarkers.length, 1);
  assert.strictEqual(portfolioPrompt1StrictMissingMarkers[0], 'PORTFOLIO_PROMPT_1_COMPLETE');

  const portfolioPrompt1CompletionReady = ctx.getResponseCompletionReadiness(
    portfolioPrompt1Complete,
    portfolioPrompts[0],
    1
  );
  assert.strictEqual(portfolioPrompt1CompletionReady.ready, true);
  assert.strictEqual(portfolioPrompt1CompletionReady.reason, 'completion_contract_satisfied');

  const getAssistantSelectorCalls = installAssistantTextSequence(ctx, [
    portfolioPrompt1WithoutMarker,
    portfolioPrompt1WithoutMarker,
    portfolioPrompt1Complete
  ]);
  const capturedPortfolioPrompt1 = await ctx.getLastResponseText({
    promptText: portfolioPrompts[0],
    promptNumber: 1,
    preferLatest: true
  });
  assert.strictEqual(capturedPortfolioPrompt1, portfolioPrompt1WithoutMarker);
  assert(getAssistantSelectorCalls() >= 1);

  const portfolioPrompt3TruncatedJson = ctx.validateStageResponseForPrompt(
    '{"thesis_construction_summary":"tekst","portfolio_construction_commentary":"tekst","layers":[',
    portfolioPrompts[2],
    3
  );
  assert.strictEqual(portfolioPrompt3TruncatedJson.valid, false);
  assert.strictEqual(portfolioPrompt3TruncatedJson.reason, 'invalid_or_incomplete_json_object');

  const portfolioPrompt3CompleteJson = ctx.validateStageResponseForPrompt(
    '{"thesis_construction_summary":"tekst","portfolio_construction_commentary":"tekst","layers":[],"positions":[],"portfolio_gaps":[],"warnings":[],"errors":[]}',
    portfolioPrompts[2],
    3
  );
  assert.strictEqual(portfolioPrompt3CompleteJson.valid, true);

  assert.match(backgroundSource, /waitForChatGptGenerationFinishedBeforeNextPrompt\(/);
  const guardCallIndex = backgroundSource.indexOf('const generationFinished = await waitForChatGptGenerationFinishedBeforeNextPrompt');
  const stageCompletionIndex = backgroundSource.indexOf('responseDataGapDirective = dataGapDirective;');
  assert(guardCallIndex > 0, 'Expected generation-finished guard before stage completion.');
  assert(stageCompletionIndex > guardCallIndex, 'Stage completion must happen after generation-finished guard.');
  assert.match(backgroundSource, /Nie wysylam kolejnego etapu - ChatGPT nadal generuje/);
  assert.match(backgroundSource, /Nie wysylam Prompt 2 - Prompt 1 nadal nie jest zakonczony/);
  assert.match(backgroundSource, /staleGeneratingReadyOverrideMs = 8_000/);
  assert.match(backgroundSource, /phase2StaleGeneratingReadyOverrideMs = 8_000/);
  assert.match(backgroundSource, /Klikam Stop po kompletnym markerze/);
  assert.match(backgroundSource, /waitForResponse mogl przejsc dalej/);
  assert.match(backgroundSource, /clickedStaleStop/);
  assert.match(backgroundSource, /phase2ClickedStaleStop/);
  assert.match(backgroundSource, /promptText:\s*payload/);
  assert.match(backgroundSource, /promptText:\s*prompt/);
  assert.match(backgroundSource, /Nie wysylam prompt chain - Stage 0 jest niekompletny/);
  assert.match(backgroundSource, /Stage 1 nie moze ruszyc bez kompletnego Stage 0/);
  assert.match(backgroundSource, /Brak markerow oczekiwanych przez prompt.*soft diagnostic/);
  assert.doesNotMatch(backgroundSource, /Nie wysylam kolejnego etapu - odpowiedz niepelna/);
  assert.match(backgroundSource, /async function getLastResponseText\(options = \{\}\)/);
  assert.match(backgroundSource, /Latest assistant response passes DOM\/basic completion readiness/);
  assert.match(backgroundSource, /tryAcceptLatestResponseByContract\(/);
  assert.match(backgroundSource, /timeout_before_manual_action/);
  assert.match(backgroundSource, /invalid_response_before_manual_action/);
  assert.match(backgroundSource, /classifyTimeoutOutcome\(snapshot, promptText, promptNumber = 0\)/);
  assert.match(backgroundSource, /if \(!preferLatest\)/);
  assert.match(
    backgroundSource,
    /responseText = await getLastResponseText\(\{\s*promptText: prompt,\s*promptNumber: absoluteCurrentPrompt,\s*preferLatest: true/s
  );

  console.log('test-stage-response-completion-contract.js passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
