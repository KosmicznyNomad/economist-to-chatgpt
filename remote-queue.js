const RemoteUiSharedUtils = globalThis.RemoteUiSharedUtils || {};

const titleInput = document.getElementById('titleInput');
const textInput = document.getElementById('textInput');
const decreaseBtn = document.getElementById('decreaseBtn');
const increaseBtn = document.getElementById('increaseBtn');
const instancesValue = document.getElementById('instancesValue');
const runnerStatus = document.getElementById('runnerStatus');
const configHint = document.getElementById('configHint');
const submitBtn = document.getElementById('submitBtn');
const submitStatus = document.getElementById('submitStatus');
const batchStatus = document.getElementById('batchStatus');
const batchJobs = document.getElementById('batchJobs');
const refreshBtn = document.getElementById('refreshBtn');

const MIN_INSTANCES = 1;
const MAX_INSTANCES = 10;
let instances = 1;
let currentBatchId = '';
let refreshTimer = null;
let submitInFlight = false;
let pendingSubmissionId = '';
let currentPrefill = null;

const urlParams = new URLSearchParams(window.location.search);
const prefillId = urlParams.get('prefillId') || '';
const presetTitle = urlParams.get('title') || '';
if (presetTitle && !titleInput.value) {
  titleInput.value = presetTitle;
}

function setStatus(element, text, tone = '') {
  if (!element) return;
  const safeText = typeof text === 'string' ? text.trim() : '';
  element.hidden = !safeText;
  element.textContent = safeText;
  element.className = 'status';
  if (tone) element.classList.add(tone);
}

function updateInstancesUi() {
  instancesValue.textContent = String(instances);
  decreaseBtn.disabled = instances <= MIN_INSTANCES;
  increaseBtn.disabled = instances >= MAX_INSTANCES;
}

function updateSubmitButton() {
  submitBtn.disabled = submitInFlight || textInput.value.trim().length === 0;
}

function formatRunnerStatusPayload(runner) {
  if (typeof RemoteUiSharedUtils.formatRunnerStatus === 'function') {
    return RemoteUiSharedUtils.formatRunnerStatus(runner || {});
  }
  return {
    tone: runner?.queueable ? 'success' : 'warn',
    text: runner?.runnerName || runner?.runnerId || 'Runner'
  };
}

function formatBatchStatusPayload(batch) {
  if (typeof RemoteUiSharedUtils.formatBatchStatus === 'function') {
    return RemoteUiSharedUtils.formatBatchStatus(batch || {});
  }
  return {
    tone: 'info',
    text: batch?.batchState || 'Brak batcha'
  };
}

function renderBatch(batch) {
  if (!batch || typeof batch !== 'object') {
    currentBatchId = '';
    setStatus(batchStatus, 'Brak batcha.', '');
    batchJobs.innerHTML = '';
    return;
  }
  currentBatchId = typeof batch.batchId === 'string' ? batch.batchId : '';
  const batchSummary = formatBatchStatusPayload(batch);
  setStatus(batchStatus, batchSummary.text, batchSummary.tone);
  const jobs = Array.isArray(batch.jobs) ? batch.jobs : [];
  if (jobs.length === 0) {
    batchJobs.innerHTML = '';
    return;
  }
  batchJobs.innerHTML = jobs.map((job) => {
    const title = typeof job?.title === 'string' && job.title.trim()
      ? job.title.trim()
      : `Instancja ${job?.instanceIndex || '?'}`;
    const status = typeof job?.status === 'string' ? job.status : 'unknown';
    const link = typeof job?.conversationUrl === 'string' && job.conversationUrl.trim()
      ? `<a href="${job.conversationUrl}" target="_blank" rel="noreferrer">rozmowa</a>`
      : '';
    const failure = job?.failure?.reason || job?.failure?.error || '';
    return [
      '<div class="batch-job">',
      `<strong>${title}</strong><br>`,
      `status: ${status}`,
      link ? ` | ${link}` : '',
      failure ? `<br>blad: ${failure}` : '',
      '</div>'
    ].join('');
  }).join('');
}

async function refreshRunnerStatus() {
  const configResponse = await sendRuntimeMessage({ type: 'GET_REMOTE_RUNNER_CONFIG' });
  if (configResponse?.success === false) {
    setStatus(runnerStatus, `Blad configu: ${configResponse.error || 'unknown'}`, 'error');
    submitBtn.disabled = true;
    return;
  }
  const defaultRunnerId = typeof configResponse?.remoteDefaultRunnerId === 'string'
    ? configResponse.remoteDefaultRunnerId.trim()
    : '';
  if (!defaultRunnerId) {
    setStatus(runnerStatus, 'Brak default runner id w popupie.', 'warn');
    setStatus(configHint, 'Uzupelnij remote config w popupie i zapisz ustawienia.', 'warn');
    submitBtn.disabled = true;
    return;
  }
  setStatus(configHint, `This device id: ${configResponse?.thisDeviceId || ''}`, '');
  const statusResponse = await sendRuntimeMessage({ type: 'GET_REMOTE_DEFAULT_RUNNER_STATUS' });
  if (statusResponse?.success === false) {
    setStatus(runnerStatus, `Blad statusu runnera: ${statusResponse.error || 'unknown'}`, 'error');
    return;
  }
  const runnerSummary = formatRunnerStatusPayload(statusResponse.runner || {});
  setStatus(runnerStatus, runnerSummary.text, runnerSummary.tone);
}

