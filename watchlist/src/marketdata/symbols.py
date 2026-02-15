from __future__ import annotations

from typing import Dict, List


EXCHANGE_SUFFIXES: Dict[str, List[str]] = {
    "NYSE": ["us"],
    "NASDAQ": ["us"],
    "AMEX": ["us"],
    "US": ["us"],
    "LSE": ["uk", "l"],
    "ETR": ["de"],
    "XETRA": ["de"],
    "XETR": ["de"],
    "FRA": ["de"],
    "EPA": ["fr"],
    "PA": ["fr"],
    "BIT": ["it"],
    "MI": ["it"],
    "AMS": ["nl"],
    "SW": ["sw"],
    "OSL": ["ol"],
    "OSE": ["ol"],
    "ASX": ["au"],
    "NSE": ["in"],
    "TSE": ["jp"],
    "TYO": ["jp"],
    "JP": ["jp"],
    "TSX": ["ca"],
    "HEL": ["fi"],
    "CPH": ["dk"],
    "SZ": ["cn"],
    "SHE": ["cn"],
    "SHA": ["cn"],
    "SGX": ["sg"],
    "KRX": ["kr"],
    "ADX": ["ae"],
    "EGX": ["eg"],
    "LAG": ["ng"],
    "GSE": ["gh"],
    "KW": ["kw"],
}


def _normalize_symbol(value: str | None) -> str:
    return str(value or "").strip().lower()


def _normalize_exchange(value: str | None) -> str:
    return str(value or "").strip().upper()


def default_stooq_symbol(ticker: str | None, exchange: str | None) -> str | None:
    normalized_ticker = _normalize_symbol(ticker)
    if not normalized_ticker:
        return None
    if "." in normalized_ticker:
        return normalized_ticker
    suffixes = EXCHANGE_SUFFIXES.get(_normalize_exchange(exchange), [])
    if suffixes:
        return f"{normalized_ticker}.{suffixes[0]}"
    return f"{normalized_ticker}.us"


def build_stooq_symbol_candidates(
    ticker: str | None,
    exchange: str | None,
    current_symbol: str | None = None,
) -> List[str]:
    normalized_ticker = _normalize_symbol(ticker)
    normalized_exchange = _normalize_exchange(exchange)
    candidates: List[str] = []

    def _append(symbol: str | None) -> None:
        normalized = _normalize_symbol(symbol)
        if not normalized:
            return
        if normalized in candidates:
            return
        candidates.append(normalized)

    _append(current_symbol)
    _append(default_stooq_symbol(normalized_ticker, normalized_exchange))

    if not normalized_ticker:
        return candidates
    if "." in normalized_ticker:
        _append(normalized_ticker)
        return candidates

    for suffix in EXCHANGE_SUFFIXES.get(normalized_exchange, []):
        _append(f"{normalized_ticker}.{suffix}")
    _append(f"{normalized_ticker}.us")
    _append(normalized_ticker)
    return candidates
