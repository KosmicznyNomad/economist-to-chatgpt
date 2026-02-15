from __future__ import annotations

from typing import Any, Dict, List

from .definitions import (
    Action,
    ActionPayload,
    DecisionOfDay,
    Mode,
    ReasonCode,
    ReasonPayload,
    State,
    Trigger,
)


def _trading_days_since(start_bar_date: str | None, bars: List[Dict[str, Any]]) -> int:
    if not start_bar_date:
        return 0
    return len([bar for bar in bars if str(bar["date"]) > start_bar_date])


def _can_execute_action(position: Dict[str, Any], bar_date: str) -> bool:
    return position["runtime"].get("last_action_bar_date") != bar_date


def _register_action(position: Dict[str, Any], bar_date: str) -> None:
    position["runtime"]["last_action_bar_date"] = bar_date


def _set_exit_state(
    position: Dict[str, Any],
    bar_date: str,
    settings: Dict[str, Any],
    permanent_exit: bool,
) -> None:
    runtime = position["runtime"]
    execution = position["execution"]
    mode = Mode(position["mode"])
    if mode == Mode.OWNED:
        runtime["hwm_at_exit"] = runtime.get("hwm_close")
    position["mode"] = Mode.WATCH.value
    position["state"] = State.EXITED_COOLDOWN.value
    execution["entry_price"] = None
    execution["entry_bar_date"] = None
    execution["current_weight_pct"] = 0.0
    runtime["cooldown_start_bar_date"] = bar_date
    runtime["cooldown_bars_left"] = int(settings["cooldown_sessions"])
    runtime["reentry_window_start_bar_date"] = None
    runtime["reentry_bars_left"] = 0
    runtime["spike_lock_start_bar_date"] = None
    runtime["last_spike_bar_date"] = None
    runtime["base_sold"] = False
    runtime["bull_sold"] = False
    runtime["consecutive_closes_below_sma200"] = 0
    runtime["permanent_exit"] = bool(permanent_exit)


def _update_runtime_counters(
    position: Dict[str, Any],
    close: float,
    sma200: float | None,
    bar_date: str,
    trend_break_buffer_pct: float = 0.0,
) -> None:
    runtime = position["runtime"]
    state = State(position["state"])
    mode = Mode(position["mode"])

    if runtime.get("last_processed_bar_date") != bar_date:
        if state == State.EXITED_COOLDOWN and int(runtime.get("cooldown_bars_left", 0)) > 0:
            runtime["cooldown_bars_left"] = max(0, int(runtime["cooldown_bars_left"]) - 1)
        if state == State.REENTRY_WINDOW and int(runtime.get("reentry_bars_left", 0)) > 0:
            runtime["reentry_bars_left"] = max(0, int(runtime["reentry_bars_left"]) - 1)

    if mode == Mode.OWNED:
        threshold = float(sma200) * (1.0 - max(0.0, float(trend_break_buffer_pct))) if sma200 is not None else None
        if threshold is not None and close < threshold:
            runtime["consecutive_closes_below_sma200"] = int(runtime.get("consecutive_closes_below_sma200", 0)) + 1
        else:
            runtime["consecutive_closes_below_sma200"] = 0


def _reversal_signal(indicators: Dict[str, Any]) -> bool:
    close = indicators.get("price_close")
    prev_high = indicators.get("prev_high")
    prev_close = indicators.get("prev_close")
    sma50 = indicators.get("sma50")
    prev_sma50 = indicators.get("prev_sma50")

    signal_prev_high = prev_high is not None and close is not None and float(close) > float(prev_high)
    signal_sma_reclaim = (
        close is not None
        and prev_close is not None
        and sma50 is not None
        and prev_sma50 is not None
        and float(prev_close) < float(prev_sma50)
        and float(close) > float(sma50)
    )
    return bool(signal_prev_high or signal_sma_reclaim)


def _build_decision(
    key: str,
    position: Dict[str, Any],
    bar_date: str,
    state_before: State,
    action: ActionPayload,
    reason_code: ReasonCode,
    reason_text: str,
    levels: Dict[str, Any],
    trigger_name: str | None = None,
) -> DecisionOfDay:
    symbol = position["identity"]
    state_after = State(position["state"])
    mode_after = Mode(position["mode"])
    return DecisionOfDay(
        bar_date=bar_date,
        key=key,
        symbol={
            "ticker": symbol.get("ticker"),
            "exchange": symbol.get("exchange"),
            "currency": symbol.get("currency"),
        },
        mode=mode_after,
        state_before=state_before,
        state_after=state_after,
        action=action,
        reason=ReasonPayload(code=reason_code, text=reason_text),
        levels=levels,
        targets=position.get("targets", {}),
        kpi=position.get("thesis_kpis", {}),
        transitions={
            "triggered": bool(action.type not in {Action.HOLD, Action.WAIT} or state_before != state_after),
            "trigger": trigger_name,
        },
    )


