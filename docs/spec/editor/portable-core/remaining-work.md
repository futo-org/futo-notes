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

Container commands (#299) are accepted on the integration branch and include canonical
nested and cross-quote lifting,
mixed original-format runs, exact owner fragments, copied ordered starts and same-line
empty prefix frames with distinct nearest/full intents. Root fenced-tail promotion
preserves opaque code and original containment through certified physical edge facts;
new source queries and canonical code-body overlap queries have measured work controls.
The pinned multiline quoted-body Outdent, Backspace and full Text observations,
representative CRLF/entity cases and separate inner/foreign quote ownership now
have exact-source/history and measured-work controls. The 218 shared list literals
run through all six consumers, including compiled WASM and synthetic Swift/Kotlin
FFI/Store tests. Native execution covers arm64 iOS Simulator and an actual x86
Android process; the remaining shipped native architectures have compilation proof.

The bounded source cases now cover promoted code after preceding listed prose,
blank/continuation and multiple fenced blocks, existing nested authored code blanks,
the quoted CRLF task pair and the final established Heading/Quote contexts.
The multiple-fence path has 64/512 parser, copy and metadata growth controls;
original mixed, reversed and endpoint controls remain in the owner chain.
The command planning/proof owners have completed bounded readability cleanup.
The shared-head path has measured source/caret/history and parser/copy/metadata
controls, with an independent pre-cursor constructor field differential. These
finite controls and synthetic consumers do not prove real keyboard/IME input,
renderer parity, complete allocation bounds, physical latency or durability.
Links (#301) are integrated from reviewed source `4f5fdeb89` and fixture-only
repair `ff442e23d` after current source gates, regenerated native consumers and a
fresh 51-scenario desktop/Android aggregate. Native execution remains attributed
to `4f5fdeb89` through unchanged runtime inputs; merged-head checks and CI complete
integration acceptance. Tables, note-id-dependent composition arbitration and
renderer integration retain their own owners and dependent tickets.

Paragraph projections use a length-indexed tree and display Rope, so an ordinary
edit after a distant jump reparses only its paragraph window without rewriting
the note's tail offsets. Work counters include actual parser input for candidate
verification, paragraph partitioning and projection. Work in a single large
paragraph, list or fence still depends on that region; progressive interpretation,
a preceding list row retaining a long run of trailing blanks, complete allocation/work
bounds and native device latency measurements remain
in their dependent tickets.
