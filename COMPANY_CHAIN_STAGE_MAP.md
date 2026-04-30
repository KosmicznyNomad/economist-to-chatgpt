# Company Chain Stage Map

This document is the readable contract for `prompts-company.txt` and runtime stage labels.

## Source Of Truth In Code
- Stage metadata is maintained in `background.js` as `STAGE_METADATA_COMPANY`.
- UI consumers fetch it via runtime message `GET_STAGE_NAMES`.
- Backward-compatible field: `stageNames`.
- Structured field: `stageMetadata`.

## Prompt Index Mapping (18 prompts)
- `promptIndex` is 0-based in code.
- `promptNumber` is 1-based in UI and logs.

| promptNumber | promptIndex | stageId | stageName | description |
|---|---:|---|---|---|
| 1 | 0 | 0 | Stage 0: Evidence Ledger + Thesis | Evidence ledger, worldview reconstruction, thesis selection, contract-form pass. |
| 2 | 1 | 1 | Stage 1: Sub-segment Validation | Invoice-first sub-segment map, gates, timing funnel, delivered pool. |
| 3 | 2 | 2 | Stage 2: Company Mapping (15 names) | Exposure-based company mapping from invoice items to listed names. |
| 4 | 3 | 3 | Stage 3: Thesis-Linked Traction Pack | Contract semantics, traction quality, and VOI objects for valuation handoff. |
| 5 | 4 | 4 | Stage 4: Company CORE Reconstruction | Market-anchored going-concern CORE, CORE/WEDGE boundary, and downstream restrictions. |
| 6 | 5 | 5 | Stage 5: MCP Sector Overlay / CORE Challenge | Iskierka sector-memory audit of CORE, boundary, proof standards, and decision-grade status. |
| 7 | 6 | 6 | Stage 6: Valuation Diagnostics / Reverse DCF Lite | Diagnostic reverse DCF lite using Stage 4 CORE_ADOPTED and MCP-adjusted CORE confidence. |
| 8 | 7 | 7 | Stage 7: Competitive Position (4 finalists) | Replaceability, moat durability, and finalist selection from the advanced set. |
| 9 | 8 | 8 | Stage 8: Returns on Capital & Capital Allocation | ROIC, CROIC, incremental returns, and value-destructive growth checks. |
| 10 | 9 | 9 | Stage 9: Revaluation Parameter Selection | Single KPI with VOI window and measurable re-rate force. |
| 11 | 10 | 10 | Stage 10: Thesis Monetization Quantification | Incremental wedge cash flows (Bear/Base/Bull), capture ceilings, and NPV blocks. |
| 12 | 11 | 11 | Stage 11: Reverse DCF (TOTAL) | Market-implied growth/margin extraction and divergence diagnostics. |
| 13 | 12 | 12 | Stage 12: Four-Gate Decision | Per-company WATCH/AVOID gates, integrity checks, value/proof gates, and execution plan handoff. |
| 14 | 13 | 13 | Stage 13: Composite Rank | Cross-company composite ranking with PRIMARY/SECONDARY selection. |
| 15 | 14 | 14 | Stage 14: Final Investment Record Builder | Final structured watchlist records for downstream ingestion. |
| 16 | 15 | 15 | Stage 15: MCP Write Final Investment Records | Persist the generated Stage 14 records through the dedicated Iskierka stage12 research-row MCP writer, then copy the generated Stage 14 JSON forward. |
| 17 | 16 | 16 | Stage 16: Sector Memory Row Writer | Reusable sector-memory rows for future company analyses. |
| 18 | 17 | 17 | Stage 17: MCP Write Sector Memory Rows | Persist the generated Stage 16 sector-memory rows through the Iskierka sector-context MCP tool, then copy the generated Stage 16 JSON forward. |

## Stage Id Rules
Runtime stage ids are numeric only.
- `0` -> `promptIndex 0`
- `1` through `17` -> their matching stage prompt by numeric id
- `setup` -> `promptIndex 1` remains as a UI compatibility alias for the Stage 1 prompt

There are no current `A`, `B`, `.5`, or boundary pseudo-stage ids in the active company chain. If a boundary is missing, the prompt should request the owning numeric stage, for example `DATA_GAP_STAGE=4`.

## Editing Checklist
1. Update `prompts-company.txt` with boundaries using either `◄PROMPT_SEPARATOR►` or `--- PROMPT SEPARATOR ---`.
2. Keep metadata order/count in `background.js` aligned to prompt order.
3. Verify logs contain `[prompts] Loaded company prompts: ...`.
4. Verify `stageMetadata.length === PROMPTS_COMPANY.length` in diagnostics. The runtime also autodetects stage headings from `prompts-company.txt` after loading the prompt chain.
5. Check resume labels in `resume-stage.html` / `resume-stage.js`.
