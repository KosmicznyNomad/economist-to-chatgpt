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
await new Promise(r => setTimeout(r, 1000));
const stopBtn = document.querySelector('button[aria-label*="Stop"]');
const editorDisabled = editor.getAttribute('contenteditable') === 'false';
if (stopBtn || editorDisabled) {
  console.log('✅ Wiadomość wysłana');
} else {
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

```javascript
function isChatGPTGenerating() {
  // 1. Sprawdź przycisk Stop
  const stopButton = document.querySelector('button[aria-label*="Stop"]') ||
                     document.querySelector('[data-testid="stop-button"]');
  if (stopButton) return true;

  // 2. Sprawdź stan edytora
  const editor = document.querySelector('[role="textbox"]') ||
                 document.querySelector('[contenteditable]');
  const editorDisabled = editor && editor.getAttribute('contenteditable') === 'false';
  if (editorDisabled) return true;

  // 3. Sprawdź przycisk Send
  const sendButton = document.querySelector('[data-testid="send-button"]');
  if (sendButton && sendButton.disabled) return true;

  return false;
}
```

### Czekanie na zakończenie odpowiedzi

```javascript
async function waitForChatGPTResponse(maxWaitMs = 600000) { // 10 minut
  const startTime = Date.now();
  let consecutiveReady = 0;

  while (Date.now() - startTime < maxWaitMs) {
    // Sprawdź czy interface jest gotowy
    const editor = document.querySelector('[role="textbox"][contenteditable="true"]');
    const stopButton = document.querySelector('button[aria-label*="Stop"]');

    const editorReady = editor && editor.getAttribute('contenteditable') === 'true';
    const noGeneration = !stopButton;
    const isReady = noGeneration && editorReady;

    if (isReady) {
      consecutiveReady++;
      if (consecutiveReady >= 3) { // Potwierdź przez 3 sprawdzenia (1.5s)
        console.log('✅ ChatGPT zakończył odpowiedź');
        await new Promise(r => setTimeout(r, 1000)); // Stabilizacja UI
        return true;
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

### Problem 3: Send button nie staje się enabled

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

### Problem 4: ChatGPT nie zaczyna odpowiadać po wysłaniu

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

### Problem 5: Timeout przy długich odpowiedziach (chain-of-thought)

**Rozwiązanie**: Zwiększ timeout + detekcja dwufazowa (start + koniec)

```javascript
// Faza 1: Czekaj na START generowania (może trwać 5+ minut)
const MAX_START_WAIT = 1200000; // 20 minut
while (Date.now() - startTime < MAX_START_WAIT) {
  if (isChatGPTGenerating()) {
    break; // Zaczął!
  }
  await new Promise(r => setTimeout(r, 500));
}

// Faza 2: Czekaj na KONIEC generowania
await waitForChatGPTResponse(1200000); // 20 minut
```

### Problem 6: Wiadomości są puste po wyciągnięciu

**Rozwiązanie**: Sprawdź thinking indicators + czekaj dłużej

```javascript
const lastMessage = assistantMessages[assistantMessages.length - 1];
const thinkingIndicators = lastMessage.querySelectorAll('[class*="thinking"]');
if (thinkingIndicators.length > 0) {
  console.warn('⚠️ ChatGPT jeszcze myśli...');
  // Czekaj dłużej
}
```

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

  // 7. Weryfikuj
  await new Promise(r => setTimeout(r, 1000));
  if (!isChatGPTGenerating()) {
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
