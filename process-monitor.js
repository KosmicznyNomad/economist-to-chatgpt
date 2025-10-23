// process-monitor.js - UI dla centralnego okna monitoringu
const processList = document.getElementById('process-list');
const emptyState = document.getElementById('empty-state');

console.log('🔍 Monitor procesów uruchomiony');

// Pobierz procesy przy starcie
refreshProcesses();

// Nasłuchuj na aktualizacje
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'PROCESSES_UPDATE') {
    updateUI(message.processes);
  }
});

// Odświeżaj co 3s jako backup
setInterval(refreshProcesses, 3000);

function refreshProcesses() {
  chrome.runtime.sendMessage({ type: 'GET_PROCESSES' }, (response) => {
    if (response && response.processes) {
      updateUI(response.processes);
    }
  });
}

function updateUI(processes) {
  if (!processes || processes.length === 0) {
    processList.innerHTML = '';
    emptyState.style.display = 'block';
    return;
  }
  
  emptyState.style.display = 'none';
  
  // Sortuj: needs-action najpierw
  processes.sort((a, b) => {
    if (a.needsAction && !b.needsAction) return -1;
    if (!a.needsAction && b.needsAction) return 1;
    return b.timestamp - a.timestamp;
  });
  
  // Aktualizuj karty
  const existingIds = new Set();
  
  processes.forEach(process => {
    existingIds.add(process.id);
    let card = document.getElementById(`process-${process.id}`);
    
    if (!card) {
      card = document.createElement('div');
      card.id = `process-${process.id}`;
      card.className = 'process-card';
      processList.appendChild(card);
      
      // Focus okna przy kliknięciu
      card.addEventListener('click', () => {
        if (process.windowId) {
          chrome.windows.update(process.windowId, { focused: true });
        }
      });
    }
    
    // Aktualizuj klasy
    card.className = 'process-card' + (process.needsAction ? ' needs-action' : '');
    
    const progress = process.totalPrompts > 0 
      ? Math.round((process.currentPrompt / process.totalPrompts) * 100)
      : 0;
    
    let statusBadge = '';
    if (process.needsAction) {
      statusBadge = '<span class="status-badge status-needs-action">⚠️ WYMAGA AKCJI</span>';
    } else if (process.status === 'completed') {
      statusBadge = '<span class="status-badge status-completed">✅ Zakończono</span>';
    } else {
      statusBadge = '<span class="status-badge status-running">▶️ W trakcie</span>';
    }
    
    card.innerHTML = `
      <div class="process-header">
        <div class="process-title">${escapeHtml(process.title)}</div>
        <div class="process-type">${process.analysisType}</div>
      </div>
      <div class="process-status">
        Prompt ${process.currentPrompt} / ${process.totalPrompts}
        ${statusBadge}
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${progress}%"></div>
      </div>
      <div class="hint">
        ${process.needsAction ? '⬆️ Kliknij aby przejść do okna i wybrać akcję' : '👁️ Kliknij aby zobaczyć okno'}
      </div>
    `;
  });
  
  // Usuń nieistniejące karty
  Array.from(processList.children).forEach(card => {
    const id = card.id.replace('process-', '');
    if (!existingIds.has(id)) {
      card.remove();
    }
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}


