from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
from typing import Any, Dict, List, Tuple


def parse_utc(value: str | None) -> datetime | None:
    if not value:
        return None
    normalized = str(value).strip()
    if normalized.endswith("Z"):
        normalized = f"{normalized[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


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


def assess_health(
    positions_payload: Dict[str, Any],
    last_run_payload: Dict[str, Any],
    *,
    now_utc: datetime,
    max_run_age_hours: float,
    max_notification_age_hours: float,
    require_notification: bool,
) -> Tuple[bool, List[str]]:
    issues: List[str] = []

    run_ts_raw = positions_payload.get("meta", {}).get("last_run_utc")
    run_ts = parse_utc(run_ts_raw if isinstance(run_ts_raw, str) else None)
    if run_ts is None:
        issues.append("Missing or invalid positions.meta.last_run_utc.")
    else:
        run_age_hours = (now_utc - run_ts).total_seconds() / 3600.0
        if run_age_hours > max_run_age_hours:
            issues.append(
                f"last_run_utc is stale ({run_age_hours:.1f}h > {max_run_age_hours:.1f}h)."
            )

    if require_notification:
        notification = last_run_payload.get("notification", {})
        sent = bool(notification.get("sent", False))
        sent_ts = parse_utc(notification.get("sent_utc"))
        if not sent:
            issues.append("Notification was not sent in the latest run.")
        elif sent_ts is None:
            issues.append("Missing or invalid notification.sent_utc timestamp.")
        else:
            notify_age_hours = (now_utc - sent_ts).total_seconds() / 3600.0
            if notify_age_hours > max_notification_age_hours:
                issues.append(
                    f"notification.sent_utc is stale ({notify_age_hours:.1f}h > {max_notification_age_hours:.1f}h)."
                )

    return len(issues) == 0, issues


def main() -> None:
    parser = argparse.ArgumentParser(description="Check daily run freshness and alert on stale state.")
    parser.add_argument(
        "--positions-path",
        default="data/positions.json",
        help="Path to persistent positions state (default: data/positions.json).",
    )
    parser.add_argument(
        "--last-run-path",
        default="out/last_run.json",
        help="Path to last run metadata (default: out/last_run.json).",
    )
    parser.add_argument(
        "--max-run-age-hours",
        type=float,
        default=36.0,
        help="Max allowed age for positions.meta.last_run_utc (default: 36h).",
    )
    parser.add_argument(
        "--max-notification-age-hours",
        type=float,
        default=36.0,
        help="Max allowed age for notification.sent_utc (default: 36h).",
    )
    parser.add_argument(
        "--require-notification",
        action="store_true",
        help="Fail when notification was not sent or is stale.",
    )
    args = parser.parse_args()

    now_utc = datetime.now(timezone.utc)
    positions_payload = read_json(args.positions_path)
    last_run_payload = read_json(args.last_run_path)

    healthy, issues = assess_health(
        positions_payload=positions_payload,
        last_run_payload=last_run_payload,
        now_utc=now_utc,
        max_run_age_hours=args.max_run_age_hours,
        max_notification_age_hours=args.max_notification_age_hours,
        require_notification=args.require_notification,
    )

    if healthy:
        print("Watchdog OK: daily run metadata is fresh.")
        return

    for issue in issues:
        print(f"::error::{issue}")
    raise SystemExit(1)


if __name__ == "__main__":
    main()

