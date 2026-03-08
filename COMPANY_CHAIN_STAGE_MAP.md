# Company Chain Stage Map

This document is the readable contract for `prompts-company.txt` and runtime stage labels.

## Source Of Truth In Code
- Stage metadata is maintained in `background.js` as `STAGE_METADATA_COMPANY`.
- UI consumers fetch it via runtime message `GET_STAGE_NAMES`.
- Backward-compatible field: `stageNames`.
- Structured field: `stageMetadata`.

## Prompt Index Mapping (13 prompts)
- `promptIndex` is 0-based in code.
- `promptNumber` is 1-based in UI and logs.

| promptNumber | promptIndex | stageId | stageName | description |
|---|---:|---|---|---|
| 1 | 0 | 0 | Stage 0: Evidence Ledger + Thesis | Evidence ledger, worldview reconstruction, thesis selection, contract-form pass. |
| 2 | 1 | 1 | Stage 1: Sub-segment Validation | Invoice-first sub-segment map, gates, timing funnel, and top sub-segment selection. |
| 3 | 2 | 2 | Stage 2: Stock Universe (15 names) | Exposure-based company mapping from invoice items to listed names. |
| 4 | 3 | 3 | Stage 3: Thesis-Linked Traction Pack | Contract semantics, traction quality, and Stage 4 handoff objects. |
| 5 | 4 | 3.2 | Stage 3.2: Traction Scoring Pack (Light) | Lean traction scoring pass for 15 companies feeding the Stage 4 valuation screen. |
| 6 | 5 | 4 | Stage 4: Reverse DCF Lite + Driver Screen | Core vs wedge vs total, asymmetry pre-filter, dominant valuation driver. |
| 7 | 6 | 5 | Stage 5: Competitive Position (4 finalists) | Replaceability, moat durability, and S-curve timing selection. |
| 8 | 7 | 6 | Stage 6: DuPont ROE Quality | ROE decomposition (margin x turnover x leverage) under thesis impact. |
| 9 | 8 | 7 | Stage 7: Revaluation Parameter Selection | Single KPI with VOI window and measurable re-rate force. |
| 10 | 9 | 8 | Stage 8: Thesis Monetization Quantification | Incremental wedge cash flows (Bear/Base/Bull), SoP-compatible NPV block. |
| 11 | 10 | 9 | Stage 9: Reverse DCF (TOTAL) | Market-implied growth/margin extraction and divergence diagnostics. |
| 12 | 11 | 10 | Stage 10: Four-Gate Decision + Stage 11 Composite Rank | Per-company WATCH/AVOID gates plus cross-company composite ranking with PRIMARY/SECONDARY selection. |
| 13 | 12 | 12 | Stage 12: Four-Gate Output Record | Two-line decision records (PRIMARY and SECONDARY) for downstream ingestion. |

## Legacy Stage Id Aliases
These aliases are still accepted by `findCompanyPromptIndexByStageIdentifier()`:
- `11` -> `promptIndex 11` (Stage 11 is implemented as a section inside the Stage 10 prompt)
- `3.2` -> `promptIndex 4` (current light traction scoring prompt inserted between Stage 3 and Stage 4)
- `2.5` -> `promptIndex 5` (legacy Reverse DCF Lite numbering)
- `3.5` -> `promptIndex 7` (legacy midpoint naming for DuPont)
- `6.5` -> `promptIndex 7` (compatibility midpoint alias for DuPont)
- `10.5` -> `promptIndex 11` (legacy midpoint naming for composite rank; now Stage 11 section in Stage 10 prompt)

## Editing Checklist
1. Update `prompts-company.txt` with `◄PROMPT_SEPARATOR►` boundaries.
2. Keep metadata order/count in `background.js` aligned to prompt order.
3. Verify logs contain `[prompts] Loaded company prompts: ...`.
4. Verify `stageMetadata.length === PROMPTS_COMPANY.length` in diagnostics.
5. Check resume labels in `resume-stage.html` / `resume-stage.js`.
