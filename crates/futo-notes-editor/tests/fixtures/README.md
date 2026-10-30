# Structural seam fixtures

`structural-seams.json` contains nineteen hand-worked synthetic public-interface
regressions for #296. These are source/display/history/caret oracles, not actual
OS captures. Ranges and carets use native UTF-16 code units. `history` counts Undo
steps, which can exceed the accepted source-record count for composition plus
following input. The editor owner tests retain the original red regressions;
store, FFI, compiled WASM, Swift and Kotlin consume these literals unchanged.

An unchanged explicit following run can move selection without adding history
after a changed marked commit. Its optional `redoCaret` records that Redo restores
the marked commit's caret, separately from the subsequent selection-only result.

The real UIKit callback evidence remains under `tests/fixtures/editor-native-input`.
