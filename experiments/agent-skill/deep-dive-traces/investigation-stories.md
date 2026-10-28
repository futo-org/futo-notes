## 2. Investigation stories, checked against today's records

**S1. "Why did Jev loop?"** This is `.agent/drive/2026-09-21T19-28-03-437Z.json`: 77 turns,
817k tokens, 57 s, `needs-agent` "stalled on ReplaceLine". Turns 4–12 repeat
`InsertLine{afterLine:1}` and `Undo`. To answer it you need, for each turn, the exact request:
the state, the questions with their option text, Jev's answers, the override logic
(`actionsDone < 0.5` promotes the runner-up), the move and the receipt.
**Partly answerable.** The answers show `afterLine` got probability over option keys, but the
criteria text that says what each key meant is gone. `buildTurn` has changed since then, so
the request cannot be rebuilt. The override is not recorded at all: you cannot tell whether
turn 6 was Jev's own pick or the promoted runner-up.

**S2. "What did the page do between receipt 12 and 13?"** Timers, a late load, autosave,
something a person did. You need the events with ids and times in the gap, and the snapshot
diff across it. **Fails.** A `do` line records how many events it caused (`events: 0`), not
which. The events stay in the 1,000-entry ring and die on reload. `changedSinceLast` only fires
when no event at all came in between (`agentTrace.ts:511`): one `selectionchange` hides it.
`await_pending` drops it on 202 receipts (`main.rs:691-698`).

**S3. "Did the app re-render late after OpenSettings?"** Recorded at 18:45:52.795
`OpenSettings` → `no change`. At 18:45:52.962, `ToggleLanguageOptions` carries
`changedSinceLast {action:1, added "Reset to default"}`. **Half answerable.** You know it was
late, but not by how much. Snapshot `t` is not in the receipt, and the only bound is the CLI
`at` of the next call, 167 ms later. If the next call had come after an event, the lateness
would be invisible.

**S4. "Which handler ran on this click?"** Gesture lines carry the `trace` events with
`handlers[]`. **Answerable for the 24 gestures, but not joinable.** A Jev `Press` is a
`futo-agent click` child whose line has no run or turn, so a gesture cannot be tied to the
turn that caused it. A console error thrown inside that handler is recorded nowhere next to
it.

**S5. "Reproduce this session's steps on iOS."** You need the ordered verbs with args, the
actor, the platform, and the start state, with harness resets filtered out. **Fails.** `do`
lines have no args. With no session, 16.5k harness `CloseTab`s are mixed in. For drive runs,
`calls[]` has args for Jev's steps only, and the agent's own steps between handoffs are
missing.

**S6. "The bridge stopped answering at 14:05. What was in flight, and what did the app log?"**
**Fails.** The in-flight call is never written, because lines are appended after the reply.
The drive run left no file. The journal has no pid. Console entries lived in the page, and
Rust stderr went to someone's terminal.

**S7. "Join a Claude tool call to the full receipt it got."** 71% of `do` output was cut by
`tail`/`head` in the transcript, so the full receipt is only in the trace. **Only by time**,
and ambiguous whenever sessions overlap, which they do right now.

Score: 0 of 7 fully answerable, 3 partly.

---
