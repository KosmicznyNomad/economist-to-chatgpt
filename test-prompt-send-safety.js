const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const backgroundPath = path.join(__dirname, 'background.js');
const backgroundSource = fs.readFileSync(backgroundPath, 'utf8');

function extractFunctionSource(source, functionName) {
  const pattern = new RegExp(`(?:async\\s+)?function\\s+${functionName}\\s*\\(`);
  const match = pattern.exec(source);
  if (!match) throw new Error(`Function not found: ${functionName}`);

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
    if (char === '(') parenDepth += 1;
    if (char === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        braceStart = source.indexOf('{', index);
        break;
      }
    }
  }

  if (braceStart < 0) throw new Error(`Function body not found: ${functionName}`);

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
      if (depth === 0) return source.slice(startIndex, index + 1);
    }
  }

  throw new Error(`Function end not found: ${functionName}`);
}

class MockElement {
  constructor(options = {}) {
    this.tagName = options.tagName || 'DIV';
    this.attrs = { ...(options.attrs || {}) };
    this.textContent = options.textContent || '';
    this.innerText = options.innerText || this.textContent;
    this.disabled = options.disabled === true;
    this.readOnly = options.readOnly === true;
    this.isContentEditable = options.isContentEditable === true;
    this.id = options.id || this.attrs.id || '';
    this.inComposer = options.inComposer === true;
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  }

  getBoundingClientRect() {
    return { width: 120, height: 32 };
  }

  closest(selector) {
    if (selector === '[aria-hidden="true"]') return null;
    if (this.inComposer && (selector === 'form' || selector === 'footer' || selector.includes('composer'))) {
      return this;
    }
    return null;
  }

  querySelectorAll() {
    return [];
  }

  matches() {
    return false;
  }

  contains(node) {
    return node === this;
  }
}

function makeDocument(state) {
  const editor = state.editorReady === false
    ? null
    : new MockElement({
        tagName: 'TEXTAREA',
        attrs: { id: 'prompt-textarea' }
      });
  const stopButton = new MockElement({
    tagName: 'BUTTON',
    attrs: { 'data-testid': 'stop-button', 'aria-label': 'Stop generating' },
    textContent: 'Stop generating',
    inComposer: true
  });
  const continueButton = new MockElement({
    tagName: 'BUTTON',
    attrs: { 'aria-label': 'Continue generating' },
    textContent: 'Continue generating'
  });
  const users = Array.from({ length: state.userCount || 0 }, (_, index) => new MockElement({
    attrs: { 'data-message-author-role': 'user' },
    textContent: `user ${index + 1}`
  }));
  const assistants = Array.from({ length: state.assistantCount || 0 }, (_, index) => new MockElement({
    attrs: { 'data-message-author-role': 'assistant' },
    textContent: `assistant ${index + 1}`
  }));

  function querySelectorAll(selector) {
    if (selector.includes('[data-message-author-role="user"]')) return users;
    if (selector.includes('[data-message-author-role="assistant"]')) return assistants;
    if (selector === '[role="alert"]' || selector === '[role="status"]') return [];
    if (selector.includes('stop-button') || selector.includes('Stop generating')) {
      return state.generatingStop ? [stopButton] : [];
    }
    if (selector === 'button') {
      return state.continueButton ? [continueButton] : [];
    }
    if (
      selector.includes('textarea') ||
      selector.includes('[role="textbox"]') ||
      selector.includes('[contenteditable]')
    ) {
      return editor ? [editor] : [];
    }
    return [];
  }

  return {
    querySelectorAll,
    querySelector(selector) {
      return querySelectorAll(selector)[0] || null;
    }
  };
}

function loadContext() {
  const computedStyle = () => ({
    display: 'block',
    visibility: 'visible',
    opacity: '1',
    pointerEvents: 'auto'
  });
  const context = vm.createContext({
    console,
    Array,
    Date,
    Number,
    Object,
    RegExp,
    Set,
    String,
    HTMLElement: MockElement,
    Element: MockElement,
    window: { getComputedStyle: computedStyle },
    document: makeDocument({ userCount: 1, assistantCount: 1, editorReady: true }),
    getComputedStyle: computedStyle
  });

  [
    'compactText',
    'normalizeChatGptActionText',
    'getLastTurnContainer',
    'normalizeDomText',
    'isElementVisibleForInteraction',
    'getElementReadableText',
    'getLastAssistantMessageElement',
    'isInComposerArea',
    'isInLastAssistantMessage',
    'isElementVisibleForStatus',
    'findVisibleGenerationIndicator',
    'hasPendingUserTurnByDom',
    'findActiveStopButton',
    'isGenerating',
    'findPromptComposerEditor',
    'findChatGptContinueGeneratingButton',
    'getLastTurnState',
    'getPromptSendSafetyState'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
      filename: 'background.js'
    });
  });

  return context;
}

function main() {
  const ctx = loadContext();

  ctx.document = makeDocument({ userCount: 1, assistantCount: 1, editorReady: true });
  const balanced = ctx.getPromptSendSafetyState();
  assert.strictEqual(balanced.unsafeReasons.length, 0);
  assert.strictEqual(balanced.safe, true);

  ctx.document = makeDocument({ userCount: 2, assistantCount: 1, editorReady: true });
  const pending = ctx.getPromptSendSafetyState();
  assert.strictEqual(pending.safe, false);
  assert(pending.unsafeReasons.includes('pending_user_turn'));

  const resendAllowed = ctx.getPromptSendSafetyState({ allowPendingUserTurn: true });
  assert.strictEqual(resendAllowed.safe, true);

  ctx.document = makeDocument({ userCount: 1, assistantCount: 1, editorReady: true, generatingStop: true });
  const generating = ctx.getPromptSendSafetyState({ allowPendingUserTurn: true });
  assert.strictEqual(generating.safe, false);
  assert(generating.unsafeReasons.includes('generating:stopButton'));

  ctx.document = makeDocument({ userCount: 1, assistantCount: 1, editorReady: true, continueButton: true });
  const continueVisible = ctx.getPromptSendSafetyState();
  assert.strictEqual(continueVisible.safe, false);
  assert(continueVisible.unsafeReasons.includes('continue_generating_button'));

  ctx.document = makeDocument({ userCount: 1, assistantCount: 1, editorReady: false });
  const noEditor = ctx.getPromptSendSafetyState();
  assert.strictEqual(noEditor.safe, false);
  assert(noEditor.unsafeReasons.includes('editor_not_ready'));

  assert(backgroundSource.includes('allowStaleGeneratingReady = waitOptions.allowStaleGeneratingReady === true'));
  assert(backgroundSource.includes('const generationLooksStale = allowStaleGeneratingReady && generationLooksStaleBase'));
  assert(backgroundSource.includes('const preClickSendSafety = getPromptSendSafetyState(sendSafetyOptions)'));
  console.log('test-prompt-send-safety.js passed');
}

main();
