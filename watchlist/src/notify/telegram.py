from __future__ import annotations

from collections import Counter, defaultdict
import json
import os
import re
from typing import Any, Callable, Dict, Iterable, List
from urllib.request import Request, urlopen

from src.engine.definitions import Action, AnomalyEvent, AnomalySeverity, DecisionOfDay


DEFAULT_BOT_USERNAME = "stockiskierkabot"
DEFAULT_BOT_TOKEN = None


STATE_TEXT = {
    "NORMAL_RUN": "pozycja aktywna",
    "SPIKE_LOCK": "ochrona po gwaltownym ruchu",
    "EXITED_COOLDOWN": "czasowe wstrzymanie po wyjsciu",
    "REENTRY_WINDOW": "okno ponownego wejscia",
}


REASON_TEXT = {
    "NO_NEW_BAR": "Brak nowej sesji rynkowej do przeliczenia.",
    "NO_TRIGGER": "Na tym barze nie pojawil sie warunek zmiany.",
    "ENTRY_WAIT_DATA": "Brakuje minimalnego zestawu danych do oceny wejscia.",
    "ENTRY_WATCH": "Spolka jest obserwowana, ale warunki wejscia nie sa jeszcze gotowe.",
    "ENTRY_SETUP": "Jest korekta w trendzie, ale brakuje potwierdzenia odbicia.",
    "ENTRY_NO_BUY_TREND": "Trend dlugoterminowy jest zbyt slaby na nowe wejscie.",
    "ENTRY_NO_BUY_OVERHEAT": "Rynek jest przegrzany, wiec nowe wejscie jest wstrzymane.",
    "BUY_TRIGGER": "Mechanizm potwierdzil sygnal kupna po korekcie i odbiciu.",
    "FALSIFIER": "Zlamal sie warunek tezy inwestycyjnej.",
    "WARN": "Pojawil sie sygnal ostrzegawczy wymagajacy redukcji ryzyka.",
    "STOP_HIT": "Cena zamknela sie ponizej poziomu obronnego.",
    "TREND_BREAK": "Trend zostal zlamany i pozycja traci przewage.",
    "SPIKE_DETECTED": "Wykryto nienaturalnie szybki ruch ceny.",
    "SPIKE_ABSORBED": "Rynek uspokoil sie po gwaltownym ruchu.",
    "SPIKE_LOCK_TIMEOUT": "Minelo okno ochronne po gwaltownym ruchu.",
    "BASE_HIT": "Cena doszla do pierwszego celu realizacji zysku.",
    "BULL_HIT": "Cena doszla do agresywnego celu realizacji zysku.",
    "COOLDOWN_ACTIVE": "Nadal trwa okres odczekania po wyjsciu.",
    "OPEN_REENTRY_WINDOW": "Otworzylo sie okno na ponowne wejscie.",
    "REENTRY_TRIGGERED": "Warunki ponownego wejscia zostaly spelnione.",
    "REENTRY_EXPIRED": "Okno ponownego wejscia wygaslo.",
    "PERMANENT_EXIT": "Pozycja jest oznaczona jako trwale zamknieta.",
    "DATA_FETCH_ERROR": "Nie udalo sie pobrac aktualnych danych rynkowych.",
    "DATA_SUSPECTED": "Dane wymagaly odbudowy po wykryciu podejrzanej zmiany.",
    "DUPLICATE_ACTION_BLOCKED": "Akcja byla juz wykonana dla tej samej sesji.",
}


CONTEXT_EMPTY = "n/a"
CONTEXT_MAX_SHORT = 40
CONTEXT_MAX_LONG = 160
METHODOLOGY_2026_YEAR = 2026


def is_actionable(decision: DecisionOfDay) -> bool:
    if decision.action.type not in {Action.HOLD, Action.WAIT}:
        return True
    if decision.state_before != decision.state_after:
        return True
    if decision.reason.code.value in {
        "SPIKE_DETECTED",
        "SPIKE_ABSORBED",
        "SPIKE_LOCK_TIMEOUT",
        "STOP_HIT",
        "TREND_BREAK",
        "BASE_HIT",
        "BULL_HIT",
        "REENTRY_TRIGGERED",
    }:
        return True
    return False


def _mean(values: List[float]) -> float | None:
    if not values:
        return None
    return sum(values) / len(values)


