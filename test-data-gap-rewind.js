#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PROMPTS_PATH = path.join(__dirname, 'prompts-company.txt');
const DATA_GAP_DIRECTIVE_REGEX = /^DATA_GAP_STAGE\s*=\s*([0-9]+(?:\.[0-9]+)?)$/i;
const MAX_REPLAYS_PER_STAGE = 2;
const PROMPT_SEPARATOR_TOKEN_SOURCE = String.raw`PROMPT(?:[ _-]+)SEPARATOR`;
const PROMPT_SEPARATOR_PREFIX_SOURCE = String.raw`(?:\u25C4|\u00E2\u2014\u201E)?[ \t-]*`;
const PROMPT_SEPARATOR_SUFFIX_SOURCE = String.raw`[ \t-]*(?:\u25BA|\u00E2\u2013\u015F)?`;
const PROMPT_SEPARATOR_LINE_REGEX = new RegExp(
  String.raw`\n${PROMPT_SEPARATOR_PREFIX_SOURCE}${PROMPT_SEPARATOR_TOKEN_SOURCE}${PROMPT_SEPARATOR_SUFFIX_SOURCE}\n`,
  'g'
);
const PROMPT_SEPARATOR_INLINE_REGEX = new RegExp(
  `${PROMPT_SEPARATOR_PREFIX_SOURCE}${PROMPT_SEPARATOR_TOKEN_SOURCE}${PROMPT_SEPARATOR_SUFFIX_SOURCE}`,
  'g'
);

const STAGE_TO_PROMPT_INDEX = new Map([
  ['1', 1],
  ['2', 2],
  ['3', 3],
  ['4', 4],
  ['5', 5],
  ['6', 6],
  ['7', 7],
  ['8', 8],
  ['9', 9],
  ['10', 10],
  ['11', 10],
  ['12', 11]
]);

function normalizeStageId(value) {
  const raw = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  if (!raw) return '';
  const match = raw.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return '';
  const whole = String(Number.parseInt(match[1], 10));
  const fractionRaw = typeof match[2] === 'string' ? match[2] : '';
  if (!fractionRaw) return whole;
  const fraction = fractionRaw.replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function parseDirective(responseText) {
  if (typeof responseText !== 'string') return null;
  const lines = responseText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== 1) return null;
  const match = lines[0].match(DATA_GAP_DIRECTIVE_REGEX);
  if (!match) return null;
  const stageId = normalizeStageId(match[1]);
  if (!stageId) return null;
  return { stageId, rawLine: lines[0] };
}

function normalizePromptText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function parsePromptChainText(rawText) {
  const normalizedText = typeof rawText === 'string'
    ? rawText.replace(/\uFEFF/g, '').replace(/\r\n?/g, '\n')
    : '';
  if (!normalizedText.trim()) return [];

  const splitAndClean = (text, separatorRegex) => text
    .split(separatorRegex)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  const lineSeparated = splitAndClean(normalizedText, PROMPT_SEPARATOR_LINE_REGEX);
  if (lineSeparated.length > 1) return lineSeparated;

  const inlineSeparated = splitAndClean(normalizedText, PROMPT_SEPARATOR_INLINE_REGEX);
  if (inlineSeparated.length > 1) return inlineSeparated;

  return [normalizedText.trim()];
}

function stripUnknownStages(trace) {
  return (Array.isArray(trace) ? trace : []).filter((stageId) => stageId !== '?');
}

function findMatchingPromptIndexByText(chain, promptText, fromIndex = 0) {
  const target = normalizePromptText(promptText);
  if (!target) return -1;
  for (let idx = Math.max(0, fromIndex); idx < chain.length; idx += 1) {
    if (normalizePromptText(chain[idx]) === target) return idx;
  }
  return -1;
}

function findPromptNumberByTextInCanonicalPrompts(prompts, promptText) {
  if (!Array.isArray(prompts) || prompts.length === 0) return null;
  const target = normalizePromptText(promptText);
  if (!target) return null;
  for (let idx = 0; idx < prompts.length; idx += 1) {
    if (normalizePromptText(prompts[idx]) === target) {
      return idx + 1;
    }
  }
  return null;
}

