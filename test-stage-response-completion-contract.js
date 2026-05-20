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
    RegExp,
    String,
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
    'validateStageResponseForPrompt'
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

function main() {
  const ctx = loadCompletionHelpers();
  const prompts = parseCompanyPrompts();
  const stage1Prompt = prompts[1];
  assert(stage1Prompt.includes('STAGE 1'), 'Expected real Stage 1 prompt fixture.');

  const truncatedStage1 = [
    'I found the Stage 0 handoff in the prior output and will treat it as locked input.',
    'The inherited mechanism splits naturally by contract economics: coupon books, secondary discounted claims, rescue amendments/refinancings, workouts/control rights, and new first-lien originations.',
    'STAGE'
  ].join('\n\n');

  const truncatedResult = ctx.validateStageResponseForPrompt(truncatedStage1, stage1Prompt, 2);
  assert.strictEqual(truncatedResult.valid, false);
  assert.strictEqual(truncatedResult.reason, 'missing_completion_marker');
  assert.match(truncatedResult.missingMarker, /STAGE 1/i);

  const wrongStageHandoff = `${truncatedStage1}

=== STAGE 0 HANDOFF ===
WINNING_THESIS: Prior-stage text that should not satisfy Stage 1 completion.
=== END HANDOFF ===`;
  const wrongStageResult = ctx.validateStageResponseForPrompt(wrongStageHandoff, stage1Prompt, 2);
  assert.strictEqual(wrongStageResult.valid, false);
  assert.match(wrongStageResult.missingMarker, /STAGE 1/i);

  const completeStage1 = `${truncatedStage1}

=== STAGE 1 HANDOFF ===
WINNING_THESIS: Distressed private-credit refinancing mechanics create forced spend through specialist claim-control and rescue-financing channels.
THESIS_SOURCE: Economist credit-market article MEDIA_ARTICLE
SELECTED_SUB-SEGMENTS: rescue amendments, discounted secondary claims
=== END HANDOFF ===`;
  const completeResult = ctx.validateStageResponseForPrompt(completeStage1, stage1Prompt, 2);
  assert.strictEqual(completeResult.valid, true);

  assert.match(backgroundSource, /waitForChatGptGenerationFinishedBeforeNextPrompt\(/);
  const guardCallIndex = backgroundSource.indexOf('const generationFinished = await waitForChatGptGenerationFinishedBeforeNextPrompt');
  const stageCompletionIndex = backgroundSource.indexOf('responseDataGapDirective = dataGapDirective;');
  assert(guardCallIndex > 0, 'Expected generation-finished guard before stage completion.');
  assert(stageCompletionIndex > guardCallIndex, 'Stage completion must happen after generation-finished guard.');
  assert.match(backgroundSource, /Nie wysylam kolejnego etapu - ChatGPT nadal generuje/);

  console.log('test-stage-response-completion-contract.js passed');
}

main();
