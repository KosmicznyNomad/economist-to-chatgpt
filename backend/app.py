from flask import Flask, request, jsonify
import os
import sqlite3
import json
import re
import uuid
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from datetime import datetime, timezone

APP_VERSION = "0.2.0"


def env_flag(name, default=False):
    raw = os.getenv(name)
    if raw is None:
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}

DB_PATH = os.getenv("DB_PATH", "data/responses.db")
API_KEY = os.getenv("API_KEY", "")
API_KEY_HEADER = os.getenv("API_KEY_HEADER", "Authorization")
TWELVEDATA_API_KEY = os.getenv("TWELVEDATA_API_KEY", "")
TWELVEDATA_BASE_URL = os.getenv("TWELVEDATA_BASE_URL", "https://api.twelvedata.com")
GITHUB_DISPATCH_ENABLED = env_flag("GITHUB_DISPATCH_ENABLED", False)
GITHUB_DISPATCH_REQUIRED = env_flag("GITHUB_DISPATCH_REQUIRED", False)
GITHUB_DISPATCH_TOKEN = os.getenv("GITHUB_DISPATCH_TOKEN", "")
GITHUB_DISPATCH_REPOSITORY = os.getenv("GITHUB_DISPATCH_REPOSITORY", os.getenv("GITHUB_REPOSITORY", ""))
GITHUB_DISPATCH_EVENT_TYPE = os.getenv("GITHUB_DISPATCH_EVENT_TYPE", "analysis_response")
GITHUB_API_BASE_URL = os.getenv("GITHUB_API_BASE_URL", "https://api.github.com").rstrip("/")
GITHUB_DISPATCH_TIMEOUT_SEC = int(os.getenv("GITHUB_DISPATCH_TIMEOUT_SEC", "15"))

app = Flask(__name__)

FOUR_GATE_FIELDS = [
    "Data decyzji",
    "Status decyzji",
    "Spolka",
    "Krotkie streszczenie tezy",
    "Material zrodlowy",
    "Teza inwestycyjna",
    "Watpliwosci/ryzyka",
    "Gate rating",
    "Asymetria/Divergence",
    "VOI/Falsifiers",
    "Sektor",
    "Region",
    "Waluta",
    "WHY BUY",
    "WHY AVOID",
]

FOUR_GATE_COLUMNS = [
    "decision_date",
    "decision_status",
    "company",
    "short_thesis",
    "source_material",
    "investment_thesis",
    "concerns",
    "gate_rating",
    "asymmetry_divergence",
    "voi_falsifiers",
    "sector",
    "region",
    "currency",
    "why_buy",
    "why_avoid",
]

FOUR_GATE_TABLE_COLUMNS = [
    "response_id",
    "run_id",
    "source",
    "analysis_type",
    "created_at",
    "received_at",
    *FOUR_GATE_COLUMNS,
    "raw_line",
]


def ensure_column(conn, table_name, column_name, column_type):
    columns = [row[1] for row in conn.execute(f"PRAGMA table_info({table_name})").fetchall()]
    if column_name not in columns:
        conn.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_type}")


