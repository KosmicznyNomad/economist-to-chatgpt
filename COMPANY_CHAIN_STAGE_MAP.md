# Company Chain Stage Map

This document is the readable contract for `prompts-company.txt` and runtime stage labels.

## Source Of Truth In Code
- Stage metadata is maintained in `background.js` as `STAGE_METADATA_COMPANY`.
- UI consumers fetch it via runtime message `GET_STAGE_NAMES`.
- Backward-compatible field: `stageNames`.
- Structured field: `stageMetadata`.

## Prompt Index Mapping (15 prompts)
- `promptIndex` is 0-based in code.
- `promptNumber` is 1-based in UI and logs.

| promptNumber | promptIndex | stageId | stageName | description |
|---|---:|---|---|---|
| 1 | 0 | 0 | Stage 0: Evidence Ledger + Thesis | Evidence ledger, worldview reconstruction, thesis selection, contract-form pass. |
| 2 | 1 | 1 | Stage 1: Sub-segment Validation | Invoice-first sub-segment map, gates, timing funnel, delivered pool. |
| 3 | 2 | 2 | Stage 2: Company Mapping (15 names) | Exposure-based company mapping from invoice items to listed names. |
| 4 | 3 | 3 | Stage 3: Thesis-Linked Traction Pack | Contract semantics, traction quality, and VOI objects for valuation handoff. |
| 5 | 4 | 4 | Stage 4: Reverse DCF Lite + Driver Screen | Core vs wedge vs total, asymmetry pre-filter, dominant valuation driver. |
| 6 | 5 | 5 | Stage 5: Competitive Position (4 finalists) | Replaceability, moat durability, and finalist selection from the advanced set. |
| 7 | 6 | 6 | Stage 6: Returns on Capital & Capital Allocation | ROIC, CROIC, incremental returns, and value-destructive growth checks. |
| 8 | 7 | 7 | Stage 7: Revaluation Parameter Selection | Single KPI with VOI window and measurable re-rate force. |
| 9 | 8 | 8 | Stage 8: Thesis Monetization Quantification | Incremental wedge cash flows (Bear/Base/Bull), capture ceilings, and NPV blocks. |
| 10 | 9 | 9 | Stage 9: Reverse DCF (TOTAL) | Market-implied growth/margin extraction and divergence diagnostics. |
| 11 | 10 | 10 | Stage 10: Four-Gate Decision + Stage 11 Composite Rank | Per-company WATCH/AVOID gates plus cross-company composite ranking with PRIMARY/SECONDARY selection. |
| 12 | 11 | 12 | Stage 12: Final Investment Record Builder | Final structured watchlist records for downstream ingestion. |
| 13 | 12 | 12.5 | Stage 12.5: MCP Write Final Investment Records | Persist the previous Stage 12 records through the watchlist MCP write tool. |
| 14 | 13 | 13 | Stage 13: Sector Memory Row Writer | Reusable sector-memory rows for future company analyses. |
| 15 | 14 | 13.5 | Stage 13.5: MCP Write Sector Memory Rows | Persist the previous Stage 13 sector-memory rows through the sector-context MCP tool. |

## Legacy Stage Id Aliases
These aliases are still accepted by `findCompanyPromptIndexByStageIdentifier()`:
- `11` -> `promptIndex 10` (Stage 11 is implemented as a section inside the Stage 10 prompt)
- `setup` -> `promptIndex 1` (legacy setup prompt was folded into the Stage 1 prompt)
- `2.5` -> `promptIndex 4` (legacy Reverse DCF Lite numbering)
- `3.1` -> `promptIndex 3` (traction scoring now lives inside the Stage 3 prompt)
- `3.2` -> `promptIndex 4` (compatibility alias collapsed to Stage 4 prompt)
- `3.5` -> `promptIndex 6` (legacy midpoint naming now resolves to returns quality)
- `6.5` -> `promptIndex 6` (compatibility midpoint alias for returns quality)
- `10.5` -> `promptIndex 10` (legacy midpoint naming for composite rank; now Stage 11 section in Stage 10 prompt)

## Editing Checklist
1. Update `prompts-company.txt` with boundaries using either `◄PROMPT_SEPARATOR►` or `--- PROMPT SEPARATOR ---`.
2. Keep metadata order/count in `background.js` aligned to prompt order.
3. Verify logs contain `[prompts] Loaded company prompts: ...`.
4. Verify `stageMetadata.length === PROMPTS_COMPANY.length` in diagnostics.
5. Check resume labels in `resume-stage.html` / `resume-stage.js`.
