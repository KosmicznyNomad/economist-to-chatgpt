from __future__ import annotations

from src.engine.anomalies import compute_anomaly_event
from src.engine.definitions import AnomalyCode
from src.storage.positions_store import default_global_settings


def _bars(closes: list[float]) -> list[dict]:
    return [
        {
            "date": f"2026-01-{idx + 1:02d}",
            "close": float(close),
        }
        for idx, close in enumerate(closes)
    ]


def _position() -> dict:
    return {
        "identity": {
            "ticker": "AAA",
            "exchange": "NYSE",
            "currency": "USD",
        }
    }


def test_extreme_drawdown_has_top_priority():
    settings = default_global_settings()
    closes = [100.0] * 50 + [99.0, 98.0, 97.0, 96.0, 95.0, 94.0, 93.0, 92.0, 91.0, 90.0]
    bars = _bars(closes)
    indicators = {"price_close": 90.0, "atr_d": 0.9, "sma50": 96.0}

    event = compute_anomaly_event(
        key="AAA:NYSE",
        position=_position(),
        bars_up_to_date=bars,
        indicators=indicators,
        settings=settings,
    )

    assert event is not None
    assert event.code == AnomalyCode.EXTREME_DRAWDOWN


def test_abnormal_drawdown_detected_when_threshold_crossed():
    settings = default_global_settings()
    closes = [100.0] * 49 + [99.5, 99.0, 98.0, 97.0, 96.0, 95.0, 94.0, 93.0, 92.0, 90.0, 89.0]
    bars = _bars(closes)
    indicators = {"price_close": 89.0, "atr_d": 2.67, "sma50": 96.0}

    event = compute_anomaly_event(
        key="AAA:NYSE",
        position=_position(),
        bars_up_to_date=bars,
        indicators=indicators,
        settings=settings,
    )

    assert event is not None
    assert event.code == AnomalyCode.ABNORMAL_DRAWDOWN


def test_abnormal_drawdown_can_trigger_without_momentum_confirmation():
    settings = default_global_settings()
    closes = [100.0] * 52 + [99.5, 99.0, 98.5, 98.0, 97.5, 97.0, 96.5, 96.0, 95.5, 95.0]
    bars = _bars(closes)
    indicators = {"price_close": 95.0, "atr_d": 1.6, "sma50": 98.5}

    event = compute_anomaly_event(
        key="AAA:NYSE",
        position=_position(),
        bars_up_to_date=bars,
        indicators=indicators,
        settings=settings,
    )

    assert event is not None
    assert event.code == AnomalyCode.ABNORMAL_DRAWDOWN


def test_momentum_case_is_escalated_to_extreme_when_drawdown_shock_is_strong():
    settings = default_global_settings()
    closes = [100.0] * 54 + [100.0, 99.0, 98.0, 97.0, 96.0, 95.0]
    bars = _bars(closes)
    indicators = {"price_close": 95.0, "atr_d": 1.9, "sma50": 98.0}

    event = compute_anomaly_event(
        key="AAA:NYSE",
        position=_position(),
        bars_up_to_date=bars,
        indicators=indicators,
        settings=settings,
    )

    assert event is not None
    assert event.code == AnomalyCode.EXTREME_DRAWDOWN


def test_trend_deterioration_case_is_escalated_to_abnormal_with_new_thresholds():
    settings = default_global_settings()
    closes = [100.0] * 50 + [99.5, 99.0, 98.5, 98.0, 97.5, 97.0, 96.5, 96.0, 95.5, 95.0]
    bars = _bars(closes)
    indicators = {"price_close": 95.0, "atr_d": 1.8, "sma50": 98.0}

    event = compute_anomaly_event(
        key="AAA:NYSE",
        position=_position(),
        bars_up_to_date=bars,
        indicators=indicators,
        settings=settings,
    )

    assert event is not None
    assert event.code == AnomalyCode.ABNORMAL_DRAWDOWN


def test_momentum_warn_can_still_trigger_when_high_drawdown_filters_are_disabled():
    settings = default_global_settings()
    settings["anomaly_drawdown_abnormal_threshold"] = 999.0
    settings["anomaly_drawdown_extreme_threshold"] = 999.0
    settings["anomaly_multiday_drop_ratio_abnormal"] = 999.0
    settings["anomaly_multiday_drop_ratio_extreme"] = 999.0
    closes = [100.0] * 54 + [100.0, 99.0, 98.0, 97.0, 96.0, 95.0]
    bars = _bars(closes)
    indicators = {"price_close": 95.0, "atr_d": 1.9, "sma50": 98.0}

    event = compute_anomaly_event(
        key="AAA:NYSE",
        position=_position(),
        bars_up_to_date=bars,
        indicators=indicators,
        settings=settings,
    )

    assert event is not None
    assert event.code == AnomalyCode.MOMENTUM_WARN


