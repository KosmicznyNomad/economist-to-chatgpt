#!/usr/bin/env node
'use strict';

const crypto = require('crypto');

const DEFAULT_INTAKE_URL = 'https://iskierka-watchlist.duckdns.org/api/v1/intake/economist-response';
const DEFAULT_KEY_ID = 'extension-primary';
const DEFAULT_SECRET = '233bf044070040d30391b224219635080696bbe1bf4eda74317213f49f01b862';

function trimText(value, maxLength = 600) {
  const safe = typeof value === 'string' ? value.trim() : '';
  if (!safe) return '';
  if (!Number.isInteger(maxLength) || maxLength <= 0 || safe.length <= maxLength) return safe;
  return `${safe.slice(0, Math.max(0, maxLength - 3))}...`;
}

function normalizeLevel(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'error') return 'error';
  if (normalized === 'warn' || normalized === 'warning') return 'warn';
  return 'info';
}

function buildProblemLogsUrl(baseUrl) {
  const parsed = new URL(baseUrl);
  parsed.pathname = parsed.pathname.replace(/\/economist-response\/?$/i, '/problem-logs');
  parsed.search = '';
  return parsed;
}

function extractSupportIdFromSource(sourceText) {
  const source = typeof sourceText === 'string' ? sourceText : '';
  const match = source.match(/(?:^|\|)support:([^|]+)/i);
  return trimText(match?.[1] || '', 120);
}

function inferSupportIdFromRunId(runId, sourceText = '') {
  const normalizedRunId = trimText(runId || '', 120);
  if (!normalizedRunId) return '';
  const normalizedSource = String(sourceText || '').toLowerCase();
  if (/^run-e2e-/i.test(normalizedRunId) && normalizedSource.includes('origin:test')) {
    return trimText(`ext-${normalizedRunId.slice(4)}`, 120);
  }
  return '';
}

function inferTitle(rawTitle, reason, message = '') {
  const explicit = trimText(rawTitle || '', 160);
  if (explicit) return explicit;
  const normalizedReason = trimText(reason || '', 140).toLowerCase();
  if (normalizedReason === 'post_restore_check') return 'Post-restore check';
  if (normalizedReason === 'integration_test') return 'Integration test';
  if (normalizedReason.includes('data_gap')) return 'Data gap';
  return trimText(message || '', 160);
}

function inferStageName(rawStageName, reason, fallbackTitle = '') {
  const explicit = trimText(rawStageName || '', 120);
  if (explicit) return explicit;
  const normalizedReason = trimText(reason || '', 140).toLowerCase();
  if (normalizedReason === 'integration_test') return 'Stage E2E';
  if (normalizedReason === 'post_restore_check') return 'Post-restore';
  if (normalizedReason.includes('data_gap')) return 'Data gap';
  return trimText(fallbackTitle || '', 120);
}

function classifyCategory({
  analysisType = '',
  level = 'info',
  reason = '',
  source = '',
  status = '',
  title = '',
  message = ''
} = {}) {
  const blob = [analysisType, reason, source, status, title, message].join(' ').toLowerCase();
  if (blob.includes('integration_test') || blob.includes('e2e')) return 'test';
  if (blob.includes('post_restore')) return 'recovery';
  if (blob.includes('data_gap')) return 'data_gap';
  if (blob.includes('dispatch')) return 'dispatch';
  if (blob.includes('runtime') || blob.includes('unhandledrejection')) return 'runtime';
  if (normalizeLevel(level) === 'error') return 'error';
  if (normalizeLevel(level) === 'warn') return 'warning';
  return 'info';
}

function canonicalizeEntry(rawItem) {
  const stage = rawItem && typeof rawItem.stage === 'object' ? rawItem.stage : {};
  const level = normalizeLevel(stage.level || rawItem.level || '');
  const status = trimText(stage.status || rawItem.status || '', 40);
  const reason = trimText(stage.reason || rawItem.reason || '', 140);
  const analysisType = trimText(rawItem.analysis_type || stage.analysisType || '', 40);
  const runId = trimText(rawItem.run_id || '', 120);
  const rawSource = trimText(rawItem.source || stage.source || '', 140) || 'problem-log-remote';
  const supportId = trimText(
    rawItem.support_id
      || stage.supportId
      || extractSupportIdFromSource(rawSource)
      || inferSupportIdFromRunId(runId, rawSource)
      || '',
    120
  );
  const hasSupportTagInSource = /(?:^|\|)support:[^|]+/i.test(rawSource);
  const source = supportId && !hasSupportTagInSource
    ? `${rawSource}|support:${supportId}`
    : rawSource;
  const message = trimText(rawItem.message || stage.message || '', 260);
  const title = inferTitle(stage.title || rawItem.title || '', reason, message);
  const stageName = inferStageName(stage.stageName || '', reason, title);
  const category = classifyCategory({
    analysisType,
    level,
    reason,
    source: rawSource,
    status,
    title,
    message
  });

  return {
    event_id: rawItem.event_id,
    run_id: runId,
    support_id: supportId,
    level,
    status,
    reason,
    category,
    title,
    stageName,
    source
  };
}

