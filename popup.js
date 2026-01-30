// Obsługa przycisku uruchomienia analizy
document.getElementById('runBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'RUN_ANALYSIS' });
  window.close();
});

// Obsługa przycisku wklej źródło
document.getElementById('manualSourceBtn').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = tabs && tabs.length > 0 ? tabs[0] : null;
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

// Obsługa przycisku Resume from Stage
document.getElementById('resumeStageBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'RESUME_STAGE_OPEN' });
  window.close();
});

// Obsługa przycisku panelu decyzyjnego
document.getElementById('decisionPanelBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('process-monitor.html') });
  window.close();
});

// Obsługa przycisku zobacz odpowiedzi
document.getElementById('responsesBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('responses.html') });
  window.close();
});

