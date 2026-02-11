// responses.js - zarządzanie listą odpowiedzi z podziałem na analiza spółki i portfela

const companyResponsesList = document.getElementById('companyResponsesList');
const portfolioResponsesList = document.getElementById('portfolioResponsesList');
const companyEmptyState = document.getElementById('companyEmptyState');
const portfolioEmptyState = document.getElementById('portfolioEmptyState');
const responseCount = document.getElementById('responseCount');
const companyCount = document.getElementById('companyCount');
const portfolioCount = document.getElementById('portfolioCount');
const marketCount = document.getElementById('marketCount');
const marketStatus = document.getElementById('marketStatus');
const marketTable = document.getElementById('marketTable');
const marketTableBody = marketTable ? marketTable.querySelector('tbody') : null;
const clearBtn = document.getElementById('clearBtn');
const copyAllCompanyBtn = document.getElementById('copyAllCompanyBtn');
const copyAllPortfolioBtn = document.getElementById('copyAllPortfolioBtn');

const RESPONSE_STORAGE_KEY = 'responses';
const MARKET_API_URL = 'http://localhost:8787/market/daily';
let responseStorageReady = null;

function getStorageAreas() {
  return {
    local: chrome.storage?.local || null,
    session: chrome.storage?.session || null
  };
}

function makeResponseKey(response) {
  if (!response) return '';
  const timestamp = response.timestamp || 0;
  const runId = response.runId || '';
  const analysisType = response.analysisType || '';
  const source = response.source || '';
  const text = response.text || '';
  const head = text.slice(0, 64);
  return `${timestamp}|${runId}|${analysisType}|${source}|${text.length}|${head}`;
}

function mergeResponses(primary, secondary) {
  const merged = [];
  const seen = new Set();

  const add = (response) => {
    if (!response || typeof response !== 'object') return;
    const key = makeResponseKey(response);
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(response);
  };

  primary.forEach(add);
  secondary.forEach(add);

  return merged;
}

