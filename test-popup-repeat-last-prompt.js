const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const popupPath = path.join(__dirname, 'popup.js');
const popupSource = fs.readFileSync(popupPath, 'utf8');

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

function createContext() {
  const runtimeMessages = [];
  const statuses = [];
  const context = {
    console,
    Object,
    Promise,
    createReloadResumeMonitorSessionId(origin) {
      return `monitor:${origin}`;
    },
    async sendRuntimeMessage(message) {
      runtimeMessages.push(message);
      return {};
    },
    setRunStatus(message, isError = false) {
      statuses.push({ message, isError });
    },
    getResumeAllSummary() {
      return 'summary';
    }
  };
  vm.createContext(context);
  vm.runInContext(extractFunctionSource(popupSource, 'executeRepeatLastPromptAllFromPopup'), context, {
    filename: 'popup.js'
  });
  return { context, runtimeMessages, statuses };
}

function toPlainObject(value) {
  return JSON.parse(JSON.stringify(value));
}

async function testRepeatLastPromptUsesStoredEffortByDefault() {
  const { context, runtimeMessages, statuses } = createContext();
  const button = { disabled: false, textContent: 'Powtorz ostatni prompt (wszystkie)' };

  await context.executeRepeatLastPromptAllFromPopup(button);

  assert.strictEqual(runtimeMessages.length, 1);
  assert.deepStrictEqual(toPlainObject(runtimeMessages[0]), {
    type: 'DETECT_LAST_COMPANY_PROMPT_AND_RESUME',
    origin: 'popup-repeat-last-prompt-all',
    scope: 'active_company_invest_processes',
    forceRepeatLastPrompt: true,
    monitorSessionId: 'monitor:popup-repeat-last-prompt-all',
    openMonitorWindow: true,
    useStoredComposerThinkingEffort: true
  });
  assert.strictEqual(button.disabled, false);
  assert.strictEqual(button.textContent, 'Powtorz ostatni prompt (wszystkie)');
  assert.strictEqual(statuses[0].isError, false);
}

async function testRepeatLastPromptForwardsExplicitEffort() {
  const { context, runtimeMessages } = createContext();
  const button = { disabled: false, textContent: 'Powtorz ostatni prompt (wszystkie)' };

  await context.executeRepeatLastPromptAllFromPopup(button, {
    origin: 'popup-test',
    composerThinkingEffort: '  HEAVY  '
  });

  assert.strictEqual(runtimeMessages.length, 1);
  assert.strictEqual(runtimeMessages[0].origin, 'popup-test');
  assert.strictEqual(runtimeMessages[0].composerThinkingEffort, 'heavy');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(runtimeMessages[0], 'useStoredComposerThinkingEffort'), false);
}

async function main() {
  await testRepeatLastPromptUsesStoredEffortByDefault();
  await testRepeatLastPromptForwardsExplicitEffort();
  console.log('test-popup-repeat-last-prompt.js passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
