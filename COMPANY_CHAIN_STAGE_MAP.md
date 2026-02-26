# Company Chain Stage Map

This document is the readable contract for `prompts-company.txt` and runtime stage labels.

## Source Of Truth In Code
- Stage metadata is defined in `background.js` as `STAGE_METADATA_COMPANY`.
- UI consumers fetch it via runtime message: `GET_STAGE_NAMES`.
- Backward-compatible field: `stageNames`.
- New structured field: `stageMetadata`.

## Prompt Index Mapping
- `promptIndex` is 0-based in code.
- `promptNumber` is 1-based in UI and logs.

| promptNumber | promptIndex | stageId | stageName | description |
|---|---:|---|---|---|
| 1 | 0 | 0 | Stage 0: Evidence Ledger + Thesis | Evidence ledger, worldview reconstruction, thesis selection, contract-form pass. |
| 2 | 1 | setup | Pipeline Setup (Rules + Data Contract) | Stage inheritance, time-anchor rules, data discipline, and execution order lock. |
| 3 | 2 | 1 | Stage 1: Sub-segment Validation | Invoice-first sub-segment map, gates, timing funnel, delivered pool. |
| 4 | 3 | 2 | Stage 2: Stock Universe (15 names) | Exposure-based company mapping from invoice items to listed names. |
| 5 | 4 | 2.5 | Stage 2.5: Reverse DCF Lite + Driver Screen | Core vs wedge vs total, asymmetry pre-filter, dominant valuation driver. |
| 6 | 5 | 3 | Stage 3: Competitive Position (4 finalists) | Replaceability, moat durability, and S-curve timing selection. |
| 7 | 6 | 4 | Stage 4: DuPont ROE Quality | ROE decomposition (margin x turnover x leverage) under thesis impact. |
| 8 | 7 | 5 | Stage 5: Revaluation Parameter Selection | Single KPI with VOI window and measurable re-rate force. |
| 9 | 8 | 6 | Stage 6: Thesis Monetization Quantification | Incremental wedge cash flows (Bear/Base/Bull), SoP-compatible NPV block. |
| 10 | 9 | 7 | Stage 7: Reverse DCF (TOTAL) | Market-implied growth/margin extraction and divergence diagnostics. |
| 11 | 10 | 8 | Stage 8: Four-Gate Decision | Integrity/Quality/Value/Proof/Execution gates with BUY-WATCH-AVOID output. |
| 12 | 11 | 9 | Stage 9: Four-Gate Output Record | Single-line decision record for downstream ingestion. |

## Legacy Stage Id Aliases
These aliases are still accepted by `findCompanyPromptIndexByStageIdentifier()`:
- `3.5 -> promptIndex 6` (legacy midpoint naming)
- `10 -> promptIndex 11` (legacy final-stage naming)

## Editing Checklist
1. Update `prompts-company.txt` with `◄PROMPT_SEPARATOR►` boundaries.
2. Update `STAGE_METADATA_COMPANY` in `background.js` to keep count/order aligned.
3. Verify `stageMetadata.length === PROMPTS_COMPANY.length` in logs (`company-count` diagnostics).
4. Check resume UI labels in `resume-stage.html` / `resume-stage.js`.
