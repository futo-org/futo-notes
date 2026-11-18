# Find in note (`fd`)

Source: `origin/desktop/new-editor:docs/spec/editor/desktop/find.md`. Ruling: Android keeps its find bar; measure fd-4, fd-5 and fd-8.

| # | Desktop does | Kind | Phone form / reason | Android now | Action |
| --- | --- | --- | --- | --- | --- |
| fd-1 | Ctrl/Cmd+F opens the bar, query from a one-line selection, else this note's last query. | host: phone form | The overflow menu; hardware Ctrl+F. | built: hardware Ctrl+F opens the bar with a one-line selection as the query (empty for a multi-line one, the last query with none); Ctrl+G / Ctrl+Shift+G step while it is open (TextFirstFindShortcutTest) | built |
| fd-2 | Shows query, count (`3 of 17`, red `0`), previous, next, close. | Android's earlier decision | Android keeps its find bar (ruling). | same items (find-in-note.md) | none |
| fd-3 | Matching is the engine's: case-insensitive, display text, no line crossing. | engine | find.md. | same | none |
| fd-4 | Typing the query makes the first match at or after the selection current and reveals it; the selection does not move. | engine | find.md. | same: typing highlights and reveals; the selection stays (area 15 verifier, 2026-11-17) | measured |
| fd-5 | Enter and arrows step: the first press selects the current match, later ones step from it. | engine | find.md; soft Search key, hardware Enter. | same: the first Search or › selects the current match, the next steps (area 15 verifier; the !300 app steps at once) | measured |
| fd-6 | Paints every match on screen, current darker, kept clear of the bar. | host: phone form | The same. | same (find-in-note.md) | none |
| fd-7 | Editing with the bar open keeps it; rescans 150 ms after input settles. | engine | find.md (carried matches). | to measure | none |
| fd-8 | Escape or × closes: bands go, the current match stays selected, the editor takes focus. | host: phone form | Close button or Back. | same: close leaves the current match selected (area 15 verifier; the !300 app restores the old selection) | measured |
| fd-9 | Opening another note or a reload closes the bar. | host: phone form | The same. | leaving the note clears it (find-in-note.md) | none |
| fd-10 | No replace, regex or case options; cross-note search never seeds find. | host: phone form | The same. | same (find-in-note.md) | none |
