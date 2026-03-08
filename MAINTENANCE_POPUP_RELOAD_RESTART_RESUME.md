# Maintenance popup: reload, restart i resume

Ten system ma kilka roznych akcji maintenance. One nie sa tym samym i celowo startuja proces z roznych punktow.

## Co jest czym

### `Wznow nastepny etap` (`popup.html`, shortcut `3`)
Scenariusz: jedna aktywna karta ChatGPT zostala przerwana albo chcemy wznowic tylko biezacy proces.

Flow:
`popup.js -> PROCESS_RESUME_NEXT_STAGE -> handleProcessResumeNextStageMessage() -> resumeFromStage()`

Co robi:
- bierze aktywna karte lub proces z `processRegistry`,
- probuje wykryc ostatni poprawny prompt na podstawie stanu procesu albo audytu rozmowy,
- jezeli ostatni prompt nie doczekal sie odpowiedzi, powtarza ten sam prompt,
- jezeli odpowiedz byla poprawna, odpala kolejny prompt,
- jezeli proces doszedl do finalu, nie restartuje chaina, tylko dopina zapis finalnej odpowiedzi,
- jezeli auto-detekcja nie jest pewna, otwiera `resume-stage.html` do recznego wyboru etapu.

To jest najbezpieczniejsza opcja dla pojedynczej karty.

### `Restart/reload + wznow wszystkie` (`popup.html`, shortcut `4`)
Scenariusz: zbiorczy maintenance po zwisie, po zmianie okien, po utracie odpowiedzi albo gdy chcemy zrestartowac wszystkie aktywne procesy company na kartach INVEST.

Flow:
`popup.js -> DETECT_LAST_COMPANY_PROMPT_AND_RESUME -> runResetScanStartAllTabs()`

Co robi:
- zbiera aktywne procesy company z kart INVEST,
- wysyla stop do procesu z powodem `bulk_resume_reload`,
- robi prepare/reload karty,
- wykrywa ostatni poprawny etap,
- oblicza poprawny `nextStartIndex`,
- odpala proces ponownie w trybie detached,
- zapisuje szczegoly do `reload-resume-monitor.html`.

Kolejnosc rozpoznawania punktu startu:
1. snapshot etapu zapisany w monitorze procesu,
2. analiza ostatniej wiadomosci / podpisu promptu w rozmowie,
3. fallback po liczbie blokow user/assistant,
4. fallback po zapisanym progressie procesu.

Wazna zasada:
- Prompt 1 nie jest replayowany w bulk-resume, bo zawiera payload `{{articlecontent}}`.
- Restart zaczyna sie od pierwszego bezpiecznego promptu po payloadzie albo od promptu, ktory trzeba powtorzyc.

To jest glowny mechanizm "restartu od odpowiedniego miejsca".

### `Bez reloadu` (`popup.html`, shortcut `8`)
Scenariusz: ten sam zbiorczy maintenance, ale bez przeladowywania kart, gdy reload jest zbyt ciezki albo niepotrzebnie destabilizuje sesje.

Flow:
`popup.js -> DETECT_LAST_COMPANY_PROMPT_AND_RESUME(reloadBeforeResume=false) -> runResetScanStartAllTabs()`

Co robi:
- zbiera aktywne procesy company z kart INVEST,
- wysyla stop do procesu z powodem `bulk_resume_no_reload`,
- wymaga potwierdzonego stopa przed wznowieniem, zeby nie dublowac pracy,
- tylko aktywuje karte i przygotowuje ja do detekcji bez hard reloadu,
- wykrywa ostatni poprawny etap,
- oblicza poprawny `nextStartIndex`,
- odpala proces ponownie w trybie detached,
- zapisuje szczegoly do `reload-resume-monitor.html` z metoda `no_reload`.

To jest bezpieczna alternatywa dla trybu z reloadem, kiedy celem jest zatrzymanie i wznowienie procesu bez obciazania karty.

### `Przywroc okna aktywnych procesow` (`popup.html`, shortcut `9`)
Scenariusz: okna sa zminimalizowane, schowane albo rozrzucone, ale nie chcemy jeszcze restartowac prompt chaina.

Flow:
`popup.js -> RESTORE_PROCESS_WINDOWS -> restoreProcessWindows()`

Co robi:
- szuka aktywnych procesow i ich kart/okien,
- przywraca okno do `normal`,
- fokusuje okno i aktywuje odpowiednia karte ChatGPT,
- rozgrupowuje karte z Chrome tab groups, jezeli trzeba.

Czego nie robi:
- nie analizuje etapu,
- nie restartuje prompt chaina,
- nie wysyla promptu.

To jest czysty restore widoku/okna.

### `Auto-restore co 5 min` (`popup.html`, shortcut `0`)
Scenariusz: cykliczny maintenance bez recznego klikania.

