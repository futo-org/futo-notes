# Remaining work and performance limits

Rename/delete lifecycle coordination, block/link interpretation,
note-id-dependent composition arbitration and renderer integration follow in their dependent tickets.

Paragraph projections use a length-indexed tree and display Rope, so an ordinary
edit after a distant jump reparses only its paragraph window without rewriting
the note's tail offsets. Work counters include actual parser input for candidate
verification, paragraph partitioning and projection. Work in a single large
paragraph or fence is still proportional to that region; progressive interpretation,
complete allocation/work bounds and native device latency measurements remain
in their dependent tickets.
