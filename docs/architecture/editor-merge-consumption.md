# Consuming shared editor merges

The shared Rust change is independently consumable by desktop and native hosts; it has no Android
renderer dependency. `futo-notes-merge` owns the conservative `diffy` merge and its examples/properties.
It first merges lines, then retries conflicts using lossless Unicode word-boundary tokens as diffy
lines. Independent words in one paragraph can combine; competing spellings of one word,
same-position insertion ambiguity and delete/edit overlap still preserve both versions. Boundary
ambiguity may conservatively park otherwise independent edits. No source normalization occurs.
`futo_notes_core::merge` preserves its existing exports. #323 stacks on #322; consumers need both.
This is a shared merge-rule change, also consumed by sync through the unchanged core facade;
no shell opt-in API changes are needed beyond #322's adoption contract.

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
Redo preserve outside contributions. A history step on lines the outside change left whole moves by
position, since a line break is a hard boundary; only a step that shares a line with it is merged.
Ambiguous historical overlap,
transient syntax correspondence or bounded preflight failure parks the complete draft while
retaining its history; ADR-0012 states the exact bounds.

The portable page owns its selection, history and composition, so the worker cannot adopt for it.
`StoreEditorHost::checkpoint()` and `save_if_due()` merge like a native save and return
`PortableSave { flush, offered }`: `offered` is the source the note holds when it is not the draft at
the revision saved (an outside change merged in, or a clean draft's outside source, which is never
written). The saved baseline stays the draft that was saved or merged; a draft typed past an
unadopted offer therefore merges again on its next save instead of overwriting the outside change.
The page adopts the offer at that revision with `PortableSession::adopt_merged_source(expected,
source)` / WASM `adopt_merged_source` and sends the returned normal Append request in sequence, like
any other edit; when it replays, the offer becomes the baseline. A page that typed past the offer
ignores it: the next save offers again. A stale revision or active composition refuses adoption
without changing the draft/history; reconcile again later. A page refused for front matter, history
bounds or ambiguity re-opens the note: the file already holds both sides. Never pair
`flush_draft_merged` with an attached host: that leaves the host's saved baseline stale. The compiled
WASM/store consumer exercises this path through save, adoption, Undo, Redo and reopen bytes.

Native device input/rendering remains a shell verification responsibility. Shared contract tests
prove exact source, selection, composition state, mutation, failure/retry and Undo preservation;
they do not prove a keyboard's visual marked-text behavior.

## Following external rename intent (#324)

Prerequisite: the shared #322 merge/adoption contract above. This addition is usable independently
of Android rendering, through existing store and UniFFI contracts; it adds no wire fields.

After sync commits files, deliver its explicit rename pairs (including collision-resolved final
ids) to `LocalNoteStore::refresh_external_changes` / `NoteStore.refresh_external_changes`. Under
the store gate and vault guard the engine reserves destination attachments before changing any
identity. A missing/unreadable destination or another editor's destination lease refuses the refresh
without moving the drafts; retain the event for retry. Apply the complete returned mutation. Updated
and deleted id lists alone never imply identity; do not derive a rename from similar filenames.

An attached draft follows the reported final id without replacing its source, revision, selection,
composition or history. Its saved baseline remains the pre-rename source: the next checkpoint merges
against current disk bytes at the final id, or parks the full draft when ambiguous. Use the session's
current id and the checkpoint mutation's final id after every save, including conflict parking. A
replayed completion for an already-vacated attachment does not retarget its parked/new identity.
Failed persistence keeps the final attachment and unsaved draft for retry; no old-id save is needed.

The portable/WASM page retains its outstanding requests and history through retargeting. Send pending
Append requests in their existing token/sequence order; the worker resolves persistence against its
current attachment id. Portable saves merge and offer as described above; overlapping edits park,
preserving both versions. Native attached sessions
adopt safe merges automatically and expose coordinated view changes through the existing contract.
