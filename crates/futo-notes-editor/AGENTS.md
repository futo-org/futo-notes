# futo-notes-editor

Portable exact-source editor engine. Keep its shipped dependencies independent
of filesystem, shells, networking and the local note engine so the same session
can run natively and in WebAssembly.

`EditorSession` validates revision and coordinate boundaries, hands the edit to
its accept hook, then changes source/history and returns a display delta.
`PortableSession` applies each input at once and returns the delta with the
request that mirrors it to the worker; acknowledgements never gate the view.
Store save policy belongs in `futo-notes-store::StoreEditorSession`.

`coordinates.rs` validates native UTF-16 text and coordinate conversions; never
clamp a foreign range or widen one across a surrogate pair. `movement.rs` uses
Unicode extended grapheme segmentation over Rope chunks. Selection-only updates
keep source revisions/history unchanged. Source and display use separate
Ropes and coordinate conversions; hidden markers and decoded entities make their
positions differ.

`inline/` owns pulldown-cmark interpretation, paragraph-relative correspondence,
local marker surgery and the length-indexed paragraph tree. Preserve original
span identities and raw visible spellings; verify candidate display and marker
pairing before acceptance. Boundary repairs may encode the immediate neighboring
scalar as an entity so CommonMark can retain its formatting. Code contents stay
opaque to inline interpretation.

`lines/` reads a note one line at a time, as
`docs/spec/editor/portable-core/linedown.md` defines it: each line's block, depth
and inline marks, plus an incremental re-read that stops where the carry from
the lines above settles. Its cases are `tests/fixtures/linedown/`.

`engine/` is the core being rebuilt on `lines/`; nothing calls it until the
surface cuts over to it. The note's text, kept as lines with their readings, is
the only stored text: each line's display is its text minus hidden pieces, and
`crates/futo-notes-editor/src/engine/line.rs` lists the few display rules that
differ. A chunked Fenwick index over line sizes finds a line by source, display or
UTF-16 offset without walking the note. Every change is text edits plus one host
acceptance; undo replays reverse edits.
`crates/futo-notes-editor/src/engine/tests/properties/` holds the five
properties (unchanged bytes on open, exact typing, exact undo, incremental equals
fresh, round-trip positions); `TYPING_CASES`/`TYPING_SEED` widen it and
`LINES_COMPARE` runs it read-only on note directories (`-- --ignored`).

Source/display text queries explicitly materialize whole text. Input reparses the
affected paragraphs and their neighbors; paragraph-tree sums avoid rewriting tail
offsets after a distant caret jump. Large paragraphs, lists and fences still
need the later progressive/bounded-work tickets. Count all
parser input, including paragraph partitioning and candidate verification.
History retains inverse source edits plus selection, affinity and carried formats
rather than whole-note strings.

Test the public session with the independent display-only reference view in
`tests/common/`. Literal source/display expectations remain the oracle.
Run `cargo test -p futo-notes-editor -p futo-notes-store -p futo-notes-core`.
The normal `just check` and existing CI Rust workspace/release gate cover these
tests. Read `docs/spec/editor/portable-core.md` before changing this surface.

`host/` holds renderer helpers that are not Markdown rules and that every native
view needs (today `DisplayMirror`: display UTF-8 ⇄ UTF-16 conversion of engine
changes). UniFFI projection: `crates/futo-notes-ffi/src/editor/host.rs` (find in `host_find.rs`).
