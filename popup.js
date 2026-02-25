function withActiveWindowContext(callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs && tabs.length > 0 ? tabs[0] : null;
    callback({
      activeTab,
      windowId: Number.isInteger(activeTab?.windowId) ? activeTab.windowId : null,
    });
  });
}

function sendRuntimeMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        const message = chrome.runtime.lastError.message || 'runtime_error';
        if (message.includes('before a response was received')) {
          resolve({});
          return;
        }
        reject(new Error(message));
        return;
      }
      resolve(response && typeof response === 'object' ? response : {});
    });
  });
}

function createReloadResumeMonitorSessionId(origin = 'popup') {
  const normalizedOrigin = typeof origin === 'string' && origin.trim()
    ? origin.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-')
    : 'popup';
  return `${normalizedOrigin || 'popup'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function openReloadResumeMonitorWindow(sessionId, options = {}) {
  if (typeof sessionId !== 'string' || !sessionId.trim()) return;
  const params = new URLSearchParams();
  params.set('sessionId', sessionId.trim());
  params.set('openedAt', String(Date.now()));
  if (typeof options?.origin === 'string' && options.origin.trim()) {
    params.set('origin', options.origin.trim());
  }
  if (typeof options?.composerThinkingEffort === 'string' && options.composerThinkingEffort.trim()) {
    params.set('composerThinkingEffort', options.composerThinkingEffort.trim());
  }
  const targetUrl = chrome.runtime.getURL(`reload-resume-monitor.html?${params.toString()}`);
  chrome.windows.create({
    url: targetUrl,
    type: 'popup',
    width: 1280,
    height: 900,
    focused: true
  });
}

const runStatus = document.getElementById('runStatus');
const copyYouTubeTranscriptBtn = document.getElementById('copyYouTubeTranscriptBtn');
const youtubeTranscriptStatus = document.getElementById('youtubeTranscriptStatus');
const watchlistDispatchStatus = document.getElementById('watchlistDispatchStatus');
const watchlistIntakeUrlInput = document.getElementById('watchlistIntakeUrlInput');
const watchlistKeyIdInput = document.getElementById('watchlistKeyIdInput');
const watchlistSecretInput = document.getElementById('watchlistSecretInput');
const saveWatchlistTokenBtn = document.getElementById('saveWatchlistTokenBtn');
const clearWatchlistTokenBtn = document.getElementById('clearWatchlistTokenBtn');
const flushWatchlistDispatchBtn = document.getElementById('flushWatchlistDispatchBtn');
const restoreProcessWindowsBtn = document.getElementById('restoreProcessWindowsBtn');
const repeatLastPromptAllBtn = document.getElementById('repeatLastPromptAllBtn');
const countCompanyMessagesBtn = document.getElementById('countCompanyMessagesBtn');
const resumeAllExtendedBtn = document.getElementById('resumeAllExtendedBtn');
const resumeAllHeavyBtn = document.getElementById('resumeAllHeavyBtn');
const restoreProcessWindowsStatus = document.getElementById('restoreProcessWindowsStatus');
const autoRestoreToggleBtn = document.getElementById('autoRestoreToggleBtn');
const autoRestoreStatus = document.getElementById('autoRestoreStatus');

const POPUP_SHORTCUTS = Object.freeze({
  manualSource: '1',
  runAnalysis: '2',
  resumeStage: '3',
  resumeAll: '4',
  responses: '5',
  processPanel: '6',
  stop: '7',
  copyYouTube: '8',
  restoreWindows: '9',
  autoRestoreToggle: '0'
});

function buildShortcutButtonHtml(label, shortcutKey) {
  const safeLabel = typeof label === 'string' ? label.trim() : '';
  const safeShortcut = typeof shortcutKey === 'string' ? shortcutKey.trim() : '';
  if (!safeShortcut) return safeLabel;
  return `${safeLabel} <span class="shortcut">${safeShortcut}</span>`;
}

function setShortcutButtonLabel(button, label, shortcutKey) {
  if (!button) return;
  button.innerHTML = buildShortcutButtonHtml(label, shortcutKey);
}

function setStatusElement(element, text, isError = false) {
  if (!element) return;
  const safeText = typeof text === 'string' ? text.trim() : '';
  if (!safeText) {
    element.textContent = '';
    element.hidden = true;
    return;
  }
  element.hidden = false;
  element.textContent = safeText;
  element.style.color = isError ? '#b91c1c' : '#374151';
  element.style.borderColor = isError ? '#fecaca' : '#d1d5db';
  element.style.background = isError ? '#fef2f2' : '#f3f4f6';
}

function setRunStatus(text, isError = false) {
  setStatusElement(runStatus, text, isError);
}

function setYouTubeTranscriptStatus(text, isError = false) {
  const compactText = String(text || '').replace(/^YouTube transcript:\s*/i, 'YT: ');
  if (youtubeTranscriptStatus) {
    setStatusElement(youtubeTranscriptStatus, compactText, isError);
    return;
  }
  setRunStatus(compactText, isError);
}

function setDispatchStatus(text, isError = false) {
  setStatusElement(watchlistDispatchStatus, text, isError);
}

function setRestoreProcessWindowsStatus(text, isError = false) {
  setStatusElement(restoreProcessWindowsStatus, text, isError);
}

function setAutoRestoreStatus(text, isError = false) {
  setStatusElement(autoRestoreStatus, text, isError);
}

function applyAutoRestoreUi(status) {
  const enabled = !!status?.enabled;
  const periodInMinutes = Number.isInteger(status?.periodInMinutes) && status.periodInMinutes > 0
    ? status.periodInMinutes
    : 5;
  if (autoRestoreToggleBtn) {
    setShortcutButtonLabel(
      autoRestoreToggleBtn,
      enabled ? `Auto co ${periodInMinutes} min: ON` : `Auto co ${periodInMinutes} min: OFF`,
      POPUP_SHORTCUTS.autoRestoreToggle
    );
    autoRestoreToggleBtn.dataset.enabled = enabled ? 'true' : 'false';
  }
}

const AUTO_RESTORE_ISSUE_LABELS = {
  needs_action: 'wymaga akcji',
  failed_status: 'status blad',
  missing_tab_context: 'brak kontekstu tab',
  tab_not_found: 'tab nieznaleziony',
  tab_not_chatgpt: 'tab poza ChatGPT',
  metrics_unavailable: 'brak metryk DOM',
  missing_assistant_reply: 'brak odpowiedzi assistant',
  assistant_reply_empty: 'pusta odpowiedz',
  assistant_reply_too_short: 'odpowiedz za krotka'
};

function getAutoRestoreIssueLabel(code) {
  const normalized = typeof code === 'string' ? code.trim() : '';
  if (!normalized) return '';
  return AUTO_RESTORE_ISSUE_LABELS[normalized] || normalized;
}

function formatAutoRestoreReasonCounts(reasonCounts) {
  if (!reasonCounts || typeof reasonCounts !== 'object') return '';
  const entries = Object.entries(reasonCounts)
    .filter((entry) => Number.isInteger(entry[1]) && entry[1] > 0)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4);
  if (entries.length === 0) return '';
  return entries
    .map((entry) => `${getAutoRestoreIssueLabel(entry[0])}: ${entry[1]}`)
    .join(', ');
}

function formatAutoRestoreIssueItem(item) {
  if (!item || typeof item !== 'object') return '';
  const title = safePreview(item.title || item.runId || 'process', 'process');
  const flags = Array.isArray(item.issueFlags)
    ? item.issueFlags.map(getAutoRestoreIssueLabel).filter(Boolean)
    : [];
  const words = Number.isInteger(item.lastAssistantWordCount) ? item.lastAssistantWordCount : 0;
  const sentences = Number.isInteger(item.lastAssistantSentenceCount) ? item.lastAssistantSentenceCount : 0;
  const promptInfo = Number.isInteger(item.currentPrompt) && Number.isInteger(item.totalPrompts) && item.totalPrompts > 0
    ? `P${item.currentPrompt}/${item.totalPrompts}`
    : 'P?';
  return `${title} -> ${flags.join(', ') || 'issue'} | ${promptInfo} | odp: ${words} slow, ${sentences} zdan`;
}

function formatAutoRestoreStatus(status) {
  if (!status || status.success === false) {
    return 'Automatyzacja: blad odczytu.';
  }
  const enabled = !!status.enabled;
  const periodInMinutes = Number.isInteger(status?.periodInMinutes) && status.periodInMinutes > 0
    ? status.periodInMinutes
    : 5;
  const nextRunAt = Number.isInteger(status.nextRunAt) ? new Date(status.nextRunAt).toLocaleString() : 'brak';
  const alarmActive = !!status.alarmActive;
  if (!enabled) {
    return 'Automatyzacja: wylaczona.';
  }
  const lines = [
    `Automatyzacja: WLACZONA (co ${periodInMinutes} min). Alarm: ${alarmActive ? 'aktywny' : 'brak'}. Nastepne uruchomienie: ${nextRunAt}.`
  ];

  const lastCycle = status?.lastCycle && typeof status.lastCycle === 'object'
    ? status.lastCycle
    : null;
  if (!lastCycle) {
    return lines.join('\n');
  }

  const check = lastCycle?.check && typeof lastCycle.check === 'object'
    ? lastCycle.check
    : {};
  const restore = lastCycle?.restore && typeof lastCycle.restore === 'object'
    ? lastCycle.restore
    : {};
  const scan = lastCycle?.scan && typeof lastCycle.scan === 'object'
    ? lastCycle.scan
    : {};
  const checkedAt = Number.isInteger(check?.checkedAt)
    ? new Date(check.checkedAt).toLocaleString()
    : (Number.isInteger(lastCycle?.ts) ? new Date(lastCycle.ts).toLocaleString() : 'brak');
  const checkedProcesses = Number.isInteger(check?.checkedProcesses) ? check.checkedProcesses : 0;
  const issueProcesses = Number.isInteger(check?.issueProcesses) ? check.issueProcesses : 0;
  const totalProcesses = Number.isInteger(check?.totalActiveProcesses) ? check.totalActiveProcesses : checkedProcesses;
  const reasonSummary = formatAutoRestoreReasonCounts(check?.reasonCounts);

  lines.push(`Ostatni check: ${checkedAt}. Procesy: ${checkedProcesses}/${totalProcesses}. Braki: ${issueProcesses}.`);
  lines.push(`Restore: requested=${restore?.requested || 0}, restored=${restore?.restored || 0}, failed=${restore?.failed || 0}.`);
  if (issueProcesses > 0) {
    lines.push(`Czego brakuje: ${reasonSummary || 'szczegoly niedostepne'}.`);
    const items = Array.isArray(check?.items) ? check.items.slice(0, 3) : [];
    items.forEach((item) => {
      const line = formatAutoRestoreIssueItem(item);
      if (line) lines.push(`- ${line}`);
    });
  }

  if (scan?.triggered) {
    const scanStarted = Number.isInteger(scan?.startedTabs) ? scan.startedTabs : 0;
    const scanMatched = Number.isInteger(scan?.matchedTabs) ? scan.matchedTabs : 0;
    const scanSuccess = scan?.success === true ? 'OK' : 'BLAD';
    const scanError = typeof scan?.error === 'string' && scan.error.trim()
      ? ` (${scan.error.trim()})`
      : '';
    lines.push(`Auto-skan: ${scanSuccess}, matched=${scanMatched}, started=${scanStarted}${scanError}.`);
  }

  return lines.join('\n');
}

async function refreshAutoRestoreStatus(forceSync = false) {
  if (!autoRestoreStatus) return;
  try {
    const response = await sendRuntimeMessage({
      type: 'GET_AUTO_RESTORE_WINDOWS_STATUS',
      forceSync,
    });
    applyAutoRestoreUi(response);
    setAutoRestoreStatus(formatAutoRestoreStatus(response), response?.success === false);
  } catch (error) {
    setAutoRestoreStatus(`Automatyzacja: ${error?.message || String(error)}`, true);
  }
}

function tokenSourceLabel(source) {
  if (source === 'inline_config') return 'inline config';
  if (source === 'storage_local') return 'local storage';
  if (source === 'storage_sync') return 'sync storage';
  return 'missing';
}

function safePreview(value, fallback = 'n/a') {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return fallback;
  return text.length > 48 ? `${text.slice(0, 45)}...` : text;
}

function formatLastDispatchFlush(lastFlush) {
  if (!lastFlush || typeof lastFlush !== 'object') return 'brak';
  const ts = Number.isInteger(lastFlush.ts) ? lastFlush.ts : null;
  const when = ts ? new Date(ts).toLocaleString() : 'n/a';
  if (lastFlush.skipped) {
    return `skip=${lastFlush.skipReason || 'n/a'} @ ${when}`;
  }
  return `sent=${lastFlush.sent || 0}, failed=${lastFlush.failed || 0}, remaining=${lastFlush.remaining || 0} @ ${when}`;
}

function formatLatestDispatchProcessLog(logs) {
  const latest = Array.isArray(logs) && logs.length > 0 ? logs[0] : null;
  if (!latest || typeof latest !== 'object') return '';
  const ts = Number.isInteger(latest.ts) ? latest.ts : null;
  const when = ts ? new Date(ts).toLocaleString() : 'n/a';
  const code = typeof latest.code === 'string' && latest.code.trim() ? latest.code.trim() : 'event';
  const level = typeof latest.level === 'string' && latest.level.trim() ? latest.level.trim() : 'info';
  const message = typeof latest.message === 'string' && latest.message.trim()
    ? latest.message.trim()
    : 'dispatch_event';
  const compactMessage = message.length > 120 ? `${message.slice(0, 117)}...` : message;
  return ` Ostatni etap DB: ${code}/${level} - ${compactMessage} @ ${when}.`;
}

function formatDispatchStatus(status) {
  if (!status || status.success === false) {
    return 'Intake status: blad odczytu.';
  }
  if (!status.enabled) {
    return 'Intake status: wylaczony.';
  }

  const queueSize = Number.isInteger(status.queueSize) ? status.queueSize : 0;
  const flushText = formatLastDispatchFlush(status.lastFlush);
  const retryText = Number.isInteger(status.nextRetryAt)
    ? ` Nastepna proba: ${new Date(status.nextRetryAt).toLocaleString()}.`
    : '';
  const errorText = status.latestOutboxError
    ? ` Ostatni blad: ${status.latestOutboxError}${status.latestOutboxErrorTrace ? ` (${status.latestOutboxErrorTrace})` : ''}.`
    : '';
  const latestProcessLogText = formatLatestDispatchProcessLog(status.recentProcessLogs);
  const base = `Kolejka: ${queueSize}. Ostatni flush: ${flushText}.${retryText}${errorText}${latestProcessLogText}`;

  if (status.configured) {
    return `Intake status: skonfigurowany (${tokenSourceLabel(status.tokenSource)}). URL: ${safePreview(status.intakeUrl)}. Key ID: ${safePreview(status.keyId)}. ${base}`;
  }
  if (status.reason === 'missing_intake_url') {
    return `Intake status: brak Intake URL. ${base}`;
  }
  if (status.reason === 'missing_key_id') {
    return `Intake status: brak Key ID. ${base}`;
  }
  if (status.reason === 'missing_dispatch_credentials') {
    return `Intake status: brak sekretu HMAC. ${base}`;
  }
  return `Intake status: ${status.reason || 'nieznany'}. ${base}`;
}

function formatDispatchFlushResult(flushResult) {
  if (!flushResult || typeof flushResult !== 'object') return 'brak danych';
  if (flushResult.skipped) {
    return `skip (${flushResult.reason || 'unknown'})`;
  }
  if (flushResult.success === false) {
    return `blad (${flushResult.error || 'unknown'})`;
  }
  return `sent=${flushResult.sent || 0}, failed=${flushResult.failed || 0}, deferred=${flushResult.deferred || 0}, remaining=${flushResult.remaining || 0}`;
}

async function refreshDispatchStatus(forceReload = false) {
  if (!watchlistDispatchStatus) return;
  try {
    const response = await sendRuntimeMessage({
      type: 'GET_WATCHLIST_DISPATCH_STATUS',
      forceReload,
    });
    if (response && typeof response === 'object') {
      if (watchlistIntakeUrlInput && typeof response.intakeUrl === 'string' && response.intakeUrl.trim()) {
        watchlistIntakeUrlInput.value = response.intakeUrl.trim();
      }
      if (watchlistKeyIdInput && typeof response.keyId === 'string' && response.keyId.trim()) {
        watchlistKeyIdInput.value = response.keyId.trim();
      }
    }
    setDispatchStatus(formatDispatchStatus(response), response?.success === false);
  } catch (error) {
    setDispatchStatus(`Intake status: ${error?.message || String(error)}`, true);
  }
}

const COMPANY_COUNT_PROCESS_ISSUE_LABELS = {
  missing_assistant_reply: 'brak odpowiedzi assistant po prompcie',
  assistant_reply_below_threshold: 'odpowiedzi ponizej progu jakosci',
  unrecognized_prompt_stage: 'nierozpoznane etapy promptow',
  sequence_issue: 'naruszona kolejnosc etapow'
};

function getCompanyCountProcessIssueLabel(code) {
  const normalized = typeof code === 'string' ? code.trim() : '';
  if (!normalized) return '';
  return COMPANY_COUNT_PROCESS_ISSUE_LABELS[normalized] || normalized;
}

function formatMissingReplyItem(item) {
  if (!item || typeof item !== 'object') return '';
  const index = Number.isInteger(item?.userMessageIndex) ? item.userMessageIndex : '?';
  const runId = Number.isInteger(item?.runId) ? item.runId : null;
  const promptNumber = Number.isInteger(item?.promptNumber) ? item.promptNumber : '?';
  const stageName = typeof item?.stageName === 'string' && item.stageName.trim()
    ? safePreview(item.stageName.trim(), '-')
    : '-';
  return `#${index}${runId ? `[R${runId}]` : ''}: P${promptNumber} (${stageName})`;
}

