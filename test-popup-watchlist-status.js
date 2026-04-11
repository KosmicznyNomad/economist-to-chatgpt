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
  const paramsStart = source.indexOf('(', startIndex);
  let parenDepth = 0;
  let braceStart = -1;
  for (let index = paramsStart; index < source.length; index += 1) {
    const char = source[index];
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
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
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

function main() {
  const context = {
    console,
    Date,
    formatLastDispatchFlush: () => 'brak',
    formatDispatchErrorText: (value) => String(value || ''),
    formatLatestDispatchProcessLog: () => '',
    getDispatchReasonLabel: () => ''
  };
  vm.createContext(context);
  [
    'tokenSourceLabel',
    'safePreview',
    'formatDispatchConfigSources',
    'formatDispatchStatus'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(popupSource, functionName), context, {
      filename: 'popup.js'
    });
  });

  const text = context.formatDispatchStatus({
    success: true,
    enabled: true,
    configured: true,
    tokenSource: 'inline_config',
    intakeUrlSource: 'inline_config',
    keyIdSource: 'inline_config',
    intakeUrl: 'https://iskierka-watchlist.duckdns.org/api/v1/intake/economist-response',
    keyId: 'extension-primary',
    queueSize: 0,
    lastFlush: null,
    recentProcessLogs: []
  });

  assert.match(text, /Zrodla: URL=inline config, Key ID=inline config, Token=inline config\./);
  assert.match(text, /URL: https:\/\/iskierka-watchlist\.duckdns\.org/);
  console.log('test-popup-watchlist-status.js: ok');
}

main();
