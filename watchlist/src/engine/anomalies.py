from __future__ import annotations

import math
from typing import Any, Dict, List

from .definitions import AnomalyCode, AnomalyEvent, AnomalySeverity


def _mean(values: List[float]) -> float | None:
    if not values:
        return None
    return sum(values) / len(values)


def _to_float(value: Any) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _mean_abs(values: List[float]) -> float | None:
    if not values:
        return None
    return sum(abs(value) for value in values) / len(values)


def _stdev(values: List[float]) -> float | None:
    if len(values) < 2:
        return None
    avg = _mean(values)
    if avg is None:
        return None
    variance = sum((value - avg) ** 2 for value in values) / len(values)
    if variance < 0:
        return None
    return math.sqrt(variance)


def _compute_sma50_lookback(closes: List[float], lookback: int) -> float | None:
    window = 50
    if lookback <= 0:
        return None
    if len(closes) < window + lookback:
        return None
    values = closes[-(window + lookback) : -lookback]
    return _mean(values)


def _build_metrics(
    bars_up_to_date: List[Dict[str, Any]],
    indicators: Dict[str, Any],
    settings: Dict[str, Any],
) -> Dict[str, float | str | None]:
    closes = [float(item["close"]) for item in bars_up_to_date]
    close = _to_float(indicators.get("price_close"))
    atr_d = _to_float(indicators.get("atr_d"))
    sma50 = _to_float(indicators.get("sma50"))

    short_period = max(1, int(settings.get("anomaly_momentum_roc_short_period", 5)))
    long_period = max(short_period, int(settings.get("anomaly_momentum_roc_long_period", 20)))
    drawdown_lookback = max(2, int(settings.get("anomaly_drawdown_lookback", 20)))
    drawdown_min_lookback = max(3, int(settings.get("anomaly_drawdown_min_lookback", 5)))
    sma50_slope_lookback = max(1, int(settings.get("anomaly_trend_sma50_slope_lookback", 10)))
    multiday_avg_window = max(5, int(settings.get("anomaly_multiday_avg_window", 20)))
    std_window = max(5, int(settings.get("anomaly_std_window", 20)))
    std_min_window = max(3, int(settings.get("anomaly_std_min_window", 8)))
    sma_fallback_min_window = max(5, int(settings.get("anomaly_sma_fallback_min_window", 10)))

    if sma50 is None:
        effective_sma_window = min(50, len(closes))
        if effective_sma_window >= sma_fallback_min_window:
            sma50 = _mean(closes[-effective_sma_window:])

    atr_pct = None
    if close is not None and close > 0 and atr_d is not None:
        atr_pct = atr_d / close * 100.0

    roc_5 = None
    if len(closes) > short_period and closes[-(short_period + 1)] != 0:
        roc_5 = (closes[-1] - closes[-(short_period + 1)]) / closes[-(short_period + 1)] * 100.0

    roc_20 = None
    if len(closes) > long_period and closes[-(long_period + 1)] != 0:
        roc_20 = (closes[-1] - closes[-(long_period + 1)]) / closes[-(long_period + 1)] * 100.0

    roc_5_norm = None
    if roc_5 is not None and atr_pct is not None and atr_pct > 0:
        roc_5_norm = roc_5 / atr_pct

    roc_20_norm = None
    if roc_20 is not None and atr_pct is not None and atr_pct > 0:
        roc_20_norm = roc_20 / atr_pct

    one_day_return_pct = None
    if len(closes) >= 2 and float(closes[-2]) != 0:
        one_day_return_pct = (float(closes[-1]) - float(closes[-2])) / float(closes[-2]) * 100.0

    log_returns: List[float] = []
    for idx in range(1, len(closes)):
        prev_close = float(closes[idx - 1])
        current_close = float(closes[idx])
        if prev_close <= 0 or current_close <= 0:
            continue
        log_returns.append(math.log(current_close / prev_close))

    sigma_log_20 = None
    effective_std_window = min(std_window, len(log_returns))
    if effective_std_window >= std_min_window:
        sigma_log_20 = _stdev(log_returns[-effective_std_window:])

    one_day_log_return = log_returns[-1] if log_returns else None
    one_day_return_in_sigma = None
    if one_day_log_return is not None and sigma_log_20 is not None and sigma_log_20 > 0:
        one_day_return_in_sigma = one_day_log_return / sigma_log_20

    return_3d_pct = None
    if len(closes) >= 4 and float(closes[-4]) != 0:
        return_3d_pct = (float(closes[-1]) - float(closes[-4])) / float(closes[-4]) * 100.0

    return_5d_pct = None
    if len(closes) >= 6 and float(closes[-6]) != 0:
        return_5d_pct = (float(closes[-1]) - float(closes[-6])) / float(closes[-6]) * 100.0

    return_3d_in_sigma = None
    if sigma_log_20 is not None and sigma_log_20 > 0 and len(log_returns) >= 3:
        sum_3d_log = sum(log_returns[-3:])
        return_3d_in_sigma = sum_3d_log / (sigma_log_20 * math.sqrt(3.0))

    return_5d_in_sigma = None
    if sigma_log_20 is not None and sigma_log_20 > 0 and len(log_returns) >= 5:
        sum_5d_log = sum(log_returns[-5:])
        return_5d_in_sigma = sum_5d_log / (sigma_log_20 * math.sqrt(5.0))

    recent_trend_sigma_abs = None
    recent_trend_direction = None
    sigma_candidates = []
    if return_3d_in_sigma is not None:
        sigma_candidates.append(("3d", return_3d_in_sigma))
    if return_5d_in_sigma is not None:
        sigma_candidates.append(("5d", return_5d_in_sigma))
    if sigma_candidates:
        _, selected_sigma = max(sigma_candidates, key=lambda item: abs(item[1]))
        recent_trend_sigma_abs = abs(selected_sigma)
        if selected_sigma > 0:
            recent_trend_direction = "UP"
        elif selected_sigma < 0:
            recent_trend_direction = "DOWN"
        else:
            recent_trend_direction = "FLAT"

    daily_change_pct: List[float] = []
    for idx in range(1, len(closes)):
        prev_close = float(closes[idx - 1])
        if prev_close == 0:
            continue
        daily_change_pct.append((float(closes[idx]) - prev_close) / prev_close * 100.0)

    recent_changes_5d = daily_change_pct[-5:] if len(daily_change_pct) >= 5 else daily_change_pct[-len(daily_change_pct) :]
    up_days_5d = len([value for value in recent_changes_5d if value > 0.0]) if recent_changes_5d else 0
    down_days_5d = len([value for value in recent_changes_5d if value < 0.0]) if recent_changes_5d else 0

    avg_abs_daily_change = None
    if daily_change_pct:
        recent_changes = daily_change_pct[-multiday_avg_window:]
        avg_abs_daily_change = _mean_abs(recent_changes)

    drop_3d_pct = None
    if len(closes) >= 4 and float(closes[-4]) != 0:
        drop_3d_pct = (float(closes[-1]) - float(closes[-4])) / float(closes[-4]) * 100.0

    drop_5d_pct = None
    if len(closes) >= 6 and float(closes[-6]) != 0:
        drop_5d_pct = (float(closes[-1]) - float(closes[-6])) / float(closes[-6]) * 100.0

    drop_ratio_3d = None
    if avg_abs_daily_change is not None and avg_abs_daily_change > 0 and drop_3d_pct is not None and drop_3d_pct < 0:
        drop_ratio_3d = abs(drop_3d_pct) / (avg_abs_daily_change * 3.0)

    drop_ratio_5d = None
    if avg_abs_daily_change is not None and avg_abs_daily_change > 0 and drop_5d_pct is not None and drop_5d_pct < 0:
        drop_ratio_5d = abs(drop_5d_pct) / (avg_abs_daily_change * 5.0)

    multiday_drop_ratio = None
    ratios = [value for value in [drop_ratio_3d, drop_ratio_5d] if value is not None]
    if ratios:
        multiday_drop_ratio = max(ratios)

    rolling_high = None
    effective_drawdown_lookback = min(drawdown_lookback, len(closes))
    if effective_drawdown_lookback >= drawdown_min_lookback:
        rolling_high = max(closes[-effective_drawdown_lookback:])

    drawdown = None
    if close is not None and rolling_high is not None and rolling_high > 0:
        drawdown = (close - rolling_high) / rolling_high * 100.0

    drawdown_in_atr = None
    if drawdown is not None and atr_pct is not None and atr_pct > 0:
        drawdown_in_atr = abs(drawdown) / atr_pct

    sma50_10d_ago = _compute_sma50_lookback(closes, sma50_slope_lookback)
    sma50_slope = None
    if sma50 is not None and sma50_10d_ago is not None and sma50_10d_ago != 0:
        sma50_slope = (sma50 - sma50_10d_ago) / sma50_10d_ago

    return {
        "close": close,
        "atr_d": atr_d,
        "atr_pct": atr_pct,
        "roc_5": roc_5,
        "roc_20": roc_20,
        "roc_5_norm": roc_5_norm,
        "roc_20_norm": roc_20_norm,
        "one_day_return_pct": one_day_return_pct,
        "sigma_log_20": sigma_log_20,
        "one_day_return_in_sigma": one_day_return_in_sigma,
        "return_3d_pct": return_3d_pct,
        "return_5d_pct": return_5d_pct,
        "return_3d_in_sigma": return_3d_in_sigma,
        "return_5d_in_sigma": return_5d_in_sigma,
        "recent_trend_sigma_abs": recent_trend_sigma_abs,
        "recent_trend_direction": recent_trend_direction,
        "up_days_5d": up_days_5d,
        "down_days_5d": down_days_5d,
        "avg_abs_daily_change_pct": avg_abs_daily_change,
        "drop_3d_pct": drop_3d_pct,
        "drop_5d_pct": drop_5d_pct,
        "multiday_drop_ratio": multiday_drop_ratio,
        "drawdown_pct": drawdown,
        "drawdown_in_atr": drawdown_in_atr,
        "sma50": sma50,
        "sma50_slope_10d": sma50_slope,
    }


