from __future__ import annotations

from src.marketdata.symbols import build_stooq_symbol_candidates, default_stooq_symbol


def test_default_stooq_symbol_uses_exchange_suffix_when_known():
    assert default_stooq_symbol("IFX", "ETR") == "ifx.de"
    assert default_stooq_symbol("ORAS", "EGX") == "oras.eg"
    assert default_stooq_symbol("KBR", "UNKNOWN") == "kbr.us"


def test_build_stooq_symbol_candidates_prioritizes_current_and_exchange_mapping():
    candidates = build_stooq_symbol_candidates("IFX", "ETR", current_symbol="ifx.us")
    assert candidates[0] == "ifx.us"
    assert "ifx.de" in candidates
    assert "ifx.us" in candidates
