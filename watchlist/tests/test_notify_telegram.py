from __future__ import annotations

from src.engine.definitions import (
    Action,
    ActionPayload,
    AnomalyCode,
    AnomalyEvent,
    AnomalySeverity,
    DecisionOfDay,
    Mode,
    ReasonCode,
    ReasonPayload,
    State,
)
from src.notify.telegram import format_telegram_message, format_telegram_messages


def _decision(
    *,
    action: Action,
    reason: ReasonCode,
    before: State,
    after: State,
    key: str = "AAA:NYSE",
    ticker: str = "AAA",
    exchange: str = "NYSE",
    currency: str = "USD",
    sell_pct: float | None = None,
    buy_pct_of_target: float | None = None,
    price_hint: float | None = None,
    levels: dict | None = None,
) -> DecisionOfDay:
    return DecisionOfDay(
        bar_date="2026-02-13",
        key=key,
        symbol={"ticker": ticker, "exchange": exchange, "currency": currency},
        mode=Mode.OWNED,
        state_before=before,
        state_after=after,
        action=ActionPayload(
            type=action,
            sell_pct=sell_pct,
            buy_pct_of_target=buy_pct_of_target,
            price_hint=price_hint,
        ),
        reason=ReasonPayload(code=reason, text=reason.value),
        levels=levels or {},
        targets={},
    )


def _research_rows_for_aaa() -> list[dict]:
    return [
        {
            "identity_guess": {"ticker": "AAA", "exchange": "NYSE", "parse_status": "resolved"},
            "fields": {
                "data_decyzji": "2026-02-14",
                "status_decyzji": "ACTIVE",
                "ocena_jakosciowa": "A-",
                "zrodlo_tezy": "podcast",
                "sektor": "Technology",
                "region": "US",
                "waluta": "USD",
                "teza_inwestycyjna": "Wysoka marza i rosnacy udzial rynku.",
                "voi_falsy_kluczowe_ryzyka": "Spadek marzy brutto przez 2 kwartaly.",
                "why_buy": "Silny trend przy korektach o niskim wolumenie.",
                "why_avoid": "Ryzyko guidance cut.",
            },
        }
    ]


def _research_rows_mixed_for_aaa() -> list[dict]:
    return [
        {
            "identity_guess": {"ticker": "AAA", "exchange": "NYSE", "parse_status": "resolved"},
            "fields": {
                "data_decyzji": "2025-11-01",
                "status_decyzji": "LEGACY",
                "why_buy": "Legacy thesis.",
            },
        },
        {
            "identity_guess": {"ticker": "AAA", "exchange": "NYSE", "parse_status": "resolved"},
            "fields": {
                "data_decyzji": "2026-01-15",
                "status_decyzji": "ACTIVE",
                "why_buy": "Nowa metodologia.",
            },
        },
    ]


def _research_rows_for_rhm_with_unresolved() -> list[dict]:
    return [
        {
            "identity_guess": {"ticker": "RHM", "exchange": "ETR", "parse_status": "resolved"},
            "fields": {
                "data_decyzji": "2026-01-12",
                "spolka": "Rheinmetall AG (RHM:ETR)",
                "zrodlo_tezy": "podcast",
                "teza_inwestycyjna": "Rosnacy popyt na segment obronny.",
                "watpliwosci_ryzyka": "Ryzyko budzetowe w cyklu politycznym.",
            },
        },
        {
            "identity_guess": {"ticker": None, "exchange": None, "parse_status": "unresolved_symbol"},
            "fields": {
                "data_decyzji": "2026-02-10",
                "spolka": "Rheinmetall AG",
                "zrodlo_tezy": "raport",
                "teza_inwestycyjna": "Efekt skali i backlog zamowien.",
                "watpliwosci_ryzyka": "Ryzyko opoznien realizacji kontraktow.",
            },
        },
    ]


