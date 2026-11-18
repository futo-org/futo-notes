# Tables (`ta`)

Source: `origin/desktop/new-editor:docs/spec/editor/desktop/tables.md`. Ruling: table controls are open with Mason.

| # | Desktop does | Kind | Phone form / reason | Android now | Action |
| --- | --- | --- | --- | --- | --- |
| ta-1 | Draws a table as a grid, short rows padded, pipes hidden, the delimiter row drawn muted as a line. | host: phone form | A grid. | its own grid with a field per cell (mobile/tables.md) | none |
| ta-2 | Gives every column one width and wraps cells: never wider than the text, never scrolled sideways. | host: phone form | Same rule, or Android's sideways pan. | pans sideways (`TextFirstTableSceneTest`, V full suites) | open with Mason |
| ta-3 | Keeps cell padding; aligns by `:--`, `:-:`, `--:`; header semibold; rules under rows and between columns. | host: phone form | The same. | to measure | measure |
| ta-4 | Draws `\|` as a pipe and inline formats, links and tags in cells. | host: phone form | The same. | `**b**` not bold (V engine merge); wikilink raw (wikilinks.md) | recommend, not built |
| ta-5 | Makes a row one line unit per wrapped row; a caret at a pipe draws at the end of the cell before. | host: phone form | Rows at least 48 dp, a touch target. | 48 dp rows (mobile/tables.md) | none |
| ta-6 | Up/Down move between rows by column; a selection in one cell is highlighted in that cell. | host: phone form | Hardware keyboard; taps open a cell. | to measure | none |
| ta-7 | Redraws only the edited row unless columns change. | not on a phone | DOM drawing detail. | none | none |
| ta-8 | Tab, Enter, Backspace, paste and `\|` in cells follow the engine's table rules. | engine | tables.md. | same | none |
| ta-9 | Mod+Enter in a cell goes to an empty line after the table. | host: phone form | Hardware Ctrl+Enter. | to measure | measure |
| ta-10 | Has no control yet for the engine's row and column commands. | host: phone form | A phone control (ruling: open). | none | open with Mason |
