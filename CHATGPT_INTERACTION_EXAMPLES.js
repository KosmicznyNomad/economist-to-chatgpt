/**
 * CHATGPT INTERACTION EXAMPLES
 *
 * Przykładowe funkcje do interakcji z interfejsem ChatGPT
 * Bazowane na dokumentacji CHATGPT_DOM_STRUCTURE.md
 *
 * Użycie: Wstrzyknij te funkcje przez chrome.scripting.executeScript
 */

// ============================================
// 1. ZNAJDOWANIE ELEMENTÓW
// ============================================

/**
 * Znajduje edytor wiadomości (contenteditable)
 * @returns {HTMLElement|null}
 */
function findEditor() {
  return (
    document.querySelector('[role="textbox"][contenteditable="true"]') ||
    document.querySelector('div[contenteditable="true"]') ||
    document.querySelector('[data-testid="composer-input"]') ||
    document.querySelector('[contenteditable]') ||
    document.querySelector('[role="textbox"]')
  );
}

/**
 * Znajduje przycisk Send
 * @returns {HTMLElement|null}
 */
function findSendButton() {
  return (
    document.querySelector('[data-testid="send-button"]') ||
    document.querySelector('#composer-submit-button') ||
    document.querySelector('button[aria-label="Send"]') ||
    document.querySelector('button[aria-label*="Send"]') ||
    document.querySelector('button[data-testid*="send"]')
  );
}

/**
 * Znajduje przycisk Edit w ostatniej wiadomości użytkownika
 * @returns {HTMLElement|null}
 */
function findEditButton() {
  const userMessages = document.querySelectorAll('[data-message-author-role="user"]');
  if (userMessages.length === 0) return null;

  const lastUserMessage = userMessages[userMessages.length - 1];

  return (
    lastUserMessage.querySelector('button[aria-label="Edit message"]') ||
    lastUserMessage.querySelector('button.right-full[aria-label*="Edit"]') ||
    lastUserMessage.querySelector('button[aria-label*="Edit"]')
  );
}

/**
 * Znajduje przycisk Stop (generowanie w toku)
 * @returns {HTMLElement|null}
 */
function findStopButton() {
  return (
    document.querySelector('button[aria-label*="Stop"]') ||
    document.querySelector('[data-testid="stop-button"]') ||
    document.querySelector('button[aria-label*="stop"]') ||
    document.querySelector('button[aria-label="Zatrzymaj"]') ||
    document.querySelector('button[aria-label*="Zatrzymaj"]')
  );
}

/**
 * Znajduje przycisk Retry (po błędzie)
 * @returns {HTMLElement|null}
 */
function findRetryButton() {
  return document.querySelector('button[aria-label="Retry"]');
}

// ============================================
// 2. SPRAWDZANIE STANU
// ============================================

/**
 * Sprawdza czy ChatGPT generuje odpowiedź
 * @returns {boolean}
 */
function isChatGPTGenerating() {
  // Sprawdź przycisk Stop (wszystkie fallbacki)
  const stopButton = document.querySelector('button[aria-label*="Stop"]') ||
                     document.querySelector('[data-testid="stop-button"]') ||
                     document.querySelector('button[aria-label*="stop"]') ||
                     document.querySelector('button[aria-label="Zatrzymaj"]') ||
                     document.querySelector('button[aria-label*="Zatrzymaj"]');
  if (stopButton) return true;

  // Sprawdź stan edytora
  const editor = findEditor();
  const editorDisabled = editor && editor.getAttribute('contenteditable') === 'false';
  if (editorDisabled) return true;

  // Sprawdź przycisk Send
  const sendButton = findSendButton();
  if (sendButton && sendButton.disabled) return true;

  return false;
}

/**
 * Sprawdza czy interface jest gotowy do wysłania nowego prompta
 * @returns {boolean}
 */
function isInterfaceReady() {
  const editor = findEditor();
  const editorReady = editor && editor.getAttribute('contenteditable') === 'true';
  const noGeneration = !findStopButton();
  return noGeneration && editorReady;
}

/**
 * Sprawdza czy wystąpił błąd generowania
 * @returns {boolean}
 */
