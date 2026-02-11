# Backend (remote storage for last response)

Minimalny backend Flask + SQLite. Zapisuje odpowiedzi do tabeli `responses`.

## Uruchomienie lokalne

```powershell
cd economist-to-chatgpt\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:API_KEY = "twoj-klucz"
$env:DB_PATH = "data/responses.db"
python app.py
```

Domyślny URL: `http://localhost:8787/responses`

## API

- `POST /responses` — zapis odpowiedzi
- `GET /responses/latest` — ostatni wpis (opcjonalnie)
- `GET /market/daily` — dzienne zmiany spółek z bazy (wymaga Twelve Data)
- `GET /health`

### Przykładowy payload (z rozszerzenia)

```json
{
  "text": "...",
  "timestamp": 1737900930000,
  "source": "Article title",
  "analysisType": "company",
  "runId": "run_..."
}
```

## Auth

Jeśli ustawisz `API_KEY`, backend wymaga nagłówka zgodnego z `API_KEY_HEADER` (domyślnie `Authorization: Bearer <key>`).

## Dane giełdowe (Twelve Data)

Endpoint `/market/daily` korzysta z Twelve Data. Ustaw zmienną środowiskową:

```
TWELVEDATA_API_KEY=twoj-klucz
```

Tickery są parsowane z pola "Spółka" (np. `Richemont (CFR:SW)`).

## Tabela

`four_gate_records` - ustrukturyzowany zapis linii Four-Gate (15 pol) powiazany z `responses.id`.

`responses` — struktura w `schema.sql`.

## Integracja z rozszerzeniem

1. Ustaw `CLOUD_UPLOAD.url` w `background.js` na adres backendu (domyslnie `http://localhost:8787/responses`).
2. Dodaj do `manifest.json` odpowiedni wpis w `host_permissions`, np. `http://localhost:8787/*` (lub docelowa domena).
3. Opcjonalnie ustaw `API_KEY` i uzupelnij `CLOUD_UPLOAD.apiKey` w `background.js`.

Backend przyjmuje tylko koncowa odpowiedz (stage responses sa zapisywane lokalnie).
