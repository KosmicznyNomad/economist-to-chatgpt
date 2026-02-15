from __future__ import annotations

from datetime import date, timedelta
from pathlib import Path
import json

from src.engine.daily_run import run_daily, run_daily_for_ticker
from src.engine.definitions import Action, AnomalyCode, Mode, ReasonCode, State
from src.engine.indicators import compute_atr_ema, compute_sma200_slope
from src.engine.levels import compute_levels
from src.engine.state_machine import apply_state_machine
from src.marketdata.stooq import merge_bars
from src.storage.positions_store import default_global_settings, ensure_position, load_positions, make_key, save_positions


START = date(2025, 1, 1)


def _bar(offset: int, close: float, spread: float = 1.0) -> dict:
    d = (START + timedelta(days=offset)).isoformat()
    return {
        "date": d,
        "open": close - 0.1,
        "high": close + spread / 2,
        "low": close - spread / 2,
        "close": close,
        "volume": 1000,
    }


def _seed_owned(path: Path, ticker: str = "AAA", exchange: str = "NYSE", entry: float = 100.0) -> str:
    store = load_positions(path)
    key = make_key(ticker, exchange)
    position = ensure_position(
        store,
        key,
        ticker=ticker,
        exchange=exchange,
        stooq_symbol=f"{ticker.lower()}.us",
    )
    position["mode"] = "OWNED"
    position["state"] = "NORMAL_RUN"
    position["execution"]["entry_price"] = entry
    position["execution"]["entry_bar_date"] = (START - timedelta(days=1)).isoformat()
    position["execution"]["target_weight_pct"] = 4.0
    position["execution"]["current_weight_pct"] = 4.0
    position["runtime"]["hwm_close"] = entry
    position["runtime"]["hwm_bar_date"] = (START - timedelta(days=1)).isoformat()
    save_positions(store, path)
    return key


def _seed_watch_reentry(path: Path, ticker: str = "RRR") -> str:
    store = load_positions(path)
    key = make_key(ticker, "NYSE")
    position = ensure_position(
        store,
        key,
        ticker=ticker,
        exchange="NYSE",
        stooq_symbol=f"{ticker.lower()}.us",
    )
    position["mode"] = "WATCH"
    position["state"] = "REENTRY_WINDOW"
    position["execution"]["entry_price"] = None
    position["execution"]["current_weight_pct"] = 0.0
    position["execution"]["target_weight_pct"] = 4.0
    position["runtime"]["hwm_at_exit"] = 110.0
    position["runtime"]["cooldown_bars_left"] = 0
    position["runtime"]["reentry_bars_left"] = 10
    position["runtime"]["reentry_window_start_bar_date"] = (START + timedelta(days=220)).isoformat()
    save_positions(store, path)
    return key


def _seed_watch_entry(path: Path, ticker: str = "WAT") -> str:
    store = load_positions(path)
    key = make_key(ticker, "NYSE")
    position = ensure_position(
        store,
        key,
        ticker=ticker,
        exchange="NYSE",
        stooq_symbol=f"{ticker.lower()}.us",
    )
    position["mode"] = "WATCH"
    position["state"] = "EXITED_COOLDOWN"
    position["runtime"]["cooldown_bars_left"] = 0
    position["runtime"]["reentry_bars_left"] = 0
    position["runtime"]["permanent_exit"] = False
    save_positions(store, path)
    return key


def test_merge_bars_deduplicates_by_date():
    existing = [_bar(1, 10), _bar(2, 11)]
    incoming = [_bar(2, 11), _bar(3, 12)]
    merged, changed = merge_bars(existing, incoming, 260)

    assert len(merged) == 3
    assert changed == [incoming[-1]["date"]]


def test_compute_atr_ema_constant_tr():
    bars = []
    close = 10.0
    for i in range(30):
        bars.append(
            {
                "date": (START + timedelta(days=i)).isoformat(),
                "open": close,
                "high": close + 1.0,
                "low": close - 1.0,
                "close": close,
                "volume": 100,
            }
        )
    atr = compute_atr_ema(bars, 14)
    assert atr is not None
    assert abs(atr - 2.0) < 1e-9


