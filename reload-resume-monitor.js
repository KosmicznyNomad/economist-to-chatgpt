const refreshBtn = document.getElementById('refresh-btn');
const sessionMeta = document.getElementById('session-meta');
const summaryMeta = document.getElementById('summary-meta');
const validationMeta = document.getElementById('validation-meta');
const stageBody = document.getElementById('stage-body');
const rowsBody = document.getElementById('rows-body');
const eventsContainer = document.getElementById('events');

const searchParams = new URLSearchParams(window.location.search);
let sessionId = typeof searchParams.get('sessionId') === 'string'
  ? searchParams.get('sessionId').trim()
  : '';
let lastRenderedSessionId = '';
let lastRenderedUpdatedAt = 0;

const ACTION_LABELS = {
  queued: 'Queued',
  queued_for_detection: 'Queued for detection',
  ready_to_start: 'Ready to start',
  started: 'Started',
  detect_failed: 'Detect failed',
  reload_failed: 'Reload failed',
  start_failed: 'Start failed',
  skipped_non_company: 'Skipped non-company',
  skipped_outside_invest: 'Skipped outside INVEST',
  final_stage_already_sent: 'Final stage already done'
};

function sendRuntimeMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || 'runtime_error'));
        return;
      }
      resolve(response && typeof response === 'object' ? response : {});
    });
  });
}

function formatDateTime(ts) {
  if (!Number.isInteger(ts) || ts <= 0) return '-';
  try {
    return new Date(ts).toLocaleString();
  } catch (error) {
    return '-';
  }
}

function createPlaceholderRow(colspan, text) {
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = colspan;
  cell.className = 'placeholder';
  cell.textContent = text;
  row.appendChild(cell);
  return row;
}

function actionLabel(action) {
  const normalized = typeof action === 'string' ? action.trim() : '';
  if (!normalized) return '-';
  return ACTION_LABELS[normalized] || normalized;
}

function actionStatusClass(action) {
  const normalized = typeof action === 'string' ? action.trim() : '';
  if (!normalized) return '';
  if (normalized === 'started' || normalized === 'final_stage_already_sent') return 'status-ok';
  if (normalized === 'detect_failed' || normalized === 'reload_failed' || normalized === 'start_failed') return 'status-err';
  if (normalized === 'skipped_non_company' || normalized === 'skipped_outside_invest') return 'status-warn';
  return 'status-running';
}

function resolveResumeState(row) {
  const action = typeof row?.action === 'string' ? row.action.trim() : '';
  if (action === 'started') {
    return { label: 'TAK', className: 'status-ok' };
  }
  if (action === 'final_stage_already_sent') {
    return { label: 'NIE (final)', className: 'status-ok' };
  }
  if (action === 'skipped_non_company' || action === 'skipped_outside_invest') {
    return { label: 'NIE (skip)', className: 'status-warn' };
  }
  if (action === 'detect_failed' || action === 'reload_failed' || action === 'start_failed') {
    return { label: 'NIE', className: 'status-err' };
  }
  return { label: 'JESZCZE NIE', className: 'status-running' };
}

function isPendingRow(row) {
  const action = typeof row?.action === 'string' ? row.action.trim() : '';
  return (
    action === 'queued'
    || action === 'queued_for_detection'
    || action === 'ready_to_start'
  );
}

function formatPromptInfo(promptNumber, totalPrompts, stageName) {
  if (!Number.isInteger(promptNumber) || promptNumber <= 0) return '-';
  const total = Number.isInteger(totalPrompts) && totalPrompts > 0 ? `/${totalPrompts}` : '';
  const stage = typeof stageName === 'string' && stageName.trim() ? ` (${stageName.trim()})` : '';
  return `P${promptNumber}${total}${stage}`;
}

function toCompactRecognitionText(value, maxLength = 120) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  const compact = text.replace(/\s+/g, ' ');
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatRecognitionStep(step) {
  const text = typeof step === 'string' ? step.trim() : '';
  if (!text) return '';
  const [stage, status, detail] = text.split('|');
  const parts = [];
  if (stage && stage.trim()) parts.push(stage.trim());
  if (status && status.trim()) parts.push(status.trim());
  if (detail && detail.trim()) parts.push(detail.trim());
  return toCompactRecognitionText(parts.join(': '), 150);
}

function formatRecognitionPipeline(row) {
  const rawSteps = Array.isArray(row?.recognitionSteps) ? row.recognitionSteps : [];
  const steps = rawSteps
    .map((step) => formatRecognitionStep(step))
    .filter((step) => step);
  if (steps.length > 0) {
    return steps.slice(-3).join(' -> ');
  }
  const summary = toCompactRecognitionText(
    typeof row?.recognitionSummary === 'string' ? row.recognitionSummary : '',
    180
  );
  return summary || '-';
}

