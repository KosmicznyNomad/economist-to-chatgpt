# Chrome Extension Architecture: Economist to ChatGPT

## Project Overview
This is a Chrome extension that automates the process of analyzing articles from various news sources (The Economist, Nikkei Asia, etc.) and YouTube content by sending them to ChatGPT with a structured prompt chain. The extension captures ChatGPT's responses and stores them locally for later retrieval.

**Key Files Structure:**
```
economist-to-chatgpt/
├── manifest.json                    # Extension configuration
├── background.js                    # Service worker (orchestrator)
├── popup.html/popup.js              # Extension popup UI
├── content-script.js                # Content script for Google Sheets integration
├── youtube-content.js               # YouTube-specific content script
├── responses.html/responses.js       # Response viewer/storage interface
├── article-selector.html/js         # Portfolio article selection UI
├── manual-source.html/js            # Manual source input UI
├── prompt-dialog.html/js            # Prompt chain dialog UI
├── prompts-company.txt              # Company analysis prompts
├── prompts-portfolio.txt            # Portfolio analysis prompts
├── chatgpt-monitor.js               # ChatGPT DOM monitoring utility
├── process-monitor.html/js          # Process monitoring interface
└── Documentation files              # ChatGPT DOM structure docs
```

---

## 1. MANIFEST & CONFIGURATION (manifest.json)

**Key Permissions:**
- `tabs`, `scripting`, `contextMenus`, `storage` - Core extension permissions
- `host_permissions` - Access to specific news sites + chatgpt.com

**Content Scripts:**
- `youtube-content.js` runs on YouTube to capture transcripts

**Web Accessible Resources:**
- UI files (responses.html, article-selector.html, etc.)
- Prompt files and monitoring scripts

**Commands:**
- `Ctrl+Shift+E` - Open popup to run analysis
- `Ctrl+Shift+R` - View saved responses

---

## 2. OVERALL FLOW & ARCHITECTURE

### User Interaction Flow:
```
User clicks extension icon
        ↓
Popup appears (popup.html)
        ↓
User clicks "Uruchom analizę" (Run Analysis)
        ↓
background.js :: runAnalysis() triggered
        ↓
[Multi-step orchestration begins]
```

---

## 3. BACKGROUND SERVICE WORKER (background.js) - THE ORCHESTRATOR

This 2,200+ line file is the heart of the extension. It coordinates the entire analysis flow.

### 3.1 Key Global Variables:
```javascript
const CHAT_URL = "https://chatgpt.com/g/g-68e628cb..."  // Company analysis GPT
const CHAT_URL_PORTFOLIO = "https://chatgpt.com/g/g-68f71d..."  // Portfolio GPT
const PROMPTS_COMPANY = []      // Loaded from prompts-company.txt
const PROMPTS_PORTFOLIO = []    // Loaded from prompts-portfolio.txt
```

### 3.2 Main Functions:

#### **loadPrompts()** (Lines 13-49)
- Loads prompt chains from text files
- Prompts are separated by `◄PROMPT_SEPARATOR►` character
- Runs on extension startup

#### **runAnalysis()** (Lines 529-620)
**Main orchestration function triggered by popup**

Steps:
1. Verifies prompts are loaded
2. Gets all open browser tabs
3. Filters for supported news sources
4. Shows prompt chain selection dialog
5. For portfolio analysis: shows article selector
6. Launches `processArticles()` for both company and portfolio analysis
7. Handles both analyses in parallel

Key code snippet:
```javascript
// KROK 1: Sprawdź prompty
if (PROMPTS_COMPANY.length === 0) {
  alert("Błąd: Brak promptów");
  return;
}

// KROK 2: Pobierz artykuły
const allTabs = await chrome.tabs.query({url: getSupportedSourcesQuery()});

// KROK 3: Pokaż dialog promptów
const promptChain = await getPromptChain();

// KROK 4: Przetwarzaj artykuły
processingTasks.push(processArticles(allTabs, PROMPTS_COMPANY, CHAT_URL, 'company'));
```