def test_compute_sma200_slope_from_buffer():
    closes = [100.0 + i * 0.1 for i in range(260)]
    slope = compute_sma200_slope(closes, sma_window=200, lookback=20)
    assert slope == "rising"


def test_run_daily_for_ticker_new_symbol_starts_in_watch_mode(tmp_path: Path):
    path = tmp_path / "positions.json"

    run_daily_for_ticker("NEW", _bar(1, 25.0), positions_path=path)
    store = load_positions(path)
    key = make_key("NEW", "UNKNOWN")

    assert key in store["positions"]
    assert store["positions"][key]["mode"] == "WATCH"
    assert store["positions"][key]["state"] == "EXITED_COOLDOWN"
    assert store["positions"][key]["execution"]["entry_price"] is None


def test_idempotent_no_duplicate_action_same_bar(tmp_path: Path):
    path = tmp_path / "positions.json"
    _seed_owned(path)

    for i in range(240):
        run_daily_for_ticker("AAA", _bar(i, 100 + i * 0.05), positions_path=path)

    first = run_daily_for_ticker("AAA", _bar(241, 125.0, spread=0.5), positions_path=path)
    second = run_daily_for_ticker("AAA", _bar(241, 125.0, spread=0.5), positions_path=path)

    assert first.action.type in {Action.SELL_PARTIAL, Action.HOLD}
    assert second.reason.code == ReasonCode.NO_NEW_BAR


def test_stop_exit_transitions_to_watch_cooldown(tmp_path: Path):
    path = tmp_path / "positions.json"
    _seed_owned(path, ticker="BBB", entry=100.0)

    for i in range(260):
        run_daily_for_ticker("BBB", _bar(i, 100 + i * 0.2), positions_path=path)

    decision = run_daily_for_ticker("BBB", _bar(261, 40.0, spread=3.0), positions_path=path)
    assert decision.action.type == Action.SELL_ALL
    assert decision.state_after == State.EXITED_COOLDOWN

    store = load_positions(path)
    key = make_key("BBB", "NYSE")
    assert store["positions"][key]["mode"] == "WATCH"


def test_spike_partial_only_on_entry_to_spike_lock(tmp_path: Path):
    path = tmp_path / "positions.json"
    _seed_owned(path, ticker="SPI", entry=50.0)

    for i in range(260):
        run_daily_for_ticker("SPI", _bar(i, 50 + i * 0.03, spread=0.4), positions_path=path)

    first = run_daily_for_ticker("SPI", _bar(261, 70.0, spread=0.4), positions_path=path)
    second = run_daily_for_ticker("SPI", _bar(262, 75.0, spread=0.4), positions_path=path)

    assert first.action.type == Action.SELL_PARTIAL
    assert first.state_after == State.SPIKE_LOCK
    assert second.action.type != Action.SELL_PARTIAL


def test_warn_and_falsifier_flow(tmp_path: Path):
    path = tmp_path / "positions.json"
    key = _seed_owned(path, ticker="WRN", entry=80.0)

    for i in range(230):
        run_daily_for_ticker("WRN", _bar(i, 80 + i * 0.1), positions_path=path)

    store = load_positions(path)
    store["positions"][key]["fundamental_triggers"]["pending_trigger"] = "warn"
    save_positions(store, path)
    warn1 = run_daily_for_ticker("WRN", _bar(231, 104.0), positions_path=path)
    assert warn1.action.type == Action.SELL_PARTIAL

    store = load_positions(path)
    store["positions"][key]["fundamental_triggers"]["pending_trigger"] = "warn"
    save_positions(store, path)
    warn2 = run_daily_for_ticker("WRN", _bar(232, 105.0), positions_path=path)
    assert warn2.action.type == Action.SELL_ALL

    key2 = _seed_owned(path, ticker="FAL", entry=60.0)
    for i in range(240):
        run_daily_for_ticker("FAL", _bar(i, 60 + i * 0.05), positions_path=path)

    store = load_positions(path)
    store["positions"][key2]["fundamental_triggers"]["pending_trigger"] = "falsifier"
    save_positions(store, path)
    fal = run_daily_for_ticker("FAL", _bar(241, 72.0), positions_path=path)
    assert fal.action.type == Action.SELL_ALL

    store = load_positions(path)
    assert store["positions"][key2]["runtime"]["permanent_exit"] is True


