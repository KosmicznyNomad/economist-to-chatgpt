from __future__ import annotations

import math
from typing import Any, Dict, List, Optional


def _mean(values: List[float]) -> Optional[float]:
    if not values:
        return None
    return sum(values) / len(values)


def _stdev(values: List[float]) -> Optional[float]:
    if len(values) < 2:
        return None
    avg = _mean(values)
    if avg is None:
        return None
    variance = sum((value - avg) ** 2 for value in values) / len(values)
    if variance <= 0:
        return 0.0
    return math.sqrt(variance)


def extract_closes(bars: List[Dict[str, Any]]) -> List[float]:
    return [float(item["close"]) for item in bars]


def true_range_at(bars: List[Dict[str, Any]], index: int) -> float:
    if index <= 0:
        raise ValueError("True Range needs a previous close.")
    high = float(bars[index]["high"])
    low = float(bars[index]["low"])
    prev_close = float(bars[index - 1]["close"])
    return max(
        high - low,
        abs(high - prev_close),
        abs(low - prev_close),
    )


def compute_true_range_series(bars: List[Dict[str, Any]]) -> List[float]:
    if len(bars) < 2:
        return []
    return [true_range_at(bars, idx) for idx in range(1, len(bars))]


def compute_atr_ema(bars: List[Dict[str, Any]], period: int, min_period: int = 5) -> Optional[float]:
    trs = compute_true_range_series(bars)
    effective_period = min(max(1, int(period)), len(trs))
    required_min = max(2, int(min_period))
    if effective_period < required_min:
        return None

    atr = _mean(trs[:effective_period])
    if atr is None:
        return None

    alpha = 1.0 / effective_period
    for tr in trs[effective_period:]:
        atr = atr * (1.0 - alpha) + tr * alpha
    return atr


def compute_sma(values: List[float], window: int) -> Optional[float]:
    if len(values) < window:
        return None
    return _mean(values[-window:])


def compute_5d_move(closes: List[float]) -> Optional[float]:
    if len(closes) < 6:
        return None
    return closes[-1] - closes[-6]


def compute_r3_pct(closes: List[float]) -> Optional[float]:
    if len(closes) < 4:
        return None
    base = float(closes[-4])
    if base == 0:
        return None
    return float(closes[-1]) / base - 1.0


def compute_up_streak(closes: List[float]) -> int:
    if len(closes) < 2:
        return 0
    streak = 0
    for index in range(len(closes) - 1, 0, -1):
        if float(closes[index]) > float(closes[index - 1]):
            streak += 1
            continue
        break
    return streak


def compute_sma200_slope(
    closes: List[float],
    sma_window: int = 200,
    lookback: int = 20,
) -> Optional[str]:
    if len(closes) < sma_window + lookback:
        return None
    today = _mean(closes[-sma_window:])
    past = _mean(closes[-(sma_window + lookback) : -lookback])
    if today is None or past is None:
        return None
    if today > past:
        return "rising"
    return "flat_or_falling"


def compute_zscore(closes: List[float], window: int = 20, min_window: int = 10) -> Optional[float]:
    effective_window = min(max(2, int(window)), len(closes))
    required_min = max(2, int(min_window))
    if effective_window < required_min:
        return None
    recent = [float(value) for value in closes[-effective_window:]]
    avg = _mean(recent)
    sd = _stdev(recent)
    if avg is None or sd is None or sd <= 0:
        return None
    return (float(closes[-1]) - avg) / sd


def compute_indicator_snapshot(
    bars: List[Dict[str, Any]],
    settings: Dict[str, Any],
) -> Dict[str, Any]:
    if not bars:
        return {}

    closes = extract_closes(bars)
    atr_period = int(settings["atr_period"])
    sma50_period = int(settings["sma50_period"])
    sma200_period = int(settings["sma200_period"])
    slope_lookback = int(settings["sma200_slope_lookback"])
    atr_min_period = int(settings.get("entry_atr_min_period", 5))
    z20_window = int(settings.get("entry_z20_window", 20))
    z20_min_window = int(settings.get("entry_z20_min_window", 10))

    atr_d = compute_atr_ema(bars, atr_period, min_period=atr_min_period)
    atr_w = atr_d * float(settings["atr_daily_to_weekly"]) if atr_d is not None else None
    sma50 = compute_sma(closes, sma50_period)
    sma200 = compute_sma(closes, sma200_period)
    sma200_slope = compute_sma200_slope(
        closes,
        sma_window=sma200_period,
        lookback=slope_lookback,
    )
    five_d_move = compute_5d_move(closes)
    z20 = compute_zscore(closes, window=z20_window, min_window=z20_min_window)
    up_streak = compute_up_streak(closes)
    r3_pct = compute_r3_pct(closes)

    prev_close = float(closes[-2]) if len(closes) >= 2 else None
    prev_high = float(bars[-2]["high"]) if len(bars) >= 2 else None
    prev_sma50 = compute_sma(closes[:-1], sma50_period) if len(closes) >= sma50_period + 1 else None
    close = float(closes[-1])
    trend_up = bool(
        sma200 is not None
        and sma200_slope == "rising"
        and close > sma200
    )
    overheat_upstreak_threshold = int(settings.get("entry_overheat_upstreak", 5))
    overheat_r3_threshold = float(settings.get("entry_overheat_r3_pct", 12.0)) / 100.0
    oversold_threshold = float(settings.get("entry_z20_threshold", -1.5))
    reversal = bool(prev_high is not None and close > float(prev_high))
    overheated = bool(
        up_streak >= overheat_upstreak_threshold
        or (r3_pct is not None and r3_pct >= overheat_r3_threshold)
    )
    setup_oversold = bool(z20 is not None and z20 <= oversold_threshold)

    return {
        "price_close": close,
        "atr_d": atr_d,
        "atr_w": atr_w,
        "sma50": sma50,
        "sma200": sma200,
        "sma200_slope": sma200_slope,
        "five_d_move": five_d_move,
        "z20": z20,
        "up_streak": up_streak,
        "r3_pct": r3_pct,
        "overheated": overheated,
        "setup_oversold": setup_oversold,
        "reversal": reversal,
        "prev_close": prev_close,
        "prev_high": prev_high,
        "prev_sma50": prev_sma50,
        "trend_up": trend_up,
    }