def test_format_telegram_message_actionable_is_natural():
    msg = format_telegram_message(
        "2026-02-13",
        [
            _decision(
                action=Action.SELL_PARTIAL,
                reason=ReasonCode.SPIKE_DETECTED,
                before=State.NORMAL_RUN,
                after=State.SPIKE_LOCK,
                sell_pct=0.25,
                price_hint=123.456,
            )
        ],
        {
            "AAA:NYSE": {"mode": "OWNED", "state": "SPIKE_LOCK"},
            "BBB:NYSE": {"mode": "WATCH", "state": "EXITED_COOLDOWN"},
        },
    )

    assert "Wniosek mechanizmu: Zmniejsz pozycje o 25%." in msg
    assert "Parametry: Cena odniesienia: 123.46 USD." in msg
    assert "Dlaczego: Wykryto nienaturalnie szybki ruch ceny." in msg
    assert "Status: Status pozycji zmienil sie z 'pozycja aktywna' na 'ochrona po gwaltownym ruchu'." in msg


def test_format_telegram_message_no_actionable_is_clear():
    msg = format_telegram_message(
        "2026-02-13",
        [
            _decision(
                action=Action.HOLD,
                reason=ReasonCode.NO_NEW_BAR,
                before=State.NORMAL_RUN,
                after=State.NORMAL_RUN,
            )
        ],
        {"AAA:NYSE": {"mode": "OWNED", "state": "NORMAL_RUN"}},
    )

    assert "Dzisiaj mechanizm nie wykryl warunkow do nowej transakcji." in msg
    assert "Podsumowanie portfela" in msg


def test_format_telegram_message_renders_high_anomaly_section():
    anomaly = AnomalyEvent(
        bar_date="2026-02-13",
        key="XYZ:NYSE",
        symbol={"ticker": "XYZ", "exchange": "NYSE", "currency": "USD"},
        code=AnomalyCode.EXTREME_DRAWDOWN,
        severity=AnomalySeverity.HIGH,
        metrics={"drawdown_in_atr": 5.6, "roc_5_norm": -2.4, "atr_pct": 1.7},
        text="Extreme volatility-adjusted drawdown detected.",
    )
    msg = format_telegram_message(
        "2026-02-13",
        [
            _decision(
                action=Action.HOLD,
                reason=ReasonCode.NO_NEW_BAR,
                before=State.NORMAL_RUN,
                after=State.NORMAL_RUN,
            )
        ],
        {"AAA:NYSE": {"mode": "OWNED", "state": "NORMAL_RUN"}},
        anomaly_events=[anomaly],
    )

    assert "Szczegolne nienormalne trendy i ryzyka (wysoki priorytet):" in msg
    assert "XYZ:NYSE" in msg
    assert "Ekstremalny spadek wzgledem zmiennosci. Poziom waznosci: wysoki." in msg
    assert "Skala obsuniecia=5.60" in msg


def test_format_telegram_message_renders_buy_alert_with_stop_loss():
    msg = format_telegram_message(
        "2026-02-13",
        [
            _decision(
                action=Action.BUY_ALERT,
                reason=ReasonCode.BUY_TRIGGER,
                before=State.EXITED_COOLDOWN,
                after=State.EXITED_COOLDOWN,
                levels={
                    "entry_ref_price": 110.0,
                    "stop_loss_price": 104.0,
                    "atr_d": 2.0,
                    "time_stop_days": 7,
                    "shares_hint": 125.5,
                },
            )
        ],
        {"AAA:NYSE": {"mode": "WATCH", "state": "EXITED_COOLDOWN"}},
    )

    assert "TOP 3 okazje do rozwazenia zakupu dzisiaj (ranking punktowy):" in msg
    assert "Potwierdzony sygnal kupna po korekcie." in msg
    assert "Plan na teraz: Cena odniesienia: 110.00 USD." in msg
    assert "Stop loss: 104.00 USD." in msg


