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
      chrome.runtime.sendMessage({ 
        type: 'PROCESS_NEEDS_ACTION',
        currentPrompt: extractCurrentPrompt(counter)
      }).catch(() => {});
      
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

function extractCurrentPrompt(counter) {
  const match = counter.textContent.match(/Prompt (\d+)/);
  return match ? parseInt(match[1]) : 0;
}


