from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
from typing import Any, Dict, Iterable, List
import unicodedata
import xml.etree.ElementTree as ET
import zipfile

from src.marketdata.symbols import default_stooq_symbol
from src.storage.positions_store import ensure_position, load_positions, make_key, save_positions


DEFAULT_XLSX_SOURCE = Path("data/watchlist_import.xlsx")
DEFAULT_CSV_SOURCE = Path("data/watchlist_import.csv")
DEFAULT_REPORT_PATH = Path("out/import_watchlist.json")
XML_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
METHODOLOGY_2026_YEAR = 2026


CANONICAL_FIELDS = [
    "data_decyzji",
    "status_decyzji",
    "spolka",
    "zrodlo_tezy",
    "material_zrodlowy_podcast",
    "teza_inwestycyjna",
    "watpliwosci_ryzyka",
    "ocena_jakosciowa",
    "asymetria_i_wycena",
    "voi_falsy_kluczowe_ryzyka",
    "sektor",
    "region",
    "waluta",
    "why_buy",
    "why_avoid",
]


HEADER_ALIASES = {
    "data_decyzji": {"data decyzji"},
    "status_decyzji": {"status decyzji"},
    "spolka": {"spolka", "spolka ticker"},
    "zrodlo_tezy": {"zrodlo tezy"},
    "material_zrodlowy_podcast": {"material zrodlowy podcast"},
    "teza_inwestycyjna": {
        "teza inwestycyjna dlaczego ta firma",
        "teza inwestycyjna",
    },
    "watpliwosci_ryzyka": {"watpliwosci ryzyka"},
    "ocena_jakosciowa": {"ocena jakosciowa"},
    "asymetria_i_wycena": {"asymetria i wycena"},
    "voi_falsy_kluczowe_ryzyka": {"voi falsy kluczowe ryzyka"},
    "sektor": {"sektor"},
    "region": {"region"},
    "waluta": {"waluta"},
    "why_buy": {"why buy"},
    "why_avoid": {"why avoid"},
}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _strip_diacritics(value: str) -> str:
    mapped = value.translate(
        str.maketrans(
            {
                "ą": "a",
                "ć": "c",
                "ę": "e",
                "ł": "l",
                "ń": "n",
                "ó": "o",
                "ś": "s",
                "ź": "z",
                "ż": "z",
                "Ą": "A",
                "Ć": "C",
                "Ę": "E",
                "Ł": "L",
                "Ń": "N",
                "Ó": "O",
                "Ś": "S",
                "Ź": "Z",
                "Ż": "Z",
            }
        )
    )
    normalized = unicodedata.normalize("NFKD", mapped)
    without_marks = "".join(ch for ch in normalized if not unicodedata.combining(ch))
    return without_marks.encode("ascii", "ignore").decode("ascii")


def _normalize_header(value: str) -> str:
    ascii_value = _strip_diacritics(str(value or ""))
    lowered = ascii_value.lower()
    collapsed = re.sub(r"[^a-z0-9]+", " ", lowered)
    return re.sub(r"\s+", " ", collapsed).strip()


def _build_header_lookup() -> Dict[str, str]:
    lookup: Dict[str, str] = {}
    for canonical, aliases in HEADER_ALIASES.items():
        for alias in aliases:
            lookup[_normalize_header(alias)] = canonical
    return lookup


HEADER_LOOKUP = _build_header_lookup()


def resolve_source_path(source_path: str | Path | None) -> Path:
    if source_path is not None:
        provided = Path(source_path)
        if not provided.exists():
            raise FileNotFoundError(f"Source file not found: {provided}")
        return provided.resolve()

    if DEFAULT_XLSX_SOURCE.exists():
        return DEFAULT_XLSX_SOURCE.resolve()
    if DEFAULT_CSV_SOURCE.exists():
        return DEFAULT_CSV_SOURCE.resolve()

    raise FileNotFoundError(
        "No source file found. Expected data/watchlist_import.xlsx or data/watchlist_import.csv."
    )