function buildReplayKey(stageId, currentPromptNumber) {
  const normalizedStageId = normalizeStageId(stageId);
  if (!normalizedStageId) return '';
  const hasPrompt = Number.isInteger(currentPromptNumber) && currentPromptNumber > 0;
  return hasPrompt ? `${normalizedStageId}@P${currentPromptNumber}` : `${normalizedStageId}@P?`;
}

function queueMissingPromptForDataGap({
  stageId,
  currentPromptText,
  localPromptIndex,
  currentPromptNumberHint = null,
  promptChain,
  canonicalPrompts,
  promptByStageId,
  replayCounts
}) {
  const normalizedStageId = normalizeStageId(stageId);
  if (!normalizedStageId) return { inserted: false, error: 'invalid_stage_id' };

  const inferredCurrentPromptNumber = (
    Number.isInteger(currentPromptNumberHint) && currentPromptNumberHint > 0
  )
    ? currentPromptNumberHint
    : findPromptNumberByTextInCanonicalPrompts(canonicalPrompts, currentPromptText);
  const replayKey = buildReplayKey(normalizedStageId, inferredCurrentPromptNumber);
  const replayCount = (replayCounts.get(replayKey) || 0) + 1;
  replayCounts.set(replayKey, replayCount);
  if (replayCount > MAX_REPLAYS_PER_STAGE) {
    return { inserted: false, error: 'data_gap_replay_limit', stageId: normalizedStageId, replayKey, replayCount };
  }

  const fromIndex = Math.max(0, localPromptIndex + 1);
  const missingPromptText = promptByStageId.get(normalizedStageId);
  if (!missingPromptText) {
    return { inserted: false, error: 'missing_prompt_for_stage', stageId: normalizedStageId, replayKey, replayCount };
  }
  const missingPromptNumber = findPromptNumberByTextInCanonicalPrompts(canonicalPrompts, missingPromptText);
  const currentPromptNumber = findPromptNumberByTextInCanonicalPrompts(canonicalPrompts, currentPromptText);

  const currentNormalized = normalizePromptText(currentPromptText);
  const missingNormalized = normalizePromptText(missingPromptText);
  if (!missingNormalized) {
    return { inserted: false, error: 'data_gap_self_reference', stageId: normalizedStageId, replayKey, replayCount };
  }
  if (missingNormalized === currentNormalized) {
    const selfReferenceReplayStart = Number.isInteger(missingPromptNumber) && missingPromptNumber > 1
      ? missingPromptNumber - 1
      : (Number.isInteger(currentPromptNumber) && currentPromptNumber > 1 ? currentPromptNumber - 1 : null);
    const canRecoverSelfReference = (
      Array.isArray(canonicalPrompts)
      && Number.isInteger(selfReferenceReplayStart)
      && Number.isInteger(currentPromptNumber)
      && selfReferenceReplayStart > 0
      && currentPromptNumber > 0
      && selfReferenceReplayStart <= currentPromptNumber
    );
    if (canRecoverSelfReference) {
      const replayRange = canonicalPrompts
        .slice(selfReferenceReplayStart - 1, currentPromptNumber)
        .map((item) => (typeof item === 'string' ? item.trim() : ''))
        .filter((item) => item.length > 0);
      if (replayRange.length > 0) {
        promptChain.splice(fromIndex, 0, ...replayRange);
        return {
          inserted: true,
          stageId: normalizedStageId,
          replayKey,
          replayCount,
          mode: 'self_reference_replay'
        };
      }
    }
    return { inserted: false, error: 'data_gap_self_reference', stageId: normalizedStageId, replayKey, replayCount };
  }

  const canReplayRange = (
    Array.isArray(canonicalPrompts)
    && Number.isInteger(missingPromptNumber)
    && Number.isInteger(currentPromptNumber)
    && missingPromptNumber > 0
    && currentPromptNumber > 0
    && missingPromptNumber < currentPromptNumber
  );
  if (canReplayRange) {
    const replayRange = canonicalPrompts
      .slice(missingPromptNumber - 1, currentPromptNumber)
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0);
    if (replayRange.length > 0) {
      promptChain.splice(fromIndex, 0, ...replayRange);
      return {
        inserted: true,
        stageId: normalizedStageId,
        replayKey,
        replayCount,
        mode: 'inserted_replay_range'
      };
    }
  }

  const existingIndex = findMatchingPromptIndexByText(promptChain, missingPromptText, fromIndex);
  let mode = 'inserted_new';
  if (existingIndex === fromIndex) {
    promptChain.splice(fromIndex + 1, 0, currentPromptText);
    mode = 'reuse_next';
  } else if (existingIndex > fromIndex) {
    const [movedPrompt] = promptChain.splice(existingIndex, 1);
    promptChain.splice(fromIndex, 0, movedPrompt, currentPromptText);
    mode = 'moved_existing';
  } else {
    promptChain.splice(fromIndex, 0, missingPromptText, currentPromptText);
  }

  return { inserted: true, stageId: normalizedStageId, replayKey, replayCount, mode };
}

