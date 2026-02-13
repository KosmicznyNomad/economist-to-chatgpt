function withActiveWindowContext(callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs && tabs.length > 0 ? tabs[0] : null;
    callback({
      activeTab,
      windowId: Number.isInteger(activeTab?.windowId) ? activeTab.windowId : null
    });
  });
}

function sendResetScanStartRequest(options = {}) {
  const payload = {
    type: 'DETECT_LAST_COMPANY_PROMPT_AND_RESUME',
    origin: typeof options?.origin === 'string' ? options.origin : 'popup'
  };

  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      payload,
      (response) => {
        if (chrome.runtime.lastError) {
          resolve({
            success: false,
            scannedTabs: 0,
            matchedTabs: 0,
            startedTabs: 0,
            resumedTabs: 0,
            passCount: 0,
            maxPasses: 0,
            maxRuntimeMs: 0,
            pendingAfterLoop: 0,
            resetSummary: null,
            results: [],
            error: chrome.runtime.lastError.message || 'runtime_error'
          });
          return;
        }

        resolve({
          success: !!response?.success,
          scannedTabs: Number.isInteger(response?.scannedTabs) ? response.scannedTabs : 0,
          matchedTabs: Number.isInteger(response?.matchedTabs) ? response.matchedTabs : 0,
          resumedTabs: Number.isInteger(response?.resumedTabs) ? response.resumedTabs : 0,
          startedTabs: Number.isInteger(response?.startedTabs)
            ? response.startedTabs
            : (Number.isInteger(response?.resumedTabs) ? response.resumedTabs : 0),
          passCount: Number.isInteger(response?.passCount) ? response.passCount : 0,
          maxPasses: Number.isInteger(response?.maxPasses) ? response.maxPasses : 0,
          maxRuntimeMs: Number.isInteger(response?.maxRuntimeMs) ? response.maxRuntimeMs : 0,
          pendingAfterLoop: Number.isInteger(response?.pendingAfterLoop) ? response.pendingAfterLoop : 0,
          resetSummary: response?.resetSummary && typeof response.resetSummary === 'object'
            ? response.resetSummary
            : null,
          results: Array.isArray(response?.results) ? response.results : [],
          error: typeof response?.error === 'string' ? response.error : ''
        });
      }
    );
  });
}

const resetScanStatus = document.getElementById('resetScanStatus');

function formatResetSummary(summary) {
  if (!summary || typeof summary !== 'object') return '';

  const parts = [];
  if (Number.isInteger(summary.activeBefore)) {
    parts.push(`aktywne: ${summary.activeBefore}`);
  }
  if (Number.isInteger(summary.resetCount)) {
    parts.push(`oznaczone stop: ${summary.resetCount}`);
  }
  if (Number.isInteger(summary.tabReloads) || Number.isInteger(summary.tabReloadFailures)) {
    const ok = Number.isInteger(summary.tabReloads) ? summary.tabReloads : 0;
    const fail = Number.isInteger(summary.tabReloadFailures) ? summary.tabReloadFailures : 0;
    parts.push(`reload kart: ${ok}/${ok + fail}`);
  }
  if (Number.isInteger(summary.uniqueWindowsReloaded)) {
    parts.push(`okna reload: ${summary.uniqueWindowsReloaded}`);
  }
  if (Number.isInteger(summary.windowReloadFailures) && summary.windowReloadFailures > 0) {
    parts.push(`bledy okien: ${summary.windowReloadFailures}`);
  }

  if (parts.length === 0) return '';
  return `Reset -> ${parts.join(', ')}`;
}

function renderResetScanStatus(state = {}) {
  if (!resetScanStatus) return;

  if (state.loading) {
    resetScanStatus.textContent = 'Resetuje, skanuje i uruchamiam...';
    return;
  }

  if (state.error) {
    resetScanStatus.textContent = `Blad: ${state.error}`;
    return;
  }

  const response = state.response;
  if (!response) {
    return;
  }

  const rows = Array.isArray(response.results) ? response.results : [];
  const unresolvedCount = rows.filter((row) => {
    const action = row?.action || '';
    return action !== 'started' && action !== 'resumed' && action !== 'final_stage_already_sent';
  }).length;

  if (!response.success && response.error) {
    resetScanStatus.textContent = `Blad: ${response.error}`;
    return;
  }

  const startedTabs = Number.isInteger(response?.startedTabs)
    ? response.startedTabs
    : (Number.isInteger(response?.resumedTabs) ? response.resumedTabs : 0);
  const scanText = `Skan: ${response.scannedTabs}, uruchomione: ${startedTabs}, niewystartowane: ${unresolvedCount}`;
  const resetText = formatResetSummary(response.resetSummary);
  resetScanStatus.textContent = resetText
    ? `${scanText}\n${resetText}`
    : scanText;
}

async function executeResetScanFromPopup(button, options = {}) {
  if (!button) return;
  const originalHtml = button.innerHTML;
  const loadingText = typeof options.loadingText === 'string' && options.loadingText.trim()
    ? options.loadingText.trim()
    : 'Resetuje...';

  button.disabled = true;
  button.textContent = loadingText;
  renderResetScanStatus({ loading: true });

  try {
    const response = await sendResetScanStartRequest(options);
    renderResetScanStatus({ response });
  } catch (error) {
    renderResetScanStatus({ error: error?.message || String(error) });
  } finally {
    button.disabled = false;
    button.innerHTML = originalHtml;
  }
}

// Main action: hard reset + run through all tabs
const runBtn = document.getElementById('runBtn');
if (runBtn) {
  runBtn.addEventListener('click', async () => {
    await executeResetScanFromPopup(runBtn, {
      origin: 'popup-run-hard-reset',
      loadingText: 'Resetuje...'
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
