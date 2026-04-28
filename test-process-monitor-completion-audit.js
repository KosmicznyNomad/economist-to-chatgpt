const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourcePath = path.join(__dirname, 'process-monitor.js');
const source = fs.readFileSync(sourcePath, 'utf8');

function extractFunctionSource(fileSource, functionName) {
  const pattern = new RegExp(`function\\s+${functionName}\\s*\\(`);
  const match = pattern.exec(fileSource);
  if (!match) {
    throw new Error(`Function not found: ${functionName}`);
  }

  let depth = 0;
  let startBody = -1;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;

  for (let i = match.index; i < fileSource.length; i += 1) {
    const char = fileSource[i];
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
    if (char === '{') {
      if (startBody === -1) startBody = i;
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (startBody !== -1 && depth === 0) {
        return fileSource.slice(match.index, i + 1);
      }
    }
  }

  throw new Error(`Function end not found: ${functionName}`);
}

const context = vm.createContext({
  console,
  Date,
  formatDateTime(ts) {
    if (!Number.isInteger(ts) || ts <= 0) return '-';
    return new Date(ts).toISOString();
  },
  shortenText(text, maxLength = 96) {
    const value = typeof text === 'string' ? text.trim() : '';
    if (!value) return '';
    if (value.length <= maxLength) return value;
    return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
  }
});

[
  'getProcessCompletionAuditStateLabel',
  'getProcessCompletionAuditLevel',
  'formatProcessCompletionAuditText'
].forEach((functionName) => {
  vm.runInContext(extractFunctionSource(source, functionName), context, {
    filename: 'process-monitor.js'
  });
});

function main() {
  const text = context.formatProcessCompletionAuditText({
    overallState: 'dispatch_pending',
    updatedAt: 1776070000000,
    hasResponse: true,
    responseCapturedAt: 1776069990000,
    saveState: 'saved',
    saveUpdatedAt: 1776069995000,
    dispatchState: 'dispatch_pending',
    dispatchConfirmed: false,
    verifyState: 'http_accepted',
    dispatchAccepted: 1,
    dispatchSent: 1,
    dispatchPending: 0,
    dispatchFailed: 0,
    dispatchUpdatedAt: 1776070000000,
    windowCloseState: 'retrying',
    windowCloseAttempts: 2,
    windowCloseLastAttemptAt: 1776070001000,
    windowCloseError: 'window_contains_other_tabs',
    checkpoints: [
      { code: 'response', state: 'captured', ts: 1776069990000 },
      { code: 'save_local', state: 'saved', ts: 1776069995000 },
      { code: 'dispatch', state: 'dispatch_pending', ts: 1776070000000 },
      { code: 'window_close', state: 'retrying', ts: 1776070001000 }
    ]
  });

  assert(text.includes('Ogolnie: dispatch oczekuje'));
  assert(text.includes('Baza: dispatch=dispatch oczekuje'));
  assert(text.includes('verify=http_accepted'));
  assert(text.includes('Okno: window=retrying'));
  assert(text.includes('window_contains_other_tabs'));
  assert.strictEqual(context.getProcessCompletionAuditLevel({ overallState: 'dispatch_confirmed_window_closed' }), 'ok');
  assert.strictEqual(context.getProcessCompletionAuditLevel({ overallState: 'dispatch_failed' }), 'err');
  console.log('test-process-monitor-completion-audit.js: ok');
}

main();
