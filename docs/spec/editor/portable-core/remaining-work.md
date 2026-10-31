# Remaining work and performance limits

Table alignment changes, row reordering, column reordering and multi-cell/grid paste are
also deferred by the maintainer. Preserve existing alignment and exact untouched bytes.
Basic row/column insertion and deletion, cell editing/navigation and ordinary single-cell
paste remain required; shared find and 20,000-line performance/durability remain required.

Rich HTML paste (#303) and rendered block movement (#311) are deferred by the maintainer's
2026-10-30 scope decision and do not block this milestone; their issues remain open for later
work. Plain-text/Markdown paste, including ordinary single-cell table paste, remains
required. Tables, shared find, wikilink completion and the 20,000-line/native durability
acceptance targets have not been deferred. → docs/plan/text-first-editor-rebuild-tickets.md

Fenced-code interpretation and key intent (#297) are accepted on the integration branch;
large-fence work bounds, progressive reinterpretation and physical device validation remain
required. → docs/spec/editor/portable-core/fenced-code.md

Deeper container commands (#299) and links (#301) remain unmerged WIP. Tables and
note-id-dependent composition arbitration remain in their dependent tickets. Full renderer
integration follows the engine/store phase. → docs/plan/text-first-editor-rebuild-tickets.md

Paragraph projections use a length-indexed tree and display Rope, so an ordinary
edit after a distant jump reparses only its paragraph window without rewriting
the note's tail offsets. Work counters include actual parser input for candidate
verification, paragraph partitioning and projection. Work in a single large
paragraph, list or fence still depends on that region; progressive interpretation,
a preceding list row retaining a long run of trailing blanks, complete allocation/work
bounds and native device latency measurements remain
in their dependent tickets.