function countWords(text) {
  if (!text) return 0;
  const cleaned = text.trim().replace(/\s+/g, ' ');
  if (!cleaned) return 0;
  return cleaned.split(' ').length;
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms)) return '';
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${seconds} s`;
}

function formatStageLine(response) {
  const stage = response?.stage;
  if (!stage) return '';
  const number = Number.isInteger(stage.number)
    ? stage.number
    : Number.isInteger(stage.index)
      ? stage.index + 1
      : null;
  const name = stage.name || (number ? `Prompt ${number}` : 'Prompt');
  const label = number ? `Etap ${number}: ${name}` : `Etap: ${name}`;
  const parts = [label];
  const durationText = formatDurationMs(stage.durationMs);
  if (durationText) parts.push(durationText);
  const words = Number.isFinite(stage.wordCount) ? stage.wordCount : countWords(response.text || '');
  if (Number.isFinite(words)) parts.push(`${words} slow`);
  return parts.join(' | ');
}

function formatFourGateTable(text) {
  if (!text || typeof text !== 'string') return null;
  const parts = text.split(';').map((part) => part.trim());
  if (parts.length === 16 && parts[15] === '') {
    parts.pop();
  }
  if (parts.length !== 15) return null;

  const labels = [
    'Data decyzji',
    'Status decyzji',
    'Spolka',
    'Krotkie streszczenie tezy',
    'Material zrodlowy',
    'Teza inwestycyjna',
    'Watpliwosci/ryzyka',
    'Gate rating',
    'Asymetria/Divergence',
    'VOI/Falsifiers',
    'Sektor',
    'Region',
    'Waluta',
    'WHY BUY',
    'WHY AVOID'
  ];

  return labels
    .map((label, index) => `${index + 1} - ${label} - ${parts[index] || ''}`)
    .join('\n');
}

async function migrateResponsesToLocal() {
  const { local, session } = getStorageAreas();
  if (!local || !session) return;

  const [localResult, sessionResult] = await Promise.all([
    local.get([RESPONSE_STORAGE_KEY]),
    session.get([RESPONSE_STORAGE_KEY])
  ]);

  const localResponses = localResult.responses || [];
  const sessionResponses = sessionResult.responses || [];

  if (sessionResponses.length === 0) return;

  const merged = mergeResponses(localResponses, sessionResponses);
  const shouldWrite = merged.length !== localResponses.length || localResponses.length === 0;

  if (shouldWrite) {
    await local.set({ [RESPONSE_STORAGE_KEY]: merged });
  }

  await session.remove([RESPONSE_STORAGE_KEY]);
}

function ensureResponseStorageReady() {
  if (!responseStorageReady) {
    responseStorageReady = migrateResponsesToLocal().catch((error) => {
      console.warn('[storage] Response migration failed:', error);
    });
  }
  return responseStorageReady;
}

async function readResponsesFromStorage() {
  const { local, session } = getStorageAreas();

  if (local) {
    const localResult = await local.get([RESPONSE_STORAGE_KEY]);
    const localResponses = localResult.responses || [];
    if (localResponses.length > 0) {
      return localResponses;
    }
  }

  if (session) {
    const sessionResult = await session.get([RESPONSE_STORAGE_KEY]);
    return sessionResult.responses || [];
  }

  return [];
}

// Wczytaj i wyświetl odpowiedzi przy starcie
loadResponses();

// Obsługa przycisku "Wyczyść wszystkie"
clearBtn.addEventListener('click', async () => {
  if (confirm('Czy na pewno chcesz wyczyścić wszystkie zebrane odpowiedzi?')) {
    await ensureResponseStorageReady();
    const { local, session } = getStorageAreas();
    const tasks = [];
    if (local) tasks.push(local.set({ [RESPONSE_STORAGE_KEY]: [] }));
    if (session) tasks.push(session.set({ [RESPONSE_STORAGE_KEY]: [] }));
    await Promise.all(tasks);
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
    await ensureResponseStorageReady();
    const responses = await readResponsesFromStorage();
    
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
    console.log(`📥 [loadResponses] Wczytuję odpowiedzi z storage...`);
    await ensureResponseStorageReady();
    const responses = await readResponsesFromStorage();
    
    console.log(`📦 [loadResponses] Wczytano ${responses.length} odpowiedzi:`, responses);
    
    renderResponses(responses);
    loadMarketData();
  } catch (error) {
    console.error('❌ [loadResponses] Błąd wczytywania odpowiedzi:', error);
    console.error('Stack trace:', error.stack);
    showEmptyStates();
  }
}

// Funkcja renderująca listę odpowiedzi
function renderResponses(responses) {
  console.log(`🎨 [renderResponses] Renderuję ${responses.length} odpowiedzi`);
  
  // Rozdziel odpowiedzi na dwa typy
  // Starsze odpowiedzi bez analysisType domyślnie 'company'
  const companyResponses = responses.filter(r => (r.analysisType || 'company') === 'company');
  const portfolioResponses = responses.filter(r => r.analysisType === 'portfolio');
  
  console.log(`   Company: ${companyResponses.length}, Portfolio: ${portfolioResponses.length}`);
  
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

  const stageLineText = formatStageLine(response);
  if (stageLineText) {
    const stageLine = document.createElement('div');
    stageLine.className = 'response-stage';
    stageLine.textContent = stageLineText;
    meta.appendChild(stageLine);
  }
  
  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.textContent = 'Kopiuj';
  const formattedText = response.formattedText || response.formatted_text || formatFourGateTable(response.text);
  const displayText = formattedText || response.text;
  copyBtn.addEventListener('click', () => copyToClipboard(displayText, copyBtn));
  
  header.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'response-actions';
  actions.appendChild(copyBtn);
  
  const text = document.createElement('div');
  text.className = 'response-text';
  text.textContent = displayText;
  if (formattedText) {
    text.classList.add('formatted');
  }

  if (stageLineText) {
    text.style.display = 'none';
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'toggle-btn';
    toggleBtn.textContent = 'Rozwin';
    toggleBtn.addEventListener('click', () => {
      const isHidden = text.style.display === 'none';
      text.style.display = isHidden ? 'block' : 'none';
      toggleBtn.textContent = isHidden ? 'Ukryj' : 'Rozwin';
    });
    actions.appendChild(toggleBtn);
  }

  header.appendChild(actions);
  
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
function formatChangeCell(value, isPercent = false) {
  if (!Number.isFinite(value)) return '—';
  const formatted = isPercent ? `${value.toFixed(2)}%` : value.toFixed(2);
  return value > 0 ? `+${formatted}` : formatted;
}

function updateMarketStatus(message) {
  if (!marketStatus) return;
  marketStatus.textContent = message;
}

async function loadMarketData() {
  if (!marketStatus || !marketTable || !marketTableBody) return;

  try {
    updateMarketStatus('Pobieram dane rynkowe...');
    const response = await fetch(MARKET_API_URL);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json();
    if (!payload?.ok) {
      throw new Error(payload?.error || 'unknown_error');
    }
    const data = payload.data || [];
    if (marketCount) {
      marketCount.textContent = data.length === 1 ? '1 spółka' : `${data.length} spółek`;
    }

    marketTableBody.innerHTML = '';

    if (data.length === 0) {
      marketTable.style.display = 'none';
      updateMarketStatus('Brak spółek z tickerami w bazie.');
      return;
    }

    data.forEach((row) => {
      const tr = document.createElement('tr');
      const changeClass = Number.isFinite(row.change)
        ? row.change > 0
          ? 'positive'
          : row.change < 0
            ? 'negative'
            : ''
        : '';

      tr.innerHTML = `
        <td>${row.symbol || '—'}</td>
        <td>${row.company || '—'}</td>
        <td>${Number.isFinite(row.close) ? row.close.toFixed(2) : '—'}</td>
        <td class="market-change ${changeClass}">${formatChangeCell(row.change)}</td>
        <td class="market-change ${changeClass}">${formatChangeCell(row.change_pct, true)}</td>
        <td class="market-status">${row.status || '—'}</td>
      `;
      marketTableBody.appendChild(tr);
    });

    marketTable.style.display = '';
    updateMarketStatus('Aktualne zmiany dzienne.');
  } catch (error) {
    marketTable.style.display = 'none';
    updateMarketStatus(`Błąd pobierania danych: ${error.message}`);
    console.error('❌ Błąd danych rynkowych:', error);
  }
}

chrome.storage.onChanged.addListener((changes, namespace) => {
  console.log(`🔔 [responses.js] Storage changed:`, { namespace, changes });
  if ((namespace === 'local' || namespace === 'session') && changes[RESPONSE_STORAGE_KEY]) {
    console.log(`✅ [responses.js] Responses changed, reloading...`);
    console.log(`   Old length: ${changes[RESPONSE_STORAGE_KEY].oldValue?.length || 0}`);
    console.log(`   New length: ${changes[RESPONSE_STORAGE_KEY].newValue?.length || 0}`);
    loadResponses();
  }
});
