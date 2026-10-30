# Shared Rust editor core: implementation tickets

Approved and published 2026-10-29 under [the engine/store spec](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/283).
All 34 tickets are native Task children of #283. Active tickets carry `ready-for-agent`;
execution must still respect their blockers and the explicit deferrals below. Conversion retained
their issue numbers and content. The initial
frontier is [Edit, save and recover a plain note](https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/284).

The GitLab license rejects native blocking links. Each issue therefore records its blockers
explicitly in its description, following the configured tracker fallback. The original 53 dependency
edges, all issue bodies/labels and the absence of cycles were verified after publication.
The parent specification, labels and state were left unchanged. Its hierarchy was verified
to contain exactly the 34 Task children linked below. Child hierarchy is available independently
of the licensed blocking-link feature.

## Approved deferrals — 2026-10-30

The maintainer deferred **rich HTML paste (#303)** and **rendered block movement (#311)**
from the current #283 milestone. Both issues stay open as future work and must not be selected
by agents or treated as completed. These two deferrals override the corresponding original
parent stories; shipping editor behavior and defaults stay unchanged.

Plain-text/Markdown copy, cut and paste (#302) remain required. Table-cell and grid paste
(#310) remain required for the supported plain-text/Markdown forms; rich HTML conversion is
deferred with #303. Consequently #310 depends on #302 and #309, and #315 no longer waits for
#311. Final consumer acceptance and renderer handoff cover the active scope and list both
deferrals explicitly. Tables, shared find, wikilink completion, the 20,000-line performance
targets and durability targets have **not** been deferred.

This phase produces the shared Rust editor engine, coordinated store recovery, thin
Swift/Kotlin/WebAssembly consumers and the portable host contract. After core acceptance,
a coworker takes desktop while the maintainer builds Android/iPhone. Full platform renderers
and the large Bootcamp campaigns are later work. Each feature ticket includes its own tests.

- [Foundations and structural input](text-first-editor-rebuild-tickets/foundations.md) — plan orders 1–13.
- [Markdown features and commands](text-first-editor-rebuild-tickets/markdown-and-commands.md) — plan orders 14–31.
- [Consumer acceptance and renderer handoff](text-first-editor-rebuild-tickets/acceptance-and-handoff.md) — plan orders 32–34.

Work from the current integration-branch tip. After each completed blocker, query the newly
unblocked tickets; table order alone is not a required serial schedule. Shared engine edits
still need coordinated integration, and binding/CI updates travel with the owning feature.
