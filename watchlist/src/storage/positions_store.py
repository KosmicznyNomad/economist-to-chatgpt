from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any, Dict, Iterable, List

from src.engine.definitions import Mode, State
from src.marketdata.symbols import default_stooq_symbol


SCHEMA_VERSION = "psm_v4"


LEGACY_STATE_MAP = {
    "ACTIVE": State.NORMAL_RUN.value,
    "NORMAL_RUN": State.NORMAL_RUN.value,
    "SPIKE_LOCK": State.SPIKE_LOCK.value,
    "EXITED_COOLDOWN": State.EXITED_COOLDOWN.value,
    "REENTRY_WINDOW": State.REENTRY_WINDOW.value,
}


def default_global_settings() -> Dict[str, Any]:
    return {
        "atr_period": 14,
        "atr_daily_to_weekly": 2.2,
        "spike_mult": 2.5,
        "vix_symbol": "^vix",
        "vix_mid_threshold": 25.0,
        "vix_high_threshold": 30.0,
        "vix_mid_regime_mult": 1.15,
        "vix_high_regime_mult": 1.30,
        "sma50_period": 50,
        "sma200_period": 200,
        "sma200_slope_lookback": 20,
        "trend_break_buffer_pct": 0.005,
        "cooldown_sessions": 5,
        "spike_lock_sessions": 10,
        "reentry_window_sessions": 40,
        "reentry_pullback_min_atrw": 1.5,
        "reentry_pullback_max_atrw": 4.0,
        "catastrophe_floor_pct": 0.70,
        "bear_total_floor_pct": 0.90,
        "profit_at_base_pct": 0.25,
        "profit_at_bull_pct": 0.25,
        "spike_sell_pct_first": 0.25,
        "spike_sell_pct_low": 0.20,
        "spike_sell_pct_mid": 0.25,
        "spike_sell_pct_high": 0.30,
        "spike_sell_pnl_mid_pct": 20.0,
        "spike_sell_pnl_high_pct": 40.0,
        "warn_sell_pct": 0.30,
        "reentry_position_pct": 0.50,
        "anomaly_momentum_roc_short_period": 5,
        "anomaly_momentum_roc_long_period": 20,
        "anomaly_momentum_warn_short_threshold": -2.0,
        "anomaly_momentum_warn_long_threshold": -1.5,
        "anomaly_drawdown_lookback": 20,
        "anomaly_drawdown_abnormal_threshold": 2.8,
        "anomaly_drawdown_extreme_threshold": 4.5,
        "anomaly_fixed_daily_drop_threshold_pct": 8.0,
        "anomaly_multiday_avg_window": 20,
        "anomaly_multiday_drop_ratio_abnormal": 1.8,
        "anomaly_multiday_drop_ratio_extreme": 2.6,
        "anomaly_multiday_drop_focus_enabled": False,
        "anomaly_multiday_drop_min_3d_pct": 4.0,
        "anomaly_multiday_drop_min_5d_pct": 6.0,
        "anomaly_multiday_drop_min_down_days": 3,
        "anomaly_multiday_drop_min_ratio": 0.9,
        "anomaly_std_window": 20,
        "anomaly_std_min_window": 8,
        "anomaly_drawdown_min_lookback": 5,
        "anomaly_sma_fallback_min_window": 10,
        "anomaly_recent_trend_sigma_threshold": 2.8,
        "anomaly_recent_trend_consistent_days": 4,
        "anomaly_std_pullback_sigma_threshold": -1.0,
        "anomaly_trend_sma50_slope_lookback": 10,
        "anomaly_trend_sma50_slope_threshold": -0.002,
        "anomaly_trend_drawdown_min": 2.0,
        "bars_buffer_max": 260,
        "stooq_fetch_days": 10,
        "stooq_quotes_batch_size": 8,
        "stooq_seed_days": 400,
        "stooq_fallback_days": 400,
        "entry_mvp_enabled": True,
        "entry_mode_default": "PULLBACK",
        "entry_setup_metric": "z20",
        "entry_z20_window": 20,
        "entry_z20_min_window": 10,
        "entry_z20_threshold": -1.5,
        "entry_atr_min_period": 5,
        "entry_overheat_upstreak": 5,
        "entry_overheat_r3_pct": 12.0,
        "entry_min_price": 5.0,
        "entry_time_stop_days": 7,
        "entry_sizing_atr_mult": 2.0,
        "entry_cat_stop_atr_mult": 3.0,
        "entry_risk_per_trade_pct": 1.0,
        "entry_capital_base": None,
    }


def empty_store() -> Dict[str, Any]:
    return {
        "meta": {
            "schema_version": SCHEMA_VERSION,
            "asof_bar_date": None,
            "last_run_utc": None,
        },
        "global": default_global_settings(),
        "positions": {},
        "research_rows": [],
        "research_import_meta": {},
    }