def test_reentry_trigger_buys_back_to_owned(tmp_path: Path):
    path = tmp_path / "positions.json"
    _seed_watch_reentry(path)
    store = load_positions(path)
    store["global"]["entry_mvp_enabled"] = False
    save_positions(store, path)

    # History to build SMA200 rising trend.
    for i in range(260):
        run_daily_for_ticker("RRR", _bar(i, 60 + i * 0.2, spread=0.8), positions_path=path)

    store = load_positions(path)
    key = make_key("RRR", "NYSE")
    position = store["positions"][key]
    position["mode"] = "WATCH"
    position["state"] = "REENTRY_WINDOW"
    position["runtime"]["hwm_at_exit"] = 108.0
    position["runtime"]["reentry_bars_left"] = 10
    position["runtime"]["cooldown_bars_left"] = 0
    save_positions(store, path)

    # Close above yesterday high and within pullback band.
    run_daily_for_ticker("RRR", _bar(261, 102.5, spread=0.2), positions_path=path)
    decision = run_daily_for_ticker("RRR", _bar(262, 103.2, spread=0.2), positions_path=path)

    assert decision.action.type == Action.BUY_REENTER
    assert decision.state_after == State.NORMAL_RUN


def test_watch_entry_reports_no_buy_trend(tmp_path: Path):
    path = tmp_path / "positions.json"
    key = _seed_watch_entry(path, ticker="NTD")
    store = load_positions(path)
    position = store["positions"][key]
    settings = store["global"]
    bar = _bar(300, 90.0, spread=0.2)

    decision = apply_state_machine(
        key=key,
        position=position,
        bar=bar,
        bars_up_to_date=[bar],
        indicators={
            "price_close": 90.0,
            "atr_d": 2.0,
            "sma200": 100.0,
            "z20": -2.0,
            "prev_high": 89.0,
            "trend_up": False,
            "overheated": False,
            "setup_oversold": True,
            "reversal": True,
        },
        levels={"entry_ref_price": 90.0, "stop_loss_price": 84.0},
        settings=settings,
    )

    assert decision.action.type == Action.WAIT
    assert decision.reason.code == ReasonCode.ENTRY_NO_BUY_TREND
    assert decision.state_after == State.EXITED_COOLDOWN


def test_watch_entry_reports_no_buy_overheat(tmp_path: Path):
    path = tmp_path / "positions.json"
    key = _seed_watch_entry(path, ticker="OVH")
    store = load_positions(path)
    position = store["positions"][key]
    settings = store["global"]
    bar = _bar(300, 120.0, spread=0.2)

    decision = apply_state_machine(
        key=key,
        position=position,
        bar=bar,
        bars_up_to_date=[bar],
        indicators={
            "price_close": 120.0,
            "atr_d": 3.0,
            "sma200": 100.0,
            "z20": -1.6,
            "prev_high": 119.0,
            "trend_up": True,
            "overheated": True,
            "setup_oversold": True,
            "reversal": True,
        },
        levels={"entry_ref_price": 120.0, "stop_loss_price": 111.0},
        settings=settings,
    )

    assert decision.action.type == Action.WAIT
    assert decision.reason.code == ReasonCode.ENTRY_NO_BUY_OVERHEAT
    assert decision.state_after == State.EXITED_COOLDOWN