function formatRecognitionSource(row) {
  const source = typeof row?.recognitionSource === 'string' && row.recognitionSource.trim()
    ? row.recognitionSource.trim()
    : (typeof row?.resumeDecisionSource === 'string' && row.resumeDecisionSource.trim()
      ? row.resumeDecisionSource.trim()
      : '');
  const stage = typeof row?.recognitionStage === 'string' ? row.recognitionStage.trim() : '';
  const status = typeof row?.recognitionStatus === 'string' ? row.recognitionStatus.trim() : '';
  const parts = [];
  if (source) parts.push(source);
  if (stage) parts.push(`stage=${stage}`);
  if (status) parts.push(`status=${status}`);
  return parts.length > 0 ? parts.join(' | ') : '-';
}

function renderSessionMeta(state) {
  sessionMeta.innerHTML = '';
  if (!state || typeof state !== 'object') {
    sessionMeta.textContent = 'Brak danych.';
    return;
  }

  const statusBadge = document.createElement('span');
  const status = typeof state.status === 'string' ? state.status.trim().toLowerCase() : 'idle';
  const badgeClass = (
    status === 'running'
    || status === 'completed'
    || status === 'failed'
    || status === 'idle'
  ) ? status : 'idle';
  statusBadge.className = `badge badge-${badgeClass}`;
  statusBadge.textContent = badgeClass;
  sessionMeta.appendChild(statusBadge);

  const detail = document.createElement('div');
  const phase = typeof state.phase === 'string' && state.phase.trim() ? state.phase.trim() : '-';
  const lines = [
    `Sesja: ${state.sessionId || '-'}`,
    `Origin: ${state.origin || '-'}`,
    `Scope: ${state.scope || '-'}`,
    `Phase: ${phase}`,
    `Start: ${formatDateTime(state.startedAt)}`,
    `Koniec: ${formatDateTime(state.finishedAt)}`,
    `Pending: ${Number.isInteger(state.pendingCount) ? state.pendingCount : 0}`,
    `Pass: ${Number.isInteger(state.passCount) ? state.passCount : 0}`
  ];
  if (state.error) lines.push(`Blad: ${state.error}`);
  detail.textContent = `\n${lines.join('\n')}`;
  sessionMeta.appendChild(detail);
}

function renderSummaryMeta(state) {
  if (!state || typeof state !== 'object') {
    summaryMeta.textContent = 'Brak danych.';
    return;
  }
  const summary = state.summary && typeof state.summary === 'object' ? state.summary : {};
  const rows = Array.isArray(state.rows) ? state.rows : [];
  const resumed = rows.filter((row) => row?.action === 'started').length;
  const pending = rows.filter(isPendingRow).length;
  const failed = rows.filter((row) => (
    row?.action === 'detect_failed'
    || row?.action === 'reload_failed'
    || row?.action === 'start_failed'
  )).length;
  const requested = Number.isInteger(state?.counts?.requestedProcesses)
    ? state.counts.requestedProcesses
    : rows.length;
  const eligible = Number.isInteger(state?.counts?.eligibleProcesses)
    ? state.counts.eligibleProcesses
    : (Number.isInteger(summary.reload_total) ? summary.reload_total : rows.length);

  summaryMeta.textContent = [
    `Strony: requested=${requested}, eligible=${eligible}`,
    `Wznowione: ${resumed}, pending: ${pending}, bledy: ${failed}`,
    `Summary: started=${summary.started || 0}, detect_failed=${summary.detect_failed || 0}, reload_failed=${summary.reload_failed || 0}, final=${summary.final_stage_completed || 0}, start_failed=${summary.start_failed || 0}`,
    `Liczniki: reload_ok=${summary.reload_ok || 0}/${summary.reload_total || 0}, prompt_bloki=${summary.prompt_blocks || 0}, odpowiedz_bloki=${summary.response_blocks || 0}, detected_prompts=${summary.detected_prompts || 0}`,
    `Rozpoznanie: saved=${summary.recognized_saved_stage || 0}, chat=${summary.recognized_chat_detection || 0}, counter_fb=${summary.recognized_chat_counter_fallback || 0}, progress_fb=${summary.recognized_progress_last_resort || 0}, unresolved=${summary.recognized_unresolved || 0}`,
    'Pipeline: saved_stage -> chat_extract -> chat_direct_signature -> chat_recent_history -> chat_resolution -> decision -> fallback_* -> start_dispatch'
  ].join('\n');
}

