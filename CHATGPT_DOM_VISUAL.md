# Wizualna Struktura DOM ChatGPT

## Hierarchia elementów

```
<body>
  │
  ├─ <main>
  │   │
  │   ├─ [data-message-author-role="user"]        ← Wiadomość użytkownika
  │   │   │
  │   │   ├─ <div> Treść wiadomości
  │   │   │
  │   │   └─ <button aria-label="Edit message">  ← Przycisk Edit (często ukryty!)
  │   │       • class: może zawierać "invisible" lub "hidden"
  │   │       • style: może mieć display: none
  │   │
  │   ├─ [data-message-author-role="assistant"]   ← Odpowiedź ChatGPT
  │   │   │
  │   │   ├─ <article>
  │   │   │   └─ Treść odpowiedzi
  │   │   │
  │   │   ├─ <ol data-block-id>                   ← Źródła/linki (usuń przy ekstrakcji)
  │   │   │
  │   │   └─ <button aria-label="Copy">           ← Przyciski akcji
  │   │       <button aria-label="Retry">
  │   │
  │   ├─ [data-message-author-role="user"]        ← Kolejna wiadomość...
  │   └─ [data-message-author-role="assistant"]
  │
  └─ <div> [dolny panel]
      │
      ├─ <div contenteditable="true" role="textbox">  ← EDYTOR (NIE textarea!)
      │   • contenteditable="true"  → gotowy do pisania
      │   • contenteditable="false" → zablokowany (ChatGPT generuje)
      │   • data-testid="composer-input" (opcjonalnie)
      │
      └─ <button data-testid="send-button">           ← Przycisk Send
          • disabled → nieaktywny (pusty edytor lub generowanie)
          • enabled  → gotowy do wysłania

          LUB podczas generowania:

          <button aria-label="Stop">                  ← Przycisk Stop
```

---

## Stany interfejsu

### Stan 1: Gotowy do wysłania nowego prompta

```
✅ Interface gotowy

Editor:
  [contenteditable="true"]     ✅ Enabled
  [role="textbox"]             ✅ Znaleziony

Przyciski:
  Send button                  ✅ Enabled (gdy tekst wstawiony)
  Stop button                  ❌ Nie istnieje
```

### Stan 2: ChatGPT generuje odpowiedź

```
⏳ ChatGPT generuje...

Editor:
  [contenteditable="false"]    ❌ Disabled

Przyciski:
  Send button                  ❌ Disabled
  Stop button                  ✅ Istnieje i aktywny
```

### Stan 3: Błąd generowania

```
❌ Błąd

DOM zawiera:
  <div class="text...">
    "Something went wrong while generating the response"
  </div>

  <button aria-label="Retry">  ✅ Przycisk Retry dostępny
```

### Stan 4: Tryb edycji wiadomości

```
✏️ Edycja wiadomości

Po kliknięciu Edit:
  [contenteditable="true"]     ✅ Editor z poprzednią wiadomością
  <button data-testid="send-button">  ✅ Send do ponownego wysłania
```

---

## Diagram przepływu wysyłania prompta

```
START
  │
  ├─ 1. Znajdź editor
  │    querySelector('[role="textbox"][contenteditable="true"]')
  │    ✓ Znaleziony
  │
  ├─ 2. Focus + wyczyść
  │    editor.focus()
  │    editor.innerHTML = ''
  │    ✓ Wyczyszczony
  │
  ├─ 3. Wstaw tekst
  │    textNode = createTextNode(text)
  │    editor.appendChild(textNode)
  │    ✓ Wstawiony
  │
  ├─ 4. Triggeruj eventy
  │    dispatchEvent(InputEvent 'input')
  │    dispatchEvent(Event 'change')
  │    ✓ Eventy wysłane
  │
  ├─ 5. Czekaj na Send button
  │    while (sendButton.disabled) { wait... }
  │    ✓ Button enabled
  │
  ├─ 6. Kliknij Send
  │    sendButton.click()
  │    ✓ Kliknięty
  │
  ├─ 7. Weryfikacja wysłania
  │    Czy stopButton istnieje?
  │    Czy editor.contenteditable === 'false'?
  │    ✓ Wysłany
  │
  ├─ 8. Czekaj na start generowania
  │    while (!isChatGPTGenerating()) { wait... }
  │    ✓ ChatGPT zaczął
  │
  ├─ 9. Czekaj na koniec generowania
  │    while (isChatGPTGenerating()) { wait... }
  │    ✓ ChatGPT zakończył
  │
  └─ 10. Wyciągnij odpowiedź
       querySelectorAll('[data-message-author-role="assistant"]')
       extractMainContent(lastMessage)
       ✓ Odpowiedź wyciągnięta
```

---

## Selektory - szybka ściąga