def ensure_db():
    db_dir = os.path.dirname(DB_PATH)
    if db_dir and not os.path.exists(db_dir):
        os.makedirs(db_dir, exist_ok=True)

    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS responses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            response_id TEXT,
            run_id TEXT,
            source TEXT,
            analysis_type TEXT,
            text TEXT NOT NULL,
            text_length INTEGER NOT NULL,
            created_at TEXT,
            received_at TEXT NOT NULL,
            stage_index INTEGER,
            stage_name TEXT,
            stage_duration_ms INTEGER,
            stage_word_count INTEGER,
            formatted_text TEXT
        )
        """
    )
    ensure_column(conn, "responses", "response_id", "TEXT")
    ensure_column(conn, "responses", "formatted_text", "TEXT")
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_responses_response_id ON responses(response_id)")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS four_gate_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            response_id INTEGER NOT NULL,
            run_id TEXT,
            source TEXT,
            analysis_type TEXT,
            created_at TEXT,
            received_at TEXT NOT NULL,
            decision_date TEXT,
            decision_status TEXT,
            company TEXT,
            short_thesis TEXT,
            source_material TEXT,
            investment_thesis TEXT,
            concerns TEXT,
            gate_rating TEXT,
            asymmetry_divergence TEXT,
            voi_falsifiers TEXT,
            sector TEXT,
            region TEXT,
            currency TEXT,
            why_buy TEXT,
            why_avoid TEXT,
            raw_line TEXT,
            UNIQUE(response_id),
            FOREIGN KEY(response_id) REFERENCES responses(id)
        )
        """
    )
    four_gate_column_types = {
        "response_id": "INTEGER",
        "run_id": "TEXT",
        "source": "TEXT",
        "analysis_type": "TEXT",
        "created_at": "TEXT",
        "received_at": "TEXT",
        "decision_date": "TEXT",
        "decision_status": "TEXT",
        "company": "TEXT",
        "short_thesis": "TEXT",
        "source_material": "TEXT",
        "investment_thesis": "TEXT",
        "concerns": "TEXT",
        "gate_rating": "TEXT",
        "asymmetry_divergence": "TEXT",
        "voi_falsifiers": "TEXT",
        "sector": "TEXT",
        "region": "TEXT",
        "currency": "TEXT",
        "why_buy": "TEXT",
        "why_avoid": "TEXT",
        "raw_line": "TEXT",
    }
    for column_name in FOUR_GATE_TABLE_COLUMNS:
        ensure_column(conn, "four_gate_records", column_name, four_gate_column_types.get(column_name, "TEXT"))
    conn.commit()
    conn.close()


def parse_timestamp(value):
    if value is None:
        return None
    try:
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value / 1000, tz=timezone.utc).isoformat()
        if isinstance(value, str):
            return value
    except Exception:
        return None
    return None


def parse_four_gate_line_parts(text):
    if not text or not isinstance(text, str):
        return None
    parts = [part.strip() for part in text.split(";")]
    if len(parts) == 16 and parts[-1] == "":
        parts.pop()
    if len(parts) != 15:
        return None
    return parts


def format_four_gate_line(text):
    parts = parse_four_gate_line_parts(text)
    if not parts:
        return None
    lines = []
    for idx, (label, value) in enumerate(zip(FOUR_GATE_FIELDS, parts), start=1):
        lines.append(f"{idx} - {label} - {value}")
    return "\n".join(lines)


def extract_symbol_from_company_field(company_field):
    if not company_field:
        return None
    match = re.search(r"\(([^)]+)\)", company_field)
    if not match:
        return None
    value = match.group(1).strip()
    if not value:
        return None
    if ":" in value:
        return value
    return value.split()[0]


def collect_symbols_from_db(limit=200):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute(
        """
        SELECT text
        FROM responses
        WHERE text IS NOT NULL AND text LIKE '%(%'
        ORDER BY id DESC
        LIMIT ?
        """,
        (limit,)
    )
    rows = cursor.fetchall()
    conn.close()

    symbols = {}
    for (text,) in rows:
        if not text:
            continue
        parts = parse_four_gate_line_parts(text)
        if not parts:
            continue
        company_field = parts[2]
        symbol = extract_symbol_from_company_field(company_field)
        if symbol and symbol not in symbols:
            symbols[symbol] = company_field
    return symbols


