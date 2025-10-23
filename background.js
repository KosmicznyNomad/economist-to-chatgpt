const CHAT_URL = "https://chatgpt.com/g/g-68e628cb581c819192fc463204dba31a-iskierka-test";
const CHAT_URL_PORTFOLIO = "https://chatgpt.com/g/g-68f71d198ffc819191ccc108942c5a56-iskierka-test-global";
const PAUSE_MS = 1000;
const WAIT_FOR_TEXTAREA_MS = 10000; // 10 sekund na znalezienie textarea
const WAIT_FOR_RESPONSE_MS = 1200000; // 20 minut na odpowiedź ChatGPT
const RETRY_INTERVAL_MS = 500;

// Zmienne globalne dla promptów
let PROMPTS_COMPANY = [];
let PROMPTS_PORTFOLIO = [];

// Funkcja wczytująca prompty z plików txt
async function loadPrompts() {
  try {
    console.log("📝 Wczytuję prompty z plików...");
    
    // Wczytaj prompts-company.txt
    const companyUrl = chrome.runtime.getURL('prompts-company.txt');
    const companyResponse = await fetch(companyUrl);
    const companyText = await companyResponse.text();
    
    // Parsuj prompty (oddzielone ~)
    PROMPTS_COMPANY = companyText
      .split('~')
      .map(p => p.trim())
      .filter(p => p.length > 0);
    
    console.log(`✅ Wczytano ${PROMPTS_COMPANY.length} promptów dla analizy spółki`);
    
    // Wczytaj prompts-portfolio.txt
    const portfolioUrl = chrome.runtime.getURL('prompts-portfolio.txt');
    const portfolioResponse = await fetch(portfolioUrl);
    const portfolioText = await portfolioResponse.text();
    
    // Parsuj prompty (oddzielone ~)
    PROMPTS_PORTFOLIO = portfolioText
      .split('~')
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
  { pattern: "https://*.foreignaffairs.com/*", name: "Foreign Affairs" }
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
    const result = await chrome.storage.session.get(['responses']);
    const responses = result.responses || [];
    
    responses.push({
      text: responseText,
      timestamp: Date.now(),
      source: source,
      analysisType: analysisType
    });
    
    await chrome.storage.session.set({ responses });
    console.log(`✅ Zapisano odpowiedź do storage (${responses.length} łącznie, typ: ${analysisType})`);
  } catch (error) {
    console.error('❌ Błąd zapisywania odpowiedzi:', error);
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
  }
});