def _resolve_spike_sell_pct(
    position: Dict[str, Any],
    close: float,
    settings: Dict[str, Any],
) -> float:
    fallback = float(settings.get("spike_sell_pct_first", 0.25))
    low = float(settings.get("spike_sell_pct_low", 0.20))
    mid = float(settings.get("spike_sell_pct_mid", fallback))
    high = float(settings.get("spike_sell_pct_high", 0.30))
    mid_pnl = float(settings.get("spike_sell_pnl_mid_pct", 20.0))
    high_pnl = float(settings.get("spike_sell_pnl_high_pct", 40.0))

    entry_raw = position.get("execution", {}).get("entry_price")
    try:
        entry = float(entry_raw)
    except (TypeError, ValueError):
        entry = 0.0

    selected = fallback
    if entry > 0.0:
        unrealized_pnl_pct = (float(close) - entry) / entry * 100.0
        if unrealized_pnl_pct > high_pnl:
            selected = high
        elif unrealized_pnl_pct > mid_pnl:
            selected = mid
        else:
            selected = low

    return max(0.0, min(1.0, float(selected)))


def _evaluate_watch_entry_mvp(
    position: Dict[str, Any],
    bar_date: str,
    indicators: Dict[str, Any],
    settings: Dict[str, Any],
    can_execute: bool,
) -> tuple[ActionPayload, ReasonCode, str]:
    close = indicators.get("price_close")
    atr_d = indicators.get("atr_d")
    sma200 = indicators.get("sma200")
    z20 = indicators.get("z20")
    prev_high = indicators.get("prev_high")

    data_ready = bool(
        close is not None
        and atr_d is not None
        and sma200 is not None
        and z20 is not None
        and prev_high is not None
    )
    if not data_ready:
        return ActionPayload(type=Action.WAIT), ReasonCode.ENTRY_WAIT_DATA, "Waiting for minimal indicator set."

    if float(close) <= float(settings.get("entry_min_price", 5.0)):
        return ActionPayload(type=Action.WAIT), ReasonCode.ENTRY_WATCH, "Price below entry minimum threshold."

    if not bool(indicators.get("trend_up")):
        return ActionPayload(type=Action.WAIT), ReasonCode.ENTRY_NO_BUY_TREND, "Trend gate is closed."

    if bool(indicators.get("overheated")):
        return ActionPayload(type=Action.WAIT), ReasonCode.ENTRY_NO_BUY_OVERHEAT, "Overheat gate is active."

    if not bool(indicators.get("setup_oversold")):
        return ActionPayload(type=Action.WAIT), ReasonCode.ENTRY_WATCH, "Trend is open, but no pullback setup."

    if not bool(indicators.get("reversal")):
        return ActionPayload(type=Action.WAIT), ReasonCode.ENTRY_SETUP, "Setup active; waiting for reversal trigger."

    if not can_execute:
        return (
            ActionPayload(type=Action.WAIT),
            ReasonCode.DUPLICATE_ACTION_BLOCKED,
            "Action already executed for this bar.",
        )

    _register_action(position, bar_date)
    return (
        ActionPayload(type=Action.BUY_ALERT, price_hint=float(close)),
        ReasonCode.BUY_TRIGGER,
        "BUY trigger confirmed: pullback setup with reversal.",
    )