def _position_defaults(key: str) -> Dict[str, Any]:
    ticker, exchange = _split_key(key)
    return {
        "identity": {
            "ticker": ticker,
            "exchange": exchange,
            "stooq_symbol": default_stooq_symbol(ticker, exchange),
            "currency": "USD",
        },
        "mode": Mode.WATCH.value,
        "state": State.EXITED_COOLDOWN.value,
        "targets": {
            "bear_total": None,
            "base_total": None,
            "bull_total": None,
        },
        "execution": {
            "entry_price": None,
            "entry_bar_date": None,
            "target_weight_pct": None,
            "current_weight_pct": 0.0,
        },
        "entry_profile": {
            "enabled": True,
            "mode": "PULLBACK",
        },
        "thesis_kpis": {},
        "fundamental_triggers": {
            "pending_trigger": None,
            "last_trigger_bar_date": None,
        },
        "runtime": {
            "hwm_close": None,
            "hwm_bar_date": None,
            "hwm_at_exit": None,
            "cooldown_start_bar_date": None,
            "cooldown_bars_left": 0,
            "spike_lock_start_bar_date": None,
            "last_spike_bar_date": None,
            "reentry_window_start_bar_date": None,
            "reentry_bars_left": 0,
            "base_sold": False,
            "bull_sold": False,
            "warn_count": 0,
            "permanent_exit": False,
            "consecutive_closes_below_sma200": 0,
            "last_processed_bar_date": None,
            "last_action_bar_date": None,
        },
        "buffers": {
            "ohlc": [],
        },
        "computed": {
            "price_close": None,
            "prev_close": None,
            "day_change_pct": None,
            "hwm_close": None,
            "atr_d": None,
            "atr_w": None,
            "five_d_move": None,
            "spike_threshold": None,
            "sma50": None,
            "sma200": None,
            "sma200_slope": None,
            "trend_up": None,
            "z20": None,
            "up_streak": None,
            "r3_pct": None,
            "overheated": None,
            "setup_oversold": None,
            "reversal": None,
            "entry_ref_price": None,
            "stop_loss_price": None,
            "stop_distance_for_size": None,
            "time_stop_days": None,
            "shares_hint": None,
            "chandelier_k": None,
            "chandelier_stop": None,
            "giveback_lock": None,
            "catastrophe_floor": None,
            "effective_stop": None,
            "pullback_min": None,
            "pullback_max": None,
            "in_band": None,
            "is_spike": None,
            "vix_close": None,
            "regime_mult": None,
            "unrealized_pnl_pct": None,
            "return_from_hwm_pct": None,
            "priced_in_pct": None,
            "gap_to_base_pct": None,
            "gap_to_bull_pct": None,
            "roc_5_norm": None,
            "roc_20_norm": None,
            "drawdown_in_atr": None,
            "sma50_slope_10d": None,
            "atr_pct": None,
            "anomaly_code_last": None,
            "anomaly_severity_last": None,
        },
    }


def _split_key(key: str) -> tuple[str, str]:
    if ":" in key:
        ticker, exchange = key.split(":", 1)
        return ticker, exchange
    return key, "UNKNOWN"


def make_key(ticker: str, exchange: str) -> str:
    return f"{ticker}:{exchange}"


