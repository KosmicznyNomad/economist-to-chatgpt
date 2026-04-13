(function attachProcessContractUtils(root, factory) {
  const api = factory(root);
  root.ProcessContractUtils = api;
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createProcessContractUtils() {
  const LIFECYCLE_STATUSES = Object.freeze([
    'queued',
    'starting',
    'running',
    'finalizing',
    'completed',
    'failed',
    'stopped'
  ]);
  const PHASES = Object.freeze([
    'queue_wait',
    'slot_reserved',
    'chat_open',
    'editor_ready',
    'payload_send',
    'prompt_send',
    'response_wait',
    'capture_validate',
    'save_local',
    'dispatch_remote',
    'verify_remote'
  ]);
  const ACTION_REQUIRED_VALUES = Object.freeze([
    'none',
    'continue_button',
    'manual_resume',
    'login_needed',
    'rate_limit'
  ]);

  const LIFECYCLE_SET = new Set(LIFECYCLE_STATUSES);
  const PHASE_SET = new Set(PHASES);
  const ACTION_REQUIRED_SET = new Set(ACTION_REQUIRED_VALUES);
  const CLOSED_SET = new Set(['completed', 'failed', 'stopped']);

  function normalizeText(value, fallback = '') {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized || fallback;
  }

  function normalizeCodeToken(value) {
    return normalizeText(value)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '_')
      .replace(/_{2,}/g, '_')
      .replace(/\._/g, '.')
      .replace(/_\./g, '.')
      .replace(/^[_./-]+|[_./-]+$/g, '');
  }

  function lifecycleStatusFromLegacyStatus(value, fallback = 'running') {
    const normalized = normalizeCodeToken(value);
    if (!normalized) return normalizeLifecycleStatus(fallback, 'running');
    if (normalized === 'queued') return 'queued';
    if (normalized === 'starting' || normalized === 'started') return 'starting';
    if (normalized === 'running') return 'running';
    if (normalized === 'finalizing' || normalized === 'post_processing') return 'finalizing';
    if (normalized === 'completed') return 'completed';
    if (
      normalized === 'failed'
      || normalized === 'error'
      || normalized === 'dispatch_failed'
      || normalized === 'save_failed'
    ) {
      return 'failed';
    }
    if (
      normalized === 'stopped'
      || normalized === 'closed'
      || normalized === 'cancelled'
      || normalized === 'canceled'
      || normalized === 'aborted'
      || normalized === 'interrupted'
    ) {
      return 'stopped';
    }
    return normalizeLifecycleStatus(fallback, 'running');
  }

  function normalizeLifecycleStatus(value, fallback = 'running') {
    const normalized = normalizeCodeToken(value);
    if (LIFECYCLE_SET.has(normalized)) return normalized;
    return lifecycleStatusFromLegacyStatus(normalized || fallback, 'running');
  }

  function defaultPhaseForLifecycle(lifecycleStatus) {
    const normalized = normalizeLifecycleStatus(lifecycleStatus, 'running');
    if (normalized === 'queued') return 'queue_wait';
    if (normalized === 'starting') return 'slot_reserved';
    if (normalized === 'finalizing') return 'dispatch_remote';
    if (normalized === 'completed') return 'verify_remote';
    if (normalized === 'failed' || normalized === 'stopped') return '';
    return 'response_wait';
  }

  function normalizePhase(value, fallback = '') {
    const normalized = normalizeCodeToken(value);
    if (PHASE_SET.has(normalized)) return normalized;
    if (normalized === 'init' || normalized === 'preparing' || normalized === 'prepare') return 'chat_open';
    if (normalized === 'capture' || normalized === 'capture_response') return 'capture_validate';
    if (normalized === 'save' || normalized === 'saving') return 'save_local';
    if (normalized === 'dispatch' || normalized === 'send') return 'dispatch_remote';
    if (normalized === 'verify') return 'verify_remote';
    return PHASE_SET.has(fallback) ? fallback : '';
  }

  function normalizeActionRequired(value, fallback = 'none') {
    const normalized = normalizeCodeToken(value);
    if (ACTION_REQUIRED_SET.has(normalized)) return normalized;
    return ACTION_REQUIRED_SET.has(fallback) ? fallback : 'none';
  }

  function deriveActionRequiredFromLegacy(source = {}) {
    const value = source && typeof source === 'object' ? source : {};
    const explicit = normalizeCodeToken(value.actionRequired || '');
    if (ACTION_REQUIRED_SET.has(explicit)) return explicit;

    const markers = [
      normalizeCodeToken(value.statusCode || ''),
      normalizeCodeToken(value.reason || ''),
      normalizeCodeToken(value.error || ''),
      normalizeCodeToken(value.statusText || '')
    ].filter(Boolean);
    const joined = markers.join(' ');

    if (joined.includes('continue')) return 'continue_button';
    if (joined.includes('login') || joined.includes('zalog')) return 'login_needed';
    if (joined.includes('rate_limit') || joined.includes('429') || joined.includes('too_many_requests')) {
      return 'rate_limit';
    }
    if (value.needsAction === true) return 'manual_resume';
    return 'none';
  }

  function deriveStatusCode(input = {}) {
    const normalized = input && typeof input === 'object' ? input : {};
    const explicit = normalizeCodeToken(normalized.statusCode || '');
    if (explicit) return explicit;

    const lifecycleStatus = normalizeLifecycleStatus(
      normalized.lifecycleStatus || normalized.status,
      'running'
    );
    const phase = normalizePhase(normalized.phase || '', defaultPhaseForLifecycle(lifecycleStatus));
    const actionRequired = normalizeActionRequired(
      normalized.actionRequired || '',
      deriveActionRequiredFromLegacy(normalized)
    );
    const effectiveActionRequired = isClosedLifecycleStatus(lifecycleStatus) ? 'none' : actionRequired;
    const reason = normalizeCodeToken(normalized.reason || '');
    const error = normalizeCodeToken(normalized.error || '');
    const statusText = normalizeCodeToken(normalized.statusText || '');

    if (effectiveActionRequired === 'continue_button') return 'chat.continue_button';
    if (effectiveActionRequired === 'login_needed') return 'chat.login_needed';
    if (effectiveActionRequired === 'rate_limit') return 'chat.rate_limited';
    if (effectiveActionRequired === 'manual_resume') return 'process.manual_resume';

    if (reason === 'queue_waiting' || statusText === 'oczekuje_w_kolejce') return 'queue.waiting';
    if (reason === 'slot_reserved' || phase === 'slot_reserved') return 'queue.slot_reserved';
    if (phase === 'queue_wait') return 'queue.waiting';
    if (phase === 'chat_open') return 'chat.opening';
    if (phase === 'editor_ready') return 'chat.editor_ready';
    if (phase === 'payload_send') return 'chat.payload_sending';
    if (phase === 'prompt_send') return 'chat.prompt_sending';
    if (phase === 'response_wait') return 'chat.response_waiting';
    if (phase === 'capture_validate') return 'response.capture_validate';
    if (phase === 'save_local' && lifecycleStatus === 'failed') return 'storage.save_failed';
    if (phase === 'save_local') return 'storage.saving_local';
    if (phase === 'dispatch_remote' && lifecycleStatus === 'failed') return 'dispatch.failed';
    if (phase === 'dispatch_remote') return 'dispatch.pending';
    if (phase === 'verify_remote' && lifecycleStatus === 'completed') return 'dispatch.confirmed';
    if (phase === 'verify_remote' && lifecycleStatus === 'failed') return 'dispatch.failed';
    if (phase === 'verify_remote') return 'dispatch.verify_pending';

    if (reason === 'dispatch_confirmed' || statusText.includes('watchlist_sync_confirmed')) {
      return 'dispatch.confirmed';
    }
    if (
      reason === 'dispatch_skipped'
      || reason === 'missing_dispatch_credentials'
      || reason === 'missing_intake_url'
    ) {
      return 'dispatch.skipped';
    }
    if (
      reason === 'save_failed'
      || reason === 'save_response_failed'
      || error === 'save_response_failed'
    ) {
      return 'storage.save_failed';
    }
    if (
      reason === 'dispatch_failed'
      || error === 'dispatch_failed'
      || statusText.includes('dispatch_failed')
    ) {
      return 'dispatch.failed';
    }
    if (reason === 'empty_response' || error === 'empty_response') return 'response.empty';
    if (reason === 'textarea_not_found' || error === 'textarea_not_found') return 'chat.editor_not_found';
    if (reason === 'execute_script_failed' || error === 'execute_script_failed') return 'chat.execute_script_failed';
    if (reason === 'invalid_response' || error === 'invalid_response') return 'response.invalid';
    if (reason === 'timeout' || error === 'timeout') return 'chat.response_timeout';
    if (reason === 'force_stop' || lifecycleStatus === 'stopped') return 'process.stopped';
    if (lifecycleStatus === 'completed') return 'process.completed';
    if (lifecycleStatus === 'failed') return 'process.failed';
    if (lifecycleStatus === 'finalizing') return 'process.finalizing';
    if (lifecycleStatus === 'starting') return 'process.starting';
    if (lifecycleStatus === 'queued') return 'queue.waiting';
    return 'process.running';
  }

  function isClosedLifecycleStatus(value) {
    return CLOSED_SET.has(normalizeLifecycleStatus(value, 'running'));
  }

  function isFailedLifecycleStatus(value) {
    return normalizeLifecycleStatus(value, 'running') === 'failed';
  }

  function isCompletedLifecycleStatus(value) {
    return normalizeLifecycleStatus(value, 'running') === 'completed';
  }

  function legacyStatusFromLifecycleStatus(value) {
    return normalizeLifecycleStatus(value, 'running');
  }

  function buildStageProgressLabel(process = {}) {
    const currentPrompt = Number.isInteger(process.currentPrompt) && process.currentPrompt > 0
      ? process.currentPrompt
      : null;
    const totalPrompts = Number.isInteger(process.totalPrompts) && process.totalPrompts > 0
      ? process.totalPrompts
      : null;
    const rawStageName = normalizeText(process.stageName || '');
    const looksLikePlainPrompt = /^prompt\s+\d+$/i.test(rawStageName);
    const stageName = looksLikePlainPrompt ? '' : rawStageName;
    const promptLabel = currentPrompt !== null || totalPrompts !== null
      ? `Prompt ${currentPrompt !== null ? currentPrompt : '?'}/${totalPrompts !== null ? totalPrompts : '?'}`
      : '';
    if (promptLabel && stageName) return `${promptLabel} - ${stageName}`;
    return promptLabel || stageName;
  }

  function buildOperatorStatusText(rawProcess = {}) {
    const process = rawProcess && typeof rawProcess === 'object' ? rawProcess : {};
    const lifecycleStatus = normalizeLifecycleStatus(
      process.lifecycleStatus || process.status,
      'running'
    );
    const phase = normalizePhase(process.phase || '', defaultPhaseForLifecycle(lifecycleStatus));
    const actionRequired = normalizeActionRequired(
      process.actionRequired || '',
      deriveActionRequiredFromLegacy(process)
    );
    const effectiveActionRequired = isClosedLifecycleStatus(lifecycleStatus) ? 'none' : actionRequired;
    const statusCode = deriveStatusCode({
      ...process,
      lifecycleStatus,
      phase,
      actionRequired: effectiveActionRequired
    });
    const progressLabel = buildStageProgressLabel(process);
    const queuePosition = Number.isInteger(process.queuePosition) && process.queuePosition > 0
      ? process.queuePosition
      : null;

    if (effectiveActionRequired === 'continue_button') return 'Wymagana akcja: ChatGPT pokazuje Continue.';
    if (effectiveActionRequired === 'login_needed') return 'Wymagana akcja: zaloguj sie do ChatGPT.';
    if (effectiveActionRequired === 'rate_limit') return 'Wymagana akcja: ChatGPT zwrocil limit/restriction.';
    if (effectiveActionRequired === 'manual_resume') return 'Wymagana akcja: wznow proces recznie.';

    switch (statusCode) {
      case 'queue.waiting':
        return queuePosition !== null
          ? `W kolejce. Pozycja ${queuePosition}.`
          : 'W kolejce.';
      case 'queue.slot_reserved':
        return 'Slot przydzielony. Startuje.';
      case 'chat.opening':
        return 'Otwieram karte ChatGPT.';
      case 'chat.editor_ready':
        return 'Karta ChatGPT gotowa.';
      case 'chat.payload_sending':
        return 'Wysylam material zrodlowy.';
      case 'chat.prompt_sending':
        return progressLabel ? `${progressLabel}. Wysylam prompt.` : 'Wysylam prompt.';
      case 'chat.response_waiting':
        return progressLabel ? `${progressLabel}. Czekam na odpowiedz.` : 'Czekam na odpowiedz.';
      case 'response.capture_validate':
        return 'Odpowiedz przechwycona. Trwa walidacja.';
      case 'storage.saving_local':
        return 'Odpowiedz przechwycona. Trwa zapis lokalny.';
      case 'storage.saved_local':
        return 'Zapis lokalny gotowy.';
      case 'dispatch.pending':
        return 'Zapis lokalny gotowy. Trwa wysylka do Watchlist.';
      case 'dispatch.verify_pending':
        return 'Wysylka zakonczona. Trwa verify w Watchlist.';
      case 'dispatch.confirmed':
        return 'Zakonczono. Zapis lokalny i sync do Watchlist gotowe.';
      case 'dispatch.skipped':
        return 'Zapis lokalny gotowy. Sync do Watchlist pominiety.';
      case 'dispatch.failed':
        return 'Zapis lokalny gotowy. Sync do Watchlist nieudany.';
      case 'storage.save_failed':
        return 'Nie udalo sie zapisac odpowiedzi lokalnie.';
      case 'response.empty':
        return 'Proces zakonczony bez zapisanej odpowiedzi.';
      case 'chat.editor_not_found':
        return 'Nie znaleziono edytora ChatGPT.';
      case 'chat.execute_script_failed':
        return 'Blad executeScript podczas komunikacji z karta.';
      case 'chat.response_timeout':
        return progressLabel ? `${progressLabel}. Timeout odpowiedzi.` : 'Timeout odpowiedzi.';
      case 'response.invalid':
        return 'Odpowiedz nie przeszla walidacji.';
      case 'process.stopped':
        return 'Proces zatrzymany.';
      case 'process.completed':
        return 'Proces zakonczony.';
      case 'process.failed':
        return 'Proces nieudany.';
      case 'process.finalizing':
        return 'Analiza zakonczona lokalnie. Trwa finalizacja.';
      case 'process.starting':
        return 'Przygotowuje proces.';
      default:
        break;
    }

    if (lifecycleStatus === 'queued') return 'W kolejce.';
    if (lifecycleStatus === 'starting') return 'Przygotowuje proces.';
    if (lifecycleStatus === 'finalizing') return 'Analiza zakonczona lokalnie. Trwa finalizacja.';
    if (lifecycleStatus === 'completed') return 'Proces zakonczony.';
    if (lifecycleStatus === 'failed') return 'Proces nieudany.';
    if (lifecycleStatus === 'stopped') return 'Proces zatrzymany.';
    return progressLabel ? `${progressLabel}. W trakcie.` : 'Proces w trakcie.';
  }

  function getProcessContract(process = {}) {
    const lifecycleStatus = normalizeLifecycleStatus(
      process.lifecycleStatus || process.status,
      'running'
    );
    const actionRequired = normalizeActionRequired(
      process.actionRequired || '',
      deriveActionRequiredFromLegacy(process)
    );
    const effectiveActionRequired = isClosedLifecycleStatus(lifecycleStatus) ? 'none' : actionRequired;
    const phase = normalizePhase(process.phase || '', defaultPhaseForLifecycle(lifecycleStatus));
    const statusCode = deriveStatusCode({
      ...process,
      lifecycleStatus,
      phase,
      actionRequired: effectiveActionRequired
    });
    return {
      lifecycleStatus,
      phase,
      actionRequired: effectiveActionRequired,
      statusCode,
      statusText: buildOperatorStatusText({
        ...process,
        lifecycleStatus,
        phase,
        actionRequired: effectiveActionRequired,
        statusCode
      })
    };
  }

  return {
    ACTION_REQUIRED_VALUES,
    LIFECYCLE_STATUSES,
    PHASES,
    buildOperatorStatusText,
    buildStageProgressLabel,
    defaultPhaseForLifecycle,
    deriveActionRequiredFromLegacy,
    deriveStatusCode,
    getProcessContract,
    isClosedLifecycleStatus,
    isCompletedLifecycleStatus,
    isFailedLifecycleStatus,
    legacyStatusFromLifecycleStatus,
    lifecycleStatusFromLegacyStatus,
    normalizeActionRequired,
    normalizeCodeToken,
    normalizeLifecycleStatus,
    normalizePhase
  };
});
