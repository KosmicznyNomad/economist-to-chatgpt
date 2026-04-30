// manual-source.js - manual text + PDF provider window

const titleInput = document.getElementById('titleInput');
const sourceInput = document.getElementById('sourceInput');
const pdfInput = document.getElementById('pdfInput');
const pdfList = document.getElementById('pdfList');
const providerStatus = document.getElementById('providerStatus');
const instancePresetButtons = Array.from(document.querySelectorAll('[data-instances]'));
const submitBtn = document.getElementById('submitBtn');
const cancelBtn = document.getElementById('cancelBtn');

const DEFAULT_INSTANCES = 5;
const ALLOWED_INSTANCE_COUNTS = new Set([5, 10, 20]);
const MANUAL_SOURCE_PREFILL_STORAGE_KEY = 'manual_source_prefill_draft';
const MANUAL_SOURCE_PREFILL_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_CHUNK_SIZE = 512 * 1024;
const PROVIDER_KEEPALIVE_INTERVAL_MS = 15000;

let instances = DEFAULT_INSTANCES;
let queueActive = false;
const providerId = `manual-pdf-provider-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const pdfFileByToken = new Map();
let selectedPdfFiles = [];
let providerPort = null;
let providerKeepaliveTimer = null;

const urlParams = new URLSearchParams(window.location.search);
const presetTitle = urlParams.get('title') || '';
const prefillToken = urlParams.get('prefillToken') || '';
if (presetTitle && !titleInput.value) {
  titleInput.value = presetTitle;
}

function setProviderStatus(text, tone = 'info') {
  providerStatus.textContent = text || '';
  providerStatus.className = 'provider-status';
  if (tone) {
    providerStatus.classList.add(tone);
  }
}

function formatBytes(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return '0 B';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(2)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function buildPdfToken(index, file) {
  const baseName = String(file?.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  return `pdf-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}-${baseName}`;
}

function updateSubmitButton() {
  const hasText = sourceInput.value.trim().length > 0;
  const hasPdf = selectedPdfFiles.length > 0;
  submitBtn.disabled = queueActive || (!hasText && !hasPdf);
}

function normalizeInstances(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return DEFAULT_INSTANCES;
  return ALLOWED_INSTANCE_COUNTS.has(parsed) ? parsed : DEFAULT_INSTANCES;
}

function updateInstancesDisplay() {
  instancePresetButtons.forEach((button) => {
    const buttonValue = normalizeInstances(button.dataset.instances);
    const isActive = buttonValue === instances;
    button.classList.toggle('is-active', isActive);
    button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    button.disabled = queueActive;
  });
}

function setQueueUiLocked(locked) {
  const isLocked = locked === true;
  titleInput.disabled = isLocked;
  sourceInput.disabled = isLocked;
  pdfInput.disabled = isLocked;
  if (isLocked) {
    instancePresetButtons.forEach((button) => {
      button.disabled = true;
    });
  } else {
    updateInstancesDisplay();
  }
}

function getManualSourcePrefillStorageArea() {
  const storage = typeof chrome !== 'undefined' ? chrome.storage : null;
  if (storage?.session) return storage.session;
  if (storage?.local) return storage.local;
  return null;
}

function readChromeStorage(area, keys) {
  return new Promise((resolve, reject) => {
    try {
      area.get(keys, (result) => {
        const lastError = typeof chrome !== 'undefined' ? chrome.runtime?.lastError : null;
        if (lastError) {
          reject(new Error(lastError.message || 'storage_get_failed'));
          return;
        }
        resolve(result || {});
      });
    } catch (error) {
      reject(error);
    }
  });
}

function removeChromeStorage(area, keys) {
  return new Promise((resolve) => {
    try {
      area.remove(keys, () => resolve());
    } catch (_) {
      resolve();
    }
  });
}

async function hydrateClipboardPrefill() {
  if (!prefillToken) return;

  const storageArea = getManualSourcePrefillStorageArea();
  if (!storageArea) {
    setProviderStatus('Nie udalo sie odczytac tekstu ze schowka. Wklej recznie.', 'error');
    return;
  }

  try {
    const stored = await readChromeStorage(storageArea, [MANUAL_SOURCE_PREFILL_STORAGE_KEY]);
    const draft = stored?.[MANUAL_SOURCE_PREFILL_STORAGE_KEY];
    const draftToken = typeof draft?.token === 'string' ? draft.token : '';
    const createdAt = Number.isInteger(draft?.createdAt) ? draft.createdAt : 0;
    const isFresh = createdAt > 0 && Date.now() - createdAt <= MANUAL_SOURCE_PREFILL_MAX_AGE_MS;
    const text = typeof draft?.text === 'string' ? draft.text : '';

    if (draftToken !== prefillToken) {
      return;
    }

    if (!isFresh || !text.trim()) {
      await removeChromeStorage(storageArea, [MANUAL_SOURCE_PREFILL_STORAGE_KEY]);
      return;
    }

    if (!sourceInput.value.trim()) {
      sourceInput.value = text;
      updateSubmitButton();
      sourceInput.focus();
      setProviderStatus('Wczytano tekst ze schowka.', 'success');
    }
    await removeChromeStorage(storageArea, [MANUAL_SOURCE_PREFILL_STORAGE_KEY]);
  } catch (error) {
    setProviderStatus(`Nie udalo sie odczytac schowka: ${error?.message || String(error)}.`, 'error');
  }
}

function renderPdfList() {
  if (!selectedPdfFiles.length) {
    pdfList.hidden = true;
    pdfList.innerHTML = '';
    return;
  }

  const rows = selectedPdfFiles
    .map((entry) => {
      const safeName = String(entry.name || 'unknown.pdf')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return [
        '<div class="pdf-item">',
        `  <span class="pdf-item-name" title="${safeName}">${safeName}</span>`,
        `  <span>${formatBytes(entry.size)}</span>`,
        '</div>',
      ].join('\n');
    })
    .join('\n');

  pdfList.innerHTML = rows;
  pdfList.hidden = false;
}

function stopProviderKeepalive() {
  if (providerKeepaliveTimer !== null) {
    clearInterval(providerKeepaliveTimer);
    providerKeepaliveTimer = null;
  }
  if (providerPort) {
    try {
      providerPort.disconnect();
    } catch (_) {
      // Ignore disconnect races.
    }
    providerPort = null;
  }
}

function startProviderKeepalive() {
  if (providerPort) return;
  try {
    providerPort = chrome.runtime.connect({ name: `manual-pdf-provider:${providerId}` });
    providerPort.onDisconnect.addListener(() => {
      providerPort = null;
      if (providerKeepaliveTimer !== null) {
        clearInterval(providerKeepaliveTimer);
        providerKeepaliveTimer = null;
      }
      if (queueActive) {
        setProviderStatus('Utracono polaczenie z workerem. Odswiez rozszerzenie i uruchom ponownie.', 'error');
      }
    });
    providerPort.postMessage({
      type: 'MANUAL_PDF_PROVIDER_KEEPALIVE',
      providerId,
      state: queueActive ? 'active' : 'idle',
      timestamp: Date.now(),
    });
    providerKeepaliveTimer = setInterval(() => {
      if (!providerPort) return;
      try {
        providerPort.postMessage({
          type: 'MANUAL_PDF_PROVIDER_KEEPALIVE',
          providerId,
          state: queueActive ? 'active' : 'idle',
          timestamp: Date.now(),
        });
      } catch (_) {
        // onDisconnect listener handles cleanup.
      }
    }, PROVIDER_KEEPALIVE_INTERVAL_MS);
  } catch (_) {
    providerPort = null;
    if (providerKeepaliveTimer !== null) {
      clearInterval(providerKeepaliveTimer);
      providerKeepaliveTimer = null;
    }
    if (queueActive) {
      setProviderStatus('Nie udalo sie utrzymac polaczenia z workerem.', 'error');
    }
  }
}

function syncPdfSelection() {
  const chosen = Array.from(pdfInput.files || []);
  let rejectedCount = 0;
  let duplicateCount = 0;
  let addedCount = 0;
  const existingFileKeys = new Set(
    selectedPdfFiles.map((entry) => `${entry.name}::${entry.size}::${entry.lastModified}`)
  );

  chosen.forEach((file, index) => {
    const name = String(file?.name || '');
    const type = String(file?.type || '').toLowerCase();
    const isPdf = type === 'application/pdf' || name.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      rejectedCount += 1;
      return;
    }

    const fileKey = `${file.name || `source-${index + 1}.pdf`}::${Number.isFinite(file.size) ? file.size : 0}::${Number.isInteger(file.lastModified) ? file.lastModified : 0}`;
    if (existingFileKeys.has(fileKey)) {
      duplicateCount += 1;
      return;
    }

    const token = buildPdfToken(index, file);
    pdfFileByToken.set(token, file);
    selectedPdfFiles.push({
      token,
      name: file.name || `source-${index + 1}.pdf`,
      size: Number.isFinite(file.size) ? file.size : 0,
      mimeType: 'application/pdf',
      lastModified: Number.isInteger(file.lastModified) ? file.lastModified : Date.now(),
    });
    existingFileKeys.add(fileKey);
    addedCount += 1;
  });

  // Allow selecting additional files in subsequent picker opens.
  pdfInput.value = '';

  renderPdfList();
  updateSubmitButton();

  if (rejectedCount > 0 || duplicateCount > 0) {
    const parts = [];
    if (addedCount > 0) {
      parts.push(`Dodano ${addedCount} PDF.`);
    }
    if (duplicateCount > 0) {
      parts.push(`Pominieto ${duplicateCount} duplikat(ow).`);
    }
    if (rejectedCount > 0) {
      parts.push(`Pominieto ${rejectedCount} plik(ow), bo nie sa PDF.`);
    }
    parts.push(`Razem: ${selectedPdfFiles.length}.`);
    setProviderStatus(parts.join(' '), rejectedCount > 0 ? 'error' : 'info');
  } else if (selectedPdfFiles.length > 0) {
    setProviderStatus(`Wybrano ${selectedPdfFiles.length} PDF.`, 'info');
  } else {
    setProviderStatus('', '');
  }
}

function parseBase64FromDataUrl(dataUrl) {
  const raw = typeof dataUrl === 'string' ? dataUrl : '';
  const markerIndex = raw.indexOf(',');
  if (markerIndex < 0) return '';
  return raw.slice(markerIndex + 1);
}

function readBlobAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('chunk_read_failed'));
    reader.readAsDataURL(blob);
  });
}

async function handlePdfChunkRead(message) {
  const incomingProviderId = typeof message?.providerId === 'string' ? message.providerId.trim() : '';
  if (!incomingProviderId || incomingProviderId !== providerId) {
    return { success: false, error: 'provider_mismatch' };
  }

  const token = typeof message?.token === 'string' ? message.token.trim() : '';
  if (!token || !pdfFileByToken.has(token)) {
    return { success: false, error: 'token_not_found' };
  }

  const file = pdfFileByToken.get(token);
  const offset = Number.isInteger(message?.offset) && message.offset >= 0 ? message.offset : 0;
  const chunkSize = Number.isInteger(message?.chunkSize) && message.chunkSize > 0
    ? Math.min(message.chunkSize, 2 * 1024 * 1024)
    : DEFAULT_CHUNK_SIZE;

  if (offset >= file.size) {
    return {
      success: true,
      eof: true,
      base64Chunk: '',
      nextOffset: file.size,
    };
  }

  try {
    const nextOffset = Math.min(offset + chunkSize, file.size);
    const blob = file.slice(offset, nextOffset);
    const dataUrl = await readBlobAsDataUrl(blob);
    const base64Chunk = parseBase64FromDataUrl(dataUrl);
    return {
      success: true,
      eof: nextOffset >= file.size,
      base64Chunk,
      nextOffset,
    };
  } catch (error) {
    return {
      success: false,
      error: error?.message || 'chunk_read_failed',
    };
  }
}

function releasePdfProviderState(releaseMessage = '') {
  queueActive = false;
  stopProviderKeepalive();
  pdfFileByToken.clear();
  selectedPdfFiles = [];
  pdfInput.value = '';
  setQueueUiLocked(false);
  renderPdfList();
  updateSubmitButton();
  submitBtn.textContent = 'Uruchom';

  if (releaseMessage) {
    setProviderStatus(releaseMessage, 'success');
  } else {
    setProviderStatus('Kolejka PDF zakonczona.', 'success');
  }
}

sourceInput.addEventListener('input', updateSubmitButton);
pdfInput.addEventListener('change', syncPdfSelection);

instancePresetButtons.forEach((button) => {
  button.addEventListener('click', () => {
    if (queueActive) return;
    instances = normalizeInstances(button.dataset.instances);
    updateInstancesDisplay();
  });
});

submitBtn.addEventListener('click', async () => {
  if (queueActive) return;

  const hasPdf = selectedPdfFiles.length > 0;
  const text = sourceInput.value.trim();
  const title = titleInput.value.trim() || 'Recznie wklejony artykul';

  if (!hasPdf && !text) return;

  submitBtn.disabled = true;
  submitBtn.textContent = 'Uruchamiam...';

  const payload = hasPdf
    ? {
      type: 'MANUAL_SOURCE_SUBMIT',
      mode: 'pdf',
      title,
      instances,
      pdfProviderId: providerId,
      pdfFiles: selectedPdfFiles,
    }
    : {
      type: 'MANUAL_SOURCE_SUBMIT',
      mode: 'text',
      text,
      title,
      instances,
    };

  if (hasPdf) {
    startProviderKeepalive();
  }

  const response = await sendRuntimeMessage(payload);
  if (response?.ok === false) {
    submitBtn.textContent = 'Blad';
    submitBtn.disabled = false;
    setProviderStatus(`Blad wysylki: ${response.errorMessage || response.errorCode || 'runtime_error'}`, 'error');
    if (hasPdf) {
      stopProviderKeepalive();
    }
    return;
  }

  if (!response?.success) {
    const launchError = response?.error || response?.reason || 'unknown';
    const launchMessage = launchError === 'prompts_not_loaded'
      ? 'Brak promptow company. Odswiez rozszerzenie i sprobuj ponownie.'
      : launchError;
    submitBtn.textContent = 'Blad';
    submitBtn.disabled = false;
    setProviderStatus(`Blad uruchomienia: ${launchMessage}`, 'error');
    if (hasPdf) {
      stopProviderKeepalive();
    }
    return;
  }

  const maxConcurrent = Number.isInteger(response?.maxConcurrent) ? response.maxConcurrent : 7;
  const usedSlots = Number.isInteger(response?.reservedSlots)
    ? response.reservedSlots
    : (Number.isInteger(response?.activeSlots) ? response.activeSlots : 0);

  if (hasPdf) {
    queueActive = true;
    startProviderKeepalive();
    setQueueUiLocked(true);
    submitBtn.disabled = true;
    submitBtn.textContent = 'Kolejka uruchomiona';
    setProviderStatus(
      `Provider aktywny. Zakolejkowano ${response?.queuedCount || response?.queued || 0} zadan, sloty ${usedSlots}/${maxConcurrent}, kolejka ${response?.queueSize || 0}.`,
      'info'
    );
    return;
  }

  submitBtn.textContent = 'Uruchomiono';
  setProviderStatus(
    `Zakolejkowano ${response?.queuedCount || response?.queued || 0} analiz. Sloty ${usedSlots}/${maxConcurrent}, kolejka ${response?.queueSize || 0}.`,
    'success'
  );
  setTimeout(() => {
    submitBtn.textContent = 'Uruchom';
    updateSubmitButton();
  }, 900);
});

cancelBtn.addEventListener('click', () => {
  window.close();
});

sourceInput.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    if (!submitBtn.disabled) {
      submitBtn.click();
    }
  }
});

window.addEventListener('beforeunload', (event) => {
  if (!queueActive) return;
  event.preventDefault();
  event.returnValue = 'Aktywna kolejka PDF zostanie przerwana po zamknieciu okna.';
});

window.addEventListener('unload', () => {
  stopProviderKeepalive();
});

const runtimeMessageApi = typeof chrome !== 'undefined' ? chrome.runtime?.onMessage : null;
if (runtimeMessageApi?.addListener) {
  runtimeMessageApi.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;

    if (message.type === 'MANUAL_PDF_PROVIDER_READ_CHUNK') {
      (async () => {
        const result = await handlePdfChunkRead(message);
        sendResponse(result);
      })().catch((error) => {
        sendResponse({
          success: false,
          error: error?.message || 'chunk_read_failed',
        });
      });
      return true;
    }

    if (message.type === 'MANUAL_PDF_PROVIDER_STATUS') {
      if (message.providerId === providerId) {
        const statusText = typeof message.message === 'string' ? message.message : '';
        const status = typeof message.status === 'string' ? message.status : '';
        if (statusText) {
          if (status === 'failed') {
            setProviderStatus(statusText, 'error');
          } else if (status === 'completed') {
            setProviderStatus(statusText, 'success');
          } else {
            setProviderStatus(statusText, 'info');
          }
        }
      }
      if (typeof sendResponse === 'function') {
        sendResponse({ success: true });
      }
      return false;
    }

    if (message.type === 'MANUAL_PDF_PROVIDER_RELEASE') {
      if (message.providerId === providerId) {
        const releaseMessage = typeof message.message === 'string' ? message.message : '';
        releasePdfProviderState(releaseMessage);
      }
      if (typeof sendResponse === 'function') {
        sendResponse({ success: true });
      }
      return false;
    }

    return false;
  });
}

setQueueUiLocked(false);
updateSubmitButton();
updateInstancesDisplay();
void hydrateClipboardPrefill();
