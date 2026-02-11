// chatgpt-monitor.js - Monitoring script dla okien ChatGPT
// Obserwuje lokalny licznik i przycisk "Kontynuuj", wysyła statusy do background.js

console.log('📡 ChatGPT Monitor uruchomiony');

// Obserwuj obecność licznika i przycisków
setInterval(() => {
  const counter = document.getElementById('economist-prompt-counter');
  if (counter) {
    const waitBtn = document.getElementById('continue-wait-btn');
    const skipBtn = document.getElementById('continue-skip-btn');
    
    if (waitBtn || skipBtn) {
      // Proces wymaga akcji
      const promptProgress = extractPromptProgress(counter);
      const needsActionPayload = {
        type: 'PROCESS_NEEDS_ACTION',
        source: 'dom-monitor'
      };
      if (promptProgress) {
        Object.assign(needsActionPayload, promptProgress);
      }
      chrome.runtime.sendMessage(needsActionPayload).catch(() => {});
      
      // Nasłuchuj na kliknięcie
      if (waitBtn && !waitBtn.dataset.monitored) {
        waitBtn.dataset.monitored = 'true';
        waitBtn.addEventListener('click', () => {
          chrome.runtime.sendMessage({ type: 'PROCESS_ACTION_RESOLVED' }).catch(() => {});
        });
      }
      if (skipBtn && !skipBtn.dataset.monitored) {
        skipBtn.dataset.monitored = 'true';
        skipBtn.addEventListener('click', () => {
          chrome.runtime.sendMessage({ type: 'PROCESS_ACTION_RESOLVED' }).catch(() => {});
        });
      }
    }
  }
}, 2000);

function extractPromptProgress(counter) {
  const text = (counter?.textContent || '').replace(/\s+/g, ' ').trim();
  const match = text.match(/Prompt\s+(\d+)(?:\s*\/\s*(\d+))?/i);
  if (!match) return null;

  const currentPrompt = Number.parseInt(match[1], 10);
  const totalPrompts = match[2] ? Number.parseInt(match[2], 10) : null;
  if (!Number.isInteger(currentPrompt) || currentPrompt <= 0) return null;

  const progress = {
    currentPrompt,
    stageIndex: currentPrompt - 1,
    stageName: `Prompt ${currentPrompt}`
  };

  if (Number.isInteger(totalPrompts) && totalPrompts > 0) {
    progress.totalPrompts = totalPrompts;
  }

  return progress;
}


