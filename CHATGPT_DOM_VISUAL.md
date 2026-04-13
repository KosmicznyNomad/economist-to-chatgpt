# Wizualna Struktura DOM ChatGPT

## Uwaga

To jest szkic pomocniczy. Aktualny runtime i selektory sa definiowane w `background.js`.

## Hierarchia wysokiego poziomu

```text
<body>
  <main>
    [data-message-author-role="user"]
    [data-message-author-role="assistant"]
      <article> ...odpowiedz... </article>
      <button aria-label="Copy">
      <button aria-label="Retry">   <- opcjonalne / historyczne

    [composer area]
      <textarea id="prompt-textarea"> <- priorytetowy kandydat runtime
      <div role="textbox" contenteditable="true"> <- fallback
      <button data-testid="send-button">
      <button aria-label="Stop">
      [thinking effort pill / composer menu]
```

## Stany interfejsu

### Gotowy do wysylania

```text
Editor:
  textarea#prompt-textarea                 enabled
  lub [role="textbox"][contenteditable]   enabled

Buttons:
  Send                                    enabled
  Stop                                    absent
```

### Generowanie odpowiedzi

```text
Editor:
  textarea/input                          disabled lub readonly
  lub contenteditable                     false

Buttons:
  Send                                    disabled
  Stop                                    visible
```

### Blad / blokada

```text
DOM:
  [role="alert"]
  [role="status"]
  elementy z tekstem typu:
    "Something went wrong"
    "rate limit"
    "try again later"
    "Heavy is not available..."

Buttons:
  Retry                                   niegwarantowany
  Continue                                mozliwy, ale nie glowny workflow
```

## Selector cheat sheet

```javascript
const editor = document.querySelector('textarea#prompt-textarea')
  || document.querySelector('[role="textbox"][contenteditable="true"]')
  || document.querySelector('div[contenteditable="true"]')
  || document.querySelector('[data-testid="composer-input"]')
  || document.querySelector('[contenteditable]');

const sendButton = document.querySelector('[data-testid="send-button"]')
  || document.querySelector('#composer-submit-button')
  || document.querySelector('button[aria-label="Send"]');

const stopButton = document.querySelector('[data-testid="stop-button"]')
  || document.querySelector('button[aria-label*="Stop"]');

const continueButton = document.querySelector('button[aria-label*="Continue"]');
const retryButton = document.querySelector('button[aria-label="Retry"]'); // optional
```

## Recovery policy

- Primary recovery: resend prompt / repeat last prompt.
- Thinking effort: ustawiany w composerze przed wysylka.
- Retry button: nie traktowac jako stabilnego punktu integracji.
- Edit+Send: swiadomie wylaczone jako podstawowy mechanizm runtime.
