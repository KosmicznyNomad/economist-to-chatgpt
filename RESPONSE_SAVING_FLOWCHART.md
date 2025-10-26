# Response Saving - Visual Flowchart

## Complete Flow from User Action to Saved Response

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ USER INTERACTION                                                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  [Extension Icon Click]                                                    │
│           ↓                                                                │
│  [popup.html] User sees 3 buttons:                                         │
│    • Uruchom analizę (Run Analysis)    ← User clicks this                 │
│    • Wklej źródło (Manual Source)                                         │
│    • Zobacz odpowiedzi (View Responses)                                    │
│           ↓                                                                │
│  [popup.js] Sends message:                                                │
│    chrome.runtime.sendMessage({ type: 'RUN_ANALYSIS' })                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ BACKGROUND SERVICE WORKER (background.js)                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  [Message Handler] Receives 'RUN_ANALYSIS'                                 │
│           ↓                                                                │
│  [runAnalysis()] MAIN ORCHESTRATION                                        │
│           ├─ Load PROMPTS_COMPANY from prompts-company.txt                │
│           ├─ Load PROMPTS_PORTFOLIO from prompts-portfolio.txt            │
│           ├─ Get all browser tabs                                         │
│           ├─ Filter tabs by supported sources                             │
│           ├─ Show prompt-dialog for user to select prompts                │
│           │                                                                │
│           ├─────► For COMPANY ANALYSIS:                                   │
│           │       processArticles(allTabs, PROMPTS_COMPANY, ...)          │
│           │                                                                │
│           └─────► For PORTFOLIO ANALYSIS (if selected):                   │
│                   Show article-selector for user to choose articles       │
│                   processArticles(selectedTabs, PROMPTS_PORTFOLIO, ...)   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ ARTICLE PROCESSING LOOP (processArticles function)                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  For each article/tab:                                                     │
│           ┌──────────────────────────────────────────────────────────────┐ │
│           │ STEP 1: EXTRACT TEXT FROM SOURCE                            │ │
│           ├──────────────────────────────────────────────────────────────┤ │
│           │                                                              │ │
│           │  Is it YouTube?                                             │ │
│           │       ├─ YES:  chrome.tabs.sendMessage(tab.id, GET_TRANSCRIPT)│ │
│           │       │        ↓                                            │ │
│           │       │        [youtube-content.js] extracts transcript    │ │
│           │       │        Returns: {transcript: "...", lang: "..."}   │ │
│           │       │                                                    │ │
│           │       └─ NO:   chrome.scripting.executeScript({            │ │
│           │                 function: extractText              │ │
│           │               })                                  │ │
│           │                ↓                                            │ │
│           │                [extractText] runs in article tab            │ │
│           │                Tries multiple CSS selectors                 │ │
│           │                Returns: text (min 50 chars required)        │ │
│           │                                                              │ │
│           └──────────────────────────────────────────────────────────────┘ │
│           ↓                                                                │
│           ┌──────────────────────────────────────────────────────────────┐ │
│           │ STEP 2: CREATE CHATGPT WINDOW & INJECT TEXT                 │ │
│           ├──────────────────────────────────────────────────────────────┤ │
│           │                                                              │ │
│           │  chrome.windows.create({ url: CHAT_URL })                  │ │
│           │           ↓                                                 │ │
│           │  [ChatGPT loads] → chrome.scripting.executeScript({         │ │
│           │                      function: injectToChat,              │ │
│           │                      args: [payload, promptChain, ...]   │ │
│           │                    })                                      │ │
│           │                                                              │ │
│           └──────────────────────────────────────────────────────────────┘ │
│           ↓                                                                │
│           ┌──────────────────────────────────────────────────────────────┐ │
│           │ STEP 3: CHATGPT INTERACTION (injectToChat)                  │ │
│           │ [1,400+ line function - runs IN ChatGPT window]            │ │
│           ├──────────────────────────────────────────────────────────────┤ │
│           │                                                              │ │
│           │ sendPrompt(payload)     ← Initial article text             │ │
│           │      ↓                                                       │ │
│           │ Find textarea/contenteditable                              │ │
│           │ Inject article payload                                     │ │
│           │ Click Send button                                          │ │
│           │ Verify sent (check for stopButton)                         │ │
│           │      ↓                                                       │ │
│           │ waitForResponse()       ← Wait for ChatGPT's response      │ │
│           │      ├─ PHASE 1: Wait for START of response               │ │
│           │      │   (stopButton appears OR editor disabled)           │ │
│           │      │   Handle errors: "Something went wrong"             │ │
│           │      │     └─ Try Edit+Resend (3 attempts)                │ │
│           │      │     └─ Try Retry button                             │ │
│           │      │                                                      │ │
│           │      └─ PHASE 2: Wait for END of response                 │ │
│           │          (stopButton disappears, editor enabled)           │ │
│           │                                                              │ │
│           │ [After initial response, NOT SAVED]                        │ │
│           │                                                              │ │
│           │ ━━━ PROMPT CHAIN LOOP ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ │ │
│           │                                                              │ │
│           │ For each prompt in promptChain:                            │ │
│           │   1. sendPrompt(prompt)                                    │ │
│           │   2. waitForResponse()                                     │ │
│           │   3. getLastResponseText()  ← EXTRACT FROM DOM            │ │
│           │      └─ Query [data-message-author-role="assistant"]      │ │
│           │      └─ Extract innerText                                  │ │
│           │      └─ Remove citations/buttons                          │ │
│           │      └─ Retry 15x with 300ms delays                       │ │
│           │      └─ If not found, try:                                │ │
│           │         - conversation-turn containers                     │ │
│           │         - article tags                                     │ │
│           │   4. validateResponse(text)                                │ │
│           │      └─ Check: text.length >= 10                          │ │
│           │   5. [Save ONLY if last prompt]                           │ │
│           │      └─ Store in window._lastResponseToSave               │ │
│           │                                                              │ │
│           │ Return: {success: true, lastResponse: "text..."}          │ │
│           │                                                              │ │
│           └──────────────────────────────────────────────────────────────┘ │
│           ↓                                                                │
│           ┌──────────────────────────────────────────────────────────────┐ │
│           │ STEP 4: SAVE RESPONSE TO STORAGE                            │ │
│           ├──────────────────────────────────────────────────────────────┤ │
│           │                                                              │ │
│           │ saveResponse(result.lastResponse, title, analysisType)     │ │
│           │           ↓                                                 │ │
│           │ chrome.storage.session.get(['responses'])                  │ │
│           │           ↓                                                 │ │
│           │ responses.push({                                           │ │
│           │   text: "ChatGPT response...",                            │ │
│           │   timestamp: Date.now(),                                  │ │
│           │   source: "Article Title",                                │ │
│           │   analysisType: "company" or "portfolio"                  │ │
│           │ })                                                          │ │
│           │           ↓                                                 │ │
│           │ chrome.storage.session.set({ responses })                 │ │
│           │           ↓                                                 │ │
│           │ [STORAGE ONCHANGE EVENT TRIGGERED]                         │ │
│           │                                                              │ │
│           └──────────────────────────────────────────────────────────────┘ │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────────────────┐
│ RESPONSE VIEWER (responses.html + responses.js)                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  [responses.js] Listener:                                                  │
│    chrome.storage.onChanged.addListener((changes, namespace) => {          │
│      if (namespace === 'session' && changes.responses) {                   │
│        loadResponses()  ← RELOAD UI WITH NEW RESPONSE                     │
│      }                                                                      │
│    })                                                                       │
│           ↓                                                                │
│  [loadResponses()] reads from storage                                      │
│           ↓                                                                │
│  [renderResponses()] separates by analysisType                            │
│           ├─ Company responses section                                     │
│           │   ├─ Shows all company responses                              │
│           │   ├─ Newest first (sorted by timestamp desc)                  │
│           │   └─ Each response shows: source, time, copy button           │
│           │                                                                │
│           └─ Portfolio responses section                                  │
│               ├─ Shows all portfolio responses                            │
│               ├─ Newest first                                             │
│               └─ Each response shows: source, time, copy button           │
│                                                                             │
│  [User Actions]:                                                           │
│    • Copy single response → navigator.clipboard.writeText(text)           │
│    • Copy all (company) → Join all texts with \n                          │
│    • Copy all (portfolio) → Join all texts with \n                        │
│    • Clear all → chrome.storage.session.set({responses: []})              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Key Decision Points in Response Saving