function formatLowQualityReplyItem(item) {
  if (!item || typeof item !== 'object') return '';
  const index = Number.isInteger(item?.userMessageIndex) ? item.userMessageIndex : '?';
  const runId = Number.isInteger(item?.runId) ? item.runId : null;
  const promptNumber = Number.isInteger(item?.promptNumber) ? item.promptNumber : '?';
  const words = Number.isInteger(item?.assistantReplyWordCount) ? item.assistantReplyWordCount : 0;
  const sentences = Number.isInteger(item?.assistantReplySentenceCount) ? item.assistantReplySentenceCount : 0;
  return `#${index}${runId ? `[R${runId}]` : ''}: P${promptNumber} (${words} slow, ${sentences} zdan)`;
}

function formatCompanyProcessCounterAlert(response) {
  if (!response || response.success !== true) return '';
  const totals = response?.totals && typeof response.totals === 'object' ? response.totals : {};
  const missingReplyCount = Number.isInteger(totals?.promptRepliesMissing) ? totals.promptRepliesMissing : 0;
  const lowQualityCount = Number.isInteger(totals?.promptRepliesBelowThreshold) ? totals.promptRepliesBelowThreshold : 0;
  const missingReplyPromptNumbers = Array.isArray(response?.missingReplyPromptNumbers)
    ? response.missingReplyPromptNumbers
    : [];
  const lowQualityReplyPromptNumbers = Array.isArray(response?.lowQualityReplyPromptNumbers)
    ? response.lowQualityReplyPromptNumbers
    : [];

  if (missingReplyCount <= 0 && lowQualityCount <= 0) {
    return 'Licznik procesu: OK (brak brakujacych i niskiej jakosci odpowiedzi).';
  }

  const parts = [];
  if (missingReplyCount > 0) {
    const missingPromptText = missingReplyPromptNumbers.length > 0
      ? `; etapy=${missingReplyPromptNumbers.map((item) => `P${item}`).join(',')}`
      : '';
    parts.push(`brak_odpowiedzi=${missingReplyCount}${missingPromptText}`);
  }
  if (lowQualityCount > 0) {
    const lowQualityPromptText = lowQualityReplyPromptNumbers.length > 0
      ? `; etapy=${lowQualityReplyPromptNumbers.map((item) => `P${item}`).join(',')}`
      : '';
    parts.push(`jakosc_niska=${lowQualityCount}${lowQualityPromptText}`);
  }
  return `Licznik procesu: WYMAGA AKCJI (${parts.join(' | ')}).`;
}

