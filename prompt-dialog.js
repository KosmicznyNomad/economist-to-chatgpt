const promptInput = document.getElementById('promptInput');
const promptCount = document.getElementById('promptCount');
const submitBtn = document.getElementById('submitBtn');
const cancelBtn = document.getElementById('cancelBtn');

const PROMPT_SEPARATOR_LINE_REGEX = /\n[ \t]*(?:\u25C4|\u00E2\u2014\u201E)?PROMPT_SEPARATOR(?:\u25BA|\u00E2\u2013\u015F)?[ \t]*\n/g;
const PROMPT_SEPARATOR_INLINE_REGEX = /(?:\u25C4|\u00E2\u2014\u201E)?PROMPT_SEPARATOR(?:\u25BA|\u00E2\u2013\u015F)?/g;

function parsePrompts(text) {
  const normalizedText = typeof text === 'string'
    ? text.replace(/\uFEFF/g, '').replace(/\r\n?/g, '\n')
    : '';

  if (!normalizedText.trim()) {
    return [];
  }

  const splitAndClean = (value, separatorRegex) => value
    .split(separatorRegex)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  const lineSeparated = splitAndClean(normalizedText, PROMPT_SEPARATOR_LINE_REGEX);
  if (lineSeparated.length > 1) return lineSeparated;

  const inlineSeparated = splitAndClean(normalizedText, PROMPT_SEPARATOR_INLINE_REGEX);
  if (inlineSeparated.length > 1) return inlineSeparated;

  return [normalizedText.trim()];
}

function updatePromptCount() {
  const prompts = parsePrompts(promptInput.value);
  const count = prompts.length;

  promptCount.textContent = count === 0
    ? '0 prompt\u00F3w'
    : count === 1
      ? '1 prompt'
      : `${count} prompt\u00F3w`;

  submitBtn.disabled = count === 0;
}

promptInput.addEventListener('input', updatePromptCount);

submitBtn.addEventListener('click', () => {
  const prompts = parsePrompts(promptInput.value);

  if (prompts.length > 0) {
    void sendRuntimeMessage({
      type: 'PROMPT_CHAIN_SUBMIT',
      prompts
    });
  }
});

cancelBtn.addEventListener('click', () => {
  void sendRuntimeMessage({
    type: 'PROMPT_CHAIN_CANCEL'
  });
});

promptInput.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    submitBtn.click();
  }
});

updatePromptCount();
