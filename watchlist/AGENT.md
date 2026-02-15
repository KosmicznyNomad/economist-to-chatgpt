# Position State Machine v4

Ten plik jest operacyjna specyfikacja systemu. Ma byc czytelny dla czlowieka i jednoznaczny dla implementacji.

## 1) Cel

System raz dziennie:
- pobiera dzienne dane OHLCV ze Stooq,
- aktualizuje `data/positions.json` (jedyne zrodlo prawdy),
- liczy wskazniki i poziomy decyzyjne,
- wykonuje deterministyczna maszyne stanow,
- generuje 1 decyzje dzienna per ticker,
- wysyla Telegram tylko przy wyraznych zmianach (actionable), bez duplikatu dla tego samego bara.

Brak UI, brak recznych komend, brak uznaniowosci.

## 2) Architektura

- `src/storage/positions_store.py`
  - load/save,
  - walidacja kontraktu,
  - hard-migrate legacy -> v4,
  - backup `positions.pre_migration.json`.
- `src/marketdata/stooq.py`
  - fetch CSV,
  - parse,
  - merge po dacie,
  - detekcja podejrzanych zmian korporacyjnych.
- `src/engine/indicators.py`
  - TR, ATR EMA-14, SMA, SMA200 slope, 5d move.
- `src/engine/levels.py`
  - spike threshold, chandelier, giveback, effective stop, re-entry band.
- `src/engine/state_machine.py`
  - priorytety i przejscia stanow,
  - egzekucja jednej akcji na bar.
- `src/engine/daily_run.py`
  - orchestration runu,
  - zapis stanu,
  - wynik `DailyRunResult`.
- `src/notify/telegram.py`
  - format i wysylka zbiorczej wiadomosci.

## 3) Kontrakt danych: `data/positions.json`

Top-level to obiekt:
- `meta`
- `global`
- `positions`

### 3.1 `meta`

- `schema_version`: `"psm_v4"`
- `asof_bar_date`: ostatnia data bara przetworzona globalnie
- `last_run_utc`: timestamp ISO UTC

### 3.2 `global` (domyslne stale)

- `atr_period`: 14
- `atr_daily_to_weekly`: 2.2
- `spike_mult`: 2.5
- `sma50_period`: 50
- `sma200_period`: 200
- `sma200_slope_lookback`: 20
- `cooldown_sessions`: 5
- `spike_lock_sessions`: 10
- `reentry_window_sessions`: 40
- `reentry_pullback_min_atrw`: 1.5
- `reentry_pullback_max_atrw`: 4.0
- `catastrophe_floor_pct`: 0.70
- `profit_at_base_pct`: 0.25
- `profit_at_bull_pct`: 0.25
- `spike_sell_pct_first`: 0.25
- `warn_sell_pct`: 0.30
- `reentry_position_pct`: 0.50
- `bars_buffer_max`: 260
- `stooq_fetch_days`: 10
- `stooq_quotes_batch_size`: 8
- `stooq_seed_days`: 400
- `stooq_fallback_days`: 400

### 3.3 `positions`

Mapa po kluczu `TICKER:EXCHANGE`, np. `KBR:NYSE`.

Kazda pozycja ma sekcje:
- `identity`
- `mode`
- `state`
- `targets`
- `execution`
- `thesis_kpis`
- `fundamental_triggers`
- `runtime`
- `buffers`
- `computed`

### 3.4 Invariants

- `mode=OWNED` => `state in {NORMAL_RUN, SPIKE_LOCK}` i `execution.entry_price != null`
- `mode=WATCH` => `state in {EXITED_COOLDOWN, REENTRY_WINDOW}`
- 1 ticker ma maksymalnie 1 bar na date
- `buffers.ohlc` jest posortowane rosnaco po dacie i przyciete do `bars_buffer_max`

## 4) Slownik nazw (obowiazujacy)

- `mode`: `OWNED`, `WATCH`
- `state`: `NORMAL_RUN`, `SPIKE_LOCK`, `EXITED_COOLDOWN`, `REENTRY_WINDOW`
- `action`: `HOLD`, `SELL_PARTIAL`, `SELL_ALL`, `WAIT`, `BUY_REENTER`
- `trigger`: `none`, `warn`, `falsifier`, `confirm`