function hasGenerationError() {
  const errorMessages = document.querySelectorAll('[class*="text"]');
  for (const msg of errorMessages) {
    if (msg.textContent.includes('Something went wrong while generating the response')) {
      return true;
    }
  }
  return false;
}

// ============================================
// 3. WSTAWIANIE TEKSTU
// ============================================

/**
 * Wstawia tekst do edytora contenteditable
 * UWAGA: Wymaga await!
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function insertTextToEditor(text) {
  const editor = findEditor();
  if (!editor) {
    console.error('❌ Nie znaleziono edytora');
    return false;
  }

  try {
    // 1. Focus i pauza
    editor.focus();
    await new Promise(r => setTimeout(r, 300));

    // 2. Wyczyść zawartość (Selection API)
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('delete', false, null);

    // 3. Wymuś czyszczenie
    editor.innerHTML = '';
    editor.textContent = '';
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));

    await new Promise(r => setTimeout(r, 300));

    // 4. Wstaw tekst jako textNode
    const textNode = document.createTextNode(text);
    editor.appendChild(textNode);

    // 5. Przesuń kursor na koniec
    try {
      const selection2 = window.getSelection();
      const range2 = document.createRange();
      range2.selectNodeContents(editor);
      range2.collapse(false);
      selection2.removeAllRanges();
      selection2.addRange(range2);
    } catch (e) {
      console.warn('⚠️ Nie udało się przesunąć kursora:', e);
    }

    // 6. Triggeruj eventy (KRYTYCZNE!)
    editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText' }));
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    editor.dispatchEvent(new Event('change', { bubbles: true }));
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));

    console.log(`✅ Tekst wstawiony (${text.length} znaków)`);
    return true;

  } catch (error) {
    console.error('❌ Błąd wstawiania tekstu:', error);
    return false;
  }
}

// ============================================
// 4. WYSYŁANIE WIADOMOŚCI
// ============================================

/**
 * Czeka aż przycisk Send będzie enabled
 * @param {number} maxWaitMs - Maksymalny czas oczekiwania (ms)
 * @returns {Promise<boolean>}
 */
async function waitForSendButton(maxWaitMs = 10000) {
  let waitTime = 0;

  while (waitTime < maxWaitMs) {
    const sendButton = findSendButton();
    if (sendButton && !sendButton.disabled) {
      console.log(`✅ Przycisk Send gotowy (${waitTime}ms)`);
      return true;
    }

    // Loguj co 2s
    if (waitTime > 0 && waitTime % 2000 === 0) {
      console.log(`⏳ Czekam na przycisk Send... (${waitTime}ms / ${maxWaitMs}ms)`);
    }

    await new Promise(r => setTimeout(r, 100));
    waitTime += 100;
  }

  console.error(`❌ Timeout: Przycisk Send nie stał się aktywny po ${maxWaitMs}ms`);
  return false;
}

/**
 * Wysyła wiadomość (klika przycisk Send)
 * @returns {Promise<boolean>}
 */
async function clickSendButton() {
  const sendButton = findSendButton();

  if (!sendButton) {
    console.error('❌ Nie znaleziono przycisku Send');
    return false;
  }

  if (sendButton.disabled) {
    console.error('❌ Przycisk Send jest disabled');
    return false;
  }

  // Poczekaj na stabilizację UI
  await new Promise(r => setTimeout(r, 500));

  console.log('✅ Klikam Send...');
  sendButton.click();

  // Weryfikacja: Sprawdź czy kliknięcie zadziałało
  console.log('🔍 Weryfikuję czy prompt został wysłany...');
  let verifyTime = 0;
  const maxVerifyWait = 5000; // 5s

  while (verifyTime < maxVerifyWait) {
    const stopBtn = findStopButton();
    const editor = findEditor();
    const editorDisabled = editor && editor.getAttribute('contenteditable') === 'false';
    const editorEmpty = editor && (editor.textContent || '').trim().length === 0;
    const sendBtn = findSendButton();
    const sendDisabled = sendBtn && sendBtn.disabled;
    
    // Weryfikacja DOM: czy są wiadomości?
    const messages = document.querySelectorAll('[data-message-author-role]');
    const hasMessages = messages.length > 0;
    
    // GŁÓWNY wskaźnik: stopButton (najbardziej pewny)
    const hasStopButton = !!stopBtn;
    
    // ALTERNATYWNY: interface zablokowany + wiadomości w DOM
    const interfaceBlocked = (editorDisabled || (editorEmpty && sendDisabled)) && hasMessages;

    if (hasStopButton || interfaceBlocked) {
      console.log(`✅ Prompt faktycznie wysłany (${verifyTime}ms)`, {
        stopBtn: !!stopBtn,
        editorDisabled,
        hasMessages,
        msgCount: messages.length
      });
      return true;
    }

    await new Promise(r => setTimeout(r, 100));
    verifyTime += 100;
  }

  console.error(`❌ Kliknięcie Send nie zadziałało po ${maxVerifyWait}ms`);
  return false;
}

