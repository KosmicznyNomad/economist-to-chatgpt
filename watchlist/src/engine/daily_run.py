from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List

from src.engine.definitions import (
    Action,
    ActionPayload,
    AnomalyCode,
    AnomalyEvent,
    AnomalySeverity,
    DailyRunResult,
    DecisionOfDay,
    Mode,
    ReasonCode,
    ReasonPayload,
    State,
)
from src.engine.anomalies import compute_anomaly_event, compute_anomaly_snapshot
from src.engine.indicators import compute_indicator_snapshot
from src.engine.levels import compute_levels
from src.engine.state_machine import apply_state_machine
from src.marketdata.symbols import build_stooq_symbol_candidates, default_stooq_symbol
from src.marketdata.stooq import detect_corp_action_suspected, fetch_last_days, fetch_latest_quotes_batched, merge_bars
from src.notify.telegram import (
    format_telegram_message,
    format_telegram_messages,
    is_actionable,
    send_telegram_message,
    summarize_positions,
)
from src.storage.positions_store import ensure_position, iter_positions, load_positions, make_key, save_positions, touch_meta


BarFetcher = Callable[[str, int], List[Dict[str, Any]]]


@dataclass
class TickerRunContext:
    key: str
    position: Dict[str, Any]
    merged_bars: List[Dict[str, Any]]
    new_dates: List[str]


def _normalize_bar(raw: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "date": str(raw["date"]),
        "open": float(raw["open"]),
        "high": float(raw["high"]),
        "low": float(raw["low"]),
        "close": float(raw["close"]),
        "volume": int(raw.get("volume", 0)),
    }


def _normalize_symbol(raw: Any) -> str:
    return str(raw or "").strip().lower()


