# Company Chain Stage Map

This document is the readable contract for `prompts-company.txt` and runtime stage labels.

## Source Of Truth In Code
- Stage metadata is maintained in `background.js` as `STAGE_METADATA_COMPANY`.
- UI consumers fetch it via runtime message `GET_STAGE_NAMES`.
- Backward-compatible field: `stageNames`.
- Structured field: `stageMetadata`.

## Prompt Index Mapping (14 prompts)
- `promptIndex` is 0-based in code.
- `promptNumber` is 1-based in UI and logs.

| promptNumber | promptIndex | stageId | stageName | description |
|---|---:|---|---|---|
| 1 | 0 | 0 | Stage 0: Evidence Ledger + Thesis | Evidence ledger, worldview reconstruction, thesis selection, contract-form pass. |
| 2 | 1 | setup | Pipeline Setup (Rules + Data Contract) | Stage inheritance, time-anchor rules, data discipline, and execution order lock. |
| 3 | 2 | 1 | Stage 1: Sub-segment Validation | Invoice-first sub-segment map, gates, timing funnel, delivered pool. |
| 4 | 3 | 2 | Stage 2: Stock Universe (15 names) | Exposure-based company mapping from invoice items to listed names. |
| 5 | 4 | 3 | Stage 3: Thesis-Linked Traction Pack | Contract semantics, traction quality, and VOI objects for valuation handoff. |
| 6 | 5 | 3.1 | Stage 3.1: Traction Scoring (15 names) | TS/TQ/CP scoring rubric and thesis-stream traction objects for the full company universe. |
| 7 | 6 | 4 | Stage 4: Reverse DCF Lite + Driver Screen | Core vs wedge vs total, asymmetry pre-filter, dominant valuation driver. |
| 8 | 7 | 5 | Stage 5: Competitive Position (4 finalists) | Replaceability, moat durability, and S-curve timing selection. |
| 9 | 8 | 6 | Stage 6: DuPont ROE Quality | ROE decomposition (margin x turnover x leverage) under thesis impact. |
| 10 | 9 | 7 | Stage 7: Revaluation Parameter Selection | Single KPI with VOI window and measurable re-rate force. |
| 11 | 10 | 8 | Stage 8: Thesis Monetization Quantification | Incremental wedge cash flows (Bear/Base/Bull), SoP-compatible NPV block. |
| 12 | 11 | 9 | Stage 9: Reverse DCF (TOTAL) | Market-implied growth/margin extraction and divergence diagnostics. |
| 13 | 12 | 10 | Stage 10: Four-Gate Decision + Stage 11 Composite Rank | Per-company WATCH/AVOID gates plus cross-company composite ranking with PRIMARY/SECONDARY selection. |
| 14 | 13 | 12 | Stage 12: Four-Gate Output Record | Two-line decision records (PRIMARY and SECONDARY) for downstream ingestion. |

## Legacy Stage Id Aliases
These aliases are still accepted by `findCompanyPromptIndexByStageIdentifier()`:
- `11` -> `promptIndex 12` (Stage 11 is implemented as a section inside the Stage 10 prompt)
- `2.5` -> `promptIndex 6` (legacy Reverse DCF Lite numbering)
- `3.2` -> `promptIndex 6` (compatibility alias collapsed to Stage 4 prompt)
- `3.5` -> `promptIndex 8` (legacy midpoint naming for DuPont)
- `6.5` -> `promptIndex 8` (compatibility midpoint alias for DuPont)
- `10.5` -> `promptIndex 12` (legacy midpoint naming for composite rank; now Stage 11 section in Stage 10 prompt)

## Editing Checklist
1. Update `prompts-company.txt` with `◄PROMPT_SEPARATOR►` boundaries.
2. Keep metadata order/count in `background.js` aligned to prompt order.
3. Verify logs contain `[prompts] Loaded company prompts: ...`.
4. Verify `stageMetadata.length === PROMPTS_COMPANY.length` in diagnostics.
5. Check resume labels in `resume-stage.html` / `resume-stage.js`.
