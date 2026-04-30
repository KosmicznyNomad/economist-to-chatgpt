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

function testCompanyPromptCatalogIsEighteenPrompts() {
  const prompts = parsePromptChainText(promptsText);
  assert.strictEqual(prompts.length, 18, 'Company prompt chain should contain exactly 18 prompts.');

  const stageMetadataBlockMatch = backgroundSource.match(/const DEFAULT_STAGE_METADATA_COMPANY = \[[\s\S]*?\n\];/);
  assert(stageMetadataBlockMatch, 'Stage metadata block should exist.');

  const promptNumbers = [...stageMetadataBlockMatch[0].matchAll(/promptNumber:\s*(\d+)/g)].map((match) => Number(match[1]));
  assert.deepStrictEqual(
    promptNumbers,
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    'Stage metadata prompt numbers should align to the 18-prompt chain.'
  );
  const stageIds = [...stageMetadataBlockMatch[0].matchAll(/stageId:\s*'([^']+)'/g)].map((match) => match[1]);
  assert.deepStrictEqual(
    stageIds,
    ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15', '16', '17'],
    'Stage metadata ids should use consecutive numeric stage ids in prompt order.'
  );

  assert(
    stageMapText.includes('## Prompt Index Mapping (18 prompts)'),
    'Stage map should document the same 18-prompt total.'
  );
  assert(
    backgroundSource.includes('function refreshCompanyStageMetadataFromPrompts'),
    'Runtime should refresh stage metadata from loaded prompts.'
  );
}

function testMcpWritePromptsUseIskierkaToolNames() {
  const prompts = parsePromptChainText(promptsText);
  const stage14RecordPrompt = prompts[14] || '';
  const stage15WritePrompt = prompts[15] || '';
  const stage17WritePrompt = prompts[17] || '';

  assert(
    stage14RecordPrompt.includes('"schema": "economist.response.v2"'),
    'Stage 14 should emit the structured economist.response.v2 schema used by copy/replay.'
  );
  assert(
    stage14RecordPrompt.includes('schema musi mieć wartość economist.response.v2'),
    'Stage 14 final instruction should require the schema field.'
  );

  assert(
    stage15WritePrompt.includes('stage12_research_rows.upsert'),
    'Stage 15 should point at the dedicated Iskierka stage12_research_rows.upsert tool.'
  );
  assert(
    stage15WritePrompt.includes('Użyj MCP server:\n\niskierka'),
    'Stage 15 should target the Iskierka MCP server.'
  );
  assert(
    stage15WritePrompt.includes('stage12_research_rows_upsert'),
    'Stage 15 should include the current Claude-safe stage12_research_rows_upsert tool name.'
  );
  assert(
    stage15WritePrompt.includes('Stage 14 / Prompt 15 z 18'),
    'Stage 15 should identify the generated Stage 14 source by the new 18-prompt structure.'
  );
  assert(
    stage15WritePrompt.includes('"schema": "economist.response.v2"'),
    'Stage 15 should locate the generated Stage 14 JSON by schema.'
  );
  assert(
    !stage15WritePrompt.includes('Weź wyłącznie bezpośrednio poprzednią wiadomość assistant'),
    'Stage 15 should not be pinned to the immediately previous assistant message.'
  );
  assert(
    stage15WritePrompt.includes('tryb kopiowania'),
    'Stage 15 should fall back to copying the previous Stage 14 JSON.'
  );
  assert(
    stage15WritePrompt.includes('FINAL OUTPUT RULE DLA PROMPTU 16'),
    'Prompt 16 should have an explicit final JSON output rule.'
  );
  assert(
    stage15WritePrompt.includes('Odpowiedź Promptu 16 musi być JSON-em'),
    'Prompt 16 should be required to output JSON, not operational text.'
  );
  assert(
    stage15WritePrompt.includes('nie wypisuj żadnego komunikatu o niedostępności MCP'),
    'Stage 15 should explicitly suppress MCP unavailable sentinel output.'
  );
  assert(
    stage15WritePrompt.includes('Nie używaj `context_packs.upsert`'),
    'Stage 15 should explicitly forbid context_packs.upsert as a Stage 14 fallback.'
  );
  assert(
    !stage15WritePrompt.includes('context_packs_upsert'),
    'Stage 15 should not suggest the context_packs_upsert tool alias.'
  );
  assert(
    !stage15WritePrompt.includes('upsert_stage12_research_rows'),
    'Stage 15 should not suggest the old upsert_stage12_research_rows tool name.'
  );
  assert(
    stage17WritePrompt.includes('sector_context.upsert_stage13'),
    'Stage 17 should point at the Iskierka sector_context.upsert_stage13 tool.'
  );
  assert(
    stage17WritePrompt.includes('Użyj MCP server:\n\niskierka'),
    'Stage 17 should target the Iskierka MCP server.'
  );
  assert(
    stage17WritePrompt.includes('sector_context_upsert_stage13'),
    'Stage 17 should include the current Claude-safe sector_context_upsert_stage13 tool name.'
  );
  assert(
    stage17WritePrompt.includes('Nie używaj `context_packs.upsert`'),
    'Stage 17 should explicitly forbid context_packs.upsert as a sector-memory fallback.'
  );
  assert(
    stage17WritePrompt.includes('Stage 16 / Prompt 17 z 18'),
    'Stage 17 should identify the generated Stage 16 source by the new 18-prompt structure.'
  );
  assert(
    stage17WritePrompt.includes('top-level tablicę rekordów'),
    'Stage 17 should locate the generated Stage 16 JSON by top-level array shape.'
  );
  assert(
    !stage17WritePrompt.includes('Weź wyłącznie bezpośrednio poprzednią wiadomość assistant'),
    'Stage 17 should not be pinned to the immediately previous assistant message.'
  );
  assert(
    stage17WritePrompt.includes('tryb kopiowania'),
    'Stage 17 should fall back to copying the previous Stage 16 JSON array.'
  );
  assert(
    stage17WritePrompt.includes('FINAL OUTPUT RULE DLA PROMPTU 18'),
    'Prompt 18 should have an explicit final JSON output rule.'
  );
  assert(
    !promptsText.includes('MCP_TOOL_UNAVAILABLE'),
    'MCP write prompts should not emit unavailable sentinel outputs.'
  );
  assert(
    !promptsText.includes('Użyj MCP server:\n\nwatchlist-company-context'),
    'MCP write prompts should not target the old watchlist-company-context server.'
  );
}

