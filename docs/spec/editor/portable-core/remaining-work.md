# Remaining work and performance limits

The shared engine implements the current [Linedown contract](linedown.md). Renderer
integration and cutover are separate from that implementation; the
[client adoption guide](../../../architecture/editor-engine-adoption.md) records each
client's current status, projection changes and required binding rebuilds.

## Deferred capabilities

- Rich HTML paste (#303) and rendered block movement (#311) remain deferred by the maintainer's 2026-10-30 decision. Plain Markdown clipboard support and ordinary single-cell table paste are implemented. → docs/spec/editor/portable-core/clipboard.md
- Table alignment changes, row/column reordering and multi-cell/grid paste remain deferred. Basic row/column insertion and deletion, cell editing/navigation and single-cell paste are implemented; existing alignment and untouched bytes are preserved. Linedown recognizes tables only at the top level; container-table recognition and HTML `<br>` interpretation are not part of its current dialect. → docs/spec/editor/portable-core/tables.md, docs/spec/editor/portable-core/linedown.md
- Progressive background reinterpretation (#313) remains deferred. The current synchronous reader continues through changed lines until its carry settles; it does not expose a frontier of stale rows for renderers to consume. → crates/futo-notes-editor/src/engine/read.rs, docs/spec/editor/portable-core/long-regions.md
- Engine cleanup is tracked under `linedown-followups`: explicit front-matter closure input (#427), removal of old shims/dead-code exemptions with an export audit (#428), and comments/production-size reporting (#429). Separate tag defects are #425 and #426. These are not stored-note migration tasks. → docs/architecture/editor-engine-adoption.md

## Renderer responsibilities

- Pickers, asset writing, image decoding, menus and navigation remain renderer/infrastructure responsibilities. The engine supplies image and wikilink semantics, not their UI. → docs/spec/editor/portable-core/images.md, docs/spec/editor/portable-core/wikilinks.md
- Shared find scans and stale-safe results are implemented; renderer bars, highlight painting and reveal behavior still require each host's integration and acceptance. → docs/spec/editor/portable-core/find.md
- Text-first native toolbars show Indent and Outdent and disable them from `can_indent`/`can_outdent`. The iOS adapter already keeps those controls visible. The shared Milkdown manifest still uses `when: 'inContainer'`; its existing-renderer behavior is not evidence that another text-first renderer has completed this integration. → apps/ios/Sources/Editor/TextFirst/TextFirstEditorController+Toolbar.swift, packages/editor/src/toolbar.ts, docs/spec/editor/portable-core/list-indent.md
- Real keyboard/IME behavior, accessibility, physical-device latency and renderer usability require host-specific acceptance. Transport tests, work counters and simulator timing do not establish physical-device latency. Physical iPhone measurement remains a follow-up to #316. → docs/architecture/text-first-editor-host.md

## Current work bounds

- The line store uses a length index; editing ordinary text re-reads its touched lines and the carry-settling boundary rather than shifting every later offset. The deterministic tests compare 1,000 and 20,000-line notes. → crates/futo-notes-editor/src/engine/store.rs, crates/futo-notes-editor/src/engine/read.rs, docs/spec/editor/portable-core/long-regions.md
- A text edit that leaves list indentation unchanged settles locally. Indent/Outdent re-read the moved subtree and settling boundary; ordered-number adjustment can also visit following in-sequence items. → crates/futo-notes-editor/src/engine/tests/lists.rs, docs/spec/editor/portable-core/list-indent.md
- A single long line is still one reading unit. Opening a fence with no later closer can re-read the tail; table inspection and row/column commands can read the table. Renderers must not assume every operation has constant cost. → docs/spec/editor/portable-core/long-regions.md
- Every accepted edit leaves reading and display equal to a fresh open. Locality and fresh-open equivalence are engine guarantees; complete allocation bounds and device latency are separate measurements. → crates/futo-notes-editor/src/engine/tests/properties/checks.rs, crates/futo-notes-editor/src/engine/tests/external/property.rs