Reason codes:
- `NO_NEW_BAR`
- `NO_TRIGGER`
- `FALSIFIER`
- `WARN`
- `STOP_HIT`
- `TREND_BREAK`
- `SPIKE_DETECTED`
- `BASE_HIT`
- `BULL_HIT`
- `COOLDOWN_ACTIVE`
- `OPEN_REENTRY_WINDOW`
- `REENTRY_TRIGGERED`
- `REENTRY_EXPIRED`
- `PERMANENT_EXIT`
- `DATA_FETCH_ERROR`
- `DATA_SUSPECTED`
- `DUPLICATE_ACTION_BLOCKED`

## 5) Dzienny pipeline (`run_daily`)

Dla kazdego tickera:
1. Pobierz latest dzienny bar batchowo z endpointu quotes (`q/l`, `f=sd2t2ohlcv`).
2. Jesli ticker nie ma historii lokalnie, dosiej dane z endpointu historycznego (`q/d/l`, `i=d`, zakres dat) do `stooq_seed_days`.
3. Jesli fetch quotes dla tickera padnie, fallback do historycznego `last N` (`N=stooq_fetch_days`).
4. Zmergeuj z `buffers.ohlc` po dacie (dedupe), sort, przyciecie.
5. Wyznacz nowe daty: `date > runtime.last_processed_bar_date`.
6. Jesli brak nowych dat -> decyzja `HOLD`/`WAIT` z `NO_NEW_BAR`.
7. Dla kazdej nowej daty licz wskazniki i poziomy.
8. Uruchom maszyne stanow.
9. Zapisz `runtime.last_processed_bar_date` i `computed`.

Po petli:
- zaktualizuj `meta`,
- zapisz `data/positions.json`,
- zbuduj 1 komunikat Telegram,
- wyslij komunikat tylko gdy sa actionable zmiany i nie byl juz wyslany dla tego samego `bar_date`.

## 6) Wskazniki (kolejnosc i wzory)

### 6.1 True Range

`TR_t = max(H_t - L_t, abs(H_t - C_{t-1}), abs(L_t - C_{t-1}))`

### 6.2 ATR dzienny (EMA-14)

- Inicjalizacja: srednia z pierwszych 14 TR.
- Aktualizacja: `ATR_t = ATR_{t-1} * (13/14) + TR_t * (1/14)`.

### 6.3 ATR tygodniowy (proxy)

`ATR_w = ATR_d * 2.2`

### 6.4 SMA

- `SMA50 = mean(close[-50:])`
- `SMA200 = mean(close[-200:])`

### 6.5 Slope SMA200

- `SMA200_today = mean(close[-200:])`
- `SMA200_20ago = mean(close[-220:-20])`
- `sma200_slope = rising` gdy `today > 20ago`, inaczej `flat_or_falling`

### 6.6 5d move

`five_d_move = close[-1] - close[-6]`

### 6.7 Trend gate

`trend_up = (close > sma200) and (sma200_slope == rising)`

## 7) Poziomy decyzyjne

### 7.1 Spike

- `spike_threshold = spike_mult * atr_w`
- `is_spike = (five_d_move > 0) and (five_d_move > spike_threshold)`

### 7.2 HWM

Aktualizowany tylko przy `mode=OWNED` i stanie otwartej pozycji.

### 7.3 Chandelier stop

`chandelier_stop = hwm_close - k * atr_w`

Reguly `k`:
- `SPIKE_LOCK`: `k=2.0`
- `NORMAL_RUN`:
  - `close < base_total` -> `3.5`
  - `base_total <= close < bull_total` -> `3.0`
  - `close >= bull_total` -> `2.5`
- jesli `warn_count >= 1`: `k = max(1.5, k - 0.5)`

### 7.4 Giveback lock

Aktywne gdy `hwm_close > entry_price`:
- `SPIKE_LOCK` -> `max_giveback=0.20`
- pozostale OWNED -> `0.35`

`giveback_lock = entry + (1 - max_giveback) * (hwm - entry)`

### 7.5 Effective stop

`effective_stop = max(chandelier_stop, giveback_lock_if_any, entry * catastrophe_floor_pct)`

### 7.6 Re-entry band

Tylko gdy mamy `hwm_at_exit` i `atr_w`:
- `pullback_min = hwm_at_exit - 1.5 * atr_w`
- `pullback_max = hwm_at_exit - 4.0 * atr_w`
- `in_band = pullback_max <= close <= pullback_min`

## 8) Maszyna stanow: priorytety

Dokladnie jeden wynik akcji na ticker na bar.

1. `falsifier`:
   - `SELL_ALL`
   - `mode=WATCH`, `state=EXITED_COOLDOWN`
   - `permanent_exit=true`
