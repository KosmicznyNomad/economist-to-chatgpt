#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const PROMPTS_PATH = path.join(__dirname, 'prompts-company.txt');
const MAX_MESSAGE_CHARS = 24000;
const MATCH_MIN_SCORE = 220;
const MATCH_MIN_GAP = 120;

function compactWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeSentenceSignature(text) {
  let normalized = typeof text === 'string' ? text : '';
  if (typeof normalized.normalize === 'function') {
    normalized = normalized.normalize('NFKC');
  }
  return normalized
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B`\u00B4]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractLeadingSentences(text, limit = 6) {
  const compact = compactWhitespace(text);
  if (!compact) return [];
  const candidates = compact.match(/[^.!?\n]+[.!?]+|[^.!?\n]+$/g) || [];
  const sentences = [];
  for (const candidate of candidates) {
    const sentence = compactWhitespace(candidate);
    if (!sentence) continue;
    sentences.push(sentence);
    if (sentences.length >= limit) break;
  }
  return sentences;
}

function extractLastTwoSentences(text) {
  const cleaned = String(text || '')
    .replace(/\r/g, ' ')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const sentences = cleaned
    .match(/[^.!?\n]+[.!?]+(?:["')\]]+)?|[^.!?\n]+$/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) || [];
  if (sentences.length === 0) return '';
  if (sentences.length === 1) return sentences[0];
  return `${sentences[sentences.length - 2]} ${sentences[sentences.length - 1]}`.trim();
}

function extractSentenceWindowSignature(text, startIndex = 0, count = 2) {
  const sentenceLimit = Math.max(0, startIndex) + Math.max(1, count);
  const sentences = extractLeadingSentences(text, sentenceLimit);
  const selected = sentences.slice(Math.max(0, startIndex), Math.max(0, startIndex) + Math.max(1, count));
  if (selected.length === 0) return '';
  return normalizeSentenceSignature(selected.join(' '));
}

function tokenizeForCompanyPromptMatch(text) {
  const normalized = normalizeSentenceSignature(text);
  if (!normalized) return [];
  return normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .slice(0, 1800);
}

function normalizeCompanyPromptTemplate(promptText) {
  return compactWhitespace(String(promptText || '').replace(/\{\{\s*articlecontent\s*\}\}/gi, ' '));
}

function sharedPrefixLength(left, right, maxLen = 420) {
  if (!left || !right) return 0;
  const limit = Math.min(left.length, right.length, maxLen);
  let index = 0;
  while (index < limit && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function signaturesOverlap(left, right) {
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left);
}

function buildCompanyPromptMatchRecords(prompts) {
  const records = (Array.isArray(prompts) ? prompts : []).map((promptText, index) => {
    const normalizedPrompt = normalizeCompanyPromptTemplate(promptText);
    const normalized = normalizeSentenceSignature(normalizedPrompt);
    const tokenSet = Array.from(new Set(
      tokenizeForCompanyPromptMatch(normalizedPrompt).filter((token) => token.length >= 6)
    ));
    return {
      index,
      promptNumber: index + 1,
      normalized,
      prefix: normalized.slice(0, 520),
      suffix: normalized.slice(Math.max(0, normalized.length - 520)),
      headSignature: extractSentenceWindowSignature(normalizedPrompt, 0, 2),
      bodySignature: extractSentenceWindowSignature(normalizedPrompt, 2, 4),
      tailSignature: normalizeSentenceSignature(extractLastTwoSentences(normalizedPrompt)),
      tokenSet,
      distinctiveTokens: []
    };
  });

  const tokenFrequency = new Map();
  records.forEach((record) => {
    record.tokenSet.forEach((token) => {
      tokenFrequency.set(token, (tokenFrequency.get(token) || 0) + 1);
    });
  });

  records.forEach((record) => {
    record.distinctiveTokens = [...record.tokenSet]
      .sort((left, right) => {
        const leftFreq = tokenFrequency.get(left) || 0;
        const rightFreq = tokenFrequency.get(right) || 0;
        if (leftFreq !== rightFreq) return leftFreq - rightFreq;
        if (right.length !== left.length) return right.length - left.length;
        return left.localeCompare(right);
      })
      .slice(0, 24);
  });

  return records;
}

function buildConversationMessageMatchFeatures(text) {
  const normalized = normalizeSentenceSignature(text);
  return {
    normalized,
    prefix: normalized.slice(0, 520),
    suffix: normalized.slice(Math.max(0, normalized.length - 520)),
    headSignature: extractSentenceWindowSignature(text, 0, 2),
    bodySignature: extractSentenceWindowSignature(text, 2, 4),
    tailSignature: normalizeSentenceSignature(extractLastTwoSentences(text)),
    tokenSet: new Set(tokenizeForCompanyPromptMatch(text).filter((token) => token.length >= 6))
  };
}

function computeCompanyPromptMatchScore(messageFeatures, promptRecord) {
  let score = 0;
  const signals = [];

  if (messageFeatures.headSignature && promptRecord.headSignature) {
    if (messageFeatures.headSignature === promptRecord.headSignature) {
      score += 220;
      signals.push('head_exact');
    } else if (signaturesOverlap(messageFeatures.headSignature, promptRecord.headSignature)) {
      score += 130;
      signals.push('head_overlap');
    }
  }

  if (messageFeatures.bodySignature && promptRecord.bodySignature) {
    if (messageFeatures.bodySignature === promptRecord.bodySignature) {
      score += 340;
      signals.push('body_exact');
    } else if (signaturesOverlap(messageFeatures.bodySignature, promptRecord.bodySignature)) {
      score += 220;
      signals.push('body_overlap');
    }
  }

  if (messageFeatures.tailSignature && promptRecord.tailSignature) {
    if (messageFeatures.tailSignature === promptRecord.tailSignature) {
      score += 260;
      signals.push('tail_exact');
    } else if (signaturesOverlap(messageFeatures.tailSignature, promptRecord.tailSignature)) {
      score += 150;
      signals.push('tail_overlap');
    }
  }

  const prefixLen = sharedPrefixLength(messageFeatures.prefix, promptRecord.prefix, 420);
  if (prefixLen >= 70) {
    score += Math.min(prefixLen, 260);
    signals.push(`prefix_${prefixLen}`);
  }

  const suffixLen = sharedPrefixLength(messageFeatures.suffix, promptRecord.suffix, 420);
  if (suffixLen >= 50) {
    score += Math.min(suffixLen, 220);
    signals.push(`suffix_${suffixLen}`);
  }

  const prefixAnchor = promptRecord.prefix.length >= 140
    ? promptRecord.prefix.slice(0, 140)
    : '';
  if (prefixAnchor && messageFeatures.normalized.includes(prefixAnchor)) {
    score += 90;
    signals.push('prefix_anchor');
  }

  const suffixAnchor = promptRecord.suffix.length >= 140
    ? promptRecord.suffix.slice(Math.max(0, promptRecord.suffix.length - 140))
    : '';
  if (suffixAnchor && messageFeatures.normalized.includes(suffixAnchor)) {
    score += 120;
    signals.push('suffix_anchor');
  }

  let tokenHits = 0;
  promptRecord.distinctiveTokens.forEach((token) => {
    if (messageFeatures.tokenSet.has(token)) tokenHits += 1;
  });
  if (tokenHits > 0) {
    score += tokenHits * 26;
    signals.push(`tokens_${tokenHits}`);
  }

  return {
    score,
    signals,
    tokenHits,
    prefixLen,
    suffixLen
  };
}

function hasStrongSignal(scoreInfo) {
  const signals = Array.isArray(scoreInfo?.signals) ? scoreInfo.signals : [];
  if (
    signals.includes('body_exact')
    || signals.includes('tail_exact')
    || signals.includes('body_overlap')
    || signals.includes('tail_overlap')
  ) {
    return true;
  }
  const tokenHits = Number.isInteger(scoreInfo?.tokenHits) ? scoreInfo.tokenHits : 0;
  const prefixLen = Number.isInteger(scoreInfo?.prefixLen) ? scoreInfo.prefixLen : 0;
  const suffixLen = Number.isInteger(scoreInfo?.suffixLen) ? scoreInfo.suffixLen : 0;
  if (tokenHits >= 4 && (prefixLen >= 140 || suffixLen >= 120)) return true;
  if (tokenHits >= 6 && (signals.includes('prefix_anchor') || signals.includes('suffix_anchor'))) return true;
  return false;
}

function matchPromptText(text, promptRecords) {
  const features = buildConversationMessageMatchFeatures(text);
  const ranked = promptRecords
    .map((record) => ({
      promptNumber: record.promptNumber,
      ...computeCompanyPromptMatchScore(features, record)
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const leftStrong = hasStrongSignal(left) ? 1 : 0;
      const rightStrong = hasStrongSignal(right) ? 1 : 0;
      if (rightStrong !== leftStrong) return rightStrong - leftStrong;
      return right.promptNumber - left.promptNumber;
    });

  const best = ranked[0] || null;
  const second = ranked[1] || null;
  assert(best, 'best candidate should exist');
  assert(best.score >= MATCH_MIN_SCORE, `best score below threshold for P${best.promptNumber}`);
  const gap = second ? (best.score - second.score) : best.score;
  assert(
    hasStrongSignal(best) || gap >= MATCH_MIN_GAP,
    `best candidate should be high-confidence for P${best.promptNumber}`
  );
  return {
    best,
    second,
    gap
  };
}

function main() {
  const promptsText = fs.readFileSync(PROMPTS_PATH, 'utf8');
  const prompts = promptsText
    .split(/\W+PROMPT_SEPARATOR\W+/)
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  assert(prompts.length >= 13, 'expected full company prompt chain');

  const records = buildCompanyPromptMatchRecords(prompts);
  prompts.forEach((promptText, index) => {
    const truncated = promptText.slice(0, MAX_MESSAGE_CHARS);
    const { best, second, gap } = matchPromptText(truncated, records);
    assert.strictEqual(
      best.promptNumber,
      index + 1,
      `truncated prompt should resolve to itself (expected P${index + 1}, got P${best.promptNumber})`
    );
    if (second) {
      assert(gap > 0, `best candidate should beat second candidate for P${index + 1}`);
    }
  });

  console.log('PASS test-prompt-recognition');
  console.log(`Validated ${prompts.length} prompts with ${MAX_MESSAGE_CHARS}-char truncation.`);
}

main();
