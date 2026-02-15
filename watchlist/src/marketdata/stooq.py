from __future__ import annotations

from datetime import date, datetime, timedelta
from io import StringIO
import csv
from typing import Any, Callable, Dict, Iterable, List, Tuple
from urllib.parse import urlencode
from urllib.request import Request, urlopen


HISTORY_BASE_URL = "https://stooq.com/q/d/l/"
QUOTES_BASE_URL = "https://stooq.com/q/l/"
DEFAULT_QUOTES_BATCH_SIZE = 8
MISSING_MARKERS = {"", "N/D", "-"}


def _normalize_symbol(symbol: str) -> str:
    return symbol.strip().lower()


def _normalize_date(raw: Any) -> str:
    value = str(raw or "").strip()
    if not value or value.upper() == "N/D":
        raise ValueError("Missing date value")

    # Stooq historically returns both ISO and US date format.
    direct_formats = ("%Y-%m-%d", "%m/%d/%Y", "%Y%m%d")
    for fmt in direct_formats:
        try:
            return datetime.strptime(value, fmt).date().isoformat()
        except ValueError:
            continue

    if "T" in value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00")).date().isoformat()
        except ValueError:
            pass

    if " " in value:
        for fmt in ("%Y-%m-%d %H:%M:%S", "%m/%d/%Y %H:%M:%S"):
            try:
                return datetime.strptime(value, fmt).date().isoformat()
            except ValueError:
                continue

    raise ValueError(f"Unsupported date format: {value}")


def _value_present(raw: Any) -> bool:
    return str(raw or "").strip().upper() not in MISSING_MARKERS


def _to_float(raw: Any) -> float:
    value = str(raw or "").strip()
    if value.upper() in MISSING_MARKERS:
        return 0.0
    return float(value)


def _to_int(raw: Any) -> int:
    value = str(raw or "").strip()
    if value.upper() in MISSING_MARKERS:
        return 0
    return int(float(value))


def _first_value(row: Dict[str, Any], names: Iterable[str]) -> Any:
    lowered = {str(key).lower(): value for key, value in row.items() if key}
    for name in names:
        if name in row:
            return row[name]
        lowered_value = lowered.get(name.lower())
        if lowered_value is not None:
            return lowered_value
    return None


def _normalize_bar(raw: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "date": _normalize_date(raw["date"]),
        "open": float(raw["open"]),
        "high": float(raw["high"]),
        "low": float(raw["low"]),
        "close": float(raw["close"]),
        "volume": int(raw.get("volume", 0)),
    }


def parse_stooq_csv(csv_text: str) -> List[Dict[str, Any]]:
    reader = csv.DictReader(StringIO(csv_text))
    bars: List[Dict[str, Any]] = []
    for row in reader:
        raw_date = _first_value(row, ("Date",))
        raw_close = _first_value(row, ("Close",))
        if not _value_present(raw_date) or not _value_present(raw_close):
            continue
        try:
            bars.append(
                _normalize_bar(
                    {
                        "date": raw_date,
                        "open": _to_float(_first_value(row, ("Open",))),
                        "high": _to_float(_first_value(row, ("High",))),
                        "low": _to_float(_first_value(row, ("Low",))),
                        "close": _to_float(raw_close),
                        "volume": _to_int(_first_value(row, ("Volume",))),
                    }
                )
            )
        except (TypeError, ValueError):
            continue
    return sorted(bars, key=lambda item: item["date"])


def parse_stooq_quotes_csv(csv_text: str) -> List[Dict[str, Any]]:
    reader = csv.DictReader(StringIO(csv_text))
    quotes: List[Dict[str, Any]] = []
    for row in reader:
        raw_symbol = _first_value(row, ("Symbol",))
        raw_date = _first_value(row, ("Date",))
        raw_close = _first_value(row, ("Close",))
        if not _value_present(raw_symbol) or not _value_present(raw_date) or not _value_present(raw_close):
            continue
        try:
            quote = _normalize_bar(
                {
                    "date": raw_date,
                    "open": _to_float(_first_value(row, ("Open",))),
                    "high": _to_float(_first_value(row, ("High",))),
                    "low": _to_float(_first_value(row, ("Low",))),
                    "close": _to_float(raw_close),
                    "volume": _to_int(_first_value(row, ("Volume",))),
                }
            )
        except (TypeError, ValueError):
            continue
        quote["symbol"] = _normalize_symbol(str(raw_symbol))
        quotes.append(quote)

    return sorted(quotes, key=lambda item: (item["symbol"], item["date"]))