def fetch_twelvedata_time_series(symbols):
    if not symbols:
        return {}
    params = {
        "apikey": TWELVEDATA_API_KEY,
        "interval": "1day",
        "outputsize": "2",
        "symbol": ",".join(symbols)
    }
    url = f"{TWELVEDATA_BASE_URL}/time_series?{urlencode(params)}"
    with urlopen(url, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def parse_twelvedata_response(payload):
    if not payload:
        return {}
    if "values" in payload:
        return {payload.get("meta", {}).get("symbol", "UNKNOWN"): payload}
    return payload


def authorize(request_obj):
    if not API_KEY:
        return True
    provided = request_obj.headers.get(API_KEY_HEADER, "")
    if API_KEY_HEADER.lower() == "authorization" and provided.startswith("Bearer "):
        provided = provided[7:]
    return provided == API_KEY


def clean_optional_string(value):
    if value is None:
        return None
    if not isinstance(value, str):
        return str(value)
    trimmed = value.strip()
    return trimmed or None


def dispatch_repository_event(client_payload):
    if not GITHUB_DISPATCH_ENABLED:
        return {"skipped": True, "reason": "dispatch_disabled"}
    if not GITHUB_DISPATCH_TOKEN:
        return {"skipped": True, "reason": "missing_dispatch_token"}
    if not GITHUB_DISPATCH_REPOSITORY:
        return {"skipped": True, "reason": "missing_dispatch_repository"}

    url = f"{GITHUB_API_BASE_URL}/repos/{GITHUB_DISPATCH_REPOSITORY}/dispatches"
    body = json.dumps(
        {
            "event_type": GITHUB_DISPATCH_EVENT_TYPE,
            "client_payload": client_payload,
        }
    ).encode("utf-8")
    request_obj = Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {GITHUB_DISPATCH_TOKEN}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
            "User-Agent": "economist-to-chatgpt-backend",
        },
        method="POST",
    )

    try:
        with urlopen(request_obj, timeout=GITHUB_DISPATCH_TIMEOUT_SEC) as response:
            return {
                "success": True,
                "status": response.status,
                "eventType": GITHUB_DISPATCH_EVENT_TYPE,
                "repository": GITHUB_DISPATCH_REPOSITORY,
            }
    except HTTPError as error:
        details = ""
        try:
            details = error.read().decode("utf-8")
        except Exception:
            details = str(error)
        return {
            "success": False,
            "status": error.code,
            "error": details,
            "eventType": GITHUB_DISPATCH_EVENT_TYPE,
            "repository": GITHUB_DISPATCH_REPOSITORY,
        }
    except URLError as error:
        return {
            "success": False,
            "status": None,
            "error": str(error.reason),
            "eventType": GITHUB_DISPATCH_EVENT_TYPE,
            "repository": GITHUB_DISPATCH_REPOSITORY,
        }
    except Exception as error:
        return {
            "success": False,
            "status": None,
            "error": str(error),
            "eventType": GITHUB_DISPATCH_EVENT_TYPE,
            "repository": GITHUB_DISPATCH_REPOSITORY,
        }


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "version": APP_VERSION})


