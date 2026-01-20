const CHAT_URL = "https://chatgpt.com/";
const CHAT_URL_PORTFOLIO = "https://chatgpt.com/g/g-68f71d198ffc819191ccc108942c5a56-iskierka-test-global";
const PAUSE_MS = 1000;
const WAIT_FOR_TEXTAREA_MS = 10000; // 10 sekund na znalezienie textarea
const WAIT_FOR_RESPONSE_MS = 7200000; // 120 minut na odpowiedź ChatGPT (zwiększono dla długich deep thinking sessions)
const RETRY_INTERVAL_MS = 500;

// Optional cloud upload config (kept simple; safe to extend later).
const CLOUD_UPLOAD = {
  enabled: false,
  url: "",
  apiKey: "",
  apiKeyHeader: "Authorization", // Use "Authorization" (Bearer) or custom header like "X-Api-Key".
  timeoutMs: 20000,
  retryCount: 2,
  backoffMs: 1000
};

// Zmienne globalne dla promptów
let PROMPTS_COMPANY = [];
let PROMPTS_PORTFOLIO = [];

// Nazwy etapów dla company analysis (synchronizowane z prompts-company.txt)
const STAGE_NAMES_COMPANY = [
  "Artykuł + Analiza Layer 3+",           // Etap 1: {{articlecontent}} + first principles
  "Investment Pipeline (Stage 1-10)",     // Etap 2: Process overview
  "Porter's Five Forces",                 // Etap 3: Industry analysis
  "Stock Selection (15 Companies)",       // Etap 4: 15 stock picks
  "Reverse DCF Lite + Driver Screen",     // Etap 5: Quick valuation filter
  "Competitive Positioning (4 Companies)",// Etap 6: Top 4 companies
  "Pairwise Flip-Gate (Top 2)",           // Etap 7: Head-to-head comparison
  "DuPont ROE Quality",                   // Etap 8: ROE decomposition
  "Thesis Monetization",                  // Etap 9: Revenue/profit quantification
  "Reverse DCF (Full)",                   // Etap 10: Full valuation expectations
  "Four-Gate Framework",                  // Etap 11: BUY/AVOID decision
  "Simple Story (Polski)",                // Etap 12: Plain language summary
  "Final Output"                          // Etap 13: Formatted decision output
];

// Funkcja generująca losowe opóźnienie dla anti-automation
function getRandomDelay() {
  const minDelay = 3000;  // 3 sekundy
  const maxDelay = 15000; // 15 sekund
  return Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
}

async function uploadResponseToCloud(response) {
  if (!CLOUD_UPLOAD.enabled) {
    return { skipped: true, reason: "disabled" };
  }
  if (!CLOUD_UPLOAD.url) {
    console.warn("[cloud] Upload enabled but URL is empty");
    return { skipped: true, reason: "missing_url" };
  }

  const headers = {
    "Content-Type": "application/json"
  };

  if (CLOUD_UPLOAD.apiKey) {
    if ((CLOUD_UPLOAD.apiKeyHeader || "").toLowerCase() === "authorization") {
      headers.Authorization = `Bearer ${CLOUD_UPLOAD.apiKey}`;
    } else {
      headers[CLOUD_UPLOAD.apiKeyHeader] = CLOUD_UPLOAD.apiKey;
    }
  }

  const payload = {
    text: response.text,
    timestamp: response.timestamp,
    source: response.source,
    analysisType: response.analysisType,
    savedAt: new Date().toISOString(),
    extensionVersion: chrome.runtime.getManifest().version
  };

  const maxAttempts = Math.max(1, CLOUD_UPLOAD.retryCount + 1);
  const body = JSON.stringify(payload);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CLOUD_UPLOAD.timeoutMs);

    try {
      const response = await fetch(CLOUD_UPLOAD.url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      return { success: true, status: response.status };
    } catch (error) {
      clearTimeout(timeoutId);

      if (attempt < maxAttempts) {
        await sleep(CLOUD_UPLOAD.backoffMs * attempt);
        continue;
      }

      return { success: false, error: error.message || String(error) };
    }
  }

  return { success: false, error: "unknown" };
}

// Funkcja wczytująca prompty z plików txt
async function loadPrompts() {
  try {
    console.log("📝 Wczytuję prompty z plików...");
    
    // Wczytaj prompts-company.txt
    const companyUrl = chrome.runtime.getURL('prompts-company.txt');
    const companyResponse = await fetch(companyUrl);
    const companyText = await companyResponse.text();
    
    // Parsuj prompty (oddzielone ◄PROMPT_SEPARATOR►)
    PROMPTS_COMPANY = companyText
      .split('◄PROMPT_SEPARATOR►')
      .map(p => p.trim())
      .filter(p => p.length > 0);
    
    console.log(`✅ Wczytano ${PROMPTS_COMPANY.length} promptów dla analizy spółki`);
    
    // Wczytaj prompts-portfolio.txt
    const portfolioUrl = chrome.runtime.getURL('prompts-portfolio.txt');
    const portfolioResponse = await fetch(portfolioUrl);
    const portfolioText = await portfolioResponse.text();
    
    // Parsuj prompty (oddzielone ◄PROMPT_SEPARATOR►)
    PROMPTS_PORTFOLIO = portfolioText
      .split('◄PROMPT_SEPARATOR►')
      .map(p => p.trim())
      .filter(p => p.length > 0);
    
    console.log(`✅ Wczytano ${PROMPTS_PORTFOLIO.length} promptów dla analizy portfela`);
    
  } catch (error) {
    console.error('❌ Błąd wczytywania promptów:', error);
    // Ustaw puste tablice jako fallback
    PROMPTS_COMPANY = [];
    PROMPTS_PORTFOLIO = [];
  }
}

// Wczytaj prompty przy starcie rozszerzenia
loadPrompts();

// Obsługiwane źródła artykułów
const SUPPORTED_SOURCES = [
  { pattern: "https://*.economist.com/*", name: "The Economist" },
  { pattern: "https://asia.nikkei.com/*", name: "Nikkei Asia" },
  { pattern: "https://*.caixinglobal.com/*", name: "Caixin Global" },
  { pattern: "https://*.theafricareport.com/*", name: "The Africa Report" },
  { pattern: "https://*.nzz.ch/*", name: "NZZ" },
  { pattern: "https://*.project-syndicate.org/*", name: "Project Syndicate" },
  { pattern: "https://the-ken.com/*", name: "The Ken" },
  { pattern: "https://www.youtube.com/*", name: "YouTube" },
  { pattern: "https://youtu.be/*", name: "YouTube" },
  { pattern: "https://*.wsj.com/*", name: "Wall Street Journal" },
  { pattern: "https://*.foreignaffairs.com/*", name: "Foreign Affairs" },
  { pattern: "https://open.spotify.com/*", name: "Spotify" }
];

// Funkcja zwracająca tablicę URLi do query
function getSupportedSourcesQuery() {
  return SUPPORTED_SOURCES.map(s => s.pattern);
}

// Tworzenie menu kontekstowego przy instalacji
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "view-responses",
    title: "Pokaż zebrane odpowiedzi",
    contexts: ["all"]
  });
});

// Handler kliknięcia menu kontekstowego
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "view-responses") {
    chrome.tabs.create({
      url: chrome.runtime.getURL('responses.html')
    });
  }
});

// Funkcja zapisująca odpowiedź do storage
async function saveResponse(responseText, source, analysisType = 'company') {
  try {
    console.log(`\n${'*'.repeat(80)}`);
    console.log(`💾 💾 💾 [saveResponse] ROZPOCZĘTO ZAPISYWANIE 💾 💾 💾`);
    console.log(`${'*'.repeat(80)}`);
    console.log(`Długość tekstu: ${responseText?.length || 0} znaków`);
    console.log(`Źródło: ${source}`);
    console.log(`Typ analizy: ${analysisType}`);
    console.log(`${'*'.repeat(80)}`);
    
    // Walidacja - nie zapisuj pustych odpowiedzi
    if (!responseText || responseText.trim().length === 0) {
      console.warn(`⚠️ [saveResponse] POMINIĘTO - odpowiedź jest pusta (${responseText?.length || 0} znaków)`);
      console.warn(`   Źródło: ${source}`);
      console.warn(`   Typ analizy: ${analysisType}`);
      console.log(`${'*'.repeat(80)}\n`);
      return;
    }
    
    const result = await chrome.storage.session.get(['responses']);
    const responses = result.responses || [];
    
    console.log(`📦 Obecny stan storage: ${responses.length} odpowiedzi`);
    
    const newResponse = {
      text: responseText,
      timestamp: Date.now(),
      source: source,
      analysisType: analysisType
    };
    
    responses.push(newResponse);

    console.log(`💾 Zapisuję do chrome.storage.session...`);
    await chrome.storage.session.set({ responses });

    // POPRAWKA: Weryfikacja że zapis faktycznie się udał
    console.log(`🔍 Weryfikuję zapis...`);
    const verification = await chrome.storage.session.get(['responses']);
    const verifiedResponses = verification.responses || [];

    if (verifiedResponses.length !== responses.length) {
      console.error(`❌ KRYTYCZNY: Weryfikacja storage nieudana!`);
      console.error(`   Oczekiwano: ${responses.length} odpowiedzi`);
      console.error(`   Faktycznie: ${verifiedResponses.length} odpowiedzi`);
      throw new Error('Storage verification failed - saved count does not match');
    }

    // Sprawdź czy ostatnia odpowiedź jest ta która właśnie zapisaliśmy
    const lastSaved = verifiedResponses[verifiedResponses.length - 1];
    if (lastSaved.text !== responseText) {
      console.error(`❌ KRYTYCZNY: Ostatnia odpowiedź w storage nie pasuje!`);
      console.error(`   Oczekiwano długość: ${responseText.length}`);
      console.error(`   Faktycznie długość: ${lastSaved.text.length}`);
      throw new Error('Storage verification failed - text mismatch');
    }

    console.log(`✅ Weryfikacja storage: OK`);

    const uploadResult = await uploadResponseToCloud({ ...newResponse });
    if (uploadResult?.success) {
      console.log(`[cloud] Upload OK (status ${uploadResult.status})`);
    } else if (uploadResult?.skipped) {
      console.log(`[cloud] Upload skipped (${uploadResult.reason || "unknown"})`);
    } else {
      console.warn(`[cloud] Upload failed: ${uploadResult?.error || "unknown"}`);
    }

    console.log(`\n${'*'.repeat(80)}`);
    console.log(`✅ ✅ ✅ [saveResponse] ZAPISANO I ZWERYFIKOWANO POMYŚLNIE ✅ ✅ ✅`);
    console.log(`${'*'.repeat(80)}`);
    console.log(`Nowy stan: ${responses.length} odpowiedzi w storage (zweryfikowano: ${verifiedResponses.length})`);
    console.log(`Preview: "${responseText.substring(0, 150)}..."`);
    console.log(`${'*'.repeat(80)}\n`);
  } catch (error) {
    console.error(`\n${'!'.repeat(80)}`);
    console.error(`❌ ❌ ❌ [saveResponse] BŁĄD ZAPISYWANIA ❌ ❌ ❌`);
    console.error(`${'!'.repeat(80)}`);
    console.error('Error:', error);
    console.error('Stack:', error.stack);
    console.error(`${'!'.repeat(80)}\n`);
  }
}

// Listener na wiadomości z content scriptu i popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SAVE_RESPONSE') {
    saveResponse(message.text, message.source, message.analysisType);
  } else if (message.type === 'RUN_ANALYSIS') {
    runAnalysis();
  } else if (message.type === 'MANUAL_SOURCE_SUBMIT') {
    console.log('📩 Otrzymano MANUAL_SOURCE_SUBMIT:', { 
      titleLength: message.title?.length, 
      textLength: message.text?.length, 
      instances: message.instances 
    });
    runManualSourceAnalysis(message.text, message.title, message.instances);
    sendResponse({ success: true });
    return true; // Utrzymuj kanał otwarty dla async
  } else if (message.type === 'GET_COMPANY_PROMPTS') {
    // Zwróć prompty dla company
    sendResponse({ prompts: PROMPTS_COMPANY });
    return false;
  } else if (message.type === 'GET_STAGE_NAMES') {
    // Zwróć nazwy etapów
    sendResponse({ stageNames: STAGE_NAMES_COMPANY });
    return false;
  } else if (message.type === 'RESUME_STAGE_START') {
    // Uruchom analizę od konkretnego etapu
    console.log('📩 Otrzymano RESUME_STAGE_START:', { startIndex: message.startIndex });
    resumeFromStage(message.startIndex);
    sendResponse({ success: true });
    return false;
  } else if (message.type === 'RESUME_STAGE_OPEN') {
    // Otwórz okno z wyborem etapu
    console.log('📩 Otrzymano RESUME_STAGE_OPEN');
    chrome.windows.create({
      url: chrome.runtime.getURL('resume-stage.html'),
      type: 'popup',
      width: 600,
      height: 400
    });
    sendResponse({ success: true });
    return false;
  } else if (message.type === 'ACTIVATE_TAB') {
    // POPRAWKA: Aktywuj kartę ChatGPT przed wysyłaniem wiadomości
    console.log('🔍 Aktywuję kartę ChatGPT...');
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (tabs[0]) {
        try {
          await chrome.tabs.update(tabs[0].id, { active: true });
          await chrome.windows.update(tabs[0].windowId, { focused: true });
          console.log('✅ Karta ChatGPT aktywowana');
          sendResponse({ success: true });
        } catch (error) {
          console.error('❌ Błąd aktywacji karty:', error);
          sendResponse({ success: false, error: error.message });
        }
      } else {
        sendResponse({ success: false, error: 'No active tab found' });
      }
    });
    return true; // Utrzymuj kanał otwarty dla async
  }
});

// Listener na skróty klawiszowe
chrome.commands.onCommand.addListener((command) => {
  if (command === 'open_responses') {
    chrome.tabs.create({ url: chrome.runtime.getURL('responses.html') });
  }
});

