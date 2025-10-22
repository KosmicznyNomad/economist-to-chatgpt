// responses.js - zarządzanie listą odpowiedzi z podziałem na analiza spółki i portfela

const companyResponsesList = document.getElementById('companyResponsesList');
const portfolioResponsesList = document.getElementById('portfolioResponsesList');
const companyEmptyState = document.getElementById('companyEmptyState');
const portfolioEmptyState = document.getElementById('portfolioEmptyState');
const responseCount = document.getElementById('responseCount');
const companyCount = document.getElementById('companyCount');
const portfolioCount = document.getElementById('portfolioCount');
const clearBtn = document.getElementById('clearBtn');
const copyAllCompanyBtn = document.getElementById('copyAllCompanyBtn');
const copyAllPortfolioBtn = document.getElementById('copyAllPortfolioBtn');

// Wczytaj i wyświetl odpowiedzi przy starcie
loadResponses();

// Obsługa przycisku "Wyczyść wszystkie"
clearBtn.addEventListener('click', async () => {
  if (confirm('Czy na pewno chcesz wyczyścić wszystkie zebrane odpowiedzi?')) {
    await chrome.storage.session.set({ responses: [] });
    loadResponses();
  }
});

// Obsługa przycisku "Kopiuj wszystkie" dla analizy spółki
copyAllCompanyBtn.addEventListener('click', async () => {
  await copyAllByType('company', copyAllCompanyBtn);
});

// Obsługa przycisku "Kopiuj wszystkie" dla analizy portfela
copyAllPortfolioBtn.addEventListener('click', async () => {
  await copyAllByType('portfolio', copyAllPortfolioBtn);
});

// Funkcja kopiująca wszystkie odpowiedzi danego typu
async function copyAllByType(analysisType, button) {
  try {
    const result = await chrome.storage.session.get(['responses']);
    const responses = result.responses || [];
    
    // Filtruj po analysisType
    const filteredResponses = responses.filter(r => (r.analysisType || 'company') === analysisType);
    
    if (filteredResponses.length === 0) {
      return;
    }
    
    // Sortuj od najnowszej do najstarszej (jak na ekranie)
    const sortedResponses = [...filteredResponses].sort((a, b) => b.timestamp - a.timestamp);
    
    // Połącz teksty z \n jako separator - każda odpowiedź w nowym wierszu Google Sheets
    const allText = sortedResponses.map(r => r.text).join('\n');
    
    await navigator.clipboard.writeText(allText);
    
    // Wizualna informacja
    const originalText = button.textContent;
    button.textContent = '✓ Skopiowano';
    button.classList.add('copied');
    
    setTimeout(() => {
      button.textContent = originalText;
      button.classList.remove('copied');
    }, 2000);
    
    console.log(`✅ Skopiowano ${filteredResponses.length} odpowiedzi (${analysisType}) do clipboard`);
  } catch (error) {
    console.error('❌ Błąd kopiowania:', error);
    button.textContent = '✗ Błąd';
    setTimeout(() => {
      button.textContent = 'Kopiuj wszystkie';
    }, 2000);
  }
}

// Funkcja wczytująca odpowiedzi z storage
async function loadResponses() {
  try {
    const result = await chrome.storage.session.get(['responses']);
    const responses = result.responses || [];
    
    renderResponses(responses);
  } catch (error) {
    console.error('❌ Błąd wczytywania odpowiedzi:', error);
    showEmptyStates();
  }
}

// Funkcja renderująca listę odpowiedzi
function renderResponses(responses) {
  // Rozdziel odpowiedzi na dwa typy
  // Starsze odpowiedzi bez analysisType domyślnie 'company'
  const companyResponses = responses.filter(r => (r.analysisType || 'company') === 'company');
  const portfolioResponses = responses.filter(r => r.analysisType === 'portfolio');
  
  // Aktualizuj liczniki
  const totalCount = responses.length;
  responseCount.textContent = totalCount === 0 
    ? '0 odpowiedzi' 
    : totalCount === 1 
      ? '1 odpowiedź' 
      : `${totalCount} odpowiedzi`;
  
  updateSectionCount(companyCount, companyResponses.length);
  updateSectionCount(portfolioCount, portfolioResponses.length);
  
  clearBtn.disabled = totalCount === 0;
  copyAllCompanyBtn.disabled = companyResponses.length === 0;
  copyAllPortfolioBtn.disabled = portfolioResponses.length === 0;
  
  // Renderuj sekcję analizy spółki
  if (companyResponses.length === 0) {
    showEmptyState(companyEmptyState);
    hideResponsesList(companyResponsesList);
  } else {
    hideEmptyState(companyEmptyState);
    showResponsesList(companyResponsesList);
    renderResponsesInSection(companyResponsesList, companyResponses);
  }
  
  // Renderuj sekcję analizy portfela
  if (portfolioResponses.length === 0) {
    showEmptyState(portfolioEmptyState);
    hideResponsesList(portfolioResponsesList);
  } else {
    hideEmptyState(portfolioEmptyState);
    showResponsesList(portfolioResponsesList);
    renderResponsesInSection(portfolioResponsesList, portfolioResponses);
  }
}

