import argparse
import ipaddress
import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, request


APP_VERSION = "0.1.0"
DEFAULT_HOST = os.getenv("ISKRA_LOCAL_RUNNER_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.getenv("ISKRA_LOCAL_RUNNER_PORT", "8787"))
DEFAULT_STATE_PATH = Path(os.getenv(
    "ISKRA_LOCAL_RUNNER_STATE_FILE",
    str(Path(__file__).with_name("local_runner_state.json")),
))
STALE_AFTER_SECONDS = int(os.getenv("ISKRA_LOCAL_RUNNER_STALE_AFTER_SECONDS", "90"))
OFFLINE_AFTER_SECONDS = int(os.getenv("ISKRA_LOCAL_RUNNER_OFFLINE_AFTER_SECONDS", "180"))
ALLOWED_CONTROLLER_IDS = {
    item.strip()
    for item in os.getenv("ISKRA_ALLOWED_CONTROLLER_IDS", "").split(",")
    if item.strip()
}
CGNAT_NETWORK = ipaddress.ip_network("100.64.0.0/10")
OPEN_JOB_STATUSES = {"pending", "claimed", "received", "started"}
FINAL_JOB_STATUSES = {"completed", "failed"}

app = Flask(__name__)
state_lock = threading.Lock()
STATE_PATH = DEFAULT_STATE_PATH


def utc_now():
    return datetime.now(timezone.utc)


def utc_now_iso():
    return utc_now().isoformat()


def parse_iso_timestamp(raw_value):
    text = str(raw_value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def age_seconds_from_timestamp(raw_value):
    parsed = parse_iso_timestamp(raw_value)
    if not parsed:
        return None
    age = int((utc_now() - parsed).total_seconds())
    return max(0, age)


def default_state():
    return {"runners": {}, "jobs": {}}


def load_state():
    if not STATE_PATH.exists():
        return default_state()
    try:
        payload = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default_state()
    if not isinstance(payload, dict):
        return default_state()
    runners = payload.get("runners")
    jobs = payload.get("jobs")
    return {
        "runners": runners if isinstance(runners, dict) else {},
        "jobs": jobs if isinstance(jobs, dict) else {},
    }


def save_state(state):
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp_path = STATE_PATH.with_suffix(".tmp")
    temp_path.write_text(json.dumps(state, ensure_ascii=True, indent=2), encoding="utf-8")
    temp_path.replace(STATE_PATH)


def is_private_client_address(raw_address):
    text = str(raw_address or "").strip()
    if not text:
        return False
    try:
        ip_value = ipaddress.ip_address(text)
    except ValueError:
        return False
    if ip_value.is_loopback or ip_value.is_private or ip_value.is_link_local:
        return True
    if isinstance(ip_value, ipaddress.IPv4Address) and ip_value in CGNAT_NETWORK:
        return True
    return False


def reject_untrusted_client():
    return jsonify({
        "success": False,
        "detail": "local_runner_client_not_allowed",
    }), 403


def normalize_runner_record(payload):
    if not isinstance(payload, dict):
        return None
    runner_id = str(payload.get("runnerId") or "").strip()
    if not runner_id:
        return None
    record = {
        "runner_id": runner_id,
        "runner_name": str(payload.get("runnerName") or runner_id).strip() or runner_id,
        "enabled": payload.get("enabled") is True,
        "prompts_loaded": payload.get("promptsLoaded") is True,
        "prompt_hash": str(payload.get("promptHash") or "").strip(),
        "chatgpt_ready": payload.get("chatgptReady") is True,
        "active_job_id": str(payload.get("activeJobId") or "").strip(),
        "active_job_status": "",
        "last_seen_at": utc_now_iso(),
        "updated_at": utc_now_iso(),
    }
    return record


def normalize_job_view(job_record, state):
    if not isinstance(job_record, dict):
        return None
    runner_id = str(job_record.get("runner_id") or "").strip()
    runner_record = state.get("runners", {}).get(runner_id)
    heartbeat_age_seconds = age_seconds_from_timestamp(runner_record.get("last_seen_at")) if isinstance(runner_record, dict) else None
    is_stale = False
    if heartbeat_age_seconds is not None and str(job_record.get("status") or "").strip().lower() in OPEN_JOB_STATUSES:
        is_stale = heartbeat_age_seconds > STALE_AFTER_SECONDS
    return {
        "job_id": str(job_record.get("job_id") or "").strip(),
        "controller_id": str(job_record.get("controller_id") or "").strip(),
        "runner_id": runner_id,
        "status": str(job_record.get("status") or "").strip().lower(),
        "request_payload": job_record.get("request_payload") if isinstance(job_record.get("request_payload"), dict) else None,
        "result_payload": job_record.get("result_payload") if isinstance(job_record.get("result_payload"), dict) else None,
        "error": str(job_record.get("error") or "").strip(),
        "created_at": str(job_record.get("created_at") or "").strip(),
        "claimed_at": str(job_record.get("claimed_at") or "").strip(),
        "received_at": str(job_record.get("received_at") or "").strip(),
        "started_at": str(job_record.get("started_at") or "").strip(),
        "heartbeat_at": str(job_record.get("heartbeat_at") or "").strip(),
        "completed_at": str(job_record.get("completed_at") or "").strip(),
        "updated_at": str(job_record.get("updated_at") or "").strip(),
        "heartbeat_age_seconds": heartbeat_age_seconds,
        "is_stale": is_stale,
    }


def normalize_runner_view(runner_record, state):
    if not isinstance(runner_record, dict):
        return None
    runner_id = str(runner_record.get("runner_id") or "").strip()
    active_job_id = str(runner_record.get("active_job_id") or "").strip()
    active_job = state.get("jobs", {}).get(active_job_id) if active_job_id else None
    active_job_status = (
        str(active_job.get("status") or "").strip().lower()
        if isinstance(active_job, dict)
        else str(runner_record.get("active_job_status") or "").strip().lower()
    )
    if active_job_status in FINAL_JOB_STATUSES:
        active_job_id = ""
        active_job_status = ""
    age_seconds = age_seconds_from_timestamp(runner_record.get("last_seen_at"))
    enabled = runner_record.get("enabled") is True
    prompts_loaded = runner_record.get("prompts_loaded") is True
    chatgpt_ready = runner_record.get("chatgpt_ready") is True
    is_online = age_seconds is not None and age_seconds <= OFFLINE_AFTER_SECONDS
    is_stale = age_seconds is not None and STALE_AFTER_SECONDS < age_seconds <= OFFLINE_AFTER_SECONDS
    accepts_remote_jobs = enabled and prompts_loaded and chatgpt_ready and is_online and not active_job_id
    if not is_online:
        status = "offline"
    elif active_job_id:
        status = "busy"
    elif is_stale:
        status = "stale"
    elif accepts_remote_jobs:
        status = "ready"
    else:
        status = "online"
    return {
        "runner_id": runner_id,
        "runner_name": str(runner_record.get("runner_name") or runner_id).strip() or runner_id,
        "enabled": enabled,
        "prompts_loaded": prompts_loaded,
        "prompt_hash": str(runner_record.get("prompt_hash") or "").strip(),
        "chatgpt_ready": chatgpt_ready,
        "active_job_id": active_job_id or None,
        "active_job_status": active_job_status or None,
        "last_seen_at": str(runner_record.get("last_seen_at") or "").strip(),
        "updated_at": str(runner_record.get("updated_at") or "").strip(),
        "last_seen_age_seconds": age_seconds,
        "accepts_remote_jobs": accepts_remote_jobs,
        "is_online": is_online,
        "status": status,
    }


def update_runner_job_binding(state, runner_id, job_id, status):
    runner_record = state.get("runners", {}).get(runner_id)
    if not isinstance(runner_record, dict):
        return
    runner_record["active_job_id"] = job_id or ""
    runner_record["active_job_status"] = status or ""
    runner_record["updated_at"] = utc_now_iso()
    if not job_id or status in FINAL_JOB_STATUSES:
        runner_record["active_job_id"] = ""
        runner_record["active_job_status"] = ""


@app.before_request
def guard_private_network():
    if not request.path.startswith("/api/v1/local-runner/"):
        return None
    if request.method == "OPTIONS":
        return app.make_default_options_response()
    if is_private_client_address(request.remote_addr):
        return None
    return reject_untrusted_client()


@app.after_request
def add_cors_headers(response):
    if request.path.startswith("/api/v1/local-runner/"):
        response.headers["Access-Control-Allow-Origin"] = "*"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
    return response


@app.get("/api/v1/local-runner/health")
def local_runner_health():
    return jsonify({
        "success": True,
        "version": APP_VERSION,
        "stateFile": str(STATE_PATH),
    })


@app.get("/api/v1/local-runner/runner/<runner_id>/status")
def get_runner_status(runner_id):
    with state_lock:
        state = load_state()
        runner_record = state["runners"].get(str(runner_id).strip())
        runner_view = normalize_runner_view(runner_record, state)
    if not runner_view:
        return jsonify({"success": False, "detail": "runner_not_found"}), 404
    return jsonify({"success": True, "runner": runner_view})


@app.post("/api/v1/local-runner/runner/heartbeat")
def post_runner_heartbeat():
    payload = request.get_json(silent=True) or {}
    runner_record = normalize_runner_record(payload)
    if not runner_record:
        return jsonify({"success": False, "detail": "runner_id_missing"}), 400
    runner_id = runner_record["runner_id"]
    with state_lock:
        state = load_state()
        existing = state["runners"].get(runner_id)
        if isinstance(existing, dict):
            existing.update(runner_record)
            runner_record = existing
        state["runners"][runner_id] = runner_record
        active_job = state["jobs"].get(runner_record.get("active_job_id") or "")
        if isinstance(active_job, dict):
            runner_record["active_job_status"] = str(active_job.get("status") or "").strip().lower()
        save_state(state)
        runner_view = normalize_runner_view(runner_record, state)
    return jsonify({"success": True, "runner": runner_view})


@app.post("/api/v1/local-runner/remote-jobs")
def create_remote_job():
    payload = request.get_json(silent=True) or {}
    controller_id = str(payload.get("controllerId") or "").strip()
    runner_id = str(payload.get("runnerId") or "").strip()
    request_payload = payload.get("requestPayload") if isinstance(payload.get("requestPayload"), dict) else None
    if not controller_id:
        return jsonify({"success": False, "reason": "controller_id_missing"}), 400
    if not runner_id:
        return jsonify({"success": False, "reason": "runner_id_missing"}), 400
    if not request_payload:
        return jsonify({"success": False, "reason": "invalid_remote_job_payload"}), 400
    if ALLOWED_CONTROLLER_IDS and controller_id not in ALLOWED_CONTROLLER_IDS:
        return jsonify({"success": False, "reason": "controller_not_allowed"}), 403

    with state_lock:
        state = load_state()
        runner_record = state["runners"].get(runner_id)
        runner_view = normalize_runner_view(runner_record, state)
        if not runner_view:
            return jsonify({"success": False, "reason": "runner_not_found"}), 404
        if runner_view["status"] != "ready" or runner_view["accepts_remote_jobs"] is not True:
            return jsonify({
                "success": False,
                "reason": f"runner_{runner_view['status'] or 'not_ready'}",
                "runner": runner_view,
            })
        job_id = f"local-job-{uuid.uuid4()}"
        created_at = utc_now_iso()
        state["jobs"][job_id] = {
            "job_id": job_id,
            "controller_id": controller_id,
            "runner_id": runner_id,
            "status": "pending",
            "request_payload": request_payload,
            "result_payload": None,
            "error": "",
            "created_at": created_at,
            "claimed_at": "",
            "received_at": "",
            "started_at": "",
            "heartbeat_at": "",
            "completed_at": "",
            "updated_at": created_at,
        }
        save_state(state)
        job_view = normalize_job_view(state["jobs"][job_id], state)
        runner_view = normalize_runner_view(state["runners"].get(runner_id), state)
    return jsonify({"success": True, "job": job_view, "runner": runner_view})


@app.get("/api/v1/local-runner/remote-jobs/<job_id>")
def get_remote_job(job_id):
    with state_lock:
        state = load_state()
        job_record = state["jobs"].get(str(job_id).strip())
        job_view = normalize_job_view(job_record, state)
    if not job_view:
        return jsonify({"success": False, "detail": "job_not_found"}), 404
    return jsonify({"success": True, "job": job_view})


@app.post("/api/v1/local-runner/remote-jobs/claim")
def claim_remote_job():
    payload = request.get_json(silent=True) or {}
    runner_id = str(payload.get("runnerId") or "").strip()
    if not runner_id:
        return jsonify({"success": False, "detail": "runner_id_missing"}), 400
    with state_lock:
        state = load_state()
        candidates = [
            item for item in state["jobs"].values()
            if isinstance(item, dict)
            and str(item.get("runner_id") or "").strip() == runner_id
            and str(item.get("status") or "").strip().lower() == "pending"
        ]
        candidates.sort(key=lambda item: str(item.get("created_at") or ""))
        if not candidates:
            return jsonify({"success": True, "claimed": False, "job": None})
        job_record = candidates[0]
        now_iso = utc_now_iso()
        job_record["status"] = "claimed"
        job_record["claimed_at"] = now_iso
        job_record["updated_at"] = now_iso
        update_runner_job_binding(state, runner_id, job_record["job_id"], "claimed")
        save_state(state)
        job_view = normalize_job_view(job_record, state)
    return jsonify({"success": True, "claimed": True, "job": job_view})


@app.post("/api/v1/local-runner/remote-jobs/<job_id>/event")
def post_remote_job_event(job_id):
    payload = request.get_json(silent=True) or {}
    event_name = str(payload.get("event") or "").strip().lower()
    runner_id = str(payload.get("runnerId") or "").strip()
    if not event_name:
        return jsonify({"success": False, "detail": "event_missing"}), 400

    with state_lock:
        state = load_state()
        job_record = state["jobs"].get(str(job_id).strip())
        if not isinstance(job_record, dict):
            return jsonify({"success": False, "detail": "job_not_found"}), 404
        stored_runner_id = str(job_record.get("runner_id") or "").strip()
        effective_runner_id = runner_id or stored_runner_id
        if runner_id and stored_runner_id and runner_id != stored_runner_id:
            return jsonify({"success": False, "detail": "runner_id_mismatch"}), 409

        now_iso = utc_now_iso()
        job_record["updated_at"] = now_iso
        if event_name == "received":
            job_record["status"] = "received"
            job_record["received_at"] = now_iso
            job_record["heartbeat_at"] = now_iso
            update_runner_job_binding(state, effective_runner_id, job_record["job_id"], "received")
        elif event_name == "started":
            job_record["status"] = "started"
            job_record["started_at"] = now_iso
            job_record["heartbeat_at"] = now_iso
            update_runner_job_binding(state, effective_runner_id, job_record["job_id"], "started")
        elif event_name == "heartbeat":
            if str(job_record.get("status") or "").strip().lower() not in FINAL_JOB_STATUSES:
                job_record["heartbeat_at"] = now_iso
        elif event_name == "completed":
            job_record["status"] = "completed"
            job_record["completed_at"] = now_iso
            job_record["heartbeat_at"] = now_iso
            job_record["result_payload"] = payload.get("resultPayload") if isinstance(payload.get("resultPayload"), dict) else None
            job_record["error"] = ""
            update_runner_job_binding(state, effective_runner_id, "", "")
        elif event_name == "failed":
            job_record["status"] = "failed"
            job_record["completed_at"] = now_iso
            job_record["heartbeat_at"] = now_iso
            job_record["result_payload"] = payload.get("resultPayload") if isinstance(payload.get("resultPayload"), dict) else None
            job_record["error"] = str(payload.get("error") or "remote_job_failed").strip()
            update_runner_job_binding(state, effective_runner_id, "", "")
        else:
            return jsonify({"success": False, "detail": "event_not_supported"}), 400

        save_state(state)
        job_view = normalize_job_view(job_record, state)
    return jsonify({"success": True, "job": job_view})


def parse_args():
    parser = argparse.ArgumentParser(description="Iskra local relay server for Remote Runner local mode")
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"Bind host (default: {DEFAULT_HOST})")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"Bind port (default: {DEFAULT_PORT})")
    parser.add_argument(
        "--state-file",
        default=str(DEFAULT_STATE_PATH),
        help=f"Path to JSON state file (default: {DEFAULT_STATE_PATH})",
    )
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    STATE_PATH = Path(args.state_file)
    app.run(host=args.host, port=args.port, debug=False)
