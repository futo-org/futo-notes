### Round five: the optimisation loop's gains, merged

The agent-control branch (`claude/agent-native-architecture-7bbe09`) ran its own optimisation
loop on the same 20 workflows and landed text anchors (`Select`/`Replace {"find"}`,
`Insert {"after"|"before"}`), a `notes` query (every note id and folder path the vault holds,
through a `vault()` on the shell provider), `wrote` receipts, tab verbs that take a `noteId`,
schema refusals that end with the accepted arguments, and a CLI guard against a batch reusing an
offset across an edit. Merged here (one merge commit; that worktree untouched). The `state.notes`
list this branch had added went, because `vault()` is the same fact with folders; `observe` now
spreads `vault()` in, so the driver sees `notes` and `folders` from the store, not the rows.

Jev needed three controller changes to sit on the merged verbs: the text anchors stay off its menu
(it has the offsets, which code pairs with `expect`) and the offsets it does see are not optional,
since `Select`/`Insert`/`Replace` now accept either form; the cycle key gained the tabs and the
vault, because three vault moves from the home screen looked like three visits to one state and
tripped the stall rule; and the tab verbs got rubric lines, since `CloseTab` (the active tab) and
`CloseTabAt {noteId}` were a coin toss without them. One pre-existing bug fell out too: the
controller's own argv filter dropped the goal when there was no `--resume`, so
`futo-puppet drive '<goal>'` had only ever worked through the harness.

| run                            | passed | calls | wall  | cost  |
| ------------------------------ | ------ | ----- | ----- | ----- |
| jev-workflows-4 (before)       | 14/20  | 99    | 98 s  | $0.04 |
| jev-workflows-merged-2 (after) | 18/20  | 80    | 84 s  | $0.04 |
| claude-workflows (agent alone) | 18/20  | 124   | 523 s | $1.68 |

The four new passes: `note-in-folder` (27 → 6 calls; the vault list names a note a collapsed
folder hid), `weekly-review`, `context-menu-move`, `background-tabs`. `merge-lists` (paste
without Enter) and `two-untitled` (one untitled note) remain, as before.
