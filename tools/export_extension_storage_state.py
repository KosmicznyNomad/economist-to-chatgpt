#!/usr/bin/env python3
"""Export selected Chrome/Edge extension storage keys to workspace JSON.

The script scans Chromium-based browser profiles for extension storage
directories that contain the target keys used by this project. It then
extracts the latest JSON payloads for those keys from LevelDB files and
writes a stable `latest.json` snapshot under `out/extension-storage-export/`.
"""

from __future__ import annotations

import argparse
import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


TARGET_KEYS = (
    "reload_resume_monitor_state",
    "process_monitor_state",
    "problem_log_entries",
)

PROFILE_NAMES = ("Default", "Profile", "Guest Profile")
DATA_ROOTS = (
    ("chrome", Path(os.environ.get("LOCALAPPDATA", "")) / "Google" / "Chrome" / "User Data"),
    ("edge", Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "Edge" / "User Data"),
    ("brave", Path(os.environ.get("LOCALAPPDATA", "")) / "BraveSoftware" / "Brave-Browser" / "User Data"),
)

SCAN_SUFFIXES = (".ldb", ".log")
SCAN_PREFIXES = ("MANIFEST-",)
MAX_BRACE_SEARCH = 512
MAX_TEXT_BYTES = 8 * 1024 * 1024


@dataclass
class CandidateDir:
    browser: str
    profile: str
    extension_id: str
    storage_dir: Path
    latest_write_ts: float
    detected_keys: set[str]


def is_profile_dir(path: Path) -> bool:
    name = path.name
    return (
        name == "Default"
        or name == "Guest Profile"
        or name == "Profile"
        or name.startswith("Profile ")
    )


def iter_storage_files(storage_dir: Path) -> list[Path]:
    files: list[Path] = []
    for path in storage_dir.iterdir():
        if not path.is_file():
            continue
        if path.suffix.lower() in SCAN_SUFFIXES or any(path.name.startswith(prefix) for prefix in SCAN_PREFIXES):
            files.append(path)
    return sorted(files, key=lambda item: item.stat().st_mtime, reverse=True)


def decode_file_text(path: Path) -> str:
    raw = path.read_bytes()
    if len(raw) > MAX_TEXT_BYTES:
        raw = raw[:MAX_TEXT_BYTES]
    return raw.decode("utf-8", errors="ignore")


def extract_balanced_json(text: str, start: int) -> str | None:
    opener = text[start]
    if opener not in "{[":
        return None
    closer = "}" if opener == "{" else "]"
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        ch = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            continue
        if ch == opener:
            depth += 1
        elif ch == closer:
            depth -= 1
            if depth == 0:
                return text[start:index + 1]
    return None


def expected_json_opener(key: str) -> str:
    return "{" if key == "reload_resume_monitor_state" else "["


def is_plausible_json_start(text: str, index: int) -> bool:
    if index < 0 or index >= len(text):
        return False
    opener = text[index]
    if opener not in "{[":
        return False
    next_char = ""
    for cursor in range(index + 1, min(len(text), index + 12)):
        ch = text[cursor]
        if ch in " \r\n\t":
            continue
        next_char = ch
        break
    if opener == "{":
        return next_char in {'"', "}"}
    return next_char in {'[', '{', '"', "]"}


def find_json_payloads(text: str, key: str) -> list[str]:
    payloads: list[str] = []
    cursor = 0
    preferred_opener = expected_json_opener(key)
    while True:
        hit = text.find(key, cursor)
        if hit < 0:
            break
        cursor = hit + len(key)
        search_end = min(len(text), cursor + MAX_BRACE_SEARCH)
        start = -1
        for index in range(cursor, search_end):
            if text[index] == preferred_opener and is_plausible_json_start(text, index):
                start = index
                break
        if start < 0:
            for index in range(cursor, search_end):
                if text[index] in "[{" and is_plausible_json_start(text, index):
                    start = index
                    break
        if start < 0:
            continue
        payload = extract_balanced_json(text, start)
        if payload:
            payloads.append(payload)
    return payloads