function loadPromptByStage() {
  const promptsText = fs.readFileSync(PROMPTS_PATH, 'utf8');
  const prompts = parsePromptChainText(promptsText);

  const promptByStageId = new Map();
  for (const [stageId, index] of STAGE_TO_PROMPT_INDEX.entries()) {
    if (Number.isInteger(index) && index >= 0 && index < prompts.length) {
      promptByStageId.set(stageId, prompts[index]);
    }
  }
  return { prompts, promptByStageId };
}

function run() {
  const { prompts, promptByStageId } = loadPromptByStage();
  assert.strictEqual(prompts.length, 12, 'prompts-company.txt should contain the current 12-prompt chain');
  assert(promptByStageId.has('2') && promptByStageId.has('3'), 'stage prompts 2 and 3 must be present');
  assert.strictEqual(
    promptByStageId.get('10'),
    promptByStageId.get('11'),
    'Stage 11 should resolve to the same prompt text as Stage 10 in the current chain'
  );
  assert.deepStrictEqual(
    parsePromptChainText('Prompt A\n--- PROMPT SEPARATOR ---\nPrompt B'),
    ['Prompt A', 'Prompt B'],
    'parser should accept dashed separator lines'
  );
  assert.deepStrictEqual(
    parsePromptChainText('Prompt A◄PROMPT_SEPARATOR►Prompt B'),
    ['Prompt A', 'Prompt B'],
    'parser should remain backward-compatible with legacy separator token'
  );

  // Test 1: parser should accept only strict one-line DATA_GAP directive.
  assert.strictEqual(parseDirective('DATA_GAP_STAGE=2.5').stageId, '2.5');
  assert.strictEqual(parseDirective('  DATA_GAP_STAGE = 7  ').stageId, '7');
  assert.strictEqual(parseDirective('DATA_GAP_STAGE=2\nextra'), null);
  assert.strictEqual(parseDirective('SYSTEM_COMMAND: DATA_GAPS_STOP__MISSING_CRITICAL_INPUTS__HALT_PROMPT_CHAIN'), null);

  // Test 2: stage sequence should rollback exactly as requested: 3 -> 2 -> 3 -> next.
  const promptChain = prompts.slice(1); // starts from stage 1 prompt in the current chain
  const replayCounts = new Map();
  const stageByPrompt = new Map();
  for (const [stageId, promptText] of promptByStageId.entries()) {
    const normalized = normalizePromptText(promptText);
    if (!stageByPrompt.has(normalized)) {
      stageByPrompt.set(normalized, stageId);
    }
  }

  const executed = [];
  let injected = false;
  for (let i = 0; i < promptChain.length; i += 1) {
    const stageId = stageByPrompt.get(normalizePromptText(promptChain[i])) || '?';
    executed.push(stageId);

    if (!injected && stageId === '3') {
      const directive = parseDirective('DATA_GAP_STAGE=2');
      const queueResult = queueMissingPromptForDataGap({
        stageId: directive.stageId,
        currentPromptText: promptChain[i],
        localPromptIndex: i,
        promptChain,
        canonicalPrompts: prompts,
        promptByStageId,
        replayCounts
      });
      assert.strictEqual(queueResult.inserted, true, 'queue insertion should succeed');
      injected = true;
      continue;
    }
  }

  const expected = ['1', '2', '3', '2', '3', '4', '5', '6', '7', '8', '9', '10', '12'];
  assert.deepStrictEqual(stripUnknownStages(executed), expected);

  // Test 2b: if missing stage is far earlier (e.g. at stage 7), replay must start
  // from missing stage and continue sequentially up to current stage.
  const promptChainFar = prompts.slice(1);
  const executedFar = [];
  let injectedFar = false;
  for (let i = 0; i < promptChainFar.length; i += 1) {
    const stageId = stageByPrompt.get(normalizePromptText(promptChainFar[i])) || '?';
    executedFar.push(stageId);

    if (!injectedFar && stageId === '7') {
      const queueResult = queueMissingPromptForDataGap({
        stageId: '2',
        currentPromptText: promptChainFar[i],
        localPromptIndex: i,
        promptChain: promptChainFar,
        canonicalPrompts: prompts,
        promptByStageId,
        replayCounts: new Map()
      });
      assert.strictEqual(queueResult.inserted, true);
      injectedFar = true;
      continue;
    }
  }
  const expectedFar = [
    '1', '2', '3', '4', '5', '6', '7',
    '2', '3', '4', '5', '6', '7', '8', '9', '10', '12'
  ];
  assert.deepStrictEqual(stripUnknownStages(executedFar), expectedFar);

  // Test 2d: self-reference directive (missing stage == current stage) should
  // recover by rewinding one prompt and replaying up to current stage.
  const promptChainSelf = prompts.slice(1);
  const executedSelf = [];
  let injectedSelf = false;
  for (let i = 0; i < promptChainSelf.length; i += 1) {
    const stageId = stageByPrompt.get(normalizePromptText(promptChainSelf[i])) || '?';
    executedSelf.push(stageId);
    if (!injectedSelf && stageId === '3') {
      const queueResult = queueMissingPromptForDataGap({
        stageId: '3',
        currentPromptText: promptChainSelf[i],
        localPromptIndex: i,
        promptChain: promptChainSelf,
        canonicalPrompts: prompts,
        promptByStageId,
        replayCounts: new Map()
      });
      assert.strictEqual(queueResult.inserted, true);
      assert.strictEqual(queueResult.mode, 'self_reference_replay');
      injectedSelf = true;
      continue;
    }
  }
  const expectedSelf = [
    '1', '2', '3',
    '2', '3',
    '4', '5', '6', '7', '8', '9', '10', '12'
  ];
  assert.deepStrictEqual(stripUnknownStages(executedSelf), expectedSelf);

  // Test 2c: generic rollback rule for many stage pairs.
  // For each current stage C and missing stage M where M < C (by prompt number),
  // expect replay sequence M..C inserted right after C.
  const orderedStages = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '12'];
  const orderedByPromptNumber = orderedStages
    .map((stageId) => ({
      stageId,
      promptNumber: findPromptNumberByTextInCanonicalPrompts(prompts, promptByStageId.get(stageId))
    }))
    .filter((item) => Number.isInteger(item.promptNumber))
    .sort((a, b) => a.promptNumber - b.promptNumber);
  const stagesByPromptNumber = orderedByPromptNumber.map((item) => item.stageId);
  for (let c = 1; c < stagesByPromptNumber.length; c += 1) {
    const currentStage = stagesByPromptNumber[c];
    for (let m = 0; m < c; m += 1) {
      const missingStage = stagesByPromptNumber[m];
      const chain = prompts.slice(1);
      const trace = [];
      let injectedPair = false;
      for (let i = 0; i < chain.length; i += 1) {
        const stageId = stageByPrompt.get(normalizePromptText(chain[i])) || '?';
        trace.push(stageId);
        if (!injectedPair && stageId === currentStage) {
          const queueResult = queueMissingPromptForDataGap({
            stageId: missingStage,
            currentPromptText: chain[i],
            localPromptIndex: i,
            promptChain: chain,
            canonicalPrompts: prompts,
            promptByStageId,
            replayCounts: new Map()
          });
          assert.strictEqual(queueResult.inserted, true);
          injectedPair = true;
          continue;
        }
      }
      const currentIdx = trace.indexOf(currentStage);
      assert(currentIdx >= 0, `current stage ${currentStage} should exist in trace`);
      const replaySlice = trace.slice(currentIdx + 1, currentIdx + 1 + (c - m + 1));
      const expectedSlice = stagesByPromptNumber.slice(m, c + 1);
      assert.deepStrictEqual(
        replaySlice,
        expectedSlice,
        `expected replay ${expectedSlice.join('->')} for current=${currentStage}, missing=${missingStage}, got=${replaySlice.join('->')}`
      );
    }
  }

  // Test 3: replay guard should stop infinite loops after max retries for the same stage id.
  const replayGuardChain = [
    promptByStageId.get('1'),
    promptByStageId.get('2'),
    promptByStageId.get('3'),
    promptByStageId.get('4'),
    promptByStageId.get('5')
  ];
  const replayGuardCounts = new Map();
  let replayLimitHit = false;
  for (let i = 0; i < replayGuardChain.length; i += 1) {
    const stageId = stageByPrompt.get(normalizePromptText(replayGuardChain[i])) || '?';
    if (stageId !== '3') continue;
    const queueResult = queueMissingPromptForDataGap({
      stageId: '2',
      currentPromptText: replayGuardChain[i],
      localPromptIndex: i,
      promptChain: replayGuardChain,
      canonicalPrompts: prompts,
      promptByStageId,
      replayCounts: replayGuardCounts
    });
    if (!queueResult.inserted) {
      replayLimitHit = queueResult.error === 'data_gap_replay_limit';
      break;
    }
  }
  assert.strictEqual(replayLimitHit, true, 'replay guard should trigger after repeated unresolved gaps');

  // Test 3b: replay counters should be scoped by stage+current prompt number.
  const perPromptReplayCounts = new Map();
  const chainForStage3 = prompts.slice(1);
  const chainForStage4 = prompts.slice(1);
  const stage3Prompt = promptByStageId.get('3');
  const stage4Prompt = promptByStageId.get('4');
  const stage3Index = chainForStage3.findIndex((item) => normalizePromptText(item) === normalizePromptText(stage3Prompt));
  const stage4Index = chainForStage4.findIndex((item) => normalizePromptText(item) === normalizePromptText(stage4Prompt));
  assert(stage3Index >= 0 && stage4Index >= 0, 'stage 3/4 prompts should exist in chain');
  const replayFromStage3 = queueMissingPromptForDataGap({
    stageId: '2',
    currentPromptText: chainForStage3[stage3Index],
    localPromptIndex: stage3Index,
    promptChain: chainForStage3,
    canonicalPrompts: prompts,
    promptByStageId,
    replayCounts: perPromptReplayCounts
  });
  const replayFromStage4 = queueMissingPromptForDataGap({
    stageId: '2',
    currentPromptText: chainForStage4[stage4Index],
    localPromptIndex: stage4Index,
    promptChain: chainForStage4,
    canonicalPrompts: prompts,
    promptByStageId,
    replayCounts: perPromptReplayCounts
  });
  assert.strictEqual(replayFromStage3.inserted, true, 'stage 3 replay should insert');
  assert.strictEqual(replayFromStage4.inserted, true, 'stage 4 replay should insert');
  assert.strictEqual(
    replayFromStage4.replayCount,
    1,
    'replay counter should reset for a different current prompt location'
  );

  console.log('PASS test-data-gap-rewind');
  console.log(`Executed rollback sequence: ${executed.join(' -> ')}`);
}

run();
