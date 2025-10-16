const CHAT_URL = "https://chatgpt.com/g/g-68e628cb581c819192fc463204dba31a-iskierka-test";
const PAUSE_MS = 1000;
const WAIT_FOR_TEXTAREA_MS = 10000; // 10 sekund na znalezienie textarea
const WAIT_FOR_RESPONSE_MS = 1200000; // 20 minut na odpowiedź ChatGPT
const RETRY_INTERVAL_MS = 500;

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

// Event listener dla kliknięcia w ikonę
chrome.action.onClicked.addListener(async () => {
  try {
    // Najpierw pobierz prompt chain od użytkownika
    const promptChain = await getPromptChain();
    
    if (!promptChain || promptChain.length === 0) {
      console.log("Anulowano lub brak promptów");
      return;
    }
    
    console.log(`Prompt chain: ${promptChain.length} promptów`);
    
    // Pobierz karty Economist
    const tabs = await chrome.tabs.query({url: "*://*.economist.com/*"});
    
    if (tabs.length === 0) {
      console.log("Brak otwartych kart Economist");
      return;
    }

    console.log(`Znaleziono ${tabs.length} kart Economist`);

    // Przetwarzaj wszystkie karty RÓWNOLEGLE - każda dostaje swoje okno ChatGPT
    const processingPromises = tabs.map(async (tab, index) => {
      try {
        console.log(`\n=== [${index + 1}/${tabs.length}] Przetwarzam kartę ID: ${tab.id}, Tytuł: ${tab.title}`);
        console.log(`URL: ${tab.url}`);
        
        // Małe opóźnienie między startami aby nie przytłoczyć przeglądarki
        await sleep(index * 500);
        
        // Ekstraktuj tekst z karty (bez aktywacji - nie przeszkadzamy użytkownikowi)
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          function: extractText
        });

        const extractedText = results[0]?.result;
        console.log(`[${index + 1}/${tabs.length}] Wyekstrahowano ${extractedText?.length || 0} znaków`);
        
        if (!extractedText || extractedText.length < 50) {
          console.log(`[${index + 1}/${tabs.length}] Pominięto - za mało tekstu`);
          return { success: false, reason: 'za mało tekstu' };
        }

        // Pobierz tytuł
        const title = tab.title || "Bez tytułu";

        // Złóż payload
        const payload = `Tytuł: ${title}\n\n${extractedText}`;

        // Otwórz nowe okno ChatGPT
        const window = await chrome.windows.create({
          url: CHAT_URL,
          type: "normal"
        });

        const chatTabId = window.tabs[0].id;

        // Czekaj na załadowanie strony
        await waitForTabComplete(chatTabId);

        // Wstrzyknij tekst do ChatGPT z retry i uruchom prompt chain
        await chrome.scripting.executeScript({
          target: { tabId: chatTabId },
          function: injectToChat,
          args: [payload, promptChain, WAIT_FOR_TEXTAREA_MS, WAIT_FOR_RESPONSE_MS, RETRY_INTERVAL_MS]
        });

        console.log(`[${index + 1}/${tabs.length}] ✅ Rozpoczęto przetwarzanie: ${title}`);
        return { success: true, title };

      } catch (error) {
        console.error(`[${index + 1}/${tabs.length}] ❌ Błąd:`, error);
        return { success: false, error: error.message };
      }
    });

    // Poczekaj na uruchomienie wszystkich
    const results = await Promise.allSettled(processingPromises);
    
    const successful = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
    console.log(`\n🎉 Uruchomiono ${successful}/${tabs.length} procesów ChatGPT`);

  } catch (error) {
    console.error("Błąd główny:", error);
  }
});