async function refreshBatch() {
  const response = await sendRuntimeMessage({
    type: 'GET_REMOTE_BATCH_STATUS',
    ...(currentBatchId ? { batchId: currentBatchId } : {})
  });
  if (response?.success === false) {
    setStatus(batchStatus, `Blad batcha: ${response.error || 'unknown'}`, 'error');
    return;
  }
  renderBatch(response?.batch || null);
}

function generateSubmissionId() {
  if (typeof crypto?.randomUUID === 'function') {
    return `rsubmit-${crypto.randomUUID()}`;
  }
  return `rsubmit-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function resetPendingSubmission() {
  if (submitInFlight) return;
  pendingSubmissionId = '';
}

function formatSubmitError(error = '') {
  const normalizedError = typeof error === 'string' ? error.trim() : '';
  if (normalizedError === 'remote_pdf_not_supported_yet') {
    return 'Remote PDF nie jest jeszcze wspierany. Najpierw wyciagnij tekst lokalnie i wyslij go jako manual text.';
  }
  if (normalizedError === 'prefill_not_found') {
    return 'Prefill wygasl albo nie istnieje. Mozesz nadal wkleić tekst recznie.';
  }
  return `Blad submitu: ${normalizedError || 'unknown'}`;
}

async function loadPrefill() {
  if (!prefillId) return;
  setStatus(submitStatus, 'Pobieram przygotowany tekst artykulu...', '');
  const response = await sendRuntimeMessage({
    type: 'GET_REMOTE_QUEUE_PREFILL',
    prefillId
  });
  if (response?.success !== true || !response?.prefill) {
    setStatus(submitStatus, formatSubmitError(response?.error || 'prefill_not_found'), 'warn');
    return;
  }
  currentPrefill = response.prefill;
  if (currentPrefill?.sourceKind === 'manual_pdf') {
    setStatus(submitStatus, formatSubmitError('remote_pdf_not_supported_yet'), 'error');
    updateSubmitButton();
    return;
  }
  if (!titleInput.value.trim() && typeof currentPrefill?.title === 'string') {
    titleInput.value = currentPrefill.title;
  }
  if (!textInput.value.trim() && typeof currentPrefill?.text === 'string') {
    textInput.value = currentPrefill.text;
  }
  setStatus(submitStatus, 'Pobrano tekst aktywnego artykulu. Sprawdz go i potwierdz submit.', '');
  updateSubmitButton();
}

async function submitBatch() {
  const text = textInput.value.trim();
  const title = titleInput.value.trim() || 'Recznie wklejony artykul';
  if (!text || currentPrefill?.sourceKind === 'manual_pdf') return;
  submitInFlight = true;
  if (!pendingSubmissionId) {
    pendingSubmissionId = generateSubmissionId();
  }
  updateSubmitButton();
  setStatus(submitStatus, 'Wysylam batch do kolejki...', '');
  const response = await sendRuntimeMessage({
    type: 'SUBMIT_REMOTE_MANUAL_BATCH',
    title,
    text,
    instances,
    submissionId: pendingSubmissionId,
    sourceKind: typeof currentPrefill?.sourceKind === 'string' ? currentPrefill.sourceKind : 'manual_text'
  });
  submitInFlight = false;
  if (response?.success === false) {
    setStatus(submitStatus, formatSubmitError(response.error), 'error');
    updateSubmitButton();
    return;
  }
  currentBatchId = typeof response?.batchId === 'string' ? response.batchId : '';
  if (!(response?.batchState === 'partial' || Number(response?.failedCount || 0) > 0)) {
    pendingSubmissionId = '';
  }
  const summary = response?.batchState === 'partial'
    ? `Batch partial: utworzono ${response.createdCount}, bledy ${response.failedCount}.`
    : `Batch utworzony: ${response.createdCount}/${response.requestedInstances}.`;
  setStatus(submitStatus, summary, response?.batchState === 'partial' ? 'warn' : 'success');
  await refreshBatch();
  updateSubmitButton();
}

decreaseBtn.addEventListener('click', () => {
  if (instances > MIN_INSTANCES) {
    instances -= 1;
    resetPendingSubmission();
    updateInstancesUi();
    updateSubmitButton();
  }
});

increaseBtn.addEventListener('click', () => {
  if (instances < MAX_INSTANCES) {
    instances += 1;
    resetPendingSubmission();
    updateInstancesUi();
    updateSubmitButton();
  }
});

refreshBtn.addEventListener('click', () => {
  void refreshRunnerStatus();
  void refreshBatch();
});

submitBtn.addEventListener('click', () => {
  void submitBatch();
});

titleInput.addEventListener('input', () => {
  resetPendingSubmission();
});
textInput.addEventListener('input', () => {
  resetPendingSubmission();
  updateSubmitButton();
});
textInput.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    if (!submitBtn.disabled) {
      void submitBatch();
    }
  }
});

updateInstancesUi();
updateSubmitButton();
void loadPrefill();
void refreshRunnerStatus();
void refreshBatch();

refreshTimer = setInterval(() => {
  void refreshRunnerStatus();
  void refreshBatch();
}, 15000);

window.addEventListener('beforeunload', () => {
  if (refreshTimer) clearInterval(refreshTimer);
});
