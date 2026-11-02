# The replacement editor owns exact source text in one shared editor engine

Decided 2026-10-29, following the text-first spike: build the production replacement from
current main, using the spike's findings, regression cases and captured input as evidence.
One Rust editor engine owns markdown interpretation and editing rules. Platform text views
hold display text only: native views on mobile, and on desktop a web text view (CodeMirror 6
or a custom view — amended 2026-11-02: either is acceptable) driving the engine as WebAssembly. Opening never rewrites a note; an edit changes only the source text it touches.
This replaces ADR-0002's permission for whole-note normalization for the replacement editor;
the shipping Milkdown editor keeps its existing contract until each platform switches.

Plan the entire replacement at roadmap level, then detail and execute the Rust editor engine
and its local-note-engine integration first (its recovery log was later dropped; see ADR-0012). Preserve ADR-0001's atomic save and
persist-or-park rules. Use today's file sync, including focused-editor deferral and dirty-draft
protection; applying remote edits during focused typing, CRDTs and collaborative editing are
future work. Persistent undo is also deferred.

The spike demonstrated feasibility but is not the production implementation or a completed
formal proof. Reuse validated behavior and test inputs deliberately, adapting tests to the new
public interface. Full platform parity and cutover follow the engine phase; small binding and
platform checks belong in that phase so the engine's contract remains usable by real views.

The editor engine also owns block and inline interpretation: whether source ranges are code
blocks, headings, links or other markdown constructs, and how they map to display text.
Renderers choose platform layout and visual styling from that description; they do not parse
markdown. Local edits have bounded synchronous work. A change with genuinely large semantic
reach may finish its editor projection progressively in the background, while subsequent
input stays consistent with the displayed text and its position mapping. Background results
must not apply stale interpretations over newer edits, and untouched source bytes stay exact.

Implementation contract: [GitLab issue #283](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/283).
