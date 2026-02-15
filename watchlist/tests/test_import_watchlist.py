from __future__ import annotations

import csv
import json
from pathlib import Path
import zipfile
from xml.sax.saxutils import escape

import pytest

from src.ops.import_watchlist import import_watchlist, resolve_source_path
from src.storage.positions_store import load_positions


HEADERS = [
    "Data decyzji",
    "Status decyzji",
    "spolka",
    "Zrodlo tezy",
    "Material zrodlowy / podcast",
    "Teza inwestycyjna (dlaczego ta firma)",
    "Watpliwosci / ryzyka",
    "Ocena jakosciowa",
    "Asymetria i wycena",
    "VOI / Falsy / Kluczowe ryzyka",
    "sektor",
    "region",
    "waluta",
    "WHY BUY",
    "WHY AVOID",
]


def _write_csv(path: Path, headers: list[str], rows: list[list[str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(headers)
        writer.writerows(rows)


def _column_letters(index: int) -> str:
    letters = []
    number = index + 1
    while number > 0:
        number, remainder = divmod(number - 1, 26)
        letters.append(chr(ord("A") + remainder))
    return "".join(reversed(letters))


def _build_sheet_xml(headers: list[str], rows: list[list[str]]) -> str:
    all_rows = [headers] + rows
    rows_xml = []
    for row_number, row in enumerate(all_rows, start=1):
        cells_xml = []
        for col_index, value in enumerate(row):
            cell_ref = f"{_column_letters(col_index)}{row_number}"
            text = escape(str(value))
            cells_xml.append(
                '<c r="{ref}" t="inlineStr"><is><t xml:space="preserve">{text}</t></is></c>'.format(
                    ref=cell_ref,
                    text=text,
                )
            )
        rows_xml.append('<row r="{row}">{cells}</row>'.format(row=row_number, cells="".join(cells_xml)))
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        "<sheetData>{rows}</sheetData>"
        "</worksheet>"
    ).format(rows="".join(rows_xml))


def _write_minimal_xlsx(path: Path, headers: list[str], rows: list[list[str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        "</Types>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="xl/workbook.xml"/>'
        "</Relationships>"
    )
    workbook = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>'
        "</workbook>"
    )
    workbook_rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
        'Target="worksheets/sheet1.xml"/>'
        "</Relationships>"
    )
    sheet = _build_sheet_xml(headers=headers, rows=rows)

    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", content_types)
        archive.writestr("_rels/.rels", rels)
        archive.writestr("xl/workbook.xml", workbook)
        archive.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        archive.writestr("xl/worksheets/sheet1.xml", sheet)


def test_import_watchlist_csv_is_idempotent_and_appends_new_rows(tmp_path: Path):
    positions_path = tmp_path / "positions.json"
    source_path = tmp_path / "watchlist.csv"
    report_path = tmp_path / "import_report.json"
    _write_csv(
        source_path,
        HEADERS,
        [
            ["2026-02-14", "NEW", "ORAS:EGX", "podcast", "odcinek 1", "teza A", "", "A", "A+", "", "Industrials", "EMEA", "EGP", "good", "risk"],
            ["2026-02-15", "NEW", "KBR", "analiza", "raport", "teza B", "", "B", "B+", "", "Industrials", "US", "USD", "good", "risk"],
        ],
    )

    first = import_watchlist(positions_path=positions_path, source_path=source_path, report_path=report_path)
    assert first["added_count"] == 2
    assert first["duplicate_count"] == 0
    assert first["total_count"] == 2
    assert first["methodology_2026_plus_added_count"] == 2
    assert first["methodology_2026_plus_total_count"] == 2

    second = import_watchlist(positions_path=positions_path, source_path=source_path, report_path=report_path)
    assert second["added_count"] == 0
    assert second["duplicate_count"] == 2
    assert second["total_count"] == 2

    _write_csv(
        source_path,
        HEADERS,
        [
            ["2026-02-14", "NEW", "ORAS:EGX", "podcast", "odcinek 1", "teza A", "", "A", "A+", "", "Industrials", "EMEA", "EGP", "good", "risk"],
            ["2026-02-15", "NEW", "KBR", "analiza", "raport", "teza B", "", "B", "B+", "", "Industrials", "US", "USD", "good", "risk"],
            ["2026-02-16", "NEW", "AAPL", "analiza", "raport", "teza C", "", "A", "A+", "", "Tech", "US", "USD", "good", "risk"],
        ],
    )
    third = import_watchlist(positions_path=positions_path, source_path=source_path, report_path=report_path)
    assert third["added_count"] == 1
    assert third["duplicate_count"] == 2
    assert third["total_count"] == 3
    assert third["methodology_2026_plus_added_count"] == 1
    assert third["methodology_2026_plus_total_count"] == 3

    store = load_positions(positions_path)
    assert len(store["research_rows"]) == 3
    assert store["research_rows"][0]["research_flags"]["methodology_2026_plus"] is True
    assert store["research_rows"][0]["research_flags"]["decision_year"] == 2026
    assert store["research_rows"][0]["research_flags"]["methodology_tag"] == "METHODOLOGY_2026_PLUS"
    assert "ORAS:EGX" in store["positions"]
    assert "KBR:UNKNOWN" in store["positions"]
    assert "AAPL:UNKNOWN" in store["positions"]
    assert store["positions"]["ORAS:EGX"]["identity"]["stooq_symbol"] == "oras.eg"
    assert store["positions"]["KBR:UNKNOWN"]["identity"]["stooq_symbol"] == "kbr.us"


def test_import_watchlist_accepts_duplicate_company_with_different_columns(tmp_path: Path):
    positions_path = tmp_path / "positions.json"
    source_path = tmp_path / "watchlist.csv"
    _write_csv(
        source_path,
        HEADERS,
        [
            ["2026-02-14", "NEW", "KBR", "podcast", "ep1", "teza A", "", "A", "A+", "", "Industrial", "US", "USD", "good", "risk"],
            ["2026-02-15", "REVIEW", "KBR", "podcast", "ep2", "teza B", "", "B", "B+", "", "Industrial", "US", "USD", "better", "risk"],
        ],
    )

    report = import_watchlist(positions_path=positions_path, source_path=source_path, report_path=tmp_path / "r.json")
    assert report["added_count"] == 2
    assert report["duplicate_count"] == 0

    store = load_positions(positions_path)
    assert len(store["research_rows"]) == 2


def test_import_watchlist_fills_missing_columns_and_parses_ticker_only(tmp_path: Path):
    positions_path = tmp_path / "positions.json"
    source_path = tmp_path / "watchlist.csv"
    _write_csv(
        source_path,
        ["spolka", "Status decyzji"],
        [
            ["ORAS", "NEW"],
        ],
    )

    report = import_watchlist(positions_path=positions_path, source_path=source_path, report_path=tmp_path / "r.json")
    assert report["added_count"] == 1
    assert report["unresolved_symbol_count"] == 0

    store = load_positions(positions_path)
    row = store["research_rows"][0]
    assert row["fields"]["spolka"] == "ORAS"
    assert row["fields"]["status_decyzji"] == "NEW"
    assert row["fields"]["region"] == ""
    assert row["identity_guess"]["ticker"] == "ORAS"
    assert row["identity_guess"]["exchange"] == "UNKNOWN"
    assert row["identity_guess"]["parse_status"] == "resolved"
    assert "ORAS:UNKNOWN" in store["positions"]


def test_import_watchlist_exact_dedupe_treats_space_as_new_row(tmp_path: Path):
    positions_path = tmp_path / "positions.json"
    source_path = tmp_path / "watchlist.csv"
    _write_csv(
        source_path,
        ["spolka", "WHY BUY"],
        [
            ["KBR", "alpha"],
            ["KBR", "alpha "],
        ],
    )

    report = import_watchlist(positions_path=positions_path, source_path=source_path, report_path=tmp_path / "r.json")
    assert report["added_count"] == 2
    assert report["duplicate_count"] == 0


def test_resolve_source_path_prefers_xlsx_then_csv_and_errors(tmp_path: Path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    data_dir = tmp_path / "data"
    xlsx_path = data_dir / "watchlist_import.xlsx"
    csv_path = data_dir / "watchlist_import.csv"

    _write_minimal_xlsx(xlsx_path, headers=["spolka"], rows=[["KBR"]])
    _write_csv(csv_path, ["spolka"], [["AAPL"]])
    assert resolve_source_path(None) == xlsx_path

    xlsx_path.unlink()
    assert resolve_source_path(None) == csv_path

    csv_path.unlink()
    with pytest.raises(FileNotFoundError):
        resolve_source_path(None)


def test_import_watchlist_reads_xlsx_and_maps_polish_headers(tmp_path: Path):
    positions_path = tmp_path / "positions.json"
    source_path = tmp_path / "watchlist.xlsx"
    report_path = tmp_path / "import_report.json"

    _write_minimal_xlsx(
        source_path,
        headers=["sp\u00f3\u0142ka", "Status decyzji", "\u0179r\u00f3d\u0142o tezy", "WHY BUY"],
        rows=[["Orascom Construction PLC (ORAS:EGX)", "NEW", "podcast", "quality"]],
    )

    report = import_watchlist(positions_path=positions_path, source_path=source_path, report_path=report_path)
    assert report["added_count"] == 1
    assert report["duplicate_count"] == 0

    report_blob = json.loads(report_path.read_text(encoding="utf-8"))
    assert report_blob["source_format"] == "xlsx"

    store = load_positions(positions_path)
    row = store["research_rows"][0]
    assert row["fields"]["spolka"] == "Orascom Construction PLC (ORAS:EGX)"
    assert row["fields"]["status_decyzji"] == "NEW"
    assert row["fields"]["zrodlo_tezy"] == "podcast"
    assert row["fields"]["why_buy"] == "quality"
    assert row["identity_guess"]["ticker"] == "ORAS"
    assert row["identity_guess"]["exchange"] == "EGX"
    assert row["identity_guess"]["parse_status"] == "resolved"
    assert "ORAS:EGX" in store["positions"]
    assert store["positions"]["ORAS:EGX"]["identity"]["stooq_symbol"] == "oras.eg"


def test_import_watchlist_keeps_unresolved_company_rows(tmp_path: Path):
    positions_path = tmp_path / "positions.json"
    source_path = tmp_path / "watchlist.csv"
    _write_csv(
        source_path,
        ["spolka", "Status decyzji"],
        [["Orascom Construction PLC", "NEW"]],
    )

    report = import_watchlist(positions_path=positions_path, source_path=source_path, report_path=tmp_path / "r.json")
    assert report["added_count"] == 1
    assert report["unresolved_symbol_count"] == 1

    store = load_positions(positions_path)
    row = store["research_rows"][0]
    assert row["identity_guess"]["parse_status"] == "unresolved_symbol"
    assert row["identity_guess"]["ticker"] is None
    assert row["identity_guess"]["exchange"] is None