async function fetchProblemLogs({
  intakeUrl = DEFAULT_INTAKE_URL,
  keyId = DEFAULT_KEY_ID,
  secret = DEFAULT_SECRET,
  limit = 500,
  minutes = 14 * 24 * 60,
  supportId = ''
} = {}) {
  const endpoint = buildProblemLogsUrl(intakeUrl);
  endpoint.searchParams.set('limit', String(Math.max(1, Math.min(limit, 500))));
  endpoint.searchParams.set('minutes', String(Math.max(1, Math.min(minutes, 14 * 24 * 60))));
  if (supportId) endpoint.searchParams.set('support_id', supportId);

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const bodyHash = crypto.createHash('sha256').update('').digest('hex');
  const canonical = ['GET', endpoint.pathname || '/', timestamp, nonce, bodyHash].join('\n');
  const signature = crypto.createHmac('sha256', secret).update(canonical).digest('hex');

  const response = await fetch(endpoint.toString(), {
    method: 'GET',
    headers: {
      'X-Watchlist-Key-Id': keyId,
      'X-Watchlist-Timestamp': timestamp,
      'X-Watchlist-Nonce': nonce,
      'X-Watchlist-Signature': signature,
    }
  });
  const payload = await response.json();
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return { response, payload, items, endpoint: endpoint.toString() };
}

function collectIssues(rawItem) {
  const stage = rawItem && typeof rawItem.stage === 'object' ? rawItem.stage : {};
  const issues = [];
  if (!trimText(rawItem?.support_id || '', 120)) issues.push('missing_support_id');
  if (!trimText(rawItem?.title || '', 160)) issues.push('missing_title');
  if (!trimText(stage?.stageName || '', 120)) issues.push('missing_stage_name');
  if (!trimText(stage?.source || '', 140)) issues.push('missing_stage_source');
  return issues;
}

function toCountMap(values) {
  return values.reduce((acc, key) => {
    const safeKey = trimText(key || '', 80) || 'unknown';
    acc[safeKey] = (acc[safeKey] || 0) + 1;
    return acc;
  }, {});
}

async function main() {
  const args = process.argv.slice(2);
  const printFixed = args.includes('--print-fixed');
  const supportIdArg = args.find((arg) => arg.startsWith('--support-id='));
  const supportId = supportIdArg ? supportIdArg.split('=').slice(1).join('=').trim() : '';

  const intakeUrl = process.env.WATCHLIST_INTAKE_URL || DEFAULT_INTAKE_URL;
  const keyId = process.env.WATCHLIST_KEY_ID || DEFAULT_KEY_ID;
  const secret = process.env.WATCHLIST_SECRET || DEFAULT_SECRET;

  const { response, items, endpoint } = await fetchProblemLogs({
    intakeUrl,
    keyId,
    secret,
    supportId
  });

  if (!response.ok) {
    throw new Error(`problem_logs_fetch_failed status=${response.status} endpoint=${endpoint}`);
  }

  const flagged = [];
  const normalized = items.map((item) => {
    const issues = collectIssues(item);
    const fixed = canonicalizeEntry(item);
    const unresolvedAfter = [];
    if (!fixed.support_id) unresolvedAfter.push('support_id');
    if (!fixed.title) unresolvedAfter.push('title');
    if (!fixed.stageName) unresolvedAfter.push('stageName');
    if (!fixed.source) unresolvedAfter.push('source');
    if (issues.length > 0) {
      flagged.push({
        event_id: item.event_id,
        run_id: item.run_id || '',
        issues,
        before: {
          support_id: item.support_id || '',
          title: item.title || '',
          stageName: item.stage?.stageName || '',
          stageSource: item.stage?.source || '',
        },
        after: {
          support_id: fixed.support_id || '',
          title: fixed.title || '',
          stageName: fixed.stageName || '',
          source: fixed.source || '',
          category: fixed.category || '',
        },
        unresolvedAfter
      });
    }
    return fixed;
  });

  const unresolvedAfterNormalization = flagged.filter((item) => Array.isArray(item.unresolvedAfter) && item.unresolvedAfter.length > 0);
  const summary = {
    endpoint,
    total_records: items.length,
    flagged_records: flagged.length,
    unresolved_after_normalization: unresolvedAfterNormalization.length,
    levels: toCountMap(normalized.map((entry) => entry.level)),
    statuses: toCountMap(normalized.map((entry) => entry.status)),
    categories: toCountMap(normalized.map((entry) => entry.category)),
  };

  console.log(JSON.stringify(summary, null, 2));
  if (flagged.length > 0) {
    console.log('\nFlagged records:');
    console.log(JSON.stringify(flagged, null, 2));
  }
  if (printFixed) {
    console.log('\nCanonicalized records:');
    console.log(JSON.stringify(normalized, null, 2));
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error?.message || String(error)
  }, null, 2));
  process.exitCode = 1;
});
