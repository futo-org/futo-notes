# futo-notes-editor

Portable exact-source editor engine. Keep its shipped dependencies independent
of filesystem, shells, networking and the local note engine so the same session
can run natively and in WebAssembly.

`EditorSession` validates revision and coordinate boundaries, accepts a recovery
record through its host, then changes source/history and returns a display delta.
The host's append acceptance precedes any view update. Store save/recovery policy
belongs in `futo-notes-store::StoreEditorSession`.

`coordinates.rs` validates native UTF-16 text and coordinate conversions; never
clamp a foreign range or widen one across a surrogate pair. `movement.rs` uses
Unicode extended grapheme segmentation over Rope chunks. Selection-only updates
keep source revisions/history/recovery unchanged. Source and display use separate
Ropes and coordinate conversions; hidden markers and decoded entities make their
positions differ.

`inline/` owns pulldown-cmark interpretation, paragraph-relative correspondence,
local marker surgery and the length-indexed paragraph tree. Preserve original
span identities and raw visible spellings; verify candidate display and marker
pairing before acceptance. Boundary repairs may encode the immediate neighboring
scalar as an entity so CommonMark can retain its formatting. Code contents stay
opaque to inline interpretation.

Source/display text queries explicitly materialize whole text. Input reparses the
affected paragraphs and their neighbors; paragraph-tree sums avoid rewriting tail
offsets after a distant caret jump. Large single paragraphs/fences still cost
proportional work and need the later progressive/bounded-work tickets. Count all
parser input, including paragraph partitioning and candidate verification.
History retains inverse source edits plus selection, affinity and carried formats
rather than whole-note strings.

Test the public session with the independent display-only reference view in
`tests/common/`. Literal source/display expectations remain the oracle.
Run `cargo test -p futo-notes-editor -p futo-notes-store -p futo-notes-core`.
The normal `just check` and existing CI Rust workspace/release gate cover these
tests. Read `docs/spec/editor/portable-core.md` before changing this surface.