Flow:
`SET_AUTO_RESTORE_WINDOWS_ENABLED -> chrome.alarms(auto-restore-process-windows) -> runAutoRestoreWindowsCycle()`

Cykl:
1. `restoreProcessWindows()` przywraca okna aktywnych procesow.
2. `collectAutoRestoreProcessHealthSnapshot()` sprawdza zdrowie rozmowy.
3. Jezeli wykryje problem, uruchamia `runResetScanStartAllTabs()`.

Health check sprawdza m.in.:
- brak odpowiedzi assistant po ostatnim promptcie usera,
- pusta odpowiedz assistant,
- zbyt krotka odpowiedz assistant,
- brak karty, brak kontekstu albo zly URL.

Domyslnie ten cykl jest `OFF`, dopoki nie wlaczy go user.

### `Recovery niedokonczonych (batch)`
Scenariusz: po crashu browsera/service workera lub po dluzszej przerwie chcemy wznowic przerwane procesy z listy recovery.

Flow:
`unfinished-processes.html -> RESUME_UNFINISHED_PROCESSES -> startResumeUnfinishedProcessesBatch()`

Co robi:
- listuje recoverable procesy z zapisanym `chatUrl`,
- moze wznowic wszystko albo limitowany batch,
- przy limicie wybiera najbardziej zaawansowane niedokonczone procesy,
- publikuje postep batcha do `UNFINISHED_RESUME_BATCH_UPDATED`.

To jest mechanizm recovery "z kolejki przerwanych", a nie maintenance biezacej aktywnej karty.

## Jak system wybiera poprawny punkt startu

Najwazniejsze reguly sa stale:

- `Prompt 1` w company chain zawiera payload artykulu, wiec nie jest bezpiecznym punktem wznowienia.
- Jezeli system wykryje, ze prompt zostal wyslany, ale assistant nie odpowiedzial albo odpowiedz jest za krotka, powtarza ten sam prompt.
- Jezeli ostatni prompt zakonczyl sie poprawna odpowiedzia, system przechodzi do kolejnego promptu.
- Jezeli proces jest juz na koncu chaina, system zapisuje final response zamiast odpalac restart bez potrzeby.
- Jezeli auto-detekcja nie daje pewnego wyniku, otwierany jest reczny picker etapu.

To sprawia, ze "restart" w praktyce znaczy:
- nie zaczynaj od zera,
- nie replayuj payloadu,
- startuj od ostatniego bezpiecznego i logicznego miejsca.

## Rola monitorow

### `reload-resume-monitor.html`
Pokazuje maintenance zbiorczy:
- planowany start,
- faktycznie wyslany start,
- powod restartu,
- metode reloadu albo tryb `bez reloadu`,
- detekcje brakujacej odpowiedzi,
- summary `started / detect_failed / reload_failed / start_failed`.

### `process-monitor.html`
Pokazuje runtime decyzje dla pojedynczych procesow:
- `Wznow nastepny etap`,
- `Nastepny etap we wszystkich` dla procesow `needsAction`,
- szczegoly stage/status/reason.

Wazne rozroznienie:
- `Nastepny etap we wszystkich` w panelu procesow nie robi hard reloadu kart,
- `Restart/reload + wznow wszystkie` w popupie robi pelny maintenance z reloadem i ponownym startem.
- `Bez reloadu` w popupie robi ten sam bulk maintenance, ale bez przeladowania kart i tylko po potwierdzonym zatrzymaniu procesu.

## Kiedy czego uzywac

- Jedna aktywna karta utknela, ale okno nadal istnieje: `Wznow nastepny etap`.
- Wiele aktywnych kart INVEST trzeba uporzadkowac i bezpiecznie zrestartowac: `Restart/reload + wznow wszystkie`.
- Wiele aktywnych kart INVEST trzeba wznowic bez obciazajacego przeadowania: `Bez reloadu`.
- Okna procesow zniknely z ekranu albo sa zminimalizowane: `Przywroc okna aktywnych procesow`.
- Chcesz miec cykliczny self-healing: `Auto-restore co 5 min`.
- Potrzebujesz batch recovery po crashu albo dluzszej przerwie: `Recovery niedokonczonych (batch)`.

## Miejsca w kodzie

- `popup.js` - entry pointy z popupu.
- `background.js` - `handleProcessResumeNextStageMessage()`, `runResetScanStartAllTabs()`, `restoreProcessWindows()`, `runAutoRestoreWindowsCycle()`, `startResumeUnfinishedProcessesBatch()`.
- `resume-stage.js` - reczny picker etapu dla wznowienia.
- `reload-resume-monitor.js` - monitor sesji bulk resume, z reloadem albo bez reloadu.
- `unfinished-processes.js` - batch recovery niedokonczonych.
