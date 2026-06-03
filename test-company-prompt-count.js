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

function testCompanyPromptFinalOutputsAreDataGapOrJsonOnly() {
  const prompts = parsePromptChainText(promptsText);
  const stage0Prompt = prompts[0] || '';
  const stage1Prompt = prompts[1] || '';
  const stage2Prompt = prompts[2] || '';
  const stage5McpPrompt = prompts.find((prompt) => (
    prompt.includes('STAGE 5') && prompt.includes('MCP SECTOR OVERLAY')
  )) || '';
  const stage14RecordPrompt = prompts[14] || '';
  const stage15McpWritePrompt = prompts[15] || '';
  const sectorMemoryPrompt = prompts[16] || '';
  const stage17McpWritePrompt = prompts[17] || '';

  assert(
    stage0Prompt.includes('=== STAGE 0 HANDOFF ===')
      && stage0Prompt.includes('CONTRACT_MAP:')
      && stage0Prompt.includes('THESIS_TYPE: [A / B / C]'),
    'Stage 0 should emit the mechanism handoff with contract map and thesis type.'
  );
  assert(
    stage0Prompt.includes('Output only Section 0 and the Stage 0 handoff.'),
    'Stage 0 should stop after the thesis reconstruction and handoff.'
  );
  assert(
    stage1Prompt.includes("search context for '=== STAGE 0 HANDOFF ==='")
      && stage1Prompt.includes('If NOT found: output DATA_GAP_STAGE=0 and STOP.')
      && stage1Prompt.includes('SELECTED_SUB-SEGMENTS: [list names of selected sub-segments]'),
    'Stage 1 should require Stage 0 inheritance and expose selected sub-segments in its handoff.'
  );
  assert(
    stage2Prompt.includes("Search context for '=== STAGE 1 HANDOFF ==='")
      && stage2Prompt.includes('If NOT found: output DATA_GAP_STAGE=1 and STOP.')
      && stage2Prompt.includes('=== STAGE 2 FUNDAMENTAL HANDOFF ==='),
    'Stage 2 should require Stage 1 inheritance and emit the fundamental handoff.'
  );

  assert(
    stage5McpPrompt.includes('Retrieve sector memory entries using short combinations of:'),
    'Stage 5 should define sector-memory retrieval inputs.'
  );
  assert(
    stage5McpPrompt.includes('Use MCP / Iskierka sector-context search.'),
    'Stage 5 should explicitly use Iskierka sector-context search.'
  );
  assert(
    stage5McpPrompt.includes('MCP_TOOL_UNAVAILABLE'),
    'Stage 5 should mark MCP unavailability explicitly.'
  );
  assert(
    stage5McpPrompt.includes('MCP_ALIAS_NOT_FOUND'),
    'Stage 5 should distinguish missing aliases from unavailable MCP.'
  );
  assert(
    stage5McpPrompt.includes('Do not call an empty result MCP_UNAVAILABLE.'),
    'Stage 5 should distinguish MCP transport errors from empty search results.'
  );
  assert(
    stage5McpPrompt.includes('MCP_STATUS:'),
    'Stage 5 handoff should represent successful empty retrieval separately from MCP unavailability.'
  );
  assert(
    stage5McpPrompt.includes('do not count duplicates as independent evidence'),
    'Stage 5 should prevent duplicate sector-memory entries from becoming independent evidence.'
  );

  assert(
    stage14RecordPrompt.includes('"schema": "economist.response.v2"')
      && stage14RecordPrompt.includes('records ma 0–2 rekordy'),
    'Stage 14 should require the structured economist.response.v2 object with 0-2 records.'
  );
  assert(
    stage14RecordPrompt.includes('records[] może być puste tylko wtedy'),
    'Stage 14 final instruction should allow empty records only for a true no-company case.'
  );
  assert(
    stage15McpWritePrompt.includes('STAGE 15 — MCP WRITE FINAL INVESTMENT RECORDS')
      && stage15McpWritePrompt.includes('stage12_research_rows_upsert')
      && stage15McpWritePrompt.includes('FINAL OUTPUT RULE DLA PROMPTU 16'),
    'Stage 15 should copy/write Stage 14 records through the dedicated MCP writer and return the JSON unchanged.'
  );
  assert(
    sectorMemoryPrompt.includes('STAGE 16 — SECTOR INTELLIGENCE MEMORY ROW WRITER')
      && sectorMemoryPrompt.includes('Return only a JSON array.'),
    'Sector-memory prompt should output only the JSON array captured by the extension.'
  );
  assert(
    stage17McpWritePrompt.includes('STAGE 17 — MCP WRITE SECTOR MEMORY ROWS')
      && stage17McpWritePrompt.includes('sector_context.upsert_stage13')
      && stage17McpWritePrompt.includes('FINAL OUTPUT RULE DLA PROMPTU 18'),
    'Stage 17 should copy/write Stage 16 sector memory rows through the dedicated MCP writer and return the JSON unchanged.'
  );
  assert(
    stage15McpWritePrompt.includes('Nie używaj `context_packs.upsert`, `sector_context.upsert_stage13`, intake/history endpoints ani `watchlist-company-context`.')
      && stage17McpWritePrompt.includes('Nie używaj `context_packs.upsert`, `stage12_research_rows.upsert`, endpointów research rows ani `watchlist-company-context`.'),
    'MCP copy prompts should route research rows and sector memory to their dedicated tools only.'
  );
  assert(
    !promptsText.includes('DATA_GAPS_STOP__MISSING_CRITICAL_INPUTS__HALT_PROMPT_CHAIN')
      && !backgroundSource.includes('DATA_GAPS_STOP__MISSING_CRITICAL_INPUTS__HALT_PROMPT_CHAIN'),
    'Legacy DATA_GAPS_STOP sentinel should not be emitted or recognized.'
  );
}

