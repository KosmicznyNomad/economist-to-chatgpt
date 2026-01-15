# Struktura DOM ChatGPT - Dokumentacja Techniczna

Data ostatniej aktualizacji: Styczeń 2025

## Spis treści
1. [Przegląd](#przegląd)
2. [Edytor wiadomości](#edytor-wiadomości)
3. [Przyciski akcji](#przyciski-akcji)
4. [Wiadomości w konwersacji](#wiadomości-w-konwersacji)
5. [Stany interfejsu](#stany-interfejsu)
6. [Best Practices](#best-practices)
7. [Częste problemy](#częste-problemy)

---

## Przegląd

ChatGPT używa dynamicznego interfejsu React z częstymi zmianami struktury DOM. Ta dokumentacja zawiera najważniejsze selektory CSS i metody interakcji z UI, które są stosunkowo stabilne.

### Podstawowe informacje
- **URL**: https://chatgpt.com/
- **Framework**: React (dynamiczny rendering)
- **Typ edytora**: `contenteditable` div (NIE textarea!)
- **Atrybuty identyfikacyjne**: `data-testid`, `aria-label`, `role`, `data-message-author-role`

---

## Edytor wiadomości

### Główny edytor tekstu

ChatGPT używa **contenteditable div** zamiast tradycyjnego textarea.

#### Selektory (priorytet malejący):
```javascript
// Metoda 1: Role + contenteditable (najbardziej niezawodna)
const editor = document.querySelector('[role="textbox"][contenteditable="true"]');

// Metoda 2: contenteditable div (fallback)
const editor = document.querySelector('div[contenteditable="true"]');

// Metoda 3: data-testid (może się zmieniać)
const editor = document.querySelector('[data-testid="composer-input"]');

// Metoda 4: Dowolny edytor (najszerszy zakres)
const editor = document.querySelector('[contenteditable]');
const editor = document.querySelector('[role="textbox"]');
```

#### Selektory z alternatywnych źródeł (fallbacki):
```javascript
// Fallback z community (październik 2025)
const editor = document.querySelector('textarea#prompt-textarea');

// Fallback dla starszych wersji
const editor = document.querySelector('[data-testid="composer-input"]');
```

**Uwaga**: `textarea#prompt-textarea` może być bardziej stabilne w przyszłych wersjach ChatGPT.

### Wstawianie tekstu do edytora

⚠️ **WAŻNE**: Zwykłe `element.value = text` NIE DZIAŁA z contenteditable!

```javascript
// Krok 1: Focus i wyczyść
editor.focus();
await new Promise(r => setTimeout(r, 300));

// Krok 2: Wyczyść zawartość (metoda Selection API)
const selection = window.getSelection();
const range = document.createRange();
range.selectNodeContents(editor);
selection.removeAllRanges();
selection.addRange(range);
document.execCommand('delete', false, null);

// Alternatywnie: Wymuś czyszczenie
editor.innerHTML = '';
editor.textContent = '';

// Krok 3: Wstaw tekst jako textNode
const textNode = document.createTextNode(text);
editor.appendChild(textNode);

// Krok 4: Przesuń kursor na koniec
const range2 = document.createRange();
range2.selectNodeContents(editor);
range2.collapse(false);
selection.removeAllRanges();
selection.addRange(range2);

// Krok 5: Triggeruj eventy (KRYTYCZNE!)
editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText' }));
editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
editor.dispatchEvent(new Event('change', { bubbles: true }));
editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
```

### Sprawdzanie stanu edytora

```javascript
// Czy edytor jest aktywny (można pisać)?
const isActive = editor.getAttribute('contenteditable') === 'true';

// Czy edytor jest zablokowany (ChatGPT generuje odpowiedź)?
const isDisabled = editor.getAttribute('contenteditable') === 'false';

// Czy edytor jest pusty?
const isEmpty = (editor.textContent || '').trim().length === 0;
```

---

## Przyciski akcji

### 1. Przycisk Send (Wyślij)

#### Selektory:
```javascript
// Metoda 1: data-testid (preferowana)
const sendButton = document.querySelector('[data-testid="send-button"]');

// Metoda 2: ID
const sendButton = document.querySelector('#composer-submit-button');

// Metoda 3: aria-label
const sendButton = document.querySelector('button[aria-label="Send"]');
const sendButton = document.querySelector('button[aria-label*="Send"]'); // Zawiera "Send"

// Metoda 4: Wildcard data-testid
const sendButton = document.querySelector('button[data-testid*="send"]');
```

#### Sprawdzanie stanu:
```javascript
// Czy przycisk jest aktywny?
const canSend = sendButton && !sendButton.disabled;

// Czekanie na aktywację (po wstawieniu tekstu):
let waitTime = 0;
const maxWait = 10000; // 10 sekund
while (waitTime < maxWait) {
  const btn = document.querySelector('[data-testid="send-button"]');
  if (btn && !btn.disabled) {
    break; // Gotowy!
  }
  await new Promise(r => setTimeout(r, 100));
  waitTime += 100;
}
```

#### Wysyłanie wiadomości:
```javascript
// Poczekaj na stabilizację UI
await new Promise(r => setTimeout(r, 500));

// Kliknij
sendButton.click();

// Weryfikacja wysłania (sprawdź czy UI się zmienił):
let verified = false;
let verifyTime = 0;
const maxVerifyWait = 5000;

while (verifyTime < maxVerifyWait) {
  // Wszystkie fallbacki dla stopButton
  const stopBtn = document.querySelector('button[aria-label*="Stop"]') ||
                  document.querySelector('[data-testid="stop-button"]') ||
                  document.querySelector('button[aria-label*="stop"]') ||
                  document.querySelector('button[aria-label="Zatrzymaj"]');
  
  const editorNow = document.querySelector('[role="textbox"]') ||
                    document.querySelector('[contenteditable]');
  const editorDisabled = editorNow && editorNow.getAttribute('contenteditable') === 'false';
  
  // Weryfikacja DOM: czy są wiadomości?
  const messages = document.querySelectorAll('[data-message-author-role]');
  const hasMessages = messages.length > 0;
  
  // GŁÓWNY warunek: stopButton (najbardziej pewny)
  // ALTERNATYWNY: editorDisabled + wiadomości w DOM
  if (stopBtn || (editorDisabled && hasMessages)) {
    console.log('✅ Wiadomość wysłana');
    verified = true;
    break;
  }
  
  await new Promise(r => setTimeout(r, 100));
  verifyTime += 100;
}

if (!verified) {
  console.error('❌ Wysłanie nie powiodło się');
}
```

### 2. Przycisk Edit (Edytuj wiadomość)

⚠️ **ZNANY PROBLEM**: Przycisk Edit jest często ukryty (CSS: `display: none` lub klasy `invisible`, `hidden`)

#### Selektory:
```javascript
// Najpierw znajdź wiadomość użytkownika
const userMessages = document.querySelectorAll('[data-message-author-role="user"]');
const lastUserMessage = userMessages[userMessages.length - 1];

// Szukaj przycisku Edit w tej wiadomości
let editButton = lastUserMessage.querySelector('button[aria-label="Edit message"]');

// Fallback selektory:
if (!editButton) {
  editButton = lastUserMessage.querySelector('button.right-full[aria-label*="Edit"]');
}
if (!editButton) {
  editButton = lastUserMessage.querySelector('button[aria-label*="Edit"]');
}
```

#### Wymuszanie widoczności:
```javascript
// Usuń klasy ukrywające
if (editButton.classList.contains('invisible')) {
  editButton.classList.remove('invisible');
}
if (editButton.classList.contains('hidden')) {
  editButton.classList.remove('hidden');
}

// Wymuś widoczność przez style
const originalStyle = editButton.style.cssText;
editButton.style.visibility = 'visible';
editButton.style.display = 'block';

// Kliknij
editButton.click();

// Przywróć oryginalny styl (opcjonalnie)
setTimeout(() => {
  editButton.style.cssText = originalStyle;
}, 100);
```

#### Dodatkowe fallbacki (październik 2025):
```javascript
// Lokalizacja polska
editButton = lastUserMessage.querySelector('button[aria-label*="Edytuj"]');

// Szukanie w conversation-turn container
const turnContainer = lastUserMessage.closest('[data-testid^="conversation-turn-"]');
editButton = turnContainer?.querySelector('button[aria-label*="Edit"]');

// Szukanie w toolbar
const toolbar = lastUserMessage.querySelector('[role="toolbar"]');
editButton = toolbar?.querySelector('button[aria-label*="Edit"]');

// Symulacja hover (pokazuje ukryte przyciski)
lastUserMessage.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
```

#### Po kliknięciu Edit:
```javascript
// Czekaj na pojawienie się edytora
await new Promise(r => setTimeout(r, 1000));

// Znajdź przycisk Send (pojawi się w trybie edycji)
const sendButton = document.querySelector('[data-testid="send-button"]');
if (sendButton && !sendButton.disabled) {
  sendButton.click(); // Wyślij edytowaną wiadomość
}
```

### 3. Przycisk Stop (Zatrzymaj generowanie)

```javascript
// Selektory:
const stopButton = document.querySelector('button[aria-label*="Stop"]');
const stopButton = document.querySelector('[data-testid="stop-button"]');
const stopButton = document.querySelector('button[aria-label*="stop"]'); // lowercase

// Sprawdzenie czy ChatGPT generuje odpowiedź:
const isGenerating = !!stopButton;
```

### 3a. Wskaźniki Generowania (Nowy UI - Styczeń 2026)

ChatGPT może wyświetlać różne wskaźniki podczas generowania odpowiedzi, szczególnie w chain-of-thought modelach:

```javascript
// Funkcja sprawdzająca czy ChatGPT generuje (rozszerzona detekcja)
function isGenerating() {
  // 1. Stop button (klasyczny)
  const stopButton = document.querySelector('button[aria-label*="Stop"]') || 
                     document.querySelector('[data-testid="stop-button"]');
  if (stopButton) return { generating: true, reason: 'stopButton' };
  
  // 2. Thinking indicators (nowy UI)
  const thinkingIndicators = document.querySelector('[class*="thinking"]') ||
                            document.querySelector('[class*="Thinking"]') ||
                            document.querySelector('[data-testid*="thinking"]') ||
                            document.querySelector('[aria-label*="Thinking"]');
  if (thinkingIndicators) return { generating: true, reason: 'thinking' };
  
  // 3. Update indicators
  const updateIndicators = document.querySelector('[aria-label*="Update"]') ||
                          document.querySelector('[aria-label*="update"]') ||
                          document.querySelector('[class*="updating"]');
  if (updateIndicators) return { generating: true, reason: 'update' };
  
  // 4. Streaming indicators
  const streamingIndicators = document.querySelector('[class*="streaming"]') ||
                             document.querySelector('[data-testid*="streaming"]');
  if (streamingIndicators) return { generating: true, reason: 'streaming' };
  
  // 5. Typing/Loading indicators
  const typingIndicators = document.querySelector('[class*="typing"]') ||
                          document.querySelector('[class*="loading"]');
  if (typingIndicators) return { generating: true, reason: 'typing' };
  
  return { generating: false, reason: 'none' };
}

// Sprawdź thinking indicators w ostatniej wiadomości
const lastMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
const hasThinkingInMessage = lastMessages.length > 0 && 
  lastMessages[lastMessages.length - 1].querySelector('[class*="thinking"]');
```

**Kluczowe wskaźniki:**
- `[class*="thinking"]` - Model myśli przed odpowiedzią (chain-of-thought)
- `[class*="updating"]` - UI aktualizuje odpowiedź w locie
- `[class*="streaming"]` - Streaming odpowiedzi w toku
- `[aria-label*="Update"]` - Przycisk/wskaźnik aktualizacji

### 4. Przycisk Retry (Ponów)

```javascript
// Pojawia się po błędzie generowania
const retryButton = document.querySelector('button[aria-label="Retry"]');

// Szukanie w kontekście komunikatu błędu:
const errorMsg = document.querySelector('[class*="text"]'); // Zawiera "Something went wrong..."
if (errorMsg) {
  const retryBtn = errorMsg.parentElement?.querySelector('button[aria-label="Retry"]');
  const retryBtn = errorMsg.closest('[class*="group"]')?.querySelector('button[aria-label="Retry"]');
}
```

### 5. Przycisk Continue (Kontynuuj)

```javascript
// Pojawia się gdy odpowiedź została przerwana
const continueButton = document.querySelector('button[aria-label="Continue"]');
const continueButton = document.querySelector('button[aria-label*="Continue"]');
```

---

## Wiadomości w konwersacji

### Wiadomości użytkownika

```javascript
// Wszystkie wiadomości użytkownika
const userMessages = document.querySelectorAll('[data-message-author-role="user"]');

// Ostatnia wiadomość użytkownika
const lastUserMessage = userMessages[userMessages.length - 1];

// Tekst wiadomości
const messageText = lastUserMessage.textContent || lastUserMessage.innerText;
```

### Wiadomości asystenta (ChatGPT)

```javascript
// Wszystkie odpowiedzi ChatGPT
const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');

// Ostatnia odpowiedź ChatGPT
const lastResponse = assistantMessages[assistantMessages.length - 1];

// Wyciągnij tekst (bez źródeł/linków)
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

const responseText = extractMainContent(lastResponse);
```

### Turny konwersacji (Conversation Turns)

ChatGPT organizuje rozmowę w "turny" - pary user/assistant message.

```javascript
// Znajdź wszystkie turny
const turns = document.querySelectorAll('[data-testid^="conversation-turn-"]');

// Znajdź ostatni turn z assistant
for (let i = turns.length - 1; i >= 0; i--) {
  const assistantMsg = turns[i].querySelector('[data-message-author-role="assistant"]');
  if (assistantMsg) {
    console.log('Znaleziono ostatnią odpowiedź assistant');
    break;
  }
}
```

**Stabilność**: Selektor `[data-testid^="conversation-turn-"]` jest często używany w community extensions i userscripts.

### Fallback: Wyszukiwanie przez article

```javascript
// Jeśli data-message-author-role nie działa
const articles = document.querySelectorAll('article');
const lastArticle = articles[articles.length - 1];
const text = extractMainContent(lastArticle);
```

---

## Stany interfejsu

### Sprawdzanie czy ChatGPT generuje odpowiedź

**AKTUALIZACJA STYCZEŃ 2026**: Rozszerzona detekcja z nowymi wskaźnikami (thinking, update, streaming).

```javascript
function isChatGPTGenerating() {
  // 1. Sprawdź przycisk Stop (klasyczny)
  const stopButton = document.querySelector('button[aria-label*="Stop"]') ||
                     document.querySelector('[data-testid="stop-button"]') ||
                     document.querySelector('button[aria-label*="stop"]') ||
                     document.querySelector('button[aria-label="Zatrzymaj"]');
  if (stopButton) return { generating: true, reason: 'stopButton' };

  // 2. Thinking indicators (NOWY UI)
  const thinkingIndicators = document.querySelector('[class*="thinking"]') ||
                            document.querySelector('[class*="Thinking"]') ||
                            document.querySelector('[data-testid*="thinking"]');
  if (thinkingIndicators) return { generating: true, reason: 'thinking' };

  // 3. Update indicators (NOWY UI)
  const updateIndicators = document.querySelector('[aria-label*="Update"]') ||
                          document.querySelector('[aria-label*="update"]') ||
                          document.querySelector('[class*="updating"]');
  if (updateIndicators) return { generating: true, reason: 'update' };

  // 4. Streaming indicators
  const streamingIndicators = document.querySelector('[class*="streaming"]') ||
                             document.querySelector('[data-testid*="streaming"]');
  if (streamingIndicators) return { generating: true, reason: 'streaming' };

  // 5. Sprawdź stan edytora (fallback)
  const editor = document.querySelector('[role="textbox"]') ||
                 document.querySelector('[contenteditable]');
  const editorDisabled = editor && editor.getAttribute('contenteditable') === 'false';
  if (editorDisabled) return { generating: true, reason: 'editorDisabled' };

  return { generating: false, reason: 'none' };
}

// Użycie
const status = isChatGPTGenerating();
if (status.generating) {
  console.log(`ChatGPT generuje: ${status.reason}`);
}
```

### Czekanie na zakończenie odpowiedzi

**AKTUALIZACJA STYCZEŃ 2026**: Timeout zwiększony do 60 minut, rozszerzona detekcja wskaźników.

```javascript
async function waitForChatGPTResponse(maxWaitMs = 3600000) { // 60 minut (zwiększono z 10 min)
  const startTime = Date.now();
  
  // FAZA 1: Czekaj aż ChatGPT ZACZNIE generować
  console.log('⏳ FAZA 1: Czekam na start odpowiedzi...');
  let responseStarted = false;
  const startTimeout = Math.min(maxWaitMs, 3600000); // Max 60 minut na start (zwiększono z 5 min)
  
  while (Date.now() - startTime < startTimeout) {
    // Fallbacki dla stopButton
    const stopButton = document.querySelector('button[aria-label*="Stop"]') ||
                      document.querySelector('[data-testid="stop-button"]') ||
                      document.querySelector('button[aria-label*="stop"]') ||
                      document.querySelector('button[aria-label*="Zatrzymaj"]');
    
    const editor = document.querySelector('[role="textbox"]') ||
                   document.querySelector('[contenteditable]');
    const editorDisabled = editor && editor.getAttribute('contenteditable') === 'false';
    
    // Weryfikacja DOM: czy jest nowa treść?
    const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
    const hasNewContent = assistantMessages.length > 0;
    
    // GŁÓWNY wskaźnik: stopButton (najbardziej pewny)
    const hasStopButton = !!stopButton;
    
    // ALTERNATYWNY wskaźnik: interface zablokowany + nowa treść w DOM
    const interfaceBlocked = editorDisabled && hasNewContent;
    
    if (hasStopButton || interfaceBlocked) {
      console.log('✅ ChatGPT zaczął generować');
      responseStarted = true;
      break;
    }
    
    await new Promise(r => setTimeout(r, 500));
  }
  
  if (!responseStarted) {
    console.error('❌ ChatGPT nie zaczął odpowiadać - prompt nie został wysłany');
    return false;
  }
  
  // FAZA 2: Czekaj aż ChatGPT ZAKOŃCZY generowanie
  console.log('⏳ FAZA 2: Czekam na zakończenie odpowiedzi...');
  let consecutiveReady = 0;

  while (Date.now() - startTime < maxWaitMs) {
    // Sprawdź czy interface jest gotowy
    const editor = document.querySelector('[role="textbox"][contenteditable="true"]');
    const stopButton = document.querySelector('button[aria-label*="Stop"]') ||
                      document.querySelector('[data-testid="stop-button"]');

    const editorReady = editor && editor.getAttribute('contenteditable') === 'true';
    const noGeneration = !stopButton;
    const isReady = noGeneration && editorReady;

    if (isReady) {
      consecutiveReady++;
      if (consecutiveReady >= 3) { // Potwierdź przez 3 sprawdzenia (1.5s)
        console.log('✅ ChatGPT zakończył odpowiedź');
        await new Promise(r => setTimeout(r, 1000)); // Stabilizacja UI
        
        // Weryfikacja finalna: czy faktycznie jest odpowiedź?
        const messages = document.querySelectorAll('[data-message-author-role="assistant"]');
        if (messages.length > 0) {
          return true;
        } else {
          console.warn('⚠️ Interface gotowy ale brak odpowiedzi w DOM');
          return true; // Kontynuuj mimo wszystko
        }
      }
    } else {
      consecutiveReady = 0;
    }

    await new Promise(r => setTimeout(r, 500));
  }

  console.error('❌ Timeout');
  return false;
}
```

### Sprawdzanie komunikatów błędów

```javascript
function checkForErrors() {
  const errorMessages = document.querySelectorAll('[class*="text"]');
  for (const msg of errorMessages) {
    if (msg.textContent.includes('Something went wrong while generating the response')) {
      return true; // Znaleziono błąd
    }
  }
  return false;
}
```

---

## Best Practices

### 1. Zawsze używaj fallback selektorów

```javascript
const editor =
  document.querySelector('[role="textbox"][contenteditable="true"]') ||
  document.querySelector('div[contenteditable="true"]') ||
  document.querySelector('[data-testid="composer-input"]');
```

### 2. Triggeruj eventy po zmianie DOM

```javascript
// Po wstawieniu tekstu do contenteditable:
editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
editor.dispatchEvent(new Event('change', { bubbles: true }));
```

### 3. Czekaj na stabilizację UI

```javascript
// Po każdej akcji (click, wstawienie tekstu):
await new Promise(r => setTimeout(r, 300-500));
```

### 4. Weryfikuj czy akcja się powiodła

```javascript
// Po kliknięciu Send, sprawdź czy faktycznie wysłano:
await new Promise(r => setTimeout(r, 1000));
const sent = isChatGPTGenerating(); // Funkcja z sekcji "Stany interfejsu"
if (!sent) {
  console.error('❌ Wysłanie nie powiodło się');
}
```

### 5. Używaj retry logic

```javascript
let attempts = 0;
const maxAttempts = 3;
while (attempts < maxAttempts) {
  const success = await tryAction();
  if (success) break;

  attempts++;
  await new Promise(r => setTimeout(r, 1000 * attempts)); // Exponential backoff
}
```

### 6. Loguj szczegóły debugowania

```javascript
console.log('🔍 Stan interfejsu:', {
  editor_exists: !!editor,
  editor_enabled: editor?.getAttribute('contenteditable') === 'true',
  sendButton_exists: !!sendButton,
  sendButton_disabled: sendButton?.disabled,
  isGenerating: isChatGPTGenerating()
});
```

### 7. Cachuj już sprawdzone błędy

```javascript
// W długich pętlach czekania (FAZA 1, FAZA 2)
const checkedFixedErrors = new Set();

while (czekaj...) {
  const lastError = findLastError();
  if (lastError) {
    const errorId = `${errorIndex}_${errorText.substring(0, 50)}`;
    
    if (checkedFixedErrors.has(errorId)) {
      // Ciche pominięcie - nie spamuj logów
    } else {
      // Sprawdź błąd i dodaj do cache
      if (errorAlreadyFixed) {
        checkedFixedErrors.add(errorId);
      }
    }
  }
}
```

**Dlaczego**: Stare komunikaty błędów mogą pozostawać w DOM. Bez cache system sprawdza je w każdej iteracji (co 500ms), generując spam w logach.

---

## Częste problemy

### Problem 1: Przycisk Edit jest ukryty

**Rozwiązanie**: Wymuś widoczność przed kliknięciem

```javascript
editButton.classList.remove('invisible', 'hidden');
editButton.style.visibility = 'visible';
editButton.style.display = 'block';
editButton.click();
```

### Problem 2: Tekst w contenteditable nie triggeruje Send

**Rozwiązanie**: Użyj textNode + triggeruj eventy

```javascript
const textNode = document.createTextNode(text);
editor.appendChild(textNode);
editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
```

### Problem 3: False positive - detektor uważa że wysłano ale nic się nie stało

**Objaw**: Mechanizm wykrywania stwierdza że prompt został wysłany i odpowiedź rozpoczęta, ale faktycznie ChatGPT nie zaczął odpowiadać.

**Przyczyna**: Interface przejściowo blokuje się zaraz po kliknięciu Send (editor staje się disabled, sendButton disabled), ale to nie oznacza że wiadomość faktycznie została wysłana. Może to być tylko chwilowa reakcja UI.

**Rozwiązanie**: Weryfikuj WIELOMA wskaźnikami naraz

```javascript
// ❌ ZŁE - słabe warunki
const editorDisabled = editor.getAttribute('contenteditable') === 'false';
if (editorDisabled) {
  // Może być false positive!
  return true;
}

// ✅ DOBRE - mocne warunki z weryfikacją DOM
const stopButton = document.querySelector('button[aria-label*="Stop"]') ||
                   document.querySelector('[data-testid="stop-button"]');

const editorDisabled = editor && editor.getAttribute('contenteditable') === 'false';

// Weryfikacja: czy faktycznie jest treść w DOM?
const messages = document.querySelectorAll('[data-message-author-role]');
const hasMessages = messages.length > 0;

// GŁÓWNY wskaźnik (najbardziej pewny)
const hasStopButton = !!stopButton;

// ALTERNATYWNY (wymaga wielu warunków)
const interfaceBlocked = editorDisabled && hasMessages;

// Akceptuj TYLKO jeśli stopButton LUB (interface zablokowany + są wiadomości)
if (hasStopButton || interfaceBlocked) {
  return true;
}
```

**Kluczowe zasady**:
1. **stopButton** jest najbardziej wiarygodnym wskaźnikiem - jeśli istnieje, ChatGPT NA PEWNO generuje
2. Inne wskaźniki (editorDisabled, sendDisabled) MUSZĄ być połączone z weryfikacją DOM
3. Sprawdź czy faktycznie są wiadomości w DOM (`[data-message-author-role]`)
4. Dodaj wszystkie fallbacki dla stopButton (włącznie z polską lokalizacją)

### Problem 4: Send button nie staje się enabled

**Rozwiązanie**: Czekaj dłużej (do 10 sekund) + triggeruj więcej eventów

```javascript
editor.dispatchEvent(new InputEvent('beforeinput', { bubbles: true }));
editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
editor.dispatchEvent(new Event('change', { bubbles: true }));
editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));

// Czekaj
let waitTime = 0;
while (waitTime < 10000) {
  if (sendButton && !sendButton.disabled) break;
  await new Promise(r => setTimeout(r, 100));
  waitTime += 100;
}
```

### Problem 5: ChatGPT nie zaczyna odpowiadać po wysłaniu

**Rozwiązanie**: Sprawdź komunikaty błędów + użyj Edit+Resend lub Retry

```javascript
if (checkForErrors()) {
  // Spróbuj Edit+Resend (patrz sekcja "Przycisk Edit")
  const retryButton = document.querySelector('button[aria-label="Retry"]');
  if (retryButton) {
    retryButton.click();
  }
}
```

### Problem 6: Timeout przy długich odpowiedziach (chain-of-thought)

**AKTUALIZACJA STYCZEŃ 2026**: Timeout zwiększony do 60 minut dla bardzo długich odpowiedzi.

**Rozwiązanie**: Zwiększ timeout + detekcja dwufazowa (start + koniec) + rozszerzone wskaźniki

```javascript
// Faza 1: Czekaj na START generowania (może trwać nawet 20+ minut dla skomplikowanych pytań)
const MAX_START_WAIT = 3600000; // 60 minut (zwiększono z 20 min)
while (Date.now() - startTime < MAX_START_WAIT) {
  const genStatus = isChatGPTGenerating();
  if (genStatus.generating) {
    console.log(`Generowanie rozpoczęte: ${genStatus.reason}`);
    break; // Zaczął!
  }
  await new Promise(r => setTimeout(r, 500));
}

// Faza 2: Czekaj na KONIEC generowania
await waitForChatGPTResponse(3600000); // 60 minut (zwiększono z 20 min)
```

**UWAGA**: Chain-of-thought modele (o1, o1-pro) mogą myśleć nawet 10-20 minut przed rozpoczęciem odpowiedzi. Nowe wskaźniki (thinking, update) pomagają wykryć że model nadal pracuje.

### Problem 7: Wiadomości są puste po wyciągnięciu (length 0)

**Objaw**: `waitForResponse()` kończy się sukcesem (interface gotowy), ale wyekstrahowany tekst ma długość 0 znaków.

**Przyczyna**: React renderuje DOM asynchronicznie. Nawet jeśli interface jest gotowy (editor enabled, brak stopButton), treść odpowiedzi może jeszcze być w trakcie renderowania w DOM.

**Rozwiązanie**: Retry loop w funkcji ekstrakcji tekstu

```javascript
async function getLastResponseText() {
  const maxRetries = 15; // 15 prób
  const retryDelay = 300; // 300ms między próbami = max 4.5s
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      console.log(`🔄 Retry ${attempt} - czekam na renderowanie treści...`);
      await new Promise(r => setTimeout(r, retryDelay));
    }
    
    const messages = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      
      // Sprawdź thinking indicators
      const thinkingIndicators = lastMessage.querySelectorAll('[class*="thinking"]');
      if (thinkingIndicators.length > 0) {
        console.warn('⚠️ ChatGPT jeszcze myśli...');
        continue; // Retry
      }
      
      const text = extractMainContent(lastMessage);
      
      // Sukces - znaleziono niepustą odpowiedź
      if (text.length > 0) {
        console.log(`✅ Znaleziono odpowiedź: ${text.length} znaków`);
        return text;
      }
      
      // Pusta - retry (chyba że ostatnia próba)
      if (attempt < maxRetries - 1) {
        console.warn(`⚠️ Tekst pusty (attempt ${attempt + 1}) - retry...`);
      }
    }
  }
  
  console.error('❌ Nie znaleziono treści po wszystkich próbach');
  return '';
}
```

**Kluczowe zasady**:
1. **NIE** wyciągaj tekstu natychmiast po `waitForResponse()`
2. Dodaj retry loop z opóźnieniem 200-500ms między próbami
3. Sprawdź czy element nie zawiera tylko thinking indicators
4. Akceptuj tylko niepuste wyniki (length > 0)
5. Funkcja ekstrakcji **MUSI** być `async` z `await` w retry loop

---

## Przykładowy kod: Kompletny flow wysłania promptu

```javascript
async function sendPromptToChatGPT(promptText) {
  // 1. Czekaj na gotowość interfejsu
  console.log('🔍 Sprawdzam gotowość...');
  while (isChatGPTGenerating()) {
    await new Promise(r => setTimeout(r, 500));
  }

  // 2. Znajdź edytor
  const editor =
    document.querySelector('[role="textbox"][contenteditable="true"]') ||
    document.querySelector('div[contenteditable="true"]');

  if (!editor) {
    throw new Error('Nie znaleziono edytora');
  }

  // 3. Wyczyść i wstaw tekst
  editor.focus();
  await new Promise(r => setTimeout(r, 300));

  editor.innerHTML = '';
  editor.textContent = '';

  const textNode = document.createTextNode(promptText);
  editor.appendChild(textNode);

  // 4. Triggeruj eventy
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  editor.dispatchEvent(new Event('change', { bubbles: true }));

  // 5. Czekaj na przycisk Send
  let waitTime = 0;
  let sendButton = null;
  while (waitTime < 10000) {
    sendButton = document.querySelector('[data-testid="send-button"]');
    if (sendButton && !sendButton.disabled) break;
    await new Promise(r => setTimeout(r, 100));
    waitTime += 100;
  }

  if (!sendButton || sendButton.disabled) {
    throw new Error('Przycisk Send nie jest dostępny');
  }

  // 6. Wyślij
  await new Promise(r => setTimeout(r, 500));
  sendButton.click();

  // 7. Weryfikuj wysłanie
  let verified = false;
  let verifyTime = 0;
  const maxVerifyWait = 5000;
  
  while (verifyTime < maxVerifyWait) {
    const stopBtn = document.querySelector('button[aria-label*="Stop"]') ||
                    document.querySelector('[data-testid="stop-button"]');
    const editorNow = document.querySelector('[role="textbox"]');
    const editorDisabled = editorNow && editorNow.getAttribute('contenteditable') === 'false';
    const messages = document.querySelectorAll('[data-message-author-role]');
    
    // stopButton (pewny) LUB (editorDisabled + wiadomości w DOM)
    if (stopBtn || (editorDisabled && messages.length > 0)) {
      verified = true;
      break;
    }
    
    await new Promise(r => setTimeout(r, 100));
    verifyTime += 100;
  }
  
  if (!verified) {
    throw new Error('Wysłanie nie powiodło się');
  }

  // 8. Czekaj na odpowiedź
  const success = await waitForChatGPTResponse(600000); // 10 minut
  if (!success) {
    throw new Error('Timeout czekania na odpowiedź');
  }

  // 9. Wyciągnij odpowiedź
  const assistantMessages = document.querySelectorAll('[data-message-author-role="assistant"]');
  const lastResponse = assistantMessages[assistantMessages.length - 1];
  const responseText = extractMainContent(lastResponse);

  return responseText;
}
```

---

## Aktualizacje i zmiany

### Styczeń 2026 (NOWA WERSJA)
**Główne zmiany dla wsparcia długich odpowiedzi i nowego UI:**

- **Timeout zwiększony do 60 minut** (z 20 minut) dla bardzo długich odpowiedzi chain-of-thought
  - Faza 1 (start): 60 minut (z 30 minut)
  - Faza 2 (koniec): 60 minut całkowity czas
  - `WAIT_FOR_RESPONSE_MS = 3600000` (z 1200000)

- **Nowa funkcja `isGenerating()`** z rozszerzoną detekcją wskaźników:
  - Thinking indicators: `[class*="thinking"]`, `[data-testid*="thinking"]`
  - Update indicators: `[aria-label*="Update"]`, `[class*="updating"]`
  - Streaming indicators: `[class*="streaming"]`, `[data-testid*="streaming"]`
  - Typing/Loading indicators: `[class*="typing"]`, `[class*="loading"]`
  - Funkcja zwraca obiekt `{generating: bool, reason: string}` dla lepszego debugowania

- **Wzmocniona detekcja w Fazie 2:**
  - Sprawdzanie thinking indicators w ostatniej wiadomości
  - Warunek: `noGeneration && editorReady && !hasThinkingInMessage`
  - Eliminuje false positives gdy model jeszcze "myśli"

- **Rozszerzone logowanie rozmiaru odpowiedzi:**
  - Liczba znaków, KB, słów, linii
  - Flagi `isLarge` (>10KB), `isVeryLarge` (>50KB)
  - Ostrzeżenia dla bardzo krótkich odpowiedzi (<50 znaków)

- **Ulepszona diagnostyka:**
  - Logowanie co 30s w Fazie 1 z pełnym statusem generowania
  - Logowanie co 5s w Fazie 2 z powodem detekcji (`genReason`)
  - Szczegółowe logi przy resetowaniu licznika gotowości

**Dlaczego te zmiany:**
- Modele chain-of-thought (o1, o1-pro) mogą myśleć 10-20+ minut przed odpowiedzią
- Nowy UI ChatGPT pokazuje wskaźniki "thinking", "updating" podczas generowania
- Stary timeout (20 min) był zbyt krótki dla bardzo skomplikowanych analiz
- Brak detekcji nowych wskaźników powodował przedwczesne wysyłanie kolejnych promptów

### Październik 2025
- Naprawiono problem false positives w detekcji wysłania wiadomości
- Naprawiono problem pustych odpowiedzi (length 0) poprzez dodanie retry loop w ekstrakcji tekstu
- Naprawiono spam logów z "Błąd już naprawiony" poprzez cache sprawdzonych błędów
- Dodano weryfikację DOM (sprawdzanie czy faktycznie są wiadomości) do wszystkich mechanizmów wykrywania
- Rozszerzono fallbacki dla stopButton (włącznie z polską lokalizacją "Zatrzymaj")
- Wzmocniono warunki wykrywania: stopButton (pewny) LUB (interfaceBlocked + hasMessages)
- Dodano dwufazową detekcję odpowiedzi (start + koniec) z weryfikacją DOM
- `getLastResponseText()` teraz async z retry loop (15 prób × 300ms = max 4.5s dodatkowego czekania)
- Cache sprawdzonych błędów (`Set`) zapobiega powtórnemu sprawdzaniu starych komunikatów błędów

### Styczeń 2025
- Dokumentacja utworzona na podstawie działającego rozszerzenia
- Potwierdzone selektory: `data-message-author-role`, `data-testid="send-button"`, `role="textbox"`
- Znany problem: Przycisk Edit ukrywany przez CSS

### Znane zmiany w przyszłości
- OpenAI często zmienia strukturę DOM bez ostrzeżenia
- Preferuj selektory oparte na `aria-label` i `role` (stabilniejsze)
- Unikaj selektorów opartych na klasach CSS (zmienne)

---

## Wsparcie

Jeśli napotkasz problemy:
1. Sprawdź DevTools → Elements → zbadaj aktualną strukturę DOM
2. Sprawdź Console → szukaj błędów JavaScript
3. Sprawdź Network → czy API ChatGPT działa poprawnie
4. Przetestuj na czystej sesji (bez innych rozszerzeń)

---

## Licencja

Ta dokumentacja jest tworzona na podstawie publicznej analizy interfejsu ChatGPT.
Używaj zgodnie z Terms of Service OpenAI.