// Funkcja wznawiania od konkretnego etapu
async function resumeFromStage(startIndex) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`🔄 RESUME FROM STAGE ${startIndex + 1}`);
  console.log(`${'='.repeat(80)}\n`);
  
  try {
    // KROK 1: Znajdź aktywne okno ChatGPT
    console.log("🔍 Szukam aktywnego okna ChatGPT...");
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (tabs.length === 0) {
      console.error("❌ Brak aktywnego okna");
      alert("Błąd: Brak aktywnego okna. Otwórz ChatGPT i spróbuj ponownie.");
      return;
    }
    
    const activeTab = tabs[0];
    
    if (!activeTab.url || !activeTab.url.includes('chatgpt.com')) {
      console.error("❌ Aktywne okno to nie ChatGPT:", activeTab.url);
      alert("Błąd: Aktywne okno nie jest ChatGPT. Przejdź do okna ChatGPT i spróbuj ponownie.");
      return;
    }
    
    console.log(`✅ Znaleziono aktywne okno ChatGPT: ${activeTab.id}`);
    
    // KROK 2: Sprawdź czy prompty są wczytane
    if (PROMPTS_COMPANY.length === 0) {
      console.error("❌ Brak promptów");
      alert("Błąd: Brak promptów. Sprawdź plik prompts-company.txt");
      return;
    }
    
    if (startIndex >= PROMPTS_COMPANY.length) {
      console.error(`❌ Nieprawidłowy indeks: ${startIndex} (max: ${PROMPTS_COMPANY.length - 1})`);
      alert(`Błąd: Nieprawidłowy indeks etapu. Maksymalny: ${PROMPTS_COMPANY.length}`);
      return;
    }
    
    console.log(`✅ Prompty załadowane: ${PROMPTS_COMPANY.length}, start od: ${startIndex + 1}`);
    
    // KROK 3: Przygotuj prompty do wklejenia (od startIndex do końca)
    const promptsToSend = PROMPTS_COMPANY.slice(startIndex);
    console.log(`📝 Będę wklejać ${promptsToSend.length} promptów (${startIndex + 1}-${PROMPTS_COMPANY.length})`);
    
    // POPRAWKA: Usuń {{articlecontent}} z pierwszego prompta (bo w resume nie mamy artykułu)
    const cleanedPrompts = [...promptsToSend];
    if (cleanedPrompts[0]) {
      cleanedPrompts[0] = cleanedPrompts[0].replace('{{articlecontent}}', '').trim();
      console.log(`📝 Pierwszy prompt (po usunięciu {{articlecontent}}): ${cleanedPrompts[0].substring(0, 100)}...`);
    }
    
    // W trybie resume: pusty payload + wszystkie prompty w chain
    const payload = '';  // Pusty payload oznacza tryb resume
    const restOfPrompts = cleanedPrompts;  // Wszystkie prompty w chain
    
    console.log(`📝 Payload: pusty (tryb resume)`);
    console.log(`📝 Prompty w chain: ${restOfPrompts.length}`);
    
    // KROK 4: Aktywuj okno ChatGPT
    console.log("\n🔍 Aktywuję okno ChatGPT...");
    await chrome.windows.update(activeTab.windowId, { focused: true });
    await chrome.tabs.update(activeTab.id, { active: true });
    console.log("✅ Okno ChatGPT aktywowane");
    
    // KROK 4.5: NOWE - Sprawdź i zatrzymaj aktywne generowanie
    console.log("\n🔍 Sprawdzam stan ChatGPT przed rozpoczęciem...");
    try {
      const stateCheckResults = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        function: () => {
          // Sprawdź czy ChatGPT generuje odpowiedź
          const stopButton = document.querySelector('button[aria-label*="Stop"]') || 
                           document.querySelector('[data-testid="stop-button"]') ||
                           document.querySelector('button[aria-label*="Zatrzymaj"]');
          
          if (stopButton) {
            console.log('🛑 ChatGPT generuje odpowiedź - klikam Stop...');
            stopButton.click();
            return { wasGenerating: true, stopped: true };
          }
          
          // Sprawdź czy editor jest zablokowany
          const editor = document.querySelector('[role="textbox"]') || 
                        document.querySelector('[contenteditable]');
          const isBlocked = editor && editor.getAttribute('contenteditable') === 'false';
          
          if (isBlocked) {
            console.log('⚠️ Editor jest zablokowany - czekam na odblokowanie...');
            return { wasGenerating: true, stopped: false, editorBlocked: true };
          }
          
          console.log('✅ ChatGPT jest gotowy - interface czysty');
          return { wasGenerating: false, stopped: false };
        }
      });
      
      const stateCheck = stateCheckResults[0]?.result;
      
      if (stateCheck?.wasGenerating) {
        console.log('⏸️ Wykryto aktywne generowanie - zatrzymano i czekam na stabilizację...');
        // Czekaj 3 sekundy na stabilizację interfejsu po zatrzymaniu
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Sprawdź ponownie czy interface jest gotowy
        const recheckResults = await chrome.scripting.executeScript({
          target: { tabId: activeTab.id },
          function: () => {
            const editor = document.querySelector('[role="textbox"]') || 
                          document.querySelector('[contenteditable]');
            const isReady = editor && editor.getAttribute('contenteditable') === 'true';
            return { ready: isReady };
          }
        });
        
        if (!recheckResults[0]?.result?.ready) {
          console.error('❌ Interface nie jest gotowy po zatrzymaniu generowania');
          alert('Błąd: ChatGPT nie jest gotowy. Zatrzymaj ręcznie generowanie i spróbuj ponownie.');
          return;
        }
      }
      
      console.log('✅ ChatGPT gotowy do rozpoczęcia resume');
      
    } catch (error) {
      console.warn('⚠️ Nie udało się sprawdzić stanu ChatGPT:', error);
      // Kontynuuj mimo błędu - może to być problem z permissions
    }
    
    // KROK 5: Wstrzyknij prompty do ChatGPT
    console.log("\n🚀 Wstrzykuję prompty do ChatGPT...");
    
    try {
      // POPRAWKA: Używamy pierwszego prompta jako payload, reszta jako promptChain
      // To jest ANALOGICZNE do processArticles (linie 681-713)
      const results = await chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        function: injectToChat,
        args: [payload, restOfPrompts, WAIT_FOR_TEXTAREA_MS, WAIT_FOR_RESPONSE_MS, RETRY_INTERVAL_MS, `Resume from Stage ${startIndex + 1}`, 'company']
      });
      
      console.log("✅ Prompty wstrzyknięte pomyślnie");
      console.log(`\n${'='.repeat(80)}`);
      console.log(`✅ RESUME FROM STAGE ZAKOŃCZONE`);
      console.log(`${'='.repeat(80)}\n`);
      
    } catch (error) {
      console.error("❌ Błąd wstrzykiwania promptów:", error);
      alert(`Błąd wstrzykiwania promptów: ${error.message}`);
    }
    
  } catch (error) {
    console.error("❌ Błąd w resumeFromStage:", error);
    alert(`Błąd wznawiania: ${error.message}`);
  }
}

// Funkcja pobierania prompt chain od użytkownika
async function getPromptChain() {
  return new Promise((resolve) => {
    let resolved = false;
    
    // Stwórz małe okno z dialogiem
    chrome.windows.create({
      url: chrome.runtime.getURL('prompt-dialog.html'),
      type: 'popup',
      width: 600,
      height: 400
    }, (window) => {
      const windowId = window.id;
      
      // Listener na wiadomość z dialogu
      const messageListener = (message, sender) => {
        if (message.type === 'PROMPT_CHAIN_SUBMIT') {
          cleanup();
          chrome.windows.remove(sender.tab.windowId, () => {
            if (chrome.runtime.lastError) {
              // Okno już zamknięte - ignoruj
            }
          });
          if (!resolved) {
            resolved = true;
            resolve(message.prompts);
          }
        } else if (message.type === 'PROMPT_CHAIN_CANCEL') {
          cleanup();
          chrome.windows.remove(sender.tab.windowId, () => {
            if (chrome.runtime.lastError) {
              // Okno już zamknięte - ignoruj
            }
          });
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        }
      };
      
      // Listener na zamknięcie okna (ręczne zamknięcie przez X)
      const windowListener = (closedWindowId) => {
        if (closedWindowId === windowId) {
          cleanup();
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        }
      };
      
      function cleanup() {
        chrome.runtime.onMessage.removeListener(messageListener);
        chrome.windows.onRemoved.removeListener(windowListener);
      }
      
      chrome.runtime.onMessage.addListener(messageListener);
      chrome.windows.onRemoved.addListener(windowListener);
    });
  });
}

// Funkcja wyboru artykułów do analizy portfela
async function getArticleSelection(articles) {
  console.log(`getArticleSelection: otrzymano ${articles.length} artykułów`);
  
  return new Promise((resolve) => {
    let resolved = false;
    
    // Przygotuj dane artykułów (title i url)
    const articlesData = articles.map(tab => ({
      title: tab.title || 'Bez tytułu',
      url: tab.url,
      id: tab.id
    }));
    
    console.log(`getArticleSelection: przygotowano dane dla ${articlesData.length} artykułów:`, articlesData);
    
    // Enkoduj dane do URL
    const encodedData = encodeURIComponent(JSON.stringify(articlesData));
    console.log(`getArticleSelection: długość zakodowanych danych: ${encodedData.length} znaków`);
    const selectorUrl = chrome.runtime.getURL(`article-selector.html?articles=${encodedData}`);
    console.log(`getArticleSelection: otwieranie selektora: ${selectorUrl.substring(0, 150)}...`);
    
    // Stwórz małe okno z dialogiem
    chrome.windows.create({
      url: selectorUrl,
      type: 'popup',
      width: 700,
      height: 600
    }, (window) => {
      const windowId = window.id;
      
      // Listener na wiadomość z dialogu
      const messageListener = (message, sender) => {
        if (message.type === 'ARTICLE_SELECTION_SUBMIT') {
          cleanup();
          chrome.windows.remove(sender.tab.windowId, () => {
            if (chrome.runtime.lastError) {
              // Okno już zamknięte - ignoruj
            }
          });
          if (!resolved) {
            resolved = true;
            // Zwróć indeksy zaznaczonych artykułów
            resolve(message.selectedIndices || []);
          }
        } else if (message.type === 'ARTICLE_SELECTION_CANCEL') {
          cleanup();
          chrome.windows.remove(sender.tab.windowId, () => {
            if (chrome.runtime.lastError) {
              // Okno już zamknięte - ignoruj
            }
          });
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        }
      };
      
      // Listener na zamknięcie okna (ręczne zamknięcie przez X)
      const windowListener = (closedWindowId) => {
        if (closedWindowId === windowId) {
          cleanup();
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        }
      };
      
      function cleanup() {
        chrome.runtime.onMessage.removeListener(messageListener);
        chrome.windows.onRemoved.removeListener(windowListener);
      }
      
      chrome.runtime.onMessage.addListener(messageListener);
      chrome.windows.onRemoved.addListener(windowListener);
    });
  });
}

// Funkcja przetwarzająca artykuły z danym prompt chain i URL
async function processArticles(tabs, promptChain, chatUrl, analysisType) {
  if (!tabs || tabs.length === 0) {
    console.log(`[${analysisType}] Brak artykułów do przetworzenia`);
    return [];
  }
  
  console.log(`[${analysisType}] Rozpoczynam przetwarzanie ${tabs.length} artykułów`);
  
  const processingPromises = tabs.map(async (tab, index) => {
    try {
      console.log(`\n=== [${analysisType}] [${index + 1}/${tabs.length}] Przetwarzam kartę ID: ${tab.id}, Tytuł: ${tab.title}`);
      console.log(`URL: ${tab.url}`);
      
      // Małe opóźnienie między startami aby nie przytłoczyć przeglądarki
      await sleep(index * 500);
      
      // Sprawdź czy to pseudo-tab (ręcznie wklejone źródło)
      const isManualSource = tab.url === "manual://source";
      let extractedText;
      let transcriptLang = null; // Może być ustawiony przez YouTube content script
      
      if (isManualSource) {
        // Użyj tekstu przekazanego bezpośrednio
        extractedText = tab.manualText;
        console.log(`[${analysisType}] [${index + 1}/${tabs.length}] Używam ręcznie wklejonego tekstu: ${extractedText?.length || 0} znaków`);
        
        // Dla manual source: brak walidacji długości (zgodnie z planem)
        if (!extractedText || extractedText.length === 0) {
          console.log(`[${analysisType}] [${index + 1}/${tabs.length}] Pominięto - pusty tekst`);
          return { success: false, reason: 'pusty tekst' };
        }
      } else {
        // Wykryj źródło najpierw, aby wiedzieć czy to YouTube
        const url = new URL(tab.url);
        const hostname = url.hostname;
        let isYouTube = hostname.includes('youtube.com') || hostname.includes('youtu.be');
        
        if (isYouTube) {
          // === YOUTUBE: Użyj content script przez sendMessage ===
          console.log(`[${analysisType}] [${index + 1}/${tabs.length}] YouTube wykryty - używam content script`);
          
          try {
            const response = await chrome.tabs.sendMessage(tab.id, {
              type: 'GET_TRANSCRIPT'
            });
            
            console.log(`[${analysisType}] [${index + 1}/${tabs.length}] Odpowiedź z content script:`, {
              length: response.transcript?.length || 0,
              method: response.method,
              error: response.error
            });
            
            if (!response.transcript) {
              console.error(`[${analysisType}] [${index + 1}/${tabs.length}] Brak transkrypcji: ${response.error || 'unknown'}`);
              return { success: false, reason: `YouTube: ${response.error || 'no transcript'}` };
            }
            
            extractedText = response.transcript;
            transcriptLang = response.lang || response.langName || 'unknown';
            
            console.log(`[${analysisType}] [${index + 1}/${tabs.length}] ✓ Transkrypcja: ${extractedText.length} znaków, język: ${transcriptLang}, metoda: ${response.method}`);
            
          } catch (e) {
            console.error(`[${analysisType}] [${index + 1}/${tabs.length}] ❌ Błąd komunikacji z content script:`, e);
            return { success: false, reason: 'YouTube: content script error' };
          }
          
        } else {
          // === NON-YOUTUBE: Użyj executeScript z extractText ===
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            function: extractText
          });
          extractedText = results[0]?.result;
          console.log(`[${analysisType}] [${index + 1}/${tabs.length}] Wyekstrahowano ${extractedText?.length || 0} znaków`);
        }
        
        // Dla automatycznych źródeł: walidacja minimum 50 znaków
        if (!extractedText || extractedText.length < 50) {
          console.log(`[${analysisType}] [${index + 1}/${tabs.length}] Pominięto - za mało tekstu`);
          return { success: false, reason: 'za mało tekstu' };
        }
      }

      // Pobierz tytuł
      const title = tab.title || "Bez tytułu";
      
      // Wykryj źródło artykułu (dla non-YouTube lub dla payload metadata)
      let sourceName;
      
      if (isManualSource) {
        sourceName = "Manual Source";
      } else {
        const url = new URL(tab.url);
        const hostname = url.hostname;
        sourceName = "Unknown";
        for (const source of SUPPORTED_SOURCES) {
          const domain = source.pattern.replace('*://*.', '').replace('*://', '').replace('/*', '');
          if (hostname.includes(domain)) {
            sourceName = source.name;
            break;
          }
        }
      }

      // Wyciągnij treść pierwszego prompta z promptChain
      const firstPrompt = promptChain[0] || '';
      
      // Wstaw treść artykułu do pierwszego prompta (zamień {{articlecontent}})
      let payload = firstPrompt.replace('{{articlecontent}}', extractedText);
      
      // Usuń pierwszy prompt z promptChain (zostanie użyty jako payload)
      const restOfPrompts = promptChain.slice(1);

      // Otwórz nowe okno ChatGPT
      const window = await chrome.windows.create({
        url: chatUrl,
        type: "normal",
        focused: true  // POPRAWKA: Aktywuj okno od razu
      });

      const chatTabId = window.tabs[0].id;

      // POPRAWKA: Upewnij się że okno jest aktywne i karta ma fokus
      await chrome.windows.update(window.id, { focused: true });
      await chrome.tabs.update(chatTabId, { active: true });

      // Czekaj na załadowanie strony
      await waitForTabComplete(chatTabId);

      // Wstrzyknij tekst do ChatGPT z retry i uruchom prompt chain
      let results;
      try {
        console.log(`\n🚀 Wywołuję executeScript dla karty ${chatTabId}...`);
        results = await chrome.scripting.executeScript({
          target: { tabId: chatTabId },
          function: injectToChat,
          args: [payload, restOfPrompts, WAIT_FOR_TEXTAREA_MS, WAIT_FOR_RESPONSE_MS, RETRY_INTERVAL_MS, title, analysisType]
        });
        console.log(`✅ executeScript zakończony pomyślnie`);
      } catch (executeError) {
        console.error(`\n${'='.repeat(80)}`);
        console.error(`❌ executeScript FAILED`);
        console.error(`  Tab ID: ${chatTabId}`);
        console.error(`  Error: ${executeError.message}`);
        console.error(`  Stack: ${executeError.stack}`);
        console.error(`${'='.repeat(80)}\n`);
        return { success: false, title, error: `executeScript error: ${executeError.message}` };
      }

      // Zapisz ostatnią odpowiedź zwróconą z injectToChat
      console.log(`\n${'='.repeat(80)}`);
      console.log(`[${analysisType}] [${index + 1}/${tabs.length}] 🎯 ANALIZA WYNIKU Z executeScript`);
      console.log(`Artykuł: ${title}`);
      console.log(`${'='.repeat(80)}`);
      
      // Sprawdź co dokładnie zwróciło executeScript
      console.log(`📦 results array:`, {
        exists: !!results,
        length: results?.length,
        type: typeof results
      });
      
      // Bezpieczna diagnostyka results (bez JSON.stringify)
      if (results && results.length > 0) {
        console.log(`📦 results[0] keys:`, results[0] ? Object.keys(results[0]) : 'brak');
        console.log(`📦 results[0].result type:`, typeof results[0]?.result);
        console.log(`📦 results[0].result exists:`, results[0]?.result !== undefined);
      }
      
      if (!results || results.length === 0) {
        console.error(`❌ KRYTYCZNY: results jest puste lub undefined!`);
        console.error(`  - results: ${results}`);
        console.log(`${'='.repeat(80)}\n`);
        // Ten return trafia do Promise.allSettled jako fulfilled z tą wartością
        return { success: false, title, error: 'executeScript nie zwrócił wyników' };
      }
      
      console.log(`📦 results[0]:`, {
        exists: !!results[0],
        type: typeof results[0],
        keys: results[0] ? Object.keys(results[0]) : []
      });
      
      const result = results[0]?.result;
      
      if (result === undefined) {
        console.error(`❌ KRYTYCZNY: results[0].result jest undefined!`);
        console.error(`  - results[0]: ${JSON.stringify(results[0], null, 2)}`);
      } else if (result === null) {
        console.error(`❌ KRYTYCZNY: results[0].result jest null!`);
      } else {
        console.log(`✓ result istnieje i nie jest null/undefined`);
        console.log(`  - type: ${typeof result}`);
        console.log(`  - success: ${result.success}`);
        console.log(`  - lastResponse type: ${typeof result.lastResponse}`);
        console.log(`  - lastResponse defined: ${result.lastResponse !== undefined}`);
        console.log(`  - lastResponse not null: ${result.lastResponse !== null}`);
        if (result.lastResponse !== undefined && result.lastResponse !== null) {
          console.log(`  - lastResponse length: ${result.lastResponse.length}`);
          console.log(`  - lastResponse preview: "${result.lastResponse.substring(0, 100)}..."`);
        }
        if (result.error) {
          console.log(`  - error: ${result.error}`);
        }
      }
      
      // DIAGNOSTYKA: Sprawdź dokładnie co mamy w result
      console.log(`\n🔍 DIAGNOSTYKA RESULT:`);
      console.log(`  - result exists: ${!!result}`);
      console.log(`  - result.success: ${result?.success}`);
      console.log(`  - result.lastResponse exists: ${result?.lastResponse !== undefined}`);
      console.log(`  - result.lastResponse is null: ${result?.lastResponse === null}`);
      console.log(`  - result.lastResponse length: ${result?.lastResponse?.length || 0}`);
      console.log(`  - result.lastResponse trim length: ${result?.lastResponse?.trim()?.length || 0}`);
      console.log(`  - result.lastResponse preview: "${result?.lastResponse?.substring(0, 100) || 'undefined'}..."`);
      
      if (result && result.success && result.lastResponse !== undefined && result.lastResponse !== null && result.lastResponse.trim().length > 0) {
        console.log(`\n✅ ✅ ✅ WARUNEK SPEŁNIONY - WYWOŁUJĘ saveResponse ✅ ✅ ✅`);
        console.log(`Zapisuję odpowiedź: ${result.lastResponse.length} znaków`);
        console.log(`Typ analizy: ${analysisType}`);
        console.log(`Tytuł: ${title}`);
        
        await saveResponse(result.lastResponse, title, analysisType);
        
        console.log(`✅ ✅ ✅ saveResponse ZAKOŃCZONY ✅ ✅ ✅`);
        console.log(`${'='.repeat(80)}\n`);
      } else if (result && result.success && (result.lastResponse === undefined || result.lastResponse === null || result.lastResponse.trim().length === 0)) {
        console.warn(`\n⚠️ ⚠️ ⚠️ Proces SUKCES ale lastResponse jest pusta lub null ⚠️ ⚠️ ⚠️`);
        console.warn(`lastResponse: "${result.lastResponse}" (długość: ${result.lastResponse?.length || 0})`);
        console.log(`${'='.repeat(80)}\n`);
      } else if (result && !result.success) {
        console.warn(`\n⚠️ ⚠️ ⚠️ Proces zakończony BEZ SUKCESU (success=false) ⚠️ ⚠️ ⚠️`);
        console.log(`${'='.repeat(80)}\n`);
      } else {
        console.error(`\n❌ ❌ ❌ NIEOCZEKIWANY STAN ❌ ❌ ❌`);
        console.error(`hasResult: ${!!result}`);
        console.error(`success: ${result?.success}`);
        console.error(`lastResponse: ${result?.lastResponse}`);
        console.log(`${'='.repeat(80)}\n`);
      }

      console.log(`[${analysisType}] [${index + 1}/${tabs.length}] ✅ Rozpoczęto przetwarzanie: ${title}`);
      return { success: true, title };

    } catch (error) {
      console.error(`[${analysisType}] [${index + 1}/${tabs.length}] ❌ Błąd:`, error);
      return { success: false, error: error.message };
    }
  });

  // Poczekaj na uruchomienie wszystkich
  const results = await Promise.allSettled(processingPromises);
  
  const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
  console.log(`\n[${analysisType}] 🎉 Uruchomiono ${successful}/${tabs.length} procesów ChatGPT`);
  
  return results;
}

