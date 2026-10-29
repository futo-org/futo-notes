# futo-notes-editor

Portable exact-source editor engine. Keep its shipped dependencies independent
of filesystem, shells, networking and the local note engine so the same session
can run natively and in WebAssembly.

`EditorSession` validates revision and coordinate boundaries, accepts a recovery
record through its host, then changes source/history and returns a display delta.
The host's append acceptance precedes any view update. Store save/recovery policy
belongs in `futo-notes-store::StoreEditorSession`.

Source queries explicitly materialize whole text; ordinary input copies only
the edit footprint. Use Ropey's indexing instead of scanning a prefix after a
caret jump. History retains inverse edits rather than whole-note strings.

Test the public session with the independent display-only reference view in
`tests/common/`. Literal source/display expectations remain the oracle.
Run `cargo test -p futo-notes-editor -p futo-notes-store -p futo-notes-core`.
The normal `just check` and existing CI Rust workspace/release gate cover these
tests. Read `docs/spec/editor/portable-core.md` before changing this surface.
