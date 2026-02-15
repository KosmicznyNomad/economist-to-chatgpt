function withActiveWindowContext(callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs && tabs.length > 0 ? tabs[0] : null;
    callback({
      activeTab,
      windowId: Number.isInteger(activeTab?.windowId) ? activeTab.windowId : null
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

const resetScanStatus = document.getElementById('resetScanStatus');
const watchlistDispatchStatus = document.getElementById('watchlistDispatchStatus');
const watchlistTokenInput = document.getElementById('watchlistTokenInput');
const saveWatchlistTokenBtn = document.getElementById('saveWatchlistTokenBtn');
const clearWatchlistTokenBtn = document.getElementById('clearWatchlistTokenBtn');

function setRunStatus(text, isError = false) {
  if (!resetScanStatus) return;
  resetScanStatus.textContent = text;
  resetScanStatus.style.color = isError ? '#b91c1c' : '#374151';
  resetScanStatus.style.borderColor = isError ? '#fecaca' : '#e5e7eb';
  resetScanStatus.style.background = isError ? '#fef2f2' : '#f3f4f6';
}

function setDispatchStatus(text, isError = false) {
  if (!watchlistDispatchStatus) return;
  watchlistDispatchStatus.textContent = text;
  watchlistDispatchStatus.style.color = isError ? '#b91c1c' : '#374151';
  watchlistDispatchStatus.style.borderColor = isError ? '#fecaca' : '#e5e7eb';
  watchlistDispatchStatus.style.background = isError ? '#fef2f2' : '#f3f4f6';
}

function tokenSourceLabel(source) {
  if (source === 'inline_config') return 'inline config';
  if (source === 'storage_local') return 'local storage';
  return 'missing';
}

function formatDispatchStatus(status) {
  if (!status || status.success === false) {
    return 'Dispatch status: blad odczytu.';
  }
  if (!status.enabled) {
    return 'Dispatch status: wylaczony.';
  }
  if (status.configured) {
    return `Dispatch status: skonfigurowany (${tokenSourceLabel(status.tokenSource)}).`;
  }
  if (status.reason === 'missing_repository') {
    return 'Dispatch status: brak repozytorium.';
  }
  if (status.reason === 'missing_dispatch_credentials') {
    return 'Dispatch status: brak tokena GitHub.';
  }
  return `Dispatch status: ${status.reason || 'nieznany'}.`;
}

async function refreshDispatchStatus(forceReload = false) {
  if (!watchlistDispatchStatus) return;
  try {
    const response = await sendRuntimeMessage({
      type: 'GET_WATCHLIST_DISPATCH_STATUS',
      forceReload
    });
    setDispatchStatus(formatDispatchStatus(response), response?.success === false);
  } catch (error) {
    setDispatchStatus(`Dispatch status: ${error?.message || String(error)}`, true);
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
      origin: typeof options?.origin === 'string' ? options.origin : 'popup-run-analysis'
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
    : (Number.isInteger(response?.resumedTabs) ? response.resumedTabs : 0);
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
      origin: typeof options?.origin === 'string' ? options.origin : 'popup-resume-all'
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

// Main action: run analysis flow from popup
const runBtn = document.getElementById('runBtn');
if (runBtn) {
  runBtn.addEventListener('click', () => {
    withActiveWindowContext(({ windowId }) => {
      void executeRunAnalysisFromPopup(runBtn, {
        windowId,
        origin: 'popup-run-analysis'
      });
    });
  });
}

// Resume all processes by scanning existing chat tabs
const resumeAllBtn = document.getElementById('resumeAllBtn');
if (resumeAllBtn) {
  resumeAllBtn.addEventListener('click', () => {
    void executeResumeAllFromPopup(resumeAllBtn, {
      origin: 'popup-resume-all'
    });
  });
}

// Stop active processes in current window
const stopBtn = document.getElementById('stopBtn');
if (stopBtn) {
  stopBtn.addEventListener('click', () => {
    withActiveWindowContext(({ windowId }) => {
      chrome.runtime.sendMessage({
        type: 'STOP_PROCESS',
        windowId,
        origin: 'popup-stop'
      }, () => {
        window.close();
      });
    });
  });
}

// Open manual source popup
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
        height: 600
      });
      window.close();
    });
  });
}

// Open resume stage dialog
const resumeStageBtn = document.getElementById('resumeStageBtn');
if (resumeStageBtn) {
  resumeStageBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'RESUME_STAGE_OPEN' });
    window.close();
  });
}

// Open decision panel
const decisionPanelBtn = document.getElementById('decisionPanelBtn');
if (decisionPanelBtn) {
  decisionPanelBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('process-monitor.html') });
    window.close();
  });
}

// Open responses page
const responsesBtn = document.getElementById('responsesBtn');
if (responsesBtn) {
  responsesBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('responses.html') });
    window.close();
  });
}

function setDispatchButtonsDisabled(disabled) {
  if (saveWatchlistTokenBtn) saveWatchlistTokenBtn.disabled = disabled;
  if (clearWatchlistTokenBtn) clearWatchlistTokenBtn.disabled = disabled;
}

if (saveWatchlistTokenBtn) {
  saveWatchlistTokenBtn.addEventListener('click', async () => {
    const rawToken = typeof watchlistTokenInput?.value === 'string' ? watchlistTokenInput.value.trim() : '';
    if (!rawToken) {
      setDispatchStatus('Dispatch status: podaj token przed zapisem.', true);
      return;
    }

    setDispatchButtonsDisabled(true);
    const originalText = saveWatchlistTokenBtn.textContent;
    saveWatchlistTokenBtn.textContent = 'Zapis...';

    try {
      const response = await sendRuntimeMessage({
        type: 'SET_WATCHLIST_DISPATCH_TOKEN',
        token: rawToken
      });
      if (response?.success === false) {
        setDispatchStatus(`Dispatch status: blad zapisu (${response.reason || response.error || 'unknown'}).`, true);
        return;
      }

      if (watchlistTokenInput) {
        watchlistTokenInput.value = '';
      }

      const statusPayload = response?.status && typeof response.status === 'object'
        ? { success: true, ...response.status }
        : response;
      setDispatchStatus(formatDispatchStatus(statusPayload), false);
    } catch (error) {
      setDispatchStatus(`Dispatch status: ${error?.message || String(error)}`, true);
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
      const response = await sendRuntimeMessage({
        type: 'CLEAR_WATCHLIST_DISPATCH_TOKEN'
      });
      if (response?.success === false) {
        setDispatchStatus(`Dispatch status: blad czyszczenia (${response.error || 'unknown'}).`, true);
        return;
      }

      const statusPayload = response?.status && typeof response.status === 'object'
        ? { success: true, ...response.status }
        : response;
      setDispatchStatus(formatDispatchStatus(statusPayload), false);
    } catch (error) {
      setDispatchStatus(`Dispatch status: ${error?.message || String(error)}`, true);
    } finally {
      clearWatchlistTokenBtn.textContent = originalText;
      setDispatchButtonsDisabled(false);
    }
  });
}

void refreshDispatchStatus(true);