// Główna funkcja uruchamiająca analizę
async function runAnalysis() {
  try {
    console.log("\n=== ROZPOCZYNAM KONFIGURACJĘ ANALIZY ===");
    
    // KROK 1: Sprawdź czy prompty są wczytane
    console.log("\n📝 Krok 1: Sprawdzanie promptów");
    if (PROMPTS_COMPANY.length === 0) {
      console.error("❌ Brak promptów dla analizy spółki w prompts-company.txt");
      alert("Błąd: Brak promptów dla analizy spółki. Sprawdź plik prompts-company.txt");
      return;
    }
    console.log(`✅ Analiza spółki: ${PROMPTS_COMPANY.length} promptów`);
    
    if (PROMPTS_PORTFOLIO.length === 0) {
      console.warn("⚠️ Brak promptów dla analizy portfela w prompts-portfolio.txt");
    } else {
      console.log(`✅ Analiza portfela: ${PROMPTS_PORTFOLIO.length} promptów`);
    }
    
    // KROK 2: Pobierz wszystkie artykuły
    console.log("\n📰 Krok 2: Pobieranie artykułów");
    const allTabs = [];
    const patterns = getSupportedSourcesQuery();
    console.log(`Szukam artykułów w ${patterns.length} źródłach:`, patterns);
    
    for (const pattern of patterns) {
      const tabs = await chrome.tabs.query({url: pattern});
      console.log(`  - ${pattern}: znaleziono ${tabs.length} kart`);
      if (tabs.length > 0) {
        tabs.forEach(tab => console.log(`    • ${tab.title} (${tab.url})`));
      }
      allTabs.push(...tabs);
    }
    
    if (allTabs.length === 0) {
      console.log("❌ Brak otwartych kart z obsługiwanych źródeł");
      alert("Nie znaleziono otwartych artykułów z obsługiwanych źródeł.\n\nObsługiwane źródła:\n- The Economist\n- Nikkei Asia\n- Caixin Global\n- The Africa Report\n- NZZ\n- Project Syndicate\n- The Ken\n- Wall Street Journal\n- Foreign Affairs\n- YouTube");
      return;
    }

    console.log(`✅ Znaleziono ${allTabs.length} artykułów łącznie`);
    
    // KROK 3: Wybór artykułów do analizy portfela
    console.log("\n🎯 Krok 3: Wybór artykułów do analizy portfela");
    const selectedIndices = await getArticleSelection(allTabs);
    
    if (selectedIndices === null) {
      console.log("❌ Anulowano wybór artykułów");
      return;
    }
    
    console.log(`✅ Wybrano ${selectedIndices.length} artykułów do analizy portfela`);
    
    // KROK 4: Przygotuj zaznaczone artykuły do analizy portfela
    let selectedTabs = [];
    if (selectedIndices.length > 0 && PROMPTS_PORTFOLIO.length > 0) {
      selectedTabs = selectedIndices.map(index => allTabs[index]);
      console.log(`\n✅ Przygotowano ${selectedTabs.length} artykułów do analizy portfela`);
    } else if (selectedIndices.length > 0 && PROMPTS_PORTFOLIO.length === 0) {
      console.log("\n⚠️ Zaznaczono artykuły ale brak promptów - pomijam analizę portfela");
    } else {
      console.log("\n⏭️ Nie zaznaczono artykułów do analizy portfela");
    }
    
    // KROK 5: Uruchom oba procesy równolegle
    console.log("\n🚀 Krok 5: Uruchamianie procesów analizy");
    console.log(`   - Analiza spółki: ${allTabs.length} artykułów`);
    console.log(`   - Analiza portfela: ${selectedTabs.length} artykułów`);
    
    const processingTasks = [];
    
    // Zawsze uruchamiaj analizę spółki
    processingTasks.push(
      processArticles(allTabs, PROMPTS_COMPANY, CHAT_URL, 'company')
    );
    
    // Uruchom analizę portfela jeśli są zaznaczone artykuły i prompty
    if (selectedTabs.length > 0) {
      processingTasks.push(
        processArticles(selectedTabs, PROMPTS_PORTFOLIO, CHAT_URL_PORTFOLIO, 'portfolio')
      );
    }
    
    // Poczekaj na uruchomienie obu procesów
    await Promise.allSettled(processingTasks);
    
    console.log("\n✅ ZAKOŃCZONO URUCHAMIANIE WSZYSTKICH PROCESÓW");

  } catch (error) {
    console.error("❌ Błąd główny:", error);
  }
}

// Funkcja uruchamiająca analizę z ręcznie wklejonego źródła
async function runManualSourceAnalysis(text, title, instances) {
  try {
    console.log("\n=== ROZPOCZYNAM ANALIZĘ Z RĘCZNEGO ŹRÓDŁA ===");
    console.log(`Tytuł: ${title}`);
    console.log(`Tekst: ${text.length} znaków`);
    console.log(`Instancje: ${instances}`);
    
    // Sprawdź czy prompty są wczytane
    if (PROMPTS_COMPANY.length === 0) {
      console.error("❌ Brak promptów dla analizy spółki");
      alert("Błąd: Brak promptów dla analizy spółki. Sprawdź plik prompts-company.txt");
      return;
    }
    
    console.log(`✅ Prompty załadowane: ${PROMPTS_COMPANY.length}`);
    
    // Stwórz pseudo-taby (N kopii tego samego źródła)
    const timestamp = Date.now();
    const pseudoTabs = [];
    
    for (let i = 0; i < instances; i++) {
      pseudoTabs.push({
        id: `manual-${timestamp}-${i}`,
        title: title,
        url: "manual://source",
        manualText: text  // Przechowuj tekst bezpośrednio
      });
    }
    
    console.log(`✅ Utworzono ${pseudoTabs.length} pseudo-tabów`);
    
    // Uruchom proces analizy
    await processArticles(pseudoTabs, PROMPTS_COMPANY, CHAT_URL, 'company');
    
    console.log("\n✅ ZAKOŃCZONO URUCHAMIANIE ANALIZY Z RĘCZNEGO ŹRÓDŁA");
    
  } catch (error) {
    console.error("❌ Błąd w runManualSourceAnalysis:", error);
  }
}

// Uwaga: chrome.action.onClicked NIE działa gdy jest default_popup w manifest
// Ikona uruchamia popup, a popup wysyła message RUN_ANALYSIS

// Funkcja ekstrakcji tekstu (content script) - tylko dla non-YouTube sources
// YouTube używa dedykowanego content script (youtube-content.js)
async function extractText() {
  const hostname = window.location.hostname;
  console.log(`Próbuję wyekstrahować tekst z: ${hostname}`);
  
  // Mapa selektorów specyficznych dla każdego źródła
  const sourceSelectors = {
    'economist.com': [
      'article',
      '[data-test-id="Article"]',
      '.article__body-text',
      '.layout-article-body'
    ],
    'asia.nikkei.com': [
      'article',
      '.article-body',
      '.ezrichtext-field',
      '.article__body'
    ],
    'caixinglobal.com': [
      'article',
      '.article-content',
      '.article__body',
      '.story-content'
    ],
    'theafricareport.com': [
      'article',
      '.post-content',
      '.entry-content',
      '.article-body'
    ],
    'nzz.ch': [
      'article',
      '.article__body',
      '[itemprop="articleBody"]',
      '.article-content'
    ],
    'project-syndicate.org': [
      'article',
      '.article-content',
      '.body-content',
      '[itemprop="articleBody"]'
    ],
    'the-ken.com': [
      'article',
      '.story-content',
      '[data-article-body]',
      '.article-body'
    ],
    'wsj.com': [
      'article',
      '[itemprop="articleBody"]',
      '.article-content',
      '.wsj-snippet-body'
    ],
    'foreignaffairs.com': [
      'article',
      '.article-body',
      '[itemprop="articleBody"]',
      '.article-content'
    ],
    'open.spotify.com': [
      '.NavBar__NavBarPage-sc-1guraqe-0.ejVULV',
      '.NavBar__NavBarPage-sc-1guraqe-0',
      'article',
      '[role="main"]'
    ]
  };
  
  // Znajdź odpowiednie selektory dla obecnego źródła
  let selectorsToTry = [];
  for (const [domain, selectors] of Object.entries(sourceSelectors)) {
    if (hostname.includes(domain)) {
      selectorsToTry = selectors;
      console.log(`Używam selektorów dla: ${domain}`);
      break;
    }
  }
  
  // Dodaj uniwersalne selektory jako fallback
  const universalSelectors = [
    'main article',
    'main',
    '.article-content',
    '#content'
  ];
  selectorsToTry = [...selectorsToTry, ...universalSelectors];
  
  // Próbuj ekstrahować tekst
  for (const selector of selectorsToTry) {
    const element = document.querySelector(selector);
    if (element) {
      const text = element.innerText || element.textContent;
      if (text && text.length > 100) {
        console.log(`Znaleziono tekst przez selector: ${selector}, długość: ${text.length}`);
        return text;
      }
    }
  }
  
  // Fallback: cała strona
  const bodyText = document.body.innerText || document.body.textContent;
  console.log(`Fallback do body, długość: ${bodyText.length}`);
  return bodyText;
}

