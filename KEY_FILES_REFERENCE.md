# Key Files Reference - Quick Navigation

## Absolute File Paths

### Core Extension Configuration
- `/home/user/economist-to-chatgpt/manifest.json` - Extension configuration and permissions

### Background Service Worker (Orchestrator)
- `/home/user/economist-to-chatgpt/background.js` - Main orchestration logic (2,200+ lines)
  - Contains: `loadPrompts()`, `runAnalysis()`, `processArticles()`, `injectToChat()`, `saveResponse()`, etc.

### Response Saving Pipeline

#### Step 1: Save Function
- **File:** `/home/user/economist-to-chatgpt/background.js` (Lines 93-134)
- **Function:** `saveResponse(responseText, source, analysisType)`
- **What it does:** Takes extracted ChatGPT response and stores in chrome.storage.session
- **Storage key:** `responses` (array of response objects)

#### Step 2: Response Extraction
- **File:** `/home/user/economist-to-chatgpt/background.js` (Lines 1513-1656)
- **Function:** `getLastResponseText()`
- **What it does:** Extracts text from ChatGPT DOM using multiple selectors with retry logic
- **Primary selector:** `[data-message-author-role="assistant"]`
- **Retry mechanism:** Up to 15 attempts with 300ms delays

#### Step 3: ChatGPT Interaction
- **File:** `/home/user/economist-to-chatgpt/background.js` (Lines 769-2189)
- **Function:** `injectToChat(payload, promptChain, ...)`
- **What it does:** 
  - Injects article text into ChatGPT textarea
  - Runs prompt chain (sends multiple prompts sequentially)
  - Captures ONLY the last response
  - Returns `{success, lastResponse}`
- **Sub-functions:**
  - `sendPrompt()` - Injects and sends text to ChatGPT
  - `waitForResponse()` - Detects ChatGPT start/completion
  - `getLastResponseText()` - Extracts response from DOM
  - `validateResponse()` - Checks response length

### Response Viewer UI
- **HTML:** `/home/user/economist-to-chatgpt/responses.html`
- **JavaScript:** `/home/user/economist-to-chatgpt/responses.js`
- **What it does:**
  - Reads responses from chrome.storage.session
  - Displays responses organized by analysisType (company/portfolio)
  - Listens for storage changes in real-time
  - Provides copy/clear functionality

### User Interface Components
- **Extension Popup:** `/home/user/economist-to-chatgpt/popup.html` + `/home/user/economist-to-chatgpt/popup.js`
  - Buttons: Run Analysis, Manual Source, View Responses

- **Prompt Dialog:** `/home/user/economist-to-chatgpt/prompt-dialog.html` + `/home/user/economist-to-chatgpt/prompt-dialog.js`
  - User selects which prompts to run

- **Article Selector:** `/home/user/economist-to-chatgpt/article-selector.html` + `/home/user/economist-to-chatgpt/article-selector.js`
  - User selects articles for portfolio analysis

- **Manual Source:** `/home/user/economist-to-chatgpt/manual-source.html` + `/home/user/economist-to-chatgpt/manual-source.js`
  - User pastes article content directly

### Content Scripts
- **YouTube Content:** `/home/user/economist-to-chatgpt/youtube-content.js`
  - Captures YouTube transcripts
  - Stores in `window._ytTranscriptData`
  - Called by background.js via `chrome.tabs.sendMessage`

- **Google Sheets Integration:** `/home/user/economist-to-chatgpt/content-script.js`
  - Sends data to Google Sheets
  - Not directly involved in response saving

### Prompt Files (Data)
- **Company Analysis Prompts:** `/home/user/economist-to-chatgpt/prompts-company.txt`
  - Prompts separated by `◄PROMPT_SEPARATOR►` character
  - Loaded at extension startup

- **Portfolio Analysis Prompts:** `/home/user/economist-to-chatgpt/prompts-portfolio.txt`
  - Prompts separated by `◄PROMPT_SEPARATOR►` character
  - Used only for portfolio analysis

### Documentation
- **Architecture Overview:** `/home/user/economist-to-chatgpt/ARCHITECTURE_OVERVIEW.md`
  - Comprehensive guide to all components

- **Response Saving Flowchart:** `/home/user/economist-to-chatgpt/RESPONSE_SAVING_FLOWCHART.md`
  - Visual flowchart of the response saving process

- **ChatGPT DOM Structure:** `/home/user/economist-to-chatgpt/CHATGPT_DOM_STRUCTURE.md`
  - ChatGPT interface element selectors and structure

---

## Function Call Chain - Response Saving

### Complete Path from User Click to Saved Response

```
popup.js
  └─ chrome.runtime.sendMessage({type: 'RUN_ANALYSIS'})
     ↓
background.js
  └─ runAnalysis()
     ├─ loadPrompts()
     ├─ chrome.tabs.query() → get articles
     ├─ getPromptChain() → show dialog
     ├─ processArticles() → for each article:
     │  ├─ extractText() OR youtube-content.js
     │  ├─ chrome.windows.create() → open ChatGPT
     │  ├─ chrome.scripting.executeScript() → call injectToChat()
     │  │  ↓
     │  │  injectToChat() IN ChatGPT WINDOW:
     │  │    ├─ sendPrompt(payload)
     │  │    ├─ waitForResponse()
     │  │    ├─ [Prompt Chain Loop]:
     │  │    │  ├─ sendPrompt(prompt)
     │  │    │  ├─ waitForResponse()
     │  │    │  ├─ getLastResponseText() ← EXTRACT FROM DOM
     │  │    │  └─ validateResponse()
     │  │    ├─ window._lastResponseToSave = responseText
     │  │    └─ return {success, lastResponse}
     │  │
     │  └─ saveResponse(result.lastResponse, title, analysisType)
     │     ├─ chrome.storage.session.get(['responses'])
     │     ├─ responses.push({text, timestamp, source, analysisType})
     │     └─ chrome.storage.session.set({responses})
     │        ↓
     │        [Storage onChanged event]
     │
responses.js
  └─ chrome.storage.onChanged.addListener()
     ├─ loadResponses()
     ├─ renderResponses()
     └─ Display in responses.html
```