def test_watch_entry_reports_setup_waiting_for_reversal(tmp_path: Path):
    path = tmp_path / "positions.json"
    key = _seed_watch_entry(path, ticker="STP")
    store = load_positions(path)
    position = store["positions"][key]
    settings = store["global"]
    bar = _bar(300, 105.0, spread=0.2)

    decision = apply_state_machine(
        key=key,
        position=position,
        bar=bar,
        bars_up_to_date=[bar],
        indicators={
            "price_close": 105.0,
            "atr_d": 2.0,
            "sma200": 95.0,
            "z20": -1.8,
            "prev_high": 106.0,
            "trend_up": True,
            "overheated": False,
            "setup_oversold": True,
            "reversal": False,
        },
        levels={"entry_ref_price": 105.0, "stop_loss_price": 99.0},
        settings=settings,
    )

    assert decision.action.type == Action.WAIT
    assert decision.reason.code == ReasonCode.ENTRY_SETUP
    assert decision.state_after == State.EXITED_COOLDOWN


def test_watch_entry_emits_buy_alert_with_stop_loss(tmp_path: Path):
    path = tmp_path / "positions.json"
    key = _seed_watch_entry(path, ticker="BUY")
    store = load_positions(path)
    position = store["positions"][key]
    settings = store["global"]
    bar = _bar(300, 110.0, spread=0.2)

    decision = apply_state_machine(
        key=key,
        position=position,
        bar=bar,
        bars_up_to_date=[bar],
        indicators={
            "price_close": 110.0,
            "atr_d": 2.0,
            "sma200": 95.0,
            "z20": -2.1,
            "prev_high": 109.5,
            "trend_up": True,
            "overheated": False,
            "setup_oversold": True,
            "reversal": True,
        },
        levels={
            "entry_ref_price": 110.0,
            "stop_loss_price": 104.0,
            "stop_distance_for_size": 4.0,
            "time_stop_days": 7,
        },
        settings=settings,
    )

    assert decision.action.type == Action.BUY_ALERT
    assert decision.reason.code == ReasonCode.BUY_TRIGGER
    assert decision.mode == Mode.WATCH
    assert decision.state_after == State.EXITED_COOLDOWN
    assert decision.levels["stop_loss_price"] == 104.0


def test_run_daily_uses_fetcher_and_returns_message(tmp_path: Path):
    path = tmp_path / "positions.json"
    _seed_owned(path, ticker="RUN", entry=30.0)

    bars = [_bar(1, 30.0), _bar(2, 30.5), _bar(3, 31.0)]

    def fake_fetcher(symbol: str, n_days: int):
        assert symbol == "run.us"
        return bars[-n_days:]

    result = run_daily(path, fetcher=fake_fetcher, send_telegram=False)
    assert result.decisions
    assert "POSITION STATE MACHINE" in result.telegram_message or "PSM" in result.telegram_message


def test_run_daily_emits_anomaly_events_without_changing_state_machine_actions(tmp_path: Path):
    path = tmp_path / "positions.json"
    store = load_positions(path)
    key = make_key("ANO", "NYSE")
    position = ensure_position(
        store,
        key,
        ticker="ANO",
        exchange="NYSE",
        stooq_symbol="ano.us",
    )
    position["mode"] = "WATCH"
    position["state"] = "EXITED_COOLDOWN"
    position["runtime"]["cooldown_bars_left"] = 0
    save_positions(store, path)

    bars = []
    for i in range(60):
        close = 100.0 if i < 50 else 100.0 - (i - 49) * 1.2
        bars.append(_bar(i, close, spread=0.3))

    def fake_fetcher(symbol: str, n_days: int):
        assert symbol == "ano.us"
        return bars

    result = run_daily(path, fetcher=fake_fetcher, send_telegram=False)

    assert len(result.anomaly_events) == 1
    assert result.anomaly_events[0].code == AnomalyCode.EXTREME_DRAWDOWN
    assert result.summary["anomaly_count_total"] == 1
    assert result.summary["anomaly_count_high"] == 1
    assert result.summary["anomaly_count_info"] == 0

    decision = result.decisions[0]
    assert decision.mode == Mode.WATCH
    assert decision.action.type == Action.WAIT
    assert decision.state_after == State.EXITED_COOLDOWN


