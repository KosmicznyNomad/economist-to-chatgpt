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

const runStatus = document.getElementById('runStatus');
const watchlistDispatchStatus = document.getElementById('watchlistDispatchStatus');
const watchlistIntakeUrlInput = document.getElementById('watchlistIntakeUrlInput');
const watchlistKeyIdInput = document.getElementById('watchlistKeyIdInput');
const watchlistSecretInput = document.getElementById('watchlistSecretInput');
const saveWatchlistTokenBtn = document.getElementById('saveWatchlistTokenBtn');
const clearWatchlistTokenBtn = document.getElementById('clearWatchlistTokenBtn');
const flushWatchlistDispatchBtn = document.getElementById('flushWatchlistDispatchBtn');
const restoreProcessWindowsBtn = document.getElementById('restoreProcessWindowsBtn');
const restoreProcessWindowsStatus = document.getElementById('restoreProcessWindowsStatus');
const autoRestoreToggleBtn = document.getElementById('autoRestoreToggleBtn');
const autoRestoreStatus = document.getElementById('autoRestoreStatus');

function setRunStatus(text, isError = false) {
  if (!runStatus) return;
  runStatus.textContent = text;
  runStatus.style.color = isError ? '#b91c1c' : '#374151';
  runStatus.style.borderColor = isError ? '#fecaca' : '#d1d5db';
  runStatus.style.background = isError ? '#fef2f2' : '#f3f4f6';
}

function setDispatchStatus(text, isError = false) {
  if (!watchlistDispatchStatus) return;
  watchlistDispatchStatus.textContent = text;
  watchlistDispatchStatus.style.color = isError ? '#b91c1c' : '#374151';
  watchlistDispatchStatus.style.borderColor = isError ? '#fecaca' : '#d1d5db';
  watchlistDispatchStatus.style.background = isError ? '#fef2f2' : '#f3f4f6';
}

function setRestoreProcessWindowsStatus(text, isError = false) {
  if (!restoreProcessWindowsStatus) return;
  restoreProcessWindowsStatus.textContent = text;
  restoreProcessWindowsStatus.style.color = isError ? '#b91c1c' : '#374151';
  restoreProcessWindowsStatus.style.borderColor = isError ? '#fecaca' : '#d1d5db';
  restoreProcessWindowsStatus.style.background = isError ? '#fef2f2' : '#f3f4f6';
}

function setAutoRestoreStatus(text, isError = false) {
  if (!autoRestoreStatus) return;
  autoRestoreStatus.textContent = text;
  autoRestoreStatus.style.color = isError ? '#b91c1c' : '#374151';
  autoRestoreStatus.style.borderColor = isError ? '#fecaca' : '#d1d5db';
  autoRestoreStatus.style.background = isError ? '#fef2f2' : '#f3f4f6';
}

function applyAutoRestoreUi(status) {
  const enabled = !!status?.enabled;
  if (autoRestoreToggleBtn) {
    autoRestoreToggleBtn.textContent = enabled ? 'Auto co 15 min: ON' : 'Auto co 15 min: OFF';
    autoRestoreToggleBtn.dataset.enabled = enabled ? 'true' : 'false';
  }
}

