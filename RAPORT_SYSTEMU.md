# Raport: teoria i mechanizm dzialania systemu "News to ChatGPT"

## 1. Cel i zakres systemu
System to rozszerzenie Chrome automatyzujace prace z artykulami newsowymi i tresciami z YouTube, ktore przekazuje material do ChatGPT w formie uporzadkowanego prompt chain i zapisuje wynikowe odpowiedzi. Celem jest eliminacja manualnego kopiowania, utrzymanie spojnej metody analizy oraz szybkie zebranie odpowiedzi w jednym miejscu.

Zakres funkcjonalny:
- automatyczne pobieranie tresci z wielu zrodel,
- uruchamianie sekwencji promptow w ChatGPT,
- kontrola procesu generacji odpowiedzi,
- zapis odpowiedzi i ich przegladanie,
- tryb manualny (wklejenie zrodla),
- osobny tor analizy "company" i "portfolio".

## 2. Teoria dzialania (model koncepcyjny)
System opiera sie na kilku zasadach projektowych:

1) Orkiestracja zamiast integracji API
- ChatGPT jest traktowany jako zewnetrzny interfejs, a nie bezposrednie API.
- Automatyzacja odbywa sie poprzez DOM i symulacje interakcji uzytkownika.

2) Prompt chain jako pipeline wiedzy
- Wieloetapowa analiza zapewnia narastanie kontekstu.
- Tylko wynik koncowy (ostatni prompt) jest zapisywany jako najbardziej wartosciowy.

3) Separacja odpowiedzialnosci
- Orkiestracja procesu w service workerze.
- Ekstrakcja tresci w kontekcie strony (content scripts).
- UI do uruchamiania i przegladu odpowiedzi w osobnych widokach.

4) Odpornosc na zmiany i bledy
- Wielopoziomowe selektory DOM.
- Retry logic dla wstrzykiwania tekstu i pobierania odpowiedzi.
- Reakcja na typowe bledy ChatGPT ("Something went wrong").

5) Minimalna persystencja danych
- Odpowiedzi przechowywane w `chrome.storage.session` (dane ulotne).
- Brak trwalego zapisu na dysku bez wyraznej potrzeby.

## 3. Architektura logiczna (moduly i role)

Glowne komponenty:
- `manifest.json`: konfiguracja rozszerzenia, uprawnienia, skroty klawiszowe.
- `background.js`: orchestrator procesu (service worker).
- `popup.html` + `popup.js`: panel uzytkownika (uruchomienie analizy, manual source, odpowiedzi).
- `prompt-dialog.html` + `prompt-dialog.js`: wybor promptow do chain.
- `article-selector.html` + `article-selector.js`: wybor artykulow do analizy portfela.
- `manual-source.html` + `manual-source.js`: wklejanie tresci recznie.
- `youtube-content.js`: pobieranie transkrypcji z YouTube.
- `content-script.js`: integracja z Google Sheets (poza zapisem odpowiedzi).
- `responses.html` + `responses.js`: przeglad i kopiowanie odpowiedzi.
- `prompts-company.txt`, `prompts-portfolio.txt`: definicje promptow.

## 4. Mechanizm dzialania (przeplyw krok po kroku)

### 4.1 Wejscie i inicjacja
1) Uzytkownik klika ikonke rozszerzenia lub uzywa skrotu `Ctrl+Shift+E`.
2) `popup.js` wysyla do `background.js` komunikat `RUN_ANALYSIS`.
3) `background.js` wczytuje prompty z plikow tekstowych i pobiera otwarte karty.

### 4.2 Selekcja promptow i artykulow
4) `prompt-dialog` wyswietla liste promptow, uzytkownik wybiera sekwencje.
5) Dla analizy portfela `article-selector` pozwala wybrac subset kart.

### 4.3 Ekstrakcja tresci
6) `processArticles()` iteruje po kartach:
   - YouTube: `youtube-content.js` zwraca transkrypcje.
   - Inne zrodla: `extractText()` uruchamiane w kontekscie strony poprzez `chrome.scripting.executeScript`.
7) Ekstrakcja uzywa selektorow specyficznych dla zrodla i fallbackow globalnych.

### 4.4 Iniekcja i prompt chain w ChatGPT
8) Dla kazdego artykulu tworzona jest nowa karta/okno ChatGPT na docelowym URL (oddzielnie dla company i portfolio).
9) `injectToChat()` (uruchamiany w kontekscie ChatGPT) wykonuje:
   - znalezienie pola edycji i przycisku wysylki,
   - wstrzykniecie tekstu artykulu,
   - wyslanie promptu inicjalnego,
   - petle prompt chain:
     - wyslij prompt,
     - poczekaj na odpowiedz,
     - pobierz tekst odpowiedzi z DOM,
     - waliduj minimalna dlugosc.
