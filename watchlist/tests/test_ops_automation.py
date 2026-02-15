from __future__ import annotations

from datetime import datetime, timezone

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
from src.ops.daily_job import apply_telegram_delivery, build_last_run_payload, build_report_payload, resolve_telegram_delivery
from src.ops.watchdog import assess_health


def _decision(
    *,
    action: Action,
    reason: ReasonCode,
    before: State,
    after: State,
) -> DecisionOfDay:
    return DecisionOfDay(
        bar_date="2026-02-13",
        key="AAA:NYSE",
        symbol={"ticker": "AAA", "exchange": "NYSE", "currency": "USD"},
        mode=Mode.OWNED,
        state_before=before,
        state_after=after,
        action=ActionPayload(type=action),
        reason=ReasonPayload(code=reason, text=reason.value),
        levels={},
        targets={},
    )


def test_daily_job_report_keeps_only_actionable_events():
    actionable = _decision(
        action=Action.SELL_PARTIAL,
        reason=ReasonCode.SPIKE_DETECTED,
        before=State.NORMAL_RUN,
        after=State.SPIKE_LOCK,
    )
    non_actionable = _decision(
        action=Action.HOLD,
        reason=ReasonCode.NO_NEW_BAR,
        before=State.NORMAL_RUN,
        after=State.NORMAL_RUN,
    )

    result = DailyRunResult(
        bar_date="2026-02-13",
        decisions=[actionable, non_actionable],
        telegram_message="test",
        summary={"telegram_sent": True},
    )
    payload = build_report_payload(result, generated_utc="2026-02-13T20:00:00Z")

    assert payload["actionable_count"] == 1
    assert len(payload["actionable_events"]) == 1
    assert payload["actionable_events"][0]["action"]["type"] == Action.SELL_PARTIAL.value


def test_daily_job_last_run_marks_notification_sent_from_summary():
    result = DailyRunResult(
        bar_date="2026-02-13",
        decisions=[],
        telegram_message="test",
        summary={"telegram_attempted": True, "telegram_sent": True, "telegram_policy": "actionable_only"},
    )

    payload = build_last_run_payload(
        result,
        generated_utc="2026-02-13T20:00:00Z",
    )

    assert payload["notification"]["attempted"] is True
    assert payload["notification"]["sent"] is True
    assert payload["notification"]["sent_utc"] == "2026-02-13T20:00:00Z"
    assert payload["notification"]["policy"] == "actionable_only"
    assert payload["notification"]["skip_reason"] is None


def test_daily_job_resolve_telegram_delivery_skips_without_actionable_changes():
    result = DailyRunResult(
        bar_date="2026-02-13",
        decisions=[],
        telegram_message="test",
        summary={"actionable_count": 0},
    )

    attempted, reason = resolve_telegram_delivery(
        result,
        previous_last_run={},
        telegram_enabled=True,
        telegram_mode="actionable_only",
    )

    assert attempted is False
    assert reason == "no_actionable_changes"


def test_daily_job_resolve_telegram_delivery_skips_when_already_sent_for_bar_date():
    result = DailyRunResult(
        bar_date="2026-02-13",
        decisions=[],
        telegram_message="test",
        summary={"actionable_count": 2},
    )

    attempted, reason = resolve_telegram_delivery(
        result,
        previous_last_run={
            "bar_date": "2026-02-13",
            "notification": {"sent": True},
        },
        telegram_enabled=True,
        telegram_mode="actionable_only",
    )

    assert attempted is False
    assert reason == "already_sent_for_bar_date"


def test_daily_job_resolve_telegram_delivery_allows_send_in_always_mode():
    result = DailyRunResult(
        bar_date="2026-02-13",
        decisions=[],
        telegram_message="test",
        summary={"actionable_count": 0},
    )

    attempted, reason = resolve_telegram_delivery(
        result,
        previous_last_run={},
        telegram_enabled=True,
        telegram_mode="always",
    )

    assert attempted is True
    assert reason is None


def test_daily_job_resolve_telegram_delivery_allows_send_for_high_anomaly():
    anomaly = AnomalyEvent(
        bar_date="2026-02-13",
        key="AAA:NYSE",
        symbol={"ticker": "AAA", "exchange": "NYSE", "currency": "USD"},
        code=AnomalyCode.EXTREME_DRAWDOWN,
        severity=AnomalySeverity.HIGH,
        metrics={},
        text="extreme",
    )
    result = DailyRunResult(
        bar_date="2026-02-13",
        decisions=[],
        telegram_message="test",
        summary={"actionable_count": 0, "anomaly_count_high": 1},
        anomaly_events=[anomaly],
    )

    attempted, reason = resolve_telegram_delivery(
        result,
        previous_last_run={},
        telegram_enabled=True,
        telegram_mode="actionable_only",
    )

    assert attempted is True
    assert reason is None


