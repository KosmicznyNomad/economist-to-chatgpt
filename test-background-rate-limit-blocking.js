const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const backgroundPath = path.join(__dirname, 'background.js');
const backgroundSource = fs.readFileSync(backgroundPath, 'utf8').replace(/\r\n/g, '\n');

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
  'compactText',
  'normalizeChatGptUiText',
  'isChatGptLimitOrRestrictionText',
  'isInjectRateLimitBlockedResult',
  'buildInjectRateLimitNeedsActionPatch',
  'isHardGenerationErrorText',
  'isRetryableChatGptGenerationErrorText'
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
    context.isChatGptLimitOrRestrictionText("You've hit your limit. Please try again later."),
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

function testRetryableGenerationErrorClassifier() {
  const retryableMessage = 'Something went wrong while generating the response. If this issue persists please contact us through our help center at help.openai.com.';
  assert.strictEqual(context.isHardGenerationErrorText(retryableMessage), true);
  assert.strictEqual(context.isRetryableChatGptGenerationErrorText(retryableMessage), true);
  assert.strictEqual(
    context.isRetryableChatGptGenerationErrorText('Something went wrong while generating the response.'),
    true
  );
  assert.strictEqual(
    context.isRetryableChatGptGenerationErrorText("You've hit your limit. Please try again later."),
    true
  );
  assert.strictEqual(
    context.isRetryableChatGptGenerationErrorText("You\u2019ve hit your limit. Please try again later."),
    true
  );
  assert.strictEqual(
    context.isRetryableChatGptGenerationErrorText('Too many requests. Please try again later.'),
    true
  );
  assert.strictEqual(
    context.isRetryableChatGptGenerationErrorText('Please try again later. Retry'),
    true
  );
  assert.strictEqual(
    context.isRetryableChatGptGenerationErrorText(
      'This is a longer normal response mentioning that someone may try again later after reviewing context.'
    ),
    false
  );
  assert.strictEqual(context.isRetryableChatGptGenerationErrorText('Network error'), false);
  assert.strictEqual(
    context.isRetryableChatGptGenerationErrorText('Streaming interrupted while waiting for the complete message.'),
    false
  );
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
  assert.match(injectSource, /function clickRetryForRetryableGenerationError\s*\(/);
  assert.match(injectSource, /statusCode:\s*'chat\.retry_generation_error'/);
  assert.match(injectSource, /lastAlert,\s*\n\s*lastAlertText:/);
  assert.match(injectSource, /isRetryableChatGptGenerationErrorText\(state\.lastAlertText\)/);
}

function testInjectResendsPromptBeforeManualNoResponseRecovery() {
  const start = backgroundSource.indexOf('async function injectToChat(');
  const end = backgroundSource.indexOf('\nfunction sleep(', start);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('Could not isolate injectToChat source');
  }
  const injectSource = backgroundSource.slice(start, end);

  assert.match(injectSource, /function resendPromptAfterMissingResponse\s*\(/);
  assert.match(injectSource, /statusCode:\s*'chat\.no_response_resend'/);
  assert.match(injectSource, /missingResponsePromptResendMaxAttempts/);

  const timeoutResendIndex = injectSource.indexOf("await resendPromptAfterMissingResponse(\n                'timeout'");
  const timeoutAutoRecoveryIndex = injectSource.indexOf("const autoRecoveryHandoff = maybeTriggerAutoRecovery(\n                'timeout'");
  assert(timeoutResendIndex > 0, 'timeout branch should resend the previous prompt');
  assert(timeoutAutoRecoveryIndex > 0, 'timeout branch should keep fallback recovery');
  assert(
    timeoutResendIndex < timeoutAutoRecoveryIndex,
    'timeout resend must run before stopping or external auto recovery'
  );

  assert(
    injectSource.includes("await resendPromptAfterMissingResponse(\n                  'empty_response'"),
    'empty captured response should resend the previous prompt before manual invalid-response handling'
  );
}

function main() {
  testClassifierRecognizesLimitAndRestrictionMessages();
  testBlockedResultHelperAndPatchBuilder();
  testRetryableGenerationErrorClassifier();
  testInjectKeepsLimitClassifierInsideInjectedScope();
  testInjectResendsPromptBeforeManualNoResponseRecovery();
  console.log('test-background-rate-limit-blocking.js passed');
}

main();
