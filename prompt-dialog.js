const promptInput = document.getElementById('promptInput');
const promptCount = document.getElementById('promptCount');
const submitBtn = document.getElementById('submitBtn');
const cancelBtn = document.getElementById('cancelBtn');

// Parsuj prompty z textarea
function parsePrompts(text) {
  if (!text.trim()) {
    return [];
  }
  
  return text
    .split('~')
    .map(p => p.trim())
    .filter(p => p.length > 0);
}

// Aktualizuj licznik promptów
function updatePromptCount() {
  const prompts = parsePrompts(promptInput.value);
  const count = prompts.length;
  
  promptCount.textContent = count === 0 
    ? '0 promptów' 
    : count === 1 
      ? '1 prompt' 
      : `${count} promptów`;
  
  submitBtn.disabled = count === 0;
}

// Nasłuchuj zmian w textarea
promptInput.addEventListener('input', updatePromptCount);

// Obsługa przycisku Submit
submitBtn.addEventListener('click', () => {
  const prompts = parsePrompts(promptInput.value);
  
  if (prompts.length > 0) {
    chrome.runtime.sendMessage({
      type: 'PROMPT_CHAIN_SUBMIT',
      prompts: prompts
    });
  }
});

// Obsługa przycisku Cancel
cancelBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({
    type: 'PROMPT_CHAIN_CANCEL'
  });
});

// Obsługa Enter z Ctrl/Cmd
promptInput.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    submitBtn.click();
  }
});

// Inicjalizacja
updatePromptCount();



