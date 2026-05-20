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

const context = {
  console,
  Number,
  String,
  Array,
  Math,
  RegExp,
  PROMPTS_COMPANY: ['p1', 'p2', 'p3', 'p4', 'p5'],
  STAGE_NAMES_COMPANY: ['P1', 'P2', 'P3', 'P4', 'P5'],
  ProcessContractUtils: {
    normalizeCodeToken(value) {
      return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '_')
        .replace(/_{2,}/g, '_')
        .replace(/\._/g, '.')
        .replace(/_\./g, '.')
        .replace(/^[_./-]+|[_./-]+$/g, '');
    }
  }
};

vm.createContext(context);
[
  'normalizeComposerThinkingEffort',
  'formatResumeProcessTitleWithThinkingEffort',
  'toBoundedPromptNumber',
  'selectConservativePromptNumber',
  'computeNextResumeIndex',
  'normalizeResumeSignalToken',
  'isMissingAssistantReplySignalToken',
  'hasExplicitMissingAssistantReplySignal',
  'buildCompanyResumePlanFromAudit'
].forEach((functionName) => {
  vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
    filename: 'background.js'
  });
});

assert.strictEqual(
  context.formatResumeProcessTitleWithThinkingEffort('Auto Start: Prompt 7', 'HEAVY'),
  'Auto Start [HEAVY]: Prompt 7'
);
assert.strictEqual(
  context.formatResumeProcessTitleWithThinkingEffort('Company run', 'extended'),
  'Company run [EXTENDED]'
);
assert.strictEqual(
  context.formatResumeProcessTitleWithThinkingEffort('Auto Start [HEAVY]: Prompt 7', 'heavy'),
  'Auto Start [HEAVY]: Prompt 7'
);

function buildAudit(rowOverrides) {
  return {
    promptCatalogCount: 5,
    rows: [{
      promptMatched: true,
      promptNumber: 3,
      userMessageIndex: 7,
      runId: 1,
      detectionMethod: 'test',
      ...rowOverrides
    }],
    totals: {
      totalUserMessages: 3,
      totalAssistantMessages: 3,
      matchedPromptMessages: 1,
      unmatchedUserMessages: 0,
      recognizedUniquePrompts: 1,
      detectedRuns: 1
    }
  };
}

const withAssistantReply = context.buildCompanyResumePlanFromAudit(buildAudit({
  hasAssistantReplyAfter: true,
  assistantReplyPassThreshold: false
}));
assert.strictEqual(withAssistantReply.shouldAdvancePrompt, true, 'An assistant reply should advance even when quality threshold failed.');
assert.strictEqual(withAssistantReply.retrySamePrompt, false);
assert.strictEqual(withAssistantReply.nextStartIndex, 3);

const unknownReplyState = context.buildCompanyResumePlanFromAudit(buildAudit({}));
assert.strictEqual(unknownReplyState.shouldAdvancePrompt, true, 'Unknown reply state should not force repeat.');
assert.strictEqual(unknownReplyState.retrySamePrompt, false);
assert.strictEqual(unknownReplyState.nextStartIndex, 3);

const missingReply = context.buildCompanyResumePlanFromAudit(buildAudit({
  hasAssistantReplyAfter: false
}));
assert.strictEqual(missingReply.shouldAdvancePrompt, false, 'Explicit missing reply should repeat the detected prompt.');
assert.strictEqual(missingReply.retrySamePrompt, true);
assert.strictEqual(missingReply.retryReason, 'missing_assistant_reply');
assert.strictEqual(missingReply.nextStartIndex, 2);

const forcedRepeat = context.buildCompanyResumePlanFromAudit(buildAudit({
  hasAssistantReplyAfter: true
}), {
  forceRepeatLastPrompt: true
});
assert.strictEqual(forcedRepeat.shouldAdvancePrompt, false, 'Force repeat should repeat the detected prompt.');
assert.strictEqual(forcedRepeat.retryReason, 'force_repeat_last_prompt');
assert.strictEqual(forcedRepeat.nextStartIndex, 2);

assert.strictEqual(
  context.hasExplicitMissingAssistantReplySignal({ reason: 'saved_stage_needs_action' }),
  false,
  'needsAction alone should not be treated as missing response.'
);
assert.strictEqual(
  context.hasExplicitMissingAssistantReplySignal({ issueFlags: ['assistant_reply_below_threshold'] }),
  false,
  'Low-quality replies should not be treated as missing responses.'
);
assert.strictEqual(
  context.hasExplicitMissingAssistantReplySignal({ reason: 'missing_assistant_reply' }),
  true,
  'Explicit missing assistant reply should be detected.'
);
assert.strictEqual(
  context.hasExplicitMissingAssistantReplySignal({ error: 'empty_response' }),
  true,
  'Empty response should be detected as missing response.'
);

console.log('resume next-stage policy test: ok');