#### **processArticles()** (Lines 306-526)
**Processes each article through ChatGPT**

For each article:
1. Extracts text from the article page
2. For YouTube: Uses YouTube content script to get transcript
3. For other sources: Uses `executeScript` with `extractText()`
4. Validates extracted text (min 50 chars for auto, no limit for manual)
5. Creates ChatGPT window with injected payload
6. Calls `injectToChat()` to run prompt chain
7. Receives response and calls `saveResponse()` to store it

Key decision point for YouTube vs Others:
```javascript
if (isYouTube) {
  // Use content script to get transcript
  const response = await chrome.tabs.sendMessage(tab.id, {type: 'GET_TRANSCRIPT'});
  extractedText = response.transcript;
} else {
  // Use executeScript with extractText function
  const results = await chrome.scripting.executeScript({
    target: {tabId: tab.id},
    function: extractText  // Defined later in file
  });
  extractedText = results[0]?.result;
}
```

#### **injectToChat()** (Lines 769-2189)
**THE CORE FUNCTION - Injects text into ChatGPT and captures responses**

This massive function (1,400+ lines) handles:

1. **Initialization:**
   - Finds or creates textarea/contenteditable
   - Waits up to 10 seconds for textarea to appear
   - Creates visual progress counter

2. **Text Injection:**
   - Clears existing text
   - Injects article payload using DOM manipulation + keyboard events
   - Waits for Send button to be enabled
   - Verifies text was actually inserted

3. **Prompt Chain Execution Loop:**
   ```
   For each prompt in promptChain:
     1. Send prompt via sendPrompt()
     2. Wait for response via waitForResponse()
     3. Extract response text via getLastResponseText()
     4. Validate response length
     5. Show user buttons if validation fails (Continue/Skip)
     6. Store ONLY last response for saving
   ```

4. **Sub-functions:**

   **sendPrompt():**
   - Finds editor textarea
   - Injects prompt text
   - Clicks Send button
   - Verifies prompt was sent (checks for stopButton or disabled editor)
   - Waits for interface to be ready

   **waitForResponse():**
   - **PHASE 1:** Waits for ChatGPT to START responding
     - Detects stopButton (most reliable)
     - OR detects editor disabled + send button disabled + new assistant message
     - Handles "Something went wrong" errors with retry logic
   - **PHASE 2:** Waits for ChatGPT to FINISH responding
     - Waits for stopButton to disappear
     - Waits for editor to become enabled (contenteditable="true")
     - Confirms 3 consecutive checks before considering response done

   **getLastResponseText():**
   - **RETRY LOOP:** Up to 15 retries with 300ms delays (React rendering)
   - Searches for `[data-message-author-role="assistant"]` elements
   - Removes non-content elements (citations, buttons, sources)
   - Extracts clean text using innerText
   - **FALLBACK 1:** Uses conversation-turn containers
   - **FALLBACK 2:** Uses article tags
   - Returns empty string if no response found

   **Error Handling:**
   - Detects "Something went wrong" messages
   - Attempts Edit+Resend fix (up to 3 tries)
   - Falls back to Retry button if Edit fails
   - Shows user intervention buttons if all retries fail

5. **Response Storage:**
   - **CRITICAL:** Only saves LAST response from prompt chain
   - Other responses are extracted but NOT saved
   - Response stored in `window._lastResponseToSave`
   - Returned as `{success: true, lastResponse: "..."}`

Return format:
```javascript
return {
  success: true/false,
  lastResponse: "ChatGPT's final response text",
  error: "Error message if failed"
};
```

#### **saveResponse()** (Lines 93-134)
**Saves captured response to chrome.storage.session**