// ============================================
// 5. CZEKANIE NA ODPOWIEDŹ
// ============================================

/**
 * Czeka aż ChatGPT zakończy generowanie odpowiedzi
 * @param {number} maxWaitMs - Maksymalny czas oczekiwania (ms)
 * @returns {Promise<boolean>}
 */
async function waitForResponse(maxWaitMs = 600000) { // 10 minut
  const startTime = Date.now();
  let consecutiveReady = 0;
  let logInterval = 0;

  console.log('⏳ Czekam na zakończenie odpowiedzi ChatGPT...');

  // FAZA 1: Czekaj aż ChatGPT ZACZNIE generować
  let responseStarted = false;
  const startTimeout = Math.min(maxWaitMs, 300000); // Max 5 minut na start

  while (Date.now() - startTime < startTimeout) {
    if (isChatGPTGenerating()) {
      console.log('✅ ChatGPT zaczął generować odpowiedź');
      responseStarted = true;
      break;
    }

    // Loguj co 30s
    if ((Date.now() - startTime) % 30000 < 500) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`⏳ Czekam na start odpowiedzi... (${elapsed}s)`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  if (!responseStarted) {
    console.error(`❌ ChatGPT nie zaczął generować po ${startTimeout / 1000}s`);
    return false;
  }

  // FAZA 2: Czekaj aż ChatGPT ZAKOŃCZY generowanie
  while (Date.now() - startTime < maxWaitMs) {
    // Sprawdź błędy
    if (hasGenerationError()) {
      console.warn('⚠️ Wykryto błąd generowania');
      return false;
    }

    const ready = isInterfaceReady();

    if (ready) {
      consecutiveReady++;
      if (consecutiveReady >= 3) { // Potwierdź przez 3 sprawdzenia (1.5s)
        console.log('✅ ChatGPT zakończył odpowiedź - interface gotowy');
        await new Promise(r => setTimeout(r, 1000)); // Stabilizacja UI
        return true;
      }
    } else {
      consecutiveReady = 0;
    }

    // Loguj co 10 iteracji (5s)
    if (logInterval % 10 === 0 && logInterval > 0) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`⏳ Czekam na zakończenie... (${elapsed}s)`);
    }
    logInterval++;

    await new Promise(r => setTimeout(r, 500));
  }

  console.error(`❌ Timeout: Odpowiedź nie zakończyła się po ${maxWaitMs / 1000}s`);
  return false;
}

// ============================================
// 6. WYCIĄGANIE ODPOWIEDZI
// ============================================

/**
 * Wyciąga czysty tekst z elementu (bez źródeł/linków)
 * @param {HTMLElement} element
 * @returns {string}
 */