def test_no_alert_when_history_is_too_short_for_anomaly_windows():
    settings = default_global_settings()
    closes = [100.0, 99.8, 99.7, 99.6]
    bars = _bars(closes)
    indicators = {"price_close": closes[-1], "atr_d": 1.0, "sma50": None}

    event = compute_anomaly_event(
        key="AAA:NYSE",
        position=_position(),
        bars_up_to_date=bars,
        indicators=indicators,
        settings=settings,
    )

    assert event is None


def test_no_alert_when_atr_pct_is_invalid():
    settings = default_global_settings()
    closes = [100.0] * 54 + [100.0, 99.0, 98.0, 97.0, 96.0, 95.0]
    bars = _bars(closes)
    indicators = {"price_close": 95.0, "atr_d": 0.0, "sma50": 98.0}

    event = compute_anomaly_event(
        key="AAA:NYSE",
        position=_position(),
        bars_up_to_date=bars,
        indicators=indicators,
        settings=settings,
    )

    assert event is None


def test_multiday_drop_ratio_triggers_abnormal_for_low_volatility_symbol():
    settings = default_global_settings()
    # Disable ATR-based drawdown path so this test isolates the multiday ratio logic.
    settings["anomaly_drawdown_abnormal_threshold"] = 999.0
    settings["anomaly_drawdown_extreme_threshold"] = 999.0
    settings["anomaly_multiday_drop_ratio_abnormal"] = 1.5
    settings["anomaly_multiday_drop_ratio_extreme"] = 3.0

    closes = [
        100.0,
        100.1,
        100.0,
        100.1,
        100.0,
        100.1,
        100.0,
        100.1,
        100.0,
        100.1,
        100.0,
        100.1,
        100.0,
        100.1,
        100.0,
        100.1,
        100.0,
        100.1,
        100.0,
        100.1,
        100.0,
        99.6,
        99.1,
        98.8,
    ]
    bars = _bars(closes)
    indicators = {"price_close": 98.8, "atr_d": 6.0, "sma50": 99.8}

    event = compute_anomaly_event(
        key="AAA:NYSE",
        position=_position(),
        bars_up_to_date=bars,
        indicators=indicators,
        settings=settings,
    )

    assert event is not None
    assert event.code == AnomalyCode.ABNORMAL_DRAWDOWN


def test_fixed_daily_drop_threshold_triggers_alert_independent_of_symbol_profile():
    settings = default_global_settings()
    settings["anomaly_drawdown_abnormal_threshold"] = 999.0
    settings["anomaly_drawdown_extreme_threshold"] = 999.0
    settings["anomaly_multiday_drop_ratio_abnormal"] = 999.0
    settings["anomaly_multiday_drop_ratio_extreme"] = 999.0
    settings["anomaly_fixed_daily_drop_threshold_pct"] = 8.0

    closes = [100.0, 100.0, 100.0, 91.0]
    bars = _bars(closes)
    indicators = {"price_close": 91.0, "atr_d": 5.0, "sma50": 99.0}

    event = compute_anomaly_event(
        key="AAA:NYSE",
        position=_position(),
        bars_up_to_date=bars,
        indicators=indicators,
        settings=settings,
    )

    assert event is not None
    assert event.code == AnomalyCode.FIXED_DAILY_DROP


def test_multiday_drop_focus_triggers_when_enabled():
    settings = default_global_settings()
    settings["anomaly_multiday_drop_focus_enabled"] = True
    settings["anomaly_multiday_drop_min_3d_pct"] = 4.0
    settings["anomaly_multiday_drop_min_5d_pct"] = 6.0
    settings["anomaly_multiday_drop_min_down_days"] = 3
    settings["anomaly_multiday_drop_min_ratio"] = 0.5
    settings["anomaly_drawdown_abnormal_threshold"] = 999.0
    settings["anomaly_drawdown_extreme_threshold"] = 999.0
    settings["anomaly_multiday_drop_ratio_abnormal"] = 999.0
    settings["anomaly_multiday_drop_ratio_extreme"] = 999.0
    settings["anomaly_fixed_daily_drop_threshold_pct"] = 99.0

    closes = [100.0, 99.0, 97.0, 95.0, 93.0, 90.0]
    bars = _bars(closes)
    indicators = {"price_close": 90.0, "atr_d": 2.0, "sma50": 99.0}

    event = compute_anomaly_event(
        key="AAA:NYSE",
        position=_position(),
        bars_up_to_date=bars,
        indicators=indicators,
        settings=settings,
    )

    assert event is not None
    assert event.code == AnomalyCode.MULTIDAY_DROP