function renderValidationMeta(state) {
  validationMeta.innerHTML = '';
  if (!state || typeof state !== 'object') {
    validationMeta.textContent = 'Brak danych.';
    return;
  }
  const check = state.summaryCheck && typeof state.summaryCheck === 'object'
    ? state.summaryCheck
    : null;
  if (!check) {
    validationMeta.textContent = 'Walidacja jeszcze sie nie zakonczyla.';
    return;
  }

  const badge = document.createElement('span');
  badge.className = `badge ${check.ok ? 'badge-valid' : 'badge-invalid'}`;
  badge.textContent = check.ok ? 'OK' : 'MISMATCH';
  validationMeta.appendChild(badge);

  const details = document.createElement('div');
  const mismatchList = Array.isArray(check.mismatches) ? check.mismatches : [];
  if (mismatchList.length === 0) {
    details.textContent = '\nZliczanie summary jest poprawne.';
  } else {
    details.textContent = `\nRoznice: ${mismatchList.map((item) => (
      `${item.key}: expected=${item.expected}, calculated=${item.calculated}`
    )).join(' | ')}`;
  }
  validationMeta.appendChild(details);
}

function renderStageSnapshot(state) {
  stageBody.innerHTML = '';
  const rows = Array.isArray(state?.stageSnapshot) ? state.stageSnapshot : [];
  if (rows.length === 0) {
    stageBody.appendChild(createPlaceholderRow(5, 'Brak snapshotu etapow.'));
    return;
  }

  rows.forEach((item, index) => {
    const row = document.createElement('tr');
    const title = typeof item?.title === 'string' && item.title.trim()
      ? item.title.trim()
      : (item?.runId || '-');
    const stageInfo = formatPromptInfo(item?.currentPrompt, item?.totalPrompts, item?.stageName);
    const status = typeof item?.status === 'string' && item.status.trim() ? item.status.trim() : '-';
    const tabWindow = `T:${Number.isInteger(item?.tabId) ? item.tabId : '-'} / W:${Number.isInteger(item?.windowId) ? item.windowId : '-'}`;

    [String(index + 1), title, status, stageInfo, tabWindow].forEach((value) => {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.appendChild(cell);
    });
    stageBody.appendChild(row);
  });
}

function renderRows(state) {
  rowsBody.innerHTML = '';
  const rows = Array.isArray(state?.rows) ? state.rows : [];
  if (rows.length === 0) {
    rowsBody.appendChild(createPlaceholderRow(12, 'Czekam na dane sesji...'));
    return;
  }

  rows.forEach((item, index) => {
    const row = document.createElement('tr');
    const title = typeof item?.title === 'string' && item.title.trim()
      ? item.title.trim()
      : (item?.runId || '-');
    const beforeStage = formatPromptInfo(item?.progressPromptNumber, item?.totalPrompts, item?.progressStageName);
    const resolvedPrompt = Number.isInteger(item?.resolvedPromptNumber) ? item.resolvedPromptNumber : null;
    const resolvedSource = typeof item?.resolvedPromptSource === 'string' ? item.resolvedPromptSource.trim() : '';
    const detectedPromptForDisplay = Number.isInteger(resolvedPrompt)
      ? resolvedPrompt
      : item?.detectedPromptNumber;
    const detectedStageLabel = Number.isInteger(resolvedPrompt)
      ? `min:${resolvedSource || 'auto'}`
      : item?.detectedStageName;
    let detectedStage = formatPromptInfo(detectedPromptForDisplay, null, detectedStageLabel);
    if (item?.resolvedPromptMismatch) {
      detectedStage = `${detectedStage} [MIN]`;
    }
    const startFromPromptNumber = Number.isInteger(item?.restartDispatchedStartPromptNumber)
      ? item.restartDispatchedStartPromptNumber
      : (
        Number.isInteger(item?.restartPlannedStartPromptNumber)
          ? item.restartPlannedStartPromptNumber
          : (
            Number.isInteger(item?.nextStartIndex)
              ? (item.nextStartIndex + 1)
              : null
          )
      );
    const startFromMode = Number.isInteger(item?.restartDispatchedStartPromptNumber)
      ? 'dispatch'
      : (
        Number.isInteger(item?.restartPlannedStartPromptNumber)
          ? 'plan'
          : ''
      );
    const startFrom = Number.isInteger(startFromPromptNumber)
      ? `P${startFromPromptNumber}${startFromMode ? ` (${startFromMode})` : ''}`
      : '-';
    const missingReply = item?.restartMissingAssistantReply === true
      ? 'TAK'
      : (item?.restartMissingAssistantReply === false ? 'NIE' : '-');
    const recognitionSource = formatRecognitionSource(item);
    const recognitionPipeline = formatRecognitionPipeline(item);
    const reloadMethod = typeof item?.reloadMethod === 'string' && item.reloadMethod.trim()
      ? item.reloadMethod.trim()
      : '-';
    const action = actionLabel(item?.action);
    const actionClass = actionStatusClass(item?.action);
    const resumeState = resolveResumeState(item);
    const reasonBase = typeof item?.restartDecisionReason === 'string' && item.restartDecisionReason.trim()
      ? item.restartDecisionReason.trim()
      : (
        typeof item?.reason === 'string' && item.reason.trim()
          ? item.reason.trim()
          : ''
      );
    const dispatchStatus = typeof item?.restartDispatchStatus === 'string' && item.restartDispatchStatus.trim()
      ? item.restartDispatchStatus.trim()
      : '';
    const reason = reasonBase
      ? `${reasonBase}${dispatchStatus ? ` | ${dispatchStatus}` : ''}`
      : '-';

    const values = [
      String(index + 1),
      title,
      beforeStage,
      detectedStage,
      recognitionSource,
      recognitionPipeline,
      startFrom,
      missingReply,
      reloadMethod,
      action,
      resumeState.label,
      reason
    ];

    values.forEach((value, cellIndex) => {
      const cell = document.createElement('td');
      cell.textContent = value;
      if (cellIndex === 7) {
        if (item?.restartMissingAssistantReply === true) cell.className = 'status-warn';
        if (item?.restartMissingAssistantReply === false) cell.className = 'status-ok';
      }
      if (cellIndex === 9 && actionClass) cell.className = actionClass;
      if (cellIndex === 10 && resumeState.className) cell.className = resumeState.className;
      row.appendChild(cell);
    });

    rowsBody.appendChild(row);
  });
}