### 1. What Gets Saved?
```
❌ NOT SAVED:
  • Response to initial article text
  • Responses to prompts 1, 2, 3... (N-1)
  
✅ SAVED:
  • Response to LAST prompt in chain
  
Why?
  → Allows ChatGPT to build context across prompts
  → Final response has the most value for analysis
```

### 2. How is Response Extracted?
```
PRIMARY (99% of cases):
  document.querySelectorAll('[data-message-author-role="assistant"]')
  → Get last element
  → Extract innerText
  
FALLBACK 1 (if above fails):
  document.querySelectorAll('[data-testid^="conversation-turn-"]')
  → Find last turn with assistant message
  → Extract innerText
  
FALLBACK 2 (last resort):
  document.querySelectorAll('article')
  → Get last article element
  → Extract innerText
  
DEFAULT (if all fail):
  Return empty string ''
```

### 3. Error Recovery Path
```
Error: "Something went wrong while generating the response"
   ↓
Try Edit+Resend:
   ├─ Find user's last message
   ├─ Click Edit button
   ├─ Click Send button
   ├─ Retry up to 3 times
   └─ Result: Success? → Continue
                Failure? → Try Retry button
   
Try Retry button:
   ├─ Find error message
   ├─ Find and click "Retry" button
   ├─ Wait for new response
   └─ Result: Success? → Continue
                Failure? → Show user intervention UI
   
User Intervention:
   ├─ Show buttons: "Continue Waiting" or "Skip"
   ├─ User fixes issue in ChatGPT manually
   └─ User clicks button to resume
```

