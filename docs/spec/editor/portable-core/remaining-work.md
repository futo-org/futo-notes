# Remaining work and performance limits

Table alignment changes, row reordering, column reordering and multi-cell/grid paste are
also deferred by the maintainer. Preserve existing alignment and exact untouched bytes.
Basic row/column insertion and deletion, cell editing/navigation and ordinary single-cell
paste remain required; shared find and 20,000-line performance remain required.

Tables (#308, #309, #310) are implemented on the shared engine; see tables.md. Table-in-container
recognition, `<br>` display projection and renderer integration remain.

Rich HTML paste (#303) and rendered block movement (#311) are deferred by the maintainer's
2026-10-30 scope decision and do not block this milestone; their issues remain open for later
work. Plain-text/Markdown paste, including ordinary single-cell table paste, remains
required. Tables, shared find, wikilink completion and the 20,000-line
acceptance targets have not been deferred. → docs/plan/text-first-editor-rebuild-tickets.md

The mobile toolbar shows Indent and Outdent everywhere and greys them out where the engine's
`can_indent`/`can_outdent` is false (list-indent.md). The shared toolbar manifest still shows them only
when the caret is in a list or quote (`when: 'inContainer'`, packages/editor/src/toolbar.ts), so
the manifest and the native toolbars remain to follow this rule.
→ docs/spec/editor/markdown-toolbar/toolbar-commands.md

Fenced-code interpretation and key intent (#297) are accepted on the integration branch;
large-fence work bounds, progressive reinterpretation and physical device validation remain
required. → docs/spec/editor/portable-core/fenced-code.md

Container commands (#299) are accepted on the integration branch and include canonical
nested and cross-quote lifting,
mixed original-format runs, exact owner fragments, copied ordered starts and same-line
empty prefix frames with distinct nearest/full intents. Root fenced-tail promotion
preserves opaque code and original containment through certified physical edge facts;
new source queries and canonical code-body overlap queries have measured work controls.
The pinned multiline quoted-body Backspace and full Text observations,
representative CRLF/entity cases and separate inner/foreign quote ownership now
have exact-source/history and measured-work controls. The 224 shared list literals
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
renderer parity, complete allocation bounds, or physical latency.
Links (#301) are integrated from reviewed source `4f5fdeb89` and fixture-only
repair `ff442e23d` after current source gates, regenerated native consumers and a
fresh 51-scenario desktop/Android aggregate. Native execution remains attributed
to `4f5fdeb89` through unchanged runtime inputs; merged-head checks and CI complete
integration acceptance. Tables and renderer integration retain their own owners and
dependent tickets; note-id delivery during composition is specified in
[wikilinks.md](wikilinks.md).

Image/atom roles and claimed insertion (#307) and wikilink completion (#306) are specified in
[images.md](images.md) and [wikilinks.md](wikilinks.md); pickers, asset writing, image decoding,
menus and navigation chrome remain with renderers and existing infrastructure.

Shared find core (#312) matches visible text with rebased, stale-safe results; renderer
bars, highlight painting and table-cell boundaries remain with their owners.
→ docs/spec/editor/portable-core/find.md

Paragraph projections use a length-indexed tree and display Rope, so an ordinary
edit after a distant jump reparses only its paragraph window without rewriting
the note's tail offsets. Work counters include actual parser input for candidate
verification, paragraph partitioning and projection. Large soft-line
paragraphs, tight bullet and ordered lists, long raw HTML blocks and top-level fences are now
cut into sealed rows (→ docs/spec/editor/portable-core/long-regions.md); work in a loose list,
a quoted container, a single huge display line holding a `|` or an unmatched delimiter, or a contained fence still depends on that region;
progressive interpretation, complete allocation/work bounds and native device latency
measurements remain in their dependent tickets.
Progressive reinterpretation (#313) is deferred. On the full path, opening or closing a raw HTML block of kinds 1-5 above a 20,000-paragraph
tail reparses that tail in one synchronous step (689 KB parsed, 458 KB materialized,
1.56 M metadata visits; later keys stay local). Any accepted edit (paste, replay, Undo)
that leaves a top-level fence unclosed at its window end, moves a raw HTML block's end
condition, or lets a list continue past its window now reparses through to the true
end, so the projection equals a fresh open; the fence and HTML edits are region-sized.
Pasting over a closer's line ending above 20,000 paragraphs costs 687 KB parsed, 458 KB
materialized and 1.55 M metadata visits in one step (27 ms release on an M-series
Mac); its Undo costs the same (45 ms). At 1,000 paragraphs both cost 30 KB parsed.
Bounded synchronous slices and revision-aware continuation remain open for HTML,
fence openers, long lines and large tables. Top-level fences are now cut into rows
(long-regions.md), so a slice could install part of an unclosed fence's tail as
rows, but no full-path API yet guards pending stale rows past a frontier: input,
queries, find, staged commands and history would each have to finish or refuse there.

Early physical ARM32 reconnaissance confirms that large-region calls and returned
semantic payloads still scale with that region. The full materializing projection contract remains
available; bounded input/results and revision-aware progressive work remain
required on the same engine and Store. The renderer/host walkthrough challenges
input ordering, failure copying, coordinate mapping and worker scheduling before
renderer reliance. → docs/architecture/text-first-editor-host.md
