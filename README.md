# News to ChatGPT

Rozszerzenie Chrome do automatycznego przetwarzania artykułów newsowych przez ChatGPT z zaawansowanym prompt chain.

## Funkcjonalność

### Podstawowe funkcje
- Automatyczne kopiowanie artykułów do ChatGPT
- Wsparcie dla wielu źródeł newsowych
- Prompt chain - automatyczne wysyłanie sekwencji promptów
- Ręczne wklejanie źródeł
- Zapisywanie odpowiedzi ChatGPT

### Obsługiwane źródła
- The Economist
- Nikkei Asia
- Caixin Global
- The Africa Report
- NZZ
- Project Syndicate
- The Ken
- Wall Street Journal
- Foreign Affairs
- YouTube (transkrypcje)

### Zaawansowane funkcje
- Automatyczna interakcja z UI ChatGPT (wysyłanie, edycja, czekanie na odpowiedzi)
- Obsługa błędów i retry logic
- Edit+Resend przy błędach generowania
- Licznik postępu prompt chain
- Dwufazowa analiza (spółka + portfel)

## Instalacja

1. Pobierz lub sklonuj to repozytorium
2. Otwórz Chrome i wejdź na `chrome://extensions/`
3. Włącz "Developer mode" w prawym górnym rogu
4. Kliknij "Load unpacked" i wybierz folder z rozszerzeniem
5. Rozszerzenie jest gotowe do użycia

## Użycie

### Analiza artykułów z internetu
1. Otwórz artykuły z obsługiwanych źródeł w osobnych kartach
2. Kliknij ikonę rozszerzenia (lub naciśnij `Ctrl+Shift+E`)
3. Wybierz artykuły do analizy portfela
4. Rozszerzenie automatycznie przetworzy wszystkie artykuły

### Ręczne wklejanie źródeł
1. Kliknij ikonę rozszerzenia
2. Wybierz "Manual Source"
3. Wklej tytuł i tekst
4. Wybierz liczbę instancji do przetworzenia

### Przeglądanie odpowiedzi
- Naciśnij `Ctrl+Shift+R` aby otworzyć zebrane odpowiedzi
- Lub kliknij prawym przyciskiem → "Pokaż zebrane odpowiedzi"

## Dokumentacja techniczna

### Struktura DOM ChatGPT
Szczegółowa dokumentacja interakcji z interfejsem ChatGPT:
- **[CHATGPT_DOM_STRUCTURE.md](CHATGPT_DOM_STRUCTURE.md)** - Kompletna dokumentacja selektorów, stanów i best practices
- **[CHATGPT_DOM_VISUAL.md](CHATGPT_DOM_VISUAL.md)** - Wizualna reprezentacja struktury DOM
- **[CHATGPT_INTERACTION_EXAMPLES.js](CHATGPT_INTERACTION_EXAMPLES.js)** - Gotowe funkcje do użycia

### Kluczowe pliki
- `manifest.json` - Konfiguracja rozszerzenia
- `background.js` - Logika główna (prompt chain, analiza artykułów)
- `content-script.js` - Komunikacja z Google Sheets
- `popup.html/js` - Interface użytkownika

## Dla deweloperów

### Interakcja z ChatGPT UI

Rozszerzenie implementuje zaawansowaną interakcję z interfejsem ChatGPT:

```javascript
// Znajdowanie elementów
const editor = document.querySelector('[role="textbox"][contenteditable="true"]');
const sendButton = document.querySelector('[data-testid="send-button"]');
const editButton = document.querySelector('button[aria-label="Edit message"]');

// Wstawianie tekstu (contenteditable!)
const textNode = document.createTextNode(promptText);
editor.appendChild(textNode);
editor.dispatchEvent(new InputEvent('input', { bubbles: true }));

// Czekanie na odpowiedź
while (!isInterfaceReady()) {
  await new Promise(r => setTimeout(r, 500));
}
```

Więcej przykładów w plikach dokumentacji.

### Testowanie selektorów

Możesz przetestować selektory bezpośrednio w DevTools Console na chatgpt.com:

```javascript
// Test edytora
const editor = document.querySelector('[role="textbox"][contenteditable="true"]');
console.log('Editor:', editor);

// Test przycisku Send
const sendBtn = document.querySelector('[data-testid="send-button"]');
console.log('Send button:', sendBtn, 'disabled:', sendBtn?.disabled);

// Test wiadomości
const userMsgs = document.querySelectorAll('[data-message-author-role="user"]');
console.log('User messages:', userMsgs.length);
```