function testSectorMemoryFallbackIsWired() {
  assert(
    backgroundSource.includes("(!schema || schema === 'economist.response.v2')"),
    'Final investment JSON capture should accept both schema-tagged Stage 14 records and older records-only outputs.'
  );
  assert(
    backgroundSource.includes('function extractSectorMemoryJsonText'),
    'Background should be able to extract the sector-memory JSON array.'
  );
  assert(
    backgroundSource.includes('rememberSectorMemoryJson(absoluteCurrentPrompt, responseText);'),
    'Prompt loop should remember sector-memory JSON independently from the final investment record.'
  );
  assert(
    backgroundSource.includes('sectorMemoryResponse,'),
    'Injected result should return the captured sector-memory response.'
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
  const schemaTaggedEmptyRecords = JSON.stringify({
    schema: 'economist.response.v2',
    records: []
  });
  const recordsOnlyEmpty = JSON.stringify({
    records: []
  });
  const sectorMemoryArray = JSON.stringify([
    { sektor: 'Semiconductors', podsektor: 'Substrate', opis: 'Not an investment record.' }
  ]);

  assert.strictEqual(context.extractStage12InvestmentJsonText(schemaTagged), schemaTagged);
  assert.strictEqual(context.extractStage12InvestmentJsonText(recordsOnly), recordsOnly);
  assert.strictEqual(context.extractStage12InvestmentJsonText(schemaTaggedEmptyRecords), schemaTaggedEmptyRecords);
  assert.strictEqual(context.extractStage12InvestmentJsonText(recordsOnlyEmpty), '');
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
	    normalizeComposerThinkingEffort(value) {
	      const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
	      return normalized === 'extended'
          ? 'heavy'
          : (['light', 'standard', 'heavy', 'pro'].includes(normalized) ? normalized : '');
	    },
	    sanitizeAnalysisQueueJob(job) {
	      return job;
	    },
    resolvePromptCountForQueuedJob(job) {
      if (Array.isArray(job?.promptChainSnapshot) && job.promptChainSnapshot.length > 0) {
        return job.promptChainSnapshot.length;
      }
      return 18;
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
  testCompanyPromptFinalOutputsAreDataGapOrJsonOnly();
  testSectorMemoryFallbackIsWired();
  testStage14InvestmentJsonExtractorAcceptsCurrentAndLegacyShape();
  testResumeQueuePatchUsesNextPromptNumber();
  console.log('test-company-prompt-count.js: ok');
}

main();
