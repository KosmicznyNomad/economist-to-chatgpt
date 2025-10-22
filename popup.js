// Obsługa przycisku uruchomienia analizy
document.getElementById('runBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'RUN_ANALYSIS' });
  window.close();
});

// Obsługa przycisku wklej źródło
document.getElementById('manualSourceBtn').addEventListener('click', () => {
  chrome.windows.create({
    url: chrome.runtime.getURL('manual-source.html'),
    type: 'popup',
    width: 800,
    height: 600
  });
  window.close();
});

// Obsługa przycisku zobacz odpowiedzi
document.getElementById('responsesBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('responses.html') });
  window.close();
});