function formatCompanyConversationCountError(response) {
  const errorCode = typeof response?.error === 'string' ? response.error.trim() : '';
  if (!errorCode) return 'unknown_error';
  if (errorCode === 'invalid_tab_id' || errorCode === 'tab_not_found') return 'brak aktywnej karty.';
  if (errorCode === 'tab_not_chatgpt') return 'aktywna karta nie jest konwersacja ChatGPT.';
  if (errorCode === 'prompts_not_loaded') return 'prompty company nie sa zaladowane.';
  if (errorCode === 'conversation_scan_failed') return 'nie udalo sie odczytac calej konwersacji.';
  return errorCode;
}

function formatCompanyConversationCountStatus(response) {
  if (!response || response.success !== true) {
    return `Liczenie company: ${formatCompanyConversationCountError(response)}`;
  }

  const totals = response?.totals && typeof response.totals === 'object' ? response.totals : {};
  const thresholds = response?.thresholds && typeof response.thresholds === 'object' ? response.thresholds : {};
  const verification = response?.verification && typeof response.verification === 'object' ? response.verification : {};
  const stageMappingCheck = response?.stageMappingCheck && typeof response.stageMappingCheck === 'object'
    ? response.stageMappingCheck
    : {};
  const stageMapping = Array.isArray(response?.stageMapping) ? response.stageMapping : [];
  const promptCoverage = Array.isArray(response?.promptCoverage) ? response.promptCoverage : [];
  const assignmentLog = Array.isArray(response?.assignmentLog) ? response.assignmentLog : [];
  const missingPromptNumbers = Array.isArray(response?.missingPromptNumbers) ? response.missingPromptNumbers : [];
  const duplicatePromptNumbers = Array.isArray(response?.duplicatePromptNumbers) ? response.duplicatePromptNumbers : [];
  const missingReplyPromptNumbers = Array.isArray(response?.missingReplyPromptNumbers)
    ? response.missingReplyPromptNumbers
    : [];
  const lowQualityReplyPromptNumbers = Array.isArray(response?.lowQualityReplyPromptNumbers)
    ? response.lowQualityReplyPromptNumbers
    : [];
  const missingReplyRows = Array.isArray(response?.missingReplyRows) ? response.missingReplyRows : [];
  const lowQualityReplyRows = Array.isArray(response?.lowQualityReplyRows) ? response.lowQualityReplyRows : [];
  const processIssueFlags = Array.isArray(response?.processIssueFlags) ? response.processIssueFlags : [];
  const processState = typeof response?.processState === 'string'
    ? response.processState.trim().toLowerCase()
    : '';
  const unmatchedUserSamples = Array.isArray(response?.unmatchedUserSamples) ? response.unmatchedUserSamples : [];
  const sequenceIssues = Array.isArray(response?.sequenceIssues) ? response.sequenceIssues : [];
  const runResets = Array.isArray(response?.runResets) ? response.runResets : [];

  const lines = [];
  lines.push('[Company count]');
  lines.push(`Konwersacja: user=${totals.totalUserMessages || 0}, assistant=${totals.totalAssistantMessages || 0}, wszystkie=${totals.totalMessages || 0}`);
  lines.push(`Prompty rozpoznane: ${totals.matchedPromptMessages || 0}/${response.promptCatalogCount || 0} (unique=${totals.recognizedUniquePrompts || 0}, nierozpoznane_user=${totals.unmatchedUserMessages || 0}, runy=${totals.detectedRuns || 0})`);
  lines.push(`Odpowiedzi: present=${totals.promptRepliesPresent || 0}, missing=${totals.promptRepliesMissing || 0}, quality_ok=${totals.promptRepliesPassingThreshold || 0}, quality_low=${totals.promptRepliesBelowThreshold || 0} (prog: ${thresholds.minAssistantWords || 0} slow, ${thresholds.minAssistantSentences || 0} zdan)`);
  const resolvedProcessState = processState || (
    (totals.promptRepliesMissing || 0) > 0
      ? 'needs_action'
      : ((totals.promptRepliesBelowThreshold || 0) > 0 ? 'warning' : 'ok')
  );
  const processStateLabel = resolvedProcessState === 'needs_action'
    ? 'WYMAGA AKCJI'
    : (resolvedProcessState === 'warning' ? 'UWAGA' : 'OK');
  lines.push(`Status procesu (licznik): ${processStateLabel}`);
  if (processIssueFlags.length > 0) {
    const processIssueText = processIssueFlags
      .map((item) => getCompanyCountProcessIssueLabel(item))
      .filter(Boolean)
      .join(', ');
    lines.push(`Alert procesu: ${processIssueText || 'wykryto problemy procesu'}`);
  }

  const missingReplyItemsText = missingReplyRows
    .slice(0, 6)
    .map((entry) => formatMissingReplyItem(entry))
    .filter(Boolean)
    .join(' | ');
  const missingReplyStagesText = missingReplyPromptNumbers.length > 0
    ? missingReplyPromptNumbers.map((item) => `P${item}`).join(', ')
    : 'brak';
  lines.push(`Brakujace odpowiedzi (instancje): ${missingReplyItemsText || 'brak'}${missingReplyRows.length > 6 ? ' | ...' : ''}`);
  lines.push(`Brakujace odpowiedzi (etapy): ${missingReplyStagesText}`);
  if ((totals.promptRepliesMissing || 0) > 0) {
    lines.push('Akcja procesu: uruchom "Powtorz ostatni prompt (wszystkie)" albo "Reload + wznow wszystkie".');
  }

  const lowQualityItemsText = lowQualityReplyRows
    .slice(0, 6)
    .map((entry) => formatLowQualityReplyItem(entry))
    .filter(Boolean)
    .join(' | ');
  const lowQualityStagesText = lowQualityReplyPromptNumbers.length > 0
    ? lowQualityReplyPromptNumbers.map((item) => `P${item}`).join(', ')
    : 'brak';
  lines.push(`Niska jakosc odpowiedzi (instancje): ${lowQualityItemsText || 'brak'}${lowQualityReplyRows.length > 6 ? ' | ...' : ''}`);
  lines.push(`Niska jakosc odpowiedzi (etapy): ${lowQualityStagesText}`);

  const missingText = missingPromptNumbers.length > 0 ? missingPromptNumbers.join(', ') : 'brak';
  const duplicateText = duplicatePromptNumbers.length > 0 ? duplicatePromptNumbers.join(', ') : 'brak';
  lines.push(`Brakujace prompty (nierozpoznane w konwersacji): ${missingText}`);
  lines.push(`Duplikaty promptow: ${duplicateText}`);

  lines.push(
    `Walidacja: prompts=${verification.allPromptsDetected ? 'OK' : 'NIE'}, replies=${verification.allMatchedPromptsHaveReply ? 'OK' : 'NIE'}, quality=${verification.allMatchedRepliesPassThreshold ? 'OK' : 'NIE'}, kolejnosc=${verification.sequenceNonDecreasing ? 'OK' : 'NIE'}${verification.userMetaTruncated ? ', meta_ucinane=TAK' : ''}`
  );
  lines.push('');

  const stageCount = Number.isInteger(stageMappingCheck?.stageNameCount) ? stageMappingCheck.stageNameCount : 0;
  const promptCount = Number.isInteger(stageMappingCheck?.promptCount) ? stageMappingCheck.promptCount : 0;
  const stageAligned = stageMappingCheck?.alignedByCount === true;
  const missingStageNames = Array.isArray(stageMappingCheck?.missingStageNames) ? stageMappingCheck.missingStageNames : [];
  lines.push('[Mapowanie prompt -> etap]');
  lines.push(`Liczba promptow=${promptCount}, liczba stage names=${stageCount}, align=${stageAligned ? 'TAK' : 'NIE'}`);
  if (missingStageNames.length > 0) {
    lines.push(`Brak nazw etapu dla: ${missingStageNames.join(', ')}`);
  }
  if (stageMapping.length > 0) {
    stageMapping.forEach((entry) => {
      const promptNumber = Number.isInteger(entry?.promptNumber) ? entry.promptNumber : '?';
      const stageName = typeof entry?.stageName === 'string' && entry.stageName.trim()
        ? entry.stageName.trim()
        : '-';
      lines.push(`P${promptNumber}: ${stageName}`);
    });
  } else {
    lines.push('Brak danych mapowania etapow.');
  }
  lines.push('');

  if (promptCoverage.length > 0) {
    lines.push('[Pokrycie etapow]');
    promptCoverage.forEach((entry) => {
      const promptNumber = Number.isInteger(entry?.promptNumber) ? entry.promptNumber : '?';
      const stageName = typeof entry?.stageName === 'string' && entry.stageName.trim()
        ? entry.stageName.trim()
        : '-';
      const occurrences = Number.isInteger(entry?.occurrences) ? entry.occurrences : 0;
      const repliesPresent = Number.isInteger(entry?.repliesPresent) ? entry.repliesPresent : 0;
      const repliesPassingThreshold = Number.isInteger(entry?.repliesPassingThreshold) ? entry.repliesPassingThreshold : 0;
      lines.push(`P${promptNumber} ${stageName}: occ=${occurrences}, present=${repliesPresent}, quality_ok=${repliesPassingThreshold}`);
    });
    lines.push('');
  }

  if (assignmentLog.length > 0) {
    lines.push('[Sekwencja user -> prompt]');
    const limit = 16;
    assignmentLog.slice(0, limit).forEach((entry) => {
      const index = Number.isInteger(entry?.userMessageIndex) ? entry.userMessageIndex : '?';
      const runId = Number.isInteger(entry?.runId) ? entry.runId : null;
      const assignedPrompt = typeof entry?.assignedPrompt === 'string' ? entry.assignedPrompt : '-';
      const stageName = typeof entry?.stageName === 'string' ? entry.stageName : '-';
      const method = typeof entry?.method === 'string' ? entry.method : '-';
      const score = Number.isFinite(entry?.score) ? entry.score : null;
      const signals = typeof entry?.signals === 'string' && entry.signals.trim()
        ? entry.signals.trim()
        : '';
      const assistantReply = typeof entry?.assistantReply === 'string' ? entry.assistantReply : 'no';
      const qualityPass = typeof entry?.qualityPass === 'string' ? entry.qualityPass : 'no';
      lines.push(
        `#${index}${runId ? ` [R${runId}]` : ''}: ${assignedPrompt} | ${stageName} | method=${method}${score !== null ? `, score=${score}` : ''}${signals ? `, signals=${signals}` : ''} | reply=${assistantReply}, quality=${qualityPass}`
      );
    });
    if (assignmentLog.length > limit) {
      lines.push(`... +${assignmentLog.length - limit} kolejnych wpisow`);
    }
    lines.push('');
  }

  if (runResets.length > 0) {
    lines.push('[Restarty runow]');
    runResets.slice(0, 6).forEach((item) => {
      lines.push(
        `R${item.fromRunId} -> R${item.toRunId}: #${item.fromUserMessageIndex} P${item.fromPromptNumber} -> #${item.toUserMessageIndex} P${item.toPromptNumber}`
      );
    });
    if (runResets.length > 6) {
      lines.push(`... +${runResets.length - 6} kolejnych restartow`);
    }
    lines.push('');
  }

  if (sequenceIssues.length > 0) {
    const compactSequenceIssues = sequenceIssues
      .slice(0, 4)
      .map((item) => `R${item.runId || '?'}:#${item.userMessageIndex}:P${item.previousPromptNumber}->P${item.currentPromptNumber}`)
      .join(', ');
    lines.push(`[Problemy kolejnosci] ${compactSequenceIssues}${sequenceIssues.length > 4 ? ', ...' : ''}`);
    lines.push('');
  }

  if (unmatchedUserSamples.length > 0) {
    const compactUnmatched = unmatchedUserSamples
      .slice(0, 3)
      .map((item) => `#${item.userMessageIndex}[${item.reason}]: ${safePreview(item.preview || '', '-')}`)
      .join(' | ');
    lines.push(`[Nierozpoznane user] ${compactUnmatched}${unmatchedUserSamples.length > 3 ? ' | ...' : ''}`);
  }

  return lines.join('\n');
}