def test_format_telegram_message_renders_std_pullback_info_section():
    anomaly = AnomalyEvent(
        bar_date="2026-02-13",
        key="AAA:NYSE",
        symbol={"ticker": "AAA", "exchange": "NYSE", "currency": "USD"},
        code=AnomalyCode.STD_PULLBACK,
        severity=AnomalySeverity.INFO,
        metrics={"one_day_return_pct": -2.4, "one_day_return_in_sigma": -1.3, "sigma_log_20": 0.0123},
        text="Standardized pullback detected (buy-context info).",
    )
    msg = format_telegram_message(
        "2026-02-13",
        [
            _decision(
                action=Action.HOLD,
                reason=ReasonCode.NO_NEW_BAR,
                before=State.NORMAL_RUN,
                after=State.NORMAL_RUN,
            )
        ],
        {"AAA:NYSE": {"mode": "WATCH", "state": "EXITED_COOLDOWN"}},
        anomaly_events=[anomaly],
    )

    assert "TOP 3 okazje do rozwazenia zakupu dzisiaj (ranking punktowy):" in msg
    assert "Silne cofniecie ceny warte obserwacji pod zakup." in msg
    assert "Dzisiaj kurs zmienil sie o -2.40% (okolo -1.30 odchylenia standardowego)." in msg


def test_format_telegram_message_buy_alert_includes_company_context_block():
    msg = format_telegram_message(
        "2026-02-13",
        [
            _decision(
                action=Action.BUY_ALERT,
                reason=ReasonCode.BUY_TRIGGER,
                before=State.EXITED_COOLDOWN,
                after=State.EXITED_COOLDOWN,
                levels={
                    "entry_ref_price": 110.0,
                    "stop_loss_price": 104.0,
                    "atr_d": 2.0,
                    "time_stop_days": 7,
                },
            )
        ],
        {"AAA:NYSE": {"mode": "WATCH", "state": "EXITED_COOLDOWN"}},
        research_rows=_research_rows_for_aaa(),
    )

    assert "Mini-esej inwestycyjny:" in msg
    assert "Metodologia analizy: EKSTRA 2026 (nowa metodologia)" in msg
    assert "Status decyzji i jakosc: ACTIVE | A-" in msg
    assert "Teza inwestycyjna: Wysoka marza i rosnacy udzial rynku." in msg
    assert "Wady i ryzyka:" in msg


def test_format_telegram_message_anomaly_info_includes_company_context_block():
    anomaly = AnomalyEvent(
        bar_date="2026-02-13",
        key="AAA:NYSE",
        symbol={"ticker": "AAA", "exchange": "NYSE", "currency": "USD"},
        code=AnomalyCode.STD_PULLBACK,
        severity=AnomalySeverity.INFO,
        metrics={"one_day_return_pct": -2.4, "one_day_return_in_sigma": -1.3, "sigma_log_20": 0.0123},
        text="Standardized pullback detected (buy-context info).",
    )
    msg = format_telegram_message(
        "2026-02-13",
        [
            _decision(
                action=Action.HOLD,
                reason=ReasonCode.NO_NEW_BAR,
                before=State.NORMAL_RUN,
                after=State.NORMAL_RUN,
            )
        ],
        {"AAA:NYSE": {"mode": "WATCH", "state": "EXITED_COOLDOWN"}},
        anomaly_events=[anomaly],
        research_rows=_research_rows_for_aaa(),
    )

    assert "TOP 3 okazje do rozwazenia zakupu dzisiaj (ranking punktowy):" in msg
    assert "Mini-esej inwestycyjny:" in msg
    assert "Zalety tej tezy: Silny trend przy korektach o niskim wolumenie." in msg


def test_format_telegram_message_renders_recent_abnormal_trend_metrics():
    anomaly = AnomalyEvent(
        bar_date="2026-02-13",
        key="AAA:NYSE",
        symbol={"ticker": "AAA", "exchange": "NYSE", "currency": "USD"},
        code=AnomalyCode.RECENT_ABNORMAL_TREND,
        severity=AnomalySeverity.HIGH,
        metrics={
            "recent_trend_direction": "UP",
            "return_3d_in_sigma": 2.9,
            "return_5d_in_sigma": 2.4,
            "return_3d_pct": 7.2,
            "return_5d_pct": 11.8,
        },
        text="Abnormal multi-day trend detected in recent sessions.",
    )
    msg = format_telegram_message(
        "2026-02-13",
        [
            _decision(
                action=Action.HOLD,
                reason=ReasonCode.NO_NEW_BAR,
                before=State.NORMAL_RUN,
                after=State.NORMAL_RUN,
            )
        ],
        {"AAA:NYSE": {"mode": "WATCH", "state": "EXITED_COOLDOWN"}},
        anomaly_events=[anomaly],
    )

    assert "Nienormalny trend z ostatnich dni. Poziom waznosci: wysoki." in msg
    assert "Kierunek=wzrostowy" in msg
    assert "Zmiana z 3 sesji=7.20% (2.90 odchylenia)" in msg
    assert "Zmiana z 5 sesji=11.80% (2.40 odchylenia)." in msg


