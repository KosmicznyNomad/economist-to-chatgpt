const promptSelect = document.getElementById('promptSelect');
const promptInfo = document.getElementById('promptInfo');
const startBtn = document.getElementById('startBtn');
const cancelBtn = document.getElementById('cancelBtn');

let prompts = [];
let promptNames = [];
const urlParams = new URLSearchParams(window.location.search);
const presetStartIndex = Number.parseInt(urlParams.get('startIndex'), 10);
const resumeTitle = urlParams.get('title') || '';
const resumeAnalysisType = urlParams.get('analysisType') || '';

// Funkcja skracania tekstu do preview
function truncateText(text, maxLength = 60) {
  if (!text) return '';
  text = text.trim().replace(/\s+/g, ' ');
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

// Załaduj prompty i nazwy etapów
async function loadPrompts() {
  try {
    // Pobierz prompty z background script
    const response = await chrome.runtime.sendMessage({ type: 'GET_COMPANY_PROMPTS' });
    
    if (response && response.prompts && response.prompts.length > 0) {
      prompts = response.prompts;
      
      // Pobierz nazwy promptów
      const namesResponse = await chrome.runtime.sendMessage({ type: 'GET_STAGE_NAMES' });
      if (namesResponse && namesResponse.stageNames) {
        promptNames = namesResponse.stageNames;
      }
      
      populateDropdown();
    } else {
      throw new Error('Brak promptów');
    }
  } catch (error) {
    console.error('Błąd ładowania promptów:', error);
    promptInfo.textContent = '❌ Błąd ładowania promptów';
    promptInfo.style.color = '#d93025';
  }
}

// Wypełnij dropdown
function populateDropdown() {
  promptSelect.innerHTML = '';
  
  // Dodaj opcję placeholder
  const placeholderOption = document.createElement('option');
  placeholderOption.value = '';
  placeholderOption.textContent = 'Wybierz prompt...';
  placeholderOption.disabled = true;
  placeholderOption.selected = true;
  promptSelect.appendChild(placeholderOption);
  
  // Dodaj opcje dla każdego promptu (zaczynając od 2, bo 1 to artykuł)
  // Prompt 1 zawiera {{articlecontent}} więc pomijamy go przy resume
  for (let i = 1; i < prompts.length; i++) {
    const option = document.createElement('option');
    option.value = i;
    
    // Użyj nazwy promptu jeśli dostępna, w przeciwnym razie preview promptu
    const promptNumber = i + 1; // Numeracja 1-based dla użytkownika
    let displayText;
    if (promptNames && promptNames[i]) {
      displayText = `Prompt ${promptNumber}: ${promptNames[i]}`;
    } else {
      const promptPreview = truncateText(prompts[i]);
      displayText = `Prompt ${promptNumber}: ${promptPreview}`;
    }
    
    option.textContent = displayText;
    promptSelect.appendChild(option);
  }

  if (Number.isInteger(presetStartIndex)) {
    const clamped = Math.min(Math.max(presetStartIndex, 1), Math.max(1, prompts.length - 1));
    promptSelect.value = String(clamped);
  }

  updateInfo();
}

// Aktualizuj info
function updateInfo() {
  if (prompts.length === 0) {
    promptInfo.textContent = 'Brak dostepnych promptow';
    return;
  }
  
  const selectedIndex = parseInt(promptSelect.value);
  const prefixParts = [];
  if (resumeTitle) prefixParts.push(`Zrodlo: ${resumeTitle}`);
  if (resumeAnalysisType) prefixParts.push(`Typ: ${resumeAnalysisType}`);
  const prefix = prefixParts.length > 0 ? `${prefixParts.join(' - ')}\n` : '';
  
  if (isNaN(selectedIndex)) {
    promptInfo.textContent = `${prefix}Dostepne prompty: 2-${prompts.length} (${prompts.length - 1} promptow)`;
    startBtn.disabled = true;
  } else {
    const remaining = prompts.length - selectedIndex;
    const promptNumber = selectedIndex + 1; // Numeracja 1-based
    const promptName = promptNames && promptNames[selectedIndex] ? promptNames[selectedIndex] : `Prompt ${promptNumber}`;
    promptInfo.textContent = `${prefix}Wybrano: "${promptName}" - zostanie wykonanych ${remaining} prompt${remaining == 1 ? '' : remaining < 5 ? 'y' : 'ow'} (prompty ${promptNumber}-${prompts.length})`;
    startBtn.disabled = false;
  }
}

// Obsługa zmiany wyboru
promptSelect.addEventListener('change', updateInfo);

// Obsługa przycisku Start
startBtn.addEventListener('click', () => {
  const selectedIndex = parseInt(promptSelect.value);
  
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
