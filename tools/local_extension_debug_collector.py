#!/usr/bin/env python3
"""Collect sanitized extension debug snapshots from localhost POSTs."""

from __future__ import annotations

import argparse
import json
import os
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 17777
SNAPSHOT_ENDPOINT = "/extension-debug/snapshot"


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def summarize_payload(payload: dict[str, Any]) -> dict[str, Any]:
    reload_state = payload.get("reloadResumeMonitorState") if isinstance(payload, dict) else None
    process_state = payload.get("processMonitorState") if isinstance(payload, dict) else None
    problem_logs = payload.get("problemLogEntries") if isinstance(payload, dict) else None
    unfinished_state = payload.get("unfinishedResumeBatchState") if isinstance(payload, dict) else None

    counts = reload_state.get("counts") if isinstance(reload_state, dict) else {}
    summary = reload_state.get("summary") if isinstance(reload_state, dict) else {}
    rows = reload_state.get("rows") if isinstance(reload_state, dict) else []
    events = reload_state.get("events") if isinstance(reload_state, dict) else []

    return {
        "received_at": utc_now_iso(),
        "reason": payload.get("reason", "") if isinstance(payload, dict) else "",
        "sessionId": reload_state.get("sessionId", "") if isinstance(reload_state, dict) else "",
        "reloadStatus": reload_state.get("status", "") if isinstance(reload_state, dict) else "",
        "reloadPhase": reload_state.get("phase", "") if isinstance(reload_state, dict) else "",
        "reloadCounts": counts if isinstance(counts, dict) else {},
        "reloadSummary": summary if isinstance(summary, dict) else {},
        "reloadRows": len(rows) if isinstance(rows, list) else 0,
        "reloadEvents": len(events) if isinstance(events, list) else 0,
        "processRecords": len(process_state) if isinstance(process_state, list) else 0,
        "problemLogs": len(problem_logs) if isinstance(problem_logs, list) else 0,
        "unfinishedJobId": unfinished_state.get("jobId", "") if isinstance(unfinished_state, dict) else "",
        "unfinishedStatus": unfinished_state.get("status", "") if isinstance(unfinished_state, dict) else "",
    }


class SnapshotStore:
    def __init__(self, output_dir: Path) -> None:
        self.output_dir = output_dir
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.latest_path = self.output_dir / "latest.json"
        self.summary_path = self.output_dir / "latest-summary.json"
        self.history_path = self.output_dir / "snapshots.ndjson"

    def write(self, payload: dict[str, Any]) -> None:
        summary = summarize_payload(payload)
        self.latest_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        self.summary_path.write_text(
            json.dumps(summary, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        with self.history_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"summary": summary, "payload": payload}, ensure_ascii=False))
            handle.write("\n")


def build_handler(store: SnapshotStore):
    class CollectorHandler(BaseHTTPRequestHandler):
        server_version = "IskraLocalDebugCollector/1.0"

        def _send_json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            if self.path == "/health":
                self._send_json(
                    200,
                    {
                        "ok": True,
                        "received_at": utc_now_iso(),
                        "latest_path": str(store.latest_path),
                        "summary_path": str(store.summary_path),
                    },
                )
                return
            self._send_json(404, {"ok": False, "error": "not_found"})

        def do_POST(self) -> None:
            if self.path != SNAPSHOT_ENDPOINT:
                self._send_json(404, {"ok": False, "error": "not_found"})
                return
            try:
                content_length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                content_length = 0
            raw_body = self.rfile.read(max(0, content_length))
            try:
                payload = json.loads(raw_body.decode("utf-8"))
            except Exception as error:  # noqa: BLE001
                self._send_json(400, {"ok": False, "error": f"invalid_json:{error}"})
                return
            if not isinstance(payload, dict):
                self._send_json(400, {"ok": False, "error": "payload_must_be_object"})
                return
            store.write(payload)
            self._send_json(
                200,
                {
                    "ok": True,
                    "saved_at": utc_now_iso(),
                    "latest_path": str(store.latest_path),
                    "summary_path": str(store.summary_path),
                },
            )

        def log_message(self, format: str, *args: object) -> None:
            return

    return CollectorHandler


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument(
        "--output-dir",
        default=str(Path(__file__).resolve().parents[1] / "out" / "local-extension-debug"),
    )
    args = parser.parse_args()

    output_dir = Path(os.path.expanduser(args.output_dir)).resolve()
    store = SnapshotStore(output_dir)
    handler_cls = build_handler(store)
    server = ThreadingHTTPServer((args.host, args.port), handler_cls)
    print(
        json.dumps(
            {
                "ok": True,
                "host": args.host,
                "port": args.port,
                "output_dir": str(output_dir),
                "latest_path": str(store.latest_path),
                "summary_path": str(store.summary_path),
            },
            ensure_ascii=False,
        )
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