def test_format_telegram_message_renders_multiday_drop_metrics():
    anomaly = AnomalyEvent(
        bar_date="2026-02-13",
        key="AAA:NYSE",
        symbol={"ticker": "AAA", "exchange": "NYSE", "currency": "USD"},
        code=AnomalyCode.MULTIDAY_DROP,
        severity=AnomalySeverity.HIGH,
        metrics={
            "drop_3d_pct": -6.2,
            "drop_5d_pct": -9.1,
            "multiday_drop_ratio": 1.8,
            "down_days_5d": 4,
        },
        text="Multi-day drop acceleration detected.",
    )
    msg = format_telegram_message(
        "2026-02-13",
        [
            _decision(
                action=Action.HOLD,
                reason=ReasonCode.NO_NEW_BAR,
                before=State.NORMAL_RUN,
                after=State.NORMAL_RUN,
            )
        ],
        {"AAA:NYSE": {"mode": "WATCH", "state": "EXITED_COOLDOWN"}},
        anomaly_events=[anomaly],
    )

    assert "Parudniowy spadek z przyspieszeniem" in msg
    assert "Zmiana 3d=-6.20%" in msg
    assert "zmiana 5d=-9.10%" in msg


def test_format_telegram_messages_prioritizes_multiday_drop_first():
    multiday = AnomalyEvent(
        bar_date="2026-02-13",
        key="AAA:NYSE",
        symbol={"ticker": "AAA", "exchange": "NYSE", "currency": "USD"},
        code=AnomalyCode.MULTIDAY_DROP,
        severity=AnomalySeverity.HIGH,
        metrics={"drop_3d_pct": -7.2, "drop_5d_pct": -10.3, "multiday_drop_ratio": 1.6, "down_days_5d": 4},
        text="Multi-day drop acceleration detected.",
    )
    normal = AnomalyEvent(
        bar_date="2026-02-13",
        key="BBB:NYSE",
        symbol={"ticker": "BBB", "exchange": "NYSE", "currency": "USD"},
        code=AnomalyCode.EXTREME_DRAWDOWN,
        severity=AnomalySeverity.HIGH,
        metrics={"drawdown_in_atr": 5.0, "roc_5_norm": -2.2, "atr_pct": 1.4},
        text="Extreme volatility-adjusted drawdown detected.",
    )

    messages = format_telegram_messages(
        "2026-02-13",
        [],
        {
            "AAA:NYSE": {"mode": "WATCH", "state": "EXITED_COOLDOWN"},
            "BBB:NYSE": {"mode": "WATCH", "state": "EXITED_COOLDOWN"},
        },
        anomaly_events=[normal, multiday],
    )

    assert len(messages) == 3
    assert "🧭 Brief dnia" in messages[0]
    assert "AAA:NYSE" in messages[0]
    assert "Spolka: AAA:NYSE" in messages[1]
    assert "Parudniowy spadek z przyspieszeniem" in messages[1]
    assert "Zmiana 3d=-7.20%" in messages[1]


def test_format_telegram_message_prefers_2026_context_when_rows_overlap():
    msg = format_telegram_message(
        "2026-02-13",
        [
            _decision(
                action=Action.BUY_ALERT,
                reason=ReasonCode.BUY_TRIGGER,
                before=State.EXITED_COOLDOWN,
                after=State.EXITED_COOLDOWN,
                levels={"entry_ref_price": 100.0, "stop_loss_price": 94.0, "atr_d": 2.0, "time_stop_days": 7},
            )
        ],
        {"AAA:NYSE": {"mode": "WATCH", "state": "EXITED_COOLDOWN"}},
        research_rows=_research_rows_mixed_for_aaa(),
    )

    assert "Metodologia analizy: EKSTRA 2026 (nowa metodologia)" in msg
    assert "Zalety tej tezy: Nowa metodologia." in msg


