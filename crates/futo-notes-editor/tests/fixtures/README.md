# Structural seam fixtures

`structural-seams.json` contains eleven hand-worked synthetic public-interface
regressions for #296. These are source/display/history/caret oracles, not actual
OS captures. Ranges and carets use native UTF-16 code units. `history` counts Undo
steps, which can exceed the accepted source-record count for composition plus
following input. The editor owner tests retain the original red regressions;
store, FFI, compiled WASM, Swift and Kotlin consume these literals unchanged.

The real UIKit callback evidence remains under `tests/fixtures/editor-native-input`.
