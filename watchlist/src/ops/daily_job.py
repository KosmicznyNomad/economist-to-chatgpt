from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any, Dict, Literal, Tuple

from src.engine.daily_run import run_daily
from src.engine.definitions import DailyRunResult
from src.notify.telegram import is_actionable, send_telegram_message


TelegramMode = Literal["always", "actionable_only"]


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def read_json(path: str | Path) -> Dict[str, Any]:
    file_path = Path(path)
    if not file_path.exists():
        return {}
    text = file_path.read_text(encoding="utf-8").strip()
    if not text:
        return {}
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def resolve_telegram_delivery(
    result: DailyRunResult,
    previous_last_run: Dict[str, Any],
    *,
    telegram_enabled: bool,
    telegram_mode: TelegramMode,
) -> Tuple[bool, str | None]:
    if not telegram_enabled:
        return False, "telegram_disabled"

    previous_notification = previous_last_run.get("notification", {})
    previous_bar_date = previous_last_run.get("bar_date")
    already_sent_for_bar = bool(previous_notification.get("sent", False)) and bool(result.bar_date) and (
        str(previous_bar_date) == str(result.bar_date)
    )
    if already_sent_for_bar:
        return False, "already_sent_for_bar_date"

    actionable_count = int(result.summary.get("actionable_count", 0))
    anomaly_high_count = int(result.summary.get("anomaly_count_high", 0))
    std_pullback_info_count = len(
        [item for item in result.anomaly_events if item.code.value == "STD_PULLBACK"]
    )
    if (
        telegram_mode == "actionable_only"
        and actionable_count <= 0
        and anomaly_high_count <= 0
        and std_pullback_info_count <= 0
    ):
        return False, "no_actionable_changes"

    return True, None


def apply_telegram_delivery(
    result: DailyRunResult,
    previous_last_run: Dict[str, Any],
    *,
    telegram_enabled: bool,
    telegram_mode: TelegramMode,
) -> None:
    attempted, skip_reason = resolve_telegram_delivery(
        result=result,
        previous_last_run=previous_last_run,
        telegram_enabled=telegram_enabled,
        telegram_mode=telegram_mode,
    )

    sent = False
    if attempted:
        payloads = list(result.telegram_messages) if result.telegram_messages else [result.telegram_message]
        sent = True
        for payload in payloads:
            if not send_telegram_message(payload):
                sent = False
                break
        if not sent:
            skip_reason = "send_failed_or_unconfigured"

    result.summary["telegram_policy"] = telegram_mode
    result.summary["telegram_attempted"] = attempted
    result.summary["telegram_sent"] = sent
    result.summary["telegram_skip_reason"] = skip_reason


def build_report_payload(result: DailyRunResult, generated_utc: str) -> Dict[str, Any]:
    actionable = [item.to_dict() for item in result.decisions if is_actionable(item)]
    anomaly_events = [item.to_dict() for item in result.anomaly_events]
    anomaly_count_high = len([item for item in result.anomaly_events if item.severity.value == "HIGH"])
    return {
        "schema": "psm_v4.run_report.v1",
        "generated_utc": generated_utc,
        "bar_date": result.bar_date,
        "summary": result.summary,
        "actionable_count": len(actionable),
        "actionable_events": actionable,
        "anomaly_count_total": len(anomaly_events),
        "anomaly_count_high": anomaly_count_high,
        "anomaly_events": anomaly_events,
    }


def build_last_run_payload(
    result: DailyRunResult,
    generated_utc: str,
) -> Dict[str, Any]:
    telegram_sent = bool(result.summary.get("telegram_sent", False))
    telegram_attempted = bool(result.summary.get("telegram_attempted", telegram_sent))
    telegram_policy = str(result.summary.get("telegram_policy", "always"))
    telegram_skip_reason = result.summary.get("telegram_skip_reason")
    return {
        "schema": "psm_v4.last_run.v1",
        "generated_utc": generated_utc,
        "bar_date": result.bar_date,
        "summary": result.summary,
        "notification": {
            "channel": "telegram",
            "attempted": telegram_attempted,
            "sent": telegram_sent,
            "sent_utc": generated_utc if telegram_sent else None,
            "policy": telegram_policy,
            "skip_reason": telegram_skip_reason,
        },
    }


def write_json(path: str | Path, payload: Dict[str, Any]) -> None:
    file_path = Path(path)
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Run daily state-machine pipeline and emit CI reports.")
    parser.add_argument(
        "--positions-path",
        default="data/positions.json",
        help="Persistent state file path (default: data/positions.json).",
    )
    parser.add_argument(
        "--report-path",
        default="out/run.json",
        help="Report file path (default: out/run.json).",
    )
    parser.add_argument(
        "--last-run-path",
        default="out/last_run.json",
        help="Last run metadata file path (default: out/last_run.json).",
    )
    parser.add_argument(
        "--no-telegram",
        action="store_true",
        help="Disable Telegram delivery for this run.",
    )
    parser.add_argument(
        "--telegram-mode",
        choices=["always", "actionable_only"],
        default="actionable_only",
        help="Telegram policy: always send or only send when actionable changes exist (default: actionable_only).",
    )
    args = parser.parse_args()

    telegram_enabled = not args.no_telegram
    previous_last_run = read_json(args.last_run_path)
    result = run_daily(positions_path=args.positions_path, send_telegram=False)
    apply_telegram_delivery(
        result=result,
        previous_last_run=previous_last_run,
        telegram_enabled=telegram_enabled,
        telegram_mode=args.telegram_mode,
    )
    now_utc = utc_now_iso()

    report = build_report_payload(result=result, generated_utc=now_utc)
    write_json(args.report_path, report)

    last_run = build_last_run_payload(
        result=result,
        generated_utc=now_utc,
    )
    write_json(args.last_run_path, last_run)

    print(
        "Daily run complete: bar_date={bar_date}, decisions={decisions}, actionable={actionable}, telegram_attempted={attempted}, telegram_sent={sent}, telegram_skip_reason={reason}".format(
            bar_date=result.bar_date,
            decisions=len(result.decisions),
            actionable=report["actionable_count"],
            attempted=result.summary.get("telegram_attempted", False),
            sent=result.summary.get("telegram_sent", False),
            reason=result.summary.get("telegram_skip_reason"),
        )
    )


if __name__ == "__main__":
    main()
