# Structural seam fixtures

`structural-seams.json` contains twenty-eight hand-worked synthetic public-interface
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
