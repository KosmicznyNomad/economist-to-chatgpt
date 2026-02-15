from __future__ import annotations

from pathlib import Path
from typing import Any, Dict

from src.storage.positions_store import (
    _is_postgres_target,
    empty_store,
    load_positions,
    save_positions,
)


def test_is_postgres_target_detection():
    assert _is_postgres_target("postgresql://localhost/db")
    assert _is_postgres_target("postgres://localhost/db")
    assert not _is_postgres_target("data/positions.json")
    assert not _is_postgres_target(Path("data/positions.json"))


def test_save_positions_routes_to_postgres_backend(monkeypatch):
    captured: Dict[str, Any] = {}

    def fake_save(path, payload):
        captured["path"] = path
        captured["payload"] = payload

    monkeypatch.setattr("src.storage.positions_store._save_postgres_blob", fake_save)

    payload = empty_store()
    save_positions(payload, "postgresql://example.invalid/psm")

    assert captured["path"] == "postgresql://example.invalid/psm"
    assert captured["payload"] == payload


def test_load_positions_routes_to_postgres_backend(monkeypatch):
    expected = empty_store()
    calls: Dict[str, int] = {"load": 0, "save": 0}

    def fake_load(path):
        calls["load"] += 1
        assert path == "postgresql://example.invalid/psm"
        return expected

    def fake_save(path, payload):
        calls["save"] += 1

    monkeypatch.setattr("src.storage.positions_store._load_postgres_blob", fake_load)
    monkeypatch.setattr("src.storage.positions_store._save_postgres_blob", fake_save)

    loaded = load_positions("postgresql://example.invalid/psm")
    assert loaded["meta"]["schema_version"] == "psm_v4"
    assert "positions" in loaded
    assert calls["load"] == 1
    assert calls["save"] == 0


def test_load_positions_migrates_and_persists_for_postgres(monkeypatch):
    # Legacy payload to force migration and persisted write.
    legacy = {"AAA": {"state": "ACTIVE", "entry": 10.0}}
    calls: Dict[str, int] = {"save": 0}

    def fake_load(path):
        return legacy

    def fake_save(path, payload):
        calls["save"] += 1
        assert "positions" in payload
        assert "AAA" in payload["positions"]

    monkeypatch.setattr("src.storage.positions_store._load_postgres_blob", fake_load)
    monkeypatch.setattr("src.storage.positions_store._save_postgres_blob", fake_save)

    loaded = load_positions("postgresql://example.invalid/psm")
    assert "AAA" in loaded["positions"]
    assert calls["save"] == 1