// Funkcja ekstrakcji tekstu (content script)
function extractText() {
  console.log("Próbuję wyekstrahować tekst z The Economist...");
  
  // Strategia 1: Szukaj głównego kontenera artykułu
  const selectors = [
    'article',
    '[data-test-id="Article"]',
    '.article__body-text',
    '.layout-article-body',
    'main article',
    'main',
    '.article-content',
    '#content'
  ];
  
  for (const selector of selectors) {
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
async function injectToChat(payload, promptChain, textareaWaitMs, responseWaitMs, retryIntervalMs) {
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
        
        // Potwierdź stan przez 3 kolejne sprawdzenia (1.5s)
        // To eliminuje false positives gdy UI migocze między stanami
        if (consecutiveReady >= 3) {
          console.log("✅ ChatGPT zakończył odpowiedź - interface gotowy");
          // Dodatkowe czekanie dla stabilizacji UI (2s wystarczy)
          await new Promise(resolve => setTimeout(resolve, 2000));
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
    
    // Szukaj ostatniej odpowiedzi ChatGPT w konwersacji
    const messages = document.querySelectorAll('[data-message-author-role="assistant"]');
    
    if (messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      const text = lastMessage.innerText || lastMessage.textContent || '';
      console.log(`✓ Znaleziono odpowiedź: ${text.length} znaków`);
      return text;
    }
    
    // Fallback - szukaj artykułów z odpowiedziami
    const articles = document.querySelectorAll('article');
    if (articles.length > 0) {
      const lastArticle = articles[articles.length - 1];
      const text = lastArticle.innerText || lastArticle.textContent || '';
      console.log(`✓ Znaleziono odpowiedź (fallback): ${text.length} znaków`);
      return text;
    }
    
    console.warn("⚠️ Nie znaleziono odpowiedzi ChatGPT w DOM");
    return '';
  }
  
  // Funkcja walidująca odpowiedź (min 500 znaków)
  function validateResponse(text) {
    const minLength = 500;
    const isValid = text.length >= minLength;
    
    console.log(`📊 Walidacja odpowiedzi: ${text.length} znaków (min: ${minLength}) - ${isValid ? '✅ OK' : '❌ ZA KRÓTKA'}`);
    
    if (!isValid && text.length > 0) {
      console.log(`📝 Preview odpowiedzi: "${text.substring(0, 200)}${text.length > 200 ? '...' : ''}"`);
    }
    
    return isValid;
  }
  
  // Funkcja pokazująca przycisk "Kontynuuj" i czekająca na kliknięcie
  function showContinueButton(counter, currentPrompt, totalPrompts) {
    return new Promise((resolve) => {
      console.log(`⏸️ Pokazuję przycisk Kontynuuj dla prompta ${currentPrompt}/${totalPrompts}`);
      
      counter.innerHTML = `
        <div style="font-size: 16px; margin-bottom: 8px;">⚠️ Zatrzymano</div>
        <div style="font-size: 14px; margin-bottom: 12px;">Prompt ${currentPrompt} / ${totalPrompts}</div>
        <div style="font-size: 12px; opacity: 0.9; margin-bottom: 12px; line-height: 1.4;">
          Odpowiedź niepoprawna lub timeout.<br>
          Napraw sytuację w ChatGPT, potem kliknij:
        </div>
        <button id="continue-chain-btn" style="
          background: white;
          color: #667eea;
          border: none;
          padding: 10px 20px;
          border-radius: 8px;
          font-weight: 600;
          cursor: pointer;
          font-size: 14px;
          width: 100%;
          transition: transform 0.2s;
        " onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">▶️ Kontynuuj</button>
      `;
      
      const btn = document.getElementById('continue-chain-btn');
      btn.addEventListener('click', () => {
        console.log('✅ Użytkownik kliknął Kontynuuj - wznawianie chain...');
        resolve();
      });
    });
  }

  // Funkcja wysyłania pojedynczego prompta
  async function sendPrompt(promptText) {
    console.log("🔍 Szukam edytora contenteditable...");
    
    // ChatGPT używa contenteditable div, NIE textarea!
    let editor = null;
    const maxWait = 15000; // Zwiększono z 10s na 15s
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWait) {
      editor = document.querySelector('[role="textbox"][contenteditable="true"]') ||
               document.querySelector('div[contenteditable="true"]');
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
    
    // Poczekaj na reakcję UI
    await new Promise(resolve => setTimeout(resolve, 1000));
    console.log("✅ Prompt wysłany");
    
    return true;
  }

  // Główna logika
  const startTime = Date.now();
  
  // Retry loop - czekaj na textarea
  while (Date.now() - startTime < textareaWaitMs) {
    const textarea = document.querySelector('textarea');
    
    if (textarea) {
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
      
      // Pauza przed prompt chain - interface musi być gotowy
      await new Promise(resolve => setTimeout(resolve, 3000));
      
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
            
            // Pokaż przycisk i czekaj na user - może naprawić sytuację
            await showContinueButton(counter, i + 1, promptChain.length);
            
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
          
          // Czekaj na odpowiedź po każdym promptcie
          console.log(`[${i + 1}/${promptChain.length}] Wywołuję waitForResponse()...`);
          const completed = await waitForResponse(responseWaitMs);
          
          // Walidacja po timeout - pokaż przycisk kontynuuj
          if (!completed) {
            console.error(`❌ Timeout przy promptcie ${i + 1}/${promptChain.length}`);
            console.log(`⏸️ ChatGPT nie odpowiedział w czasie - czekam na interwencję użytkownika`);
            updateCounter(counter, i + 1, promptChain.length, '⏱️ Timeout - czekam...');
            
            // Pokaż przycisk i czekaj na user
            await showContinueButton(counter, i + 1, promptChain.length);
            
            // User naprawił sytuację, kontynuuj
            console.log(`🔄 Kontynuacja po timeout - przechodź do walidacji odpowiedzi...`);
          }
          
          // Walidacja odpowiedzi - sprawdź czy jest wystarczająco długa
          console.log(`[${i + 1}/${promptChain.length}] Walidacja odpowiedzi...`);
          const responseText = getLastResponseText();
          const isValid = validateResponse(responseText);
          
          if (!isValid) {
            console.error(`❌ Odpowiedź niepoprawna przy promptcie ${i + 1}/${promptChain.length}`);
            console.error(`❌ Długość: ${responseText.length} znaków (wymagane min 500)`);
            updateCounter(counter, i + 1, promptChain.length, '❌ Odpowiedź za krótka');
            
            // Pokaż przycisk i czekaj na user
            await showContinueButton(counter, i + 1, promptChain.length);
            
            // User naprawił odpowiedź, kontynuuj
            console.log(`🔄 Kontynuacja po naprawie odpowiedzi...`);
          }
          
          console.log(`✅ Prompt ${i + 1}/${promptChain.length} zakończony - odpowiedź poprawna`);
          
          // Dodatkowa pauza przed następnym promptem - zwiększona z 2s na 4s
          // Im późniejszy prompt, tym dłuższa pauza (progresywnie)
          const pauseTime = 4000 + (i * 500); // 4s + 0.5s za każdy poprzedni prompt
          console.log(`⏸️  Pauza ${pauseTime}ms przed kolejnym promptem...`);
          await new Promise(resolve => setTimeout(resolve, pauseTime));
        }
        
        // Sukces - pętla zakończona bez break
        console.log(`\n🎉 ZAKOŃCZONO PROMPT CHAIN - wykonano wszystkie ${promptChain.length} promptów`);
        
        // Usuń licznik z animacją sukcesu
        removeCounter(counter, true);
      } else {
        console.log("ℹ️ Brak prompt chain do wykonania (prompt chain jest puste lub null)");
        
        // Usuń licznik
        removeCounter(counter, true);
      }
      
      return;
    }
    
    // Czekaj przed następną próbą
    await new Promise(resolve => setTimeout(resolve, retryIntervalMs));
  }
  
  console.error("Nie znaleziono textarea w ChatGPT po " + textareaWaitMs + "ms");
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
