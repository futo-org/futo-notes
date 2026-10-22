## The short version

We set out to make agents drive the debug apps quickly and correctly. What we learned:

1. **Make each call fast, and make fewer of them.** We cut the tool's own latency several-fold:
   a click from 727 to 230 ms, `state` from 305 to 45 ms, an iOS screen read from 250 to 20–35 ms.
   That made driving about twice as fast. A session is still mostly model time, so cutting the
   calls an agent needs saved the most: the tool-eval went from 140 calls in 670 s to 60 calls in
   329 s.
2. **The tool must never answer confidently when it is wrong.** Every misleading "no change" or
   false success we chased turned out to be a tool bug. Calls now refuse with the cause, wait until
   their work has landed, and print the call that would work. Row refusals fell from 0.75 to 0.14
   a goal.
3. **Put what agents need in the output, not in docs.**
   - No agent opened the reference files (0 of 84 sessions).
   - 92% of action receipts were filtered, often before the agent had seen a single one.
   - Text receipts and a hook that blocks filtering brought that down to 2–5%. Telling agents to
     read the receipts had not.
4. **Agents reproduce a bug when the request asks them to.** On the same seven bugs, agents told
   "reproduce it in the running app first" reproduced 13 of 14 times; without the line, 2 of 14.
   Suggestions in the docs did not change behaviour: told it could hand driving to Jev, Claude
   almost never did.
5. **Act like a person.** A verb is one user action, and only what is on screen can be touched.
   Shortcuts exist but are marked, because the point is to hit the bugs users hit.
6. **Benchmark real sessions on goals you never tuned on.** Pass rates saturate at once, so count
   calls, errors and cost. Running the held-out and editor sets surfaced more than a dozen bugs in
   the app and the tool, and several of our own answer keys were wrong.
7. **Small-model drivers are shelved, not settled.** We tried three: Granite 8B locally,
   TypeSafe's Jev, and Laya, with very different results (§7). Jev drove the workflows fastest
   (19/20 in 84 s for $0.04), but it could not compose text and never had a fair held-out test.
   We set them aside on 09-28 to make the tool itself work well for Claude, and kept the code to
   come back to.

Still open: a record that explains *why* the app did what it did (§3).

## Timeline

| Date | What happened |
|---|---|
| 09-11 | Research: Shopify's fast path is a debug listener inside the real app |
| 09-14 | A local Granite 8B driver; the first CLI |
| 09-16 | Rust CLI; desktop and iOS listeners; first A/B against `main` |
| 09-17 | Every UI handler a verb, with a gate; Android listener; five-bug pilot (0/5 reproduced first) |
| 09-18 | App pre-launched for benchmarks; the `bugfix` skill deleted; desktop real click and drag |
| 09-21 | Tool-eval, workflows and hard-tier benchmarks; Jev shoot-off begins |
| 09-22 | Optimisation loop; composite verbs rejected; `Type`/`Press`; Laya ruled out |
| 09-23–24 | Convenience verbs; Jev hand-off; a Jev gate in the CLI; diagnosis harness |
| 09-25 | Held-out set (497 notes) |
| 09-28 | Benchmarks run as real sessions; "proper app navigation" rule; Jev shelved |
| 09-29–30 | Phones' native screens readable; whole-app receipts; per-control verb gate |
| 10-01 | Held-out baseline 79/80; text receipts and the hook; refusals print the fix |
| 10-02–05 | Milkdown port: ProseMirror positions, desktop real keys, confirmations with `answer` |
| 10-05–06 | Held-out 80/80 after the port; editor set; eight bugs fixed; reproduce-first diagnosis; `screenshot` |
| 10-07 | Rebased onto main (held-out 80/80); renamed to `puppet` |
