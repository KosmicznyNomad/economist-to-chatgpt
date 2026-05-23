const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const popupPath = path.join(__dirname, 'popup.js');
const popupSource = fs.readFileSync(popupPath, 'utf8');

function extractConstSource(source, constName) {
  const pattern = new RegExp(`const\\s+${constName}\\s*=`);
  const match = pattern.exec(source);
  if (!match) {
    throw new Error(`Const not found: ${constName}`);
  }
  const startIndex = match.index;
  const endIndex = source.indexOf(';\n', startIndex);
  if (endIndex < 0) {
    throw new Error(`Const end not found: ${constName}`);
  }
  return source.slice(startIndex, endIndex + 2);
}

function extractFunctionSource(source, functionName) {
  const pattern = new RegExp(`function\\s+${functionName}\\s*\\(`);
  const match = pattern.exec(source);
  if (!match) {
    throw new Error(`Function not found: ${functionName}`);
  }
  const startIndex = match.index;
  let parenDepth = 0;
  let braceStart = -1;
  for (let index = match.index; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') {
      parenDepth += 1;
      continue;
    }
    if (char === ')') {
      parenDepth -= 1;
      continue;
    }
    if (char === '{' && parenDepth === 0) {
      braceStart = index;
      break;
    }
  }
  if (braceStart === -1) {
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

function main() {
  const context = vm.createContext({
    console,
    Math,
    Number,
    String,
    Array,
    DISPATCH_REASON_LABELS: {
      expected_records_missing: 'brak oczekiwanych rekordow materializacji',
      materialization_unavailable: 'materializacja DB niedostepna',
      missing_fields: 'braki danych po stronie intake',
      mismatch: 'niezgodnosc danych verify',
      ingest_failed: 'ingest zakonczony bledem',
      ingest_quarantined: 'ingest zakonczony kwarantanna'
    }
  });

  [
    'safePreview',
    'normalizeDispatchToken',
    'humanizeDispatchToken',
    'getDispatchReasonLabel',
    'formatFinalStagePersistenceStatus',
    'formatCopyLatestInvestFinalResponseStatus'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(popupSource, functionName), context, {
      filename: 'popup.js'
    });
  });

  const batchStatus = context.formatCopyLatestInvestFinalResponseStatus({
    batch: true,
    requested: 4,
    copied: 3,
    failed: 1,
    windowCount: 4,
    textLength: 1200,
    conversationUrlCount: 3,
    persistenceAttemptedCount: 3,
    localSaveSuccessCount: 3,
    intakeAcceptedCount: 2,
    verifiedDbCount: 1,
    terminalFailureCount: 1,
    results: [
      { success: true, title: 'Alpha' },
      { success: true, title: 'Beta' },
      { success: true, title: 'Gamma' },
      { success: false, title: 'Delta', error: 'not_final_stage' }
    ]
  });

  assert(batchStatus.includes('Lokalny zapis: 3/3 OK.'));
  assert(batchStatus.includes('Intake accepted: 2/3.'));
  assert(batchStatus.includes('DB verified: 1/3.'));
  assert(batchStatus.includes('Terminal DB errors: 1.'));
  assert(!batchStatus.includes('Fallback save'));

  const batchStatusDerivedFromResults = context.formatCopyLatestInvestFinalResponseStatus({
    batch: true,
    requested: 4,
    copied: 4,
    failed: 0,
    windowCount: 4,
    textLength: 1600,
    conversationUrlCount: 4,
    persistenceAttemptedCount: 4,
    localSaveSuccessCount: 1,
    intakeAcceptedCount: 1,
    verifiedDbCount: 1,
    terminalFailureCount: 0,
    results: [
      {
        success: true,
        title: 'Alpha',
        persistence: { attempted: true, success: true, localSaveOk: true, acceptedByIntake: true, verifiedInDb: true, terminalFailure: false }
      },
      {
        success: true,
        title: 'Beta',
        persistence: { attempted: true, success: true, localSaveOk: true, acceptedByIntake: true, verifiedInDb: false, terminalFailure: false }
      },
      {
        success: true,
        title: 'Gamma',
        persistence: { attempted: true, success: true, localSaveOk: true, acceptedByIntake: false, verifiedInDb: false, terminalFailure: false }
      },
      {
        success: true,
        title: 'Delta',
        persistence: { attempted: true, success: true, localSaveOk: true, acceptedByIntake: false, verifiedInDb: false, terminalFailure: false }
      }
    ]
  });

  assert(batchStatusDerivedFromResults.includes('Lokalny zapis: 4/4 OK.'));
  assert(batchStatusDerivedFromResults.includes('Intake accepted: 2/4.'));
  assert(batchStatusDerivedFromResults.includes('DB verified: 1/4.'));

  const acceptedButUnverified = context.formatFinalStagePersistenceStatus({
    success: true,
    accepted: 1,
    sent: 1,
    failed: 0,
    pending: 0,
    verifyState: 'http_accepted'
  });

  assert(!acceptedButUnverified.includes('BAZA OK'));
  assert(acceptedButUnverified.includes('verify DB nadal niepotwierdzone'));

  const verified = context.formatFinalStagePersistenceStatus({
    success: true,
    accepted: 1,
    sent: 1,
    failed: 0,
    pending: 0,
    verifyState: 'verified'
  });

  assert(verified.includes('BAZA OK'));

  const singleRetryStatus = context.formatCopyLatestInvestFinalResponseStatus({
    success: true,
    title: 'Invest Alpha',
    textLength: 321,
    conversationUrl: 'https://chatgpt.com/c/invest-alpha',
    persistence: {
      attempted: true,
      success: true,
      localSaveOk: true,
      mode: 'retry_existing_dispatch',
      acceptedByIntake: true,
      verifiedInDb: false,
      terminalFailure: false
    }
  });

  assert(singleRetryStatus.includes('Recovery: Retry dispatch.'));
  assert(singleRetryStatus.includes('DB verified: pending.'));

  console.log('test-popup-copy-latest-invest-status.js: ok');
}

main();
