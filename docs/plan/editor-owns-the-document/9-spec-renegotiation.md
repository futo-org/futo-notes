## 9. Spec renegotiation (`docs/spec/editor.md`)

Behaviour that changes, and the lines that state it today (line numbers as of this plan):

- "Saving & rename" `:2046`: keep the 200 ms line; add that every report names its note and
  generation, that an unreported edit is announced synchronously, and that a note switch
  reports the outgoing note's pending edit before loading the next.
- The Gap at `:2065-2070` (select-all-delete dropped when flushed inside the window): a
  switch or exit now flushes first, so the window is only a process kill. Narrow the Gap's
  text to that; do not delete it.
- "Editor exits" `:2298` (commit the exact captured snapshot) → "the newest tagged `change`
  the shell holds, after asking the editor to flush when it is behind".
- `:2324-2335` (no live document → the shell's copy) → the renderer-death rule in §5.2.
- `:2336-2347` (deadline plus liveness probe) → delete; replace with the two-row table.
- `:2348-2356` (streaming withholds `change`) → streaming withholds `change` but announces
  `edited`; a flush settles the tail.
- `:2370-2374` (change fencing) → fencing is by note id; the pre-load fence stays
  (`documentLoaded` is the gate instead of "the initial off-main read").
- Permitted divergence "Where the committed body comes from" → delete; both shells commit
  `latest`. The Gap under it (iOS delete refuses for 6 s; Android never asks) → closed.
- The Gap at `:1969-1993` (exit during a >6 s slice drops streamed-time text, #245) → closed:
  the shell is behind and either waits or refuses; it never commits a stale copy as current.
- Gaps #79 (iOS ignores a parked disposition on navigation) and #80 (Android drops a change
  after the destructive latch) are untouched — note that the mailbox makes #80 easy later
  (the quarantine is the mailbox entry) but do not close it here.
- `docs/spec/sync.md` open-note dispositions: "both native shells settle a deferred open-note
  adoption on a blur edge" still holds; the pre-classify read line, if any, changes to
  `awaitCurrent`.

Close #194, #244, #245 from the MR with the test that pins each.