def summarize_positions(positions: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
    mode_counter: Counter[str] = Counter()
    state_counter: Counter[str] = Counter()
    priced_in_values: List[float] = []
    gap_to_base_values: List[float] = []
    gap_to_bull_values: List[float] = []
    unrealized_values: List[float] = []
    for _, position in positions.items():
        mode_counter[position["mode"]] += 1
        state_counter[position["state"]] += 1

        computed = position.get("computed", {})
        priced_in = computed.get("priced_in_pct")
        gap_base = computed.get("gap_to_base_pct")
        gap_bull = computed.get("gap_to_bull_pct")
        unrealized = computed.get("unrealized_pnl_pct")

        if isinstance(priced_in, (int, float)):
            priced_in_values.append(float(priced_in))
        if isinstance(gap_base, (int, float)):
            gap_to_base_values.append(float(gap_base))
        if isinstance(gap_bull, (int, float)):
            gap_to_bull_values.append(float(gap_bull))
        if isinstance(unrealized, (int, float)):
            unrealized_values.append(float(unrealized))

    return {
        "modes": dict(mode_counter),
        "states": dict(state_counter),
        "valuation": {
            "priced_in_pct_avg": _mean(priced_in_values),
            "gap_to_base_pct_avg": _mean(gap_to_base_values),
            "gap_to_bull_pct_avg": _mean(gap_to_bull_values),
            "unrealized_pnl_pct_avg": _mean(unrealized_values),
            "priced_in_samples": len(priced_in_values),
            "gap_to_base_samples": len(gap_to_base_values),
            "gap_to_bull_samples": len(gap_to_bull_values),
            "unrealized_samples": len(unrealized_values),
        },
    }


def _state_text(value: str) -> str:
    return STATE_TEXT.get(value, value)


def _action_text(item: DecisionOfDay) -> str:
    if item.action.type == Action.SELL_PARTIAL:
        if item.action.sell_pct is not None:
            return f"Zmniejsz pozycje o {item.action.sell_pct:.0%}."
        return "Zmniejsz czesc pozycji."
    if item.action.type == Action.SELL_ALL:
        return "Zamknij cala pozycje."
    if item.action.type == Action.BUY_REENTER:
        if item.action.buy_pct_of_target is not None:
            return f"Wroc do pozycji na poziomie {item.action.buy_pct_of_target:.0%} docelowej wielkosci."
        return "Wroc do pozycji po potwierdzeniu warunkow."
    if item.action.type == Action.BUY_ALERT:
        return "Rozwaz nowe wejscie: mechanizm wygenerowal sygnal kupna."
    if item.action.type == Action.HOLD:
        return "Utrzymaj pozycje bez zmian."
    return "Obserwuj, bez nowej transakcji."


def _reason_text(item: DecisionOfDay) -> str:
    code = item.reason.code.value
    if code in REASON_TEXT:
        return REASON_TEXT[code]
    return item.reason.text.strip() if item.reason.text else "Brak dodatkowych informacji."


def _state_sentence(item: DecisionOfDay) -> str:
    before = _state_text(item.state_before.value)
    after = _state_text(item.state_after.value)
    if item.state_before == item.state_after:
        return f"Status pozycji bez zmiany: {after}."
    return f"Status pozycji zmienil sie z '{before}' na '{after}'."


def _resolve_price(item: DecisionOfDay) -> float | None:
    if item.action.price_hint is not None:
        return float(item.action.price_hint)
    close_value = item.levels.get("price_close")
    if close_value is None:
        return None
    return float(close_value)


def _price_variable(item: DecisionOfDay) -> str:
    if item.action.type == Action.BUY_ALERT:
        currency = str(item.symbol.get("currency") or "USD")
        entry_ref = item.levels.get("entry_ref_price")
        stop_loss = item.levels.get("stop_loss_price")
        atr_d = item.levels.get("atr_d")
        time_stop = item.levels.get("time_stop_days")
        shares_hint = item.levels.get("shares_hint")

        entry_text = "n/a" if entry_ref is None else f"{float(entry_ref):.2f} {currency}"
        stop_text = "n/a" if stop_loss is None else f"{float(stop_loss):.2f} {currency}"
        atr_text = _format_metric(atr_d)
        time_stop_text = "n/a" if time_stop is None else f"{int(time_stop)} dni"
        shares_text = _format_metric(shares_hint, precision=2)
        return (
            f"Cena odniesienia: {entry_text}. "
            f"Stop loss: {stop_text}. "
            f"Sredni zakres zmiennosci z 14 sesji: {atr_text}. "
            f"Limit czasu trzymania pozycji: {time_stop_text}. "
            f"Podpowiedz wielkosci pozycji: {shares_text} akcji."
        )

    price = _resolve_price(item)
    if price is None:
        return "Cena odniesienia: brak."
    currency = str(item.symbol.get("currency") or "USD")
    return f"Cena odniesienia: {price:.2f} {currency}."


def _format_metric(value: Any, precision: int = 2) -> str:
    try:
        if value is None:
            return "n/a"
        return f"{float(value):.{precision}f}"
    except (TypeError, ValueError):
        return "n/a"


def _normalize_context_token(value: Any) -> str:
    return str(value or "").strip().upper()


def _normalize_company_name(value: Any) -> str:
    text = " ".join(str(value or "").split())
    if not text:
        return ""
    # Remove optional (TICKER:EXCHANGE) suffixes and normalize spacing/punctuation.
    text = re.sub(r"\([^)]*\)", "", text).strip()
    text = re.sub(r"[^A-Za-z0-9]+", " ", text).strip().upper()
    return text


def _clean_text(value: Any) -> str | None:
    if value is None:
        return None
    text = " ".join(str(value).split())
    return text if text else None


def _truncate_text(value: str | None, limit: int) -> str:
    if not value:
        return CONTEXT_EMPTY
    if len(value) <= limit:
        return value
    return f"{value[: max(1, limit - 3)].rstrip()}..."


def _parse_decision_year(value: Any) -> int | None:
    match = re.search(r"\b(19|20)\d{2}\b", str(value or ""))
    if match is None:
        return None
    try:
        year = int(match.group(0))
    except ValueError:
        return None
    if year < 1900 or year > 2100:
        return None
    return year


def _methodology_flags_from_row(row: Dict[str, Any], fields: Dict[str, Any]) -> Dict[str, Any]:
    research_flags = row.get("research_flags")
    if isinstance(research_flags, dict):
        decision_year = research_flags.get("decision_year")
        methodology_2026_plus = bool(research_flags.get("methodology_2026_plus", False))
        return {
            "decision_year": decision_year if isinstance(decision_year, int) else _parse_decision_year(fields.get("data_decyzji")),
            "methodology_2026_plus": methodology_2026_plus
            or bool(
                isinstance(decision_year, int)
                and decision_year >= METHODOLOGY_2026_YEAR
            ),
        }

    decision_year = _parse_decision_year(fields.get("data_decyzji"))
    return {
        "decision_year": decision_year,
        "methodology_2026_plus": bool(decision_year is not None and decision_year >= METHODOLOGY_2026_YEAR),
    }


def _context_priority(context: Dict[str, Any]) -> tuple[int, int]:
    flags = context.get("research_flags", {}) if isinstance(context.get("research_flags"), dict) else {}
    methodology_weight = 1 if bool(flags.get("methodology_2026_plus")) else 0
    decision_year = flags.get("decision_year")
    decision_year_weight = decision_year if isinstance(decision_year, int) else -1
    return methodology_weight, decision_year_weight


def _pick_context(existing: Dict[str, Any] | None, candidate: Dict[str, Any]) -> Dict[str, Any]:
    if existing is None:
        return candidate
    if _context_priority(candidate) >= _context_priority(existing):
        return candidate
    return existing


def _build_research_lookup(research_rows: Iterable[Dict[str, Any]] | None) -> Dict[str, Dict[str, Dict[str, Any]]]:
    by_key_best: Dict[str, Dict[str, Any]] = {}
    by_ticker_best: Dict[str, Dict[str, Any]] = {}
    by_key_all: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    by_ticker_all: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    ticker_company_names: Dict[str, set[str]] = defaultdict(set)
    ticker_keys: Dict[str, set[str]] = defaultdict(set)
    unresolved_contexts: List[Dict[str, Any]] = []

    for index, row in enumerate(list(research_rows or [])):
        if not isinstance(row, dict):
            continue
        fields = row.get("fields")
        identity = row.get("identity_guess")
        if not isinstance(fields, dict):
            continue

        context_id = str(row.get("row_fingerprint") or f"row_{index}")
        company_name_norm = _normalize_company_name(fields.get("spolka"))
        context = {
            "fields": fields,
            "research_flags": _methodology_flags_from_row(row, fields),
            "context_id": context_id,
            "company_name_norm": company_name_norm,
        }

        if not isinstance(identity, dict):
            unresolved_contexts.append(context)
            continue

        ticker = _normalize_context_token(identity.get("ticker"))
        if not ticker:
            unresolved_contexts.append(context)
            continue
        exchange = _normalize_context_token(identity.get("exchange")) or "UNKNOWN"
        by_key_token = f"{ticker}:{exchange}"
        by_key_best[by_key_token] = _pick_context(by_key_best.get(by_key_token), context)
        by_ticker_best[ticker] = _pick_context(by_ticker_best.get(ticker), context)
        by_key_all[by_key_token].append(context)
        by_ticker_all[ticker].append(context)
        ticker_keys[ticker].add(by_key_token)
        if company_name_norm:
            ticker_company_names[ticker].add(company_name_norm)

    # Link unresolved company-name rows to known tickers with the same company name.
    for context in unresolved_contexts:
        company_name_norm = str(context.get("company_name_norm") or "")
        if not company_name_norm:
            continue
        for ticker, names in ticker_company_names.items():
            if company_name_norm not in names:
                continue
            by_ticker_all[ticker].append(context)
            for key_token in ticker_keys.get(ticker, set()):
                by_key_all[key_token].append(context)

    return {
        "by_key_best": by_key_best,
        "by_ticker_best": by_ticker_best,
        "by_key_all": dict(by_key_all),
        "by_ticker_all": dict(by_ticker_all),
    }


def _resolve_research_context(
    key: str,
    symbol: Dict[str, Any],
    research_lookup: Dict[str, Dict[str, Dict[str, Any]]],
) -> Dict[str, Any] | None:
    by_key = research_lookup.get("by_key_best", {})
    by_ticker = research_lookup.get("by_ticker_best", {})
    normalized_key = _normalize_context_token(key)
    if normalized_key in by_key:
        return by_key[normalized_key]

    ticker = _normalize_context_token(symbol.get("ticker") if isinstance(symbol, dict) else None)
    if ticker and ticker in by_ticker:
        return by_ticker[ticker]

    if ":" in normalized_key:
        fallback_ticker = normalized_key.split(":", 1)[0]
        if fallback_ticker in by_ticker:
            return by_ticker[fallback_ticker]
    return None


def _resolve_research_contexts(
    key: str,
    symbol: Dict[str, Any],
    research_lookup: Dict[str, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    by_key_all = research_lookup.get("by_key_all", {})
    by_ticker_all = research_lookup.get("by_ticker_all", {})

    normalized_key = _normalize_context_token(key)
    contexts: List[Dict[str, Any]] = []
    if normalized_key in by_key_all:
        contexts.extend(list(by_key_all.get(normalized_key, [])))

    ticker = _normalize_context_token(symbol.get("ticker") if isinstance(symbol, dict) else None)
    if ticker:
        contexts.extend(list(by_ticker_all.get(ticker, [])))
    elif ":" in normalized_key:
        fallback_ticker = normalized_key.split(":", 1)[0]
        contexts.extend(list(by_ticker_all.get(fallback_ticker, [])))

    deduped: Dict[str, Dict[str, Any]] = {}
    for context in contexts:
        context_id = str(context.get("context_id") or id(context))
        if context_id not in deduped:
            deduped[context_id] = context

    sorted_contexts = sorted(
        deduped.values(),
        key=lambda item: _context_priority(item),
        reverse=True,
    )
    return sorted_contexts


def _append_context_block(
    lines: List[str],
    context: Dict[str, Any] | None,
    *,
    indent: str = "  ",
    include_thesis: bool = True,
) -> None:
    if context is None:
        return
    fields_raw = context.get("fields")
    if not isinstance(fields_raw, dict):
        return

    status = _truncate_text(_clean_text(fields_raw.get("status_decyzji")), CONTEXT_MAX_SHORT)
    quality = _truncate_text(_clean_text(fields_raw.get("ocena_jakosciowa")), CONTEXT_MAX_SHORT)
    sector = _truncate_text(_clean_text(fields_raw.get("sektor")), CONTEXT_MAX_SHORT)
    region = _truncate_text(_clean_text(fields_raw.get("region")), CONTEXT_MAX_SHORT)
    currency = _truncate_text(_clean_text(fields_raw.get("waluta")), CONTEXT_MAX_SHORT)
    thesis_source = _truncate_text(_clean_text(fields_raw.get("zrodlo_tezy")), CONTEXT_MAX_SHORT)
    source_material = _truncate_text(_clean_text(fields_raw.get("material_zrodlowy_podcast")), CONTEXT_MAX_LONG)
    why_buy = _truncate_text(_clean_text(fields_raw.get("why_buy")), CONTEXT_MAX_LONG)
    why_avoid = _truncate_text(_clean_text(fields_raw.get("why_avoid")), CONTEXT_MAX_LONG)
    risk = _truncate_text(
        _clean_text(fields_raw.get("voi_falsy_kluczowe_ryzyka")) or _clean_text(fields_raw.get("watpliwosci_ryzyka")),
        CONTEXT_MAX_LONG,
    )
    thesis = _truncate_text(_clean_text(fields_raw.get("teza_inwestycyjna")), CONTEXT_MAX_LONG)
    context_flags = context.get("research_flags") if isinstance(context.get("research_flags"), dict) else {}
    methodology_2026_plus = bool(context_flags.get("methodology_2026_plus", False))
    decision_year = context_flags.get("decision_year")
    methodology_label = CONTEXT_EMPTY
    if methodology_2026_plus:
        year_label = str(decision_year) if isinstance(decision_year, int) else f"{METHODOLOGY_2026_YEAR}+"
        methodology_label = f"EKSTRA {year_label} (nowa metodologia)"
    if all(
        value == CONTEXT_EMPTY
        for value in [
            status,
            quality,
            sector,
            region,
            currency,
            thesis_source,
            source_material,
            why_buy,
            why_avoid,
            risk,
            thesis,
            methodology_label,
        ]
    ):
        return

    lines.append(f"{indent}Dodatkowy kontekst o spolce i tezie:")
    if methodology_label != CONTEXT_EMPTY:
        lines.append(f"{indent}  Metodologia analizy: {methodology_label}")
    lines.append(f"{indent}  Status i jakosc: {status} | {quality}")
    lines.append(f"{indent}  Sektor, region, waluta: {sector} | {region} | {currency}")
    if thesis_source != CONTEXT_EMPTY:
        lines.append(f"{indent}  Zrodlo tezy: {thesis_source}")
    if source_material != CONTEXT_EMPTY:
        lines.append(f"{indent}  Material zrodlowy: {source_material}")
    if include_thesis and thesis != CONTEXT_EMPTY:
        lines.append(f"{indent}  Teza inwestycyjna: {thesis}")
    if why_buy != CONTEXT_EMPTY:
        lines.append(f"{indent}  Dlaczego rozwazac kupno: {why_buy}")
    if risk != CONTEXT_EMPTY:
        lines.append(f"{indent}  Najwazniejsze ryzyka i warunki uniewaznienia tezy: {risk}")
    if why_avoid != CONTEXT_EMPTY:
        lines.append(f"{indent}  Dlaczego uwazac: {why_avoid}")


def _context_fields(context: Dict[str, Any] | None) -> Dict[str, str]:
    if context is None:
        return {}
    fields_raw = context.get("fields")
    if not isinstance(fields_raw, dict):
        return {}
    return {
        "data_decyzji": _truncate_text(_clean_text(fields_raw.get("data_decyzji")), CONTEXT_MAX_SHORT),
        "spolka": _truncate_text(_clean_text(fields_raw.get("spolka")), CONTEXT_MAX_SHORT),
        "status_decyzji": _truncate_text(_clean_text(fields_raw.get("status_decyzji")), CONTEXT_MAX_SHORT),
        "ocena_jakosciowa": _truncate_text(_clean_text(fields_raw.get("ocena_jakosciowa")), CONTEXT_MAX_SHORT),
        "teza_inwestycyjna": _truncate_text(_clean_text(fields_raw.get("teza_inwestycyjna")), CONTEXT_MAX_LONG),
        "why_buy": _truncate_text(_clean_text(fields_raw.get("why_buy")), CONTEXT_MAX_LONG),
        "why_avoid": _truncate_text(_clean_text(fields_raw.get("why_avoid")), CONTEXT_MAX_LONG),
        "risk": _truncate_text(
            _clean_text(fields_raw.get("voi_falsy_kluczowe_ryzyka")) or _clean_text(fields_raw.get("watpliwosci_ryzyka")),
            CONTEXT_MAX_LONG,
        ),
        "sektor": _truncate_text(_clean_text(fields_raw.get("sektor")), CONTEXT_MAX_SHORT),
        "region": _truncate_text(_clean_text(fields_raw.get("region")), CONTEXT_MAX_SHORT),
        "waluta": _truncate_text(_clean_text(fields_raw.get("waluta")), CONTEXT_MAX_SHORT),
        "asymetria_i_wycena": _truncate_text(_clean_text(fields_raw.get("asymetria_i_wycena")), CONTEXT_MAX_LONG),
        "zrodlo_tezy": _truncate_text(_clean_text(fields_raw.get("zrodlo_tezy")), CONTEXT_MAX_SHORT),
        "material": _truncate_text(_clean_text(fields_raw.get("material_zrodlowy_podcast")), CONTEXT_MAX_LONG),
    }


def _append_company_mini_essay(lines: List[str], context: Dict[str, Any] | None, *, indent: str = "  ") -> None:
    fields = _context_fields(context)
    if not fields:
        return
    company = fields.get("spolka", CONTEXT_EMPTY)
    status = fields.get("status_decyzji", CONTEXT_EMPTY)
    quality = fields.get("ocena_jakosciowa", CONTEXT_EMPTY)
    thesis = fields.get("teza_inwestycyjna", CONTEXT_EMPTY)
    why_buy = fields.get("why_buy", CONTEXT_EMPTY)
    why_avoid = fields.get("why_avoid", CONTEXT_EMPTY)
    risk = fields.get("risk", CONTEXT_EMPTY)
    sector = fields.get("sektor", CONTEXT_EMPTY)
    region = fields.get("region", CONTEXT_EMPTY)
    currency = fields.get("waluta", CONTEXT_EMPTY)
    asymmetry = fields.get("asymetria_i_wycena", CONTEXT_EMPTY)
    source = fields.get("zrodlo_tezy", CONTEXT_EMPTY)
    material = fields.get("material", CONTEXT_EMPTY)
    context_flags = context.get("research_flags") if isinstance(context, dict) and isinstance(context.get("research_flags"), dict) else {}
    methodology_2026_plus = bool(context_flags.get("methodology_2026_plus", False))
    decision_year = context_flags.get("decision_year")

    lines.append(f"{indent}Mini-esej inwestycyjny:")
    if company != CONTEXT_EMPTY:
        lines.append(f"{indent}Przypomnienie o spolce: {company}.")
    if methodology_2026_plus:
        year_label = str(decision_year) if isinstance(decision_year, int) else f"{METHODOLOGY_2026_YEAR}+"
        lines.append(f"{indent}Metodologia analizy: EKSTRA {year_label} (nowa metodologia).")
    if status != CONTEXT_EMPTY or quality != CONTEXT_EMPTY:
        lines.append(f"{indent}Status decyzji i jakosc: {status} | {quality}")
    if thesis != CONTEXT_EMPTY:
        lines.append(f"{indent}Teza inwestycyjna: {thesis}")

    role_parts = [part for part in [sector, region, currency] if part != CONTEXT_EMPTY]
    if role_parts:
        role_sentence = ", ".join(role_parts)
        if asymmetry != CONTEXT_EMPTY:
            lines.append(f"{indent}Rola w chainie i rynku: {role_sentence}. Asymetria i wycena: {asymmetry}")
        else:
            lines.append(f"{indent}Rola w chainie i rynku: {role_sentence}.")
    elif asymmetry != CONTEXT_EMPTY:
        lines.append(f"{indent}Asymetria i wycena: {asymmetry}")

    if why_buy != CONTEXT_EMPTY:
        lines.append(f"{indent}Zalety tej tezy: {why_buy}")
    risk_text_parts = [part for part in [why_avoid, risk] if part != CONTEXT_EMPTY]
    if risk_text_parts:
        lines.append(f"{indent}Wady i ryzyka: {' | '.join(risk_text_parts)}")
    if source != CONTEXT_EMPTY or material != CONTEXT_EMPTY:
        source_text = source if source != CONTEXT_EMPTY else "n/a"
        material_text = material if material != CONTEXT_EMPTY else "n/a"
        lines.append(f"{indent}Zrodlo i material: {source_text} | {material_text}")


def _as_float(value: Any) -> float | None:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def _clamp_score(value: float) -> int:
    return max(0, min(100, int(round(value))))


def _score_buy_alert(item: DecisionOfDay) -> int:
    score = 75.0
    trend_up = bool(item.levels.get("trend_up"))
    reversal = bool(item.levels.get("reversal"))
    z20 = _as_float(item.levels.get("z20"))
    if trend_up:
        score += 10.0
    if reversal:
        score += 8.0
    if z20 is not None and z20 <= -1.5:
        score += min(10.0, abs(z20 + 1.5) * 8.0)
    return _clamp_score(score)


def _score_std_pullback(event: AnomalyEvent) -> int:
    one_day_pct = _as_float(event.metrics.get("one_day_return_pct")) or 0.0
    sigma = abs(_as_float(event.metrics.get("one_day_return_in_sigma")) or 0.0)
    score = 40.0 + sigma * 22.0 + abs(min(0.0, one_day_pct)) * 1.2
    return _clamp_score(score)


def _build_buy_candidates(
    buy_alerts: List[DecisionOfDay],
    std_pullback_info: List[AnomalyEvent],
    research_lookup: Dict[str, Dict[str, Dict[str, Any]]],
) -> List[Dict[str, Any]]:
    candidates_by_key: Dict[str, Dict[str, Any]] = {}

    for item in buy_alerts:
        score = _score_buy_alert(item)
        z20 = _format_metric(item.levels.get("z20"))
        context = _resolve_research_context(item.key, item.symbol, research_lookup)
        candidate = {
            "key": item.key,
            "score": score,
            "priority": 2,
            "headline": "Potwierdzony sygnal kupna po korekcie.",
            "movement": f"Dzisiaj mechanizm potwierdzil odbicie po korekcie. Odchylenie ceny od sredniej 20 sesji: {z20}.",
            "plan": _price_variable(item),
            "context": context,
        }
        existing = candidates_by_key.get(item.key)
        if existing is None or candidate["score"] >= existing["score"]:
            candidates_by_key[item.key] = candidate

    for event in std_pullback_info:
        score = _score_std_pullback(event)
        one_day_pct = _format_metric(event.metrics.get("one_day_return_pct"))
        sigma = _format_metric(event.metrics.get("one_day_return_in_sigma"))
        context = _resolve_research_context(event.key, event.symbol, research_lookup)
        candidate = {
            "key": event.key,
            "score": score,
            "priority": 1,
            "headline": "Silne cofniecie ceny warte obserwacji pod zakup.",
            "movement": (
                f"Dzisiaj kurs zmienil sie o {one_day_pct}% (okolo {sigma} odchylenia standardowego). "
                "To moze budowac okazje do kupna po potwierdzeniu odbicia."
            ),
            "plan": "To sygnal informacyjny. Najpierw potwierdz odbicie ceny i kontrole ryzyka, dopiero potem rozwaz wejscie.",
            "context": context,
        }
        existing = candidates_by_key.get(event.key)
        if existing is None:
            candidates_by_key[event.key] = candidate
            continue
        if candidate["priority"] > existing["priority"] or (
            candidate["priority"] == existing["priority"] and candidate["score"] > existing["score"]
        ):
            candidates_by_key[event.key] = candidate

    candidates = list(candidates_by_key.values())
    candidates.sort(key=lambda item: (-int(item["score"]), -int(item["priority"]), str(item["key"])))
    return candidates


def _append_buy_opportunities_section(lines: List[str], candidates: List[Dict[str, Any]], *, limit: int = 3) -> None:
    if not candidates:
        return
    top = candidates[:limit]
    lines.append(f"TOP {limit} okazje do rozwazenia zakupu dzisiaj (ranking punktowy):")
    lines.append("Im wyzsza punktacja, tym mocniejszy sygnal do dalszej analizy inwestycji.")
    lines.append("")
    for idx, candidate in enumerate(top, start=1):
        lines.append(f"{idx}. {candidate['key']} | {candidate['score']}/100 pkt")
        lines.append(f"   {candidate['headline']}")
        lines.append(f"   {candidate['movement']}")
        lines.append(f"   Plan na teraz: {candidate['plan']}")
        _append_company_mini_essay(lines, candidate.get("context"), indent="   ")
        lines.append("")
    remaining = len(candidates) - len(top)
    if remaining > 0:
        lines.append(f"Poza top {limit} sa jeszcze {remaining} dodatkowe sygnaly kupna do obserwacji.")
        lines.append("")


def _anomaly_code_text(code: str) -> str:
    labels = {
        "MOMENTUM_WARN": "Slabnacy impet ceny",
        "TREND_DETERIORATION": "Pogorszenie trendu",
        "ABNORMAL_DRAWDOWN": "Nienormalny spadek wzgledem zmiennosci",
        "EXTREME_DRAWDOWN": "Ekstremalny spadek wzgledem zmiennosci",
        "FIXED_DAILY_DROP": "Jednodniowy spadek przekroczyl staly prog",
        "MULTIDAY_DROP": "Parudniowy spadek z przyspieszeniem",
        "RECENT_ABNORMAL_TREND": "Nienormalny trend z ostatnich dni",
        "STD_PULLBACK": "Silne cofniecie wzgledem standardowej zmiennosci",
    }
    return labels.get(code, code)


def _severity_text(value: str) -> str:
    mapping = {
        "HIGH": "wysoki",
        "INFO": "informacyjny",
    }
    return mapping.get(value, value.lower())


def _trend_direction_text(value: str) -> str:
    mapping = {
        "UP": "wzrostowy",
        "DOWN": "spadkowy",
        "FLAT": "neutralny",
    }
    return mapping.get(value, value.lower() if value else "n/a")


def _anomaly_metrics_line(event: AnomalyEvent) -> str:
    if event.code.value == "RECENT_ABNORMAL_TREND":
        return (
            "  Dane z ostatnich sesji: Kierunek={direction}, "
            "Zmiana z 3 sesji={r3}% ({r3s} odchylenia), "
            "Zmiana z 5 sesji={r5}% ({r5s} odchylenia).".format(
                direction=_trend_direction_text(str(event.metrics.get("recent_trend_direction") or "")),
                r3s=_format_metric(event.metrics.get("return_3d_in_sigma")),
                r5s=_format_metric(event.metrics.get("return_5d_in_sigma")),
                r3=_format_metric(event.metrics.get("return_3d_pct")),
                r5=_format_metric(event.metrics.get("return_5d_pct")),
            )
        )
    if event.code.value == "STD_PULLBACK":
        return (
            "  Dane z ostatnich sesji: Zmiana jednodniowa={r1}% "
            "({r1s} odchylenia), typowa zmiennosc dzienna={sig}.".format(
                r1=_format_metric(event.metrics.get("one_day_return_pct")),
                r1s=_format_metric(event.metrics.get("one_day_return_in_sigma")),
                sig=_format_metric(event.metrics.get("sigma_log_20"), precision=4),
            )
        )
    if event.code.value == "MULTIDAY_DROP":
        return (
            "  Dane z ostatnich sesji: Zmiana 3d={r3}%, zmiana 5d={r5}%, "
            "relacja spadku do typowego ruchu={ratio}, dni spadkowe w 5d={down_days}.".format(
                r3=_format_metric(event.metrics.get("drop_3d_pct")),
                r5=_format_metric(event.metrics.get("drop_5d_pct")),
                ratio=_format_metric(event.metrics.get("multiday_drop_ratio")),
                down_days=int(event.metrics.get("down_days_5d") or 0),
            )
        )
    return (
        "  Dane z ostatnich sesji: Skala obsuniecia={drawdown} jednostki zmiennosci, "
        "impet 5 sesji wzgledem zmiennosci={roc}, biezaca zmiennosc dzienna={atr}%.".format(
            drawdown=_format_metric(event.metrics.get("drawdown_in_atr")),
            roc=_format_metric(event.metrics.get("roc_5_norm")),
            atr=_format_metric(event.metrics.get("atr_pct")),
        )
    )


def _anomaly_interpretation(event: AnomalyEvent) -> str:
    mapping = {
        "EXTREME_DRAWDOWN": "Spadek jest duzy nawet po uwzglednieniu typowej zmiennosci tej spolki.",
        "ABNORMAL_DRAWDOWN": "Spadek jest wyraznie wiekszy niz zwykly ruch tej spolki.",
        "FIXED_DAILY_DROP": "Jedna sesja przyniosla bardzo duzy spadek ceny.",
        "MULTIDAY_DROP": "Spadek utrzymuje sie od kilku sesji i przyspieszyl wzgledem typowych ruchow.",
        "RECENT_ABNORMAL_TREND": "Ostatnie sesje tworza nietypowo silny trend, ktory wymaga uwagi.",
        "MOMENTUM_WARN": "Impet wzrostu slabnie i zwieksza sie ryzyko dalszego oslabienia.",
        "TREND_DETERIORATION": "Trend pogarsza sie, a presja podazowa narasta.",
        "STD_PULLBACK": "Pojawilo sie mocniejsze cofniecie, ktore moze budowac setup pod odbicie.",
    }
    return mapping.get(event.code.value, event.text)


def _append_anomaly_section(
    lines: List[str],
    anomaly_events: List[AnomalyEvent],
    research_lookup: Dict[str, Dict[str, Dict[str, Any]]],
) -> None:
    if not anomaly_events:
        return
    lines.append("Szczegolne nienormalne trendy i ryzyka (wysoki priorytet):")
    lines.append("")
    for event in anomaly_events:
        lines.append(f"Spolka: {event.key}")
        lines.append(
            "  Co wykryl mechanizm: {code}. Poziom waznosci: {severity}.".format(
                code=_anomaly_code_text(event.code.value),
                severity=_severity_text(event.severity.value),
            )
        )
        lines.append(
            _anomaly_metrics_line(event)
        )
        lines.append(f"  Interpretacja: {_anomaly_interpretation(event)}")
        _append_company_mini_essay(
            lines,
            _resolve_research_context(event.key, event.symbol, research_lookup),
            indent="  ",
        )
        lines.append("")


def _append_info_buy_section(
    lines: List[str],
    anomaly_events: List[AnomalyEvent],
    research_lookup: Dict[str, Dict[str, Dict[str, Any]]],
) -> None:
    info_events = [item for item in anomaly_events if item.code.value == "STD_PULLBACK"]
    if not info_events:
        return
    lines.append("Informacje o potencjalnym oknie kupna (bez automatycznej decyzji):")
    lines.append("")
    for event in info_events:
        lines.append(f"Spolka: {event.key}")
        lines.append(
            "  Co wykryl mechanizm: {code}. Poziom waznosci: {severity}.".format(
                code=_anomaly_code_text(event.code.value),
                severity=_severity_text(event.severity.value),
            )
        )
        lines.append(_anomaly_metrics_line(event))
        lines.append(f"  Interpretacja: {_anomaly_interpretation(event)}")
        _append_context_block(
            lines,
            _resolve_research_context(event.key, event.symbol, research_lookup),
            indent="  ",
            include_thesis=True,
        )
        lines.append("")


def format_telegram_message(
    bar_date: str | None,
    decisions: Iterable[DecisionOfDay],
    positions: Dict[str, Dict[str, Any]],
    anomaly_events: Iterable[AnomalyEvent] | None = None,
    research_rows: Iterable[Dict[str, Any]] | None = None,
) -> str:
    decisions_list = list(decisions)
    anomaly_list = list(anomaly_events or [])
    research_lookup = _build_research_lookup(research_rows)
    high_anomalies = [item for item in anomaly_list if item.severity == AnomalySeverity.HIGH]
    std_pullback_info = [item for item in anomaly_list if item.code.value == "STD_PULLBACK"]
    actionable = [item for item in decisions_list if is_actionable(item)]
    buy_alerts = [item for item in actionable if item.action.type == Action.BUY_ALERT]
    actionable_non_buy = [item for item in actionable if item.action.type != Action.BUY_ALERT]
    buy_candidates = _build_buy_candidates(
        buy_alerts=buy_alerts,
        std_pullback_info=std_pullback_info,
        research_lookup=research_lookup,
    )
    summary = summarize_positions(positions)

    if not actionable_non_buy and not buy_candidates and not high_anomalies:
        owned = summary["modes"].get("OWNED", 0)
        watch = summary["modes"].get("WATCH", 0)
        normal = summary["states"].get("NORMAL_RUN", 0)
        spike = summary["states"].get("SPIKE_LOCK", 0)
        return (
            f"PSM | {bar_date or 'n/a'}\n"
            "Dzisiaj mechanizm nie wykryl warunkow do nowej transakcji.\n"
            f"Podsumowanie portfela: pozycje aktywne {owned}, obserwowane {watch}. "
            f"Tryb aktywny {normal}, tryb ochronny po gwaltownym ruchu {spike}."
        )

    lines: List[str] = [f"PSM | {bar_date or 'n/a'}", "Dzienny raport mechanizmu:", ""]

    if buy_candidates:
        _append_buy_opportunities_section(lines, buy_candidates, limit=3)

    if actionable_non_buy:
        lines.append("Decyzje wymagajace wykonania dzisiaj:")
        lines.append("")

    critical = 0
    execution = 0
    for item in actionable_non_buy:
        if item.action.type in {Action.SELL_ALL, Action.SELL_PARTIAL, Action.BUY_REENTER}:
            execution += 1
        if item.reason.code.value in {"STOP_HIT", "TREND_BREAK", "FALSIFIER"}:
            critical += 1
        lines.append(f"Spolka: {item.key}")
        lines.append(f"  Wniosek mechanizmu: {_action_text(item)}")
        lines.append(f"  Dlaczego: {_reason_text(item)}")
        lines.append(f"  Parametry: {_price_variable(item)}")
        lines.append(f"  Status: {_state_sentence(item)}")
        _append_company_mini_essay(
            lines,
            _resolve_research_context(item.key, item.symbol, research_lookup),
            indent="  ",
        )
        lines.append("")

    if high_anomalies:
        _append_anomaly_section(lines, high_anomalies, research_lookup)

    lines.append("Krotkie podsumowanie:")
    lines.append(
        f"  Pozycje aktywne: {summary['modes'].get('OWNED', 0)}. Pozycje obserwowane: {summary['modes'].get('WATCH', 0)}."
    )
    lines.append(
        "  Statusy: aktywna {normal}, ochrona po gwaltownym ruchu {spike}, czasowe wstrzymanie {exited}, okno ponownego wejscia {reentry}.".format(
            normal=summary["states"].get("NORMAL_RUN", 0),
            spike=summary["states"].get("SPIKE_LOCK", 0),
            exited=summary["states"].get("EXITED_COOLDOWN", 0),
            reentry=summary["states"].get("REENTRY_WINDOW", 0),
        )
    )
    lines.append(
        "  Okazje kupna do rozwazenia: {buy}. Sygnaly krytyczne: {critical}. Decyzje wykonawcze: {execution}.".format(
            buy=len(buy_candidates),
            critical=critical,
            execution=execution,
        )
    )
    return "\n".join(lines)


def _resolve_symbol_for_key(
    key: str,
    decision_items: List[DecisionOfDay],
    anomaly_items: List[AnomalyEvent],
    positions: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    if decision_items:
        return decision_items[0].symbol
    if anomaly_items:
        return anomaly_items[0].symbol
    identity = positions.get(key, {}).get("identity", {})
    return {
        "ticker": identity.get("ticker"),
        "exchange": identity.get("exchange"),
        "currency": identity.get("currency"),
    }


def _resolve_price_change_for_key(
    key: str,
    decision_items: List[DecisionOfDay],
    anomaly_items: List[AnomalyEvent],
    positions: Dict[str, Dict[str, Any]],
) -> tuple[float | None, float | None]:
    close = None
    day_change_pct = None

    for item in decision_items:
        close_candidate = _as_float(item.levels.get("price_close"))
        if close_candidate is None:
            close_candidate = _as_float(item.action.price_hint)
        if close_candidate is not None and close is None:
            close = close_candidate

        change_candidate = _as_float(item.levels.get("day_change_pct"))
        if change_candidate is None:
            prev_close = _as_float(item.levels.get("prev_close"))
            if close_candidate is not None and prev_close is not None and prev_close != 0:
                change_candidate = (close_candidate - prev_close) / prev_close * 100.0
        if change_candidate is not None and day_change_pct is None:
            day_change_pct = change_candidate

    for event in anomaly_items:
        if close is None:
            close = _as_float(event.metrics.get("close"))
        if day_change_pct is None:
            day_change_pct = _as_float(event.metrics.get("one_day_return_pct"))

    position_computed = positions.get(key, {}).get("computed", {})
    if close is None:
        close = _as_float(position_computed.get("price_close"))
    if day_change_pct is None:
        day_change_pct = _as_float(position_computed.get("day_change_pct"))

    return close, day_change_pct


def _format_price_change_line(close: float | None, day_change_pct: float | None, currency: str) -> str:
    close_text = "n/a" if close is None else f"{close:.2f} {currency}"
    if day_change_pct is None:
        return f"Aktualna cena: {close_text}. Zmiana dzienna: n/a."
    return f"Aktualna cena: {close_text}. Zmiana dzienna: {day_change_pct:+.2f}%."


def _build_per_stock_message(
    *,
    key: str,
    bar_date: str | None,
    decision_items: List[DecisionOfDay],
    anomaly_items: List[AnomalyEvent],
    positions: Dict[str, Dict[str, Any]],
    research_lookup: Dict[str, Dict[str, Dict[str, Any]]],
) -> str:
    symbol = _resolve_symbol_for_key(key, decision_items, anomaly_items, positions)
    contexts = _resolve_research_contexts(key, symbol, research_lookup)
    context = contexts[0] if contexts else _resolve_research_context(key, symbol, research_lookup)
    currency = str(symbol.get("currency") or "USD")
    close, day_change_pct = _resolve_price_change_for_key(
        key=key,
        decision_items=decision_items,
        anomaly_items=anomaly_items,
        positions=positions,
    )

    lines: List[str] = [
        f"📊 PSM | {bar_date or 'n/a'}",
        f"🏢 Spolka: {key}",
        f"💵 {_format_price_change_line(close=close, day_change_pct=day_change_pct, currency=currency)}",
        "",
        "🧠 Co wykryl mechanizm dzisiaj:",
    ]

    if decision_items:
        for item in decision_items:
            lines.append(f"✅ Decyzja: {_action_text(item)}")
            lines.append(f"   Powod: {_reason_text(item)}")
            lines.append(f"   Plan: {_price_variable(item)}")
    if anomaly_items:
        for event in anomaly_items:
            anomaly_icon = "🔴" if event.severity == AnomalySeverity.HIGH else "🟡"
            lines.append(
                "{icon} Anomalia: {code} ({severity}).".format(
                    icon=anomaly_icon,
                    code=_anomaly_code_text(event.code.value),
                    severity=_severity_text(event.severity.value),
                )
            )
            lines.append(f"   {_anomaly_interpretation(event)}")
            lines.append(f"   {_anomaly_metrics_line(event).strip()}")
    if not decision_items and not anomaly_items:
        lines.append("ℹ️ Brak sygnalu decyzyjnego i brak anomalii.")

    fields = _context_fields(context)
    source = fields.get("zrodlo_tezy", CONTEXT_EMPTY)
    thesis = fields.get("teza_inwestycyjna", CONTEXT_EMPTY)
    risk = fields.get("risk", CONTEXT_EMPTY)

    lines.append("")
    lines.append("📝 Historia i sens pozycji:")
    _append_company_mini_essay(lines, context, indent="  ")

    lines.extend(
        [
            "📚 Kontekst tezy:",
            f"• Zrodlo tezy: {source}",
            f"• Teza inwestycyjna (dlaczego ta firma): {thesis}",
            f"• Watpliwosci / ryzyka: {risk}",
        ]
    )

    if contexts:
        lines.append("")
        lines.append("🗂️ Wszystkie tezy z bazy (max 5):")
        for index, item in enumerate(contexts[:5], start=1):
            fields = _context_fields(item)
            entry_date = fields.get("data_decyzji", CONTEXT_EMPTY)
            entry_source = fields.get("zrodlo_tezy", CONTEXT_EMPTY)
            entry_thesis = fields.get("teza_inwestycyjna", CONTEXT_EMPTY)
            entry_risk = fields.get("risk", CONTEXT_EMPTY)
            lines.append(f"- {index}) {entry_date} | zrodlo: {entry_source}")
            lines.append(f"  Teza: {entry_thesis}")
            lines.append(f"  Ryzyka: {entry_risk}")
    return "\n".join(lines)


def _brief_item_icon(decision_items: List[DecisionOfDay], anomaly_items: List[AnomalyEvent]) -> str:
    if any(item.action.type == Action.BUY_ALERT for item in decision_items):
        return "🟢"
    if any(item.code.value == "MULTIDAY_DROP" for item in anomaly_items):
        return "🔻"
    if any(item.severity == AnomalySeverity.HIGH for item in anomaly_items):
        return "🔴"
    if any(item.code.value == "STD_PULLBACK" for item in anomaly_items):
        return "🟡"
    if decision_items:
        return "⚙️"
    return "ℹ️"


def _brief_item_summary(decision_items: List[DecisionOfDay], anomaly_items: List[AnomalyEvent]) -> str:
    if any(item.action.type == Action.BUY_ALERT for item in decision_items):
        return "sygnal BUY"
    if any(item.code.value == "MULTIDAY_DROP" for item in anomaly_items):
        return "parudniowy drop"
    if any(item.severity == AnomalySeverity.HIGH for item in anomaly_items):
        return "silna anomalia ceny"
    if any(item.code.value == "STD_PULLBACK" for item in anomaly_items):
        return "silniejsze cofniecie"
    if decision_items:
        return "decyzja systemu"
    return "obserwacja"


def _build_brief_message(
    *,
    bar_date: str | None,
    sorted_keys: List[str],
    grouped: Dict[str, Dict[str, Any]],
    positions: Dict[str, Dict[str, Any]],
    research_lookup: Dict[str, Dict[str, Dict[str, Any]]],
    max_items: int = 40,
) -> str:
    lines: List[str] = [
        f"📊 PSM | {bar_date or 'n/a'}",
        "🧭 Brief dnia",
        f"Wykryte spolki do uwagi: {len(sorted_keys)}.",
        "Ponizej dostaniesz osobna wiadomosc dla kazdej spolki.",
        "",
    ]
    for index, key in enumerate(sorted_keys[:max_items], start=1):
        payload = grouped.get(key, {})
        decision_items = list(payload.get("decisions", []))
        anomaly_items = list(payload.get("anomalies", []))
        symbol = _resolve_symbol_for_key(key, decision_items, anomaly_items, positions)
        context = _resolve_research_context(key, symbol, research_lookup)
        context_fields = _context_fields(context)
        company_name = context_fields.get("spolka", CONTEXT_EMPTY)
        company_suffix = f" | {company_name}" if company_name and company_name != CONTEXT_EMPTY else ""
        icon = _brief_item_icon(decision_items, anomaly_items)
        summary = _brief_item_summary(decision_items, anomaly_items)
        lines.append(f"{index}. {icon} {key}{company_suffix} - {summary}")

    remaining = len(sorted_keys) - min(len(sorted_keys), max_items)
    if remaining > 0:
        lines.append("")
        lines.append(f"… +{remaining} kolejnych spolek w osobnych wiadomosciach.")
    return "\n".join(lines)


def format_telegram_messages(
    bar_date: str | None,
    decisions: Iterable[DecisionOfDay],
    positions: Dict[str, Dict[str, Any]],
    anomaly_events: Iterable[AnomalyEvent] | None = None,
    research_rows: Iterable[Dict[str, Any]] | None = None,
) -> List[str]:
    decisions_list = list(decisions)
    anomaly_list = list(anomaly_events or [])
    research_lookup = _build_research_lookup(research_rows)
    actionable = [item for item in decisions_list if is_actionable(item)]
    relevant_anomalies = [
        item
        for item in anomaly_list
        if item.severity == AnomalySeverity.HIGH or item.code.value == "STD_PULLBACK"
    ]

    grouped: Dict[str, Dict[str, Any]] = {}

    for item in actionable:
        entry = grouped.setdefault(item.key, {"decisions": [], "anomalies": []})
        entry["decisions"].append(item)

    for event in relevant_anomalies:
        entry = grouped.setdefault(event.key, {"decisions": [], "anomalies": []})
        entry["anomalies"].append(event)

    if not grouped:
        return [
            format_telegram_message(
                bar_date=bar_date,
                decisions=decisions_list,
                positions=positions,
                anomaly_events=anomaly_list,
                research_rows=research_rows,
            )
        ]

    messages: List[str] = []
    def _message_priority(grouped_payload: Dict[str, Any], key_token: str) -> tuple[int, str]:
        anomalies_for_key = list(grouped_payload.get("anomalies", []))
        has_multiday_drop = any(item.code.value == "MULTIDAY_DROP" for item in anomalies_for_key)
        has_high = any(item.severity == AnomalySeverity.HIGH for item in anomalies_for_key)
        if has_multiday_drop:
            return (0, key_token)
        if has_high:
            return (1, key_token)
        return (2, key_token)

    sorted_keys = sorted(grouped.keys(), key=lambda key: _message_priority(grouped.get(key, {}), key))
    messages.append(
        _build_brief_message(
            bar_date=bar_date,
            sorted_keys=sorted_keys,
            grouped=grouped,
            positions=positions,
            research_lookup=research_lookup,
        )
    )
    for key in sorted_keys:
        payload = grouped[key]
        message = _build_per_stock_message(
            key=key,
            bar_date=bar_date,
            decision_items=list(payload.get("decisions", [])),
            anomaly_items=list(payload.get("anomalies", [])),
            positions=positions,
            research_lookup=research_lookup,
        )
        messages.append(message)
    return messages


def send_telegram_message(
    message: str,
    token: str | None = None,
    chat_id: str | None = None,
    sender: Callable[[str], None] | None = None,
) -> bool:
    if sender is not None:
        sender(message)
        return True

    resolved_token = token or os.getenv("TELEGRAM_BOT_TOKEN")
    resolved_chat = chat_id or os.getenv("TELEGRAM_CHAT_ID")
    if not resolved_token or not resolved_chat:
        return False

    url = f"https://api.telegram.org/bot{resolved_token}/sendMessage"
    payload = json.dumps({"chat_id": resolved_chat, "text": message}).encode("utf-8")
    request = Request(url, data=payload, headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=30):
        return True