// Funkcja wklejania do ChatGPT (content script)
async function injectToChat(payload, promptChain, textareaWaitMs, responseWaitMs, retryIntervalMs, articleTitle, analysisType = 'company') {
  try {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🚀 [injectToChat] START`);
    console.log(`  Article: ${articleTitle}`);
    console.log(`  Analysis: ${analysisType}`);
    console.log(`  Prompts: ${promptChain?.length || 0}`);
    console.log(`${'='.repeat(80)}\n`);
    
  // Funkcja generująca losowe opóźnienie dla anti-automation
  function getRandomDelay() {
    const minDelay = 3000;  // 3 sekundy
    const maxDelay = 15000; // 15 sekund
    return Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
  }
    
  // Funkcja tworząca licznik promptów
  function createCounter() {
    const counter = document.createElement('div');
    counter.id = 'economist-prompt-counter';
    counter.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
      padding: 16px 24px;
      border-radius: 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 14px;
      font-weight: 600;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      z-index: 10000;
      min-width: 200px;
      text-align: center;
    `;
    document.body.appendChild(counter);
    return counter;
  }
  
  // Funkcja aktualizująca licznik
  function updateCounter(counter, current, total, status = '') {
    if (current === 0) {
      counter.innerHTML = `
        <div style="font-size: 16px; margin-bottom: 4px;">📝 Przetwarzanie artykułu</div>
        <div style="font-size: 12px; opacity: 0.9;">${status}</div>
      `;
    } else {
      const percent = Math.round((current / total) * 100);
      counter.innerHTML = `
        <div style="font-size: 16px; margin-bottom: 4px;">Prompt Chain</div>
        <div style="font-size: 24px; margin-bottom: 4px;">${current} / ${total}</div>
        <div style="background: rgba(255,255,255,0.3); height: 6px; border-radius: 3px; margin-bottom: 4px;">
          <div style="background: white; height: 100%; border-radius: 3px; width: ${percent}%; transition: width 0.3s;"></div>
        </div>
        <div style="font-size: 12px; opacity: 0.9;">${status}</div>
      `;
    }
  }
  
  // Funkcja usuwająca licznik
  function removeCounter(counter, success = true) {
    if (success) {
      counter.innerHTML = `
        <div style="font-size: 18px;">🎉 Zakończono!</div>
      `;
      setTimeout(() => counter.remove(), 3000);
    } else {
      counter.remove();
    }
  }
  
  // Funkcja próbująca naprawić błąd przez Edit+Resend
  async function tryEditResend() {
    try {
      console.log('🔧 [tryEditResend] Próbuję naprawić przez Edit+Resend...');
      
      // === 1. ZNAJDŹ OSTATNIĄ WIADOMOŚĆ UŻYTKOWNIKA ===
      console.log('🔍 [tryEditResend] Szukam ostatniej wiadomości użytkownika...');
      
      // Próba 1: standardowy selektor
      let userMessages = document.querySelectorAll('[data-message-author-role="user"]');
      console.log(`  Próba 1: [data-message-author-role="user"] → ${userMessages.length} wyników`);
      
      // Fallback 1: conversation-turn containers
      if (userMessages.length === 0) {
        console.log('  Próba 2: szukam w conversation-turn containers...');
        const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');
        console.log(`    Znaleziono ${turns.length} conversation turns`);
        userMessages = Array.from(turns).filter(turn => 
          turn.querySelector('[data-message-author-role="user"]')
        );
        console.log(`    Znaleziono ${userMessages.length} user turns`);
      }
      
      // Fallback 2: szukaj przez article + klasy
      if (userMessages.length === 0) {
        console.log('  Próba 3: szukam przez article[class*="message"]...');
        const allMessages = document.querySelectorAll('article, [class*="message"], [class*="Message"]');
        console.log(`    Znaleziono ${allMessages.length} potencjalnych wiadomości`);
        userMessages = Array.from(allMessages).filter(msg => {
          const role = msg.getAttribute('data-message-author-role');
          const hasUserIndicator = msg.querySelector('[data-message-author-role="user"]') ||
                                   msg.textContent?.includes('You') ||
                                   msg.classList.toString().includes('user');
          return role === 'user' || hasUserIndicator;
        });
        console.log(`    Znaleziono ${userMessages.length} user messages`);
      }
      
      if (userMessages.length === 0) {
        console.warn('❌ [tryEditResend] Brak wiadomości użytkownika - nie mogę znaleźć Edit');
        return false;
      }
      
      const lastUserMessage = userMessages[userMessages.length - 1];
      console.log(`✓ [tryEditResend] Znaleziono ostatnią wiadomość użytkownika (${userMessages.length} total)`);
      
      // === 2. SYMULUJ HOVER ŻEBY POKAZAĆ EDIT ===
      console.log('🖱️ [tryEditResend] Symuluję hover aby pokazać Edit...');
      lastUserMessage.dispatchEvent(new MouseEvent('mouseenter', { 
        view: window,
        bubbles: true, 
        cancelable: true 
      }));
      lastUserMessage.dispatchEvent(new MouseEvent('mouseover', { 
        view: window,
        bubbles: true, 
        cancelable: true 
      }));
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // === 3. ZNAJDŹ PRZYCISK EDIT ===
      console.log('🔍 [tryEditResend] Szukam przycisku Edit...');
      
      let editButton = null;
      const editSelectors = [
        'button[aria-label="Edit message"]',
        'button[aria-label*="Edit"]',
        'button.right-full[aria-label*="Edit"]',
        'button[aria-label*="Edytuj"]',  // Polska lokalizacja
        'button[title*="Edit"]',
        'button[title*="edit"]'
      ];
      
      for (const selector of editSelectors) {
        editButton = lastUserMessage.querySelector(selector);
        if (editButton) {
          console.log(`✓ [tryEditResend] Znaleziono Edit przez: ${selector}`);
          break;
        }
      }
      
      // Fallback 1: conversation-turn container
      if (!editButton) {
        console.log('  Fallback 1: szukam w conversation-turn container...');
        const turnContainer = lastUserMessage.closest('[data-testid^="conversation-turn-"]');
        if (turnContainer) {
          for (const selector of editSelectors) {
            editButton = turnContainer.querySelector(selector);
            if (editButton) {
              console.log(`✓ [tryEditResend] Znaleziono Edit w turn container przez: ${selector}`);
              break;
            }
          }
        }
      }
      
      // Fallback 2: toolbar
      if (!editButton) {
        console.log('  Fallback 2: szukam w toolbar...');
        const toolbar = lastUserMessage.querySelector('[role="toolbar"]') ||
                       lastUserMessage.querySelector('[class*="toolbar"]');
        if (toolbar) {
          for (const selector of editSelectors) {
            editButton = toolbar.querySelector(selector);
            if (editButton) {
              console.log(`✓ [tryEditResend] Znaleziono Edit w toolbar przez: ${selector}`);
              break;
            }
          }
        }
      }
      
      if (!editButton) {
        console.warn('❌ [tryEditResend] Nie znaleziono przycisku Edit');
        return false;
      }
      
      // Usuń klasy ukrywające i wymuś widoczność
      if (editButton.classList.contains('invisible')) {
        editButton.classList.remove('invisible');
        console.log('  ✓ Usunięto klasę invisible');
      }
      if (editButton.classList.contains('hidden')) {
        editButton.classList.remove('hidden');
        console.log('  ✓ Usunięto klasę hidden');
      }
      
      const originalStyle = editButton.style.cssText;
      editButton.style.visibility = 'visible';
      editButton.style.display = 'block';
      
      console.log('👆 [tryEditResend] Klikam przycisk Edit...');
      editButton.click();
      
      setTimeout(() => {
        editButton.style.cssText = originalStyle;
      }, 100);
      
      // === 4. CZEKAJ NA EDYTOR I ZNAJDŹ SEND W KONTEKŚCIE ===
      console.log('⏳ [tryEditResend] Czekam na pojawienie się edytora po Edit...');
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Znajdź conversation turn container dla kontekstu
      const turnContainer = lastUserMessage.closest('[data-testid^="conversation-turn-"]') ||
                           lastUserMessage.closest('[class*="turn"]') ||
                           lastUserMessage.closest('article') ||
                           lastUserMessage.parentElement;
      
      console.log('🔍 [tryEditResend] Szukam przycisku Send w kontekście edytowanej wiadomości...');
      
      const sendSelectors = [
        '[data-testid="send-button"]',
        'button[aria-label="Send"]',
        'button[aria-label*="Send"]',
        'button[name="Send"]',
        'button[type="submit"]',
        '#composer-submit-button',
        'button[data-testid*="send"]'
      ];
      
      // Aktywne czekanie na Send button (max 10s)
      let sendButton = null;
      const maxWaitForSend = 10000;
      const checkInterval = 100;
      const maxIterations = maxWaitForSend / checkInterval;
      
      for (let iteration = 0; iteration < maxIterations; iteration++) {
        // Najpierw szukaj w turn container
        for (const selector of sendSelectors) {
          sendButton = turnContainer.querySelector(selector);
          if (sendButton && !sendButton.disabled) {
            console.log(`✓ [tryEditResend] Znaleziono Send w turn container po ${iteration * checkInterval}ms: ${selector}`);
            break;
          }
        }
        
        // Jeśli nie znaleziono, szukaj w całym dokumencie
        if (!sendButton) {
          for (const selector of sendSelectors) {
            sendButton = document.querySelector(selector);
            if (sendButton && !sendButton.disabled) {
              console.log(`✓ [tryEditResend] Znaleziono Send globalnie po ${iteration * checkInterval}ms: ${selector}`);
              break;
            }
          }
        }
        
        if (sendButton) break;
        
        if (iteration > 0 && iteration % 10 === 0) {
          console.log(`  ⏳ Czekam na Send... ${iteration * checkInterval}ms / ${maxWaitForSend}ms`);
        }
        
        await new Promise(resolve => setTimeout(resolve, checkInterval));
      }
      
      if (!sendButton) {
        console.warn('❌ [tryEditResend] Nie znaleziono przycisku Send po Edit');
        return false;
      }
      
      if (sendButton.disabled) {
        console.warn('⚠️ [tryEditResend] Przycisk Send jest disabled');
        return false;
      }
      
      console.log('👆 [tryEditResend] Klikam przycisk Send...');
      sendButton.click();
      
      // === 5. WERYFIKACJA WYSŁANIA ===
      console.log('🔍 [tryEditResend] Weryfikuję czy prompt został wysłany...');
      let verified = false;
      const maxVerifyTime = 3000;
      const verifyInterval = 100;
      const maxVerifyIterations = maxVerifyTime / verifyInterval;
      
      for (let iteration = 0; iteration < maxVerifyIterations; iteration++) {
        const editor = document.querySelector('[role="textbox"]') || 
                      document.querySelector('[contenteditable]');
        
        // Fallbacki dla stopButton
        const stopBtn = document.querySelector('button[aria-label*="Stop"]') || 
                       document.querySelector('[data-testid="stop-button"]') ||
                       document.querySelector('button[aria-label*="stop"]') ||
                       document.querySelector('button[aria-label="Zatrzymaj"]');
        
        const currentSendBtn = document.querySelector('[data-testid="send-button"]') ||
                              document.querySelector('button[aria-label="Send"]');
        
        const editorDisabled = editor && editor.getAttribute('contenteditable') === 'false';
        const editorEmpty = editor && (editor.textContent || '').trim().length === 0;
        const sendDisabled = currentSendBtn && currentSendBtn.disabled;
        
        // Weryfikacja DOM
        const messages = document.querySelectorAll('[data-message-author-role]');
        const hasMessages = messages.length > 0;
        
        // GŁÓWNY wskaźnik: stopButton (najbardziej pewny)
        const hasStopButton = !!stopBtn;
        
        // ALTERNATYWNY: interface zablokowany + wiadomości w DOM
        const interfaceBlocked = (editorDisabled || (editorEmpty && sendDisabled)) && hasMessages;
        
        if (hasStopButton || interfaceBlocked) {
          verified = true;
          console.log(`✅ [tryEditResend] Weryfikacja SUKCES po ${iteration * verifyInterval}ms:`, {
            stopBtn: !!stopBtn,
            editorDisabled,
            editorEmpty,
            sendDisabled,
            hasMessages,
            msgCount: messages.length
          });
          break;
        }
        
        if (iteration > 0 && iteration % 5 === 0) {
          console.log(`  ⏳ Weryfikacja... ${iteration * verifyInterval}ms / ${maxVerifyTime}ms`);
        }
        
        await new Promise(resolve => setTimeout(resolve, verifyInterval));
      }
      
      if (!verified) {
        console.warn(`⚠️ [tryEditResend] Weryfikacja FAILED - prompt może nie zostać wysłany po ${maxVerifyTime}ms`);
        return false;
      }
      
      console.log('✅ [tryEditResend] Edit+Resend wykonane pomyślnie i zweryfikowane');
      return true;
      
    } catch (error) {
      console.error('❌ [tryEditResend] Błąd:', error);
      return false;
    }
  }
  
  // Funkcja sprawdzająca czy ChatGPT generuje odpowiedź (rozszerzona detekcja)
  function isGenerating() {
    // 1. Stop button (klasyczne selektory)
    const stopButton = document.querySelector('button[aria-label*="Stop"]') || 
                       document.querySelector('[data-testid="stop-button"]') ||
                       document.querySelector('button[aria-label*="stop"]') ||
                       document.querySelector('button[aria-label="Zatrzymaj"]') ||
                       document.querySelector('button[aria-label*="Zatrzymaj"]');
    if (stopButton) {
      return { generating: true, reason: 'stopButton', element: stopButton };
    }
    
    // 2. Thinking indicators - TYLKO w ostatniej wiadomości assistant!
    // Znajdź ostatnią wiadomość assistant
    const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (assistantMessages.length > 0) {
      const lastAssistantMsg = assistantMessages[assistantMessages.length - 1];
      
      // Sprawdź thinking indicator TYLKO w ostatniej wiadomości
      const thinkingInLastMsg = lastAssistantMsg.querySelector('[class*="thinking"]') ||
                                lastAssistantMsg.querySelector('[class*="Thinking"]') ||
                                lastAssistantMsg.querySelector('[data-testid*="thinking"]') ||
                                lastAssistantMsg.querySelector('[aria-label*="Thinking"]') ||
                                lastAssistantMsg.querySelector('[aria-label*="thinking"]');
      if (thinkingInLastMsg) {
        return { generating: true, reason: 'thinkingIndicator', element: thinkingInLastMsg };
      }
    }
    
    // 3. Update indicators
    const updateIndicators = document.querySelector('[aria-label*="Update"]') ||
                            document.querySelector('[aria-label*="update"]') ||
                            document.querySelector('[class*="updating"]') ||
                            document.querySelector('[class*="Updating"]') ||
                            document.querySelector('[data-testid*="update"]');
    if (updateIndicators) {
      return { generating: true, reason: 'updateIndicator', element: updateIndicators };
    }
    
    // 4. Streaming indicators
    const streamingIndicators = document.querySelector('[class*="streaming"]') ||
                               document.querySelector('[class*="Streaming"]') ||
                               document.querySelector('[data-testid*="streaming"]') ||
                               document.querySelector('[aria-label*="Streaming"]');
    if (streamingIndicators) {
      return { generating: true, reason: 'streamingIndicator', element: streamingIndicators };
    }
    
    // 5. Typing/Loading indicators
    const typingIndicators = document.querySelector('[class*="typing"]') ||
                            document.querySelector('[class*="Typing"]') ||
                            document.querySelector('[class*="loading"]') ||
                            document.querySelector('[class*="Loading"]') ||
                            document.querySelector('[aria-label*="typing"]') ||
                            document.querySelector('[aria-label*="loading"]');
    if (typingIndicators) {
      return { generating: true, reason: 'typingIndicator', element: typingIndicators };
    }
    
    // 6. Editor disabled (fallback - mniej pewny)
    const editor = document.querySelector('[role="textbox"]') ||
                  document.querySelector('[contenteditable]');
    const editorDisabled = editor && editor.getAttribute('contenteditable') === 'false';
    if (editorDisabled) {
      return { generating: true, reason: 'editorDisabled', element: editor };
    }
    
    return { generating: false, reason: 'none', element: null };
  }
  
  // Funkcja czekająca na zakończenie odpowiedzi ChatGPT
  async function waitForResponse(maxWaitMs) {
    console.log("⏳ Czekam na odpowiedź ChatGPT...");
    
    // ===== FAZA 1: Detekcja STARTU odpowiedzi =====
    // Czekaj aż ChatGPT zacznie generować odpowiedź
    // Chain-of-thought model może myśleć 4-5 min przed startem
    const phase1StartTime = Date.now(); // ✅ OSOBNY timer dla FAZY 1
    let responseStarted = false;
    let editAttemptedPhase1 = false; // Flaga: czy już próbowaliśmy Edit w tej fazie
    const checkedFixedErrorsPhase1 = new Set(); // Cache dla już sprawdzonych i naprawionych błędów
    const startTimeout = Math.min(maxWaitMs, 7200000); // 120 minut na start (zwiększono dla długich deep thinking sessions)
    
    console.log(`📊 [FAZA 1] Timeout dla detekcji startu: ${Math.round(startTimeout/1000)}s (${Math.round(startTimeout/60000)} min)`);
    
    while (Date.now() - phase1StartTime < startTimeout) {
      // Sprawdź czy pojawił się komunikat błędu - TYLKO OSTATNI
      const errorMessages = document.querySelectorAll('[class*="text"]');
      
      // Znajdź ostatni komunikat błędu (od końca)
      let lastErrorMsg = null;
      let lastErrorIndex = -1;
      for (let i = errorMessages.length - 1; i >= 0; i--) {
        const msg = errorMessages[i];
        if (msg.textContent.includes('Something went wrong while generating the response') || 
            msg.textContent.includes('Something went wrong')) {
          lastErrorMsg = msg;
          lastErrorIndex = i;
          break; // Zatrzymaj się na pierwszym (ostatnim) znalezionym
        }
      }
      
      // Jeśli znaleziono błąd, sprawdź czy nie został już naprawiony
      if (lastErrorMsg) {
        // Unikalne ID błędu (pozycja + fragment tekstu)
        const errorId = `${lastErrorIndex}_${lastErrorMsg.textContent.substring(0, 50)}`;
        
        // Jeśli już sprawdzaliśmy ten błąd i był naprawiony - pomiń bez logowania
        if (checkedFixedErrorsPhase1.has(errorId)) {
          // Ciche pominięcie - nie spamuj logów
        } else {
          // Pierwszy raz widzimy ten błąd - sprawdź go
          console.log(`🔍 [FAZA 1] Znaleziono ostatni komunikat błędu (${lastErrorIndex + 1}/${errorMessages.length})`);
          
          // Znajdź kontener błędu w strukturze DOM
          const errorContainer = lastErrorMsg.closest('article') || 
                                lastErrorMsg.closest('[data-testid^="conversation-turn-"]') ||
                                lastErrorMsg.closest('[class*="message"]') ||
                                lastErrorMsg.parentElement;
          
          // Sprawdź czy po błędzie jest już nowa odpowiedź assistant
          const allMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
          let errorAlreadyFixed = false;
          
          if (errorContainer && allMessages.length > 0) {
            const lastAssistantMsg = allMessages[allMessages.length - 1];
            
            // Porównaj pozycję błędu z ostatnią odpowiedzią
            try {
              const errorPosition = errorContainer.compareDocumentPosition(lastAssistantMsg);
              
              // Jeśli ostatnia odpowiedź jest AFTER błędu (Node.DOCUMENT_POSITION_FOLLOWING = 4)
              if (errorPosition & Node.DOCUMENT_POSITION_FOLLOWING) {
                errorAlreadyFixed = true;
                console.log('✓ [FAZA 1] Błąd już naprawiony - jest nowa odpowiedź po nim, pomijam');
                // Dodaj do cache żeby nie sprawdzać ponownie
                checkedFixedErrorsPhase1.add(errorId);
              }
            } catch (e) {
              console.warn('⚠️ [FAZA 1] Nie udało się porównać pozycji błędu:', e);
            }
          }
          
          // Jeśli błąd został naprawiony, pomiń całą logikę Edit/Retry
          if (!errorAlreadyFixed) {
          // Jeśli już próbowaliśmy Edit - NIE próbuj ponownie
          if (editAttemptedPhase1) {
            console.log('⚠️ [FAZA 1] Błąd wykryty ale editAttempted=true - pomijam Edit, szukam Retry...');
          } else {
            console.log('⚠️ [FAZA 1] Znaleziono komunikat błędu - uruchamiam retry loop Edit+Resend...');
            editAttemptedPhase1 = true; // Oznacz że próbujemy
            
            // Retry loop: max 3 próby Edit+Resend
            let editSuccess = false;
            for (let attempt = 1; attempt <= 3 && !editSuccess; attempt++) {
              console.log(`🔧 [FAZA 1] Próba ${attempt}/3 wywołania tryEditResend()...`);
              editSuccess = await tryEditResend();
              console.log(`📊 [FAZA 1] Próba ${attempt}/3: ${editSuccess ? '✅ SUKCES' : '❌ PORAŻKA'}`);
              
              if (editSuccess) {
                console.log('✅ [FAZA 1] Edit+Resend SUKCES - przerywam retry loop');
                break;
              }
              
              if (!editSuccess && attempt < 3) {
                console.log(`⏳ [FAZA 1] Próba ${attempt} nieudana, czekam 2s przed kolejną...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
              }
            }
            
            if (editSuccess) {
              console.log('✅ [FAZA 1] Naprawiono przez Edit+Resend - kontynuuję czekanie...');
              await new Promise(resolve => setTimeout(resolve, 2000));
              continue; // Kontynuuj czekanie w tej samej pętli
            }
            
            console.log('⚠️ [FAZA 1] Wszystkie 3 próby Edit+Resend nieudane, próbuję Retry button...');
          }
          
          // Jeśli Edit nie zadziałał (lub już próbowaliśmy), spróbuj Retry
          console.log('🔍 [FAZA 1] Szukam przycisku Retry...');
          let retryButton = lastErrorMsg.parentElement?.querySelector('button[aria-label="Retry"]');
          if (!retryButton) {
            retryButton = lastErrorMsg.closest('[class*="group"]')?.querySelector('button[aria-label="Retry"]');
          }
          if (!retryButton) {
            // Szukaj w całym dokumencie jako fallback
            retryButton = document.querySelector('button[aria-label="Retry"]');
          }
          
          if (retryButton) {
            console.log('🔄 [FAZA 1] Klikam przycisk Retry - wznawiam czekanie na odpowiedź...');
            retryButton.click();
            await new Promise(resolve => setTimeout(resolve, 2000));
            // Zwróć false aby zewnętrzna pętla wywołała waitForResponse ponownie (jak Continue)
            return false;
          } else {
            console.warn('⚠️ [FAZA 1] Nie znaleziono przycisku Retry');
          }
          }
        }
      }
      
      // Użyj rozszerzonej funkcji wykrywania generowania
      const genStatus = isGenerating();
      
      // Weryfikacja: Czy faktycznie jest nowa aktywność w DOM?
      const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
      const hasNewContent = assistantMessages.length > 0;
      
      // ChatGPT zaczął odpowiadać jeśli:
      // 1. isGenerating() wykryło wskaźniki generowania (stop/thinking/update/streaming)
      // 2. LUB jest nowa treść w DOM (faktyczna odpowiedź)
      
      if (genStatus.generating || hasNewContent) {
        console.log("✓ ChatGPT zaczął odpowiadać", {
          generating: genStatus.generating,
          reason: genStatus.reason,
          hasNewContent: hasNewContent,
          assistantMsgCount: assistantMessages.length
        });
        responseStarted = true;
        break;
      }
      
      // Loguj co 30s że czekamy z rozszerzonym statusem
      if ((Date.now() - phase1StartTime) % 30000 < 500) {
        const elapsed = Math.round((Date.now() - phase1StartTime) / 1000);
        const currentGenStatus = isGenerating();
        console.log(`⏳ [FAZA 1] Czekam na start odpowiedzi... (${elapsed}s)`, {
          generating: currentGenStatus.generating,
          reason: currentGenStatus.reason,
          hasNewContent: assistantMessages.length > 0,
          assistantMsgCount: assistantMessages.length
        });
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    const phase1Duration = Math.round((Date.now() - phase1StartTime) / 1000);
    console.log(`📊 [FAZA 1] Zakończona po ${phase1Duration}s (${Math.round(phase1Duration/60)} min)`);
    
    if (!responseStarted) {
      console.error(`❌ [FAZA 1] ChatGPT nie zaczął odpowiadać po ${Math.round(startTimeout/1000)}s - prompt prawdopodobnie nie został wysłany!`);
      return false;
    }
    
    // ===== FAZA 2: Detekcja ZAKOŃCZENIA odpowiedzi =====
    // Czekaj aż ChatGPT skończy i interface będzie gotowy na kolejny prompt
    const phase2StartTime = Date.now(); // ✅ NOWY timer dla FAZY 2 (niezależny od FAZY 1!)
    const phase2Timeout = Math.min(maxWaitMs, 7200000); // 120 minut na zakończenie (zwiększono dla długich deep thinking sessions)
    let consecutiveReady = 0;
    let logInterval = 0;
    let editAttemptedPhase2 = false; // Flaga: czy już próbowaliśmy Edit w tej fazie
    const checkedFixedErrors = new Set(); // Cache dla już sprawdzonych i naprawionych błędów
    
    console.log(`📊 [FAZA 2] Timeout dla detekcji zakończenia: ${Math.round(phase2Timeout/1000)}s (${Math.round(phase2Timeout/60000)} min)`);
    
    while (Date.now() - phase2StartTime < phase2Timeout) {
      // Sprawdź czy pojawił się komunikat błędu - TYLKO OSTATNI
      const errorMessages = document.querySelectorAll('[class*="text"]');
      
      // Znajdź ostatni komunikat błędu (od końca)
      let lastErrorMsg = null;
      let lastErrorIndex = -1;
      for (let i = errorMessages.length - 1; i >= 0; i--) {
        const msg = errorMessages[i];
        if (msg.textContent.includes('Something went wrong while generating the response') || 
            msg.textContent.includes('Something went wrong')) {
          lastErrorMsg = msg;
          lastErrorIndex = i;
          break; // Zatrzymaj się na pierwszym (ostatnim) znalezionym
        }
      }
      
      // Jeśli znaleziono błąd, sprawdź czy nie został już naprawiony
      if (lastErrorMsg) {
        // Unikalne ID błędu (pozycja + fragment tekstu)
        const errorId = `${lastErrorIndex}_${lastErrorMsg.textContent.substring(0, 50)}`;
        
        // Jeśli już sprawdzaliśmy ten błąd i był naprawiony - pomiń bez logowania
        if (checkedFixedErrors.has(errorId)) {
          // Ciche pominięcie - nie spamuj logów
        } else {
          // Pierwszy raz widzimy ten błąd - sprawdź go
          console.log(`🔍 [FAZA 2] Znaleziono ostatni komunikat błędu (${lastErrorIndex + 1}/${errorMessages.length})`);
          
          // Znajdź kontener błędu w strukturze DOM
          const errorContainer = lastErrorMsg.closest('article') || 
                                lastErrorMsg.closest('[data-testid^="conversation-turn-"]') ||
                                lastErrorMsg.closest('[class*="message"]') ||
                                lastErrorMsg.parentElement;
          
          // Sprawdź czy po błędzie jest już nowa odpowiedź assistant
          const allMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
          let errorAlreadyFixed = false;
          
          if (errorContainer && allMessages.length > 0) {
            const lastAssistantMsg = allMessages[allMessages.length - 1];
            
            // Porównaj pozycję błędu z ostatnią odpowiedzią
            try {
              const errorPosition = errorContainer.compareDocumentPosition(lastAssistantMsg);
              
              // Jeśli ostatnia odpowiedź jest AFTER błędu (Node.DOCUMENT_POSITION_FOLLOWING = 4)
              if (errorPosition & Node.DOCUMENT_POSITION_FOLLOWING) {
                errorAlreadyFixed = true;
                console.log('✓ [FAZA 2] Błąd już naprawiony - jest nowa odpowiedź po nim, pomijam');
                // Dodaj do cache żeby nie sprawdzać ponownie
                checkedFixedErrors.add(errorId);
              }
            } catch (e) {
              console.warn('⚠️ [FAZA 2] Nie udało się porównać pozycji błędu:', e);
            }
          }
          
          // Jeśli błąd został naprawiony, pomiń całą logikę Edit/Retry
          if (!errorAlreadyFixed) {
          // Jeśli już próbowaliśmy Edit - NIE próbuj ponownie
          if (editAttemptedPhase2) {
            console.log('⚠️ [FAZA 2] Błąd wykryty ale editAttempted=true - pomijam Edit, szukam Retry...');
          } else {
            console.log('⚠️ [FAZA 2] Znaleziono komunikat błędu - uruchamiam retry loop Edit+Resend...');
            editAttemptedPhase2 = true; // Oznacz że próbujemy
            
            // Retry loop: max 3 próby Edit+Resend
            let editSuccess = false;
            for (let attempt = 1; attempt <= 3 && !editSuccess; attempt++) {
              console.log(`🔧 [FAZA 2] Próba ${attempt}/3 wywołania tryEditResend()...`);
              editSuccess = await tryEditResend();
              console.log(`📊 [FAZA 2] Próba ${attempt}/3: ${editSuccess ? '✅ SUKCES' : '❌ PORAŻKA'}`);
              
              if (editSuccess) {
                console.log('✅ [FAZA 2] Edit+Resend SUKCES - przerywam retry loop');
                break;
              }
              
              if (!editSuccess && attempt < 3) {
                console.log(`⏳ [FAZA 2] Próba ${attempt} nieudana, czekam 2s przed kolejną...`);
                await new Promise(resolve => setTimeout(resolve, 2000));
              }
            }
            
            if (editSuccess) {
              console.log('✅ [FAZA 2] Naprawiono przez Edit+Resend - kontynuuję czekanie...');
              await new Promise(resolve => setTimeout(resolve, 2000));
              continue; // Kontynuuj czekanie w tej samej pętli
            }
            
            console.log('⚠️ [FAZA 2] Wszystkie 3 próby Edit+Resend nieudane, próbuję Retry button...');
          }
          
          // Jeśli Edit nie zadziałał (lub już próbowaliśmy), spróbuj Retry
          console.log('🔍 [FAZA 2] Szukam przycisku Retry...');
          let retryButton = lastErrorMsg.parentElement?.querySelector('button[aria-label="Retry"]');
          if (!retryButton) {
            retryButton = lastErrorMsg.closest('[class*="group"]')?.querySelector('button[aria-label="Retry"]');
          }
          if (!retryButton) {
            // Szukaj w całym dokumencie jako fallback
            retryButton = document.querySelector('button[aria-label="Retry"]');
          }
          
          if (retryButton) {
            console.log('🔄 [FAZA 2] Klikam przycisk Retry - wznawiam czekanie na odpowiedź...');
            retryButton.click();
            await new Promise(resolve => setTimeout(resolve, 2000));
            // Zwróć false aby zewnętrzna pętla wywołała waitForResponse ponownie (jak Continue)
            return false;
          } else {
            console.warn('⚠️ [FAZA 2] Nie znaleziono przycisku Retry');
          }
          }
        }
      }
      
      // Szukaj wszystkich elementów interfejsu
      const editor = document.querySelector('[role="textbox"][contenteditable="true"]') ||
                     document.querySelector('div[contenteditable="true"]') ||
                     document.querySelector('[data-testid="composer-input"][contenteditable="true"]');
      
      const sendButton = document.querySelector('[data-testid="send-button"]') ||
                        document.querySelector('#composer-submit-button') ||
                        document.querySelector('button[aria-label="Send"]') ||
                        document.querySelector('button[aria-label*="Send"]');
      
      // Użyj rozszerzonej funkcji wykrywania generowania
      const genStatus = isGenerating();
      
      // Co 10 iteracji (5s) loguj stan
      if (logInterval % 10 === 0) {
        const phase2Elapsed = Math.round((Date.now() - phase2StartTime) / 1000);
        console.log(`🔍 [FAZA 2] Stan interfejsu:`, {
          editor_exists: !!editor,
          editor_enabled: editor?.getAttribute('contenteditable') === 'true',
          generating: genStatus.generating,
          genReason: genStatus.reason,
          sendButton_exists: !!sendButton,
          sendButton_disabled: sendButton?.disabled,
          consecutiveReady: consecutiveReady,
          elapsed: phase2Elapsed + 's'
        });
      }
      logInterval++;
      
      // ===== WARUNKI GOTOWOŚCI =====
      // Interface jest gotowy gdy ChatGPT skończył generować:
      // 1. BRAK wskaźników generowania (isGenerating() == false)
      // 2. Editor ISTNIEJE i jest ENABLED (contenteditable="true")
      // 3. BRAK wskaźników "thinking" w ostatniej wiadomości
      // 
      // UWAGA: SendButton może nie istnieć gdy editor jest pusty - sprawdzimy go dopiero w sendPrompt()
      
      const editorReady = editor && editor.getAttribute('contenteditable') === 'true';
      const noGeneration = !genStatus.generating;
      
      // Sprawdź czy nie ma wskaźników "thinking" w ostatniej wiadomości
      const lastMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
      const hasThinkingInMessage = lastMessages.length > 0 && 
        lastMessages[lastMessages.length - 1].querySelector('[class*="thinking"]');
      
      const isReady = noGeneration && editorReady && !hasThinkingInMessage;
      
      if (isReady) {
        consecutiveReady++;
        console.log(`✓ [FAZA 2] Interface ready (${consecutiveReady}/1) - warunki OK`);
        
        // Potwierdź stan przez 1 sprawdzenie (0.5s)
        // Zmniejszono z 3 do 1 dla szybszej reakcji (oszczędza 1s na każdy prompt)
        if (consecutiveReady >= 1) {
          console.log("✅ ChatGPT zakończył odpowiedź - interface gotowy");
          // Dodatkowe czekanie dla stabilizacji UI
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          // WERYFIKACJA: Sprawdź czy faktycznie jest jakaś odpowiedź w DOM (max 1 próba)
          console.log("🔍 Weryfikuję obecność odpowiedzi w DOM...");
          let domCheckAttempts = 0;
          const MAX_DOM_CHECKS = 1;
          
          while (domCheckAttempts < MAX_DOM_CHECKS) {
            const messages = document.querySelectorAll('[data-message-author-role="assistant"]');
            const articles = document.querySelectorAll('article');
            
            if (messages.length > 0 || articles.length > 0) {
              console.log(`✓ Znaleziono ${messages.length} wiadomości assistant i ${articles.length} articles`);
              return true;
            }
            
            domCheckAttempts++;
            console.warn(`⚠️ DOM check ${domCheckAttempts}/${MAX_DOM_CHECKS} - brak odpowiedzi, czekam 1s...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
          
          // Po 1 próbie (1s) - zakładamy że OK, walidacja później wyłapie błąd
          console.warn("⚠️ DOM nie gotowy po 1 próbie (1s), ale kontynuuję - walidacja tekstu wyłapie jeśli faktyczny błąd");
          return true;
        }
      } else {
        // Reset licznika jeśli którykolwiek warunek nie jest spełniony
        if (consecutiveReady > 0) {
          console.log(`⚠️ Interface NOT ready, resetuję licznik (był: ${consecutiveReady})`);
          console.log(`  Powód: noGeneration=${noGeneration}, editorReady=${editorReady}, hasThinkingInMessage=${hasThinkingInMessage}`);
          if (genStatus.generating) {
            console.log(`  Detekcja generowania: ${genStatus.reason}`);
          }
        }
        consecutiveReady = 0;
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    const phase2Duration = Math.round((Date.now() - phase2StartTime) / 1000);
    console.error(`❌ [FAZA 2] TIMEOUT czekania na zakończenie odpowiedzi po ${phase2Duration}s (${Math.round(phase2Duration/60)} min)`);
    console.error(`📊 Łączny czas (FAZA 1 + FAZA 2): ${phase1Duration + phase2Duration}s (${Math.round((phase1Duration + phase2Duration)/60)} min)`);
    return false;
  }

  // Funkcja sprawdzająca czy ChatGPT działa (brak błędów połączenia)
  async function checkChatGPTConnection() {
    console.log("🔍 Sprawdzam połączenie z ChatGPT...");
    
    try {
      // Sprawdź czy są błędy w konsoli (HTTP2, 404, itp.)
      const hasConnectionErrors = await checkForConnectionErrors();
      if (hasConnectionErrors) {
        return { healthy: false, error: "Wykryto błędy połączenia w konsoli" };
      }
      
      // Sprawdź czy interfejs ChatGPT jest responsywny
      const editor = document.querySelector('[role="textbox"]') || 
                   document.querySelector('[contenteditable]');
      if (!editor) {
        return { healthy: false, error: "Nie znaleziono edytora ChatGPT" };
      }
      
      // Sprawdź czy nie ma komunikatów o błędach na stronie
      // Używamy bardziej precyzyjnych selektorów dla rzeczywistych błędów ChatGPT
      const errorSelectors = [
        '[class*="error"]',
        '[class*="alert"]',
        '[role="alert"]',
        '.text-red-500',
        '.text-red-600'
      ];
      
      for (const selector of errorSelectors) {
        const errorElements = document.querySelectorAll(selector);
        for (const elem of errorElements) {
          const text = elem.textContent.toLowerCase();
          // Sprawdź tylko elementy zawierające znane frazy błędów
          if (text.includes('something went wrong') || 
              text.includes('connection error') ||
              text.includes('network error') ||
              text.includes('server error') ||
              text.includes('unable to load') ||
              text.includes('failed to')) {
            return { healthy: false, error: `Błąd na stronie: ${text.substring(0, 100)}` };
          }
        }
      }
      
      return { healthy: true, error: null };
      
    } catch (error) {
      console.warn("⚠️ Błąd podczas sprawdzania połączenia:", error);
      return { healthy: false, error: `Błąd sprawdzania: ${error.message}` };
    }
  }
  
  // Funkcja sprawdzająca błędy połączenia w konsoli
  async function checkForConnectionErrors() {
    // Sprawdź czy są aktywne błędy połączenia
    // (Ta funkcja może być rozszerzona o bardziej zaawansowaną detekcję)
    return false; // Na razie zwracamy false - można dodać bardziej zaawansowaną logikę
  }

  // Funkcja wyciągająca ostatnią odpowiedź ChatGPT z DOM
  async function getLastResponseText() {
    console.log("🔍 Wyciągam ostatnią odpowiedź ChatGPT...");
    
    // Funkcja pomocnicza - wyciąga tylko treść głównej odpowiedzi, pomija źródła/linki
    function extractMainContent(element) {
      // Klonuj element aby nie modyfikować oryginału
      const clone = element.cloneNode(true);
      
      // Usuń elementy które zawierają źródła/linki (zazwyczaj na końcu)
      const toRemove = [
        'ol[data-block-id]',  // Lista źródeł
        'div[class*="citation"]',  // Cytowania
        'div[class*="source"]',  // Źródła
        'a[target="_blank"]',  // Zewnętrzne linki
        'button',  // Przyciski
        '[role="button"]'  // Role przyciski
      ];
      
      toRemove.forEach(selector => {
        clone.querySelectorAll(selector).forEach(el => el.remove());
      });
      
      // Wyciągnij tekst - użyj innerText aby zachować formatowanie (nowe linie)
      const text = clone.innerText || clone.textContent || '';

      // Oczyść z nadmiarowych spacji, ale zachowaj formatowanie
      // POPRAWKA: Nie kolapsuj CAŁEJ spacji - tylko trim края linii
      return text
        .split('\n')
        .map(line => line.trim())  // Tylko trim краї - zachowuj wewnętrzne spacje
        .join('\n')
        .replace(/\n{3,}/g, '\n\n') // Max 2 puste linie z rzędu
        .trim();
    }
    
    // RETRY LOOP - React może asynchronicznie renderować treść
    // Nawet jeśli interface jest gotowy, treść może jeszcze być w trakcie renderowania
    // POPRAWKA: Zwiększono z 15 prób × 300ms (4.5s) do 20 prób × 500ms (10s)
    // Powód: ChatGPT React rendering może być wolny dla długich odpowiedzi
    const maxRetries = 20; // Zwiększono z 15 do 20
    const retryDelay = 500; // Zwiększono z 300ms do 500ms (total: 10s max)
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (attempt > 0) {
        console.log(`🔄 Retry ${attempt}/${maxRetries - 1} - czekam ${retryDelay}ms na renderowanie treści...`);
        await new Promise(r => setTimeout(r, retryDelay));
      }
      
      // Szukaj wszystkich odpowiedzi ChatGPT w konwersacji
      // POPRAWKA: Dodano diagnostykę selektorów dla lepszego debugowania
      const messages = document.querySelectorAll('[data-message-author-role="assistant"]');
      console.log(`🔍 Znaleziono ${messages.length} wiadomości assistant w DOM (selektor: [data-message-author-role="assistant"])`);

      // Diagnostyka: sprawdź inne możliwe selektory jeśli primary nie zadziałał
      if (messages.length === 0 && attempt === 0) {
        console.warn(`⚠️ Primary selector nie znalazł wiadomości - diagnostyka:`);
        const altSelectors = [
          '[role="presentation"]',
          '.agent-turn',
          '.markdown',
          '[data-testid*="conversation"]',
          'article',
          '[data-testid^="conversation-turn-"]',
          'div[class*="markdown"]',
          'div[class*="message"]'
        ];
        for (const sel of altSelectors) {
          const count = document.querySelectorAll(sel).length;
          console.log(`   ${sel}: ${count} elementów`);
        }
        
        // Dodatkowa diagnostyka - sprawdź czy w ogóle są jakieś wiadomości
        const allDivs = document.querySelectorAll('div');
        console.log(`   Wszystkie divy: ${allDivs.length}`);
        
        // Sprawdź czy są elementy z tekstem
        const textElements = Array.from(allDivs).filter(div => 
          div.textContent && div.textContent.trim().length > 10 && 
          !div.querySelector('[data-message-author-role]') // Nie licząc już znalezionych
        );
        console.log(`   Divy z tekstem (bez data-message-author-role): ${textElements.length}`);
        
        if (textElements.length > 0) {
          console.log(`   Przykłady tekstu:`, textElements.slice(0, 3).map(el => ({
            text: el.textContent.substring(0, 100),
            classes: el.className,
            id: el.id
          })));
        }
      }
      
      if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        
        // Sprawdź czy to nie jest tylko thinking indicator
        const thinkingIndicators = lastMessage.querySelectorAll('[class*="thinking"]');
        if (thinkingIndicators.length > 0) {
          console.warn("⚠️ Ostatnia wiadomość zawiera thinking indicator - ChatGPT jeszcze nie zaczął odpowiedzi");
          console.log(`   Thinking indicators: ${thinkingIndicators.length}`);
          // Kontynuuj retry - może treść się pojawi
          continue;
        }
        
        const text = extractMainContent(lastMessage);
        
        // Jeśli znaleziono niepustą odpowiedź - sukces!
        if (text.length > 0) {
          // Oblicz szczegółowe statystyki odpowiedzi
          const textSize = text.length;
          const textSizeKB = (textSize / 1024).toFixed(2);
          const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
          const lineCount = text.split('\n').length;
          const isLarge = textSize > 10000; // >10KB
          const isVeryLarge = textSize > 50000; // >50KB
          
          console.log(`✅ Znaleziono odpowiedź (attempt ${attempt + 1}/${maxRetries})`);
          console.log(`📊 Rozmiar odpowiedzi:`, {
            characters: textSize,
            sizeKB: textSizeKB,
            words: wordCount,
            lines: lineCount,
            isLarge: isLarge,
            isVeryLarge: isVeryLarge
          });
          
          console.log(`📝 Preview (pierwsze 200 znaków): "${text.substring(0, 200)}${text.length > 200 ? '...' : ''}"`);
          console.log(`📝 Preview (ostatnie 200 znaków): "...${text.substring(Math.max(0, text.length - 200))}"`);
          
          // Weryfikacja kompletności
          if (textSize < 50) {
            console.warn('⚠️ UWAGA: Odpowiedź bardzo krótka (<50 znaków) - może być niepełna lub błędna');
          }
          if (textSize < 10) {
            console.warn('❌ KRYTYCZNE: Odpowiedź ekstremalnie krótka (<10 znaków) - prawdopodobnie błąd');
          }
          
          return text;
        }
        
        // Jeśli pusta - loguj i kontynuuj retry (chyba że ostatnia próba)
        if (attempt < maxRetries - 1) {
          console.warn(`⚠️ Wyekstrahowany tekst ma długość 0 (attempt ${attempt + 1}/${maxRetries}) - retry...`);
        } else {
          // Ostatnia próba - pełne logowanie
          console.warn("⚠️ Wyekstrahowany tekst ma długość 0 po wszystkich próbach!");
          console.log("   HTML preview:", lastMessage.innerHTML.substring(0, 300));
          console.log("   textContent:", lastMessage.textContent.substring(0, 300));
          console.log("   Liczba children:", lastMessage.children.length);
          console.log("   Klasy:", lastMessage.className);
        }
      } else if (attempt === maxRetries - 1) {
        // Ostatnia próba i nadal brak wiadomości - pełne logowanie
        console.warn(`⚠️ Brak wiadomości assistant w DOM po ${maxRetries} próbach`);
      }
    }
    
    // Fallback 2: szukaj przez conversation-turn containers (z retry)
    console.log("🔍 Fallback 2: Szukam przez conversation-turn containers...");
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        console.log(`🔄 Fallback 2 retry ${attempt}/4 - czekam 300ms...`);
        await new Promise(r => setTimeout(r, 300));
      }
      
      const turnContainers = document.querySelectorAll('[data-testid^="conversation-turn-"]');
      console.log(`🔍 Znaleziono ${turnContainers.length} conversation turns w DOM (fallback 2)`);
      
      if (turnContainers.length > 0) {
        // Szukaj ostatniego turnu z assistant
        for (let i = turnContainers.length - 1; i >= 0; i--) {
          const turn = turnContainers[i];
          const assistantMsg = turn.querySelector('[data-message-author-role="assistant"]');
          if (assistantMsg) {
            const text = extractMainContent(assistantMsg);
            if (text.length > 0) {
              console.log(`✅ Znaleziono odpowiedź przez conversation-turn (fallback 2): ${text.length} znaków`);
              console.log(`📝 Preview: "${text.substring(0, 200)}${text.length > 200 ? '...' : ''}"`);
              return text;
            }
          }
        }
        
        // Jeśli nie znaleziono przez data-message-author-role, spróbuj znaleźć ostatni turn z tekstem
        console.log("🔍 Fallback 2b: Szukam ostatniego turnu z tekstem...");
        for (let i = turnContainers.length - 1; i >= 0; i--) {
          const turn = turnContainers[i];
          const text = extractMainContent(turn);
          if (text.length > 50) { // Minimum 50 znaków
            console.log(`✅ Znaleziono odpowiedź przez conversation-turn (fallback 2b): ${text.length} znaków`);
            console.log(`📝 Preview: "${text.substring(0, 200)}${text.length > 200 ? '...' : ''}"`);
            return text;
          }
        }
      }
    }
    
    // Fallback 3: szukaj artykułów z odpowiedziami (z retry)
    console.log("🔍 Fallback 3: Szukam przez article tags...");
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        console.log(`🔄 Fallback 3 retry ${attempt}/4 - czekam 300ms...`);
        await new Promise(r => setTimeout(r, 300));
      }
      
      const articles = document.querySelectorAll('article');
      console.log(`🔍 Znaleziono ${articles.length} articles w DOM (fallback 3)`);
      
      if (articles.length > 0) {
        const lastArticle = articles[articles.length - 1];
        const text = extractMainContent(lastArticle);
        if (text.length > 0) {
          console.log(`✅ Znaleziono odpowiedź przez article (fallback 3): ${text.length} znaków`);
          console.log(`📝 Preview: "${text.substring(0, 200)}${text.length > 200 ? '...' : ''}"`);
          return text;
        }
      }
    }
    
    // Fallback 4: szukaj po klasach markdown (z retry)
    console.log("🔍 Fallback 4: Szukam przez klasy markdown...");
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        console.log(`🔄 Fallback 4 retry ${attempt}/4 - czekam 300ms...`);
        await new Promise(r => setTimeout(r, 300));
      }
      
      const markdownSelectors = [
        'div[class*="markdown"]',
        'div[class*="message"]',
        'div[class*="content"]',
        'div[class*="response"]'
      ];
      
      for (const selector of markdownSelectors) {
        const elements = document.querySelectorAll(selector);
        console.log(`🔍 Znaleziono ${elements.length} elementów (${selector})`);
        
        if (elements.length > 0) {
          // Weź ostatni element
          const lastElement = elements[elements.length - 1];
          const text = extractMainContent(lastElement);
          if (text.length > 50) { // Minimum 50 znaków
            console.log(`✅ Znaleziono odpowiedź przez ${selector} (fallback 4): ${text.length} znaków`);
            console.log(`📝 Preview: "${text.substring(0, 200)}${text.length > 200 ? '...' : ''}"`);
            return text;
          }
        }
      }
    }
    
    console.error("❌ Nie znaleziono odpowiedzi ChatGPT w DOM po wszystkich próbach");
    console.log("   Wszystkie selektory (z retry) zwróciły puste wyniki");
    return '';
  }
  
  // Funkcja walidująca odpowiedź
  // POPRAWKA: Zwiększono minimalną długość z 10 do 50 znaków i dodano sprawdzanie błędów
  function validateResponse(text) {
    const minLength = 50; // Zwiększono z 10 do 50

    // Podstawowa walidacja długości
    if (text.length < minLength) {
      console.log(`📊 Walidacja: ❌ ZA KRÓTKA (${text.length} < ${minLength} znaków)`);
      return false;
    }

    // Sprawdź czy odpowiedź nie zawiera typowych wzorców błędów
    const errorPatterns = [
      /I apologize.*error/i,
      /something went wrong/i,
      /please try again/i,
      /I cannot.*at the moment/i,
      /unable to.*right now/i
    ];

    for (const pattern of errorPatterns) {
      if (pattern.test(text.substring(0, 200))) {
        console.warn(`📊 Walidacja: ⚠️ Wykryto wzorzec błędu: ${pattern}`);
        console.warn(`   Początek tekstu: "${text.substring(0, 100)}..."`);
        // Nie odrzucaj całkowicie - może to być częściowa odpowiedź
        // Tylko zaloguj ostrzeżenie
      }
    }

    console.log(`📊 Walidacja: ✅ OK (${text.length} >= ${minLength} znaków)`);
    return true;
  }
  
  // Funkcja czekająca aż interface ChatGPT będzie gotowy do wysłania kolejnego prompta
  async function waitForInterfaceReady(maxWaitMs, counter = null, promptIndex = 0, promptTotal = 0) {
    const startTime = Date.now();
    let consecutiveReady = 0;
    
    console.log("⏳ Czekam aż interface będzie gotowy...");
    
    // POPRAWKA: Sprawdź czy to jest nowa konwersacja (brak wiadomości)
    const userMessages = document.querySelectorAll('[data-message-author-role="user"]');
    const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
    const isNewConversation = userMessages.length === 0 && assistantMessages.length === 0;
    
    if (isNewConversation) {
      console.log("✅ Nowa konwersacja - pomijam czekanie na gotowość (nie powinno być generowania)");
      // Sprawdź tylko czy editor istnieje i jest enabled
      const editor = document.querySelector('[role="textbox"][contenteditable="true"]') ||
                     document.querySelector('div[contenteditable="true"]');
      if (editor) {
        console.log("✅ Editor gotowy - kontynuuję natychmiast");
        return true;
      } else {
        console.log("⏳ Editor nie istnieje - czekam max 5s...");
        maxWaitMs = 5000; // Krótki timeout tylko na pojawienie się editora
      }
    } else {
      console.log(`📊 Kontynuacja konwersacji (${userMessages.length} user, ${assistantMessages.length} assistant) - pełny timeout`);
    }
    
    // POPRAWKA: Sprawdź czy karta jest aktywna (rozwiązuje problem z wyciszonymi kartami)
    if (document.hidden || document.visibilityState === 'hidden') {
      console.warn("⚠️ Karta jest nieaktywna - próbuję aktywować...");
      try {
        chrome.runtime.sendMessage({ type: 'ACTIVATE_TAB' });
        // Czekaj chwilę na aktywację
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.warn("⚠️ Nie udało się aktywować karty:", error);
      }
    }
    
    // Mapowanie powodów na przyjazne opisy po polsku
    const reasonDescriptions = {
      'stopButton': 'generuje odpowiedź',
      'thinkingIndicator': 'myśli (chain-of-thought)',
      'updateIndicator': 'aktualizuje odpowiedź',
      'streamingIndicator': 'streamuje odpowiedź',
      'typingIndicator': 'pisze odpowiedź',
      'editorDisabled': 'interface zablokowany',
      'none': 'gotowy'
    };
    
    while (Date.now() - startTime < maxWaitMs) {
      // Sprawdź wszystkie elementy interfejsu
      const editor = document.querySelector('[role="textbox"][contenteditable="true"]') ||
                     document.querySelector('div[contenteditable="true"]');
      
      // POPRAWKA: Użyj isGenerating() zamiast tylko sprawdzania stopButton
      const genStatus = isGenerating();
      
      // Interface jest gotowy gdy:
      // 1. BRAK wskaźników generowania (isGenerating() == false)
      // 2. Editor ISTNIEJE i jest ENABLED
      const editorReady = editor && editor.getAttribute('contenteditable') === 'true';
      const noGeneration = !genStatus.generating;
      const isReady = noGeneration && editorReady;
      
      if (isReady) {
        consecutiveReady++;
        if (consecutiveReady >= 2) { // Potwierdź przez 2 sprawdzenia (1s)
          console.log("✅ Interface gotowy");
          await new Promise(resolve => setTimeout(resolve, 500)); // Krótka stabilizacja
          return true;
        }
      } else {
        // Resetowanie licznika - loguj powód
        if (consecutiveReady > 0) {
          const reason = reasonDescriptions[genStatus.reason] || genStatus.reason;
          console.log(`🔄 Interface nie gotowy - reset licznika. Powód: ${reason}`);
        }
        consecutiveReady = 0;
        
        // Aktualizuj licznik wizualny z powodem czekania
        if (counter) {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          const reason = reasonDescriptions[genStatus.reason] || genStatus.reason;
          const statusText = `⏳ Czekam na gotowość... (${elapsed}s)\nChatGPT: ${reason}`;
          updateCounter(counter, promptIndex, promptTotal, statusText);
        }
      }
      
      // Loguj szczegółowy status co 5s
      if ((Date.now() - startTime) % 5000 < 500) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        const reason = reasonDescriptions[genStatus.reason] || genStatus.reason;
        console.log(`⏳ Interface nie gotowy (${elapsed}s)`, {
          generating: genStatus.generating,
          reason: genStatus.reason,
          reasonDesc: reason,
          editorReady: editorReady,
          consecutiveReady: consecutiveReady
        });
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.error(`❌ Timeout czekania na gotowość interfejsu (${maxWaitMs}ms)`);
    return false;
  }
  
  // Funkcja pokazująca przyciski "Kontynuuj" i czekająca na kliknięcie
  // Zwraca: 'wait' - czekaj na odpowiedź, 'skip' - pomiń i wyślij następny prompt
  function showContinueButton(counter, currentPrompt, totalPrompts) {
    return new Promise((resolve) => {
      console.log(`⏸️ Pokazuję przyciski Kontynuuj dla prompta ${currentPrompt}/${totalPrompts}`);
      
      counter.innerHTML = `
        <div style="font-size: 16px; margin-bottom: 8px;">⚠️ Zatrzymano</div>
        <div style="font-size: 14px; margin-bottom: 12px;">Prompt ${currentPrompt} / ${totalPrompts}</div>
        <div style="font-size: 12px; opacity: 0.9; margin-bottom: 12px; line-height: 1.4;">
          Odpowiedź niepoprawna lub timeout.<br>
          Napraw sytuację w ChatGPT, potem wybierz:
        </div>
        <button id="continue-wait-btn" style="
          background: white;
          color: #667eea;
          border: none;
          padding: 10px 20px;
          border-radius: 8px;
          font-weight: 600;
          cursor: pointer;
          font-size: 14px;
          width: 100%;
          margin-bottom: 8px;
          transition: transform 0.2s;
        ">⏳ Czekaj na odpowiedź</button>
        <button id="continue-skip-btn" style="
          background: rgba(255,255,255,0.3);
          color: white;
          border: 1px solid white;
          padding: 10px 20px;
          border-radius: 8px;
          font-weight: 600;
          cursor: pointer;
          font-size: 14px;
          width: 100%;
          transition: transform 0.2s;
        ">⏭️ Wyślij następny prompt</button>
      `;
      
      const waitBtn = document.getElementById('continue-wait-btn');
      const skipBtn = document.getElementById('continue-skip-btn');
      
      // Event listeners dla waitBtn
      waitBtn.addEventListener('mouseover', () => {
        waitBtn.style.transform = 'scale(1.05)';
      });
      
      waitBtn.addEventListener('mouseout', () => {
        waitBtn.style.transform = 'scale(1)';
      });
      
      waitBtn.addEventListener('click', () => {
        console.log('✅ Użytkownik kliknął "Czekaj na odpowiedź" - wznawianie czekania...');
        resolve('wait');
      });
      
      // Event listeners dla skipBtn
      skipBtn.addEventListener('mouseover', () => {
        skipBtn.style.transform = 'scale(1.05)';
      });
      
      skipBtn.addEventListener('mouseout', () => {
        skipBtn.style.transform = 'scale(1)';
      });
      
      skipBtn.addEventListener('click', () => {
        console.log('✅ Użytkownik kliknął "Wyślij następny prompt" - pomijam czekanie i idę dalej...');
        resolve('skip');
      });
    });
  }

  // Funkcja wysyłania pojedynczego prompta
  async function sendPrompt(promptText, maxWaitForReady = responseWaitMs, counter = null, promptIndex = 0, promptTotal = 0) {
    // KROK 0: POPRAWKA - Aktywuj kartę przed wysyłaniem (rozwiązuje problem z wyciszonymi kartami)
    const maxRetries = 3;
    let retryCount = 0;
    
    while (retryCount < maxRetries) {
      try {
        console.log(`🔍 Aktywuję kartę ChatGPT przed wysyłaniem (próba ${retryCount + 1}/${maxRetries})...`);
        
        // Sprawdź czy karta jest aktywna - ale nie blokuj jeśli executeScript działa
        if (document.hidden || document.visibilityState === 'hidden') {
          console.warn("⚠️ Karta może być nieaktywna - ale kontynuuję (executeScript działa)");
          // Nie blokuj - executeScript już działa w kontekście aktywnej karty
        }
        
        console.log("✅ Karta jest aktywna - kontynuuję wysyłanie");
        break;
        
      } catch (error) {
        console.warn("⚠️ Błąd aktywacji karty:", error);
        retryCount++;
        if (retryCount < maxRetries) {
          console.warn(`⚠️ Próba ${retryCount + 1}/${maxRetries} za 2 sekundy...`);
          await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
          console.error("❌ Nie udało się aktywować karty po wszystkich próbach");
          return false;
        }
      }
    }
    
    // KROK 1: Czekaj aż interface będzie gotowy (jeśli poprzednia odpowiedź się jeszcze generuje)
    console.log("🔍 Sprawdzam gotowość interfejsu przed wysłaniem...");
    const interfaceReady = await waitForInterfaceReady(maxWaitForReady, counter, promptIndex, promptTotal); // Pełny timeout (domyślnie 60 minut)
    
    if (!interfaceReady) {
      console.error(`❌ Interface nie stał się gotowy po ${Math.round(maxWaitForReady/1000)}s`);
      return false;
    }
    
    console.log("✅ Interface gotowy - sprawdzam połączenie z ChatGPT");
    
    // KROK 1.5: Sprawdź czy ChatGPT działa (brak błędów połączenia)
    const connectionCheck = await checkChatGPTConnection();
    if (!connectionCheck.healthy) {
      console.error(`❌ ChatGPT nie działa: ${connectionCheck.error}`);
      return false;
    }
    console.log("✅ Połączenie z ChatGPT OK - wysyłam prompt");
    
    // KROK 2: Szukaj edytora
    console.log("🔍 Szukam edytora contenteditable...");
    
    // ChatGPT używa contenteditable div, NIE textarea!
    let editor = null;
    const maxWait = 15000; // Zwiększono z 10s na 15s
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWait) {
      editor = document.querySelector('textarea#prompt-textarea') ||
               document.querySelector('[role="textbox"][contenteditable="true"]') ||
               document.querySelector('div[contenteditable="true"]') ||
               document.querySelector('[data-testid="composer-input"]') ||
               document.querySelector('[contenteditable]');
      if (editor) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    if (!editor) {
      console.error("❌ Nie znaleziono edytora contenteditable po " + maxWait + "ms");
      return false;
    }
    
    console.log("✓ Znaleziono edytor");
    
    // Focus i wyczyść - ulepszona wersja
    editor.focus();
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Wyczyść zawartość - najpierw spróbuj nowoczesnym API
    try {
      // Metoda 1: Selection API (najbardziej niezawodna)
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection.removeAllRanges();
      selection.addRange(range);
      
      // Usuń przez KeyboardEvent (symuluje naturalne usuwanie)
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', bubbles: true }));
      document.execCommand('delete', false, null);
      
    } catch (e) {
      console.warn("⚠️ Fallback czyszczenia:", e);
    }
    
    // Wymuś czyszczenie przez innerHTML i textContent
    editor.innerHTML = '';
    editor.textContent = '';
    
    // Triggeruj event czyszczenia
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
    
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Wstaw tekst - ulepszona wersja z zachowaniem formatowania
    // Użyj innerHTML zamiast createTextNode aby zachować HTML i nowe linie
    editor.innerHTML = promptText.replace(/\n/g, '<br>');
    
    // Przesuń kursor na koniec
    try {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (e) {
      console.warn("⚠️ Nie udało się przesunąć kursora:", e);
    }
    
    // Triggeruj więcej eventów dla pewności
    editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText' }));
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
    
    console.log(`✓ Tekst wstawiony (${promptText.length} znaków): "${promptText.substring(0, 50)}..."`);
    
    // Czekaj aż przycisk Send będzie enabled - zwiększony timeout
    let submitButton = null;
    let waitTime = 0;
    const maxButtonWait = 10000; // Zwiększono z 3s na 10s
    
    while (waitTime < maxButtonWait) {
      submitButton = document.querySelector('[data-testid="send-button"]') ||
                     document.querySelector('#composer-submit-button') ||
                     document.querySelector('button[aria-label="Send"]') ||
                     document.querySelector('button[aria-label*="Send"]') ||
                     document.querySelector('button[data-testid*="send"]');
      
      if (submitButton && !submitButton.disabled) {
        console.log(`✅ Przycisk Send gotowy (${waitTime}ms)`);
        break;
      }
      
      // Loguj co 2s
      if (waitTime > 0 && waitTime % 2000 === 0) {
        console.log(`⏳ Czekam na przycisk Send... (${waitTime}ms / ${maxButtonWait}ms)`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
      waitTime += 100;
    }
    
    if (!submitButton) {
      console.error("❌ Nie znaleziono przycisku Send po " + maxButtonWait + "ms");
      return false;
    }
    
    if (submitButton.disabled) {
      console.error("❌ Przycisk Send jest disabled po " + maxButtonWait + "ms");
      return false;
    }
    
    // Poczekaj dłużej przed kliknięciem - daj czas na stabilizację UI
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log("✓ Klikam Send...");
    submitButton.click();
    
    // WERYFIKACJA: Sprawdź czy kliknięcie zadziałało
    console.log("🔍 Weryfikuję czy prompt został wysłany...");
    let verified = false;
    let verifyTime = 0;
    const maxVerifyWait = 10000; // Zwiększono z 5s do 10s na weryfikację
    
    while (verifyTime < maxVerifyWait) {
      // Po wysłaniu prompta ChatGPT powinien:
      // 1. Pokazać stopButton (zacząć generować) - NAJBARDZIEJ PEWNY wskaźnik
      // 2. LUB wyczyścić/disabled editor + disabled sendButton + nowa wiadomość w DOM
      
      const editorNow = document.querySelector('[role="textbox"]') ||
                        document.querySelector('[contenteditable]');
      
      // Fallbacki dla stopButton z dokumentacji
      const stopBtn = document.querySelector('button[aria-label*="Stop"]') || 
                      document.querySelector('[data-testid="stop-button"]') ||
                      document.querySelector('button[aria-label*="stop"]') ||
                      document.querySelector('button[aria-label="Zatrzymaj"]') ||
                      document.querySelector('button[aria-label*="Zatrzymaj"]');
      
      const sendBtn = document.querySelector('[data-testid="send-button"]') ||
                      document.querySelector('#composer-submit-button') ||
                      document.querySelector('button[aria-label="Send"]') ||
                      document.querySelector('button[aria-label*="Send"]');
      
      const editorDisabled = editorNow && editorNow.getAttribute('contenteditable') === 'false';
      const editorEmpty = editorNow && (editorNow.textContent || '').trim().length === 0;
      const sendDisabled = sendBtn && sendBtn.disabled;
      
      // Weryfikacja: czy jest nowa aktywność w DOM?
      const userMessages = document.querySelectorAll('[data-message-author-role="user"]');
      const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
      const hasMessages = userMessages.length > 0 || assistantMessages.length > 0;
      
      // GŁÓWNY wskaźnik: stopButton (najbardziej pewny)
      const hasStopButton = !!stopBtn;
      
      // ALTERNATYWNY wskaźnik: interface zablokowany + są jakieś wiadomości w DOM
      const interfaceBlocked = (editorDisabled || (editorEmpty && sendDisabled)) && hasMessages;
      
      // NOWY wskaźnik: sprawdź czy nasza wiadomość pojawiła się w DOM
      let messageInDOM = false;
      if (userMessages.length > 0) {
        const lastUserMessage = userMessages[userMessages.length - 1];
        const messageText = lastUserMessage.textContent || lastUserMessage.innerText || '';
        // Sprawdź czy ostatnia wiadomość użytkownika zawiera fragment naszego prompta
        const promptFragment = promptText.substring(0, 50);
        if (messageText.includes(promptFragment)) {
          messageInDOM = true;
          console.log(`✅ Znaleziono naszą wiadomość w DOM (${messageText.length} znaków)`);
        }
      }
      
      // Jeśli którykolwiek z PEWNYCH wskaźników potwierdza wysłanie:
      if (hasStopButton || interfaceBlocked || messageInDOM) {
        console.log(`✅ Prompt faktycznie wysłany (${verifyTime}ms)`, {
          stopBtn: !!stopBtn,
          editorDisabled,
          editorEmpty,
          sendDisabled,
          userMsgCount: userMessages.length,
          assistantMsgCount: assistantMessages.length,
          messageInDOM
        });
        verified = true;
        break;
      }
      
      await new Promise(resolve => setTimeout(resolve, 100));
      verifyTime += 100;
    }
    
    if (!verified) {
      console.error(`❌ Kliknięcie Send nie zadziałało - prompt NIE został wysłany po ${maxVerifyWait}ms`);
      return false;
    }
    
    return true;
  }

  // Główna logika
  const startTime = Date.now();
  
  // Retry loop - czekaj na editor (contenteditable div, nie textarea!)
  while (Date.now() - startTime < textareaWaitMs) {
    const editor = document.querySelector('[role="textbox"]') ||
                   document.querySelector('[contenteditable]') ||
                   document.querySelector('[data-testid="composer-input"]');
    
    if (editor) {
      console.log("=== ROZPOCZYNAM PRZETWARZANIE ===");
      
      // POPRAWKA: Sprawdź czy to resume (payload jest pusty lub zawiera marker)
      const isResume = !payload || payload.trim() === '' || payload.includes('Resume from stage');
      
      if (isResume) {
        console.log("🔄 TRYB RESUME - pomijam wysyłanie payload, zaczynam od prompt chain");
      } else {
        console.log(`Artykuł: ${payload.substring(0, 100)}...`);
      }
      
      // Stwórz licznik
      const counter = createCounter();
      
      if (!isResume) {
        // Normalny tryb - wyślij payload (artykuł)
        updateCounter(counter, 0, promptChain ? promptChain.length : 0, 'Wysyłam artykuł...');
        
        // Wyślij tekst Economist
        console.log("📤 Wysyłam artykuł do ChatGPT...");
        await sendPrompt(payload, responseWaitMs, counter, 0, promptChain ? promptChain.length : 0);
        
        // Czekaj na odpowiedź ChatGPT
        updateCounter(counter, 0, promptChain ? promptChain.length : 0, 'Czekam na odpowiedź...');
        await waitForResponse(responseWaitMs);
        console.log("✅ Artykuł przetworzony");
        
        // NIE zapisujemy początkowej odpowiedzi - zapisujemy tylko ostatnią z prompt chain
        
        // Anti-automation delay przed prompt chain - czekanie na gotowość jest w sendPrompt
        const delay = getRandomDelay();
        console.log(`⏸️ Anti-automation delay: ${(delay/1000).toFixed(1)}s przed rozpoczęciem prompt chain...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        // Resume mode - zacznij od razu od prompt chain
        updateCounter(counter, 0, promptChain ? promptChain.length : 0, '🔄 Resume from stage...');
        console.log("⏭️ Pomijam payload - zaczynam od prompt chain");
        
        // NOWE: Dodatkowe czekanie na gotowość interfejsu w trybie resume
        console.log("🔍 Sprawdzam gotowość interfejsu przed rozpoczęciem resume chain...");
        updateCounter(counter, 0, promptChain ? promptChain.length : 0, '⏳ Sprawdzam gotowość...');
        
        const resumeInterfaceReady = await waitForInterfaceReady(responseWaitMs, counter, 0, promptChain ? promptChain.length : 0);
        
        if (!resumeInterfaceReady) {
          console.error("❌ Interface nie jest gotowy w trybie resume - przerywam");
          updateCounter(counter, 0, promptChain ? promptChain.length : 0, '❌ Interface nie gotowy');
          await new Promise(resolve => setTimeout(resolve, 5000));
          return { success: false, lastResponse: '', error: 'Interface nie gotowy w trybie resume' };
        }
        
        console.log("✅ Interface gotowy - rozpoczynam resume chain");
        updateCounter(counter, 0, promptChain ? promptChain.length : 0, '🔄 Rozpoczynam chain...');
        await new Promise(resolve => setTimeout(resolve, 1000)); // Krótka stabilizacja
      }
      
      // Teraz uruchom prompt chain
      if (promptChain && promptChain.length > 0) {
        console.log(`\n=== PROMPT CHAIN: ${promptChain.length} promptów do wykonania ===`);
        console.log(`Pełna lista promptów:`, promptChain);
        
        for (let i = 0; i < promptChain.length; i++) {
          const prompt = promptChain[i];
          const remaining = promptChain.length - i - 1;
          
          console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
          console.log(`>>> PROMPT ${i + 1}/${promptChain.length} (pozostało: ${remaining})`);
          console.log(`Długość: ${prompt.length} znaków, ${prompt.split('\n').length} linii`);
          console.log(`Preview:\n${prompt.substring(0, 200)}${prompt.length > 200 ? '...' : ''}`);
          console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
          
          // Aktualizuj licznik - wysyłanie
          updateCounter(counter, i + 1, promptChain.length, 'Wysyłam prompt...');
          
          // Wyślij prompt
          console.log(`[${i + 1}/${promptChain.length}] Wywołuję sendPrompt()...`);
          const sent = await sendPrompt(prompt, responseWaitMs, counter, i + 1, promptChain.length);
          
          if (!sent) {
            console.error(`❌ Nie udało się wysłać prompta ${i + 1}/${promptChain.length}`);
            console.log(`⏸️ Błąd wysyłania - czekam na interwencję użytkownika`);
            updateCounter(counter, i + 1, promptChain.length, `❌ Błąd wysyłania`);
            
            // Pokaż przyciski i czekaj na user - może naprawić sytuację lub pominąć
            const action = await showContinueButton(counter, i + 1, promptChain.length);
            
            if (action === 'skip') {
              console.log(`⏭️ User wybrał pominięcie - przechodzę do następnego prompta`);
              continue; // Pomiń resztę tego prompta, idź do następnego
            }
            
            // User naprawił, spróbuj wysłać ponownie ten sam prompt
            console.log(`🔄 Kontynuacja po naprawie - ponowne wysyłanie prompta ${i + 1}...`);
            const retried = await sendPrompt(prompt, responseWaitMs, counter, i + 1, promptChain.length);
            
            if (!retried) {
              console.error(`❌ Ponowna próba nieudana - przerywam chain`);
              updateCounter(counter, i + 1, promptChain.length, `❌ Błąd krytyczny`);
              await new Promise(resolve => setTimeout(resolve, 10000));
              // WAŻNE: Musimy zwrócić obiekt, nie undefined!
              return { success: false, lastResponse: '', error: 'Nie udało się wysłać prompta po retry' };
            }
            
            console.log(`✅ Ponowne wysyłanie udane - kontynuuję chain`);
          }
          
          // Aktualizuj licznik - czekanie
          updateCounter(counter, i + 1, promptChain.length, 'Czekam na odpowiedź...');
          
          // Pętla czekania na odpowiedź - powtarzaj aż się uda
          let responseCompleted = false;
          while (!responseCompleted) {
            console.log(`[${i + 1}/${promptChain.length}] Wywołuję waitForResponse()...`);
            const completed = await waitForResponse(responseWaitMs);
            
            if (!completed) {
              // Timeout - pokaż przyciski i czekaj na user
              console.error(`❌ Timeout przy promptcie ${i + 1}/${promptChain.length}`);
              console.log(`⏸️ ChatGPT nie odpowiedział w czasie - czekam na interwencję użytkownika`);
              updateCounter(counter, i + 1, promptChain.length, '⏱️ Timeout - czekam...');
              
              const action = await showContinueButton(counter, i + 1, promptChain.length);
              
              if (action === 'skip') {
                console.log(`⏭️ User wybrał pominięcie - zakładam że odpowiedź jest OK i idę dalej`);
                responseCompleted = true; // Wyjdź z pętli czekania
                break;
              }
              
              // User kliknął "Czekaj na odpowiedź" - czekaj ponownie
              console.log(`🔄 Kontynuacja po timeout - ponowne czekanie na odpowiedź...`);
              updateCounter(counter, i + 1, promptChain.length, 'Czekam na odpowiedź...');
              continue; // Powtórz pętlę waitForResponse
            }
            
            // Odpowiedź zakończona - wyjdź z pętli
            responseCompleted = true;
          }
          
          // Pętla walidacji odpowiedzi - powtarzaj aż będzie poprawna
          let responseValid = false;
          let responseText = '';
          while (!responseValid) {
            console.log(`[${i + 1}/${promptChain.length}] Walidacja odpowiedzi...`);
            responseText = await getLastResponseText();
            const isValid = validateResponse(responseText);
            
            if (!isValid) {
              // Odpowiedź niepoprawna - pokaż przyciski i czekaj na user
              console.error(`❌ Odpowiedź niepoprawna przy promptcie ${i + 1}/${promptChain.length}`);
              console.error(`❌ Długość: ${responseText.length} znaków (wymagane min 50)`);
              updateCounter(counter, i + 1, promptChain.length, '❌ Odpowiedź za krótka');
              
              const action = await showContinueButton(counter, i + 1, promptChain.length);
              
              if (action === 'skip') {
                console.log(`⏭️ User wybrał pominięcie - akceptuję krótką odpowiedź i idę dalej`);
                responseValid = true; // Wyjdź z pętli walidacji
                break;
              }
              
              // User kliknął "Czekaj na odpowiedź" - może ChatGPT jeszcze generuje
              console.log(`🔄 Kontynuacja po naprawie - czekam na zakończenie generowania...`);
              updateCounter(counter, i + 1, promptChain.length, 'Czekam na odpowiedź...');
              
              // Poczekaj na zakończenie odpowiedzi ChatGPT
              await waitForResponse(responseWaitMs);
              
              // Powtórz walidację
              continue;
            }
            
            // Odpowiedź poprawna - wyjdź z pętli
            responseValid = true;
          }
          
          console.log(`✅ Prompt ${i + 1}/${promptChain.length} zakończony - odpowiedź poprawna`);
          
          // Zapamiętaj TYLKO odpowiedź z ostatniego prompta (do zwrócenia na końcu)
          const isLastPrompt = (i === promptChain.length - 1);
          if (isLastPrompt) {
            // Zapisz ZAWSZE ostatnią odpowiedź, nawet jeśli pusta (dla debugowania)
            window._lastResponseToSave = responseText || '';
            if (responseText && responseText.length > 0) {
              console.log(`💾 Przygotowano ostatnią odpowiedź z prompta ${i + 1}/${promptChain.length} do zapisu (${responseText.length} znaków)`);
            } else {
              console.warn(`⚠️ Ostatnia odpowiedź z prompta ${i + 1}/${promptChain.length} jest pusta! Zapisuję pustą odpowiedź dla debugowania.`);
            }
          } else {
            console.log(`⏭️ Pomijam odpowiedź ${i + 1}/${promptChain.length} - nie jest to ostatni prompt`);
          }
          
          // Anti-automation delay przed następnym promptem
          if (i < promptChain.length - 1) {
            const delay = getRandomDelay();
            console.log(`⏸️ Anti-automation delay: ${(delay/1000).toFixed(1)}s przed promptem ${i + 2}/${promptChain.length}...`);
            updateCounter(counter, i + 1, promptChain.length, `⏸️ Czekam ${(delay/1000).toFixed(0)}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        }
        
        // Sukces - pętla zakończona bez break
        console.log(`\n🎉 ZAKOŃCZONO PROMPT CHAIN - wykonano wszystkie ${promptChain.length} promptów`);
        
        // Usuń licznik z animacją sukcesu
        removeCounter(counter, true);
        
        // Zwróć ostatnią odpowiedź do zapisania
        const lastResponse = window._lastResponseToSave || '';
        delete window._lastResponseToSave;
        console.log(`🔙 Zwracam ostatnią odpowiedź (${lastResponse.length} znaków)`);
        
        return { success: true, lastResponse: lastResponse };
      } else {
        console.log("ℹ️ Brak prompt chain do wykonania (prompt chain jest puste lub null)");
        
        // Usuń licznik
        removeCounter(counter, true);
        
        // Brak prompt chain - nie ma odpowiedzi do zapisania
        return { success: true, lastResponse: '' };
      }
      
      // Ten return nigdy nie powinien zostać osiągnięty
      return { success: false };
    }
    
    // Czekaj przed następną próbą
    await new Promise(resolve => setTimeout(resolve, retryIntervalMs));
  }
  
  console.error("Nie znaleziono textarea w ChatGPT po " + textareaWaitMs + "ms");
  return { success: false, error: 'Nie znaleziono textarea' };
  
  } catch (error) {
    console.error(`\n${'='.repeat(80)}`);
    console.error(`❌ [injectToChat] CRITICAL ERROR`);
    console.error(`  Error: ${error.message}`);
    console.error(`  Stack: ${error.stack}`);
    console.error(`${'='.repeat(80)}\n`);
    return { success: false, error: `Critical error: ${error.message}` };
  }
}

// Funkcja pomocnicza do czekania
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Funkcja czekająca na pełne załadowanie karty
function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    
    // Sprawdź czy już jest complete
    chrome.tabs.get(tabId, (tab) => {
      if (tab.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}
