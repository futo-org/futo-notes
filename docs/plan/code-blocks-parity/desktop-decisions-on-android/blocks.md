# Lists, tasks, quotes and dividers (`bl`)

Source: `origin/desktop/new-editor:docs/spec/editor/desktop/blocks.md`.

| # | Desktop does | Kind | Phone form / reason | Android now | Action |
| --- | --- | --- | --- | --- | --- |
| bl-1 | Indents a list item 1.4em a level (less past the fifth); a wide marker (`100.`) moves its text right; level is the engine's. | host: phone form | The same, in Android's units. | same (~88 px per level; wide markers push the text) | measured |
| bl-2 | The marker is one unit: the caret stops before it and at the text start; Home and Up/Down keep to the text. | host: phone form | Taps and a hardware keyboard's Home/arrows. | Left from the text start goes to the line above; no stop before the marker | differs; host needs a caret stop the TextView lacks (large); not built |
| bl-3 | A click on a marker places the caret on its nearer side; a double click selects the marker. | host: phone form | A tap and a double tap. | a tap on a marker puts the caret at the text start; a double tap selects nothing | differs; same cause as bl-2; not built |
| bl-4 | Highlights a selected marker from its left edge to the text start, no gap. | host: phone form | The same. | same, except a last partial line's number is not tinted | measured; small, not built |
| bl-5 | Typing over the marker unit replaces it; Backspace after it takes it off. | engine | lists.md. | to measure | none |
| bl-6 | Draws a 3px tinted quote bar per level and quote text muted. | host: phone form | The same. | grey bar, upright text; colour open (V 3.10, #13) | none |
| bl-7 | A divider is one atom: a click selects it whole; Backspace after it deletes it. | host: phone form | A tap selects it. | built: a tap on a divider selects it whole, as a tap on an image does (TextFirstDesktopRulesTest); Backspace after it deletes it | built |
| bl-8 | A click on a task's checkbox toggles it in one Undo step; caret, selection and scroll stay. | host: phone form | A tap. | same | measured |
| bl-9 | Enter, Backspace, Tab in lists and quotes, and typed line starts, are the engine's. | engine | lists.md, list-indent.md, list-shortcuts.md. | same | none |
| bl-10 | Mod+Alt+8 bullets, Mod+Alt+7 numbers, Mod+Shift+B quotes. | host: phone form | Hardware Ctrl+Alt+8, Ctrl+Alt+7, Ctrl+Shift+B; touch uses the toolbar. | built: Ctrl+Alt+8, Ctrl+Alt+7, Ctrl+Shift+B (e0d9b4610, TextFirstDesktopRulesTest) | built |
| bl-11 | Copies list lines with their markers; pasted lists become lists. | engine | clipboard.md. | same | none |
| bl-12 | Redraws only changed lines; typing in a long list costs what a paragraph does. | host: phone form | Android's own performance rules (performance/android-text-first.md). | own rules | none |
| bl-13 | Puppet's `doc` names each line's kind. | host: phone form | Android Puppet's own `doc`. | to measure | none |