def _normalize_external_bars(candle_or_bars: Dict[str, Any] | Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if isinstance(candle_or_bars, dict):
        return [_normalize_bar(candle_or_bars)]
    return [_normalize_bar(item) for item in list(candle_or_bars)]


def _build_no_new_bar_decision(
    key: str,
    position: Dict[str, Any],
    reason_code: ReasonCode,
    reason_text: str,
) -> DecisionOfDay:
    mode = Mode(position["mode"])
    state = State(position["state"])
    action = Action.HOLD if mode == Mode.OWNED else Action.WAIT
    return DecisionOfDay(
        bar_date=position["runtime"].get("last_processed_bar_date") or "",
        key=key,
        symbol={
            "ticker": position["identity"].get("ticker"),
            "exchange": position["identity"].get("exchange"),
            "currency": position["identity"].get("currency"),
        },
        mode=mode,
        state_before=state,
        state_after=state,
        action=ActionPayload(type=action),
        reason=ReasonPayload(code=reason_code, text=reason_text),
        levels=position.get("computed", {}).copy(),
        targets=position.get("targets", {}).copy(),
        kpi=position.get("thesis_kpis", {}).copy(),
        transitions={"triggered": False, "trigger": None},
    )


def _process_position(
    context: TickerRunContext,
    settings: Dict[str, Any],
    market_context: Dict[str, Any] | None = None,
) -> tuple[DecisionOfDay, AnomalyEvent | None]:
    if not context.new_dates:
        return (
            _build_no_new_bar_decision(
                key=context.key,
                position=context.position,
                reason_code=ReasonCode.NO_NEW_BAR,
                reason_text="No new market bar since last processed date.",
            ),
            None,
        )

    latest_decision: DecisionOfDay | None = None
    latest_anomaly: AnomalyEvent | None = None
    for bar_date in sorted(context.new_dates):
        bars_up_to_date = [item for item in context.merged_bars if item["date"] <= bar_date]
        if not bars_up_to_date:
            continue

        indicators = compute_indicator_snapshot(bars_up_to_date, settings)
        if not indicators:
            continue

        levels = compute_levels(context.position, indicators, settings, market_context=market_context)
        anomaly_snapshot = compute_anomaly_snapshot(
            bars_up_to_date=bars_up_to_date,
            indicators=indicators,
            settings=settings,
        )
        anomaly_event = compute_anomaly_event(
            key=context.key,
            position=context.position,
            bars_up_to_date=bars_up_to_date,
            indicators=indicators,
            settings=settings,
        )
        latest_decision = apply_state_machine(
            key=context.key,
            position=context.position,
            bar=bars_up_to_date[-1],
            bars_up_to_date=bars_up_to_date,
            indicators=indicators,
            levels=levels,
            settings=settings,
        )
        latest_anomaly = anomaly_event
        context.position["computed"].update(
            {
                "roc_5_norm": anomaly_snapshot.get("roc_5_norm"),
                "roc_20_norm": anomaly_snapshot.get("roc_20_norm"),
                "drawdown_in_atr": anomaly_snapshot.get("drawdown_in_atr"),
                "sma50_slope_10d": anomaly_snapshot.get("sma50_slope_10d"),
                "atr_pct": anomaly_snapshot.get("atr_pct"),
                "anomaly_code_last": anomaly_event.code.value if anomaly_event is not None else None,
                "anomaly_severity_last": anomaly_event.severity.value if anomaly_event is not None else None,
            }
        )

    if latest_decision is None:
        return (
            _build_no_new_bar_decision(
                key=context.key,
                position=context.position,
                reason_code=ReasonCode.NO_NEW_BAR,
                reason_text="No processable bars after merge.",
            ),
            None,
        )
    return latest_decision, latest_anomaly


def _resolve_new_dates(position: Dict[str, Any], changed_dates: List[str]) -> List[str]:
    last_processed = position["runtime"].get("last_processed_bar_date")
    if not last_processed:
        return sorted(changed_dates)
    return sorted([value for value in changed_dates if value > str(last_processed)])


def _resolve_vix_close(
    settings: Dict[str, Any],
    use_quote_feed: bool,
) -> float | None:
    if not use_quote_feed:
        return None

    vix_symbol = _normalize_symbol(settings.get("vix_symbol"))
    if not vix_symbol:
        return None

    try:
        rows = fetch_last_days(vix_symbol, 1)
    except Exception:
        return None
    if not rows:
        return None

    try:
        return float(rows[-1]["close"])
    except (TypeError, ValueError, KeyError):
        return None


def run_daily(
    positions_path: str | Path = "data/positions.json",
    fetcher: BarFetcher | None = None,
    send_telegram: bool = True,
    telegram_sender: Callable[[str], None] | None = None,
) -> DailyRunResult:
    store = load_positions(positions_path)
    settings = store["global"]
    bars_limit = int(settings["bars_buffer_max"])
    fetch_days = int(settings["stooq_fetch_days"])
    seed_days = max(int(settings.get("stooq_seed_days", max(400, bars_limit + 140))), fetch_days, bars_limit)
    fallback_days = max(int(settings.get("stooq_fallback_days", max(400, bars_limit + 140))), fetch_days, bars_limit)
    use_quote_feed = fetcher is None

    quote_bars_by_symbol: Dict[str, List[Dict[str, Any]]] = {}
    quote_failed_symbols: set[str] = set()
    symbol_candidates_by_key: Dict[str, List[str]] = {}
    vix_close = _resolve_vix_close(settings=settings, use_quote_feed=use_quote_feed)
    if use_quote_feed:
        quote_batch_size = max(1, int(settings.get("stooq_quotes_batch_size", 8)))
        symbols: List[str] = []
        for key, position in iter_positions(store):
            identity = position.get("identity", {})
            candidates = build_stooq_symbol_candidates(
                ticker=identity.get("ticker"),
                exchange=identity.get("exchange"),
                current_symbol=identity.get("stooq_symbol"),
            )
            symbol_candidates_by_key[key] = candidates
            symbols.extend(candidates)
        quote_bars_by_symbol, failed_symbols = fetch_latest_quotes_batched(symbols, batch_size=quote_batch_size)
        quote_failed_symbols = set(failed_symbols)

    decisions: List[DecisionOfDay] = []
    anomaly_events: List[AnomalyEvent] = []
    latest_bar_date = store["meta"].get("asof_bar_date")
    market_context = {"vix_close": vix_close}

    for key, position in iter_positions(store):
        identity = position.get("identity", {})
        candidate_symbols = symbol_candidates_by_key.get(key, [])
        if not candidate_symbols:
            candidate_symbols = build_stooq_symbol_candidates(
                ticker=identity.get("ticker"),
                exchange=identity.get("exchange"),
                current_symbol=identity.get("stooq_symbol"),
            )

        symbol = candidate_symbols[0] if candidate_symbols else _normalize_symbol(identity.get("stooq_symbol"))
        incoming: List[Dict[str, Any]] = []
        fetch_failed = False
        data_suspected = False

        if use_quote_feed:
            resolved_from_quotes = None
            for candidate_symbol in candidate_symbols:
                if quote_bars_by_symbol.get(candidate_symbol):
                    resolved_from_quotes = candidate_symbol
                    break
            if resolved_from_quotes is not None:
                symbol = resolved_from_quotes
                incoming = quote_bars_by_symbol.get(symbol, [])
                if _normalize_symbol(identity.get("stooq_symbol")) != symbol:
                    identity["stooq_symbol"] = symbol

            if not symbol:
                fetch_failed = True
            else:
                if symbol in quote_failed_symbols:
                    try:
                        incoming = fetch_last_days(symbol, fetch_days)
                    except Exception:
                        fetch_failed = True

                if not position["buffers"].get("ohlc"):
                    try:
                        seed_history = fetch_last_days(symbol, seed_days)
                        if incoming:
                            seeded, _ = merge_bars(seed_history, incoming, max(seed_days, bars_limit))
                            incoming = seeded
                        else:
                            incoming = seed_history
                    except Exception:
                        if not incoming:
                            fetch_failed = True
        else:
            if symbol:
                try:
                    incoming = fetcher(symbol, fetch_days) if fetcher is not None else []
                except Exception:
                    fetch_failed = True
            else:
                fetch_failed = True

        merged, changed_dates = merge_bars(
            existing=position["buffers"].get("ohlc", []),
            incoming=incoming,
            max_bars=bars_limit,
        )

        if merged and detect_corp_action_suspected(merged):
            data_suspected = True
            if symbol:
                try:
                    if use_quote_feed:
                        long_history = fetch_last_days(symbol, fallback_days)
                    else:
                        long_history = fetcher(symbol, fallback_days) if fetcher is not None else []
                    rebuilt, rebuilt_changes = merge_bars([], long_history, bars_limit)
                    if rebuilt:
                        merged = rebuilt
                        changed_dates = rebuilt_changes
                except Exception:
                    fetch_failed = True

        position["buffers"]["ohlc"] = merged
        new_dates = _resolve_new_dates(position, changed_dates)

        if not new_dates:
            if fetch_failed:
                decision = _build_no_new_bar_decision(
                    key=key,
                    position=position,
                    reason_code=ReasonCode.DATA_FETCH_ERROR,
                    reason_text="Failed to fetch market data.",
                )
            elif data_suspected:
                decision = _build_no_new_bar_decision(
                    key=key,
                    position=position,
                    reason_code=ReasonCode.DATA_SUSPECTED,
                    reason_text="Corporate action suspected; rebuilt history with no new bar to process.",
                )
            else:
                decision = _build_no_new_bar_decision(
                    key=key,
                    position=position,
                    reason_code=ReasonCode.NO_NEW_BAR,
                    reason_text="No new market bar since last processed date.",
                )
        else:
            decision, anomaly_event = _process_position(
                context=TickerRunContext(
                    key=key,
                    position=position,
                    merged_bars=merged,
                    new_dates=new_dates,
                ),
                settings=settings,
                market_context=market_context,
            )
            if anomaly_event is not None:
                anomaly_events.append(anomaly_event)

        decisions.append(decision)
        if decision.bar_date and (latest_bar_date is None or decision.bar_date > latest_bar_date):
            latest_bar_date = decision.bar_date

    touch_meta(store, latest_bar_date)
    save_positions(store, positions_path)

    message = format_telegram_message(
        latest_bar_date,
        decisions,
        store["positions"],
        anomaly_events=anomaly_events,
        research_rows=store.get("research_rows"),
    )
    per_stock_messages = format_telegram_messages(
        latest_bar_date,
        decisions,
        store["positions"],
        anomaly_events=anomaly_events,
        research_rows=store.get("research_rows"),
    )
    telegram_sent = False
    if send_telegram:
        telegram_sent = True
        for payload in per_stock_messages:
            if not send_telegram_message(payload, sender=telegram_sender):
                telegram_sent = False
                break

    summary = summarize_positions(store["positions"])
    summary["total_positions"] = len(store["positions"])
    summary["actionable_count"] = len([item for item in decisions if is_actionable(item)])
    summary["anomaly_count_total"] = len(anomaly_events)
    summary["anomaly_count_high"] = len(
        [item for item in anomaly_events if item.severity == AnomalySeverity.HIGH]
    )
    summary["anomaly_count_info"] = len(
        [item for item in anomaly_events if item.severity == AnomalySeverity.INFO]
    )
    summary["anomaly_count_multiday_drop"] = len(
        [item for item in anomaly_events if item.code == AnomalyCode.MULTIDAY_DROP]
    )
    summary["anomaly_count_std_pullback"] = len(
        [item for item in anomaly_events if item.code == AnomalyCode.STD_PULLBACK]
    )
    summary["telegram_sent"] = telegram_sent

    return DailyRunResult(
        bar_date=latest_bar_date,
        decisions=decisions,
        telegram_message=message,
        telegram_messages=per_stock_messages,
        summary=summary,
        anomaly_events=anomaly_events,
    )


def _find_or_create_key(store: Dict[str, Any], ticker: str) -> str:
    for key, position in store["positions"].items():
        if str(position.get("identity", {}).get("ticker", "")).upper() == ticker.upper():
            return key
    key = make_key(ticker.upper(), "UNKNOWN")
    position = ensure_position(
        store=store,
        key=key,
        ticker=ticker.upper(),
        exchange="UNKNOWN",
        stooq_symbol=default_stooq_symbol(ticker, "UNKNOWN"),
        currency="USD",
    )
    # New symbols always start from WATCH baseline.
    position["mode"] = Mode.WATCH.value
    position["state"] = State.EXITED_COOLDOWN.value
    position["execution"]["entry_price"] = None
    position["execution"]["entry_bar_date"] = None
    position["execution"]["current_weight_pct"] = 0.0
    position["runtime"]["permanent_exit"] = False
    return key


def run_daily_for_ticker(
    ticker: str,
    candle_or_bars: Dict[str, Any] | Iterable[Dict[str, Any]],
    positions_path: str | Path = "data/positions.json",
) -> DecisionOfDay:
    store = load_positions(positions_path)
    settings = store["global"]
    bars_limit = int(settings["bars_buffer_max"])

    key = _find_or_create_key(store, ticker)
    position = store["positions"][key]
    incoming = _normalize_external_bars(candle_or_bars)
    merged, changed_dates = merge_bars(
        existing=position["buffers"].get("ohlc", []),
        incoming=incoming,
        max_bars=bars_limit,
    )
    position["buffers"]["ohlc"] = merged
    new_dates = _resolve_new_dates(position, changed_dates)

    decision, _ = _process_position(
        context=TickerRunContext(
            key=key,
            position=position,
            merged_bars=merged,
            new_dates=new_dates,
        ),
        settings=settings,
    )

    touch_meta(store, decision.bar_date or store["meta"].get("asof_bar_date"))
    save_positions(store, positions_path)
    return decision
