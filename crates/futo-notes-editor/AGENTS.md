# futo-notes-editor

Portable exact-source editor engine. Keep its shipped dependencies independent
of filesystem, shells, networking and the local note engine so the same session
can run natively and in WebAssembly.

`EditorSession` (`src/session.rs`, `src/session/`) is the surface hosts call;
every method hands its work to the core in `src/engine/`. `PortableSession`
applies each input at once and returns the delta with the request that mirrors
it to the worker; acknowledgements never gate the view. Store save policy
belongs in `futo-notes-store::StoreEditorSession`.

`coordinates.rs` holds the UTF-16 entry points native hosts call; never clamp a
foreign range or widen one across a surrogate pair. Selection-only updates
keep source revisions and history unchanged.

`lines/` reads a note one line at a time, as
`docs/spec/editor/portable-core/linedown.md` defines it: each line's block, indent
and inline marks, plus an incremental re-read that stops where the carry from
the lines above settles. Its cases are `tests/fixtures/linedown/`.

`engine/` is the editor core on `lines/`. The note's text, kept as lines with
their readings, is the only stored text: each line's display is its text minus
hidden pieces, and `src/engine/line.rs` lists the few display rules that differ.
A chunked Fenwick index over line sizes finds a line by source, display or
UTF-16 offset without walking the note. Every change is text edits plus one
host acceptance; undo replays reverse edits with selection, affinity and
carried formats. Commands (`src/engine/commands/<family>/`) all take the lines
they are pointed at and the selection and return edits plus a selection, behind
one guard (`src/engine/command.rs`) that cancels a command when a line it did
not name would read as another kind of block. Their literal cases are
`tests/fixtures/engine/`. `src/engine/tests/properties/` holds the five
properties (unchanged bytes on open, exact typing, exact undo, incremental
equals fresh, round-trip positions); `TYPING_CASES`/`TYPING_SEED` widen it and
`LINES_COMPARE` runs it read-only on note directories (`-- --ignored`).
`EditWork` counts re-read bytes, copied source bytes and projection items; the
budget tests (`tests/long_regions*`, the core's own "old engine" tests) may not
go up.

Literal source/display expectations remain the oracle. Run
`cargo test -p futo-notes-editor -p futo-notes-store -p futo-notes-core`, and
`node scripts/test-editor-wasm.mjs` for the WebAssembly consumers, which replay
`tests/fixtures/engine/` through the compiled session and the real store worker.
The normal `just check` and existing CI Rust workspace/release gate cover these
tests. Read `docs/spec/editor/portable-core.md` before changing this surface.

`host/` holds renderer helpers that are not Markdown rules and that every native
view needs (today `DisplayMirror`: display UTF-8 ⇄ UTF-16 conversion of engine
changes). UniFFI projection: `crates/futo-notes-ffi/src/editor/host.rs` (find in `host_find.rs`).
