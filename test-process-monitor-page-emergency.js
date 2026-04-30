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

const context = vm.createContext({ console });

vm.runInContext(`
const reasonLabels = {
  page_emergency_only: 'Final tylko w awaryjnym zapisie strony'
};
const persistenceErrorLabels = {
  runtime_unavailable: 'most runtime niedostepny',
  runtime_timeout: 'timeout mostu runtime',
  save_failed: 'blad zapisu',
  page_emergency_only: 'tylko awaryjny zapis w stronie',
  local_storage_unavailable: 'local storage rozszerzenia niedostepny'
};
function getProcessContract(process) {
  return {
    lifecycleStatus: typeof process?.lifecycleStatus === 'string'
      ? process.lifecycleStatus
      : (typeof process?.status === 'string' ? process.status : 'running'),
    phase: typeof process?.phase === 'string' ? process.phase : '',
    actionRequired: typeof process?.actionRequired === 'string' ? process.actionRequired : 'none',
    statusCode: typeof process?.statusCode === 'string' ? process.statusCode : '',
    statusText: typeof process?.statusText === 'string' ? process.statusText : ''
  };
}
function getProcessLifecycleStatus(process) {
  return getProcessContract(process).lifecycleStatus;
}
function getNormalizedStatus(process) {
  return getProcessLifecycleStatus(process);
}
function isCompletedStatus(status) {
  return ['completed', 'finalizing'].includes(typeof status === 'string' ? status : '');
}
`, context);

[
  'normalizeCodeToken',
  'humanizeToken',
  'getReasonLabel',
  'getPersistenceErrorLabel',
  'getProcessEmergencyPersistence',
  'shortenText',
  'buildProcessReasonLine',
  'getPersistenceLogLines',
  'parseDispatchCountFromSummary',
  'resolveProcessDatabaseDelivery',
  'getDatabaseBadgeModel'
].forEach((functionName) => {
  vm.runInContext(extractFunctionSource(source, functionName), context, {
    filename: 'process-monitor.js'
  });
});

function main() {
  const responseId = 'queue-article-1777276072552-aa69t4cm_p12_5ae4c000';
  const process = {
    id: 'queue-article-1777276072552-aa69t4cm',
    status: 'stopped',
    reason: 'page_emergency_only',
    completedResponseSaved: false,
    persistenceStatus: {
      saveOk: false,
      saveError: 'runtime_unavailable',
      bridgeError: 'runtime_unavailable',
      responseId,
      emergencyLocalSave: {
        success: false,
        reason: 'Extension context invalidated'
      },
      emergencyPageSave: {
        success: true,
        responseId,
        queueSize: 1
      },
      emergencyLocalOk: false,
      emergencyPageOk: true,
      pageEmergencyOnly: true
    }
  };

  const lines = context.getPersistenceLogLines(process, 4);
  assert(lines[0].includes('Baza: NIE wyslano'));
  assert(lines[0].includes('page localStorage'));
  assert(lines[0].includes(responseId));
  assert(lines[1].includes('Akcja: przeladuj rozszerzenie'));

  const delivery = context.resolveProcessDatabaseDelivery(process);
  assert.strictEqual(delivery.saveOk, false);
  assert.strictEqual(delivery.pageEmergencyOnly, true);
  assert.strictEqual(delivery.emergencyPageOk, true);
  assert.strictEqual(delivery.emergencyLocalOk, false);
  assert.strictEqual(delivery.responseId, responseId);

  const badge = context.getDatabaseBadgeModel(process);
  assert.strictEqual(badge.visible, true);
  assert.strictEqual(badge.text, 'Baza: PAGE-EMERGENCY');
  assert.strictEqual(badge.className, 'db-badge db-warning');
  assert(badge.detailText.includes('NIE wyslano finalu'));
  assert(badge.detailText.includes(responseId));

  const reasonLine = context.buildProcessReasonLine(process);
  assert(reasonLine.includes('Final tylko w awaryjnym zapisie strony'));
  assert(reasonLine.includes('page=awaryjny zapis strony'));
  assert(reasonLine.includes('save=most runtime niedostepny'));

  console.log('test-process-monitor-page-emergency.js: ok');
}

main();