// Listener na skróty klawiszowe
chrome.commands.onCommand.addListener((command) => {
  if (command === 'open_responses') {
    chrome.tabs.create({ url: chrome.runtime.getURL('responses.html') });
  }
});

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
        // Ekstraktuj tekst z karty (bez aktywacji - nie przeszkadzamy użytkownikowi)
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          function: extractText
        });
        extractedText = results[0]?.result;
        console.log(`[${analysisType}] [${index + 1}/${tabs.length}] Wyekstrahowano ${extractedText?.length || 0} znaków`);
        
        // Dla automatycznych źródeł: walidacja minimum 50 znaków
        if (!extractedText || extractedText.length < 50) {
          console.log(`[${analysisType}] [${index + 1}/${tabs.length}] Pominięto - za mało tekstu`);
          return { success: false, reason: 'za mało tekstu' };
        }
      }

      // Pobierz tytuł
      const title = tab.title || "Bez tytułu";
      
      // Wykryj źródło artykułu
      let sourceName;
      let transcriptLang = null;
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
        
        // Dla YouTube - pobierz język transkrypcji z injected script
        if (sourceName === "YouTube") {
          try {
            const langResults = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              function: () => window._ytTranscriptLang || null
            });
            transcriptLang = langResults[0]?.result;
            console.log(`[${analysisType}] Język transkrypcji YouTube: ${transcriptLang || 'unknown'}`);
          } catch (e) {
            console.warn(`[${analysisType}] Nie udało się pobrać języka transkrypcji:`, e);
          }
        }
      }

      // Złóż payload z metadanymi źródła
      let payload = `Źródło: ${sourceName}`;
      if (transcriptLang) {
        payload += `\nJęzyk transkrypcji: ${transcriptLang}`;
      }
      payload += `\nTytuł: ${title}\n\n${extractedText}`;

      // Otwórz nowe okno ChatGPT
      const window = await chrome.windows.create({
        url: chatUrl,
        type: "normal"
      });

      const chatTabId = window.tabs[0].id;

      // Czekaj na załadowanie strony
      await waitForTabComplete(chatTabId);

      // Wstrzyknij tekst do ChatGPT z retry i uruchom prompt chain
      const results = await chrome.scripting.executeScript({
        target: { tabId: chatTabId },
        function: injectToChat,
        args: [payload, promptChain, WAIT_FOR_TEXTAREA_MS, WAIT_FOR_RESPONSE_MS, RETRY_INTERVAL_MS, title, analysisType]
      });

      // Zapisz ostatnią odpowiedź zwróconą z injectToChat
      const result = results[0]?.result;
      if (result && result.success && result.lastResponse) {
        await saveResponse(result.lastResponse, title, analysisType);
        console.log(`[${analysisType}] [${index + 1}/${tabs.length}] ✅ Zapisano odpowiedź dla: ${title}`);
      } else if (result && !result.success) {
        console.warn(`[${analysisType}] [${index + 1}/${tabs.length}] ⚠️ Proces zakończony bez odpowiedzi: ${title}`);
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

// Funkcja ekstrakcji tekstu (content script)
async function extractText() {
  const hostname = window.location.hostname;
  console.log(`Próbuję wyekstrahować tekst z: ${hostname}`);
  
  // === OBSŁUGA YOUTUBE ===
  if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
    console.log('Wykryto YouTube - pobieram transkrypcję przez YouTube Internal API...');
    
    // === 3.1 WYCIĄGNIJ VIDEO ID Z URL ===
    function extractVideoId(url) {
      try {
        const urlObj = new URL(url);
        
        // Format: youtube.com/watch?v=VIDEO_ID
        if (urlObj.hostname.includes('youtube.com')) {
          const videoId = urlObj.searchParams.get('v');
          if (videoId) return videoId;
        }
        
        // Format: youtu.be/VIDEO_ID
        if (urlObj.hostname.includes('youtu.be')) {
          const videoId = urlObj.pathname.slice(1); // Usuń pierwszy slash
          if (videoId) return videoId;
        }
        
        console.error('Nie udało się wyciągnąć Video ID z URL:', url);
        return null;
      } catch (e) {
        console.error('Błąd parsowania URL:', e);
        return null;
      }
    }
    
    const videoId = extractVideoId(window.location.href);
    if (!videoId) {
      console.error('❌ Brak Video ID - pomijam');
      return '';
    }
    
    console.log(`✓ Video ID: ${videoId}`);
    
     // === 3.2 WYCIĄGNIJ URL TRANSKRYPCJI Z ytInitialPlayerResponse ===
     function getCaptionTracksFromPlayerResponse() {
       try {
         // YouTube zapisuje dane w <script> tagach w HTML (content script ma dostęp do DOM)
         let ytInitialPlayerResponse = null;
         
         // Szukaj w script tagach
         const scripts = document.querySelectorAll('script');
         for (const script of scripts) {
           const content = script.textContent || script.innerText || '';
           
           // Szukaj wzorca: var ytInitialPlayerResponse = {...};
           const match = content.match(/var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
           if (match && match[1]) {
             try {
               ytInitialPlayerResponse = JSON.parse(match[1]);
               console.log('✓ Znaleziono ytInitialPlayerResponse w <script> tagu');
               break;
             } catch (e) {
               console.warn('⚠️ Nie udało się sparsować ytInitialPlayerResponse:', e);
               continue;
             }
           }
         }
         
         if (!ytInitialPlayerResponse) {
           console.error('❌ Nie znaleziono ytInitialPlayerResponse w HTML');
           return null;
         }
         
         const captions = ytInitialPlayerResponse.captions;
         if (!captions) {
           console.error('❌ Brak sekcji captions w ytInitialPlayerResponse');
           return null;
         }
         
         const captionTracks = captions.playerCaptionsTracklistRenderer?.captionTracks;
         if (!captionTracks || captionTracks.length === 0) {
           console.error('❌ Brak dostępnych napisów dla tego filmu');
           console.error('💡 Film prawdopodobnie nie ma transkrypcji/napisów');
           return null;
         }
         
         console.log(`✓ Znaleziono ${captionTracks.length} dostępnych transkrypcji`);
         
         // Wybierz pierwszą dostępną transkrypcję (dowolny język)
         const selectedTrack = captionTracks[0];
         const langCode = selectedTrack.languageCode || 'unknown';
         const langName = selectedTrack.name?.simpleText || langCode;
         const baseUrl = selectedTrack.baseUrl;
         
         if (!baseUrl) {
           console.error('❌ Brak baseUrl w wybranej transkrypcji');
           return null;
         }
         
         console.log(`✓ Wybrałem transkrypcję: ${langName} (${langCode})`);
         console.log(`📍 URL transkrypcji: ${baseUrl.substring(0, 100)}...`);
         
         return {
           url: baseUrl,
           langCode: langCode,
           langName: langName
         };
         
       } catch (e) {
         console.error('❌ Błąd wyciągania transkrypcji z ytInitialPlayerResponse:', e);
         return null;
       }
     }
    
     const captionTrack = getCaptionTracksFromPlayerResponse();
     if (!captionTrack) {
       console.error('❌ Nie znaleziono transkrypcji dla tego filmu');
       return '';
     }
     
     // Zapisz język w zmiennej globalnej (do użycia w payload metadata)
     window._ytTranscriptLang = captionTrack.langCode;
     
     console.log(`✓ Pobieram transkrypcję przez fetch (content script - bez CORS)...`);
     
     // Pobierz XML w content script (brak problemów CORS)
     try {
       // Dodaj format parametr - spróbuj różnych formatów
       const urlWithFormat = captionTrack.url + '&fmt=srv3';
       console.log(`🔗 Pełny URL: ${urlWithFormat}`);
       
       // Użyj XMLHttpRequest - czasami działa lepiej niż fetch dla YouTube API
       const transcriptXml = await new Promise((resolve, reject) => {
         const xhr = new XMLHttpRequest();
         xhr.open('GET', urlWithFormat, true);
         xhr.timeout = 10000;
         
         xhr.onload = () => {
           console.log(`📡 XHR status: ${xhr.status} ${xhr.statusText}`);
           console.log(`📡 XHR responseType: ${xhr.responseType}`);
           console.log(`📡 XHR response length: ${xhr.responseText?.length || 0}`);
           
           if (xhr.status >= 200 && xhr.status < 300) {
             resolve(xhr.responseText);
           } else {
             reject(new Error(`HTTP ${xhr.status}`));
           }
         };
         
         xhr.onerror = () => reject(new Error('Network error'));
         xhr.ontimeout = () => reject(new Error('Timeout'));
         
         xhr.send();
       });
       
       console.log(`✓ Transkrypcja pobrana: ${transcriptXml.length} znaków`);
       console.log(`📝 Preview XML (pierwsze 500 znaków): ${transcriptXml.substring(0, 500)}...`);
       
       // Parsuj XML do tekstu (używamy DOMParser - dostępny w content script)
       const parser = new DOMParser();
       const doc = parser.parseFromString(transcriptXml, 'text/xml');
       const textElements = doc.querySelectorAll('text');
       
       if (textElements.length === 0) {
         console.error('❌ Brak elementów <text> w XML transkrypcji');
         return '';
       }
       
       // Wyciągnij tekst z każdego elementu
       const texts = Array.from(textElements).map(element => {
         const text = element.textContent || '';
         // Dekoduj HTML entities
         const textarea = document.createElement('textarea');
         textarea.innerHTML = text;
         return textarea.value.trim();
       }).filter(text => text.length > 0);
       
       const fullText = texts.join(' ');
       console.log(`✓ Sparsowano transkrypcję: ${textElements.length} segmentów → ${fullText.length} znaków`);
       console.log(`📝 Preview: "${fullText.substring(0, 150)}..."`);
       
       return fullText;
       
     } catch (error) {
       console.error('❌ Błąd pobierania/parsowania transkrypcji:', error);
       return '';
     }
  }
  
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
      console.log('🔧 Próbuję naprawić przez Edit+Resend...');
      
      // Znajdź ostatnią wiadomość użytkownika
      const userMessages = document.querySelectorAll('[data-message-author-role="user"]');
      if (userMessages.length === 0) {
        console.warn('⚠️ Brak wiadomości użytkownika');
        return false;
      }
      
      const lastUserMessage = userMessages[userMessages.length - 1];
      console.log('✓ Znaleziono ostatnią wiadomość użytkownika');
      
      // Symuluj hover aby pokazać ukryte narzędzia
      lastUserMessage.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 150));
      
      // Znajdź przycisk Edit bezpośrednio w wiadomości (różne selektory)
      let editButton = lastUserMessage.querySelector('button[aria-label="Edit message"]');
      if (!editButton) {
        editButton = lastUserMessage.querySelector('button.right-full[aria-label*="Edit"]');
      }
      if (!editButton) {
        editButton = lastUserMessage.querySelector('button[aria-label*="Edit"]');
      }
      
      // Fallback 1: lokalizacja polska
      if (!editButton) {
        editButton = lastUserMessage.querySelector('button[aria-label*="Edytuj"]');
        if (editButton) console.log('✓ Znaleziono przycisk Edit (fallback: polska lokalizacja)');
      }
      
      // Fallback 2: szukaj w conversation-turn container
      if (!editButton) {
        const turnContainer = lastUserMessage.closest('[data-testid^="conversation-turn-"]');
        if (turnContainer) {
          editButton = turnContainer.querySelector('button[aria-label*="Edit"]') ||
                       turnContainer.querySelector('button[aria-label*="Edytuj"]');
          if (editButton) console.log('✓ Znaleziono przycisk Edit (fallback: conversation-turn container)');
        }
      }
      
      // Fallback 3: szukaj w toolbar
      if (!editButton) {
        const toolbar = lastUserMessage.querySelector('[role="toolbar"]');
        if (toolbar) {
          editButton = toolbar.querySelector('button[aria-label*="Edit"]') ||
                       toolbar.querySelector('button[aria-label*="Edytuj"]');
          if (editButton) console.log('✓ Znaleziono przycisk Edit (fallback: toolbar)');
        }
      }
      
      if (!editButton) {
        console.warn('⚠️ Nie znaleziono przycisku Edit');
        return false;
      }
      
      console.log('✓ Znaleziono przycisk Edit');
      
      // Usuń klasy ukrywające (invisible, hidden) i wymuś widoczność
      if (editButton.classList.contains('invisible')) {
        editButton.classList.remove('invisible');
        console.log('✓ Usunięto klasę invisible');
      }
      if (editButton.classList.contains('hidden')) {
        editButton.classList.remove('hidden');
        console.log('✓ Usunięto klasę hidden');
      }
      
      // Wymuś widoczność przez style (na wypadek CSS)
      const originalStyle = editButton.style.cssText;
      editButton.style.visibility = 'visible';
      editButton.style.display = 'block';
      
      console.log('✓ Klikam przycisk Edit...');
      editButton.click();
      
      // Przywróć oryginalny styl po kliknięciu
      setTimeout(() => {
        editButton.style.cssText = originalStyle;
      }, 100);
      
      // Czekaj na pojawienie się edytora
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Znajdź przycisk Send
      let sendButton = document.querySelector('[data-testid="send-button"]');
      if (!sendButton) {
        sendButton = document.querySelector('button[aria-label*="Send"]');
      }
      if (!sendButton) {
        sendButton = document.querySelector('#composer-submit-button');
      }
      
      if (!sendButton) {
        console.warn('⚠️ Nie znaleziono przycisku Send po Edit');
        return false;
      }
      
      if (sendButton.disabled) {
        console.warn('⚠️ Przycisk Send jest disabled');
        return false;
      }
      
      console.log('✓ Znaleziono przycisk Send - klikam...');
      sendButton.click();
      
      // Czekaj aby prompt się wysłał
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      console.log('✅ Edit+Resend wykonane pomyślnie');
      return true;
      
    } catch (error) {
      console.error('❌ Błąd w tryEditResend:', error);
      return false;
    }
  }
  
  // Funkcja czekająca na zakończenie odpowiedzi ChatGPT
  async function waitForResponse(maxWaitMs) {
    const startTime = Date.now();
    
    console.log("⏳ Czekam na odpowiedź ChatGPT...");
    
    // ===== FAZA 1: Detekcja STARTU odpowiedzi =====
    // Czekaj aż ChatGPT zacznie generować odpowiedź
    // Chain-of-thought model może myśleć 4-5 min przed startem
    let responseStarted = false;
    const startTimeout = Math.min(maxWaitMs, 1200000); // Max 20 minut na start
    
    while (Date.now() - startTime < startTimeout) {
      // Sprawdź czy pojawił się komunikat błędu i napraw przez Edit+Resend lub Retry
      const errorMessages = document.querySelectorAll('[class*="text"]');
      for (const msg of errorMessages) {
        if (msg.textContent.includes('Something went wrong while generating the response')) {
          console.log('⚠️ Znaleziono komunikat błędu - próbuję naprawić...');
          
          // Najpierw spróbuj Edit+Resend
          const editSuccess = await tryEditResend();
          if (editSuccess) {
            console.log('✅ Naprawiono przez Edit+Resend - kontynuuję czekanie...');
            await new Promise(resolve => setTimeout(resolve, 2000));
            continue; // Kontynuuj czekanie w tej samej pętli
          }
          
          // Jeśli Edit nie zadziałał, spróbuj Retry
          console.log('⚠️ Edit+Resend nie zadziałał - szukam przycisku Retry...');
          let retryButton = msg.parentElement?.querySelector('button[aria-label="Retry"]');
          if (!retryButton) {
            retryButton = msg.closest('[class*="group"]')?.querySelector('button[aria-label="Retry"]');
          }
          if (!retryButton) {
            // Szukaj w całym dokumencie jako fallback
            retryButton = document.querySelector('button[aria-label="Retry"]');
          }
          
          if (retryButton) {
            console.log('🔄 Klikam przycisk Retry - wznawiam czekanie na odpowiedź...');
            retryButton.click();
            await new Promise(resolve => setTimeout(resolve, 2000));
            // Zwróć false aby zewnętrzna pętla wywołała waitForResponse ponownie (jak Continue)
            return false;
          } else {
            console.warn('⚠️ Nie znaleziono przycisku Retry');
          }
        }
      }
      
      // Szukaj edytora - może być w różnych stanach
      const editorAny = document.querySelector('[role="textbox"]') ||
                        document.querySelector('[contenteditable]') ||
                        document.querySelector('[data-testid="composer-input"]');
      
      const stopButton = document.querySelector('button[aria-label*="Stop"]') || 
                        document.querySelector('[data-testid="stop-button"]') ||
                        document.querySelector('button[aria-label*="stop"]');
      
      const sendButton = document.querySelector('[data-testid="send-button"]') ||
                        document.querySelector('#composer-submit-button') ||
                        document.querySelector('button[aria-label="Send"]');
      
      // ChatGPT zaczął odpowiadać jeśli:
      // 1. Jest stopButton (główny wskaźnik generowania)
      // 2. LUB editor jest disabled (contenteditable="false")
      // 3. LUB sendButton jest disabled (podczas generowania)
      const editorDisabled = editorAny && editorAny.getAttribute('contenteditable') === 'false';
      const sendDisabled = sendButton && sendButton.disabled;
      
      if (stopButton || editorDisabled || sendDisabled) {
        console.log("✓ ChatGPT zaczął odpowiadać", {
          stopButton: !!stopButton,
          editorDisabled: !!editorDisabled,
          sendDisabled: !!sendDisabled
        });
        responseStarted = true;
        break;
      }
      
      // Loguj co 30s że czekamy
      if ((Date.now() - startTime) % 30000 < 500) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`⏳ Czekam na start odpowiedzi... (${elapsed}s)`);
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    if (!responseStarted) {
      console.error(`❌ ChatGPT nie zaczął odpowiadać po ${Math.round(startTimeout/1000)}s - prompt prawdopodobnie nie został wysłany!`);
      return false;
    }
    
    // ===== FAZA 2: Detekcja ZAKOŃCZENIA odpowiedzi =====
    // Czekaj aż ChatGPT skończy i interface będzie gotowy na kolejny prompt
    let consecutiveReady = 0;
    let logInterval = 0;
    
    while (Date.now() - startTime < maxWaitMs) {
      // Sprawdź czy pojawił się komunikat błędu i napraw przez Edit+Resend lub Retry
      const errorMessages = document.querySelectorAll('[class*="text"]');
      for (const msg of errorMessages) {
        if (msg.textContent.includes('Something went wrong while generating the response')) {
          console.log('⚠️ Znaleziono komunikat błędu - próbuję naprawić...');
          
          // Najpierw spróbuj Edit+Resend
          const editSuccess = await tryEditResend();
          if (editSuccess) {
            console.log('✅ Naprawiono przez Edit+Resend - kontynuuję czekanie...');
            await new Promise(resolve => setTimeout(resolve, 2000));
            continue; // Kontynuuj czekanie w tej samej pętli
          }
          
          // Jeśli Edit nie zadziałał, spróbuj Retry
          console.log('⚠️ Edit+Resend nie zadziałał - szukam przycisku Retry...');
          let retryButton = msg.parentElement?.querySelector('button[aria-label="Retry"]');
          if (!retryButton) {
            retryButton = msg.closest('[class*="group"]')?.querySelector('button[aria-label="Retry"]');
          }
          if (!retryButton) {
            // Szukaj w całym dokumencie jako fallback
            retryButton = document.querySelector('button[aria-label="Retry"]');
          }
          
          if (retryButton) {
            console.log('🔄 Klikam przycisk Retry - wznawiam czekanie na odpowiedź...');
            retryButton.click();
            await new Promise(resolve => setTimeout(resolve, 2000));
            // Zwróć false aby zewnętrzna pętla wywołała waitForResponse ponownie (jak Continue)
            return false;
          } else {
            console.warn('⚠️ Nie znaleziono przycisku Retry');
          }
        }
      }
      
      // Szukaj wszystkich elementów interfejsu
      const editor = document.querySelector('[role="textbox"][contenteditable="true"]') ||
                     document.querySelector('div[contenteditable="true"]') ||
                     document.querySelector('[data-testid="composer-input"][contenteditable="true"]');
      
      const stopButton = document.querySelector('button[aria-label*="Stop"]') || 
                        document.querySelector('[data-testid="stop-button"]') ||
                        document.querySelector('button[aria-label*="stop"]');
      
      const sendButton = document.querySelector('[data-testid="send-button"]') ||
                        document.querySelector('#composer-submit-button') ||
                        document.querySelector('button[aria-label="Send"]') ||
                        document.querySelector('button[aria-label*="Send"]');
      
      // Co 10 iteracji (5s) loguj stan
      if (logInterval % 10 === 0) {
        console.log(`🔍 Stan interfejsu:`, {
          editor_exists: !!editor,
          editor_enabled: editor?.getAttribute('contenteditable') === 'true',
          stopButton_exists: !!stopButton,
          sendButton_exists: !!sendButton,
          sendButton_disabled: sendButton?.disabled,
          consecutiveReady: consecutiveReady,
          elapsed: Math.round((Date.now() - startTime) / 1000) + 's'
        });
      }
      logInterval++;
      
      // ===== WARUNKI GOTOWOŚCI =====
      // Interface jest gotowy gdy ChatGPT skończył generować:
      // 1. BRAK stopButton (ChatGPT przestał generować)
      // 2. Editor ISTNIEJE i jest ENABLED (contenteditable="true")
      // 
      // UWAGA: SendButton może nie istnieć gdy editor jest pusty - sprawdzimy go dopiero w sendPrompt()
      
      const editorReady = editor && editor.getAttribute('contenteditable') === 'true';
      const noGeneration = !stopButton;
      
      const isReady = noGeneration && editorReady;
      
      if (isReady) {
        consecutiveReady++;
        console.log(`✓ Interface ready (${consecutiveReady}/3) - warunki OK`);
        
        // Potwierdź stan przez 3 kolejnych sprawdzeń (1.5s)
        // To eliminuje false positives gdy UI migocze między stanami
        if (consecutiveReady >= 3) {
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
          console.log(`  Powód: noGeneration=${noGeneration}, editorReady=${editorReady}`);
        }
        consecutiveReady = 0;
      }
      
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.error(`❌ TIMEOUT czekania na odpowiedź po ${Math.round(maxWaitMs/1000)}s`);
    return false;
  }

  // Funkcja wyciągająca ostatnią odpowiedź ChatGPT z DOM
  function getLastResponseText() {
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
      
      // Wyciągnij tekst
      const text = clone.textContent || clone.innerText || '';
      
      // Oczyść z nadmiarowych białych znaków
      return text.replace(/\s+/g, ' ').trim();
    }
    
    // Szukaj wszystkich odpowiedzi ChatGPT w konwersacji
    const messages = document.querySelectorAll('[data-message-author-role="assistant"]');
    console.log(`🔍 Znaleziono ${messages.length} wiadomości assistant w DOM`);
    
    if (messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      
      // Sprawdź czy to nie jest tylko thinking indicator
      const thinkingIndicators = lastMessage.querySelectorAll('[class*="thinking"]');
      if (thinkingIndicators.length > 0) {
        console.warn("⚠️ Ostatnia wiadomość zawiera thinking indicator - ChatGPT jeszcze nie zaczął odpowiedzi");
        console.log(`   Thinking indicators: ${thinkingIndicators.length}`);
      }
      
      const text = extractMainContent(lastMessage);
      console.log(`✓ Znaleziono odpowiedź: ${text.length} znaków`);
      console.log(`📝 Preview: "${text.substring(0, 200)}${text.length > 200 ? '...' : ''}"`);
      
      // Dodatkowe logowanie jeśli odpowiedź jest pusta
      if (text.length === 0) {
        console.warn("⚠️ Wyekstrahowany tekst ma długość 0!");
        console.log("   HTML preview:", lastMessage.innerHTML.substring(0, 300));
        console.log("   textContent:", lastMessage.textContent.substring(0, 300));
      }
      
      return text;
    }
    
    // Fallback 2: szukaj przez conversation-turn containers
    const turnContainers = document.querySelectorAll('[data-testid^="conversation-turn-"]');
    console.log(`🔍 Znaleziono ${turnContainers.length} conversation turns w DOM (fallback 2)`);
    
    if (turnContainers.length > 0) {
      // Szukaj ostatniego turnu z assistant
      for (let i = turnContainers.length - 1; i >= 0; i--) {
        const turn = turnContainers[i];
        const assistantMsg = turn.querySelector('[data-message-author-role="assistant"]');
        if (assistantMsg) {
          const text = extractMainContent(assistantMsg);
          console.log(`✓ Znaleziono odpowiedź przez conversation-turn (fallback 2): ${text.length} znaków`);
          console.log(`📝 Preview: "${text.substring(0, 200)}${text.length > 200 ? '...' : ''}"`);
          return text;
        }
      }
    }
    
    // Fallback 3: szukaj artykułów z odpowiedziami
    const articles = document.querySelectorAll('article');
    console.log(`🔍 Znaleziono ${articles.length} articles w DOM (fallback 3)`);
    
    if (articles.length > 0) {
      const lastArticle = articles[articles.length - 1];
      const text = extractMainContent(lastArticle);
      console.log(`✓ Znaleziono odpowiedź (fallback): ${text.length} znaków`);
      console.log(`📝 Preview: "${text.substring(0, 200)}${text.length > 200 ? '...' : ''}"`);
      return text;
    }
    
    console.warn("⚠️ Nie znaleziono odpowiedzi ChatGPT w DOM");
    console.log("   Wszystkie selektory zwróciły 0 wyników");
    return '';
  }
  
  // Funkcja walidująca odpowiedź (min 10 znaków - poluzowane zabezpieczenie)
  function validateResponse(text) {
    const minLength = 10;
    const isValid = text.length >= minLength;
    
    console.log(`📊 Walidacja: ${isValid ? '✅ OK' : '❌ ZA KRÓTKA'} (${text.length} < ${minLength} znaków)`);
    
    return isValid;
  }
  
  // Funkcja czekająca aż interface ChatGPT będzie gotowy do wysłania kolejnego prompta
  async function waitForInterfaceReady(maxWaitMs) {
    const startTime = Date.now();
    let consecutiveReady = 0;
    
    console.log("⏳ Czekam aż interface będzie gotowy...");
    
    while (Date.now() - startTime < maxWaitMs) {
      // Sprawdź wszystkie elementy interfejsu
      const editor = document.querySelector('[role="textbox"][contenteditable="true"]') ||
                     document.querySelector('div[contenteditable="true"]');
      
      const stopButton = document.querySelector('button[aria-label*="Stop"]') || 
                        document.querySelector('[data-testid="stop-button"]') ||
                        document.querySelector('button[aria-label*="stop"]');
      
      // Interface jest gotowy gdy:
      // 1. BRAK stopButton (ChatGPT nie generuje)
      // 2. Editor ISTNIEJE i jest ENABLED
      const editorReady = editor && editor.getAttribute('contenteditable') === 'true';
      const noGeneration = !stopButton;
      const isReady = noGeneration && editorReady;
      
      if (isReady) {
        consecutiveReady++;
        if (consecutiveReady >= 2) { // Potwierdź przez 2 sprawdzenia (1s)
          console.log("✅ Interface gotowy");
          await new Promise(resolve => setTimeout(resolve, 500)); // Krótka stabilizacja
          return true;
        }
      } else {
        consecutiveReady = 0;
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
  async function sendPrompt(promptText, maxWaitForReady = responseWaitMs) {
    // KROK 1: Czekaj aż interface będzie gotowy (jeśli poprzednia odpowiedź się jeszcze generuje)
    console.log("🔍 Sprawdzam gotowość interfejsu przed wysłaniem...");
    const interfaceReady = await waitForInterfaceReady(maxWaitForReady); // Pełny timeout (domyślnie 20 minut)
    
    if (!interfaceReady) {
      console.error(`❌ Interface nie stał się gotowy po ${Math.round(maxWaitForReady/1000)}s`);
      return false;
    }
    
    console.log("✅ Interface gotowy - wysyłam prompt");
    
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
    
    // Wstaw tekst - ulepszona wersja
    // Najpierw jako textNode
    const textNode = document.createTextNode(promptText);
    editor.appendChild(textNode);
    
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
    const maxVerifyWait = 5000; // 5s na weryfikację
    
    while (verifyTime < maxVerifyWait) {
      // Po wysłaniu prompta ChatGPT powinien:
      // 1. Wyczyścić/disabled editor
      // 2. Pokazać stopButton (zacząć generować)
      // 3. Disabled sendButton
      
      const editorNow = document.querySelector('[role="textbox"]') ||
                        document.querySelector('[contenteditable]');
      const stopBtn = document.querySelector('button[aria-label*="Stop"]') || 
                      document.querySelector('[data-testid="stop-button"]');
      const sendBtn = document.querySelector('[data-testid="send-button"]') ||
                      document.querySelector('button[aria-label="Send"]');
      
      const editorDisabled = editorNow && editorNow.getAttribute('contenteditable') === 'false';
      const editorEmpty = editorNow && (editorNow.textContent || '').trim().length === 0;
      const sendDisabled = sendBtn && sendBtn.disabled;
      
      // Jeśli którykolwiek wskaźnik potwierdza wysłanie:
      if (stopBtn || editorDisabled || (editorEmpty && sendDisabled)) {
        console.log(`✅ Prompt faktycznie wysłany (${verifyTime}ms)`, {
          stopBtn: !!stopBtn,
          editorDisabled,
          editorEmpty: editorEmpty && sendDisabled
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
      console.log(`Artykuł: ${payload.substring(0, 100)}...`);
      
      // Stwórz licznik
      const counter = createCounter();
      updateCounter(counter, 0, promptChain ? promptChain.length : 0, 'Wysyłam artykuł...');
      
      // Wyślij tekst Economist
      console.log("📤 Wysyłam artykuł do ChatGPT...");
      await sendPrompt(payload);
      
      // Czekaj na odpowiedź ChatGPT
      updateCounter(counter, 0, promptChain ? promptChain.length : 0, 'Czekam na odpowiedź...');
      await waitForResponse(responseWaitMs);
      console.log("✅ Artykuł przetworzony");
      
      // NIE zapisujemy początkowej odpowiedzi - zapisujemy tylko ostatnią z prompt chain
      
      // Krótka pauza przed prompt chain - czekanie na gotowość jest w sendPrompt
      await new Promise(resolve => setTimeout(resolve, 1000));
      
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
          const sent = await sendPrompt(prompt);
          
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
            const retried = await sendPrompt(prompt);
            
            if (!retried) {
              console.error(`❌ Ponowna próba nieudana - przerywam chain`);
              updateCounter(counter, i + 1, promptChain.length, `❌ Błąd krytyczny`);
              await new Promise(resolve => setTimeout(resolve, 10000));
              return; // Zakończ bez usuwania licznika
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
            responseText = getLastResponseText();
            const isValid = validateResponse(responseText);
            
            if (!isValid) {
              // Odpowiedź niepoprawna - pokaż przyciski i czekaj na user
              console.error(`❌ Odpowiedź niepoprawna przy promptcie ${i + 1}/${promptChain.length}`);
              console.error(`❌ Długość: ${responseText.length} znaków (wymagane min 10)`);
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
          if (isLastPrompt && responseText && responseText.length > 0) {
            // Zmienna lastResponse będzie zwrócona na końcu funkcji
            window._lastResponseToSave = responseText;
            console.log(`💾 Przygotowano ostatnią odpowiedź z prompta ${i + 1}/${promptChain.length} do zapisu (${responseText.length} znaków)`);
          } else if (!isLastPrompt) {
            console.log(`⏭️ Pomijam odpowiedź ${i + 1}/${promptChain.length} - nie jest to ostatni prompt`);
          }
          
          // Minimalna pauza przed następnym promptem - główne czekanie jest w sendPrompt
          console.log(`⏸️ Krótka pauza przed kolejnym promptem...`);
          await new Promise(resolve => setTimeout(resolve, 1000));
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
