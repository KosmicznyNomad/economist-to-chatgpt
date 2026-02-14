#!/usr/bin/env python3
import hashlib
import json
import os
import sys
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def env_flag(name, default=False):
    raw = os.getenv(name)
    if raw is None:
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


def env_int(name, default):
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(str(raw).strip())
    except Exception:
        return default


def trim(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)


def read_json(path):
    if not path or not os.path.exists(path):
        return {}
    with open(path, "r", encoding="utf-8-sig") as file:
        try:
            return json.load(file)
        except Exception:
            return {}


def set_output(key, value):
    output_path = os.getenv("GITHUB_OUTPUT")
    if not output_path:
        return
    with open(output_path, "a", encoding="utf-8") as file:
        file.write(f"{key}={value}\n")


def github_api_json(url, token, timeout_sec=20):
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "economist-to-chatgpt-relay",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"

    request_obj = Request(url, headers=headers, method="GET")
    with urlopen(request_obj, timeout=timeout_sec) as response:
        body = response.read().decode("utf-8")
        return json.loads(body)


def check_marker_exists(repository, token, marker_name):
    if not repository:
        return {"checked": False, "duplicate": False, "reason": "missing_repository"}
    if not token:
        return {"checked": False, "duplicate": False, "reason": "missing_token"}

    page = 1
    timeout_sec = max(5, env_int("GITHUB_API_TIMEOUT_SEC", 20))
    while page <= 20:
        url = f"https://api.github.com/repos/{repository}/actions/artifacts?per_page=100&page={page}"
        try:
            payload = github_api_json(url, token, timeout_sec=timeout_sec)
        except Exception as error:
            return {
                "checked": False,
                "duplicate": False,
                "reason": f"marker_check_failed: {error}",
            }
        artifacts = payload.get("artifacts") or []
        if not artifacts:
            break

        for artifact in artifacts:
            if artifact.get("name") != marker_name:
                continue
            if artifact.get("expired"):
                continue
            return {
                "checked": True,
                "duplicate": True,
                "reason": "marker_exists",
                "artifactId": artifact.get("id"),
                "createdAt": artifact.get("created_at"),
                "expiresAt": artifact.get("expires_at"),
            }

        if len(artifacts) < 100:
            break
        page += 1

    return {"checked": True, "duplicate": False, "reason": "marker_not_found"}


def build_monitoring_headers():
    headers = {"Content-Type": "application/json"}
    api_key = trim(os.getenv("MONITORING_API_KEY"))
    key_header = trim(os.getenv("MONITORING_API_KEY_HEADER")) or "Authorization"
    if api_key:
        if key_header.lower() == "authorization":
            headers["Authorization"] = f"Bearer {api_key}"
        else:
            headers[key_header] = api_key
    return headers


def send_to_monitoring(payload):
    url = trim(os.getenv("MONITORING_API_URL"))
    required = env_flag("MONITORING_API_REQUIRED", False)
    timeout_sec = max(5, env_int("MONITORING_TIMEOUT_SEC", 15))
    retry_count = max(0, env_int("MONITORING_RETRY_COUNT", 2))
    backoff_sec = max(0, env_int("MONITORING_BACKOFF_SEC", 2))

    if not url:
        state = "failed" if required else "skipped"
        return {
            "state": state,
            "reason": "missing_monitoring_api_url",
            "statusCode": None,
            "attempts": 0,
        }

    headers = build_monitoring_headers()
    body = json.dumps(payload).encode("utf-8")
    attempts_total = retry_count + 1
    last_error = ""
    last_status = None

    for attempt in range(1, attempts_total + 1):
        try:
            request_obj = Request(url, data=body, headers=headers, method="POST")
            with urlopen(request_obj, timeout=timeout_sec) as response:
                response_body = response.read().decode("utf-8", errors="replace")
                last_status = response.status
                if 200 <= response.status < 300:
                    return {
                        "state": "delivered",
                        "reason": "ok",
                        "statusCode": response.status,
                        "attempts": attempt,
                        "responseBodyPreview": response_body[:400],
                    }
                last_error = f"HTTP {response.status}: {response_body[:400]}"
        except HTTPError as error:
            details = ""
            try:
                details = error.read().decode("utf-8", errors="replace")
            except Exception:
                details = str(error)
            last_status = error.code
            last_error = f"HTTP {error.code}: {details[:400]}"
        except URLError as error:
            last_status = None
            last_error = f"URLError: {error.reason}"
        except Exception as error:
            last_status = None
            last_error = str(error)

        if attempt < attempts_total:
            time.sleep(backoff_sec * attempt)

    return {
        "state": "failed",
        "reason": "delivery_failed",
        "statusCode": last_status,
        "attempts": attempts_total,
        "error": last_error,
    }


def build_safe_name(value, fallback):
    raw = trim(value)
    if not raw:
        return fallback
    safe = "".join(ch if ch.isalnum() or ch in {"-", "_", "."} else "_" for ch in raw)
    safe = safe.strip("._")
    if not safe:
        return fallback
    return safe[:80]


