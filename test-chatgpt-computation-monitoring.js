const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function extractFunctionSource(source, functionName) {
  const pattern = new RegExp(`function\\s+${functionName}\\s*\\(`);
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

function loadFunctions(filePath, functionNames) {
  const source = fs.readFileSync(filePath, 'utf8');
  const context = { console, Number, String, Object, RegExp, Date };
  vm.createContext(context);
  functionNames.forEach((functionName) => {
    vm.runInContext(extractFunctionSource(source, functionName), context, { filename: path.basename(filePath) });
  });
  return context;
}

function testApplyChatGptComputationStatePatch() {
  const backgroundPath = path.join(__dirname, 'background.js');
  const ctx = loadFunctions(backgroundPath, [
    'normalizeComposerThinkingEffort',
    'normalizeChatGptMonitoringLabel',
    'normalizeChatGptModeKind',
    'normalizeChatGptPlanHint',
    'applyChatGptComputationStatePatch'
  ]);

  const patch = {};
  ctx.applyChatGptComputationStatePatch(patch, {
    composerThinkingEffort: 'HEAVY',
    chatGptModeKind: 'Thinking',
    chatGptPlanHint: 'Pro',
    chatGptModeLabel: 'Thinking',
    chatGptModelSwitcherLabel: 'ChatGPT Pro',
    chatGptThinkingEffortDetected: 'Heavy',
    chatGptThinkingEffortLabel: 'Heavy',
    chatGptComputationLabel: 'ChatGPT Pro | Thinking | Thinking Heavy',
    chatGptComputationDetectedAt: 123456789
  });

  assert.deepStrictEqual(patch, {
    composerThinkingEffort: 'heavy',
    chatGptModeKind: 'thinking',
    chatGptPlanHint: 'pro',
    chatGptModeLabel: 'Thinking',
    chatGptModelSwitcherLabel: 'ChatGPT Pro',
    chatGptThinkingEffortDetected: 'heavy',
    chatGptThinkingEffortLabel: 'Heavy',
    chatGptComputationLabel: 'ChatGPT Pro | Thinking | Thinking Heavy',
    chatGptComputationDetectedAt: 123456789
  });
}

function testFormatChatGptComputationSummary() {
  const monitorPath = path.join(__dirname, 'process-monitor.js');
  const ctx = loadFunctions(monitorPath, [
    'humanizeChatGptModeKind',
    'humanizeThinkingEffort',
    'formatChatGptComputationSummary'
  ]);

  const summary = ctx.formatChatGptComputationSummary({
    composerThinkingEffort: 'extended',
    chatGptModeKind: 'thinking',
    chatGptModelSwitcherLabel: 'ChatGPT Pro',
    chatGptThinkingEffortDetected: 'heavy'
  });

  assert.strictEqual(
    summary,
    'Model ChatGPT Pro | Tryb Thinking | Thinking Heavy (req Extended)'
  );
}

function main() {
  testApplyChatGptComputationStatePatch();
  testFormatChatGptComputationSummary();
  console.log('test-chatgpt-computation-monitoring.js passed');
}

main();
