from __future__ import annotations

import json
from typing import Any, Dict


DEFAULT_TABLE_NAME = "psm_store"
DEFAULT_STORE_KEY = "positions"


def _import_psycopg():
    try:
        import psycopg  # type: ignore
    except ImportError as exc:  # pragma: no cover - exercised via wrapper behavior
        raise RuntimeError(
            "PostgreSQL backend requires psycopg. Install with: pip install psycopg[binary]"
        ) from exc
    return psycopg


def _ensure_schema(cursor: Any, table_name: str) -> None:
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS {table_name} (
          store_key TEXT PRIMARY KEY,
          payload JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        """.format(table_name=table_name)
    )


def load_store_blob(
    dsn: str,
    table_name: str = DEFAULT_TABLE_NAME,
    store_key: str = DEFAULT_STORE_KEY,
) -> Dict[str, Any] | None:
    psycopg = _import_psycopg()
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cursor:
            _ensure_schema(cursor, table_name)
            cursor.execute(
                "SELECT payload FROM {table_name} WHERE store_key = %s".format(table_name=table_name),
                (store_key,),
            )
            row = cursor.fetchone()
            if row is None:
                return None
            payload = row[0]
            if isinstance(payload, dict):
                return payload
            if isinstance(payload, str):
                parsed = json.loads(payload)
                return parsed if isinstance(parsed, dict) else None
            return None


def save_store_blob(
    dsn: str,
    payload: Dict[str, Any],
    table_name: str = DEFAULT_TABLE_NAME,
    store_key: str = DEFAULT_STORE_KEY,
) -> None:
    psycopg = _import_psycopg()
    serialized = json.dumps(payload, ensure_ascii=False)
    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cursor:
            _ensure_schema(cursor, table_name)
            cursor.execute(
                """
                INSERT INTO {table_name} (store_key, payload, updated_at)
                VALUES (%s, %s::jsonb, NOW())
                ON CONFLICT (store_key) DO UPDATE
                SET payload = EXCLUDED.payload,
                    updated_at = NOW();
                """.format(table_name=table_name),
                (store_key, serialized),
            )