def test_run_daily_prefers_quotes_batch_feed_when_no_custom_fetcher(tmp_path: Path, monkeypatch):
    path = tmp_path / "positions.json"
    _seed_owned(path, ticker="QQQ", entry=30.0)
    for i in range(260):
        run_daily_for_ticker("QQQ", _bar(i, 30.0 + i * 0.05), positions_path=path)

    calls = {"quotes": 0, "history": 0, "history_symbols": []}
    quote_bar = _bar(261, 45.0)

    def fake_quotes(symbols, batch_size=8, http_get=None):
        calls["quotes"] += 1
        assert "qqq.us" in symbols
        return {"qqq.us": [quote_bar]}, []

    def fake_history(symbol: str, n_days: int, http_get=None):
        calls["history"] += 1
        calls["history_symbols"].append(symbol)
        if symbol == "^vix":
            return [_bar(261, 24.0)]
        return []

    monkeypatch.setattr("src.engine.daily_run.fetch_latest_quotes_batched", fake_quotes)
    monkeypatch.setattr("src.engine.daily_run.fetch_last_days", fake_history)

    result = run_daily(path, send_telegram=False)

    assert calls["quotes"] == 1
    assert calls["history"] == 1
    assert calls["history_symbols"] == ["^vix"]
    assert result.decisions[0].bar_date == quote_bar["date"]


def test_run_daily_can_recover_symbol_from_exchange_candidates(tmp_path: Path, monkeypatch):
    path = tmp_path / "positions.json"
    _seed_owned(path, ticker="IFX", exchange="ETR", entry=30.0)
    store = load_positions(path)
    key = make_key("IFX", "ETR")
    store["positions"][key]["identity"]["stooq_symbol"] = "ifx.us"
    save_positions(store, path)

    calls = {"quotes": 0}
    quote_bar = _bar(261, 45.0)

    def fake_quotes(symbols, batch_size=8, http_get=None):
        calls["quotes"] += 1
        assert "ifx.us" in symbols
        assert "ifx.de" in symbols
        return {"ifx.de": [quote_bar], "ifx.us": []}, []

    def fake_history(symbol: str, n_days: int, http_get=None):
        if symbol == "^vix":
            return [_bar(261, 24.0)]
        return []

    monkeypatch.setattr("src.engine.daily_run.fetch_latest_quotes_batched", fake_quotes)
    monkeypatch.setattr("src.engine.daily_run.fetch_last_days", fake_history)

    result = run_daily(path, send_telegram=False)
    assert calls["quotes"] == 1
    assert result.decisions[0].bar_date == quote_bar["date"]

    post_store = load_positions(path)
    assert post_store["positions"][key]["identity"]["stooq_symbol"] == "ifx.de"


def test_spike_lock_absorbed_can_return_to_normal_before_timeout(tmp_path: Path):
    path = tmp_path / "positions.json"
    key = _seed_owned(path, ticker="ABS", entry=100.0)
    store = load_positions(path)
    position = store["positions"][key]
    position["state"] = "SPIKE_LOCK"
    position["runtime"]["spike_lock_start_bar_date"] = (START + timedelta(days=255)).isoformat()
    position["runtime"]["last_spike_bar_date"] = (START + timedelta(days=255)).isoformat()
    settings = store["global"]

    bars = [_bar(256, 118.0), _bar(257, 119.0), _bar(258, 120.0)]
    decision = apply_state_machine(
        key=key,
        position=position,
        bar=bars[-1],
        bars_up_to_date=bars,
        indicators={
            "price_close": 120.0,
            "sma200": 110.0,
            "trend_up": True,
        },
        levels={
            "effective_stop": None,
            "five_d_move": 1.0,
            "spike_threshold": 3.0,
        },
        settings=settings,
    )

    assert decision.reason.code == ReasonCode.SPIKE_ABSORBED
    assert decision.state_after == State.NORMAL_RUN


