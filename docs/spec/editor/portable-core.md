# Portable text-first core

Table alignment changes, row reordering, column reordering and multi-cell/grid paste are
also deferred by the maintainer. Preserve existing alignment and exact untouched bytes.
Basic row/column insertion and deletion, cell editing/navigation and ordinary single-cell
paste remain required; shared find and 20,000-line performance remain required.

This core is under development for #283. Shipping apps continue using the shared
Milkdown editor until a separate renderer integration and cutover.

The maintainer's 2026-10-30 scope decision defers rich HTML paste (#303) and rendered
block movement (#311) from this milestone; both remain open future work, not accepted
capabilities. Plain-text/Markdown clipboard support and ordinary single-cell table paste remain
required. Tables, shared find, wikilink completion, 20,000-line performance
targets remain in scope. The dependency plan records these deferrals so agents do not
reintroduce them or wait for them at final acceptance. → docs/plan/text-first-editor-rebuild-tickets.md

- [Linedown: the dialect the engine reads and writes](portable-core/linedown.md)
- [Exact source, interpretation and input](portable-core/interpretation-and-input.md)
- [Inline formatting](portable-core/inline-formatting.md)
- [Heading, quote and divider block commands](portable-core/block-commands.md)
- [Find in note](portable-core/find.md)
- [Link editing and source ownership](portable-core/links.md)
- [Wikilink roles and note ids](portable-core/wikilinks.md)
- [Plain Markdown copy, cut and paste](portable-core/clipboard.md)
- [Images and non-text atoms](portable-core/images.md)
- [List interpretation and editing](portable-core/lists.md)
- [Typed list shortcuts](portable-core/list-shortcuts.md)
- [Fenced code and key intent](portable-core/fenced-code.md)
- [Front matter, raw HTML and unfamiliar Markdown](portable-core/foreign-content.md)
- [Saving and outside writers](portable-core/recovery.md)
- [Portable and native transports](portable-core/transports.md)
- [Remaining work and performance limits](portable-core/remaining-work.md)
