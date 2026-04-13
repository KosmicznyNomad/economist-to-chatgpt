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

const context = {
  console,
  Date,
  String,
  Number,
  Boolean,
  Object,
  normalizeChatConversationUrl(value) {
    return typeof value === 'string' ? value.trim() : '';
  }
};

vm.createContext(context);
[
  'normalizeChatGptUiText',
  'isChatGptLimitOrRestrictionText',
  'isInjectRateLimitBlockedResult',
  'buildInjectRateLimitNeedsActionPatch'
].forEach((functionName) => {
  vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
    filename: 'background.js'
  });
});

function testClassifierRecognizesLimitAndRestrictionMessages() {
  assert.strictEqual(
    context.isChatGptLimitOrRestrictionText('limit: reached for this run'),
    true
  );
  assert.strictEqual(
    context.isChatGptLimitOrRestrictionText('  LIMIT : temporary block  '),
    true
  );
  assert.strictEqual(
    context.isChatGptLimitOrRestrictionText('Too many requests. Please try again later.'),
    false
  );
  assert.strictEqual(
    context.isChatGptLimitOrRestrictionText('Heavy is not available on your current plan.'),
    false
  );
  assert.strictEqual(
    context.isChatGptLimitOrRestrictionText('Something went wrong while generating the response.'),
    false
  );
}

function testBlockedResultHelperAndPatchBuilder() {
  assert.strictEqual(
    context.isInjectRateLimitBlockedResult({ success: false, error: 'rate_limit_blocked' }),
    true
  );
  assert.strictEqual(
    context.isInjectRateLimitBlockedResult({ success: false, error: 'inject_failed' }),
    false
  );

  const patch = context.buildInjectRateLimitNeedsActionPatch(
    {
      success: false,
      error: 'rate_limit_blocked',
      currentPrompt: 4,
      stageIndex: 3,
      conversationUrl: ' https://chatgpt.com/c/alpha '
    },
    {
      totalPrompts: 14,
      stageName: 'Prompt 4'
    }
  );

  assert.strictEqual(patch.lifecycleStatus, 'running');
  assert.strictEqual(patch.status, 'running');
  assert.strictEqual(patch.actionRequired, 'rate_limit');
  assert.strictEqual(patch.statusCode, 'chat.rate_limited');
  assert.strictEqual(patch.needsAction, true);
  assert.strictEqual(patch.reason, 'limit_or_restriction');
  assert.strictEqual(patch.error, 'rate_limit_blocked');
  assert.strictEqual(patch.currentPrompt, 4);
  assert.strictEqual(patch.totalPrompts, 14);
  assert.strictEqual(patch.stageIndex, 3);
  assert.strictEqual(patch.stageName, 'Prompt 4');
  assert.strictEqual(patch.chatUrl, 'https://chatgpt.com/c/alpha');
}

function testInjectKeepsLimitClassifierInsideInjectedScope() {
  const start = backgroundSource.indexOf('async function injectToChat(');
  const end = backgroundSource.indexOf('\nfunction sleep(', start);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('Could not isolate injectToChat source');
  }
  const injectSource = backgroundSource.slice(start, end);

  assert.match(injectSource, /function isInjectedChatGptLimitOrRestrictionText\s*\(/);
  assert.doesNotMatch(injectSource, /\bisChatGptLimitOrRestrictionText\s*\(/);
}

function main() {
  testClassifierRecognizesLimitAndRestrictionMessages();
  testBlockedResultHelperAndPatchBuilder();
  testInjectKeepsLimitClassifierInsideInjectedScope();
  console.log('test-background-rate-limit-blocking.js passed');
}

main();