async function executeCountCompanyMessagesFromPopup(button) {
  if (!button) return;

  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Licze...';
  setRunStatus('Licze wszystkie wiadomosci company na aktywnej konwersacji...');

  try {
    const activeTab = await getActiveTabInCurrentWindow();
    const response = await sendRuntimeMessage({
      type: 'COUNT_COMPANY_CONVERSATION_MESSAGES',
      tabId: Number.isInteger(activeTab?.id) ? activeTab.id : null,
      origin: 'popup-company-conversation-count'
    });
    if (!response || response.success !== true) {
      const errorText = `Liczenie company: ${formatCompanyConversationCountError(response)}`;
      setRunStatus(errorText, true);
      setRestoreProcessWindowsStatus(`Licznik procesu: blad (${formatCompanyConversationCountError(response)})`, true);
      return;
    }

    const responseTotals = response?.totals && typeof response.totals === 'object' ? response.totals : {};
    const hasProcessIssue = (
      (Number.isInteger(responseTotals?.promptRepliesMissing) && responseTotals.promptRepliesMissing > 0)
      || (Number.isInteger(responseTotals?.promptRepliesBelowThreshold) && responseTotals.promptRepliesBelowThreshold > 0)
      || response?.processState === 'needs_action'
    );
    setRunStatus(formatCompanyConversationCountStatus(response), hasProcessIssue);
    setRestoreProcessWindowsStatus(formatCompanyProcessCounterAlert(response), hasProcessIssue);
  } catch (error) {
    const errorText = `Liczenie company: ${error?.message || String(error)}`;
    setRunStatus(errorText, true);
    setRestoreProcessWindowsStatus(`Licznik procesu: blad (${error?.message || String(error)})`, true);
  } finally {
    button.disabled = false;
    button.textContent = originalText || 'Policz wszystkie wiadomosci (company)';
  }
}

