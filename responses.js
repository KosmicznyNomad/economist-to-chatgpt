// responses.js - zarzÄ…dzanie listÄ… odpowiedzi z podziaĹ‚em na analiza spĂłĹ‚ki i portfela

const companyResponsesList = document.getElementById('companyResponsesList');
const companyEmptyState = document.getElementById('companyEmptyState');
const responseCount = document.getElementById('responseCount');
const companyCount = document.getElementById('companyCount');
const marketCount = document.getElementById('marketCount');
const marketStatus = document.getElementById('marketStatus');
const marketTable = document.getElementById('marketTable');
const marketTableBody = marketTable ? marketTable.querySelector('tbody') : null;
const clearBtn = document.getElementById('clearBtn');
const copyAllCompanyBtn = document.getElementById('copyAllCompanyBtn');
const copyAllCompanyWithLinkBtn = document.getElementById('copyAllCompanyWithLinkBtn');

const RESPONSE_STORAGE_KEY = 'responses';
let responseStorageReady = null;

// Clipboard copy counters (in-memory per tab open).
const clipboardCounters = {
  ops: 0,
  opsOk: 0,
  opsFail: 0,
  messagesAttempted: 0,
  messagesCopiedOk: 0,
  messagesCopiedFail: 0
};

function logClipboard(event, extra = {}) {
  // Keep logs ASCII to avoid mojibake in some consoles.
  console.log(`[clipboard] ${event}`, { ...clipboardCounters, ...extra });
}

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
  const responseId = response.responseId || '';
  const analysisType = response.analysisType || '';
  const source = response.source || '';
  const text = response.text || '';
  const head = text.slice(0, 64);
  return `${timestamp}|${runId}|${responseId}|${analysisType}|${source}|${text.length}|${head}`;
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

// Wczytaj i wyĹ›wietl odpowiedzi przy starcie
loadResponses();

// ObsĹ‚uga przycisku "WyczyĹ›Ä‡ wszystkie"
clearBtn.addEventListener('click', async () => {
  if (confirm('Czy na pewno chcesz wyczyĹ›ciÄ‡ wszystkie zebrane odpowiedzi?')) {
    await ensureResponseStorageReady();
    const { local, session } = getStorageAreas();
    const tasks = [];
    if (local) tasks.push(local.set({ [RESPONSE_STORAGE_KEY]: [] }));
    if (session) tasks.push(session.set({ [RESPONSE_STORAGE_KEY]: [] }));
    await Promise.all(tasks);
    loadResponses();
  }
});

// ObsĹ‚uga przycisku "Kopiuj wszystkie" dla analizy spĂłĹ‚ki
copyAllCompanyBtn.addEventListener('click', async () => {
  await copyAllByType('company', copyAllCompanyBtn);
});

if (copyAllCompanyWithLinkBtn) {
  copyAllCompanyWithLinkBtn.addEventListener('click', async () => {
    await copyAllByTypeWithLink('company', copyAllCompanyWithLinkBtn);
  });
}

function normalizeConversationUrl(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (!/^https?:\/\//i.test(raw)) return '';
  return raw;
}

function resolveConversationUrl(response) {
  if (!response || typeof response !== 'object') return '';
  return (
    normalizeConversationUrl(response.conversationUrl) ||
    normalizeConversationUrl(response.conversation_url) ||
    ''
  );
}

// Funkcja kopiujÄ…ca wszystkie odpowiedzi danego typu
async function copyAllByType(analysisType, button) {
  let opCounted = false;
  let attemptedCount = 0;
  let attemptedChars = 0;
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
    
    // PoĹ‚Ä…cz teksty z \n jako separator - kaĹĽda odpowiedĹş w nowym wierszu Google Sheets
    const allText = sortedResponses.map(r => r.text).join('\n');

    attemptedCount = sortedResponses.length;
    attemptedChars = allText.length;
    clipboardCounters.ops += 1;
    opCounted = true;
    clipboardCounters.messagesAttempted += attemptedCount;
    
    await navigator.clipboard.writeText(allText);
    clipboardCounters.opsOk += 1;
    clipboardCounters.messagesCopiedOk += attemptedCount;
    
    // Wizualna informacja
    const originalText = button.textContent;
    button.textContent = `\u2713 Skopiowano (${attemptedCount})`;
    button.classList.add('copied');
    
    setTimeout(() => {
      button.textContent = originalText;
      button.classList.remove('copied');
    }, 2000);
    
    logClipboard('OK copy_all', {
      analysisType,
      copiedMessages: attemptedCount,
      chars: attemptedChars
    });
  } catch (error) {
    if (!opCounted) {
      clipboardCounters.ops += 1;
      opCounted = true;
      clipboardCounters.messagesAttempted += attemptedCount;
    }
    clipboardCounters.opsFail += 1;
    clipboardCounters.messagesCopiedFail += attemptedCount;
    console.error('[clipboard] ERROR copy_all:', error);
    button.textContent = '\u2717 Blad';
    setTimeout(() => {
      button.textContent = 'Kopiuj wszystkie';
    }, 2000);
    logClipboard('FAIL copy_all', { analysisType, attemptedMessages: attemptedCount, attemptedChars });
  }
}

