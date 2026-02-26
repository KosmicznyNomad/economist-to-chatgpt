const promptSelect = document.getElementById('promptSelect');
const promptInfo = document.getElementById('promptInfo');
const promptDescription = document.getElementById('promptDescription');
const startBtn = document.getElementById('startBtn');
const cancelBtn = document.getElementById('cancelBtn');

let prompts = [];
let promptNames = [];
let stageMetadata = [];
const stageMetadataByPromptIndex = new Map();

const urlParams = new URLSearchParams(window.location.search);
const presetStartIndex = Number.parseInt(urlParams.get('startIndex'), 10);
const presetTargetTabIdRaw = Number.parseInt(urlParams.get('targetTabId'), 10);
const presetTargetWindowIdRaw = Number.parseInt(urlParams.get('targetWindowId'), 10);
const presetTargetTabId = Number.isInteger(presetTargetTabIdRaw) ? presetTargetTabIdRaw : null;
const presetTargetWindowId = Number.isInteger(presetTargetWindowIdRaw) ? presetTargetWindowIdRaw : null;
const resumeTitle = urlParams.get('title') || '';

function truncateText(text, maxLength = 80) {
  if (!text) return '';
  const compact = String(text).trim().replace(/\s+/g, ' ');
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 3)}...`;
}

function isNumericStageId(value) {
  return typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim());
}

function setPromptDescription(meta, fallbackName = '') {
  if (!promptDescription) return;

  if (!meta || typeof meta !== 'object') {
    promptDescription.hidden = true;
    promptDescription.textContent = '';
    return;
  }

  const lines = [];
  const stageId = typeof meta.stageId === 'string' ? meta.stageId.trim() : '';
  const stageName = typeof meta.stageName === 'string' ? meta.stageName.trim() : '';
  const description = typeof meta.description === 'string' ? meta.description.trim() : '';

  if (stageId) {
    lines.push(isNumericStageId(stageId) ? `Etap: Stage ${stageId}` : `Etap: ${stageId}`);
  }
  if (stageName || fallbackName) {
    lines.push(`Nazwa: ${stageName || fallbackName}`);
  }
  if (description) {
    lines.push(`Opis: ${description}`);
  }

  if (lines.length === 0) {
    promptDescription.hidden = true;
    promptDescription.textContent = '';
    return;
  }

  promptDescription.hidden = false;
  promptDescription.textContent = lines.join('\n');
}

function getStageMetaForPromptIndex(promptIndex) {
  if (!Number.isInteger(promptIndex)) return null;
  if (stageMetadataByPromptIndex.has(promptIndex)) {
    return stageMetadataByPromptIndex.get(promptIndex);
  }
  return null;
}

async function loadPrompts() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_COMPANY_PROMPTS' });
    if (!(response && Array.isArray(response.prompts) && response.prompts.length > 0)) {
      throw new Error('Brak promptow');
    }
    prompts = response.prompts;

    const namesResponse = await chrome.runtime.sendMessage({ type: 'GET_STAGE_NAMES' });
    if (Array.isArray(namesResponse?.stageNames)) {
      promptNames = namesResponse.stageNames;
    }

    if (Array.isArray(namesResponse?.stageMetadata)) {
      stageMetadata = namesResponse.stageMetadata;
      stageMetadataByPromptIndex.clear();
      stageMetadata.forEach((entry) => {
        if (!entry || typeof entry !== 'object') return;
        if (!Number.isInteger(entry.promptIndex)) return;
        stageMetadataByPromptIndex.set(entry.promptIndex, entry);
      });
    }

    populateDropdown();
  } catch (error) {
    console.error('Blad ladowania promptow:', error);
    promptInfo.textContent = 'Blad ladowania promptow';
    promptInfo.style.color = '#d93025';
    setPromptDescription(null);
  }
}

function populateDropdown() {
  promptSelect.innerHTML = '';

  const placeholderOption = document.createElement('option');
  placeholderOption.value = '';
  placeholderOption.textContent = 'Wybierz prompt...';
  placeholderOption.disabled = true;
  placeholderOption.selected = true;
  promptSelect.appendChild(placeholderOption);

  // Prompt 1 zawiera {{articlecontent}}, dlatego resume startuje od promptu 2.
  for (let i = 1; i < prompts.length; i += 1) {
    const option = document.createElement('option');
    option.value = i;

    const promptNumber = i + 1;
    const meta = getStageMetaForPromptIndex(i);
    const promptName = promptNames && promptNames[i] ? promptNames[i] : '';

    let displayText = '';
    if (meta && typeof meta.stageName === 'string' && meta.stageName.trim()) {
      displayText = `Prompt ${promptNumber}: ${meta.stageName.trim()}`;
    } else if (promptName) {
      displayText = `Prompt ${promptNumber}: ${promptName}`;
    } else {
      displayText = `Prompt ${promptNumber}: ${truncateText(prompts[i])}`;
    }

    option.textContent = displayText;
    promptSelect.appendChild(option);
  }

  if (Number.isInteger(presetStartIndex)) {
    const clamped = Math.min(Math.max(presetStartIndex, 1), Math.max(1, prompts.length - 1));
    promptSelect.value = String(clamped);
  }

  updateInfo();
}

function updateInfo() {
  if (prompts.length === 0) {
    promptInfo.textContent = 'Brak dostepnych promptow';
    startBtn.disabled = true;
    setPromptDescription(null);
    return;
  }

  const selectedIndex = Number.parseInt(promptSelect.value, 10);
  const prefixParts = [];
  if (resumeTitle) prefixParts.push(`Zrodlo: ${resumeTitle}`);
  const prefix = prefixParts.length > 0 ? `${prefixParts.join(' - ')}\n` : '';

  if (!Number.isInteger(selectedIndex)) {
    promptInfo.textContent = `${prefix}Dostepne prompty: 2-${prompts.length} (${prompts.length - 1} promptow)`;
    startBtn.disabled = true;
    setPromptDescription(null);
    return;
  }

  const remaining = prompts.length - selectedIndex;
  const promptNumber = selectedIndex + 1;
  const promptName = promptNames && promptNames[selectedIndex]
    ? promptNames[selectedIndex]
    : `Prompt ${promptNumber}`;

  promptInfo.textContent = `${prefix}Wybrano: "${promptName}" - zostanie wykonanych ${remaining} prompt${remaining === 1 ? '' : remaining < 5 ? 'y' : 'ow'} (prompty ${promptNumber}-${prompts.length})`;
  startBtn.disabled = false;

  const meta = getStageMetaForPromptIndex(selectedIndex);
  setPromptDescription(meta, promptName);
}

promptSelect.addEventListener('change', updateInfo);

startBtn.addEventListener('click', () => {
  const selectedIndex = Number.parseInt(promptSelect.value, 10);
  if (!Number.isInteger(selectedIndex)) return;

  startBtn.disabled = true;
  chrome.runtime.sendMessage({
    type: 'RESUME_STAGE_START',
    startIndex: selectedIndex,
    targetTabId: presetTargetTabId,
    targetWindowId: presetTargetWindowId,
    title: resumeTitle,
    reloadBeforeResume: true,
    detach: true
  }, () => {
    if (chrome.runtime.lastError) {
      console.warn('RESUME_STAGE_START send failed:', chrome.runtime.lastError.message || chrome.runtime.lastError);
    }
    window.close();
  });
});

cancelBtn.addEventListener('click', () => {
  window.close();
});

loadPrompts();
