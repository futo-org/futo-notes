# Consuming shared editor merges

The shared Rust change is independently consumable by desktop and native hosts; it has no Android
renderer dependency. `futo-notes-merge` owns the existing conservative line-based `diffy` merge and
its examples/properties. `futo_notes_core::merge` preserves its existing exports. Independent changes
inside one paragraph remain separate work (#323).

`LocalNoteStore::flush_draft_merged(id, base, draft)` returns `MergedDraftResult { source, flush }`.
The workflow reads disk, merges and commits under the existing store gate and process-wide vault
mutation guard. `source` is the exact saved version, including outside contributions, or the exact
parked draft. `flush` carries the existing disposition and complete post-commit mutation. Matching
disk converges without an mtime bump. Ambiguous overlap, missing-note recreation, conflict names,
collision handling and retry behavior retain their existing rules. UniFFI exposes the same additive
record/method to Swift and Kotlin. No sync payload, AppState, bridge version or acknowledgement
schema changes.

Consumers opt in only when they can adopt authoritative source with local history and selection
intact. Apply the complete mutation and use the returned source as the saved baseline. Legacy
`flush_draft` keeps its existing behavior, so an older renderer cannot unknowingly save merged disk
bytes while retaining a different draft baseline.

`StoreEditorSession` automatically adopts clean merges. Drain `take_coordinated_changes()` after
checkpoint/save-if-due, on errors as well as success: outside divergence may settle composition
before persistence fails. Ordinary autosaves keep provisional composition intact. The session
prepares source/history adoption before committing; prepared plans are bound to the editor
incarnation, source revision, selection and affinity. A foreign or stale plan cannot replace another
session's source/history. Write failure does not apply the prepared remote adoption. Both Undo and
Redo preserve outside contributions. Ambiguous historical overlap,
transient syntax correspondence or bounded preflight failure parks the complete draft while
retaining its history; ADR-0012 states the exact bounds.

The portable page owns its selection, history and composition. Automatic `StoreEditorHost` saves
therefore retain legacy parking. An explicitly merge-aware host first settles marked text on the
page, captures its exact draft and revision, then uses the opt-in flush and calls
`PortableSession::adopt_merged_source(expected, source)` / WASM `adopt_merged_source`. Send the
returned normal Append request in sequence, like any other edit. A stale revision or active
composition refuses adoption without changing the draft/history; retain the current draft and
reconcile again. Never replace the page from a fresh snapshot as a substitute for rebasing history.
The compiled WASM/store consumer exercises this explicit path through save, adoption, Undo, Redo
and reopen bytes.

Native device input/rendering remains a shell verification responsibility. Shared contract tests
prove exact source, selection, composition state, mutation, failure/retry and Undo preservation;
they do not prove a keyboard's visual marked-text behavior.