// Kopiuje wszystkie odpowiedzi danego typu jako TSV: text<TAB>conversationUrl (po jednej odpowiedzi na wiersz).
async function copyAllByTypeWithLink(analysisType, button) {
  let opCounted = false;
  let attemptedCount = 0;
  let attemptedChars = 0;
  try {
    await ensureResponseStorageReady();
    const responses = await readResponsesFromStorage();

    const filteredResponses = responses.filter(r => (r.analysisType || 'company') === analysisType);
    if (filteredResponses.length === 0) {
      return;
    }

    const sortedResponses = [...filteredResponses].sort((a, b) => b.timestamp - a.timestamp);
    const allText = sortedResponses
      .map((response) => {
        const text = typeof response?.text === 'string' ? response.text.replace(/\t/g, ' ') : '';
        const url = resolveConversationUrl(response);
        return `${text}\t${url}`;
      })
      .join('\n');

    attemptedCount = sortedResponses.length;
    attemptedChars = allText.length;
    clipboardCounters.ops += 1;
    opCounted = true;
    clipboardCounters.messagesAttempted += attemptedCount;

    await navigator.clipboard.writeText(allText);
    clipboardCounters.opsOk += 1;
    clipboardCounters.messagesCopiedOk += attemptedCount;

    const originalText = button.textContent;
    button.textContent = `\u2713 Skopiowano (${attemptedCount})`;
    button.classList.add('copied');

    setTimeout(() => {
      button.textContent = originalText;
      button.classList.remove('copied');
    }, 2000);

    logClipboard('OK copy_all_with_link', {
      analysisType,
      copiedMessages: attemptedCount,
      chars: attemptedChars
    });
  } catch (error) {
    if (!opCounted) {
      clipboardCounters.ops += 1;
      opCounted = true;
      clipboardCounters.messagesAttempted += attemptedCount;
    }
    clipboardCounters.opsFail += 1;
    clipboardCounters.messagesCopiedFail += attemptedCount;
    console.error('[clipboard] ERROR copy_all_with_link:', error);
    button.textContent = '\u2717 Blad';
    setTimeout(() => {
      button.textContent = 'Kopiuj z linkiem';
    }, 2000);
    logClipboard('FAIL copy_all_with_link', { analysisType, attemptedMessages: attemptedCount, attemptedChars });
  }
}

// Funkcja wczytujÄ…ca odpowiedzi z storage
async function loadResponses() {
  try {
    console.log(`đź“Ą [loadResponses] WczytujÄ™ odpowiedzi z storage...`);
    await ensureResponseStorageReady();
    const responses = await readResponsesFromStorage();
    
    console.log(`đź“¦ [loadResponses] Wczytano ${responses.length} odpowiedzi:`, responses);
    
    renderResponses(responses);
    loadMarketData();
  } catch (error) {
    console.error('âťŚ [loadResponses] BĹ‚Ä…d wczytywania odpowiedzi:', error);
    console.error('Stack trace:', error.stack);
    showEmptyStates();
  }
}

// Funkcja renderujÄ…ca listÄ™ odpowiedzi
function renderResponses(responses) {
  console.log(`đźŽ¨ [renderResponses] RenderujÄ™ ${responses.length} odpowiedzi`);
  
  // Starsze odpowiedzi bez analysisType domyĹ›lnie 'company'
  const companyResponses = responses.filter(r => (r.analysisType || 'company') === 'company');
  
  console.log(`   Company: ${companyResponses.length}`);
  
  // Aktualizuj liczniki
  const totalCount = responses.length;
  responseCount.textContent = totalCount === 0 
    ? '0 odpowiedzi' 
    : totalCount === 1 
      ? '1 odpowiedĹş' 
      : `${totalCount} odpowiedzi`;
  
  updateSectionCount(companyCount, companyResponses.length);
  
  clearBtn.disabled = totalCount === 0;
  copyAllCompanyBtn.disabled = companyResponses.length === 0;
  if (copyAllCompanyWithLinkBtn) {
    copyAllCompanyWithLinkBtn.disabled = companyResponses.length === 0;
  }
  
  if (companyResponses.length === 0) {
    showEmptyState(companyEmptyState);
    hideResponsesList(companyResponsesList);
  } else {
    hideEmptyState(companyEmptyState);
    showResponsesList(companyResponsesList);
    renderResponsesInSection(companyResponsesList, companyResponses);
  }
}

