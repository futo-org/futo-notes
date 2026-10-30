# Portable text-first core

This core is under development for #283. Shipping apps continue using the shared
Milkdown editor until a separate renderer integration and cutover.

The maintainer's 2026-10-30 scope decision defers rich HTML paste (#303) and rendered
block movement (#311) from this milestone; both remain open future work, not accepted
capabilities. Plain-text/Markdown clipboard support and table paste in those forms remain
required. Tables, shared find, wikilink completion, 20,000-line performance and durability
targets remain in scope. The dependency plan records these deferrals so agents do not
reintroduce them or wait for them at final acceptance. → docs/plan/text-first-editor-rebuild-tickets.md

- [Exact source, interpretation and input](portable-core/interpretation-and-input.md)
- [Fenced code and key intent](portable-core/fenced-code.md)
- [Persistence, recovery and outside writers](portable-core/recovery.md)
- [Portable and native transports](portable-core/transports.md)
- [Remaining work and performance limits](portable-core/remaining-work.md)