---

## Storage Structure

### Before Any Responses:
```javascript
{
  responses: []
}
```

### After First Response:
```javascript
{
  responses: [
    {
      text: "The Economist article discusses market trends...",
      timestamp: 1698765432000,
      source: "The Economist - Market Analysis",
      analysisType: "company"
    }
  ]
}
```

### After Multiple Responses:
```javascript
{
  responses: [
    // Company analysis responses
    {
      text: "Quarterly earnings show 5% growth...",
      timestamp: 1698765432000,
      source: "Nikkei Asia - Earnings Report",
      analysisType: "company"
    },
    {
      text: "Foreign investment increased by 15%...",
      timestamp: 1698765540000,
      source: "Caixin Global - Investment Trends",
      analysisType: "company"
    },
    
    // Portfolio analysis responses
    {
      text: "Portfolio exposure to emerging markets...",
      timestamp: 1698765650000,
      source: "Article 1 + Article 2 combined",
      analysisType: "portfolio"
    }
  ]
}
```

---

## Critical Response Extraction Logic

The `getLastResponseText()` function has RETRY MECHANISM:

```javascript
const maxRetries = 15;      // 15 attempts
const retryDelay = 300;     // 300ms between attempts
                            // Total max wait: 4.5 seconds

This handles:
  • React rendering delays
  • Asynchronous DOM updates
  • Streaming response content
```

### Extraction Cleaning:

The `extractMainContent()` sub-function:
1. **Clones** the element (non-destructive)
2. **Removes** non-content elements:
   - `ol[data-block-id]` → Citation lists
   - `div[class*="citation"]` → Citation divs
   - `div[class*="source"]` → Source divs
   - `a[target="_blank"]` → External links
   - `button` → Action buttons
   - `[role="button"]` → Button-like elements
3. **Extracts** text preserving formatting:
   - Uses `innerText` (preserves newlines)
   - Splits by newlines, trims each line
   - Max 2 blank lines in a row
4. **Returns** clean text

---

## Timestamp Formatting

In responses.html, timestamps are formatted using:

```javascript
const date = new Date(timestamp);
const now = new Date();

if (date.toDateString() === now.toDateString()) {
  // Today: "Dzisiaj o 14:32"
  return `Dzisiaj o ${timeStr}`;
} else {
  // Other days: "26 października 2023 o 14:32"
  return `${dateStr} o ${timeStr}`;
}
```

---

## Analysis Type Filtering

`responses.js` automatically separates responses:

```javascript
const companyResponses = responses
  .filter(r => (r.analysisType || 'company') === 'company');
  
const portfolioResponses = responses
  .filter(r => r.analysisType === 'portfolio');

// Note: Older responses without analysisType default to 'company'
```

This allows UI to show two independent sections with separate counts and copy buttons.