def apply_state_machine(
    key: str,
    position: Dict[str, Any],
    bar: Dict[str, Any],
    bars_up_to_date: List[Dict[str, Any]],
    indicators: Dict[str, Any],
    levels: Dict[str, Any],
    settings: Dict[str, Any],
) -> DecisionOfDay:
    bar_date = str(bar["date"])
    runtime = position["runtime"]
    fundamentals = position["fundamental_triggers"]
    execution = position["execution"]

    state_before = State(position["state"])
    mode_before = Mode(position["mode"])
    close = float(indicators["price_close"])
    sma200 = indicators.get("sma200")
    trend_up = bool(indicators.get("trend_up"))

    _update_runtime_counters(
        position=position,
        close=close,
        sma200=sma200,
        bar_date=bar_date,
        trend_break_buffer_pct=float(settings.get("trend_break_buffer_pct", 0.0)),
    )

    if mode_before == Mode.OWNED and state_before in {State.NORMAL_RUN, State.SPIKE_LOCK}:
        hwm_close = runtime.get("hwm_close")
        if hwm_close is None or close > float(hwm_close):
            runtime["hwm_close"] = close
            runtime["hwm_bar_date"] = bar_date

    pending_trigger = str(fundamentals.get("pending_trigger") or "none").lower().strip()
    trigger: Trigger
    try:
        trigger = Trigger(pending_trigger)
    except ValueError:
        trigger = Trigger.NONE
    if trigger != Trigger.NONE:
        fundamentals["last_trigger_bar_date"] = bar_date
        fundamentals["pending_trigger"] = None

    default_action = Action.HOLD if mode_before == Mode.OWNED else Action.WAIT
    reason_code = ReasonCode.NO_TRIGGER
    reason_text = "No rule matched."
    action_payload = ActionPayload(type=default_action)

    can_execute = _can_execute_action(position, bar_date)

    # Priority 1: fundamental falsifier override.
    if trigger == Trigger.FALSIFIER:
        if can_execute:
            _set_exit_state(position, bar_date, settings, permanent_exit=True)
            _register_action(position, bar_date)
            action_payload = ActionPayload(type=Action.SELL_ALL, sell_pct=1.0, price_hint=close)
            reason_code = ReasonCode.FALSIFIER
            reason_text = "Falsifier triggered: immediate full exit and permanent watch mode."
        else:
            action_payload = ActionPayload(type=Action.WAIT)
            reason_code = ReasonCode.DUPLICATE_ACTION_BLOCKED
            reason_text = "Action already executed for this bar."

    # Priority 2/3: stop and trend-break exits for owned position.
    elif mode_before == Mode.OWNED and execution.get("entry_price") is not None:
        stop_hit = levels.get("effective_stop") is not None and close < float(levels["effective_stop"])
        trend_break = int(runtime.get("consecutive_closes_below_sma200", 0)) >= 2
        if stop_hit:
            if can_execute:
                _set_exit_state(position, bar_date, settings, permanent_exit=False)
                _register_action(position, bar_date)
                action_payload = ActionPayload(type=Action.SELL_ALL, sell_pct=1.0, price_hint=close)
                reason_code = ReasonCode.STOP_HIT
                reason_text = "Close dropped below effective stop."
            else:
                action_payload = ActionPayload(type=Action.HOLD)
                reason_code = ReasonCode.DUPLICATE_ACTION_BLOCKED
                reason_text = "Action already executed for this bar."
        elif trend_break:
            if can_execute:
                _set_exit_state(position, bar_date, settings, permanent_exit=False)
                _register_action(position, bar_date)
                action_payload = ActionPayload(type=Action.SELL_ALL, sell_pct=1.0, price_hint=close)
                reason_code = ReasonCode.TREND_BREAK
                reason_text = "Two consecutive closes below SMA200."
            else:
                action_payload = ActionPayload(type=Action.HOLD)
                reason_code = ReasonCode.DUPLICATE_ACTION_BLOCKED
                reason_text = "Action already executed for this bar."
        else:
            # Priority 4: spike in NORMAL_RUN.
            if state_before == State.NORMAL_RUN and bool(levels.get("is_spike")):
                if can_execute:
                    position["state"] = State.SPIKE_LOCK.value
                    runtime["spike_lock_start_bar_date"] = bar_date
                    runtime["last_spike_bar_date"] = bar_date
                    _register_action(position, bar_date)
                    action_payload = ActionPayload(
                        type=Action.SELL_PARTIAL,
                        sell_pct=_resolve_spike_sell_pct(position=position, close=close, settings=settings),
                        price_hint=close,
                    )
                    reason_code = ReasonCode.SPIKE_DETECTED
                    reason_text = "Spike detected in NORMAL_RUN."
                else:
                    action_payload = ActionPayload(type=Action.HOLD)
                    reason_code = ReasonCode.DUPLICATE_ACTION_BLOCKED
                    reason_text = "Action already executed for this bar."
            # Priority 5: warn trigger.
            elif trigger == Trigger.WARN:
                warn_count = int(runtime.get("warn_count", 0))
                if warn_count == 0:
                    if can_execute:
                        runtime["warn_count"] = 1
                        _register_action(position, bar_date)
                        action_payload = ActionPayload(
                            type=Action.SELL_PARTIAL,
                            sell_pct=float(settings["warn_sell_pct"]),
                            price_hint=close,
                        )
                        reason_code = ReasonCode.WARN
                        reason_text = "Warn #1: partial risk reduction."
                    else:
                        action_payload = ActionPayload(type=Action.HOLD)
                        reason_code = ReasonCode.DUPLICATE_ACTION_BLOCKED
                        reason_text = "Action already executed for this bar."
                else:
                    if can_execute:
                        runtime["warn_count"] = 2
                        _set_exit_state(position, bar_date, settings, permanent_exit=False)
                        runtime["warn_count"] = 2
                        _register_action(position, bar_date)
                        action_payload = ActionPayload(type=Action.SELL_ALL, sell_pct=1.0, price_hint=close)
                        reason_code = ReasonCode.WARN
                        reason_text = "Warn #2: full exit, cooldown, re-entry still allowed."
                    else:
                        action_payload = ActionPayload(type=Action.HOLD)
                        reason_code = ReasonCode.DUPLICATE_ACTION_BLOCKED
                        reason_text = "Action already executed for this bar."
            # Priority 6: profit schedule in NORMAL_RUN only.
            elif state_before == State.NORMAL_RUN:
                base_total = position["targets"].get("base_total")
                bull_total = position["targets"].get("bull_total")
                base_sold = bool(runtime.get("base_sold", False))
                bull_sold = bool(runtime.get("bull_sold", False))
                if base_total is not None and not base_sold and close >= float(base_total):
                    if can_execute:
                        runtime["base_sold"] = True
                        _register_action(position, bar_date)
                        action_payload = ActionPayload(
                            type=Action.SELL_PARTIAL,
                            sell_pct=float(settings["profit_at_base_pct"]),
                            price_hint=close,
                        )
                        reason_code = ReasonCode.BASE_HIT
                        reason_text = "Base target reached."
                    else:
                        action_payload = ActionPayload(type=Action.HOLD)
                        reason_code = ReasonCode.DUPLICATE_ACTION_BLOCKED
                        reason_text = "Action already executed for this bar."
                elif bull_total is not None and not bull_sold and close >= float(bull_total):
                    if can_execute:
                        runtime["bull_sold"] = True
                        _register_action(position, bar_date)
                        action_payload = ActionPayload(
                            type=Action.SELL_PARTIAL,
                            sell_pct=float(settings["profit_at_bull_pct"]),
                            price_hint=close,
                        )
                        reason_code = ReasonCode.BULL_HIT
                        reason_text = "Bull target reached."
                    else:
                        action_payload = ActionPayload(type=Action.HOLD)
                        reason_code = ReasonCode.DUPLICATE_ACTION_BLOCKED
                        reason_text = "Action already executed for this bar."

    # Priority 7: WATCH entry engine (MVP, alert-only).
    elif mode_before == Mode.WATCH and bool(settings.get("entry_mvp_enabled", True)):
        action_payload, reason_code, reason_text = _evaluate_watch_entry_mvp(
            position=position,
            bar_date=bar_date,
            indicators=indicators,
            settings=settings,
            can_execute=can_execute,
        )

    # Priority 8: state-specific transitions.
    state_now = State(position["state"])
    if reason_code == ReasonCode.NO_TRIGGER:
        if state_now == State.SPIKE_LOCK:
            spike_start = runtime.get("spike_lock_start_bar_date")
            sessions = _trading_days_since(spike_start, bars_up_to_date)
            five_d_move = levels.get("five_d_move")
            spike_threshold = levels.get("spike_threshold")
            spike_absorbed = bool(
                five_d_move is not None
                and spike_threshold is not None
                and float(five_d_move) > 0.0
                and float(five_d_move) < float(spike_threshold)
                and trend_up
            )
            if spike_absorbed:
                position["state"] = State.NORMAL_RUN.value
                runtime["spike_lock_start_bar_date"] = None
                runtime["last_spike_bar_date"] = None
                reason_code = ReasonCode.SPIKE_ABSORBED
                reason_text = "Spike conditions normalized and trend gate is open."
            elif sessions >= int(settings["spike_lock_sessions"]):
                position["state"] = State.NORMAL_RUN.value
                runtime["spike_lock_start_bar_date"] = None
                runtime["last_spike_bar_date"] = None
                reason_code = ReasonCode.SPIKE_LOCK_TIMEOUT
                reason_text = "Spike lock timeout reached; returning to NORMAL_RUN."

        elif state_now == State.EXITED_COOLDOWN:
            if bool(runtime.get("permanent_exit", False)):
                action_payload = ActionPayload(type=Action.WAIT)
                reason_code = ReasonCode.PERMANENT_EXIT
                reason_text = "Permanent exit active."
            elif int(runtime.get("cooldown_bars_left", 0)) > 0:
                action_payload = ActionPayload(type=Action.WAIT)
                reason_code = ReasonCode.COOLDOWN_ACTIVE
                reason_text = f"Cooldown active: {runtime.get('cooldown_bars_left', 0)} bars left."
            elif trend_up:
                position["state"] = State.REENTRY_WINDOW.value
                runtime["reentry_window_start_bar_date"] = bar_date
                runtime["reentry_bars_left"] = int(settings["reentry_window_sessions"])
                action_payload = ActionPayload(type=Action.WAIT)
                reason_code = ReasonCode.OPEN_REENTRY_WINDOW
                reason_text = "Trend recovered; opening re-entry window."
            else:
                action_payload = ActionPayload(type=Action.WAIT)
                reason_code = ReasonCode.COOLDOWN_ACTIVE
                reason_text = "Cooldown complete but trend gate is still closed."

        elif state_now == State.REENTRY_WINDOW:
            reversal_signal = _reversal_signal(indicators)
            in_band = bool(levels.get("in_band", False))
            pullback_max = levels.get("pullback_max")
            reentry_trigger = bool(in_band and reversal_signal and trend_up and not runtime.get("permanent_exit", False))

            if reentry_trigger:
                if can_execute:
                    target_weight = position["execution"].get("target_weight_pct")
                    buy_pct = float(settings["reentry_position_pct"])
                    position["mode"] = Mode.OWNED.value
                    position["state"] = State.NORMAL_RUN.value
                    position["execution"]["entry_price"] = close
                    position["execution"]["entry_bar_date"] = bar_date
                    if target_weight is not None:
                        position["execution"]["current_weight_pct"] = float(target_weight) * buy_pct
                    runtime["hwm_close"] = close
                    runtime["hwm_bar_date"] = bar_date
                    runtime["hwm_at_exit"] = None
                    runtime["cooldown_start_bar_date"] = None
                    runtime["cooldown_bars_left"] = 0
                    runtime["reentry_window_start_bar_date"] = None
                    runtime["reentry_bars_left"] = 0
                    runtime["consecutive_closes_below_sma200"] = 0
                    _register_action(position, bar_date)
                    action_payload = ActionPayload(
                        type=Action.BUY_REENTER,
                        buy_pct_of_target=buy_pct,
                        price_hint=close,
                    )
                    reason_code = ReasonCode.REENTRY_TRIGGERED
                    reason_text = "Re-entry trigger confirmed."
                else:
                    action_payload = ActionPayload(type=Action.WAIT)
                    reason_code = ReasonCode.DUPLICATE_ACTION_BLOCKED
                    reason_text = "Action already executed for this bar."
            elif (pullback_max is not None and close < float(pullback_max)) or not trend_up:
                position["state"] = State.EXITED_COOLDOWN.value
                runtime["reentry_window_start_bar_date"] = None
                runtime["reentry_bars_left"] = 0
                runtime["cooldown_start_bar_date"] = bar_date
                runtime["cooldown_bars_left"] = int(settings["cooldown_sessions"])
                action_payload = ActionPayload(type=Action.WAIT)
                reason_code = ReasonCode.COOLDOWN_ACTIVE
                reason_text = "Re-entry window invalidated; back to cooldown."
            elif int(runtime.get("reentry_bars_left", 0)) == 0:
                position["state"] = State.EXITED_COOLDOWN.value
                runtime["reentry_window_start_bar_date"] = None
                runtime["cooldown_start_bar_date"] = bar_date
                runtime["cooldown_bars_left"] = int(settings["cooldown_sessions"])
                action_payload = ActionPayload(type=Action.WAIT)
                reason_code = ReasonCode.REENTRY_EXPIRED
                reason_text = "Re-entry window expired."
            else:
                action_payload = ActionPayload(type=Action.WAIT)
                reason_code = ReasonCode.NO_TRIGGER
                reason_text = "Waiting for re-entry trigger."

    if trigger == Trigger.CONFIRM and reason_code == ReasonCode.NO_TRIGGER:
        reason_text = "Confirm trigger is informational only."

    runtime["last_processed_bar_date"] = bar_date
    position["computed"].update(levels)

    return _build_decision(
        key=key,
        position=position,
        bar_date=bar_date,
        state_before=state_before,
        action=action_payload,
        reason_code=reason_code,
        reason_text=reason_text,
        levels=position["computed"].copy(),
        trigger_name=trigger.value if trigger != Trigger.NONE else None,
    )
