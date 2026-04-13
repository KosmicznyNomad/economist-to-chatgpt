# Struktura DOM ChatGPT - notatki runtime

Data ostatniej aktualizacji: 2026-04-11

## Zasada nadrzedna

Markdown w tym repo ma charakter pomocniczy. Zrodlem prawdy jest dzialajacy runtime w `background.js`, bo UI ChatGPT zmienia sie szybciej niz dokumentacja.

## Najwazniejsze zalozenia

- URL docelowy: `https://chatgpt.com/`
- Interfejs jest renderowany dynamicznie przez React.
- Edytor nie jest juz dokumentowany jako jeden stabilny `contenteditable`.
- Priorytetowy kandydat edytora w runtime to `textarea#prompt-textarea`.
- Thinking effort jest ustawieniem w composerze, nie osobnym subsystemem retry.

## Edytor wiadomości

### Priorytet selektorow

```javascript
const editor = document.querySelector('textarea#prompt-textarea')
  || document.querySelector('[role="textbox"][contenteditable="true"]')
  || document.querySelector('div[contenteditable="true"]')
  || document.querySelector('[data-testid="composer-input"]')
  || document.querySelector('[contenteditable]');
```

### Uwagi praktyczne

- `textarea#prompt-textarea` jest pierwszym kandydatem i powinno byc sprawdzane przed fallbackami `contenteditable`.
- Runtime nadal toleruje starsze fallbacki, ale nie nalezy zakladac, ze `contenteditable` bedzie jedynym aktywnym edytorem.
- Przyklady integracji powinny obslugiwac oba warianty: `textarea/input` i `contenteditable`.

## Composer i thinking effort

### Zasada

Thinking effort jest ustawiany w composerze przez:

```javascript
normalizeComposerThinkingEffort()
-> ensureRequestedComposerThinkingEffort()
-> ensureComposerThinkingEffort()
```

### Wnioski

- Nie budujemy osobnego clickera "od effortu".
- Nie opieramy sie na stalych wspolrzednych.
- Selekcja odbywa sie semantycznie: role, `aria-haspopup="menu"`, tekst, kontekst DOM.

## Retry i recovery

### Retry button

```javascript
const retryButton = document.querySelector('button[aria-label="Retry"]');
```

Ten przycisk jest traktowany jako historyczny lub opcjonalny element UI. Nie jest stabilnym, podstawowym punktem integracji.

### Continue button

```javascript
const continueButton = document.querySelector('button[aria-label="Continue"]')
  || document.querySelector('button[aria-label*="Continue"]');
```

`Continue` pozostaje przydatne jako awaryjny sygnal operatora, ale nie jest glowna sciezka dla zdalnego runnera.

### Edit+Send

Edit+Send jest w runtime celowo wylaczone jako podstawowa metoda recovery.

Aktualna polityka projektu:

- podstawowy recovery to ponowne wyslanie promptu
- `forceRepeatLastPrompt` jest jedyna wspierana logika "repeat last prompt"
- nie dokladamy nowego subsystemu retry wokol Edit+Send

## Bledy i blokady

### Hard generation errors

Runtime rozroznia:

- zwykle hard generation errors typu `something went wrong`
- blokady `limit/restriction`

### Limit/restriction

Blokady typu:

- `rate limit`
- `usage limit`
- `too many requests`
- `try again later`
- `limit reached`
- `reached your limit`
- ograniczenia planu lub availability dla effortu

sa klasyfikowane jako stan blokujacy `needsAction`, a nie jako trigger dla nowego clickera.

## Minimalny flow runtime

```text
popup / remote trigger
-> DETECT_LAST_COMPANY_PROMPT_AND_RESUME(forceRepeatLastPrompt?, composerThinkingEffort?)
-> resolveCompanyResumeStagePlanForTab()
-> injectToChat()
-> ensureRequestedComposerThinkingEffort()
-> sendPromptUntilSuccess()
-> success / needsAction
```

## Praktyczne zalecenia

- Jesli aktualizujesz selektory, najpierw sprawdz `background.js`.
- Jesli aktualizujesz przyklady DOM, nie promuj `Retry` ani `Edit+Send` jako glownej sciezki.
- Jesli opisujesz edytor, zaczynaj od `textarea#prompt-textarea`.