def _is_empty_row(values: Iterable[str]) -> bool:
    return all(value == "" for value in values)


def read_rows_from_csv(path: str | Path) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    with Path(path).open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            return rows

        for row_number, row in enumerate(reader, start=2):
            normalized: Dict[str, str] = {}
            for key, value in row.items():
                if key is None:
                    continue
                normalized[str(key)] = "" if value is None else str(value)
            if _is_empty_row(normalized.values()):
                continue
            rows.append({"row_number": row_number, "raw": normalized})
    return rows


def _q(tag: str) -> str:
    return f"{XML_NS}{tag}"


def _column_index_from_cell_ref(cell_ref: str) -> int:
    letters = []
    for char in cell_ref:
        if char.isalpha():
            letters.append(char.upper())
        else:
            break
    if not letters:
        return -1
    result = 0
    for letter in letters:
        result = result * 26 + (ord(letter) - ord("A") + 1)
    return result - 1


def _read_shared_strings(archive: zipfile.ZipFile) -> List[str]:
    if "xl/sharedStrings.xml" not in archive.namelist():
        return []
    root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
    values: List[str] = []
    for si in root.findall(_q("si")):
        text_chunks = [node.text or "" for node in si.findall(f".//{_q('t')}")]
        values.append("".join(text_chunks))
    return values


def _read_first_sheet_xml(archive: zipfile.ZipFile) -> bytes:
    worksheet_paths = sorted(
        path for path in archive.namelist() if path.startswith("xl/worksheets/") and path.endswith(".xml")
    )
    if not worksheet_paths:
        raise ValueError("XLSX file does not contain worksheets.")
    return archive.read(worksheet_paths[0])


def _extract_cell_value(cell: ET.Element, shared_strings: List[str]) -> str:
    cell_type = cell.get("t")
    if cell_type == "inlineStr":
        return "".join(node.text or "" for node in cell.findall(f".//{_q('t')}"))

    value_node = cell.find(_q("v"))
    raw_value = value_node.text if value_node is not None and value_node.text is not None else ""
    if cell_type == "s":
        try:
            return shared_strings[int(raw_value)]
        except (ValueError, IndexError):
            return ""
    if cell_type == "b":
        return "TRUE" if raw_value == "1" else "FALSE"
    return raw_value


def _extract_sheet_rows(sheet_xml: bytes, shared_strings: List[str]) -> List[tuple[int, Dict[int, str]]]:
    root = ET.fromstring(sheet_xml)
    sheet_data = root.find(_q("sheetData"))
    if sheet_data is None:
        return []

    extracted: List[tuple[int, Dict[int, str]]] = []
    for fallback_row_number, row in enumerate(sheet_data.findall(_q("row")), start=1):
        row_number_raw = row.get("r")
        row_number = int(row_number_raw) if row_number_raw and row_number_raw.isdigit() else fallback_row_number
        row_cells: Dict[int, str] = {}
        fallback_column = 0

        for cell in row.findall(_q("c")):
            cell_ref = str(cell.get("r", ""))
            column_index = _column_index_from_cell_ref(cell_ref)
            if column_index < 0:
                column_index = fallback_column
            fallback_column = column_index + 1
            row_cells[column_index] = _extract_cell_value(cell, shared_strings)

        extracted.append((row_number, row_cells))
    return extracted


def read_rows_from_xlsx(path: str | Path) -> List[Dict[str, Any]]:
    with zipfile.ZipFile(Path(path), "r") as archive:
        shared_strings = _read_shared_strings(archive)
        sheet_xml = _read_first_sheet_xml(archive)

    parsed_rows = _extract_sheet_rows(sheet_xml=sheet_xml, shared_strings=shared_strings)
    if not parsed_rows:
        return []

    _, header_cells = parsed_rows[0]
    headers_by_index = {index: str(value) for index, value in header_cells.items()}
    rows: List[Dict[str, Any]] = []
    for row_number, row_cells in parsed_rows[1:]:
        normalized_row = {header: str(row_cells.get(index, "")) for index, header in headers_by_index.items()}
        if _is_empty_row(normalized_row.values()):
            continue
        rows.append({"row_number": row_number, "raw": normalized_row})
    return rows


