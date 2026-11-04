# A local rename is a journaled transaction

Decided 2026-11-03 (#214, #318 decision 3A). Every store move (title rename, note move, folder
rename or move, delete-folder's move-up) is recorded in a durable journal so sync can keep the
renamed note's server identity. Without it the app saw only "file gone, file new" and uploaded a
delete plus a create.

#318 forbade new application-state schemas; the journal is the one authorized exception.

- **State.** `<vault>/.local-renames.json` (versioned, atomically replaced, directory-fsynced) and
  `<vault>/.local-renames/<tx>/`, a staging directory owned by one transaction. Both are dot-prefixed,
  so the vault walk and the sync scan skip them.
- **Move.** `from` goes to `.local-renames/<tx>/<n>`, then to `to`, under the vault mutation guard.
  Whatever is in a staging directory is that transaction's source, so recovery needs no hard links,
  inode numbers or content comparison, and case- or normalization-only renames are not special.
  Phases: `Prepared` (before any source moves), `Staged` (every source staged), `Committed`.
- **Recovery** runs at store bootstrap. `Prepared` returns staged files to their sources; `Staged`
  finishes the move and replays the backlink rewrite. A newcomer at either name is never overwritten:
  ours takes a fresh name beside it.
- **Sync** claims committed intents inside push, binds the source's server object id in the journal,
  moves that one checkpoint entry to the destination and PUTs the original object there. It
  acknowledges (drops) the intent only after the PUT landed and the checkpoint holding the result
  saved. Intents are scoped to the checkpoint's collection and are kept only while a live checkpoint
  exists. Sync payloads, `BRIDGE_VERSION`, crypto/path guards and push-first ordering are unchanged.
- **Compatibility.** An older binary ignores the journal: downgrading with a pending intent loses
  that one rename's identity (unsupported), and an interrupted move stays parked until a current
  binary recovers it. A journal version this binary does not know is never rewritten or discarded;
  renames and sync stop with an error and the file is left as evidence.

Sync reaches the journal through `futo_notes_core::files::rename_journal` (`with_rename_journal`,
`set_rename_scope`), which takes the vault mutation guard but not a `LocalNoteStore` gate; it is the
one writer outside the gate and owns no note content.

Implementation: `crates/futo-notes-core/src/files/rename_journal/` (record and sync view), `crates/futo-notes-store/src/rename_journal/` (moves, recovery), `crates/futo-notes-sync/src/sync/push/local_renames.rs`.
Behavior: `docs/spec/sync/conflict-and-data-safety/edits-deletes-and-renames.md`.
