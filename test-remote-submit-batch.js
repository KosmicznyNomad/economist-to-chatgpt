const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const backgroundPath = path.join(__dirname, 'background.js');
const backgroundSource = fs.readFileSync(backgroundPath, 'utf8');
const RemoteContractUtils = require('./remote-contract.js');

function extractFunctionSource(source, functionName) {
  const pattern = new RegExp(`(?:async\\s+)?function\\s+${functionName}\\s*\\(`);
  const match = pattern.exec(source);
  if (!match) {
    throw new Error(`Function not found: ${functionName}`);
  }
  const startIndex = match.index;
  const paramsStart = source.indexOf('(', match.index);
  let depth = 0;
  let braceStart = -1;
  for (let i = paramsStart; i < source.length; i += 1) {
    const char = source[i];
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        braceStart = source.indexOf('{', i);
        break;
      }
    }
  }
  if (braceStart < 0) {
    throw new Error(`Function body not found: ${functionName}`);
  }

  depth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let escaped = false;
  for (let i = braceStart; i < source.length; i += 1) {
    const char = source[i];
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
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startIndex, i + 1);
      }
    }
  }
  throw new Error(`Function end not found: ${functionName}`);
}

function buildContext() {
  const capturedPayloads = [];
  const context = {
    console,
    Date,
    REMOTE_ERROR_PDF_NOT_SUPPORTED: 'remote_pdf_not_supported_yet',
    RemoteContractUtils,
    RemoteBatchStorageUtils: {
      buildBatchRecord: (record) => record
    },
    getRemoteRunnerConfig: async () => ({
      remoteDefaultRunnerId: 'runner-b'
    }),
    ensureCompanyPromptsReady: async () => true,
    ensureExtensionInstallationId: async () => 'controller-a',
    buildRemotePromptSnapshotMeta: async () => ({
      promptsLoaded: true,
      promptChainSnapshot: ['prompt-1'],
      promptHash: 'sha256:prompt'
    }),
    fetchRemoteRunnerStatusRemote: async () => ({
      success: true,
      body: {
        runner: {
          queueable: true,
          state: 'ready'
        }
      }
    }),
    createRemoteJobRemote: async (payload) => {
      capturedPayloads.push(JSON.parse(JSON.stringify(payload)));
      return {
        success: true,
        body: {
          job: {
            jobId: payload.jobId,
            runId: payload.runId,
            batchId: payload.batchId,
            instanceIndex: payload.instanceIndex
          }
        }
      };
    },
    storeRemoteBatchRecord: async (record) => record
  };
  vm.createContext(context);
  vm.runInContext(extractFunctionSource(backgroundSource, 'submitRemoteManualBatch'), context, {
    filename: 'background.js'
  });
  return { context, capturedPayloads };
}

async function testSubmitRemoteManualBatchBuildsStableDedupeKeys() {
  const { context, capturedPayloads } = buildContext();
  const result = await context.submitRemoteManualBatch('hello world', 'Acme', 2, {
    submissionId: 'rsubmit-fixed',
    sourceKind: 'article'
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.createdCount, 2);
  assert.strictEqual(capturedPayloads.length, 2);
  assert.strictEqual(capturedPayloads[0].submissionId, 'rsubmit-fixed');
  assert.strictEqual(capturedPayloads[0].requestDedupeKey, 'rsubmit-fixed:1');
  assert.strictEqual(capturedPayloads[1].requestDedupeKey, 'rsubmit-fixed:2');
  assert.strictEqual(capturedPayloads[0].batchId, 'rbatch-rsubmit-fixed');
  assert.strictEqual(capturedPayloads[0].jobId, 'rjob-rsubmit-fixed-1');
  assert.strictEqual(capturedPayloads[0].runId, 'run-rsubmit-fixed-1');
}

async function testSubmitRemoteManualBatchRejectsRemotePdf() {
  const { context } = buildContext();
  const result = await context.submitRemoteManualBatch('hello world', 'Acme', 1, {
    submissionId: 'rsubmit-fixed',
    sourceKind: 'manual_pdf'
  });

  assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), {
    success: false,
    error: 'remote_pdf_not_supported_yet'
  });
}

async function main() {
  await testSubmitRemoteManualBatchBuildsStableDedupeKeys();
  await testSubmitRemoteManualBatchRejectsRemotePdf();
  console.log('test-remote-submit-batch.js: ok');
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