def compute_anomaly_snapshot(
    bars_up_to_date: List[Dict[str, Any]],
    indicators: Dict[str, Any],
    settings: Dict[str, Any],
) -> Dict[str, float | str | None]:
    return _build_metrics(bars_up_to_date=bars_up_to_date, indicators=indicators, settings=settings)


def _event_text(code: AnomalyCode) -> str:
    mapping = {
        AnomalyCode.EXTREME_DRAWDOWN: "Extreme volatility-adjusted drawdown detected.",
        AnomalyCode.ABNORMAL_DRAWDOWN: "Abnormal volatility-adjusted drawdown detected.",
        AnomalyCode.FIXED_DAILY_DROP: "Fixed-threshold daily drop detected.",
        AnomalyCode.MULTIDAY_DROP: "Multi-day drop acceleration detected.",
        AnomalyCode.RECENT_ABNORMAL_TREND: "Abnormal multi-day trend detected in recent sessions.",
        AnomalyCode.STD_PULLBACK: "Standardized pullback detected (buy-context info).",
        AnomalyCode.MOMENTUM_WARN: "Momentum deterioration detected versus volatility baseline.",
        AnomalyCode.TREND_DETERIORATION: "Trend deterioration confirmed with drawdown pressure.",
    }
    return mapping[code]