def _http_get(url: str) -> str:
    request = Request(url, headers={"User-Agent": "psm-v4/1.0"})
    with urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8", errors="replace")


def fetch_daily_history(
    symbol: str,
    start_date: date | None = None,
    end_date: date | None = None,
    http_get: Callable[[str], str] | None = None,
) -> List[Dict[str, Any]]:
    params = {
        "s": _normalize_symbol(symbol),
        "i": "d",
    }
    if start_date is not None:
        params["d1"] = start_date.strftime("%Y%m%d")
    if end_date is not None:
        params["d2"] = end_date.strftime("%Y%m%d")
    url = f"{HISTORY_BASE_URL}?{urlencode(params)}"
    payload = _http_get(url) if http_get is None else http_get(url)
    return parse_stooq_csv(payload)


def fetch_last_days(
    symbol: str,
    n_days: int,
    http_get: Callable[[str], str] | None = None,
) -> List[Dict[str, Any]]:
    today = date.today()
    start = today - timedelta(days=max(30, n_days * 4))
    parsed = fetch_daily_history(
        symbol=symbol,
        start_date=start,
        end_date=today,
        http_get=http_get,
    )
    return parsed[-n_days:] if n_days > 0 else parsed


def fetch_latest_quotes_batched(
    symbols: List[str],
    batch_size: int = DEFAULT_QUOTES_BATCH_SIZE,
    http_get: Callable[[str], str] | None = None,
) -> Tuple[Dict[str, List[Dict[str, Any]]], List[str]]:
    normalized_symbols: List[str] = []
    seen: set[str] = set()
    for symbol in symbols:
        normalized = _normalize_symbol(symbol)
        if not normalized or normalized in seen:
            continue
        seen.add(normalized)
        normalized_symbols.append(normalized)

    bars_by_symbol: Dict[str, List[Dict[str, Any]]] = {symbol: [] for symbol in normalized_symbols}
    failed_symbols: List[str] = []
    if not normalized_symbols:
        return bars_by_symbol, failed_symbols

    resolved_batch_size = max(1, int(batch_size))
    get_fn = _http_get if http_get is None else http_get

    for start_index in range(0, len(normalized_symbols), resolved_batch_size):
        chunk = normalized_symbols[start_index : start_index + resolved_batch_size]
        params = {
            "s": " ".join(chunk),
            "f": "sd2t2ohlcv",
            "h": "",
            "e": "csv",
        }
        url = f"{QUOTES_BASE_URL}?{urlencode(params)}"
        try:
            payload = get_fn(url)
            parsed = parse_stooq_quotes_csv(payload)
        except Exception:
            failed_symbols.extend(chunk)
            continue

        latest_for_chunk: Dict[str, Dict[str, Any]] = {}
        for row in parsed:
            symbol = row["symbol"]
            if symbol not in bars_by_symbol:
                continue
            bar = {
                "date": row["date"],
                "open": row["open"],
                "high": row["high"],
                "low": row["low"],
                "close": row["close"],
                "volume": row["volume"],
            }
            previous = latest_for_chunk.get(symbol)
            if previous is None or bar["date"] > previous["date"]:
                latest_for_chunk[symbol] = bar

        for symbol, bar in latest_for_chunk.items():
            bars_by_symbol[symbol] = [bar]

    return bars_by_symbol, sorted(set(failed_symbols))


def merge_bars(
    existing: List[Dict[str, Any]],
    incoming: List[Dict[str, Any]],
    max_bars: int,
) -> Tuple[List[Dict[str, Any]], List[str]]:
    by_date = {str(item["date"]): _normalize_bar(item) for item in existing}
    changed_dates: List[str] = []
    for raw in incoming:
        bar = _normalize_bar(raw)
        current = by_date.get(bar["date"])
        if current != bar:
            changed_dates.append(bar["date"])
        by_date[bar["date"]] = bar

    merged = sorted(by_date.values(), key=lambda item: item["date"])
    if len(merged) > max_bars:
        merged = merged[-max_bars:]
    date_set = {item["date"] for item in merged}
    changed = sorted([raw_date for raw_date in set(changed_dates) if raw_date in date_set])
    return merged, changed


def detect_corp_action_suspected(bars: List[Dict[str, Any]]) -> bool:
    if len(bars) < 2:
        return False
    prev_close = float(bars[-2]["close"])
    last_close = float(bars[-1]["close"])
    if prev_close <= 0:
        return False
    ratio = last_close / prev_close
    return ratio < 0.5 or ratio > 1.5
