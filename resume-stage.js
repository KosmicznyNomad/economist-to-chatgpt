const stageSelect = document.getElementById('stageSelect');
const stageInfo = document.getElementById('stageInfo');
const startBtn = document.getElementById('startBtn');
const cancelBtn = document.getElementById('cancelBtn');

let prompts = [];

// Funkcja skracania tekstu do preview
function truncateText(text, maxLength = 60) {
  if (!text) return '';
  text = text.trim().replace(/\s+/g, ' ');
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

// Załaduj prompty
async function loadPrompts() {
  try {
    // Pobierz prompty z background script
    const response = await chrome.runtime.sendMessage({ type: 'GET_COMPANY_PROMPTS' });
    
    if (response && response.prompts && response.prompts.length > 0) {
      prompts = response.prompts;
      populateDropdown();
    } else {
      throw new Error('Brak promptów');
    }
  } catch (error) {
    console.error('Błąd ładowania promptów:', error);
    stageInfo.textContent = '❌ Błąd ładowania promptów';
    stageInfo.style.color = '#d93025';
  }
}

// Wypełnij dropdown
function populateDropdown() {
  stageSelect.innerHTML = '';
  
  // Dodaj opcję placeholder
  const placeholderOption = document.createElement('option');
  placeholderOption.value = '';
  placeholderOption.textContent = 'Wybierz etap...';
  placeholderOption.disabled = true;
  placeholderOption.selected = true;
  stageSelect.appendChild(placeholderOption);
  
  // Dodaj opcje dla każdego promptu (zaczynając od 2, bo 1 to artykuł)
  // Prompt 1 zawiera {{articlecontent}} więc pomijamy go
  for (let i = 1; i < prompts.length; i++) {
    const option = document.createElement('option');
    option.value = i;
    
    const promptPreview = truncateText(prompts[i]);
    option.textContent = `${i + 1}: ${promptPreview}`;
    
    stageSelect.appendChild(option);
  }
  
  updateInfo();
}

// Aktualizuj info
function updateInfo() {
  if (prompts.length === 0) {
    stageInfo.textContent = 'Brak dostępnych promptów';
    return;
  }
  
  const selectedIndex = parseInt(stageSelect.value);
  
  if (isNaN(selectedIndex)) {
    stageInfo.textContent = `Dostępne etapy: 2-${prompts.length} (${prompts.length - 1} promptów)`;
    startBtn.disabled = true;
  } else {
    const remaining = prompts.length - selectedIndex;
    stageInfo.textContent = `Zostanie wykonanych ${remaining} prompt${remaining === 1 ? '' : remaining < 5 ? 'y' : 'ów'} (${selectedIndex + 1}-${prompts.length})`;
    startBtn.disabled = false;
  }
}

// Obsługa zmiany wyboru
stageSelect.addEventListener('change', updateInfo);

// Obsługa przycisku Start
startBtn.addEventListener('click', () => {
  const selectedIndex = parseInt(stageSelect.value);
  
  if (!isNaN(selectedIndex)) {
    chrome.runtime.sendMessage({
      type: 'RESUME_STAGE_START',
      startIndex: selectedIndex
    });
    window.close();
  }
});

// Obsługa przycisku Cancel
cancelBtn.addEventListener('click', () => {
  window.close();
});

// Inicjalizacja
loadPrompts();
