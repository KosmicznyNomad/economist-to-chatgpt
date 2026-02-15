from __future__ import annotations

from typing import Any, Dict, Optional

from .definitions import Mode, State


def compute_chandelier_k(
    state: State,
    close: float,
    base_total: Optional[float],
    bull_total: Optional[float],
    warn_count: int,
    settings: Dict[str, Any],
) -> float:
    if state == State.SPIKE_LOCK:
        base_k = 2.0
    elif state == State.NORMAL_RUN:
        if bull_total is not None and close >= bull_total:
            base_k = 2.5
        elif base_total is not None and close >= base_total:
            base_k = 3.0
        else:
            base_k = 3.5
    else:
        base_k = 3.0

    if int(warn_count) >= 1:
        base_k -= 0.5
    return max(base_k, 1.5)


def _resolve_regime_multiplier(vix_close: float | None, settings: Dict[str, Any]) -> float:
    if vix_close is None:
        return 1.0

    high_threshold = float(settings.get("vix_high_threshold", 30.0))
    mid_threshold = float(settings.get("vix_mid_threshold", 25.0))
    high_mult = float(settings.get("vix_high_regime_mult", 1.30))
    mid_mult = float(settings.get("vix_mid_regime_mult", 1.15))

    if vix_close > high_threshold:
        return high_mult
    if vix_close > mid_threshold:
        return mid_mult
    return 1.0


