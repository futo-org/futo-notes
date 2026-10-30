# Remaining work and performance limits

Rich HTML paste (#303) and rendered block movement (#311) are deferred by the maintainer's
2026-10-30 scope decision and do not block this milestone; their issues remain open for later
work. Plain-text/Markdown paste, including the supported table-cell/grid forms, remains
required. Tables, shared find, wikilink completion and the 20,000-line/native durability
acceptance targets have not been deferred. → docs/plan/text-first-editor-rebuild-tickets.md

Complete list/container commands and fence/table/link interpretation,
note-id-dependent composition arbitration and renderer integration follow in their dependent tickets.

Paragraph projections use a length-indexed tree and display Rope, so an ordinary
edit after a distant jump reparses only its paragraph window without rewriting
the note's tail offsets. Work counters include actual parser input for candidate
verification, paragraph partitioning and projection. Work in a single large
paragraph, list or fence still depends on that region; progressive interpretation,
complete allocation/work bounds and native device latency measurements remain
in their dependent tickets.