function extractMainContent(element) {
  const clone = element.cloneNode(true);

  // Usuń dodatkowe elementy
  const toRemove = [
    'ol[data-block-id]',        // Lista źródeł
    'div[class*="citation"]',   // Cytowania
    'div[class*="source"]',     // Źródła
    'a[target="_blank"]',       // Zewnętrzne linki
    'button',                   // Przyciski
    '[role="button"]'           // Role przyciski
  ];

  toRemove.forEach(selector => {
    clone.querySelectorAll(selector).forEach(el => el.remove());
  });

  const text = clone.textContent || clone.innerText || '';
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Wyciąga ostatnią odpowiedź ChatGPT z DOM
 * UWAGA: Funkcja async z retry loop - czeka na wyrenderowanie treści (max 4.5s)
 * @returns {Promise<string>}
 */
async function getLastResponseText() {
  console.log('🔍 Wyciągam ostatnią odpowiedź ChatGPT...');

  // RETRY LOOP - React może asynchronicznie renderować treść
  const maxRetries = 15;
  const retryDelay = 300; // 300ms = max 4.5s
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      console.log(`🔄 Retry ${attempt}/${maxRetries - 1} - czekam na renderowanie...`);
      await new Promise(r => setTimeout(r, retryDelay));
    }
    
    // Szukaj wiadomości asystenta
    const messages = document.querySelectorAll('[data-message-author-role="assistant"]');
    console.log(`🔍 Znaleziono ${messages.length} wiadomości assistant`);

    if (messages.length > 0) {
      const lastMessage = messages[messages.length - 1];

      // Sprawdź czy to nie thinking indicator
      const thinkingIndicators = lastMessage.querySelectorAll('[class*="thinking"]');
      if (thinkingIndicators.length > 0) {
        console.warn('⚠️ Ostatnia wiadomość zawiera thinking indicator');
        continue; // Retry
      }

      const text = extractMainContent(lastMessage);
      
      // Sukces - znaleziono niepustą odpowiedź
      if (text.length > 0) {
        console.log(`✅ Znaleziono odpowiedź: ${text.length} znaków (attempt ${attempt + 1})`);
        return text;
      }
      
      // Pusta - retry
      if (attempt < maxRetries - 1) {
        console.warn(`⚠️ Tekst pusty (attempt ${attempt + 1}) - retry...`);
      }
    }
  }

  // Fallback: szukaj przez article (z retry)
  console.log('🔍 Fallback: Szukam przez article...');
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 300));
    }
    
    const articles = document.querySelectorAll('article');
    console.log(`🔍 Fallback: Znaleziono ${articles.length} articles`);

    if (articles.length > 0) {
      const lastArticle = articles[articles.length - 1];
      const text = extractMainContent(lastArticle);
      if (text.length > 0) {
        console.log(`✅ Znaleziono odpowiedź (fallback): ${text.length} znaków`);
        return text;
      }
    }
  }

  console.error('❌ Nie znaleziono odpowiedzi ChatGPT w DOM po wszystkich próbach');
  return '';
}

// ============================================
// 7. EDYCJA WIADOMOŚCI
// ============================================

/**
 * Klika przycisk Edit w ostatniej wiadomości użytkownika
 * UWAGA: Wymaga await!
 * @returns {Promise<boolean>}
 */
async function clickEditButton() {
  const editButton = findEditButton();

  if (!editButton) {
    console.error('❌ Nie znaleziono przycisku Edit');
    return false;
  }

  console.log('✅ Znaleziono przycisk Edit');

  // Usuń klasy ukrywające
  if (editButton.classList.contains('invisible')) {
    editButton.classList.remove('invisible');
    console.log('✓ Usunięto klasę invisible');
  }
  if (editButton.classList.contains('hidden')) {
    editButton.classList.remove('hidden');
    console.log('✓ Usunięto klasę hidden');
  }

  // Wymuś widoczność przez style
  const originalStyle = editButton.style.cssText;
  editButton.style.visibility = 'visible';
  editButton.style.display = 'block';

  console.log('✓ Klikam przycisk Edit...');
  editButton.click();

  // Przywróć oryginalny styl
  setTimeout(() => {
    editButton.style.cssText = originalStyle;
  }, 100);

  // Czekaj na pojawienie się edytora
  await new Promise(r => setTimeout(r, 1000));

  return true;
}

/**
 * Edytuje ostatnią wiadomość i wysyła ponownie (Edit+Resend)
 * UWAGA: Wymaga await!
 * @returns {Promise<boolean>}
 */