def compute_levels(
    position: Dict[str, Any],
    indicators: Dict[str, Any],
    settings: Dict[str, Any],
    market_context: Dict[str, Any] | None = None,
) -> Dict[str, Any]:
    mode = Mode(position["mode"])
    state = State(position["state"])
    runtime = position["runtime"]
    execution = position["execution"]
    targets = position["targets"]

    close = indicators.get("price_close")
    prev_close = indicators.get("prev_close")
    atr_d = indicators.get("atr_d")
    atr_w = indicators.get("atr_w")
    vix_raw = (market_context or {}).get("vix_close")
    try:
        vix_close = float(vix_raw) if vix_raw is not None else None
    except (TypeError, ValueError):
        vix_close = None
    regime_mult = _resolve_regime_multiplier(vix_close, settings)
    spike_threshold = (
        float(settings["spike_mult"]) * atr_w * regime_mult
        if atr_w is not None
        else None
    )
    five_d_move = indicators.get("five_d_move")
    is_spike = bool(
        spike_threshold is not None
        and five_d_move is not None
        and five_d_move > 0
        and five_d_move > spike_threshold
    )

    hwm_close = runtime.get("hwm_close")
    entry = execution.get("entry_price")
    warn_count = int(runtime.get("warn_count", 0))

    chandelier_k = None
    chandelier_stop = None
    giveback_lock = None
    catastrophe_floor = None
    effective_stop = None
    if mode == Mode.OWNED and close is not None and hwm_close is not None and atr_w is not None:
        chandelier_k = compute_chandelier_k(
            state=state,
            close=float(close),
            base_total=targets.get("base_total"),
            bull_total=targets.get("bull_total"),
            warn_count=warn_count,
            settings=settings,
        )
        chandelier_stop = float(hwm_close) - chandelier_k * float(atr_w)

        if entry is not None and float(hwm_close) > float(entry):
            max_giveback = 0.20 if state == State.SPIKE_LOCK else 0.35
            giveback_lock = float(entry) + (1.0 - max_giveback) * (float(hwm_close) - float(entry))

        effective_stop = chandelier_stop
        if giveback_lock is not None:
            effective_stop = max(effective_stop, giveback_lock)
        if entry is not None:
            catastrophe_candidates = [float(entry) * float(settings["catastrophe_floor_pct"])]
            bear_total = targets.get("bear_total")
            if bear_total is not None:
                catastrophe_candidates.append(float(bear_total) * float(settings.get("bear_total_floor_pct", 0.90)))
            catastrophe_floor = max(catastrophe_candidates)
            effective_stop = max(effective_stop, catastrophe_floor)

    hwm_at_exit = runtime.get("hwm_at_exit")
    pullback_min = None
    pullback_max = None
    in_band = False
    if atr_w is not None and hwm_at_exit is not None:
        pullback_min = float(hwm_at_exit) - float(settings["reentry_pullback_min_atrw"]) * float(atr_w)
        pullback_max = float(hwm_at_exit) - float(settings["reentry_pullback_max_atrw"]) * float(atr_w)
        if close is not None:
            in_band = bool(float(pullback_max) <= float(close) <= float(pullback_min))

    unrealized_pnl_pct = None
    return_from_hwm_pct = None
    priced_in_pct = None
    gap_to_base_pct = None
    gap_to_bull_pct = None

    if close is not None and entry is not None and float(entry) > 0:
        unrealized_pnl_pct = (float(close) - float(entry)) / float(entry) * 100.0
    if close is not None and hwm_close is not None and float(hwm_close) > 0:
        return_from_hwm_pct = (float(close) - float(hwm_close)) / float(hwm_close) * 100.0

    bear_total = targets.get("bear_total")
    base_total = targets.get("base_total")
    bull_total = targets.get("bull_total")

    if (
        close is not None
        and bear_total is not None
        and bull_total is not None
        and float(bull_total) != float(bear_total)
    ):
        priced_in_pct = (float(close) - float(bear_total)) / (float(bull_total) - float(bear_total)) * 100.0

    if close is not None and float(close) > 0 and base_total is not None:
        gap_to_base_pct = (float(base_total) - float(close)) / float(close) * 100.0
    if close is not None and float(close) > 0 and bull_total is not None:
        gap_to_bull_pct = (float(bull_total) - float(close)) / float(close) * 100.0

    day_change_pct = None
    if close is not None and prev_close is not None and float(prev_close) != 0:
        day_change_pct = (float(close) - float(prev_close)) / float(prev_close) * 100.0

    entry_ref_price = float(close) if close is not None else None
    entry_cat_stop_mult = float(settings.get("entry_cat_stop_atr_mult", 3.0))
    entry_sizing_atr_mult = float(settings.get("entry_sizing_atr_mult", 2.0))
    entry_risk_pct = float(settings.get("entry_risk_per_trade_pct", 1.0))
    entry_time_stop_days = int(settings.get("entry_time_stop_days", 7))
    stop_loss_price = None
    stop_distance_for_size = None
    shares_hint = None

    if entry_ref_price is not None and atr_d is not None:
        stop_loss_price = entry_ref_price - entry_cat_stop_mult * float(atr_d)
        stop_distance_for_size = entry_sizing_atr_mult * float(atr_d)

    capital_raw = settings.get("entry_capital_base")
    try:
        capital_base = float(capital_raw) if capital_raw is not None else None
    except (TypeError, ValueError):
        capital_base = None

    if (
        capital_base is not None
        and capital_base > 0.0
        and stop_distance_for_size is not None
        and stop_distance_for_size > 0.0
    ):
        risk_budget = capital_base * entry_risk_pct / 100.0
        shares_hint = risk_budget / stop_distance_for_size

    return {
        "price_close": close,
        "prev_close": prev_close,
        "day_change_pct": day_change_pct,
        "hwm_close": hwm_close,
        "atr_d": atr_d,
        "atr_w": atr_w,
        "five_d_move": five_d_move,
        "vix_close": vix_close,
        "regime_mult": regime_mult,
        "spike_threshold": spike_threshold,
        "sma50": indicators.get("sma50"),
        "sma200": indicators.get("sma200"),
        "sma200_slope": indicators.get("sma200_slope"),
        "trend_up": indicators.get("trend_up"),
        "z20": indicators.get("z20"),
        "up_streak": indicators.get("up_streak"),
        "r3_pct": indicators.get("r3_pct"),
        "overheated": indicators.get("overheated"),
        "setup_oversold": indicators.get("setup_oversold"),
        "reversal": indicators.get("reversal"),
        "entry_ref_price": entry_ref_price,
        "stop_loss_price": stop_loss_price,
        "stop_distance_for_size": stop_distance_for_size,
        "time_stop_days": entry_time_stop_days,
        "shares_hint": shares_hint,
        "chandelier_k": chandelier_k,
        "chandelier_stop": chandelier_stop,
        "giveback_lock": giveback_lock,
        "catastrophe_floor": catastrophe_floor,
        "effective_stop": effective_stop,
        "pullback_min": pullback_min,
        "pullback_max": pullback_max,
        "in_band": in_band,
        "is_spike": is_spike,
        "unrealized_pnl_pct": unrealized_pnl_pct,
        "return_from_hwm_pct": return_from_hwm_pct,
        "priced_in_pct": priced_in_pct,
        "gap_to_base_pct": gap_to_base_pct,
        "gap_to_bull_pct": gap_to_bull_pct,
    }
