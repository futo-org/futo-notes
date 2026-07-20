# Shells are projections — the engine owns save semantics, ordering, and identity

The three shells (desktop TS, iOS Swift, Android Kotlin) each re-implemented note-list
ordering, final-id resolution, and the draft-flush workflow on top of the Rust local note
engine, and they drifted: Android silently dropped drafts on the outcomes it didn't handle,
desktop saved unconditionally, and only iOS honored the persist-or-park promise — after ~10
rounds of hand-fixes. We decided the engine owns all of it: mutations carry each note's final
id and sorted position (shells apply splices verbatim and hold no rules), and a single
`flush_draft` verb resolves every save surprise itself, returning one of four flush
dispositions (wrote / converged / recreated / parked). Shells own only *when* to save
(debounce, lifecycle, jetsam register); the engine owns *what happens* on save.

## Consequences

- The raw save primitives (conditional write, create-if-absent, park) are **deliberately
  private** to the engine. Do not re-expose them over the FFI or desktop commands — their
  absence is what makes it impossible to re-stitch a per-platform save workflow and restart
  the drift.
- Shell note caches are pure projections. Do not add sort, identity, or collision logic to a
  shell; if a shell "needs" a rule, the mutation record is the place to carry the engine's
  answer.
- The rejected alternative — keeping per-shell copies locked by shared conformance fixtures —
  prevents silent drift but keeps N copies forever; it remains the fallback only for genuinely
  per-keystroke hot-path rules (see AGENTS.md §4.2), which this decision does not change.

Origin: architecture review + grilling, 2026-07-20. Spec: GitLab issue #34; vocabulary in
CONTEXT.md (mutation, projection, flush disposition, park, persist-or-park promise).