def test_std_pullback_info_triggers_on_large_negative_one_day_sigma_move():
    settings = default_global_settings()
    settings["anomaly_drawdown_abnormal_threshold"] = 999.0
    settings["anomaly_drawdown_extreme_threshold"] = 999.0
    settings["anomaly_multiday_drop_ratio_abnormal"] = 999.0
    settings["anomaly_multiday_drop_ratio_extreme"] = 999.0
    settings["anomaly_fixed_daily_drop_threshold_pct"] = 99.0
    settings["anomaly_std_pullback_sigma_threshold"] = -1.0

    closes = [
        100.0,
        100.2,
        100.1,
        100.2,
        100.1,
        100.2,
        100.1,
        100.2,
        100.1,
        100.2,
        100.1,
        100.2,
        100.1,
        100.2,
        100.1,
        100.2,
        100.1,
        100.2,
        100.1,
        100.2,
        98.8,
    ]
    bars = _bars(closes)
    indicators = {"price_close": 98.8, "atr_d": 2.5, "sma50": 99.5}

    event = compute_anomaly_event(
        key="AAA:NYSE",
        position=_position(),
        bars_up_to_date=bars,
        indicators=indicators,
        settings=settings,
    )

    assert event is not None
    assert event.code == AnomalyCode.STD_PULLBACK


def test_recent_abnormal_trend_triggers_on_extreme_up_move_over_last_days():
    settings = default_global_settings()
    settings["anomaly_drawdown_abnormal_threshold"] = 999.0
    settings["anomaly_drawdown_extreme_threshold"] = 999.0
    settings["anomaly_multiday_drop_ratio_abnormal"] = 999.0
    settings["anomaly_multiday_drop_ratio_extreme"] = 999.0
    settings["anomaly_fixed_daily_drop_threshold_pct"] = 99.0
    settings["anomaly_recent_trend_sigma_threshold"] = 2.4
    settings["anomaly_recent_trend_consistent_days"] = 4

    closes = [
        100.0,
        100.1,
        100.0,
        100.1,
        100.0,
        100.1,
        100.0,
        100.1,
        100.0,
        100.1,
        100.0,
        100.1,
        100.0,
        100.1,
        100.0,
        100.1,
        100.0,
        100.1,
        100.0,
        100.1,
        101.5,
        103.0,
        104.8,
        106.7,
        108.9,
    ]
    bars = _bars(closes)
    indicators = {"price_close": 108.9, "atr_d": 2.2, "sma50": 102.0}

    event = compute_anomaly_event(
        key="AAA:NYSE",
        position=_position(),
        bars_up_to_date=bars,
        indicators=indicators,
        settings=settings,
    )

    assert event is not None
    assert event.code == AnomalyCode.RECENT_ABNORMAL_TREND
    assert event.metrics.get("recent_trend_direction") == "UP"


def test_std_pullback_can_trigger_with_shorter_history_using_adaptive_sigma_window():
    settings = default_global_settings()
    settings["anomaly_drawdown_abnormal_threshold"] = 999.0
    settings["anomaly_drawdown_extreme_threshold"] = 999.0
    settings["anomaly_multiday_drop_ratio_abnormal"] = 999.0
    settings["anomaly_multiday_drop_ratio_extreme"] = 999.0
    settings["anomaly_fixed_daily_drop_threshold_pct"] = 99.0
    settings["anomaly_recent_trend_sigma_threshold"] = 99.0
    settings["anomaly_std_window"] = 20
    settings["anomaly_std_min_window"] = 8
    settings["anomaly_std_pullback_sigma_threshold"] = -1.0

    closes = [100.0, 100.2, 100.1, 100.2, 100.1, 100.2, 100.1, 100.2, 100.1, 98.9]
    bars = _bars(closes)
    indicators = {"price_close": 98.9, "atr_d": 2.0, "sma50": None}

    event = compute_anomaly_event(
        key="AAA:NYSE",
        position=_position(),
        bars_up_to_date=bars,
        indicators=indicators,
        settings=settings,
    )

    assert event is not None
    assert event.code == AnomalyCode.STD_PULLBACK


def test_abnormal_drawdown_uses_sma_fallback_for_short_history():
    settings = default_global_settings()
    settings["anomaly_drawdown_abnormal_threshold"] = 1.2
    settings["anomaly_drawdown_extreme_threshold"] = 99.0
    settings["anomaly_multiday_drop_ratio_abnormal"] = 99.0
    settings["anomaly_multiday_drop_ratio_extreme"] = 99.0
    settings["anomaly_fixed_daily_drop_threshold_pct"] = 99.0
    settings["anomaly_recent_trend_sigma_threshold"] = 99.0
    settings["anomaly_std_pullback_sigma_threshold"] = -99.0
    settings["anomaly_drawdown_lookback"] = 20
    settings["anomaly_drawdown_min_lookback"] = 5
    settings["anomaly_sma_fallback_min_window"] = 8

    closes = [100.0, 100.5, 101.0, 100.8, 100.6, 99.9, 99.2, 98.5, 97.9, 97.2]
    bars = _bars(closes)
    indicators = {"price_close": 97.2, "atr_d": 1.2, "sma50": None}

    event = compute_anomaly_event(
        key="AAA:NYSE",
        position=_position(),
        bars_up_to_date=bars,
        indicators=indicators,
        settings=settings,
    )

    assert event is not None
    assert event.code == AnomalyCode.ABNORMAL_DRAWDOWN