---

## Where to Look for Different Tasks

### If you need to understand Response Extraction:
1. Start: `/home/user/economist-to-chatgpt/background.js` Line 1513-1656 (`getLastResponseText`)
2. Look at: DOM selectors in lines 1559, 1611, 1639
3. Check: Retry mechanism (lines 1549-1551)
4. See: Content cleaning in `extractMainContent()` (lines 1517-1545)

### If you need to understand Response Storage:
1. Start: `/home/user/economist-to-chatgpt/background.js` Line 93-134 (`saveResponse`)
2. Data structure: Lines 108-113
3. Storage call: Lines 117-118
4. Verification: Add logs at lines 106, 117, 122

### If you need to understand Prompt Chain Execution:
1. Start: `/home/user/economist-to-chatgpt/background.js` Line 2018-2156 (prompt chain loop)
2. Single prompt send: Line 2037 `sendPrompt(prompt)`
3. Response wait: Line 2074 `waitForResponse(responseWaitMs)`
4. Response extract: Line 2105 `getLastResponseText()`
5. Save decision: Lines 2140-2151

### If you need to understand ChatGPT DOM Interaction:
1. Selectors reference: `/home/user/economist-to-chatgpt/CHATGPT_DOM_STRUCTURE.md`
2. Implementation: `/home/user/economist-to-chatgpt/background.js` Lines 769-2189
3. Response detection: Lines 1104-1510 (waitForResponse)
4. Text injection: Lines 1823-1873 (sendPrompt)

### If you need to debug Storage Issues:
1. Write responses: `/home/user/economist-to-chatgpt/background.js` Lines 93-134
2. Read responses: `/home/user/economist-to-chatgpt/responses.js` Lines 77-91
3. Storage listener: `/home/user/economist-to-chatgpt/responses.js` Lines 279-287
4. UI render: `/home/user/economist-to-chatgpt/responses.js` Lines 94-138

---

## Key Variables in Storage

### chrome.storage.session structure:
```javascript
{
  responses: [
    {
      text: string,              // ChatGPT's response (extracted from DOM)
      timestamp: number,         // Date.now() at save time
      source: string,            // Article title or "Manual Source"
      analysisType: string       // "company" or "portfolio"
    },
    // ... more responses
  ]
}
```

### Global variables in background.js:
- `PROMPTS_COMPANY` - Array of company analysis prompts (loaded from file)
- `PROMPTS_PORTFOLIO` - Array of portfolio analysis prompts (loaded from file)
- `CHAT_URL` - URL to company analysis ChatGPT
- `CHAT_URL_PORTFOLIO` - URL to portfolio analysis ChatGPT
- `SUPPORTED_SOURCES` - Array of supported news source patterns
- `window._lastResponseToSave` - Temporary storage for response during injectToChat execution
- `window._ytTranscriptData` - YouTube transcript data (set by youtube-content.js)

---

## Critical DOM Selectors Used

### Finding ChatGPT Editor:
```
[role="textbox"]
[contenteditable="true"]
textarea#prompt-textarea
[data-testid="composer-input"]
[contenteditable]
```

### Finding Send Button:
```
[data-testid="send-button"]
#composer-submit-button
button[aria-label="Send"]
button[aria-label*="Send"]
```

### Finding Assistant Messages (MOST IMPORTANT):
```
[data-message-author-role="assistant"]
```

### Finding Stop Button (Generation in progress):
```
button[aria-label*="Stop"]
[data-testid="stop-button"]
button[aria-label*="stop"]
button[aria-label="Zatrzymaj"]
```

### Fallback Selectors for Messages:
```
[data-testid^="conversation-turn-"]
article
```

---

## Console Debugging Tips

### Enable detailed logging in responses.js:
All functions have console.log with emoji prefixes:
- `📥` - Loading data
- `🎨` - Rendering
- `💾` - Saving
- `✅` - Success
- `❌` - Error

### Trace response saving in background.js:
Look for lines starting with asterisks `*`:
- Line 96: `console.log('💾 💾 💾 [saveResponse] ROZPOCZĘTO ZAPISYWANIE')` 
- Line 121: `console.log('✅ ✅ ✅ [saveResponse] ZAPISANO POMYŚLNIE')`

### Monitor injectToChat execution:
Search for `console.log('🎯 ANALIZA WYNIKU Z executeScript')` at line 438

---

## Storage Location Note

The extension uses `chrome.storage.session` which:
- Clears when browser closes
- Is lightweight (no persistence)
- Stores in browser's temporary storage
- Is NOT persistent across sessions

To add persistence, you would change:
- `chrome.storage.session` → `chrome.storage.local`
- But this would require permission in manifest.json