def test_format_telegram_messages_returns_separate_message_per_stock():
    messages = format_telegram_messages(
        "2026-02-13",
        [
            _decision(
                action=Action.BUY_ALERT,
                reason=ReasonCode.BUY_TRIGGER,
                before=State.EXITED_COOLDOWN,
                after=State.EXITED_COOLDOWN,
                key="AAA:NYSE",
                ticker="AAA",
                exchange="NYSE",
                levels={"price_close": 110.0, "day_change_pct": -2.5},
            ),
            _decision(
                action=Action.SELL_PARTIAL,
                reason=ReasonCode.SPIKE_DETECTED,
                before=State.NORMAL_RUN,
                after=State.SPIKE_LOCK,
                key="BBB:NYSE",
                ticker="BBB",
                exchange="NYSE",
                levels={"price_close": 55.0, "day_change_pct": 3.2},
            ),
        ],
        {
            "AAA:NYSE": {"mode": "WATCH", "state": "EXITED_COOLDOWN"},
            "BBB:NYSE": {"mode": "OWNED", "state": "SPIKE_LOCK"},
        },
        research_rows=_research_rows_for_aaa(),
    )

    assert len(messages) == 3
    assert "🧭 Brief dnia" in messages[0]
    assert "AAA:NYSE" in messages[0]
    assert "BBB:NYSE" in messages[0]
    assert "Spolka: AAA:NYSE" in messages[1]
    assert "Spolka: BBB:NYSE" in messages[2]
    assert "Aktualna cena: 110.00 USD. Zmiana dzienna: -2.50%." in messages[1]
    assert "Aktualna cena: 55.00 USD. Zmiana dzienna: +3.20%." in messages[2]


def test_format_telegram_messages_includes_required_thesis_fields():
    messages = format_telegram_messages(
        "2026-02-13",
        [
            _decision(
                action=Action.BUY_ALERT,
                reason=ReasonCode.BUY_TRIGGER,
                before=State.EXITED_COOLDOWN,
                after=State.EXITED_COOLDOWN,
                levels={"price_close": 110.0, "day_change_pct": -1.2},
            )
        ],
        {"AAA:NYSE": {"mode": "WATCH", "state": "EXITED_COOLDOWN"}},
        research_rows=_research_rows_for_aaa(),
    )

    assert len(messages) == 2
    assert "🧭 Brief dnia" in messages[0]
    msg = messages[1]
    assert "Zrodlo tezy: n/a" in msg or "Zrodlo tezy:" in msg
    assert "Teza inwestycyjna (dlaczego ta firma): Wysoka marza i rosnacy udzial rynku." in msg
    assert "Watpliwosci / ryzyka: Spadek marzy brutto przez 2 kwartaly." in msg


def test_format_telegram_messages_includes_all_theses_for_same_company_name():
    messages = format_telegram_messages(
        "2026-02-13",
        [
            _decision(
                action=Action.BUY_ALERT,
                reason=ReasonCode.BUY_TRIGGER,
                before=State.EXITED_COOLDOWN,
                after=State.EXITED_COOLDOWN,
                key="RHM:ETR",
                ticker="RHM",
                exchange="ETR",
                levels={"price_close": 812.4, "day_change_pct": -1.8},
            )
        ],
        {"RHM:ETR": {"mode": "WATCH", "state": "EXITED_COOLDOWN"}},
        research_rows=_research_rows_for_rhm_with_unresolved(),
    )

    assert len(messages) == 2
    assert "🧭 Brief dnia" in messages[0]
    msg = messages[1]
    assert "Spolka: RHM:ETR" in msg
    assert "Wszystkie tezy z bazy (max 5):" in msg
    assert "Rosnacy popyt na segment obronny." in msg
    assert "Efekt skali i backlog zamowien." in msg