def test_daily_job_resolve_telegram_delivery_skips_for_info_only_anomalies():
    anomaly = AnomalyEvent(
        bar_date="2026-02-13",
        key="AAA:NYSE",
        symbol={"ticker": "AAA", "exchange": "NYSE", "currency": "USD"},
        code=AnomalyCode.MOMENTUM_WARN,
        severity=AnomalySeverity.INFO,
        metrics={},
        text="warn",
    )
    result = DailyRunResult(
        bar_date="2026-02-13",
        decisions=[],
        telegram_message="test",
        summary={"actionable_count": 0, "anomaly_count_high": 0},
        anomaly_events=[anomaly],
    )

    attempted, reason = resolve_telegram_delivery(
        result,
        previous_last_run={},
        telegram_enabled=True,
        telegram_mode="actionable_only",
    )

    assert attempted is False
    assert reason == "no_actionable_changes"


def test_daily_job_resolve_telegram_delivery_allows_send_for_std_pullback_info():
    anomaly = AnomalyEvent(
        bar_date="2026-02-13",
        key="AAA:NYSE",
        symbol={"ticker": "AAA", "exchange": "NYSE", "currency": "USD"},
        code=AnomalyCode.STD_PULLBACK,
        severity=AnomalySeverity.INFO,
        metrics={"one_day_return_pct": -2.1, "one_day_return_in_sigma": -1.4},
        text="std pullback",
    )
    result = DailyRunResult(
        bar_date="2026-02-13",
        decisions=[],
        telegram_message="test",
        summary={"actionable_count": 0, "anomaly_count_high": 0},
        anomaly_events=[anomaly],
    )

    attempted, reason = resolve_telegram_delivery(
        result,
        previous_last_run={},
        telegram_enabled=True,
        telegram_mode="actionable_only",
    )

    assert attempted is True
    assert reason is None


def test_apply_telegram_delivery_sends_all_per_stock_messages(monkeypatch):
    sent_messages: list[str] = []

    def fake_sender(message: str) -> bool:
        sent_messages.append(message)
        return True

    monkeypatch.setattr("src.ops.daily_job.send_telegram_message", fake_sender)

    result = DailyRunResult(
        bar_date="2026-02-13",
        decisions=[],
        telegram_message="fallback",
        telegram_messages=["AAA message", "BBB message"],
        summary={"actionable_count": 1},
    )

    apply_telegram_delivery(
        result=result,
        previous_last_run={},
        telegram_enabled=True,
        telegram_mode="always",
    )

    assert sent_messages == ["AAA message", "BBB message"]
    assert result.summary["telegram_attempted"] is True
    assert result.summary["telegram_sent"] is True


def test_apply_telegram_delivery_marks_failed_when_any_message_fails(monkeypatch):
    calls = {"count": 0}

    def fake_sender(message: str) -> bool:
        calls["count"] += 1
        return calls["count"] < 2

    monkeypatch.setattr("src.ops.daily_job.send_telegram_message", fake_sender)

    result = DailyRunResult(
        bar_date="2026-02-13",
        decisions=[],
        telegram_message="fallback",
        telegram_messages=["AAA message", "BBB message"],
        summary={"actionable_count": 1},
    )

    apply_telegram_delivery(
        result=result,
        previous_last_run={},
        telegram_enabled=True,
        telegram_mode="always",
    )

    assert calls["count"] == 2
    assert result.summary["telegram_sent"] is False
    assert result.summary["telegram_skip_reason"] == "send_failed_or_unconfigured"


def test_watchdog_assess_health_ok_for_fresh_run_and_notification():
    now_utc = datetime(2026, 2, 13, 22, 0, tzinfo=timezone.utc)
    positions = {"meta": {"last_run_utc": "2026-02-13T10:30:00Z"}}
    last_run = {"notification": {"sent": True, "sent_utc": "2026-02-13T10:35:00Z"}}

    healthy, issues = assess_health(
        positions_payload=positions,
        last_run_payload=last_run,
        now_utc=now_utc,
        max_run_age_hours=36.0,
        max_notification_age_hours=36.0,
        require_notification=True,
    )

    assert healthy is True
    assert issues == []


def test_watchdog_assess_health_fails_for_stale_run():
    now_utc = datetime(2026, 2, 13, 22, 0, tzinfo=timezone.utc)
    positions = {"meta": {"last_run_utc": "2026-02-11T08:00:00Z"}}

    healthy, issues = assess_health(
        positions_payload=positions,
        last_run_payload={},
        now_utc=now_utc,
        max_run_age_hours=36.0,
        max_notification_age_hours=36.0,
        require_notification=False,
    )

    assert healthy is False
    assert any("stale" in item for item in issues)