```javascript
async function saveResponse(responseText, source, analysisType = 'company') {
  const result = await chrome.storage.session.get(['responses']);
  const responses = result.responses || [];
  
  const newResponse = {
    text: responseText,
    timestamp: Date.now(),
    source: source,           // Article title
    analysisType: analysisType // 'company' or 'portfolio'
  };
  
  responses.push(newResponse);
  await chrome.storage.session.set({responses});
  
  // Triggers onChanged listener in responses.js
}
```

#### **extractText()** (Lines 669-766)
**Injected function to extract article text from news sites**

- Uses CSS selectors specific to each news source
- Falls back to universal selectors (main, .article-content, #content)
- Last fallback: entire document.body.innerText
- Requires minimum 50 characters for validation

Supported sources have custom selectors:
- economist.com: `article`, `[data-test-id="Article"]`, `.article__body-text`
- asia.nikkei.com: `.article-body`, `.ezrichtext-field`
- caixinglobal.com: `.article-content`, `.story-content`
- etc.

---

## 4. RESPONSE CAPTURE & STORAGE SYSTEM

### 4.1 Storage: chrome.storage.session

**Why session storage?**
- Data cleared on browser close
- Lightweight, suitable for temporary responses
- No persistence across sessions

**Data Structure:**
```javascript
{
  responses: [
    {
      text: "ChatGPT's full response...",
      timestamp: 1698765432000,
      source: "Article Title or 'Manual Source'",
      analysisType: "company" // or "portfolio"
    },
    // ... more responses
  ]
}
```

### 4.2 Response Viewer (responses.html/responses.js)

**UI Components:**
- Shows all captured responses organized by analysis type
- Company analysis section
- Portfolio analysis section
- Each response shows:
  - Source (article title)
  - Timestamp (formatted as "Dzisiaj o HH:MM" or date)
  - Response text (max-height 300px with scroll)
  - Copy button

**Key Features:**
- Real-time updates via `chrome.storage.onChanged` listener
- "Copy All" button for each section (joins with \n)
- "Clear All" button with confirmation
- Copy-to-clipboard visual feedback

**Storage Listener** (Line 279-287):
```javascript
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'session' && changes.responses) {
    console.log('✅ Responses changed, reloading...');
    loadResponses();  // Re-render the UI
  }
});
```

---

## 5. CONTENT SCRIPTS

### 5.1 youtube-content.js
**Captures YouTube video transcripts**

**How it works:**
1. Extracts video ID from URL
2. Finds `ytInitialPlayerResponse` in window or script tags
3. Extracts `captionTracks` from the response
4. Stores data in `window._ytTranscriptData`
5. Background script requests transcript via `chrome.tabs.sendMessage`

**Supported Methods:**
- Direct caption fetching via captions API
- Auto-generated or manually added captions
- Multiple language support

**Data provided to background script:**
```javascript
{
  videoId: "dQw4w9WgXcQ",
  captionTracks: [...],  // Array of caption tracks with URLs
  lang: "English",
  transcript: "Full transcript text..."
}
```

### 5.2 content-script.js
**Integrates with Google Sheets (not for response saving)**

- Listens for `ECONOMIST_TO_SHEETS` messages
- Sends captured data to Google Sheets via GET request
- Not directly involved in response saving to extension storage

---

## 6. SUPPORTING UI COMPONENTS

### 6.1 popup.html/popup.js
**Extension popup (Ctrl+Shift+E)**

Buttons:
1. **Uruchom analizę** - Sends `RUN_ANALYSIS` message to background
2. **Wklej źródło** - Opens manual-source.html window
3. **Zobacz odpowiedzi** - Opens responses.html tab

### 6.2 prompt-dialog.html/prompt-dialog.js
**Prompt chain selection dialog**

- Shows all loaded prompts from prompts-company.txt
- User selects which prompts to run
- Sends `PROMPT_CHAIN_SUBMIT` back to background

### 6.3 article-selector.html/article-selector.js
**Article selection for portfolio analysis**

- Shows list of open article tabs
- User selects which articles to include in portfolio analysis
- Sends `ARTICLE_SELECTION_SUBMIT` with selected indices

### 6.4 manual-source.html/manual-source.js
**Manual text input for ad-hoc analysis**

- Textarea for pasting article content
- Title field
- Instances spinner (run analysis N times)
- Sends `MANUAL_SOURCE_SUBMIT` with text, title, instances
- Analyzed via `runManualSourceAnalysis()` which creates pseudo-tabs

---

## 7. RESPONSE SAVING - COMPLETE FLOW

### Flow Diagram:
```
User clicks "Urunchom analizę"
        ↓
popup.js sends RUN_ANALYSIS
        ↓
background.js :: runAnalysis()
        ↓
Gets articles from browser tabs
        ↓
Shows prompt dialog (getPromptChain)
        ↓
processArticles() for each article
        ↓
Opens ChatGPT window
        ↓
injectToChat() executes:
   ├─ Finds textarea/contenteditable
   ├─ Injects article text (payload)
   ├─ Waits for response (waitForResponse)
   ├─ Prompt Chain Loop:
   │  ├─ For each prompt:
   │  │  ├─ sendPrompt()
   │  │  ├─ waitForResponse()
   │  │  ├─ getLastResponseText() ← EXTRACTS FROM DOM
   │  │  └─ validateResponse()
   │  └─ [Only last response stored]
   └─ Returns {success, lastResponse}
        ↓
saveResponse() called with:
   - lastResponse text
   - article title (source)
   - analysisType ('company' or 'portfolio')
        ↓
chrome.storage.session.set({responses: [...]})
        ↓
Storage onChanged event triggered
        ↓
responses.js loads and renders responses
        ↓
User can view/copy responses in responses.html tab
```

### Critical Detail: Response Extraction from DOM

**Three-level extraction strategy in getLastResponseText():**

**Level 1:** Primary selector `[data-message-author-role="assistant"]`
```javascript
const messages = document.querySelectorAll('[data-message-author-role="assistant"]');
const lastMessage = messages[messages.length - 1];
const text = extractMainContent(lastMessage);
```

**Level 2:** Fallback to conversation-turn containers
```javascript
const turnContainers = document.querySelectorAll('[data-testid^="conversation-turn-"]');
// Find last assistant message within turns
```

**Level 3:** Fallback to article tags
```javascript
const articles = document.querySelectorAll('article');
const lastArticle = articles[articles.length - 1];
```

**Content Cleaning (extractMainContent):**
- Removes citations, sources, buttons
- Uses `innerText` to preserve formatting (newlines)
- Trims extra whitespace
- Max 2 consecutive blank lines

---

## 8. KEY FILES FOR RESPONSE SAVING

| File | Purpose | Key Responsibility |
|------|---------|-------------------|
| **background.js** | Service worker | Orchestrates entire flow, calls saveResponse |
| **responses.js** | Response viewer | Loads/displays saved responses, real-time updates |
| **responses.html** | Response UI | UI template for response viewer |
| **injectToChat()** in background.js | Response extraction | Extracts text from ChatGPT DOM, returns to background |
| **getLastResponseText()** in background.js | DOM scraping | Searches multiple DOM selectors for response |

---

## 9. ANALYSIS TYPE DISTINCTION

The extension supports TWO types of analyses:

### Company Analysis (`analysisType: 'company'`)
- Single URL: `/g/g-68e628cb...`
- All articles processed through this
- Used when "Uruchom analizę" is clicked

### Portfolio Analysis (`analysisType: 'portfolio'`)
- Single URL: `/g/g-68f71d...` (different GPT)
- Only runs if user selects articles in article-selector
- User chooses which articles to include
- Both analyses run in parallel

**Storage Separation:**
- responses.js filters responses by `analysisType`
- Two separate sections in UI
- Each has its own "Copy All" button

---

## 10. PROMPT CHAIN MECHANISM

**Purpose:** Run multiple prompts sequentially on the SAME ChatGPT conversation

**Flow:**
1. Send initial article text
2. Wait for response (but DON'T SAVE)
3. For each prompt in chain:
   - Send next prompt
   - Wait for response
   - Extract response
   - Validate response
4. **Save ONLY the final response** (from last prompt)

**Why?**
- Allows ChatGPT to build context across prompts
- Example chain:
  1. "Summarize this article"
  2. "What are the key risks?"
  3. "How does this affect a portfolio?"
4. Only the answer to #3 is saved

---

## 11. ERROR HANDLING & RECOVERY

### Common Failure Points:

1. **Text not injected:**
   - Retries up to 3 times every 500ms
   - Waits max 10 seconds for Send button

2. **ChatGPT error ("Something went wrong"):**
   - Attempts Edit+Resend up to 3 times
   - Falls back to Retry button
   - Shows user intervention UI if all fails

3. **Response timeout:**
   - Max 20 minutes (1,200,000ms)
   - Can be extended via responseWaitMs parameter
   - Shows user buttons to continue or skip

4. **Response validation failure:**
   - Min 10 characters for prompt chain responses
   - No minimum for initial article response
   - Retry extraction up to 15 times with delays

5. **YouTube transcript not found:**
   - Logs error, skips article
   - Falls back to next article

---

## 12. DOM SELECTORS REFERENCE

### ChatGPT Interface Elements:
```javascript
// Editor/textarea
'[role="textbox"]'
'[contenteditable="true"]'
'textarea#prompt-textarea'
'[data-testid="composer-input"]'

// Send button
'[data-testid="send-button"]'
'#composer-submit-button'
'button[aria-label="Send"]'

// Stop button (generation in progress)
'button[aria-label*="Stop"]'
'[data-testid="stop-button"]'
'button[aria-label*="stop"]'

// Messages
'[data-message-author-role="assistant"]'
'[data-message-author-role="user"]'

// Conversation structure
'[data-testid^="conversation-turn-"]'
'article'

// Error messages
'[class*="text"]' (checks for "Something went wrong")

// Edit/Retry buttons
'button[aria-label="Edit message"]'
'button[aria-label="Retry"]'
```

---

## 13. DEBUGGING POINTS

Key console.log areas in background.js:

1. **Lines 95-125:** saveResponse() - shows what's being saved
2. **Lines 437-508:** Response extraction analysis - shows result structure
3. **Lines 1513-1656:** getLastResponseText() - shows DOM search process
4. **Lines 1104-1310:** waitForResponse() Phase 1 - shows response start detection
5. **Lines 1304-1505:** waitForResponse() Phase 2 - shows completion detection
6. **Lines 2018-2156:** Prompt chain loop - shows prompt execution

---

## 14. DATA FLOW SUMMARY

```
Input: News article from open browser tab
   ↓
Extract text (via DOM selectors or YouTube API)
   ↓
Create payload with metadata (source, title, language)
   ↓
Open ChatGPT window with injected payload
   ↓
Run prompt chain (send prompts 1, 2, 3... wait for responses)
   ↓
Extract LAST response from ChatGPT DOM
   ↓
Return {success, lastResponse} from injectToChat()
   ↓
saveResponse(lastResponse, title, analysisType)
   ↓
chrome.storage.session.set({responses: [...]})
   ↓
responses.js listener triggered
   ↓
responses.html updated with new response
   ↓
User can copy/view response
```

---

## 15. SUPPORTED SOURCES

```javascript
'https://*.economist.com/*'
'https://asia.nikkei.com/*'
'https://*.caixinglobal.com/*'
'https://*.theafricareport.com/*'
'https://*.nzz.ch/*'
'https://*.project-syndicate.org/*'
'https://the-ken.com/*'
'https://www.youtube.com/*'
'https://youtu.be/*'
'https://*.wsj.com/*'
'https://*.foreignaffairs.com/*'
```

Plus manual source input for any text.