def _deep_merge(defaults: Dict[str, Any], custom: Dict[str, Any]) -> Dict[str, Any]:
    merged = deepcopy(defaults)
    for key, value in custom.items():
        if key in merged and isinstance(merged[key], dict) and isinstance(value, dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def _legacy_buffers_to_ohlc(position: Dict[str, Any]) -> List[Dict[str, Any]]:
    bars = position.get("bars")
    if isinstance(bars, list) and bars:
        normalized = []
        for bar in bars:
            normalized.append(
                {
                    "date": str(bar["date"]),
                    "open": float(bar["open"]),
                    "high": float(bar["high"]),
                    "low": float(bar["low"]),
                    "close": float(bar["close"]),
                    "volume": int(bar.get("volume", 0)),
                }
            )
        return normalized

    buffers = position.get("buffers", {})
    dates = buffers.get("date", [])
    opens = buffers.get("open", [])
    highs = buffers.get("high", [])
    lows = buffers.get("low", [])
    closes = buffers.get("close", [])
    volumes = buffers.get("volume", [0] * len(dates))
    converted = []
    for idx, raw_date in enumerate(dates):
        if idx >= len(opens) or idx >= len(highs) or idx >= len(lows) or idx >= len(closes):
            continue
        converted.append(
            {
                "date": str(raw_date),
                "open": float(opens[idx]),
                "high": float(highs[idx]),
                "low": float(lows[idx]),
                "close": float(closes[idx]),
                "volume": int(volumes[idx]) if idx < len(volumes) else 0,
            }
        )
    return converted


def _migrate_legacy_position(key: str, position: Dict[str, Any]) -> Dict[str, Any]:
    defaults = _position_defaults(key)
    ticker, exchange = _split_key(key)
    entry = position.get("entry_price", position.get("entry"))
    legacy_state = LEGACY_STATE_MAP.get(str(position.get("state", "ACTIVE")), State.NORMAL_RUN.value)

    if position.get("mode") in {Mode.OWNED.value, Mode.WATCH.value}:
        mode = position["mode"]
    else:
        mode = Mode.OWNED.value if entry is not None else Mode.WATCH.value

    if mode == Mode.OWNED.value and legacy_state not in {State.NORMAL_RUN.value, State.SPIKE_LOCK.value}:
        legacy_state = State.NORMAL_RUN.value
    if mode == Mode.WATCH.value and legacy_state not in {State.EXITED_COOLDOWN.value, State.REENTRY_WINDOW.value}:
        legacy_state = State.EXITED_COOLDOWN.value

    migrated = {
        "identity": {
            "ticker": position.get("ticker", ticker),
            "exchange": position.get("exchange", exchange),
            "stooq_symbol": position.get("stooq_symbol"),
            "currency": position.get("currency", "USD"),
        },
        "mode": mode,
        "state": legacy_state,
        "targets": {
            "bear_total": position.get("bear_total"),
            "base_total": position.get("base_total"),
            "bull_total": position.get("bull_total"),
        },
        "execution": {
            "entry_price": entry,
            "entry_bar_date": position.get("entry_bar_date"),
            "target_weight_pct": position.get("target_weight_pct", position.get("position_pct")),
            "current_weight_pct": position.get("current_weight_pct", position.get("position_pct") or 0.0),
        },
        "thesis_kpis": position.get("thesis_kpis", {}),
        "fundamental_triggers": {
            "pending_trigger": position.get("trigger"),
            "last_trigger_bar_date": position.get("last_trigger_bar_date"),
        },
        "runtime": {
            "hwm_close": position.get("hwm", position.get("hwm_close")),
            "hwm_bar_date": position.get("hwm_bar_date"),
            "hwm_at_exit": position.get("hwm_exit", position.get("hwm_at_exit")),
            "cooldown_start_bar_date": position.get("cooldown_start_bar_date"),
            "cooldown_bars_left": position.get("cooldown_bars_left", 0),
            "spike_lock_start_bar_date": position.get("spike_lock_start"),
            "last_spike_bar_date": position.get("last_spike_date"),
            "reentry_window_start_bar_date": position.get("reentry_window_start"),
            "reentry_bars_left": position.get("reentry_bars_left", 0),
            "base_sold": bool(position.get("base_hit", False)),
            "bull_sold": bool(position.get("bull_hit", False)),
            "warn_count": int(position.get("warn_count", 0)),
            "permanent_exit": bool(position.get("permanent_exit", False)),
            "consecutive_closes_below_sma200": int(position.get("consecutive_closes_below_sma200", 0)),
            "last_processed_bar_date": position.get("last_processed_bar_date"),
            "last_action_bar_date": position.get("last_action_bar_date"),
        },
        "buffers": {
            "ohlc": _legacy_buffers_to_ohlc(position),
        },
        "computed": position.get("computed", {}),
    }

    return _deep_merge(defaults, migrated)


def migrate_legacy_blob(raw: Any) -> Dict[str, Any]:
    store = empty_store()
    if isinstance(raw, dict):
        if {"meta", "global", "positions"} <= set(raw.keys()):
            store = _deep_merge(store, raw)
            return store

        # legacy dict keyed by ticker.
        for key, position in raw.items():
            if not isinstance(position, dict):
                continue
            store["positions"][str(key)] = _migrate_legacy_position(str(key), position)
        return store

    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            ticker = item.get("ticker")
            exchange = item.get("exchange", "UNKNOWN")
            if not ticker:
                continue
            key = make_key(str(ticker), str(exchange))
            store["positions"][key] = _migrate_legacy_position(key, item)
        return store

    return store


def _normalize_position(key: str, position: Dict[str, Any], settings: Dict[str, Any]) -> Dict[str, Any]:
    merged = _deep_merge(_position_defaults(key), position)
    bars = merged["buffers"]["ohlc"]
    bars = sorted({str(item["date"]): item for item in bars}.values(), key=lambda item: str(item["date"]))
    max_bars = int(settings.get("bars_buffer_max", 260))
    merged["buffers"]["ohlc"] = bars[-max_bars:]

    mode = Mode(merged["mode"])
    state = State(merged["state"])
    entry = merged["execution"].get("entry_price")

    if mode == Mode.OWNED:
        if state not in {State.NORMAL_RUN, State.SPIKE_LOCK}:
            merged["state"] = State.NORMAL_RUN.value
        if entry is None:
            merged["mode"] = Mode.WATCH.value
            merged["state"] = State.EXITED_COOLDOWN.value
    else:
        if state not in {State.EXITED_COOLDOWN, State.REENTRY_WINDOW}:
            merged["state"] = State.EXITED_COOLDOWN.value

    return merged


def validate_store(store: Dict[str, Any]) -> None:
    if not isinstance(store, dict):
        raise ValueError("Store must be a JSON object.")
    if "positions" not in store or not isinstance(store["positions"], dict):
        raise ValueError("Store must contain positions map.")

    for key, position in store["positions"].items():
        mode = Mode(position["mode"])
        state = State(position["state"])
        entry = position["execution"].get("entry_price")
        if mode == Mode.OWNED:
            if state not in {State.NORMAL_RUN, State.SPIKE_LOCK}:
                raise ValueError(f"{key}: OWNED must be in NORMAL_RUN or SPIKE_LOCK.")
            if entry is None:
                raise ValueError(f"{key}: OWNED requires execution.entry_price.")
        if mode == Mode.WATCH and state not in {State.EXITED_COOLDOWN, State.REENTRY_WINDOW}:
            raise ValueError(f"{key}: WATCH must be in EXITED_COOLDOWN or REENTRY_WINDOW.")

        dates = [str(item["date"]) for item in position["buffers"]["ohlc"]]
        if len(dates) != len(set(dates)):
            raise ValueError(f"{key}: duplicated bar dates found.")


def _backup_path(path: Path) -> Path:
    return path.with_name(f"{path.stem}.pre_migration{path.suffix}")


def _is_postgres_target(path: str | Path) -> bool:
    normalized = str(path).strip().lower()
    return normalized.startswith("postgresql://") or normalized.startswith("postgres://")


def _load_postgres_blob(path: str | Path) -> Dict[str, Any] | None:
    from .postgres_store import load_store_blob

    return load_store_blob(str(path))


def _save_postgres_blob(path: str | Path, payload: Dict[str, Any]) -> None:
    from .postgres_store import save_store_blob

    save_store_blob(str(path), payload)


def load_positions(path: str | Path = "data/positions.json") -> Dict[str, Any]:
    postgres_target = _is_postgres_target(path)
    if postgres_target:
        raw = _load_postgres_blob(path) or {}
    else:
        file_path = Path(path)
        if not file_path.exists():
            store = empty_store()
            file_path.parent.mkdir(parents=True, exist_ok=True)
            save_positions(store, file_path)
            return store

        text = file_path.read_text(encoding="utf-8").strip()
        raw = json.loads(text) if text else {}
    migrated = migrate_legacy_blob(raw)
    migrated["global"] = _deep_merge(default_global_settings(), migrated.get("global", {}))
    migrated["meta"] = _deep_merge(
        {
            "schema_version": SCHEMA_VERSION,
            "asof_bar_date": None,
            "last_run_utc": None,
        },
        migrated.get("meta", {}),
    )
    migrated["meta"]["schema_version"] = SCHEMA_VERSION

    normalized_positions = {}
    for key, position in migrated.get("positions", {}).items():
        normalized_positions[key] = _normalize_position(key, position, migrated["global"])
    migrated["positions"] = normalized_positions

    needs_write = raw != migrated
    if needs_write:
        if postgres_target:
            _save_postgres_blob(path, migrated)
        else:
            backup = _backup_path(file_path)
            backup.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
            save_positions(migrated, file_path)

    validate_store(migrated)
    return migrated


def save_positions(store: Dict[str, Any], path: str | Path = "data/positions.json") -> None:
    if _is_postgres_target(path):
        _save_postgres_blob(path, store)
        return
    file_path = Path(path)
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(json.dumps(store, ensure_ascii=False, indent=2), encoding="utf-8")


def touch_meta(store: Dict[str, Any], asof_bar_date: str | None) -> None:
    store["meta"]["asof_bar_date"] = asof_bar_date
    store["meta"]["last_run_utc"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def iter_positions(store: Dict[str, Any]) -> Iterable[tuple[str, Dict[str, Any]]]:
    for key in sorted(store["positions"].keys()):
        yield key, store["positions"][key]


def ensure_position(
    store: Dict[str, Any],
    key: str,
    ticker: str | None = None,
    exchange: str | None = None,
    stooq_symbol: str | None = None,
    currency: str = "USD",
) -> Dict[str, Any]:
    if key not in store["positions"]:
        position = _position_defaults(key)
        if ticker:
            position["identity"]["ticker"] = ticker
        if exchange:
            position["identity"]["exchange"] = exchange
        if stooq_symbol:
            position["identity"]["stooq_symbol"] = stooq_symbol
        position["identity"]["currency"] = currency
        store["positions"][key] = position
    return store["positions"][key]