function renderEvents(state) {
  eventsContainer.innerHTML = '';
  const events = Array.isArray(state?.events) ? state.events.slice() : [];
  if (events.length === 0) {
    const placeholder = document.createElement('div');
    placeholder.className = 'placeholder';
    placeholder.textContent = 'Brak logow.';
    eventsContainer.appendChild(placeholder);
    return;
  }

  const ordered = events.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  ordered.forEach((item) => {
    const event = document.createElement('div');
    const level = item?.level === 'warn' || item?.level === 'error' ? item.level : 'info';
    event.className = `event event-${level}`;

    const meta = document.createElement('div');
    meta.className = 'event-meta';
    meta.textContent = `${formatDateTime(item?.ts)} | ${item?.code || 'event'}`;
    event.appendChild(meta);

    const text = document.createElement('div');
    text.className = 'event-text';
    text.textContent = item?.message || '-';
    event.appendChild(text);

    if (item?.details) {
      const details = document.createElement('div');
      details.className = 'event-details';
      details.textContent = item.details;
      event.appendChild(details);
    }

    eventsContainer.appendChild(event);
  });
}

function updateDocumentTitle(state) {
  const status = typeof state?.status === 'string' && state.status
    ? state.status.toUpperCase()
    : 'IDLE';
  const sessionPart = state?.sessionId ? ` ${state.sessionId}` : '';
  document.title = `[${status}] Reload + Resume${sessionPart}`;
}

function renderState(state) {
  renderSessionMeta(state);
  renderSummaryMeta(state);
  renderValidationMeta(state);
  renderStageSnapshot(state);
  renderRows(state);
  renderEvents(state);
  updateDocumentTitle(state);
}

function shouldRenderState(state) {
  if (!state || typeof state !== 'object') return false;
  const nextSessionId = typeof state.sessionId === 'string' ? state.sessionId : '';
  const nextUpdatedAt = Number.isInteger(state.updatedAt) ? state.updatedAt : 0;
  if (nextSessionId && nextSessionId !== lastRenderedSessionId) return true;
  if (nextUpdatedAt !== lastRenderedUpdatedAt) return true;
  return false;
}

function applyState(state) {
  if (!shouldRenderState(state)) return;
  if (!sessionId && typeof state?.sessionId === 'string' && state.sessionId.trim()) {
    sessionId = state.sessionId.trim();
  }
  lastRenderedSessionId = typeof state?.sessionId === 'string' ? state.sessionId : '';
  lastRenderedUpdatedAt = Number.isInteger(state?.updatedAt) ? state.updatedAt : Date.now();
  renderState(state);
}

async function fetchState() {
  try {
    const response = await sendRuntimeMessage({
      type: 'GET_RELOAD_RESUME_MONITOR_STATE',
      sessionId: sessionId || ''
    });
    if (response?.success === false) return;
    const state = response?.state;
    if (!state) return;
    applyState(state);
  } catch (error) {
    // Keep polling silently.
  }
}

if (chrome?.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'RELOAD_RESUME_MONITOR_UPDATE') return;
    const state = message?.state;
    if (!state || typeof state !== 'object') return;
    if (sessionId && state.sessionId !== sessionId) return;
    applyState(state);
  });
}

if (refreshBtn) {
  refreshBtn.addEventListener('click', () => {
    void fetchState();
  });
}

void fetchState();
setInterval(() => {
  void fetchState();
}, 1500);
