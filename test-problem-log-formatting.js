const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const problemLogPath = path.join(__dirname, 'problem-log.js');
const problemLogSource = fs.readFileSync(problemLogPath, 'utf8');

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

function extractConstObject(source, constName) {
  const pattern = new RegExp(`const\\s+${constName}\\s*=\\s*\\{`);
  const match = pattern.exec(source);
  if (!match) {
    throw new Error(`Const not found: ${constName}`);
  }
  const startIndex = match.index;
  const braceStart = source.indexOf('{', startIndex);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const endIndex = source.indexOf(';', index);
        return source.slice(startIndex, endIndex + 1);
      }
    }
  }
  throw new Error(`Const end not found: ${constName}`);
}

function main() {
  const context = { console };
  vm.createContext(context);
  vm.runInContext(extractConstObject(problemLogSource, 'REASON_LABELS'), context, {
    filename: 'problem-log.js'
  });
  [
    'humanizeReasonToken',
    'getReasonLabel',
    'formatReason'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(problemLogSource, functionName), context, {
      filename: 'problem-log.js'
    });
  });

  assert.strictEqual(
    context.formatReason({ reason: 'state_progress', heartbeat: true }),
    'pulse | nadal w toku'
  );
  assert.strictEqual(
    context.formatReason({ reason: 'stuck_same_prompt' }),
    'utknal na tym samym prompcie - wymaga wznowienia'
  );
  assert.strictEqual(
    context.formatReason({ reason: 'continue_button' }),
    'wymaga Continue'
  );
  console.log('test-problem-log-formatting.js: ok');
}

main();