def main():
    artifact_dir = trim(os.getenv("RELAY_ARTIFACT_DIR")) or ".relay"
    os.makedirs(artifact_dir, exist_ok=True)

    run_file = os.path.join(artifact_dir, "run.json")
    last_run_file = os.path.join(artifact_dir, "last_run.json")
    delivery_file = os.path.join(artifact_dir, "delivery_status.json")
    marker_file = os.path.join(artifact_dir, "marker.json")

    # Default outputs so downstream artifact steps can run even when validation fails.
    set_output("artifact_dir", artifact_dir)
    set_output("marker_file", marker_file)
    set_output("write_marker", "false")
    set_output("duplicate", "false")
    set_output("validation_ok", "false")
    set_output("delivery_state", "unknown")

    event_path = os.getenv("GITHUB_EVENT_PATH", "")
    event_payload = read_json(event_path)
    client_payload = event_payload.get("client_payload") or {}
    if not isinstance(client_payload, dict):
        client_payload = {}

    run_id = trim(client_payload.get("runId"))
    response_id = trim(client_payload.get("responseId"))
    text = trim(client_payload.get("text"))
    validation_errors = []
    if not run_id:
        validation_errors.append("missing runId")
    if not response_id:
        validation_errors.append("missing responseId")
    if not text:
        validation_errors.append("missing text")

    safe_run = build_safe_name(run_id, "run")
    safe_response = build_safe_name(response_id, "response")
    trace_artifact_name = f"relay-trace-{safe_run}-{safe_response}-{int(time.time())}"
    set_output("trace_artifact_name", trace_artifact_name)

    dedupe_key = f"{run_id}::{response_id}"
    dedupe_hash = hashlib.sha256(dedupe_key.encode("utf-8")).hexdigest() if run_id and response_id else ""
    marker_artifact_name = f"relay-marker-{dedupe_hash[:40]}" if dedupe_hash else "relay-marker-invalid"
    set_output("marker_artifact_name", marker_artifact_name)

    validation_ok = len(validation_errors) == 0
    duplicate = False
    idempotency = {
        "key": dedupe_key,
        "hash": dedupe_hash,
        "markerArtifactName": marker_artifact_name,
        "checked": False,
        "duplicate": False,
        "reason": "not_checked",
    }

    delivery = {
        "state": "skipped",
        "reason": "validation_failed",
        "statusCode": None,
        "attempts": 0,
    }
    monitoring_required = env_flag("MONITORING_API_REQUIRED", False)
    should_write_marker = False
    fail_workflow = False

    if validation_ok:
        repository = trim(os.getenv("GITHUB_REPOSITORY"))
        token = trim(os.getenv("GITHUB_TOKEN"))
        marker_check = check_marker_exists(repository, token, marker_artifact_name)
        duplicate = bool(marker_check.get("duplicate"))
        idempotency.update(marker_check)
        idempotency["key"] = dedupe_key
        idempotency["hash"] = dedupe_hash
        idempotency["markerArtifactName"] = marker_artifact_name

        if duplicate:
            delivery = {
                "state": "duplicate",
                "reason": "already_processed",
                "statusCode": None,
                "attempts": 0,
            }
        else:
            monitoring_payload = {
                "runId": run_id,
                "responseId": response_id,
                "source": trim(client_payload.get("source")) or None,
                "analysisType": trim(client_payload.get("analysisType")) or None,
                "text": client_payload.get("text"),
                "textLength": client_payload.get("textLength"),
                "timestamp": client_payload.get("timestamp"),
                "receivedAt": client_payload.get("receivedAt"),
                "savedAt": client_payload.get("savedAt"),
                "extensionVersion": client_payload.get("extensionVersion"),
                "stage": client_payload.get("stage"),
                "meta": client_payload.get("meta"),
                "backendResponseDbId": client_payload.get("backendResponseDbId"),
                "relay": {
                    "receivedAt": now_iso(),
                    "githubRepository": trim(os.getenv("GITHUB_REPOSITORY")),
                    "githubRunId": trim(os.getenv("GITHUB_RUN_ID")),
                    "githubRunAttempt": trim(os.getenv("GITHUB_RUN_ATTEMPT")),
                    "githubWorkflow": trim(os.getenv("GITHUB_WORKFLOW")),
                },
            }
            delivery = send_to_monitoring(monitoring_payload)
            should_write_marker = delivery.get("state") == "delivered"

            if monitoring_required and delivery.get("state") != "delivered":
                fail_workflow = True
    else:
        fail_workflow = True

    trace = {
        "processedAt": now_iso(),
        "event": {
            "name": trim(os.getenv("GITHUB_EVENT_NAME")),
            "action": event_payload.get("action"),
            "repository": trim(os.getenv("GITHUB_REPOSITORY")),
            "runId": trim(os.getenv("GITHUB_RUN_ID")),
            "runAttempt": trim(os.getenv("GITHUB_RUN_ATTEMPT")),
        },
        "validation": {
            "ok": validation_ok,
            "errors": validation_errors,
        },
        "idempotency": idempotency,
        "delivery": delivery,
        "payload": client_payload,
    }
    summary = {
        "processedAt": trace["processedAt"],
        "runId": run_id or None,
        "responseId": response_id or None,
        "validationOk": validation_ok,
        "duplicate": duplicate,
        "deliveryState": delivery.get("state"),
        "deliveryReason": delivery.get("reason"),
        "markerArtifactName": marker_artifact_name,
    }

    write_json(run_file, trace)
    write_json(last_run_file, summary)
    write_json(delivery_file, delivery)

    if should_write_marker:
        write_json(
            marker_file,
            {
                "processedAt": now_iso(),
                "runId": run_id,
                "responseId": response_id,
                "dedupeKey": dedupe_key,
                "dedupeHash": dedupe_hash,
                "workflowRunId": trim(os.getenv("GITHUB_RUN_ID")),
                "deliveryState": delivery.get("state"),
            },
        )

    set_output("validation_ok", "true" if validation_ok else "false")
    set_output("duplicate", "true" if duplicate else "false")
    set_output("delivery_state", trim(delivery.get("state")) or "unknown")
    set_output("write_marker", "true" if should_write_marker else "false")

    if fail_workflow:
        print("Relay failed", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