def discover_candidates() -> list[CandidateDir]:
    candidates: list[CandidateDir] = []
    for browser, root in DATA_ROOTS:
        if not root.exists():
            continue
        for profile_dir in root.iterdir():
            if not profile_dir.is_dir() or not is_profile_dir(profile_dir):
                continue
            local_extension_settings = profile_dir / "Local Extension Settings"
            if not local_extension_settings.exists():
                continue
            for extension_dir in local_extension_settings.iterdir():
                if not extension_dir.is_dir():
                    continue
                detected_keys: set[str] = set()
                latest_write_ts = 0.0
                files = iter_storage_files(extension_dir)
                if not files:
                    continue
                for file_path in files[:8]:
                    try:
                        file_stat = file_path.stat()
                        latest_write_ts = max(latest_write_ts, file_stat.st_mtime)
                        text = decode_file_text(file_path)
                    except OSError:
                        continue
                    for key in TARGET_KEYS:
                        if key in text:
                            detected_keys.add(key)
                    if detected_keys == set(TARGET_KEYS):
                        break
                if detected_keys:
                    candidates.append(
                        CandidateDir(
                            browser=browser,
                            profile=profile_dir.name,
                            extension_id=extension_dir.name,
                            storage_dir=extension_dir,
                            latest_write_ts=latest_write_ts,
                            detected_keys=detected_keys,
                        )
                    )
    return sorted(candidates, key=lambda item: item.latest_write_ts, reverse=True)


def choose_candidate(candidates: list[CandidateDir], extension_id: str | None = None) -> CandidateDir | None:
    if extension_id:
        for candidate in candidates:
            if candidate.extension_id == extension_id:
                return candidate
        return None
    if not candidates:
        return None
    complete = [candidate for candidate in candidates if candidate.detected_keys == set(TARGET_KEYS)]
    return complete[0] if complete else candidates[0]


def parse_json_payload(payload: str) -> Any:
    try:
        return json.loads(payload)
    except json.JSONDecodeError:
        sanitized = "".join(
            ch for ch in payload
            if ch in "\r\n\t" or ord(ch) >= 32
        )
        try:
            return json.loads(sanitized)
        except json.JSONDecodeError:
            return None


def expected_key_type(key: str) -> type[Any]:
    if key == "reload_resume_monitor_state":
        return dict
    return list


def extract_state(candidate: CandidateDir) -> dict[str, Any]:
    files = iter_storage_files(candidate.storage_dir)
    key_matches: dict[str, list[dict[str, Any]]] = {key: [] for key in TARGET_KEYS}
    for file_path in files:
        try:
            file_stat = file_path.stat()
            text = decode_file_text(file_path)
        except OSError:
            continue
        for key in TARGET_KEYS:
            payloads = find_json_payloads(text, key)
            if not payloads:
                continue
            for payload in payloads:
                parsed = parse_json_payload(payload)
                key_matches[key].append(
                    {
                        "file": str(file_path),
                        "mtime": datetime.fromtimestamp(file_stat.st_mtime, tz=timezone.utc).isoformat(),
                        "payload_length": len(payload),
                        "parsed": parsed,
                        "raw": payload if parsed is None else None,
                    }
                )

    latest_by_key: dict[str, Any] = {}
    for key, matches in key_matches.items():
        if not matches:
            latest_by_key[key] = None
            continue
        expected_type = expected_key_type(key)
        parsed_matches = [
            match for match in matches
            if isinstance(match.get("parsed"), expected_type)
        ]
        selected = parsed_matches[0] if parsed_matches else matches[0]
        selected = dict(selected)
        selected["match_count"] = len(matches)
        selected["parsed_match_count"] = len(parsed_matches)
        latest_by_key[key] = selected

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": {
            "browser": candidate.browser,
            "profile": candidate.profile,
            "extension_id": candidate.extension_id,
            "storage_dir": str(candidate.storage_dir),
            "latest_write": datetime.fromtimestamp(candidate.latest_write_ts, tz=timezone.utc).isoformat(),
            "detected_keys": sorted(candidate.detected_keys),
        },
        "keys": latest_by_key,
    }


def write_output(payload: dict[str, Any], output_dir: Path) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    timestamped_path = output_dir / f"extension-storage-{timestamp}.json"
    latest_path = output_dir / "latest.json"
    content = json.dumps(payload, ensure_ascii=False, indent=2)
    timestamped_path.write_text(content, encoding="utf-8")
    latest_path.write_text(content, encoding="utf-8")
    return latest_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--extension-id", default="", help="Optional exact extension id to prefer.")
    parser.add_argument(
        "--output-dir",
        default=str(Path(__file__).resolve().parents[1] / "out" / "extension-storage-export"),
        help="Directory for exported JSON snapshots.",
    )
    args = parser.parse_args()

    candidates = discover_candidates()
    if not candidates:
        raise SystemExit("No extension storage directories with target keys were found.")

    candidate = choose_candidate(candidates, args.extension_id.strip() or None)
    if candidate is None:
        raise SystemExit(f"Extension id not found: {args.extension_id}")

    payload = extract_state(candidate)
    latest_path = write_output(payload, Path(args.output_dir))
    print(str(latest_path))
    print(json.dumps(payload["source"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