function formatAutoRestoreStatus(status) {
  if (!status || status.success === false) {
    return 'Automatyzacja: blad odczytu.';
  }
  const enabled = !!status.enabled;
  const nextRunAt = Number.isInteger(status.nextRunAt) ? new Date(status.nextRunAt).toLocaleString() : 'brak';
  const alarmActive = !!status.alarmActive;
  if (!enabled) {
    return 'Automatyzacja: wylaczona.';
  }
  return `Automatyzacja: WLACZONA (co 15 min). Alarm: ${alarmActive ? 'aktywny' : 'brak'}. Nastepne uruchomienie: ${nextRunAt}.`;
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
  const base = `Kolejka: ${queueSize}. Ostatni flush: ${flushText}.${retryText}${errorText}`;

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
      setRunStatus(`Blad: ${response.error || 'Nie udalo sie uruchomic analiz.'}`, true);
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
  const scannedTabs = Number.isInteger(response?.scannedTabs) ? response.scannedTabs : 0;
  const startedTabs = Number.isInteger(response?.startedTabs)
    ? response.startedTabs
    : Number.isInteger(response?.resumedTabs)
      ? response.resumedTabs
      : 0;
  const rows = Array.isArray(response?.results) ? response.results : [];
  const unresolvedCount = rows.filter((row) => {
    const action = row?.action || '';
    return action !== 'started' && action !== 'resumed' && action !== 'final_stage_already_sent';
  }).length;

  return `Skan: ${scannedTabs}, uruchomione: ${startedTabs}, niewystartowane: ${unresolvedCount}`;
}

async function executeResumeAllFromPopup(button, options = {}) {
  if (!button) return;

  const originalHtml = button.innerHTML;
  button.disabled = true;
  button.textContent = 'Wznawiam...';
  setRunStatus('Wznawiam wszystkie procesy...');

  try {
    const response = await sendRuntimeMessage({
      type: 'DETECT_LAST_COMPANY_PROMPT_AND_RESUME',
      origin: typeof options?.origin === 'string' ? options.origin : 'popup-resume-all',
    });

    if (!response || Object.keys(response).length === 0) {
      setRunStatus('Polecenie wznowienia zostalo wyslane.');
      return;
    }

    if (response.success === false) {
      setRunStatus(`Blad: ${response.error || 'Nie udalo sie wznowic procesow.'}`, true);
      return;
    }

    setRunStatus(getResumeAllSummary(response));
  } catch (error) {
    setRunStatus(`Blad: ${error?.message || String(error)}`, true);
  } finally {
    button.disabled = false;
    button.innerHTML = originalHtml;
  }
}

const runBtn = document.getElementById('runBtn');
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
    chrome.runtime.sendMessage({ type: 'RESUME_STAGE_OPEN' });
    window.close();
  });
}

const decisionPanelBtn = document.getElementById('decisionPanelBtn');
if (decisionPanelBtn) {
  decisionPanelBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('process-monitor.html') });
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
    const originalText = restoreProcessWindowsBtn.textContent;
    restoreProcessWindowsBtn.disabled = true;
    restoreProcessWindowsBtn.textContent = 'Przywracam...';
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
      restoreProcessWindowsBtn.textContent = originalText;
    }
  });
}

if (autoRestoreToggleBtn) {
  autoRestoreToggleBtn.addEventListener('click', async () => {
    const currentlyEnabled = autoRestoreToggleBtn.dataset.enabled === 'true';
    const nextEnabled = !currentlyEnabled;
    const originalText = autoRestoreToggleBtn.textContent;
    autoRestoreToggleBtn.disabled = true;
    autoRestoreToggleBtn.textContent = nextEnabled ? 'Wlaczam auto...' : 'Wylaczam auto...';
    setAutoRestoreStatus(nextEnabled ? 'Wlaczam automatyzacje co 15 min...' : 'Wylaczam automatyzacje...');

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
        autoRestoreToggleBtn.textContent = originalText;
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
  '1': () => clickIfEnabled(manualSourceBtn),
  '2': () => clickIfEnabled(runBtn),
  '3': () => clickIfEnabled(resumeStageBtn),
  '4': () => clickIfEnabled(resumeAllBtn),
  '5': () => clickIfEnabled(responsesBtn),
  '6': () => clickIfEnabled(decisionPanelBtn),
  '7': () => clickIfEnabled(stopBtn),
};

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.repeat) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (isTextEntryElement(event.target)) return;

  const handler = popupShortcutHandlers[event.key];
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

void Promise.all([
  refreshDispatchStatus(true),
  refreshAutoRestoreStatus(true),
]);
