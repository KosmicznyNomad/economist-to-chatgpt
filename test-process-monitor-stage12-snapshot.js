const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const monitorPath = path.join(__dirname, 'process-monitor.js');
const monitorSource = fs.readFileSync(monitorPath, 'utf8');

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
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

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

const context = { console };
vm.createContext(context);
['mapStage12Record', 'buildProcessCompanySnapshotFromProcess'].forEach((functionName) => {
  vm.runInContext(extractFunctionSource(monitorSource, functionName), context);
});

function testProcessSnapshotBypassesStorageScan() {
  const snapshot = context.buildProcessCompanySnapshotFromProcess({
    id: 'run-123',
    title: 'Alpha source',
    finishedAt: 1_710_000_000_000,
    completedStage12Snapshot: {
      company: 'Alpha Corp (ALP)',
      status: 'valid',
      issueCodes: [],
      recordCount: 1,
      recordFormats: ['current16'],
      hasDecisionRecord: true,
      records: [
        {
          decisionRole: 'PRIMARY',
          company: 'Alpha Corp (ALP)',
          decisionStatus: 'WATCH',
          decisionDate: '2026-03-20',
          composite: '4.2/5.0'
        }
      ]
    }
  });

  assert(snapshot);
  assert.strictEqual(snapshot.processId, 'run-123');
  assert.strictEqual(snapshot.responseTimestamp, 1_710_000_000_000);
  assert.strictEqual(snapshot.company, 'Alpha Corp (ALP)');
  assert.strictEqual(snapshot.decisionContractStatus, 'valid');
  assert.strictEqual(snapshot.hasDecisionRecord, true);
  assert.strictEqual(snapshot.stage12Records.length, 1);
  assert.strictEqual(snapshot.stage12Records[0].decisionRole, 'PRIMARY');
}

function main() {
  testProcessSnapshotBypassesStorageScan();
  console.log('test-process-monitor-stage12-snapshot.js passed');
}

main();