10) Zapisywana jest tylko odpowiedz z ostatniego promptu.

### 4.5 Zapis i prezentacja odpowiedzi
11) `saveResponse()` zapisuje odpowiedz w `chrome.storage.session`.
12) `responses.js` nasluchuje zmian storage i renderuje odpowiedzi w `responses.html`.

## 5. Mechanizmy kluczowe

### 5.1 Ekstrakcja tresci (artykuly i YouTube)
- Specyficzne selektory dla kazdego serwisu (np. `article`, `.article-body`, itp.).
- Fallback do ogolnych selektorow i `document.body.innerText`.
- Dla YouTube wykorzystywany jest `captionTracks` z `ytInitialPlayerResponse`.

### 5.2 Interakcja z ChatGPT (DOM automation)
- Wykorzystanie selektorow:
  - edytor: `[role="textbox"]`, `[contenteditable="true"]`, `textarea#prompt-textarea`
  - przycisk wysylki: `[data-testid="send-button"]`, `button[aria-label="Send"]`
  - stan generacji: przycisk stop
- Detekcja startu i konca odpowiedzi oparta o pojawienie/zanik przycisku stop i stan edytora.

### 5.3 Ekstrakcja odpowiedzi
- Glowny selector: `[data-message-author-role="assistant"]`.
- Fallback: `data-testid^="conversation-turn-"` oraz `article`.
- Oczyszczanie tresci z przyciskow, zrodel i cytowan.
- Retry loop (wielokrotne proby z opoznieniem).

### 5.4 Zapisywanie danych
- `chrome.storage.session` przechowuje tablice obiektow:
  - `text`, `timestamp`, `source`, `analysisType`.
- Dane sa ulotne (czyszcza sie po zamknieciu przegladarki).

### 5.5 Obsluga bledow
- Retry przy wstrzykiwaniu tekstu.
- Detekcja bledow "Something went wrong" i proba `Edit+Resend` lub `Retry`.
- Mozliwosc interwencji uzytkownika (kontynuuj/pomin).
- Timeouty dla odpowiedzi (zabezpieczenie przed "zawieszeniem").

## 6. Uklad danych i przeplyw

Schemat (skrot):
```
Uzytkownik -> popup -> background.runAnalysis
  -> prompt-dialog -> processArticles
  -> extractText / youtube transcript
  -> open ChatGPT -> injectToChat
  -> prompt chain -> last response
  -> saveResponse -> chrome.storage.session
  -> responses.html (render)
```

## 7. Konfiguracja i sterowanie
- `manifest.json`: uprawnienia (tabs, scripting, storage), host_permissions, skroty klawiszowe.
- `prompts-company.txt` i `prompts-portfolio.txt`: definicje promptow (separator promptow).
- `CHAT_URL` i `CHAT_URL_PORTFOLIO` w `background.js`: docelowe instancje ChatGPT.

## 8. Ograniczenia i ryzyka
- Zmiany w DOM ChatGPT lub serwisow newsowych moga zepsuc selektory.
- Paywalle i blokady tresci ograniczaja ekstrakcje.
- Wymaga zalogowanej sesji ChatGPT w przegladarce.
- `chrome.storage.session` nie zapewnia trwalego archiwum.
- ChatGPT moze zwracac bledy lub opoznienia, co wymaga retry i timeoutow.

## 9. Rozszerzalnosc
- Dodanie nowych zrodel: dopisanie selektorow w `extractText()` i host_permissions.
- Nowe prompty: edycja plikow `prompts-*.txt`.
- Inne kanaly zapisu: zmiana storage z `session` na `local` (wymaga modyfikacji uprawnien).

## 10. Wskazniki poprawnego dzialania
- W logach `background.js`: potwierdzenie `sendPrompt`, `waitForResponse`, `getLastResponseText`.
- W `responses.html`: pojawianie sie odpowiedzi w czasie rzeczywistym.
- Stabilny przebieg prompt chain (brak interwencji manualnej).

## 11. Najwazniejsze zaleznosci plikow
- Orkiestracja: `background.js`
- Ekstrakcja i UI: `popup.js`, `prompt-dialog.js`, `article-selector.js`, `manual-source.js`
- ChatGPT DOM: `background.js` + dokumenty `CHATGPT_DOM_STRUCTURE.md`
- Zapis i przeglad: `responses.js`

## 12. Podsumowanie
System realizuje automatyzacje analizy tresci poprzez kontrolowany pipeline: ekstrakcja -> prompt chain -> ekstrakcja odpowiedzi -> zapis. Teoria dzialania opiera sie na traktowaniu ChatGPT jako sterowanego interfejsu, a nie zewnetrznego API, przy jednoczesnym zapewnieniu odpornosci na bledy i czytelnej separacji modulow.
