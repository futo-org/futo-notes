# futo-notes-merge

The portable three-way source merge shared by sync, the local note engine and
editor history adoption. Keep dependencies independent of filesystem and shells
so the same merge rule compiles natively and in WebAssembly. The core crate
retains its public merge facade for existing consumers.

Ambiguous overlap returns `Conflict`; callers preserve both versions. Exact
source bytes remain authoritative. Changes to the merge rule require public
store/session regressions as well as this crate's examples and properties.

Run `cargo test -p futo-notes-merge -p futo-notes-core -p futo-notes-store
-p futo-notes-editor -p futo-notes-sync`, `just test-cross-platform` and
`just test-editor-wasm`.
