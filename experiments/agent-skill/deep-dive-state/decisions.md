## 0. Decisions

1. **One `AppState` (v1) on every platform.** It is the full, canonical state. Each platform's
   `state` returns it. It is identified by a content hash (`@<8 hex>`) and stored in
   `.agent/state/<id>.json`. Turns and traces refer to the id and do not resend the state.
2. **One diff model: the CLI diffs `AppState` before and after, for every verb on every platform.**
   The page's element diff is demoted to the trace and to `diff {"action"}`. Native verbs get
   receipts through this diff without any new Swift or Kotlin diff code.
3. **Claude gets text, not JSON.** The result is a "where you are" header plus only the changed
   paths, the changed lines as they now read, and the verbs and overlays that appeared or went
   away. The median is about 104 B, against 571 B today (1,179 B for editor verbs), and p90 is
   144 B against 2,090 B.
4. **Jev gets the lean AppState, and the question set is pruned.** Measured on 317 turns: the
   median drops from **9.8k to 5.2k tokens** (p90 13.4k → 6.7k) and desktop drops from 12.2k to
   6.2k. The pruning loses none of the recorded moves: 323 argument answers were checked. A
   two-stage variant reaches 2.8k tokens, at the price of a second TypeSafe call on 65% of turns.

---
