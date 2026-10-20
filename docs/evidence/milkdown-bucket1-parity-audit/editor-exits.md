## Editor exits _(iOS/Android)_

Every line in this section is shell code (EditorSession.kt / EditorSession.swift) reached through
the same bridge either engine serves: the exits' capture is the `getContent` round trip, and
change fencing rides the same change messages. The section's wording says "the latest live CM6
body" — under Milkdown the capture is the same bridge call against the WYSIWYG engine; the
bucket‑2 spec MR should reword "CM6" to "editor". Ordering, latches, drains, refusals, and both
recorded divergence Gaps (#79 iOS parked‑conflict on navigation, #80 Android dropped quarantine)
are exactly as recorded — PASS via `[shell]` ordering suites, gaps stand.

| Spec line group | Verdict | Evidence |
|---|---|---|
| Latches before first suspension; destructive cancels before drain; exact‑snapshot commit; refusal semantics; one‑way delete latch; single admitted exit; effect/workflow non‑interleave; change fencing; external‑delete close; detached exits (legacy notice) | PASS | `[shell]` EditorSessionTest.kt / EditorSessionTests.swift, NativeMutationOutcome*; bridge contract `[milkdown]` |
| Three permitted divergences (commit order, capture source, move‑picker timing) | PASS | As specified, unchanged |
| Gap #79 (iOS parked‑conflict on navigation) / Gap #80 (Android drops the post‑latch change) | GAP | Stand; shell behavior, not Milkdown's |