def normalize_headers_and_fields(raw_row: Dict[str, Any]) -> Dict[str, str]:
    normalized = {field: "" for field in CANONICAL_FIELDS}
    for raw_header, raw_value in raw_row.items():
        header_name = _normalize_header(str(raw_header))
        canonical = HEADER_LOOKUP.get(header_name)
        if canonical is None:
            continue
        normalized[canonical] = "" if raw_value is None else str(raw_value)
    return normalized


def fingerprint_row(fields: Dict[str, str]) -> str:
    serialized = json.dumps(fields, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def parse_decision_year(value: str) -> int | None:
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


def build_research_flags(fields: Dict[str, str]) -> Dict[str, Any]:
    decision_year = parse_decision_year(fields.get("data_decyzji", ""))
    methodology_2026_plus = bool(decision_year is not None and decision_year >= METHODOLOGY_2026_YEAR)
    return {
        "decision_year": decision_year,
        "methodology_2026_plus": methodology_2026_plus,
        "methodology_tag": "METHODOLOGY_2026_PLUS" if methodology_2026_plus else "LEGACY_METHOD",
    }


def parse_identity_guess(spolka: str) -> Dict[str, str | None]:
    text = str(spolka or "")
    pair_patterns = [
        r"\(([A-Za-z0-9._-]{1,20})\s*:\s*([A-Za-z0-9._-]{1,20})\)",
        r"\b([A-Za-z0-9._-]{1,20})\s*:\s*([A-Za-z0-9._-]{1,20})\b",
    ]

    for pattern in pair_patterns:
        match = re.search(pattern, text)
        if match:
            return {
                "ticker": match.group(1).upper(),
                "exchange": match.group(2).upper(),
                "parse_status": "resolved",
            }

    token_patterns = [
        r"^\s*([A-Za-z0-9._-]{1,20})\s*$",
        r"\(([A-Za-z0-9._-]{1,20})\)",
    ]
    for pattern in token_patterns:
        match = re.search(pattern, text)
        if match:
            return {
                "ticker": match.group(1).upper(),
                "exchange": "UNKNOWN",
                "parse_status": "resolved",
            }

    return {
        "ticker": None,
        "exchange": None,
        "parse_status": "unresolved_symbol",
    }


def _read_source_rows(source_path: Path) -> List[Dict[str, Any]]:
    suffix = source_path.suffix.lower()
    if suffix == ".csv":
        return read_rows_from_csv(source_path)
    if suffix == ".xlsx":
        return read_rows_from_xlsx(source_path)
    raise ValueError(f"Unsupported source extension: {source_path.suffix}")


def _write_json(path: str | Path, payload: Dict[str, Any]) -> None:
    file_path = Path(path)
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def import_watchlist(
    positions_path: str | Path = "data/positions.json",
    source_path: str | Path | None = None,
    report_path: str | Path = DEFAULT_REPORT_PATH,
) -> Dict[str, Any]:
    resolved_source = resolve_source_path(source_path)
    source_rows = _read_source_rows(resolved_source)
    imported_at = utc_now_iso()

    store = load_positions(positions_path)
    research_rows_raw = store.get("research_rows", [])
    research_rows: List[Dict[str, Any]] = research_rows_raw if isinstance(research_rows_raw, list) else []
    for row in research_rows:
        if not isinstance(row, dict):
            continue
        fields = row.get("fields")
        if not isinstance(fields, dict):
            continue
        flags = row.get("research_flags")
        if not isinstance(flags, dict):
            row["research_flags"] = build_research_flags(fields)

    existing_fingerprints = {
        str(item.get("row_fingerprint"))
        for item in research_rows
        if isinstance(item, dict) and isinstance(item.get("row_fingerprint"), str)
    }

    added_count = 0
    duplicate_count = 0
    unresolved_symbol_count = 0
    position_upserts_count = 0
    methodology_2026_plus_added_count = 0

    for source_row in source_rows:
        fields = normalize_headers_and_fields(source_row["raw"])
        research_flags = build_research_flags(fields)
        fingerprint = fingerprint_row(fields)
        if fingerprint in existing_fingerprints:
            duplicate_count += 1
            continue

        identity_guess = parse_identity_guess(fields.get("spolka", ""))
        if identity_guess.get("parse_status") != "resolved":
            unresolved_symbol_count += 1
        else:
            ticker = str(identity_guess.get("ticker"))
            exchange = str(identity_guess.get("exchange") or "UNKNOWN")
            key = make_key(ticker, exchange)
            if key not in store.get("positions", {}):
                ensure_position(
                    store=store,
                    key=key,
                    ticker=ticker,
                    exchange=exchange,
                    stooq_symbol=default_stooq_symbol(ticker, exchange),
                )
                position_upserts_count += 1

        research_rows.append(
            {
                "row_fingerprint": fingerprint,
                "imported_at_utc": imported_at,
                "source_file": str(resolved_source),
                "source_row_number": int(source_row["row_number"]),
                "fields": fields,
                "identity_guess": identity_guess,
                "research_flags": research_flags,
            }
        )
        existing_fingerprints.add(fingerprint)
        added_count += 1
        if bool(research_flags.get("methodology_2026_plus")):
            methodology_2026_plus_added_count += 1

    store["research_rows"] = research_rows
    methodology_2026_plus_total_count = len(
        [
            row
            for row in research_rows
            if isinstance(row, dict)
            and isinstance(row.get("fields"), dict)
            and bool(build_research_flags(row.get("fields")).get("methodology_2026_plus"))
        ]
    )
    store["research_import_meta"] = {
        "last_import_utc": imported_at,
        "source_path": str(resolved_source),
        "source_format": resolved_source.suffix.lower().lstrip("."),
        "added_count": added_count,
        "duplicate_count": duplicate_count,
        "total_count": len(source_rows),
        "research_rows_total": len(research_rows),
        "unresolved_symbol_count": unresolved_symbol_count,
        "position_upserts_count": position_upserts_count,
        "methodology_2026_plus_added_count": methodology_2026_plus_added_count,
        "methodology_2026_plus_total_count": methodology_2026_plus_total_count,
    }
    save_positions(store, positions_path)

    report = {
        "schema": "psm_v4.watchlist_import.v1",
        "generated_utc": imported_at,
        "positions_path": str(positions_path),
        "source_path": str(resolved_source),
        "source_format": resolved_source.suffix.lower().lstrip("."),
        "added_count": added_count,
        "duplicate_count": duplicate_count,
        "total_count": len(source_rows),
        "research_rows_total": len(research_rows),
        "unresolved_symbol_count": unresolved_symbol_count,
        "position_upserts_count": position_upserts_count,
        "methodology_2026_plus_added_count": methodology_2026_plus_added_count,
        "methodology_2026_plus_total_count": methodology_2026_plus_total_count,
    }
    _write_json(report_path, report)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Import watchlist rows from Excel/CSV into positions.json.")
    parser.add_argument(
        "--positions-path",
        default="data/positions.json",
        help="Path to state file (default: data/positions.json).",
    )
    parser.add_argument(
        "--source-path",
        default=None,
        help="Optional source path. If omitted, prefers data/watchlist_import.xlsx then data/watchlist_import.csv.",
    )
    parser.add_argument(
        "--report-path",
        default=str(DEFAULT_REPORT_PATH),
        help="Import report output path (default: out/import_watchlist.json).",
    )
    args = parser.parse_args()

    report = import_watchlist(
        positions_path=args.positions_path,
        source_path=args.source_path,
        report_path=args.report_path,
    )
    print(
        "Watchlist import complete: source={source}, added={added}, duplicates={duplicates}, unresolved={unresolved}".format(
            source=report["source_path"],
            added=report["added_count"],
            duplicates=report["duplicate_count"],
            unresolved=report["unresolved_symbol_count"],
        )
    )


if __name__ == "__main__":
    main()