| Element | Selektor (priorytet malejący) |
|---------|-------------------------------|
| **Editor** | `[role="textbox"][contenteditable="true"]` |
| | `div[contenteditable="true"]` |
| | `[data-testid="composer-input"]` |
| **Send** | `[data-testid="send-button"]` |
| | `#composer-submit-button` |
| | `button[aria-label="Send"]` |
| **Edit** | `button[aria-label="Edit message"]` (w wiadomości użytkownika) |
| | `button[aria-label*="Edit"]` |
| **Stop** | `button[aria-label*="Stop"]` |
| | `[data-testid="stop-button"]` |
| **Retry** | `button[aria-label="Retry"]` |
| **Wiadomość użytkownika** | `[data-message-author-role="user"]` |
| **Odpowiedź ChatGPT** | `[data-message-author-role="assistant"]` |
| **Komunikat błędu** | `[class*="text"]` zawierający "Something went wrong" |

---

## Typowe problemy i rozwiązania

### Problem: Przycisk Edit nie widoczny

```
DOM:
  <button aria-label="Edit message" class="invisible">
  lub
  <button aria-label="Edit message" style="display: none;">

Rozwiązanie:
  editButton.classList.remove('invisible', 'hidden');
  editButton.style.visibility = 'visible';
  editButton.style.display = 'block';
  editButton.click();
```

### Problem: Send nie staje się enabled po wstawieniu tekstu

```
Przyczyna:
  React nie wykrył zmiany w contenteditable

Rozwiązanie:
  1. Użyj textNode zamiast innerHTML
  2. Triggeruj więcej eventów:
     - InputEvent 'beforeinput'
     - InputEvent 'input'
     - Event 'change'
     - KeyboardEvent 'keyup'
  3. Czekaj dłużej (do 10s)
```

### Problem: Odpowiedź jest pusta mimo zakończenia generowania

```
Przyczyna:
  Thinking indicator nadal obecny

Sprawdź:
  const thinkingIndicators = message.querySelectorAll('[class*="thinking"]');
  if (thinkingIndicators.length > 0) {
    // ChatGPT jeszcze myśli, czekaj dłużej
  }
```

---

## Przykład użycia w Chrome Extension

```javascript
// background.js
async function processWithChatGPT(articleText) {
  // 1. Otwórz ChatGPT
  const window = await chrome.windows.create({
    url: 'https://chatgpt.com/',
    type: 'normal'
  });

  const chatTabId = window.tabs[0].id;

  // 2. Czekaj na załadowanie
  await waitForTabComplete(chatTabId);

  // 3. Wstrzyknij funkcje i wyślij prompt
  const results = await chrome.scripting.executeScript({
    target: { tabId: chatTabId },
    function: sendPromptAndGetResponse,
    args: [articleText, 600000] // 10 minut timeout
  });

  const result = results[0]?.result;

  if (result.success) {
    console.log('✅ Odpowiedź:', result.responseText);
    return result.responseText;
  } else {
    console.error('❌ Błąd:', result.error);
    return null;
  }
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}
```

---

## Testy w DevTools Console

Możesz przetestować selektory bezpośrednio w konsoli ChatGPT:

```javascript
// Test 1: Znajdź editor
const editor = document.querySelector('[role="textbox"][contenteditable="true"]');
console.log('Editor:', editor);

// Test 2: Znajdź przyciski
const sendBtn = document.querySelector('[data-testid="send-button"]');
const stopBtn = document.querySelector('button[aria-label*="Stop"]');
console.log('Send:', sendBtn, 'disabled:', sendBtn?.disabled);
console.log('Stop:', stopBtn);

// Test 3: Znajdź wiadomości
const userMsgs = document.querySelectorAll('[data-message-author-role="user"]');
const assistantMsgs = document.querySelectorAll('[data-message-author-role="assistant"]');
console.log('User messages:', userMsgs.length);
console.log('Assistant messages:', assistantMsgs.length);

// Test 4: Sprawdź stan generowania
const isGenerating = !!(
  document.querySelector('button[aria-label*="Stop"]') ||
  (editor && editor.getAttribute('contenteditable') === 'false')
);
console.log('Is generating:', isGenerating);
```

---

## Uwagi końcowe

- **Struktura DOM ChatGPT zmienia się często** - te selektory są aktualne na styczeń 2025
- **Używaj fallback selektorów** - jeśli pierwszy nie działa, spróbuj kolejnego
- **Loguj wszystko** - `console.log()` pomoże debugować zmiany w DOM
- **Testuj regularnie** - po każdej aktualizacji ChatGPT sprawdź czy selektory działają

**Ważne linki:**
- Pełna dokumentacja: `CHATGPT_DOM_STRUCTURE.md`
- Przykłady kodu: `CHATGPT_INTERACTION_EXAMPLES.js`
