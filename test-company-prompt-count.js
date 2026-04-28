const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const repoDir = __dirname;
const backgroundPath = path.join(repoDir, 'background.js');
const promptsPath = path.join(repoDir, 'prompts-company.txt');
const stageMapPath = path.join(repoDir, 'COMPANY_CHAIN_STAGE_MAP.md');

const backgroundSource = fs.readFileSync(backgroundPath, 'utf8');
const promptsText = fs.readFileSync(promptsPath, 'utf8');
const stageMapText = fs.readFileSync(stageMapPath, 'utf8');

function extractFunctionSource(source, functionName) {
  const pattern = new RegExp(`(?:async\\s+)?function\\s+${functionName}\\s*\\(`);
  const match = pattern.exec(source);
  if (!match) {
    throw new Error(`Function not found: ${functionName}`);
  }

  const startIndex = match.index;
  const paramsStart = source.indexOf('(', startIndex);
  if (paramsStart < 0) {
    throw new Error(`Function params not found: ${functionName}`);
  }

  let parenDepth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;
  let braceStart = -1;

  for (let i = paramsStart; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
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
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
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
        braceStart = source.indexOf('{', i);
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

  for (let i = braceStart; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (char === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
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
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
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

function parsePromptChainText(rawText) {
  const normalizedText = typeof rawText === 'string'
    ? rawText.replace(/\uFEFF/g, '').replace(/\r\n?/g, '\n')
    : '';
  if (!normalizedText.trim()) return [];

  const promptSeparatorTokenSource = String.raw`PROMPT(?:[ _-]+)SEPARATOR`;
  const promptSeparatorPrefixSource = String.raw`(?:\u25C4|\u00E2\u2014\u201E)?[ \t-]*`;
  const promptSeparatorSuffixSource = String.raw`[ \t-]*(?:\u25BA|\u00E2\u2013\u015F)?`;
  const promptSeparatorLineRegex = new RegExp(
    String.raw`\n${promptSeparatorPrefixSource}${promptSeparatorTokenSource}${promptSeparatorSuffixSource}\n`,
    'g'
  );
  const promptSeparatorInlineRegex = new RegExp(
    `${promptSeparatorPrefixSource}${promptSeparatorTokenSource}${promptSeparatorSuffixSource}`,
    'g'
  );

  const splitAndClean = (text, separatorRegex) => text
    .split(separatorRegex)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  const lineSeparated = splitAndClean(normalizedText, promptSeparatorLineRegex);
  if (lineSeparated.length > 1) return lineSeparated;

  const inlineSeparated = splitAndClean(normalizedText, promptSeparatorInlineRegex);
  if (inlineSeparated.length > 1) return inlineSeparated;

  return [normalizedText.trim()];
}

function testCompanyPromptCatalogIsTwelvePrompts() {
  const prompts = parsePromptChainText(promptsText);
  assert.strictEqual(prompts.length, 12, 'Company prompt chain should contain exactly 12 prompts.');

  const stageMetadataBlockMatch = backgroundSource.match(/const STAGE_METADATA_COMPANY = \[[\s\S]*?\n\];/);
  assert(stageMetadataBlockMatch, 'Stage metadata block should exist.');

  const promptNumbers = [...stageMetadataBlockMatch[0].matchAll(/promptNumber:\s*(\d+)/g)].map((match) => Number(match[1]));
  assert.deepStrictEqual(
    promptNumbers,
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    'Stage metadata prompt numbers should align to the 12-prompt chain.'
  );

  assert(
    stageMapText.includes('## Prompt Index Mapping (12 prompts)'),
    'Stage map should document the same 12-prompt total.'
  );
}

function testResumeQueuePatchUsesNextPromptNumber() {
  const context = vm.createContext({
    console,
    Number,
    Math,
    String,
    Array,
    JSON,
    ANALYSIS_QUEUE_KIND_ARTICLE: 'article',
    ANALYSIS_QUEUE_KIND_RESUME_STAGE: 'resume_stage',
    PROMPTS_COMPANY: new Array(12).fill('prompt'),
    sanitizeAnalysisQueueJob(job) {
      return job;
    }
  });

  [
    'buildPendingPromptSnapshotFromStartIndex',
    'buildQueuedProcessPatchForJob'
  ].forEach((functionName) => {
    vm.runInContext(extractFunctionSource(backgroundSource, functionName), context, {
      filename: 'background.js'
    });
  });

  const firstPromptPatch = context.buildQueuedProcessPatchForJob({
    jobId: 'job-first',
    title: 'Resume first',
    analysisType: 'company',
    kind: 'resume_stage',
    createdAt: 1,
    resumeStartIndex: 0,
    resumeTargetTabId: 101
  });
  assert.strictEqual(firstPromptPatch.currentPrompt, 1);
  assert.strictEqual(firstPromptPatch.totalPrompts, 12);
  assert.strictEqual(firstPromptPatch.stageIndex, 0);
  assert.strictEqual(firstPromptPatch.stageName, 'Prompt 1');

  const finalPromptPatch = context.buildQueuedProcessPatchForJob({
    jobId: 'job-final',
    title: 'Resume final',
    analysisType: 'company',
    kind: 'resume_stage',
    createdAt: 1,
    resumeStartIndex: 11,
    resumeTargetTabId: 202
  });
  assert.strictEqual(finalPromptPatch.currentPrompt, 12);
  assert.strictEqual(finalPromptPatch.totalPrompts, 12);
  assert.strictEqual(finalPromptPatch.stageIndex, 11);
  assert.strictEqual(finalPromptPatch.stageName, 'Prompt 12');
}

function main() {
  testCompanyPromptCatalogIsTwelvePrompts();
  testResumeQueuePatchUsesNextPromptNumber();
  console.log('test-company-prompt-count.js: ok');
}

main();