// Funkcja aktualizujÄ…ca licznik sekcji
function updateSectionCount(element, count) {
  element.textContent = count === 0 
    ? '0 odpowiedzi' 
    : count === 1 
      ? '1 odpowiedĹş' 
      : `${count} odpowiedzi`;
}

// Funkcja renderujÄ…ca odpowiedzi w danej sekcji
function renderResponsesInSection(listElement, responses) {
  // Sortuj od najnowszej do najstarszej
  const sortedResponses = [...responses].sort((a, b) => b.timestamp - a.timestamp);
  
  // WyczyĹ›Ä‡ listÄ™
  listElement.innerHTML = '';
  
  // Renderuj kaĹĽdÄ… odpowiedĹş
  sortedResponses.forEach((response) => {
    const item = createResponseItem(response);
    listElement.appendChild(item);
  });
}

// Funkcja tworzÄ…ca element odpowiedzi
function createResponseItem(response) {
  const item = document.createElement('div');
  item.className = 'response-item';
  
  const header = document.createElement('div');
  header.className = 'response-header';
  
  const meta = document.createElement('div');
  meta.className = 'response-meta';
  
  const source = document.createElement('div');
  source.className = 'response-source';
  source.textContent = response.source || 'ArtykuĹ‚';
  
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

  const conversationUrl = resolveConversationUrl(response);
  if (conversationUrl) {
    const openChatBtn = document.createElement('button');
    openChatBtn.className = 'toggle-btn';
    openChatBtn.textContent = 'Otworz chat';
    openChatBtn.addEventListener('click', () => {
      try {
        if (chrome?.tabs?.create) {
          chrome.tabs.create({ url: conversationUrl });
          return;
        }
      } catch (error) {
        // Ignore and fallback below.
      }
      window.open(conversationUrl, '_blank', 'noopener,noreferrer');
    });
    actions.appendChild(openChatBtn);
  }
  
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

// Funkcja kopiujÄ…ca tekst do clipboard
async function copyToClipboard(text, button) {
  const attemptedCount = 1;
  const attemptedChars = typeof text === 'string' ? text.length : 0;
  try {
    clipboardCounters.ops += 1;
    clipboardCounters.messagesAttempted += attemptedCount;
    await navigator.clipboard.writeText(text);
    clipboardCounters.opsOk += 1;
    clipboardCounters.messagesCopiedOk += attemptedCount;
    
    // Wizualna informacja o skopiowaniu
    const originalText = button.textContent;
    button.textContent = '\u2713 Skopiowano (1)';
    button.classList.add('copied');
    
    setTimeout(() => {
      button.textContent = originalText;
      button.classList.remove('copied');
    }, 2000);
    
    logClipboard('OK copy_one', { chars: typeof text === 'string' ? text.length : 0 });
  } catch (error) {
    clipboardCounters.opsFail += 1;
    clipboardCounters.messagesCopiedFail += attemptedCount;
    console.error('[clipboard] ERROR copy_one:', error);
    button.textContent = '\u2717 Blad';
    setTimeout(() => {
      button.textContent = 'Kopiuj';
    }, 2000);
    logClipboard('FAIL copy_one', { attemptedChars });
  }
}

// Funkcja formatujÄ…ca timestamp na czytelnÄ… datÄ™
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

// Funkcje pokazujÄ…ce/ukrywajÄ…ce empty state
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
  hideResponsesList(companyResponsesList);
}

// NasĹ‚uchuj zmian w storage (gdy nowe odpowiedzi sÄ… dodawane)
function formatChangeCell(value, isPercent = false) {
  if (!Number.isFinite(value)) return 'â€”';
  const formatted = isPercent ? `${value.toFixed(2)}%` : value.toFixed(2);
  return value > 0 ? `+${formatted}` : formatted;
}

function updateMarketStatus(message) {
  if (!marketStatus) return;
  marketStatus.textContent = message;
}

async function loadMarketData() {
  if (!marketStatus || !marketTable || !marketTableBody) return;
  marketTableBody.innerHTML = '';
  marketTable.style.display = 'none';
  if (marketCount) {
    marketCount.textContent = '0 spolek';
  }
  updateMarketStatus('Backend usuniety: dane rynkowe niedostepne.');
}

chrome.storage.onChanged.addListener((changes, namespace) => {
  console.log(`đź”” [responses.js] Storage changed:`, { namespace, changes });
  if ((namespace === 'local' || namespace === 'session') && changes[RESPONSE_STORAGE_KEY]) {
    console.log(`âś… [responses.js] Responses changed, reloading...`);
    console.log(`   Old length: ${changes[RESPONSE_STORAGE_KEY].oldValue?.length || 0}`);
    console.log(`   New length: ${changes[RESPONSE_STORAGE_KEY].newValue?.length || 0}`);
    loadResponses();
  }
});