2. `OWNED` i `close < effective_stop`:
   - `SELL_ALL`, exit do cooldown
3. `OWNED` i `consecutive_closes_below_sma200 >= 2`:
   - `SELL_ALL`, exit do cooldown
4. `NORMAL_RUN` i `is_spike`:
   - `SELL_PARTIAL` (25%), przejscie do `SPIKE_LOCK`
5. `warn`:
   - `warn_count==0` -> `SELL_PARTIAL` (30%), `warn_count=1`
   - `warn_count>=1` -> `SELL_ALL`, `warn_count=2`, `permanent_exit=false`
6. Profit schedule (`NORMAL_RUN`):
   - base hit i `base_sold=false` -> `SELL_PARTIAL` (25%), `base_sold=true`
   - bull hit i `bull_sold=false` -> `SELL_PARTIAL` (25%), `bull_sold=true`
7. Przejscia czasowe:
   - `SPIKE_LOCK` -> `NORMAL_RUN` po 10 sesjach i `close > sma50`
   - `EXITED_COOLDOWN` -> `REENTRY_WINDOW` gdy cooldown zakonczony i `trend_up=true` i nie permanent
   - `REENTRY_WINDOW` -> `BUY_REENTER` (50% target) gdy trigger re-entry
   - `REENTRY_WINDOW` -> `EXITED_COOLDOWN` gdy trend padnie, cena wybije pasmo dolne lub okno wygasnie

Dodatkowe ustalenie:
- W `SPIKE_LOCK` nie ma wielokrotnego `SELL_PARTIAL` co dzien. Sprzedaz jest tylko na wejsciu do locka.

## 9) Re-entry trigger

Warunek laczny:
- `in_band == true`
- sygnal odwrocenia:
  - `close > prev_high`, albo
  - reclaim SMA50 od dolu (`prev_close < prev_sma50` i `close > sma50`)
- `trend_up == true`
- `permanent_exit == false`

## 10) Idempotencja i bezpieczenstwo

- `runtime.last_processed_bar_date`:
  - blokuje ponowne liczenie tego samego bara.
- `runtime.last_action_bar_date`:
  - blokuje podwojna akcje (sprzedaz/kupno) na tym samym barze.
- Merge danych po dacie:
  - brak duplikatow barow.
- Corporate action guard:
  - gdy `close_t / close_{t-1} < 0.5` lub `> 1.5`, oznacz `DATA_SUSPECTED` i przebuduj historie dluzszym fetchem.

## 11) Telegram

- Domyslna polityka: `actionable_only`.
- Gdy sa akcje/zmiany stanu -> wysylany jest 1 zbiorczy komunikat (lista tickerow + podsumowanie).
- Gdy brak actionable zmian -> brak wysylki.
- Deduplikacja: brak ponownej wysylki dla tego samego `bar_date`.
- Kanal wysylki: `src/notify/telegram.py`.

## 12) Migracja legacy

`load_positions` robi hard-migrate przy odczycie, jesli plik nie jest v4.

Mapowanie legacy:
- `ACTIVE -> NORMAL_RUN`
- `PARTIAL_REDUCE -> SELL_PARTIAL` (historycznie, na poziomie interpretacji decyzji)
- `EXIT -> SELL_ALL`
- `REENTER -> BUY_REENTER`
- `WAIT_COOLDOWN|WAIT_SETUP -> WAIT`

W trakcie migracji tworzony jest backup:
- `positions.pre_migration.json`

## 13) Publiczne API

- `run_daily(positions_path="data/positions.json") -> DailyRunResult`
- `run_daily_for_ticker(...) -> DecisionOfDay` (helper testowy)

`DecisionOfDay` zawiera m.in.:
- `bar_date`, `key`, `mode`, `state_before`, `state_after`
- `action` (`type`, `sell_pct`, `buy_pct_of_target`, `price_hint`)
- `reason` (`code`, `text`)
- `levels`

## 14) Checklist operacyjny

- uruchomienie 2x tego samego dnia nie duplikuje akcji,
- brak nowego bara daje `NO_NEW_BAR`,
- `falsifier` ma najwyzszy priorytet,
- `warn#2` nie ustawia `permanent_exit`,
- `SPIKE_LOCK` nie produkuje codziennych partiali,
- Telegram dostaje maksymalnie jedna wiadomosc na dany `bar_date` i tylko przy actionable zmianach.