def _severity_for(code: AnomalyCode) -> AnomalySeverity:
    if code in {
        AnomalyCode.EXTREME_DRAWDOWN,
        AnomalyCode.ABNORMAL_DRAWDOWN,
        AnomalyCode.FIXED_DAILY_DROP,
        AnomalyCode.MULTIDAY_DROP,
        AnomalyCode.RECENT_ABNORMAL_TREND,
    }:
        return AnomalySeverity.HIGH
    return AnomalySeverity.INFO


def compute_anomaly_event(
    key: str,
    position: Dict[str, Any],
    bars_up_to_date: List[Dict[str, Any]],
    indicators: Dict[str, Any],
    settings: Dict[str, Any],
) -> AnomalyEvent | None:
    metrics = _build_metrics(bars_up_to_date=bars_up_to_date, indicators=indicators, settings=settings)
    close = _to_float(metrics.get("close"))
    sma50 = _to_float(metrics.get("sma50"))
    roc_5_norm = _to_float(metrics.get("roc_5_norm"))
    roc_20_norm = _to_float(metrics.get("roc_20_norm"))
    atr_pct = _to_float(metrics.get("atr_pct"))
    drawdown_in_atr = _to_float(metrics.get("drawdown_in_atr"))
    sma50_slope = _to_float(metrics.get("sma50_slope_10d"))
    multiday_drop_ratio = _to_float(metrics.get("multiday_drop_ratio"))
    drop_3d_pct = _to_float(metrics.get("drop_3d_pct"))
    drop_5d_pct = _to_float(metrics.get("drop_5d_pct"))
    one_day_return_pct = _to_float(metrics.get("one_day_return_pct"))
    one_day_return_in_sigma = _to_float(metrics.get("one_day_return_in_sigma"))
    recent_trend_sigma_abs = _to_float(metrics.get("recent_trend_sigma_abs"))
    recent_trend_direction = str(metrics.get("recent_trend_direction") or "")
    up_days_5d = int(metrics.get("up_days_5d") or 0)
    down_days_5d = int(metrics.get("down_days_5d") or 0)

    short_threshold = float(settings.get("anomaly_momentum_warn_short_threshold", -2.0))
    long_threshold = float(settings.get("anomaly_momentum_warn_long_threshold", -1.5))
    abnormal_threshold = float(settings.get("anomaly_drawdown_abnormal_threshold", 2.8))
    extreme_threshold = float(settings.get("anomaly_drawdown_extreme_threshold", 4.5))
    trend_slope_threshold = float(settings.get("anomaly_trend_sma50_slope_threshold", -0.002))
    trend_drawdown_min = float(settings.get("anomaly_trend_drawdown_min", 2.0))
    multiday_abnormal_threshold = float(settings.get("anomaly_multiday_drop_ratio_abnormal", 1.8))
    multiday_extreme_threshold = float(settings.get("anomaly_multiday_drop_ratio_extreme", 2.6))
    multiday_focus_enabled = bool(settings.get("anomaly_multiday_drop_focus_enabled", False))
    multiday_focus_min_3d_pct = abs(float(settings.get("anomaly_multiday_drop_min_3d_pct", 4.0)))
    multiday_focus_min_5d_pct = abs(float(settings.get("anomaly_multiday_drop_min_5d_pct", 6.0)))
    multiday_focus_min_down_days = max(2, int(settings.get("anomaly_multiday_drop_min_down_days", 3)))
    multiday_focus_min_ratio = max(0.0, float(settings.get("anomaly_multiday_drop_min_ratio", 0.9)))
    fixed_daily_drop_threshold = float(settings.get("anomaly_fixed_daily_drop_threshold_pct", 8.0))
    recent_trend_sigma_threshold = float(settings.get("anomaly_recent_trend_sigma_threshold", 2.8))
    recent_trend_consistent_days = max(3, int(settings.get("anomaly_recent_trend_consistent_days", 4)))
    std_pullback_sigma_threshold = float(settings.get("anomaly_std_pullback_sigma_threshold", -1.0))

    momentum_warn = bool(
        roc_5_norm is not None
        and roc_20_norm is not None
        and roc_5_norm < short_threshold
        and roc_20_norm < long_threshold
    )
    multiday_abnormal = bool(
        atr_pct is not None
        and atr_pct > 0
        and multiday_drop_ratio is not None
        and multiday_drop_ratio >= multiday_abnormal_threshold
    )
    multiday_extreme = bool(
        atr_pct is not None
        and atr_pct > 0
        and multiday_drop_ratio is not None
        and multiday_drop_ratio >= multiday_extreme_threshold
    )
    abnormal_drawdown = bool(
        close is not None
        and sma50 is not None
        and close < sma50
        and (
            (drawdown_in_atr is not None and drawdown_in_atr >= abnormal_threshold)
            or multiday_abnormal
        )
    )
    extreme_drawdown = bool(
        (drawdown_in_atr is not None and drawdown_in_atr >= extreme_threshold)
        or multiday_extreme
    )
    trend_deterioration = bool(
        close is not None
        and sma50 is not None
        and sma50_slope is not None
        and drawdown_in_atr is not None
        and close < sma50
        and sma50_slope < trend_slope_threshold
        and drawdown_in_atr >= trend_drawdown_min
    )
    fixed_daily_drop = bool(
        one_day_return_pct is not None
        and one_day_return_pct <= -abs(fixed_daily_drop_threshold)
    )
    multiday_drop_focus = bool(
        multiday_focus_enabled
        and down_days_5d >= multiday_focus_min_down_days
        and (
            (drop_3d_pct is not None and drop_3d_pct <= -multiday_focus_min_3d_pct)
            or (drop_5d_pct is not None and drop_5d_pct <= -multiday_focus_min_5d_pct)
        )
        and (
            multiday_drop_ratio is None
            or multiday_drop_ratio >= multiday_focus_min_ratio
        )
    )
    recent_abnormal_trend = bool(
        atr_pct is not None
        and atr_pct > 0
        and
        recent_trend_sigma_abs is not None
        and recent_trend_sigma_abs >= recent_trend_sigma_threshold
        and recent_trend_direction in {"UP", "DOWN"}
        and (up_days_5d >= recent_trend_consistent_days or down_days_5d >= recent_trend_consistent_days)
    )
    std_pullback = bool(
        atr_pct is not None
        and atr_pct > 0
        and one_day_return_in_sigma is not None
        and one_day_return_in_sigma <= float(std_pullback_sigma_threshold)
        and one_day_return_pct is not None
        and one_day_return_pct < 0.0
    )

    code: AnomalyCode | None = None
    if fixed_daily_drop:
        code = AnomalyCode.FIXED_DAILY_DROP
    elif multiday_drop_focus:
        code = AnomalyCode.MULTIDAY_DROP
    elif extreme_drawdown:
        code = AnomalyCode.EXTREME_DRAWDOWN
    elif abnormal_drawdown:
        code = AnomalyCode.ABNORMAL_DRAWDOWN
    elif momentum_warn:
        code = AnomalyCode.MOMENTUM_WARN
    elif trend_deterioration:
        code = AnomalyCode.TREND_DETERIORATION
    elif recent_abnormal_trend:
        code = AnomalyCode.RECENT_ABNORMAL_TREND
    elif std_pullback:
        code = AnomalyCode.STD_PULLBACK

    if code is None:
        return None

    bar_date = str(bars_up_to_date[-1]["date"]) if bars_up_to_date else ""
    symbol = position.get("identity", {})
    return AnomalyEvent(
        bar_date=bar_date,
        key=key,
        symbol={
            "ticker": symbol.get("ticker"),
            "exchange": symbol.get("exchange"),
            "currency": symbol.get("currency"),
        },
        code=code,
        severity=_severity_for(code),
        metrics=metrics,
        text=_event_text(code),
    )