def test_spike_lock_timeout_forces_return_to_normal_run(tmp_path: Path):
    path = tmp_path / "positions.json"
    key = _seed_owned(path, ticker="TOU", entry=100.0)
    store = load_positions(path)
    position = store["positions"][key]
    position["state"] = "SPIKE_LOCK"
    position["runtime"]["spike_lock_start_bar_date"] = (START + timedelta(days=245)).isoformat()
    position["runtime"]["last_spike_bar_date"] = (START + timedelta(days=245)).isoformat()
    settings = store["global"]

    bars = [_bar(i, 120.0 + (i - 246) * 0.5) for i in range(246, 260)]
    decision = apply_state_machine(
        key=key,
        position=position,
        bar=bars[-1],
        bars_up_to_date=bars,
        indicators={
            "price_close": float(bars[-1]["close"]),
            "sma200": 110.0,
            "trend_up": True,
        },
        levels={
            "effective_stop": None,
            "five_d_move": 8.0,
            "spike_threshold": 3.0,
        },
        settings=settings,
    )

    assert decision.reason.code == ReasonCode.SPIKE_LOCK_TIMEOUT
    assert decision.state_after == State.NORMAL_RUN


def test_trend_break_uses_buffer_to_avoid_micro_breaches(tmp_path: Path):
    path = tmp_path / "positions.json"
    _seed_owned(path, ticker="BUF", entry=100.0)
    for i in range(260):
        run_daily_for_ticker("BUF", _bar(i, 100.0, spread=0.4), positions_path=path)

    first = run_daily_for_ticker("BUF", _bar(261, 99.7, spread=0.4), positions_path=path)
    second = run_daily_for_ticker("BUF", _bar(262, 99.7, spread=0.4), positions_path=path)
    assert first.reason.code != ReasonCode.TREND_BREAK
    assert second.reason.code != ReasonCode.TREND_BREAK

    run_daily_for_ticker("BUF", _bar(263, 99.4, spread=0.4), positions_path=path)
    breached = run_daily_for_ticker("BUF", _bar(264, 99.4, spread=0.4), positions_path=path)
    assert breached.reason.code == ReasonCode.TREND_BREAK
    assert breached.action.type == Action.SELL_ALL


def test_compute_levels_applies_vix_multiplier_and_bear_floor():
    settings = default_global_settings()
    position = {
        "mode": "OWNED",
        "state": "NORMAL_RUN",
        "runtime": {
            "hwm_close": 140.0,
            "warn_count": 0,
            "hwm_at_exit": None,
        },
        "execution": {
            "entry_price": 100.0,
        },
        "targets": {
            "bear_total": 90.0,
            "base_total": 160.0,
            "bull_total": 220.0,
        },
    }
    indicators = {
        "price_close": 130.0,
        "atr_d": 4.5,
        "atr_w": 10.0,
        "five_d_move": 28.0,
        "sma50": 120.0,
        "sma200": 110.0,
        "sma200_slope": "rising",
        "trend_up": True,
    }

    levels = compute_levels(
        position=position,
        indicators=indicators,
        settings=settings,
        market_context={"vix_close": 31.0},
    )

    assert levels["regime_mult"] == 1.30
    assert levels["spike_threshold"] == 32.5
    assert levels["catastrophe_floor"] == 81.0
    assert levels["effective_stop"] >= 81.0
    assert levels["priced_in_pct"] is not None
    assert levels["gap_to_base_pct"] is not None


def test_legacy_migration_creates_meta_global_positions_and_backup(tmp_path: Path):
    path = tmp_path / "positions.json"
    legacy = {
        "AAA": {
            "state": "ACTIVE",
            "entry": 10.0,
            "hwm": 12.0,
            "base_total": 20.0,
            "bull_total": 30.0,
            "buffers": {
                "date": ["2026-01-01"],
                "open": [10.0],
                "high": [11.0],
                "low": [9.0],
                "close": [10.5],
                "volume": [1000],
            },
        }
    }
    path.write_text(json.dumps(legacy), encoding="utf-8")

    store = load_positions(path)
    assert "meta" in store
    assert "global" in store
    assert "positions" in store
    assert "AAA" in store["positions"]
    backup = path.with_name("positions.pre_migration.json")
    assert backup.exists()