async function executeRunAnalysisFromPopup(button, options = {}) {
  if (!button) return;

  const originalHtml = button.innerHTML;
  button.disabled = true;
  button.textContent = 'Uruchamiam...';
  setRunStatus('Uruchamiam analizy...');

  try {
    const payload = {
      type: 'RUN_ANALYSIS',
      origin: typeof options?.origin === 'string' ? options.origin : 'popup-run-analysis',
    };
    if (Number.isInteger(options?.windowId)) {
      payload.windowId = options.windowId;
    }

    const response = await sendRuntimeMessage(payload);
    if (response?.success === false) {
      const runError = response.error || 'Nie udalo sie uruchomic analiz.';
      const runMessage = runError === 'prompts_not_loaded'
        ? 'Blad: Brak promptow company. Odswiez rozszerzenie i sprobuj ponownie.'
        : `Blad: ${runError}`;
      setRunStatus(runMessage, true);
      return;
    }

    setRunStatus('Uruchomiono analizy.');
  } catch (error) {
    setRunStatus(`Blad: ${error?.message || String(error)}`, true);
  } finally {
    button.disabled = false;
    button.innerHTML = originalHtml;
  }
}

function getResumeAllSummary(response) {
  const summary = response?.summary && typeof response.summary === 'object'
    ? response.summary
    : {};
  const rows = Array.isArray(response?.results) ? response.results : [];
  const scannedTabs = Number.isInteger(response?.scannedTabs)
    ? response.scannedTabs
    : Number.isInteger(response?.eligibleProcesses)
      ? response.eligibleProcesses
      : rows.length;
  const startedTabs = Number.isInteger(summary?.started)
    ? summary.started
    : Number.isInteger(response?.startedTabs)
      ? response.startedTabs
      : Number.isInteger(response?.resumedTabs)
        ? response.resumedTabs
        : 0;
  const detectFailed = Number.isInteger(summary?.detect_failed)
    ? summary.detect_failed
    : rows.filter((row) => row?.action === 'detect_failed').length;
  const reloadFailed = Number.isInteger(summary?.reload_failed)
    ? summary.reload_failed
    : rows.filter((row) => row?.action === 'reload_failed').length;
  const skippedOutsideInvest = Number.isInteger(summary?.skipped_outside_invest)
    ? summary.skipped_outside_invest
    : rows.filter((row) => row?.action === 'skipped_outside_invest').length;
  const finalStageCompleted = Number.isInteger(summary?.final_stage_completed)
    ? summary.final_stage_completed
    : rows.filter((row) => row?.action === 'final_stage_already_sent').length;
  const startFailed = Number.isInteger(summary?.start_failed)
    ? summary.start_failed
    : rows.filter((row) => row?.action === 'start_failed').length;
  const reloadOk = Number.isInteger(summary?.reload_ok)
    ? summary.reload_ok
    : rows.filter((row) => typeof row?.reloadMethod === 'string' && row.reloadMethod.trim()).length;
  const reloadTotal = Number.isInteger(summary?.reload_total)
    ? summary.reload_total
    : rows.length;
  const promptBlocks = Number.isInteger(summary?.prompt_blocks)
    ? summary.prompt_blocks
    : rows.reduce((sum, row) => sum + (Number.isInteger(row?.userMessageCount) ? row.userMessageCount : 0), 0);
  const responseBlocks = Number.isInteger(summary?.response_blocks)
    ? summary.response_blocks
    : rows.reduce((sum, row) => {
      if (Number.isInteger(row?.responseBlockCount)) return sum + row.responseBlockCount;
      if (Number.isInteger(row?.assistantMessageCount)) return sum + row.assistantMessageCount;
      return sum;
    }, 0);
  const missingRepliesDetected = Number.isInteger(summary?.missing_replies_detected)
    ? summary.missing_replies_detected
    : rows.filter((row) => row?.restartMissingAssistantReply === true).length;
  const dataGapsDetected = Number.isInteger(summary?.data_gaps_detected)
    ? summary.data_gaps_detected
    : rows.filter((row) => {
      if (row?.dataGapDetected === true) return true;
      const marker = [
        typeof row?.reason === 'string' ? row.reason : '',
        typeof row?.restartDecisionReason === 'string' ? row.restartDecisionReason : '',
        typeof row?.recognitionSummary === 'string' ? row.recognitionSummary : ''
      ].join(' ');
      return /\bdata[_\s-]?gaps?\b/i.test(marker);
    }).length;
  const detectedPrompts = Number.isInteger(summary?.detected_prompts)
    ? summary.detected_prompts
    : rows.filter((row) => Number.isInteger(row?.detectedPromptNumber)).length;
  const recognizedSavedStage = Number.isInteger(summary?.recognized_saved_stage)
    ? summary.recognized_saved_stage
    : rows.filter((row) => row?.recognitionSource === 'saved_stage_snapshot' || row?.resumeDecisionSource === 'saved_stage_snapshot').length;
  const recognizedChatDetection = Number.isInteger(summary?.recognized_chat_detection)
    ? summary.recognized_chat_detection
    : rows.filter((row) => row?.recognitionSource === 'chat_fallback_detection' || row?.resumeDecisionSource === 'chat_fallback_detection').length;
  const recognizedCounterFallback = Number.isInteger(summary?.recognized_chat_counter_fallback)
    ? summary.recognized_chat_counter_fallback
    : rows.filter((row) => row?.recognitionSource === 'chat_counter_fallback' || row?.resumeDecisionSource === 'chat_counter_fallback').length;
  const recognizedProgressFallback = Number.isInteger(summary?.recognized_progress_last_resort)
    ? summary.recognized_progress_last_resort
    : rows.filter((row) => row?.recognitionSource === 'progress_last_resort_fallback' || row?.resumeDecisionSource === 'progress_last_resort_fallback').length;
  const recognizedUnresolved = Number.isInteger(summary?.recognized_unresolved)
    ? summary.recognized_unresolved
    : rows.filter((row) => row?.action === 'detect_failed').length;

  return `Procesy: ${scannedTabs}, started: ${startedTabs}, final_completed: ${finalStageCompleted}, start_failed: ${startFailed}, detect_failed: ${detectFailed}, reload_failed: ${reloadFailed}, reload_ok: ${reloadOk}/${reloadTotal}, skipped_outside_invest: ${skippedOutsideInvest}, prompt_bloki: ${promptBlocks}, odpowiedz_bloki: ${responseBlocks}, missing_reply_detected: ${missingRepliesDetected}, data_gaps: ${dataGapsDetected}, detected_prompts: ${detectedPrompts}, rozpoznanie[saved=${recognizedSavedStage}, chat=${recognizedChatDetection}, counter_fb=${recognizedCounterFallback}, progress_fb=${recognizedProgressFallback}, unresolved=${recognizedUnresolved}], pipeline=saved_stage->chat_extract->chat_resolution->fallback->start_dispatch`;
}

async function executeResumeAllFromPopup(button, options = {}) {
  if (!button) return;

  const origin = typeof options?.origin === 'string' ? options.origin : 'popup-resume-all';
  const composerThinkingEffort = typeof options?.composerThinkingEffort === 'string'
    ? options.composerThinkingEffort.trim().toLowerCase()
    : '';
  const hasExplicitThinkingEffort = (
    composerThinkingEffort === 'light'
    || composerThinkingEffort === 'standard'
    || composerThinkingEffort === 'extended'
    || composerThinkingEffort === 'heavy'
  );
  const effortSuffix = composerThinkingEffort ? ` (${composerThinkingEffort})` : '';
  const monitorSessionId = createReloadResumeMonitorSessionId(origin);
  const originalHtml = button.innerHTML;
  button.disabled = true;
  button.textContent = `Reload + wznawiam${effortSuffix}...`;
  setRunStatus(
    composerThinkingEffort
      ? `Reload + wznowienie aktywnych procesow company (INVEST), tryb: ${composerThinkingEffort}.`
      : 'Reload + wznowienie aktywnych procesow company (INVEST)...'
  );
  openReloadResumeMonitorWindow(monitorSessionId, {
    origin,
    composerThinkingEffort
  });

  try {
    const message = {
      type: 'DETECT_LAST_COMPANY_PROMPT_AND_RESUME',
      origin,
      scope: 'active_company_invest_processes',
      monitorSessionId
    };
    if (hasExplicitThinkingEffort) {
      message.composerThinkingEffort = composerThinkingEffort;
    }
    const response = await sendRuntimeMessage(message);

    if (!response || Object.keys(response).length === 0) {
      setRunStatus(
        composerThinkingEffort
          ? `Polecenie reload + wznowienia (${composerThinkingEffort}) zostalo wyslane.`
          : 'Polecenie reload + wznowienia zostalo wyslane.'
      );
      return;
    }

    if (response.success === false) {
      setRunStatus(`Blad: ${response.error || 'Nie udalo sie wykonac reload + wznowienia procesow.'}`, true);
      return;
    }

    setRunStatus(
      composerThinkingEffort
        ? `Tryb ${composerThinkingEffort}: ${getResumeAllSummary(response)}`
        : getResumeAllSummary(response)
    );
  } catch (error) {
    setRunStatus(`Blad: ${error?.message || String(error)}`, true);
  } finally {
    button.disabled = false;
    button.innerHTML = originalHtml;
  }
}

