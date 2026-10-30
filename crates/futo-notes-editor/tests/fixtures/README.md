# Structural seam fixtures

`structural-seams.json` contains thirty-eight hand-worked synthetic public-interface
regressions for #296. These are source/display/history/caret oracles, not actual
OS captures. Ranges and carets use native UTF-16 code units. `history` counts Undo
steps, which can exceed the accepted source-record count for composition plus
following input. The editor owner tests retain the original red regressions;
store, FFI, compiled WASM, Swift and Kotlin consume these literals unchanged.

An unchanged explicit following run can move selection without adding history
after a changed marked commit. Its optional `redoCaret` records that Redo restores
the marked commit's caret, separately from the subsequent selection-only result.

The real UIKit callback evidence remains under `tests/fixtures/editor-native-input`.

The selected-source cases distinguish a whole explicit replacement that owns a
lower setext body and its boundary from a body-only replacement that retains the
heading. They include CRLF with untouched entity-spelled neighbors and explicit
input after unchanged raw marking; they do not change OS changed-run discovery.

The typing-history cases supply an `inputs` sequence of action/text pairs at each
returned caret, with optional carried Bold or Code. Ordinary input keeps one
adjacent typing group through quote repair or divider insertion; an explicitly
isolated first input keeps two. The same family covers a whitespace typing run
that enters quote repair. Fixed-clock editor/store tests own the exact timing
and failed-acceptance boundaries; thin consumers use the normal session clock.

`list-actions.json` retains twenty-four hand-worked synthetic public-interface
regressions for #298; `list-shortcuts.json` adds twenty-two literal shortcut boundary
controls. All consumers assert both family counts. `range`, optional
`selection`, `composeRange`, `resultRange` and `undoRanges` use native UTF-16 units.
`expected`/`shown` are exact final source/display literals. Default history has one
Undo to `source`/`display`/initial selection; optional `undoSources`, `undoDisplays`
and `undoRanges` describe every intermediate group. Composition plus checkbox
shares one protected acceptance and retains two Undo groups. `finalItems` gives
literal `[interpreted ordinal or null, checked state or null]` pairs for the final
first lines at depth one; `quoteDepth` defaults to zero. Consumers also request
the EOF caret slice so a zero-width final item is checked. No expected value is
derived from a Markdown parser. The original thirty-eight seam literals remain
unchanged.