@app.route("/responses", methods=["POST"])
def save_response():
    if not authorize(request):
        return jsonify({"error": "unauthorized"}), 401

    payload = request.get_json(silent=True) or {}

    text = (payload.get("text") or "").strip()
    if not text:
        return jsonify({"error": "text_required"}), 400

    run_id = clean_optional_string(payload.get("runId"))
    response_id = clean_optional_string(payload.get("responseId")) or str(uuid.uuid4())
    source = clean_optional_string(payload.get("source"))
    analysis_type = clean_optional_string(payload.get("analysisType"))
    created_at = parse_timestamp(payload.get("timestamp"))
    received_at = datetime.now(timezone.utc).isoformat()

    stage = payload.get("stage") or {}
    if not isinstance(stage, dict):
        stage = {}
    stage_index = stage.get("index") if isinstance(stage.get("index"), int) else None
    stage_name = clean_optional_string(stage.get("name"))
    stage_duration_ms = stage.get("durationMs") if isinstance(stage.get("durationMs"), int) else None
    stage_word_count = stage.get("wordCount") if isinstance(stage.get("wordCount"), int) else None

    text_length = len(text)
    formatted_text = format_four_gate_line(text)
    four_gate_parts = parse_four_gate_line_parts(text)

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute(
        """
        INSERT OR IGNORE INTO responses (
            response_id,
            run_id,
            source,
            analysis_type,
            text,
            text_length,
            created_at,
            received_at,
            stage_index,
            stage_name,
            stage_duration_ms,
            stage_word_count,
            formatted_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            response_id,
            run_id,
            source,
            analysis_type,
            text,
            text_length,
            created_at,
            received_at,
            stage_index,
            stage_name,
            stage_duration_ms,
            stage_word_count,
            formatted_text
        )
    )
    inserted = cursor.rowcount > 0
    if inserted:
        row_id = cursor.lastrowid
    else:
        existing = conn.execute(
            "SELECT id FROM responses WHERE response_id = ?",
            (response_id,)
        ).fetchone()
        row_id = existing[0] if existing else None

    if inserted and four_gate_parts and row_id is not None:
        columns = ", ".join(FOUR_GATE_TABLE_COLUMNS)
        placeholders = ", ".join(["?"] * len(FOUR_GATE_TABLE_COLUMNS))
        cursor.execute(
            f"INSERT OR IGNORE INTO four_gate_records ({columns}) VALUES ({placeholders})",
            [
                row_id,
                run_id,
                source,
                analysis_type,
                created_at,
                received_at,
                *four_gate_parts,
                text,
            ],
        )
    conn.commit()
    conn.close()

    dispatch_payload = {
        "responseId": response_id,
        "runId": run_id,
        "source": source,
        "analysisType": analysis_type,
        "text": text,
        "textLength": text_length,
        "timestamp": created_at,
        "receivedAt": received_at,
        "savedAt": clean_optional_string(payload.get("savedAt")),
        "extensionVersion": clean_optional_string(payload.get("extensionVersion")),
        "backendResponseDbId": row_id,
        "backendDuplicate": not inserted,
    }
    if stage:
        dispatch_payload["stage"] = {
            "index": stage_index,
            "name": stage_name,
            "durationMs": stage_duration_ms,
            "wordCount": stage_word_count,
        }
    if isinstance(payload.get("meta"), dict):
        dispatch_payload["meta"] = payload.get("meta")

    dispatch_result = dispatch_repository_event(dispatch_payload)
    dispatch_failed = (
        GITHUB_DISPATCH_ENABLED
        and not dispatch_result.get("success")
        and not dispatch_result.get("skipped")
    )
    status_code = 200
    ok = True
    if dispatch_failed and GITHUB_DISPATCH_REQUIRED:
        ok = False
        status_code = 502

    return jsonify(
        {
            "ok": ok,
            "id": row_id,
            "responseId": response_id,
            "duplicate": not inserted,
            "dispatch": dispatch_result,
        }
    ), status_code


@app.route("/responses/latest", methods=["GET"])
def latest_response():
    if not authorize(request):
        return jsonify({"error": "unauthorized"}), 401

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        """
        SELECT * FROM responses
        ORDER BY received_at DESC, id DESC
        LIMIT 1
        """
    ).fetchone()
    conn.close()

    if not row:
        return jsonify({"ok": True, "response": None})

    return jsonify({"ok": True, "response": dict(row)})


@app.route("/market/daily", methods=["GET"])
def market_daily():
    if not authorize(request):
        return jsonify({"error": "unauthorized"}), 401
    if not TWELVEDATA_API_KEY:
        return jsonify({"error": "missing_twelvedata_api_key"}), 400

    symbols_map = collect_symbols_from_db()
    if not symbols_map:
        return jsonify({"ok": True, "data": []})

    symbols = list(symbols_map.keys())
    raw_payload = fetch_twelvedata_time_series(symbols)
    payload = parse_twelvedata_response(raw_payload)

    result = []
    for symbol in symbols:
        series = payload.get(symbol)
        if not series or "values" not in series:
            result.append({
                "symbol": symbol,
                "company": symbols_map.get(symbol),
                "status": "no_data"
            })
            continue

        values = series.get("values", [])
        if len(values) < 2:
            result.append({
                "symbol": symbol,
                "company": symbols_map.get(symbol),
                "status": "not_enough_data"
            })
            continue

        latest = values[0]
        previous = values[1]
        try:
            close = float(latest.get("close"))
            prev_close = float(previous.get("close"))
            change = close - prev_close
            change_pct = (change / prev_close) * 100 if prev_close else None
        except Exception:
            result.append({
                "symbol": symbol,
                "company": symbols_map.get(symbol),
                "status": "parse_error"
            })
            continue

        result.append({
            "symbol": symbol,
            "company": symbols_map.get(symbol),
            "date": latest.get("datetime"),
            "close": close,
            "prev_close": prev_close,
            "change": change,
            "change_pct": change_pct,
            "status": "ok"
        })

    return jsonify({"ok": True, "data": result})


if __name__ == "__main__":
    ensure_db()
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "8787")))