async function executeRepeatLastPromptAllFromPopup(button, options = {}) {
  if (!button) return;

  const origin = typeof options?.origin === 'string' ? options.origin : 'popup-repeat-last-prompt-all';
  const monitorSessionId = createReloadResumeMonitorSessionId(origin);
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Powtarzam...';
  setRunStatus('Powtarzam ostatni prompt we wszystkich aktywnych procesach company...');
  openReloadResumeMonitorWindow(monitorSessionId, {
    origin,
    forceRepeatLastPrompt: true
  });

  try {
    const response = await sendRuntimeMessage({
      type: 'DETECT_LAST_COMPANY_PROMPT_AND_RESUME',
      origin,
      scope: 'active_company_invest_processes',
      forceRepeatLastPrompt: true,
      monitorSessionId
    });

    if (!response || Object.keys(response).length === 0) {
      setRunStatus('Polecenie powtorzenia promptu zostalo wyslane.');
      return;
    }

    if (response.success === false) {
      setRunStatus(`Blad: ${response.error || 'Nie udalo sie powtorzyc ostatniego promptu we wszystkich procesach.'}`, true);
      return;
    }

    setRunStatus(`Powtorzanie promptu: ${getResumeAllSummary(response)}`);
  } catch (error) {
    setRunStatus(`Blad: ${error?.message || String(error)}`, true);
  } finally {
    button.disabled = false;
    button.textContent = originalText || 'Powtorz ostatni prompt (wszystkie)';
  }
}

function formatSmartResumeStatus(response) {
  const startPromptNumber = Number.isInteger(response?.startPromptNumber)
    ? response.startPromptNumber
    : null;
  const detectedPromptNumber = Number.isInteger(response?.detectedPromptNumber)
    ? response.detectedPromptNumber
    : null;
  const retrySamePrompt = response?.retrySamePrompt === true;
  const retryReason = typeof response?.retryReason === 'string' ? response.retryReason : '';

  if (response?.success) {
    if (retrySamePrompt && startPromptNumber) {
      if (retryReason === 'assistant_reply_too_short') {
        return `Wznowiono ponownie Prompt ${startPromptNumber} (odpowiedz byla za krotka).`;
      }
      return `Wznowiono ponownie Prompt ${startPromptNumber} (brak odpowiedzi po ostatnim wyslaniu).`;
    }
    if (startPromptNumber && detectedPromptNumber) {
      return `Wznowiono od Prompt ${startPromptNumber} (wykryto ostatni: ${detectedPromptNumber}).`;
    }
    if (startPromptNumber) {
      return `Wznowiono od Prompt ${startPromptNumber}.`;
    }
    return 'Wznowiono automatycznie.';
  }

  const errorCode = typeof response?.error === 'string' ? response.error : '';
  if (errorCode === 'already_at_last_prompt') {
    return 'Proces wyglada na zakonczony (brak kolejnego promptu).';
  }
  if (errorCode === 'prompts_not_loaded') {
    return 'Brak promptow company. Odswiez rozszerzenie i sprobuj ponownie.';
  }
  if (errorCode === 'chat_tab_not_found') {
    return 'Aktywna karta nie jest ChatGPT.';
  }
  if (errorCode === 'signature_not_found' || errorCode === 'empty_user_message') {
    return 'Nie wykryto etapu automatycznie. Otwieram wybor etapu...';
  }
  if (errorCode === 'run_not_found') {
    return 'Brak aktywnego procesu dla tej karty. Otwieram wybor etapu...';
  }
  return `Nie udalo sie automatycznie wznowic (${errorCode || 'unknown'}). Otwieram wybor etapu...`;
}

async function executeSmartResumeStageFromPopup(button, options = {}) {
  if (!button) return;

  const originalHtml = button.innerHTML;
  button.disabled = true;
  setShortcutButtonLabel(button, 'Wykrywam etap...', POPUP_SHORTCUTS.resumeStage);
  setRunStatus('Wykrywam etap i status odpowiedzi...');

  try {
    const response = await sendRuntimeMessage({
      type: 'PROCESS_RESUME_NEXT_STAGE',
      tabId: Number.isInteger(options?.tabId) ? options.tabId : null,
      windowId: Number.isInteger(options?.windowId) ? options.windowId : null,
      chatUrl: typeof options?.chatUrl === 'string' ? options.chatUrl : '',
      title: typeof options?.title === 'string' ? options.title : '',
      openDialogOnly: false
    });

    if (response?.success) {
      setRunStatus(formatSmartResumeStatus(response), false);
      return;
    }

    const statusText = formatSmartResumeStatus(response);
    const errorCode = typeof response?.error === 'string' ? response.error : '';
    const shouldFallbackToDialog = (
      errorCode === 'signature_not_found'
      || errorCode === 'empty_user_message'
      || errorCode === 'run_not_found'
    );

    if (shouldFallbackToDialog) {
      chrome.runtime.sendMessage({
        type: 'RESUME_STAGE_OPEN',
        tabId: Number.isInteger(options?.tabId) ? options.tabId : null,
        windowId: Number.isInteger(options?.windowId) ? options.windowId : null,
        title: typeof options?.title === 'string' ? options.title : ''
      });
      setRunStatus(statusText, true);
      window.close();
      return;
    }

    setRunStatus(statusText, true);
  } catch (error) {
    chrome.runtime.sendMessage({
      type: 'RESUME_STAGE_OPEN',
      tabId: Number.isInteger(options?.tabId) ? options.tabId : null,
      windowId: Number.isInteger(options?.windowId) ? options.windowId : null,
      title: typeof options?.title === 'string' ? options.title : ''
    });
    setRunStatus(`Blad auto-wznowienia: ${error?.message || String(error)}. Otwieram wybor etapu...`, true);
    window.close();
  } finally {
    button.disabled = false;
    button.innerHTML = originalHtml;
  }
}

function isYouTubeUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return false;
  try {
    const parsed = new URL(rawUrl);
    const host = String(parsed.hostname || '').toLowerCase();
    return host.includes('youtube.com') || host.includes('youtu.be');
  } catch (error) {
    return false;
  }
}

async function getActiveTabInCurrentWindow() {
  const tabs = await new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (rows) => resolve(Array.isArray(rows) ? rows : []));
  });
  return tabs.length > 0 ? tabs[0] : null;
}

async function refreshYouTubeTranscriptHint() {
  try {
    const activeTab = await getActiveTabInCurrentWindow();
    if (!activeTab || !Number.isInteger(activeTab.id)) {
      setYouTubeTranscriptStatus('YouTube transcript: brak aktywnej karty.', false);
      return;
    }
    if (!isYouTubeUrl(activeTab.url || '')) {
      setYouTubeTranscriptStatus('YouTube transcript: otworz karte YouTube i kliknij "Kopiuj".', false);
      return;
    }
    setYouTubeTranscriptStatus('YouTube transcript: gotowy do pobrania.', false);
  } catch (error) {
    setYouTubeTranscriptStatus(`YouTube transcript: ${error?.message || String(error)}`, true);
  }
}

async function fallbackCopyText(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'readonly');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    const copied = document.execCommand('copy');
    if (!copied) throw new Error('execCommand_copy_failed');
  } finally {
    textarea.remove();
  }
}

async function copyTextToClipboard(text) {
  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  await fallbackCopyText(text);
}

function formatTranscriptFetchError(response) {
  const errorCode = typeof response?.errorCode === 'string' ? response.errorCode.trim() : '';
  const errorMessage = typeof response?.error === 'string' ? response.error.trim() : '';
  if (errorCode === 'not_youtube_tab') return 'Aktywna karta nie jest YouTube.';
  if (errorCode === 'tab_id_missing' || errorCode === 'tab_not_found') return 'Nie znaleziono aktywnej karty.';
  if (errorCode === 'not_video_page') return 'To nie jest strona filmu YouTube (watch/shorts/live).';
  if (errorCode === 'caption_tracks_missing') return 'Ten film nie ma dostepnych napisow.';
  if (errorCode === 'caption_tracks_timeout' || errorCode === 'player_response_missing') return 'Nie udalo sie zaladowac napisow. Sprobuj ponownie za chwile.';
  if (errorCode === 'timedtext_list_fetch_failed') return 'Nie udalo sie pobrac listy napisow z YouTube.';
  if (errorCode === 'transcript_fetch_failed') return 'Nie udalo sie pobrac transkrypcji z YouTube.';
  if (errorCode === 'transcript_too_short') return 'Pobrana transkrypcja jest zbyt krotka.';
  if (errorCode === 'content_script_unreachable') return 'Content script YouTube nie jest gotowy. Odswiez karte i sproboj ponownie.';
  if (errorCode === 'content_script_injection_failed') return 'Nie udalo sie uruchomic modulu YouTube na tej karcie.';
  if (errorCode === 'content_script_injection_blocked') return 'Przegladarka zablokowala dostep do tej strony.';
  if (errorCode === 'invalid_transcript_response') return 'Otrzymano niepoprawna odpowiedz z modulu YouTube.';
  if (errorCode === 'runtime_timeout') return 'Przekroczono czas oczekiwania na transkrypcje.';
  return errorMessage || errorCode || 'transcript_unavailable';
}