async function editAndResendLastMessage() {
  try {
    console.log('🔧 Próbuję naprawić przez Edit+Resend...');

    // 1. Kliknij Edit
    const editSuccess = await clickEditButton();
    if (!editSuccess) {
      console.warn('⚠️ Nie udało się kliknąć Edit');
      return false;
    }

    // 2. Znajdź przycisk Send (pojawi się po Edit)
    let sendButton = findSendButton();
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
    await new Promise(r => setTimeout(r, 1000));

    console.log('✅ Edit+Resend wykonane pomyślnie');
    return true;

  } catch (error) {
    console.error('❌ Błąd w editAndResendLastMessage:', error);
    return false;
  }
}

// ============================================
// 8. KOMPLETNE FLOW
// ============================================

/**
 * Wysyła prompt do ChatGPT i czeka na odpowiedź
 * KOMPLETNY FLOW - gotowy do użycia
 *
 * @param {string} promptText - Tekst do wysłania
 * @param {number} responseTimeout - Maksymalny czas oczekiwania na odpowiedź (ms)
 * @returns {Promise<{success: boolean, responseText: string, error?: string}>}
 */
async function sendPromptAndGetResponse(promptText, responseTimeout = 600000) {
  try {
    console.log('=== ROZPOCZYNAM WYSYŁANIE PROMPTA ===');
    console.log(`Prompt: ${promptText.substring(0, 100)}...`);

    // 1. Czekaj na gotowość interfejsu
    console.log('🔍 Sprawdzam gotowość interfejsu...');
    let waitTime = 0;
    const maxInterfaceWait = 120000; // 2 minuty

    while (waitTime < maxInterfaceWait) {
      if (isInterfaceReady()) {
        console.log('✅ Interface gotowy');
        break;
      }
      await new Promise(r => setTimeout(r, 500));
      waitTime += 500;
    }

    if (!isInterfaceReady()) {
      return {
        success: false,
        responseText: '',
        error: 'Interface nie stał się gotowy w czasie'
      };
    }

    // 2. Wstaw tekst do edytora
    console.log('📝 Wstawiam tekst do edytora...');
    const inserted = await insertTextToEditor(promptText);
    if (!inserted) {
      return {
        success: false,
        responseText: '',
        error: 'Nie udało się wstawić tekstu do edytora'
      };
    }

    // 3. Czekaj na przycisk Send
    console.log('⏳ Czekam na przycisk Send...');
    const sendReady = await waitForSendButton(10000);
    if (!sendReady) {
      return {
        success: false,
        responseText: '',
        error: 'Przycisk Send nie stał się aktywny'
      };
    }

    // 4. Wyślij wiadomość
    console.log('📤 Wysyłam wiadomość...');
    const sent = await clickSendButton();
    if (!sent) {
      return {
        success: false,
        responseText: '',
        error: 'Nie udało się wysłać wiadomości'
      };
    }

    // 5. Czekaj na odpowiedź
    console.log('⏳ Czekam na odpowiedź ChatGPT...');
    const responseCompleted = await waitForResponse(responseTimeout);
    if (!responseCompleted) {
      return {
        success: false,
        responseText: '',
        error: 'Timeout czekania na odpowiedź'
      };
    }

    // 6. Wyciągnij odpowiedź
    console.log('📥 Wyciągam odpowiedź...');
    const responseText = await getLastResponseText();

    if (!responseText || responseText.length < 10) {
      console.warn('⚠️ Odpowiedź jest pusta lub za krótka');
      return {
        success: false,
        responseText: responseText,
        error: 'Odpowiedź jest pusta lub za krótka'
      };
    }

    console.log('✅ Sukces! Otrzymano odpowiedź:', responseText.substring(0, 200) + '...');
    return {
      success: true,
      responseText: responseText
    };

  } catch (error) {
    console.error('❌ Błąd w sendPromptAndGetResponse:', error);
    return {
      success: false,
      responseText: '',
      error: error.message
    };
  }
}

// ============================================
// EKSPORT (jeśli używasz modułów)
// ============================================

// Dla użycia w Chrome Extension:
// await chrome.scripting.executeScript({
//   target: { tabId: chatTabId },
//   function: sendPromptAndGetResponse,
//   args: ["Twój prompt tutaj", 600000]
// });