// Funkcja aktualizująca licznik sekcji
function updateSectionCount(element, count) {
  element.textContent = count === 0 
    ? '0 odpowiedzi' 
    : count === 1 
      ? '1 odpowiedź' 
      : `${count} odpowiedzi`;
}

// Funkcja renderująca odpowiedzi w danej sekcji
function renderResponsesInSection(listElement, responses) {
  // Sortuj od najnowszej do najstarszej
  const sortedResponses = [...responses].sort((a, b) => b.timestamp - a.timestamp);
  
  // Wyczyść listę
  listElement.innerHTML = '';
  
  // Renderuj każdą odpowiedź
  sortedResponses.forEach((response) => {
    const item = createResponseItem(response);
    listElement.appendChild(item);
  });
}

// Funkcja tworząca element odpowiedzi
function createResponseItem(response) {
  const item = document.createElement('div');
  item.className = 'response-item';
  
  const header = document.createElement('div');
  header.className = 'response-header';
  
  const meta = document.createElement('div');
  meta.className = 'response-meta';
  
  const source = document.createElement('div');
  source.className = 'response-source';
  source.textContent = response.source || 'Artykuł';
  
  const time = document.createElement('div');
  time.className = 'response-time';
  time.textContent = formatTimestamp(response.timestamp);
  
  meta.appendChild(source);
  meta.appendChild(time);
  
  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.textContent = 'Kopiuj';
  copyBtn.addEventListener('click', () => copyToClipboard(response.text, copyBtn));
  
  header.appendChild(meta);
  header.appendChild(copyBtn);
  
  const text = document.createElement('div');
  text.className = 'response-text';
  text.textContent = response.text;
  
  item.appendChild(header);
  item.appendChild(text);
  
  return item;
}

// Funkcja kopiująca tekst do clipboard
async function copyToClipboard(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    
    // Wizualna informacja o skopiowaniu
    const originalText = button.textContent;
    button.textContent = '✓ Skopiowano';
    button.classList.add('copied');
    
    setTimeout(() => {
      button.textContent = originalText;
      button.classList.remove('copied');
    }, 2000);
    
    console.log('✅ Skopiowano do clipboard');
  } catch (error) {
    console.error('❌ Błąd kopiowania:', error);
    button.textContent = '✗ Błąd';
    setTimeout(() => {
      button.textContent = 'Kopiuj';
    }, 2000);
  }
}

// Funkcja formatująca timestamp na czytelną datę
function formatTimestamp(timestamp) {
  const date = new Date(timestamp);
  const now = new Date();
  
  const isToday = date.toDateString() === now.toDateString();
  
  const timeStr = date.toLocaleTimeString('pl-PL', {
    hour: '2-digit',
    minute: '2-digit'
  });
  
  if (isToday) {
    return `Dzisiaj o ${timeStr}`;
  }
  
  const dateStr = date.toLocaleDateString('pl-PL', {
    day: 'numeric',
    month: 'long',
    year: 'numeric'
  });
  
  return `${dateStr} o ${timeStr}`;
}

// Funkcje pokazujące/ukrywające empty state
function showEmptyState(element) {
  element.style.display = 'block';
}

function hideEmptyState(element) {
  element.style.display = 'none';
}

function showResponsesList(element) {
  element.style.display = 'flex';
}

function hideResponsesList(element) {
  element.style.display = 'none';
}

function showEmptyStates() {
  showEmptyState(companyEmptyState);
  showEmptyState(portfolioEmptyState);
  hideResponsesList(companyResponsesList);
  hideResponsesList(portfolioResponsesList);
}

// Nasłuchuj zmian w storage (gdy nowe odpowiedzi są dodawane)
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'session' && changes.responses) {
    loadResponses();
  }
});