async function executeCopyYouTubeTranscriptFromPopup(button) {
  if (!button) return;
  const originalHtml = button.innerHTML;
  button.disabled = true;
  setShortcutButtonLabel(button, 'Pobieram...', POPUP_SHORTCUTS.copyYouTube);
  setYouTubeTranscriptStatus('YouTube transcript: pobieram...', false);

  try {
    const activeTab = await getActiveTabInCurrentWindow();
    if (!activeTab || !Number.isInteger(activeTab.id)) {
      setYouTubeTranscriptStatus('YouTube transcript: brak aktywnej karty.', true);
      return;
    }
    if (!isYouTubeUrl(activeTab.url || '')) {
      setYouTubeTranscriptStatus('YouTube transcript: aktywna karta nie jest YouTube.', true);
      return;
    }

    const response = await sendRuntimeMessage({
      type: 'YT_FETCH_TRANSCRIPT_FOR_TAB',
      tabId: activeTab.id,
      preferredLanguages: ['pl', 'en'],
    });

    if (!response?.success || typeof response?.transcript !== 'string' || !response.transcript.trim()) {
      setYouTubeTranscriptStatus(`YouTube transcript: ${formatTranscriptFetchError(response)}`, true);
      return;
    }

    await copyTextToClipboard(response.transcript);
    const transcriptLength = response.transcript.trim().length;
    const transcriptLang = typeof response.lang === 'string' && response.lang.trim() ? response.lang.trim() : 'unknown';
    const method = typeof response.method === 'string' && response.method.trim() ? response.method.trim() : 'unknown';
    const cacheHint = response.cacheHit ? ', cache' : '';
    const attemptHint = Number.isInteger(response.attemptUsed) && Number.isInteger(response.attempts)
      ? `, proba ${response.attemptUsed}/${response.attempts}`
      : '';
    setYouTubeTranscriptStatus(
      `YouTube transcript: skopiowano (${transcriptLang}, ${transcriptLength} znakow, ${method}${cacheHint}${attemptHint}).`,
      false
    );
  } catch (error) {
    setYouTubeTranscriptStatus(`YouTube transcript: ${error?.message || String(error)}`, true);
  } finally {
    button.disabled = false;
    button.innerHTML = originalHtml;
  }
}

const runBtn = document.getElementById('runBtn');
if (copyYouTubeTranscriptBtn) {
  copyYouTubeTranscriptBtn.addEventListener('click', () => {
    void executeCopyYouTubeTranscriptFromPopup(copyYouTubeTranscriptBtn);
  });
}

if (runBtn) {
  runBtn.addEventListener('click', () => {
    withActiveWindowContext(({ windowId }) => {
      void executeRunAnalysisFromPopup(runBtn, {
        windowId,
        origin: 'popup-run-analysis',
      });
    });
  });
}

const resumeAllBtn = document.getElementById('resumeAllBtn');
if (resumeAllBtn) {
  resumeAllBtn.addEventListener('click', () => {
    void executeResumeAllFromPopup(resumeAllBtn, {
      origin: 'popup-resume-all',
    });
  });
}

if (resumeAllExtendedBtn) {
  resumeAllExtendedBtn.addEventListener('click', () => {
    void executeResumeAllFromPopup(resumeAllExtendedBtn, {
      origin: 'popup-resume-all-extended',
      composerThinkingEffort: 'extended',
    });
  });
}

if (resumeAllHeavyBtn) {
  resumeAllHeavyBtn.addEventListener('click', () => {
    void executeResumeAllFromPopup(resumeAllHeavyBtn, {
      origin: 'popup-resume-all-heavy',
      composerThinkingEffort: 'heavy',
    });
  });
}

if (repeatLastPromptAllBtn) {
  repeatLastPromptAllBtn.addEventListener('click', () => {
    void executeRepeatLastPromptAllFromPopup(repeatLastPromptAllBtn, {
      origin: 'popup-repeat-last-prompt-all',
    });
  });
}

if (countCompanyMessagesBtn) {
  countCompanyMessagesBtn.addEventListener('click', () => {
    void executeCountCompanyMessagesFromPopup(countCompanyMessagesBtn);
  });
}

const stopBtn = document.getElementById('stopBtn');
if (stopBtn) {
  stopBtn.addEventListener('click', () => {
    withActiveWindowContext(({ windowId }) => {
      chrome.runtime.sendMessage(
        {
          type: 'STOP_PROCESS',
          windowId,
          origin: 'popup-stop',
        },
        () => {
          window.close();
        }
      );
    });
  });
}

const manualSourceBtn = document.getElementById('manualSourceBtn');
if (manualSourceBtn) {
  manualSourceBtn.addEventListener('click', () => {
    withActiveWindowContext(({ activeTab }) => {
      const title = activeTab?.title || '';
      const url = activeTab?.url || '';
      const params = new URLSearchParams();
      if (title) params.set('title', title);
      if (url) params.set('url', url);
      const targetUrl = chrome.runtime.getURL(`manual-source.html${params.toString() ? `?${params.toString()}` : ''}`);

      chrome.windows.create({
        url: targetUrl,
        type: 'popup',
        width: 800,
        height: 600,
      });
      window.close();
    });
  });
}

const resumeStageBtn = document.getElementById('resumeStageBtn');
if (resumeStageBtn) {
  resumeStageBtn.addEventListener('click', () => {
    withActiveWindowContext(({ activeTab, windowId }) => {
      void executeSmartResumeStageFromPopup(resumeStageBtn, {
        tabId: Number.isInteger(activeTab?.id) ? activeTab.id : null,
        windowId: Number.isInteger(windowId) ? windowId : null,
        chatUrl: typeof activeTab?.url === 'string' ? activeTab.url : '',
        title: typeof activeTab?.title === 'string' ? activeTab.title : ''
      });
    });
  });
}

const decisionPanelBtn = document.getElementById('decisionPanelBtn');
if (decisionPanelBtn) {
  decisionPanelBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('process-monitor.html') });
    window.close();
  });
}

const problemLogsBtn = document.getElementById('problemLogsBtn');
if (problemLogsBtn) {
  problemLogsBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('problem-log.html') });
    window.close();
  });
}

const responsesBtn = document.getElementById('responsesBtn');
if (responsesBtn) {
  responsesBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('responses.html') });
    window.close();
  });
}

if (restoreProcessWindowsBtn) {
  restoreProcessWindowsBtn.addEventListener('click', async () => {
    const originalHtml = restoreProcessWindowsBtn.innerHTML;
    restoreProcessWindowsBtn.disabled = true;
    setShortcutButtonLabel(restoreProcessWindowsBtn, 'Przywracam...', POPUP_SHORTCUTS.restoreWindows);
    setRestoreProcessWindowsStatus('Przywracam aktywne procesy na ekran...');

    try {
      const response = await sendRuntimeMessage({
        type: 'RESTORE_PROCESS_WINDOWS',
        origin: 'popup-restore-process-windows',
      });

      if (response?.success === false) {
        setRestoreProcessWindowsStatus(
          `Blad przywracania: ${response.error || response.reason || 'unknown'}.`,
          true
        );
        return;
      }

      const requested = Number.isInteger(response?.requested) ? response.requested : 0;
      const restored = Number.isInteger(response?.restored) ? response.restored : 0;
      const opened = Number.isInteger(response?.opened) ? response.opened : 0;
      const failed = Number.isInteger(response?.failed) ? response.failed : 0;
      const skipped = Number.isInteger(response?.skipped) ? response.skipped : 0;

      setRestoreProcessWindowsStatus(
        `Gotowe. Strony: ${requested}, przywrocone: ${restored}, otwarte: ${opened}, pominiete: ${skipped}, bledy: ${failed}.`,
        failed > 0
      );
    } catch (error) {
      setRestoreProcessWindowsStatus(`Blad przywracania: ${error?.message || String(error)}.`, true);
    } finally {
      restoreProcessWindowsBtn.disabled = false;
      restoreProcessWindowsBtn.innerHTML = originalHtml;
    }
  });
}

