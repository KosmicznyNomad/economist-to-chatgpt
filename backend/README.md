# Backend (remote storage + relay to GitHub Actions)

Flask + SQLite backend used as a single entry point for extension responses.

## Integration flow

`extension -> POST /responses -> repository_dispatch -> GitHub Actions -> monitoring API`

The extension sends only the final `lastResponse` plus metadata.
Backend stores the response, then publishes a `repository_dispatch` event.
GitHub Actions performs validation, idempotency (`runId + responseId`), monitoring delivery, and audit artifacts.

## Local run

```powershell
cd economist-to-chatgpt\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

$env:API_KEY = "your-key"                         # optional
$env:DB_PATH = "data/responses.db"                # optional

# Optional GitHub relay:
$env:GITHUB_DISPATCH_ENABLED = "true"
$env:GITHUB_DISPATCH_TOKEN = "ghp_..."
$env:GITHUB_DISPATCH_REPOSITORY = "owner/repo"
$env:GITHUB_DISPATCH_EVENT_TYPE = "analysis_response"

python app.py
```

Default URL: `http://localhost:8787/responses`

## API

- `POST /responses` - save final response, optionally trigger GitHub `repository_dispatch`
- `GET /responses/latest` - latest stored response
- `GET /market/daily` - daily stock changes from DB symbols (Twelve Data)
- `GET /health`

### Example payload (`POST /responses`)

```json
{
  "text": "final response from ChatGPT",
  "timestamp": 1737900930000,
  "source": "Article title",
  "analysisType": "company",
  "runId": "run_20260214_abc",
  "responseId": "run_20260214_abc_4d7264db-9b5f-4e40-a5ff-5fba00dc50db",
  "savedAt": "2026-02-14T13:42:10.213Z",
  "extensionVersion": "1.0.0"
}
```

### Example response

```json
{
  "ok": true,
  "id": 123,
  "responseId": "run_20260214_abc_4d7264db-9b5f-4e40-a5ff-5fba00dc50db",
  "duplicate": false,
  "dispatch": {
    "success": true,
    "status": 204,
    "eventType": "analysis_response",
    "repository": "owner/repo"
  }
}
```

## Auth

If `API_KEY` is set, backend requires header defined by `API_KEY_HEADER`.
Default: `Authorization: Bearer <API_KEY>`.

## Environment variables

### Core

- `DB_PATH` (default: `data/responses.db`)
- `API_KEY` (optional)
- `API_KEY_HEADER` (default: `Authorization`)

### GitHub relay

- `GITHUB_DISPATCH_ENABLED` (`true/false`, default: `false`)
- `GITHUB_DISPATCH_REQUIRED` (`true/false`, default: `false`)
- `GITHUB_DISPATCH_TOKEN` (GitHub token with permission to call repository dispatch)
- `GITHUB_DISPATCH_REPOSITORY` (`owner/repo`, fallback: `GITHUB_REPOSITORY`)
- `GITHUB_DISPATCH_EVENT_TYPE` (default: `analysis_response`)
- `GITHUB_API_BASE_URL` (default: `https://api.github.com`)
- `GITHUB_DISPATCH_TIMEOUT_SEC` (default: `15`)

If `GITHUB_DISPATCH_REQUIRED=true` and dispatch fails, backend returns `502` (response is still stored in DB).

### Market data

- `TWELVEDATA_API_KEY` for `/market/daily`
- `TWELVEDATA_BASE_URL` (default: `https://api.twelvedata.com`)

## Database

`responses` table now includes:

- `response_id` (unique index for dedupe/correlation)
- `run_id`, `source`, `analysis_type`, `text`, `formatted_text`, stage metadata

`four_gate_records` keeps parsed Four-Gate rows linked by `response_id` (DB FK).

## Extension integration

1. Set `CLOUD_UPLOAD.url` in `background.js` to backend URL (`http://localhost:8787/responses`).
2. Set `CLOUD_UPLOAD.enabled = true`.
3. Add backend host to `manifest.json` `host_permissions`.
4. Optionally set backend auth key (`API_KEY` + `CLOUD_UPLOAD.apiKey`).

Extension sends only the final chain output (`lastResponse`), not intermediate stage responses.
