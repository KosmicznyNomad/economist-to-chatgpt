from __future__ import annotations

from urllib.parse import parse_qs, urlparse

from src.marketdata.stooq import fetch_last_days, fetch_latest_quotes_batched, parse_stooq_csv, parse_stooq_quotes_csv


def test_parse_stooq_csv_accepts_iso_and_us_dates():
    payload = "\n".join(
        [
            "Date,Open,High,Low,Close,Volume",
            "02/11/2026,10,11,9,10.5,1000",
            "2026-02-10,9,10,8,9.5,900",
        ]
    )

    bars = parse_stooq_csv(payload)
    assert [item["date"] for item in bars] == ["2026-02-10", "2026-02-11"]
    assert bars[1]["close"] == 10.5


def test_parse_stooq_quotes_csv_returns_normalized_symbols():
    payload = "\n".join(
        [
            "Symbol,Date,Time,Open,High,Low,Close,Volume",
            "AAA.US,02/12/2026,22:00:00,100,101,99,100.5,1000",
            "bbb.us,2026-02-12,22:00:00,200,201,198,200.5,2000",
        ]
    )

    rows = parse_stooq_quotes_csv(payload)
    assert [item["symbol"] for item in rows] == ["aaa.us", "bbb.us"]
    assert rows[0]["date"] == "2026-02-12"
    assert rows[1]["volume"] == 2000


def test_fetch_last_days_uses_date_range_params():
    captured_url = {"value": ""}

    def fake_http_get(url: str) -> str:
        captured_url["value"] = url
        return "\n".join(
            [
                "Date,Open,High,Low,Close,Volume",
                "2026-02-10,9,10,8,9.5,900",
                "2026-02-11,10,11,9,10.5,1000",
            ]
        )

    bars = fetch_last_days("aaa.us", 1, http_get=fake_http_get)
    parsed_query = parse_qs(urlparse(captured_url["value"]).query)

    assert parsed_query["s"] == ["aaa.us"]
    assert parsed_query["i"] == ["d"]
    assert "d1" in parsed_query
    assert "d2" in parsed_query
    assert len(bars) == 1
    assert bars[0]["date"] == "2026-02-11"


def test_fetch_latest_quotes_batched_splits_requests_and_collects_failures():
    calls: list[str] = []

    def fake_http_get(url: str) -> str:
        calls.append(url)
        query = parse_qs(urlparse(url).query)
        chunk_symbols = query["s"][0].split()
        if "ccc.us" in chunk_symbols:
            raise RuntimeError("simulated batch failure")
        rows = ["Symbol,Date,Time,Open,High,Low,Close,Volume"]
        for symbol in chunk_symbols:
            rows.append(f"{symbol.upper()},2026-02-12,22:00:00,10,11,9,10.5,100")
        return "\n".join(rows)

    bars_by_symbol, failed = fetch_latest_quotes_batched(
        ["aaa.us", "bbb.us", "ccc.us", "ddd.us"],
        batch_size=2,
        http_get=fake_http_get,
    )

    assert len(calls) == 2
    assert failed == ["ccc.us", "ddd.us"]
    assert bars_by_symbol["aaa.us"][0]["close"] == 10.5
    assert bars_by_symbol["ccc.us"] == []