if (autoRestoreToggleBtn) {
  autoRestoreToggleBtn.addEventListener('click', async () => {
    const currentlyEnabled = autoRestoreToggleBtn.dataset.enabled === 'true';
    const nextEnabled = !currentlyEnabled;
    const originalHtml = autoRestoreToggleBtn.innerHTML;
    autoRestoreToggleBtn.disabled = true;
    setShortcutButtonLabel(
      autoRestoreToggleBtn,
      nextEnabled ? 'Wlaczam auto...' : 'Wylaczam auto...',
      POPUP_SHORTCUTS.autoRestoreToggle
    );
    setAutoRestoreStatus(nextEnabled ? 'Wlaczam automatyzacje...' : 'Wylaczam automatyzacje...');

    try {
      const response = await sendRuntimeMessage({
        type: 'SET_AUTO_RESTORE_WINDOWS_ENABLED',
        enabled: nextEnabled,
        origin: 'popup-auto-restore-toggle',
      });
      if (response?.success === false) {
        setAutoRestoreStatus(`Automatyzacja: ${response.error || response.reason || 'unknown'}.`, true);
      } else {
        applyAutoRestoreUi(response);
        setAutoRestoreStatus(formatAutoRestoreStatus(response), false);
      }
    } catch (error) {
      setAutoRestoreStatus(`Automatyzacja: ${error?.message || String(error)}`, true);
    } finally {
      autoRestoreToggleBtn.disabled = false;
      if (!autoRestoreToggleBtn.dataset.enabled) {
        autoRestoreToggleBtn.innerHTML = originalHtml;
      }
    }
  });
}

function isTextEntryElement(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = (target.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

function clickIfEnabled(button) {
  if (!button || button.disabled) return;
  button.click();
}

const popupShortcutHandlers = {
  [POPUP_SHORTCUTS.manualSource]: () => clickIfEnabled(manualSourceBtn),
  [POPUP_SHORTCUTS.runAnalysis]: () => clickIfEnabled(runBtn),
  [POPUP_SHORTCUTS.resumeStage]: () => clickIfEnabled(resumeStageBtn),
  [POPUP_SHORTCUTS.resumeAll]: () => clickIfEnabled(resumeAllBtn),
  [POPUP_SHORTCUTS.responses]: () => clickIfEnabled(responsesBtn),
  [POPUP_SHORTCUTS.processPanel]: () => clickIfEnabled(decisionPanelBtn),
  [POPUP_SHORTCUTS.stop]: () => clickIfEnabled(stopBtn),
  [POPUP_SHORTCUTS.copyYouTube]: () => clickIfEnabled(copyYouTubeTranscriptBtn),
  [POPUP_SHORTCUTS.restoreWindows]: () => clickIfEnabled(restoreProcessWindowsBtn),
  [POPUP_SHORTCUTS.autoRestoreToggle]: () => clickIfEnabled(autoRestoreToggleBtn),
};

function resolvePopupShortcutKey(event) {
  if (!event) return '';
  const key = typeof event.key === 'string' ? event.key.trim() : '';
  if (/^[0-9]$/.test(key)) return key;

  const code = typeof event.code === 'string' ? event.code.trim() : '';
  const digitMatch = code.match(/^Digit([0-9])$/);
  if (digitMatch) return digitMatch[1];
  const numpadMatch = code.match(/^Numpad([0-9])$/);
  if (numpadMatch) return numpadMatch[1];

  return '';
}

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.repeat) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (isTextEntryElement(event.target)) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    window.close();
    return;
  }

  const shortcutKey = resolvePopupShortcutKey(event);
  if (!shortcutKey) return;
  const handler = popupShortcutHandlers[shortcutKey];
  if (!handler) return;

  event.preventDefault();
  handler();
});

function setDispatchButtonsDisabled(disabled) {
  if (saveWatchlistTokenBtn) saveWatchlistTokenBtn.disabled = disabled;
  if (clearWatchlistTokenBtn) clearWatchlistTokenBtn.disabled = disabled;
  if (flushWatchlistDispatchBtn) flushWatchlistDispatchBtn.disabled = disabled;
}

if (saveWatchlistTokenBtn) {
  saveWatchlistTokenBtn.addEventListener('click', async () => {
    const intakeUrl = typeof watchlistIntakeUrlInput?.value === 'string' ? watchlistIntakeUrlInput.value.trim() : '';
    const keyId = typeof watchlistKeyIdInput?.value === 'string' ? watchlistKeyIdInput.value.trim() : '';
    const secret = typeof watchlistSecretInput?.value === 'string' ? watchlistSecretInput.value.trim() : '';
    if (!intakeUrl || !keyId || !secret) {
      setDispatchStatus('Intake status: podaj Intake URL, Key ID i Secret przed zapisem.', true);
      return;
    }

    setDispatchButtonsDisabled(true);
    const originalText = saveWatchlistTokenBtn.textContent;
    saveWatchlistTokenBtn.textContent = 'Zapis...';

    try {
      const response = await sendRuntimeMessage({
        type: 'SET_WATCHLIST_DISPATCH_TOKEN',
        credentials: {
          intakeUrl,
          keyId,
          secret,
        },
      });
      if (response?.success === false) {
        setDispatchStatus(`Intake status: blad zapisu (${response.reason || response.error || 'unknown'}).`, true);
        return;
      }

      if (watchlistSecretInput) {
        watchlistSecretInput.value = '';
      }

      const statusPayload = response?.status && typeof response.status === 'object'
        ? { success: true, ...response.status }
        : response;
      setDispatchStatus(formatDispatchStatus(statusPayload), false);
    } catch (error) {
      setDispatchStatus(`Intake status: ${error?.message || String(error)}`, true);
    } finally {
      saveWatchlistTokenBtn.textContent = originalText;
      setDispatchButtonsDisabled(false);
    }
  });
}

if (clearWatchlistTokenBtn) {
  clearWatchlistTokenBtn.addEventListener('click', async () => {
    setDispatchButtonsDisabled(true);
    const originalText = clearWatchlistTokenBtn.textContent;
    clearWatchlistTokenBtn.textContent = 'Czyszcze...';

    try {
      const response = await sendRuntimeMessage({ type: 'CLEAR_WATCHLIST_DISPATCH_TOKEN' });
      if (response?.success === false) {
        setDispatchStatus(`Intake status: blad czyszczenia (${response.error || 'unknown'}).`, true);
        return;
      }

      if (watchlistIntakeUrlInput) watchlistIntakeUrlInput.value = '';
      if (watchlistKeyIdInput) watchlistKeyIdInput.value = '';
      if (watchlistSecretInput) watchlistSecretInput.value = '';

      const statusPayload = response?.status && typeof response.status === 'object'
        ? { success: true, ...response.status }
        : response;
      setDispatchStatus(formatDispatchStatus(statusPayload), false);
    } catch (error) {
      setDispatchStatus(`Intake status: ${error?.message || String(error)}`, true);
    } finally {
      clearWatchlistTokenBtn.textContent = originalText;
      setDispatchButtonsDisabled(false);
    }
  });
}

if (flushWatchlistDispatchBtn) {
  flushWatchlistDispatchBtn.addEventListener('click', async () => {
    setDispatchButtonsDisabled(true);
    const originalText = flushWatchlistDispatchBtn.textContent;
    flushWatchlistDispatchBtn.textContent = 'Flush...';

    try {
      const response = await sendRuntimeMessage({
        type: 'FLUSH_WATCHLIST_DISPATCH',
        reason: 'popup_manual_flush',
        forceReload: true,
      });
      if (response?.success === false) {
        setDispatchStatus(`Intake status: blad flush (${response.error || 'unknown'}).`, true);
        return;
      }

      const statusPayload = response?.status && typeof response.status === 'object'
        ? { success: true, ...response.status }
        : response;
      const flushSummary = formatDispatchFlushResult(response?.flushResult);
      const baseStatus = formatDispatchStatus(statusPayload);
      setDispatchStatus(`${baseStatus} Flush: ${flushSummary}.`, false);
    } catch (error) {
      setDispatchStatus(`Intake status: ${error?.message || String(error)}`, true);
    } finally {
      flushWatchlistDispatchBtn.textContent = originalText;
      setDispatchButtonsDisabled(false);
    }
  });
}

if (chrome?.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'AUTO_RESTORE_STATUS_UPDATED') return;
    void refreshAutoRestoreStatus(false);
  });
}

void Promise.all([
  refreshDispatchStatus(true),
  refreshAutoRestoreStatus(true),
]);

setInterval(() => {
  void refreshAutoRestoreStatus(false);
}, 15000);