function testStage16SectorMemoryFallbackIsWired() {
  assert(
    backgroundSource.includes("(!schema || schema === 'economist.response.v2')"),
    'Final investment JSON capture should accept both schema-tagged Stage 14 records and older records-only outputs.'
  );
  assert(
    backgroundSource.includes('function extractStage16SectorMemoryJsonText'),
    'Background should be able to extract the Stage 16 sector-memory JSON array.'
  );
  assert(
    backgroundSource.includes('rememberStage16SectorMemoryJson(absoluteCurrentPrompt, responseText);'),
    'Prompt loop should remember Stage 16 sector-memory JSON independently from the final investment record.'
  );
  assert(
    backgroundSource.includes('sectorMemoryResponse: stage16SectorMemoryResponse'),
    'Injected result should return the captured Stage 16 sector-memory response.'
  );
  assert(
    backgroundSource.includes('"/api/v1/intake/sector-memory-rows"'),
    'Background should send sector memory through the dedicated intake fallback endpoint.'
  );
  assert(
    backgroundSource.includes('selectedResponseReason,'),
    'Injected result should preserve the selected final investment response reason instead of hardcoding last_prompt.'
  );
}

function testStage14InvestmentJsonExtractorAcceptsCurrentAndLegacyShape() {
  const context = vm.createContext({ JSON });
  vm.runInContext(extractFunctionSource(backgroundSource, 'extractStage12InvestmentJsonText'), context, {
    filename: 'background.js'
  });

  const schemaTagged = JSON.stringify({
    schema: 'economist.response.v2',
    records: [
      {
        decision_role: 'PRIMARY',
        fields: { spolka: 'Alpha (ALPH:NYSE)' }
      }
    ]
  });
  const recordsOnly = JSON.stringify({
    records: [
      {
        decision_role: 'PRIMARY',
        fields: { spolka: 'Alpha (ALPH:NYSE)' }
      }
    ]
  });
  const sectorMemoryArray = JSON.stringify([
    { sektor: 'Semiconductors', podsektor: 'Substrate', opis: 'Not an investment record.' }
  ]);

  assert.strictEqual(context.extractStage12InvestmentJsonText(schemaTagged), schemaTagged);
  assert.strictEqual(context.extractStage12InvestmentJsonText(recordsOnly), recordsOnly);
  assert.strictEqual(context.extractStage12InvestmentJsonText(sectorMemoryArray), '');
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
    PROMPTS_COMPANY: new Array(18).fill('prompt'),
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
  assert.strictEqual(firstPromptPatch.totalPrompts, 18);
  assert.strictEqual(firstPromptPatch.stageIndex, 0);
  assert.strictEqual(firstPromptPatch.stageName, 'Prompt 1');

  const finalPromptPatch = context.buildQueuedProcessPatchForJob({
    jobId: 'job-final',
    title: 'Resume final',
    analysisType: 'company',
    kind: 'resume_stage',
    createdAt: 1,
    resumeStartIndex: 17,
    resumeTargetTabId: 202
  });
  assert.strictEqual(finalPromptPatch.currentPrompt, 18);
  assert.strictEqual(finalPromptPatch.totalPrompts, 18);
  assert.strictEqual(finalPromptPatch.stageIndex, 17);
  assert.strictEqual(finalPromptPatch.stageName, 'Prompt 18');
}

function main() {
  testCompanyPromptCatalogIsEighteenPrompts();
  testMcpWritePromptsUseIskierkaToolNames();
  testStage16SectorMemoryFallbackIsWired();
  testStage14InvestmentJsonExtractorAcceptsCurrentAndLegacyShape();
  testResumeQueuePatchUsesNextPromptNumber();
  console.log('test-company-prompt-count.js: ok');
}

main();
