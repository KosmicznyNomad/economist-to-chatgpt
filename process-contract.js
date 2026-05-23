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
  const PERFORMANCE_PHASE_STALL_THRESHOLDS_MS = Object.freeze({
    queue_wait: 5 * 60 * 1000,
    slot_reserved: 60 * 1000,
    chat_open: 90 * 1000,
    editor_ready: 90 * 1000,
    payload_send: 2 * 60 * 1000,
    prompt_send: 2 * 60 * 1000,
    response_wait: 15 * 60 * 1000,
    capture_validate: 60 * 1000,
    save_local: 30 * 1000,
    dispatch_remote: 60 * 1000,
    verify_remote: 2 * 60 * 1000
  });
  const PERFORMANCE_STALE_ACTIVITY_FLOOR_MS = 2 * 60 * 1000;
  const PERFORMANCE_PROMPT_GAP_WARN_MS = 60 * 1000;
  const PERFORMANCE_PROMPT_GAP_ERROR_MS = 4 * 60 * 1000;
  const PERFORMANCE_FINALIZATION_WARN_MS = 20 * 1000;
  const PERFORMANCE_FINALIZATION_ERROR_MS = 60 * 1000;
  const PERFORMANCE_WINDOW_CLOSE_WARN_MS = 15 * 1000;
  const PERFORMANCE_WINDOW_CLOSE_ERROR_MS = 45 * 1000;

  const LIFECYCLE_SET = new Set(LIFECYCLE_STATUSES);
  const PHASE_SET = new Set(PHASES);
  const ACTION_REQUIRED_SET = new Set(ACTION_REQUIRED_VALUES);
  const CLOSED_SET = new Set(['completed', 'failed', 'stopped']);

  function normalizeText(value, fallback = '') {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized || fallback;
  }

  function normalizePositiveInteger(value, fallback = null) {
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  function normalizeNonNegativeInteger(value, fallback = 0) {
    return Number.isInteger(value) && value >= 0 ? value : fallback;
  }

  function clampDurationMs(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.round(value));
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
      || normalized === 'force_stopped'
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

  function isForceStoppedRecord(source = {}) {
    const value = source && typeof source === 'object' ? source : {};
    const markers = [
      normalizeCodeToken(value.status || ''),
      normalizeCodeToken(value.lifecycleStatus || ''),
      normalizeCodeToken(value.statusCode || ''),
      normalizeCodeToken(value.reason || ''),
      normalizeCodeToken(value.error || ''),
      normalizeCodeToken(value.statusText || '')
    ].filter(Boolean);
    return markers.some((marker) => (
      marker === 'force_stop'
      || marker === 'force_stopped'
      || marker === 'process.stopped'
      || marker === 'bulk_resume_prepare'
      || marker === 'bulk_reset_before_detect_resume'
      || marker === 'manual_stop'
    ));
  }

  function deriveStatusCode(input = {}) {
    const normalized = input && typeof input === 'object' ? input : {};
    const explicit = normalizeCodeToken(normalized.statusCode || '');
    if (explicit) return explicit;

    const lifecycleStatus = isForceStoppedRecord(normalized)
      ? 'stopped'
      : normalizeLifecycleStatus(
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
    if (
      reason === 'force_stop'
      || reason === 'force_stopped'
      || error === 'force_stopped'
      || isForceStoppedRecord(normalized)
      || lifecycleStatus === 'stopped'
    ) {
      return 'process.stopped';
    }
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
    const lifecycleStatus = isForceStoppedRecord(process)
      ? 'stopped'
      : normalizeLifecycleStatus(
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

  function normalizePerformancePhaseTotals(rawTotals) {
    const totals = rawTotals && typeof rawTotals === 'object' ? rawTotals : {};
    const normalized = {};
    for (const phase of PHASES) {
      const value = clampDurationMs(totals?.[phase]);
      if (value > 0) normalized[phase] = value;
    }
    return normalized;
  }

  function normalizePromptTimingTelemetry(rawPromptTimings) {
    const promptTimings = rawPromptTimings && typeof rawPromptTimings === 'object'
      ? rawPromptTimings
      : {};
    const count = normalizeNonNegativeInteger(promptTimings.count, 0);
    const gapCount = normalizeNonNegativeInteger(promptTimings.gapCount, 0);
    const totalGapMs = clampDurationMs(promptTimings.totalGapMs);
    const maxGapMs = clampDurationMs(promptTimings.maxGapMs);
    const lastGapMs = clampDurationMs(promptTimings.lastGapMs);
    const firstAt = normalizePositiveInteger(promptTimings.firstAt);
    const lastAt = normalizePositiveInteger(promptTimings.lastAt);
    const lastPromptNumber = normalizePositiveInteger(promptTimings.lastPromptNumber);
    const normalized = {
      count,
      gapCount,
      totalGapMs,
      maxGapMs: Math.max(maxGapMs, lastGapMs),
      lastGapMs
    };
    if (firstAt !== null) normalized.firstAt = firstAt;
    if (lastAt !== null) normalized.lastAt = lastAt;
    if (lastPromptNumber !== null) normalized.lastPromptNumber = lastPromptNumber;
    return normalized;
  }

  function normalizeProcessPerformanceTelemetry(rawTelemetry) {
    if (!rawTelemetry || typeof rawTelemetry !== 'object' || Array.isArray(rawTelemetry)) {
      return null;
    }
    const phaseTotalsMs = normalizePerformancePhaseTotals(rawTelemetry.phaseTotalsMs);
    const promptTimings = normalizePromptTimingTelemetry(rawTelemetry.promptTimings);
    const phaseTransitionCount = normalizeNonNegativeInteger(rawTelemetry.phaseTransitionCount, 0);
    const lastPhaseChangeAt = normalizePositiveInteger(rawTelemetry.lastPhaseChangeAt);
    const normalized = {
      phaseTotalsMs,
      promptTimings,
      phaseTransitionCount
    };
    if (lastPhaseChangeAt !== null) normalized.lastPhaseChangeAt = lastPhaseChangeAt;
    return normalized;
  }

  function clonePerformanceTelemetry(rawTelemetry) {
    const normalized = normalizeProcessPerformanceTelemetry(rawTelemetry);
    if (!normalized) {
      return {
        phaseTotalsMs: {},
        promptTimings: {
          count: 0,
          gapCount: 0,
          totalGapMs: 0,
          maxGapMs: 0,
          lastGapMs: 0
        },
        phaseTransitionCount: 0
      };
    }
    return {
      phaseTotalsMs: { ...normalized.phaseTotalsMs },
      promptTimings: { ...normalized.promptTimings },
      phaseTransitionCount: normalized.phaseTransitionCount,
      ...(Number.isInteger(normalized.lastPhaseChangeAt) ? { lastPhaseChangeAt: normalized.lastPhaseChangeAt } : {})
    };
  }

  function mergeProcessPerformanceTelemetry(existingProcess = {}, patch = {}, options = {}) {
    const existing = existingProcess && typeof existingProcess === 'object' ? existingProcess : {};
    const nextPatch = patch && typeof patch === 'object' ? patch : {};
    const nowTs = normalizePositiveInteger(options?.nowTs, Date.now());
    const existingLifecycleStatus = normalizeLifecycleStatus(
      existing.lifecycleStatus || existing.status,
      'starting'
    );
    const nextLifecycleStatus = normalizeLifecycleStatus(
      options?.nextLifecycleStatus || nextPatch.lifecycleStatus || nextPatch.status || existingLifecycleStatus,
      existingLifecycleStatus
    );
    const previousPhase = normalizePhase(
      options?.previousPhase || existing.phase || '',
      defaultPhaseForLifecycle(existingLifecycleStatus)
    );
    const nextPhase = normalizePhase(
      options?.nextPhase || nextPatch.phase || '',
      previousPhase || defaultPhaseForLifecycle(nextLifecycleStatus)
    );
    const telemetry = clonePerformanceTelemetry(nextPatch.performanceTelemetry || existing.performanceTelemetry);
    const previousClosed = isClosedLifecycleStatus(existingLifecycleStatus);
    const nextClosed = isClosedLifecycleStatus(nextLifecycleStatus);
    const previousPhaseStartedAt = normalizePositiveInteger(
      existing.phaseStartedAt,
      normalizePositiveInteger(existing.lastActivityAt, nowTs)
    );

    if (!previousClosed && previousPhase && (previousPhase !== nextPhase || nextClosed)) {
      const phaseElapsedMs = clampDurationMs(nowTs - previousPhaseStartedAt);
      if (phaseElapsedMs > 0) {
        telemetry.phaseTotalsMs[previousPhase] = clampDurationMs(
          normalizeNonNegativeInteger(telemetry.phaseTotalsMs?.[previousPhase], 0) + phaseElapsedMs
        );
      }
      if (previousPhase !== nextPhase) {
        telemetry.phaseTransitionCount = normalizeNonNegativeInteger(telemetry.phaseTransitionCount, 0) + 1;
        telemetry.lastPhaseChangeAt = nowTs;
      }
    }

    const promptTimings = normalizePromptTimingTelemetry(telemetry.promptTimings);
    const nextPromptNumber = normalizePositiveInteger(
      nextPatch.currentPrompt,
      normalizePositiveInteger(existing.currentPrompt)
    );
    const promptStartDetected = (
      nextPhase === 'prompt_send'
      && nextPromptNumber !== null
      && (
        previousPhase !== 'prompt_send'
        || nextPromptNumber !== normalizePositiveInteger(existing.currentPrompt)
      )
    );

    if (promptStartDetected) {
      const previousPromptNumber = normalizePositiveInteger(promptTimings.lastPromptNumber);
      const previousPromptAt = normalizePositiveInteger(promptTimings.lastAt);
      if (previousPromptAt !== null && previousPromptNumber !== null && previousPromptNumber !== nextPromptNumber) {
        const gapMs = clampDurationMs(nowTs - previousPromptAt);
        if (gapMs > 0) {
          promptTimings.gapCount = normalizeNonNegativeInteger(promptTimings.gapCount, 0) + 1;
          promptTimings.totalGapMs = clampDurationMs(
            normalizeNonNegativeInteger(promptTimings.totalGapMs, 0) + gapMs
          );
          promptTimings.maxGapMs = Math.max(normalizeNonNegativeInteger(promptTimings.maxGapMs, 0), gapMs);
          promptTimings.lastGapMs = gapMs;
        }
      }
      if (normalizePositiveInteger(promptTimings.firstAt) === null) {
        promptTimings.firstAt = nowTs;
      }
      if (previousPromptNumber !== nextPromptNumber) {
        promptTimings.count = normalizeNonNegativeInteger(promptTimings.count, 0) + 1;
      }
      promptTimings.lastAt = nowTs;
      promptTimings.lastPromptNumber = nextPromptNumber;
    }

    telemetry.promptTimings = promptTimings;
    return telemetry;
  }

  function buildLivePhaseTotals(process = {}, telemetry = null, options = {}) {
    const nowTs = normalizePositiveInteger(options?.nowTs, Date.now());
    const totals = {
      ...(telemetry?.phaseTotalsMs && typeof telemetry.phaseTotalsMs === 'object'
        ? telemetry.phaseTotalsMs
        : {})
    };
    const lifecycleStatus = isForceStoppedRecord(process)
      ? 'stopped'
      : normalizeLifecycleStatus(
        process.lifecycleStatus || process.status,
        'running'
      );
    const phase = normalizePhase(process.phase || '', defaultPhaseForLifecycle(lifecycleStatus));
    if (isClosedLifecycleStatus(lifecycleStatus) || !phase) return totals;
    const phaseStartedAt = normalizePositiveInteger(process.phaseStartedAt);
    if (phaseStartedAt === null) return totals;
    const livePhaseMs = clampDurationMs(nowTs - phaseStartedAt);
    if (livePhaseMs <= 0) return totals;
    totals[phase] = clampDurationMs(normalizeNonNegativeInteger(totals?.[phase], 0) + livePhaseMs);
    return totals;
  }

  function buildProcessPerformanceProblems(process = {}, snapshot = {}, options = {}) {
    const nowTs = normalizePositiveInteger(options?.nowTs, Date.now());
    const lifecycleStatus = normalizeLifecycleStatus(
      process.lifecycleStatus || process.status,
      'running'
    );
    const phase = normalizePhase(process.phase || '', defaultPhaseForLifecycle(lifecycleStatus));
    const actionRequired = normalizeActionRequired(
      process.actionRequired || '',
      deriveActionRequiredFromLegacy(process)
    );
    const problems = [];
    const addProblem = (severity, code, label, valueMs = null) => {
      problems.push({ severity, code, label, ...(Number.isInteger(valueMs) ? { valueMs } : {}) });
    };

    const phaseThresholdMs = normalizePositiveInteger(PERFORMANCE_PHASE_STALL_THRESHOLDS_MS?.[phase]);
    if (
      !isClosedLifecycleStatus(lifecycleStatus)
      && phase
      && phaseThresholdMs !== null
      && Number.isInteger(snapshot.phaseElapsedMs)
      && snapshot.phaseElapsedMs >= phaseThresholdMs
    ) {
      addProblem(
        snapshot.phaseElapsedMs >= (phaseThresholdMs * 2) ? 'error' : 'warn',
        'phase_slow',
        `Faza ${phase} trwa zbyt dlugo`,
        snapshot.phaseElapsedMs
      );
    }

    const staleThresholdMs = Math.max(
      PERFORMANCE_STALE_ACTIVITY_FLOOR_MS,
      Math.round((phaseThresholdMs || PERFORMANCE_STALE_ACTIVITY_FLOOR_MS) / 2)
    );
    if (
      !isClosedLifecycleStatus(lifecycleStatus)
      && actionRequired === 'none'
      && Number.isInteger(snapshot.lastActivityAgeMs)
      && snapshot.lastActivityAgeMs >= staleThresholdMs
    ) {
      addProblem(
        snapshot.lastActivityAgeMs >= (staleThresholdMs * 2) ? 'error' : 'warn',
        'stale_activity',
        'Brak aktywnosci procesu',
        snapshot.lastActivityAgeMs
      );
    }

    if (Number.isInteger(snapshot.promptGapMaxMs) && snapshot.promptGapMaxMs >= PERFORMANCE_PROMPT_GAP_WARN_MS) {
      addProblem(
        snapshot.promptGapMaxMs >= PERFORMANCE_PROMPT_GAP_ERROR_MS ? 'error' : 'warn',
        'prompt_gap',
        'Duzy odstep miedzy promptami',
        snapshot.promptGapMaxMs
      );
    }

    if (
      Number.isInteger(snapshot.captureToPersistenceMs)
      && snapshot.captureToPersistenceMs >= PERFORMANCE_FINALIZATION_WARN_MS
    ) {
      addProblem(
        snapshot.captureToPersistenceMs >= PERFORMANCE_FINALIZATION_ERROR_MS ? 'error' : 'warn',
        'finalization_slow',
        'Finalizacja i wysylka danych sa opoznione',
        snapshot.captureToPersistenceMs
      );
    }

    if (
      Number.isInteger(snapshot.windowCloseMs)
      && snapshot.windowClosePending === true
      && snapshot.windowCloseMs >= PERFORMANCE_WINDOW_CLOSE_WARN_MS
    ) {
      addProblem(
        snapshot.windowCloseMs >= PERFORMANCE_WINDOW_CLOSE_ERROR_MS ? 'error' : 'warn',
        'window_close_slow',
        'Domkniecie okna procesu jest opoznione',
        snapshot.windowCloseMs
      );
    }

    const injectMetrics = process?.injectMetrics && typeof process.injectMetrics === 'object'
      ? process.injectMetrics
      : null;
    const sendFailures = normalizeNonNegativeInteger(injectMetrics?.sendFailures, 0)
      + normalizeNonNegativeInteger(injectMetrics?.sendHardFail, 0);
    const responseTimeouts = normalizeNonNegativeInteger(injectMetrics?.responseTimeouts, 0);
    const invalidResponses = normalizeNonNegativeInteger(injectMetrics?.responseInvalid, 0);

    if (sendFailures > 0) {
      addProblem('warn', 'send_failures', `Wystapily problemy z wysylaniem (${sendFailures})`);
    }
    if (responseTimeouts > 0) {
      addProblem('warn', 'response_timeouts', `Wystapily timeouty odpowiedzi (${responseTimeouts})`);
    }
    if (invalidResponses > 0) {
      addProblem('warn', 'invalid_responses', `Wystapily niepoprawne odpowiedzi (${invalidResponses})`);
    }
    if (actionRequired === 'rate_limit') {
      addProblem('error', 'rate_limit', 'ChatGPT zwrocil limit lub restriction');
    }

    return problems;
  }

  function buildProcessPerformanceSnapshot(process = {}, options = {}) {
    const nowTs = normalizePositiveInteger(options?.nowTs, Date.now());
    const lifecycleStatus = normalizeLifecycleStatus(
      process.lifecycleStatus || process.status,
      'running'
    );
    const phase = normalizePhase(process.phase || '', defaultPhaseForLifecycle(lifecycleStatus));
    const telemetry = clonePerformanceTelemetry(process.performanceTelemetry);
    const phaseTotalsMs = buildLivePhaseTotals(process, telemetry, { nowTs });
    const startedAt = normalizePositiveInteger(process.startedAt);
    const finishedAt = normalizePositiveInteger(process.finishedAt);
    const phaseStartedAt = normalizePositiveInteger(process.phaseStartedAt);
    const lastActivityAt = normalizePositiveInteger(
      process.lastActivityAt,
      normalizePositiveInteger(process.timestamp)
    );
    const runtimeEndAt = finishedAt !== null && isClosedLifecycleStatus(lifecycleStatus)
      ? finishedAt
      : nowTs;
    const runtimeMs = startedAt !== null ? clampDurationMs(runtimeEndAt - startedAt) : null;
    const phaseElapsedMs = (
      !isClosedLifecycleStatus(lifecycleStatus)
      && phaseStartedAt !== null
      && phase
    )
      ? clampDurationMs(nowTs - phaseStartedAt)
      : null;
    const lastActivityAgeMs = lastActivityAt !== null ? clampDurationMs(nowTs - lastActivityAt) : null;
    const promptTimings = normalizePromptTimingTelemetry(telemetry.promptTimings);
    const promptGapAvgMs = promptTimings.gapCount > 0
      ? Math.round(promptTimings.totalGapMs / promptTimings.gapCount)
      : null;
    const timeSinceLastPromptMs = normalizePositiveInteger(promptTimings.lastAt) !== null
      ? clampDurationMs(nowTs - promptTimings.lastAt)
      : null;

    const completedResponseCapturedAt = normalizePositiveInteger(process.completedResponseCapturedAt);
    const persistenceUpdatedAt = normalizePositiveInteger(process?.persistenceStatus?.updatedAt);
    const captureToPersistenceMs = completedResponseCapturedAt !== null
      ? clampDurationMs((persistenceUpdatedAt || runtimeEndAt) - completedResponseCapturedAt)
      : null;
    const windowCloseRequestedAt = normalizePositiveInteger(process?.windowClose?.requestedAt);
    const windowCloseClosedAt = normalizePositiveInteger(process?.windowClose?.closedAt);
    const windowClosePending = windowCloseRequestedAt !== null && windowCloseClosedAt === null;
    const windowCloseMs = windowCloseRequestedAt !== null
      ? clampDurationMs((windowCloseClosedAt || nowTs) - windowCloseRequestedAt)
      : null;

    const snapshot = {
      lifecycleStatus,
      phase,
      runtimeMs,
      phaseElapsedMs,
      lastActivityAgeMs,
      phaseTotalsMs,
      phaseTransitionCount: normalizeNonNegativeInteger(telemetry.phaseTransitionCount, 0),
      promptCount: normalizeNonNegativeInteger(promptTimings.count, 0),
      promptGapCount: normalizeNonNegativeInteger(promptTimings.gapCount, 0),
      promptGapAvgMs,
      promptGapMaxMs: normalizeNonNegativeInteger(promptTimings.maxGapMs, 0) || null,
      promptLastGapMs: normalizeNonNegativeInteger(promptTimings.lastGapMs, 0) || null,
      timeSinceLastPromptMs,
      captureToPersistenceMs,
      windowCloseMs,
      windowClosePending
    };
    const problems = buildProcessPerformanceProblems(process, snapshot, { nowTs });
    return {
      ...snapshot,
      problems,
      highestSeverity: problems.some((entry) => entry?.severity === 'error')
        ? 'error'
        : (problems.some((entry) => entry?.severity === 'warn') ? 'warn' : 'ok')
    };
  }

  function getProcessContract(process = {}) {
    const lifecycleStatus = isForceStoppedRecord(process)
      ? 'stopped'
      : normalizeLifecycleStatus(
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
    PERFORMANCE_PHASE_STALL_THRESHOLDS_MS,
    buildOperatorStatusText,
    buildProcessPerformanceSnapshot,
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
    mergeProcessPerformanceTelemetry,
    normalizeActionRequired,
    normalizeCodeToken,
    normalizeLifecycleStatus,
    normalizePhase,
    normalizeProcessPerformanceTelemetry
  };
});
