# AGENTS.md — futo-notes-store

**The** local note engine: one durable owner for a Markdown vault and its derived search index.
Every shell — Tauri desktop, native iOS, native Android — reaches note CRUD through this crate
(desktop directly, mobile through `futo-notes-ffi`). Nothing else may read or write the vault.

Layering: `futo-notes-model` decides note rules (no filesystem), `futo-notes-core` provides the
primitives (path safety, atomic writes, conflict names, the vault mutation guard),
`futo-notes-search` is the index engine. This crate is where those meet a real directory.

## Modules

- **`lib.rs`**: `LocalNoteStore`, the public result types, sort order, search access, `reset`,
  and the vault-migration entry points. The rest of the public workflow surface is split by job,
  each an `impl LocalNoteStore` block: `bootstrap.rs` (`bootstrap`, `startup_listing`, `.txt`
  migration), `notes.rs` (`snapshot`, `read`, `create`, `append`, `write`, `rename`, `move_note`, `delete`,
  external-change projection), `flush.rs` (`save`, `flush_draft`), `folders.rs` (the folder
  workflows), `relink.rs` (journaled file moves and backlink rewrites), and `commit.rs`
  (no-replace installs and the post-commit `MutationResult`).
- **`rename_journal/`**: every note/folder move goes `from` -> `.local-renames/<tx>/` -> `to`
  under the durable rename journal (`.local-renames.json`, #214). `moves.rs` runs and rolls back
  a move, `recovery.rs` finishes or undoes one at bootstrap. The record and the view sync reads
  live in `futo-notes-core` `files/rename_journal/`; sync touches it only through that view,
  under the vault guard (not this crate's gate). Unknown journal versions fail closed and are
  left untouched; downgrading with a pending intent loses that rename's identity.
- **`vault.rs`**: the corpus walk, snapshot building, and `note_list_order` — **the** note-list sort
  rule (modified desc, id asc). The walk visits folders and each folder's notes in parallel and
  closes a folder before opening its subfolders, so descriptors stay bounded (iOS defaults to 256;
  `tests/fd_limit.rs`).
- **`list_cache.rs`**: each note's derived preview, rich preview and tags, persisted at
  `<index_dir>.list-cache` (outside the vault) so a relaunch reads no unchanged note. An entry is
  trusted only on an exact stat fingerprint older than a 2 s racy margin; the file records the
  vault root and a checksum of the derivation rules. Every open still stats every note.
- **`paths.rs`**: collision resolution (`unique_note_id`, `unique_folder_path`).
- **`editor_session/`**: store-owned editor attachment, input and debounced markdown saves (500 ms idle, 2 s max wait; no recovery log);
  `save.rs` owns the injected-clock schedule, `checkpoint.rs` the save decision (write, converge,
  recreate or park), `identity.rs` an attached note's rename/relink, `lease.rs` the one-attachment-
  per-note registry, `quick_open.rs` a long note's read-only first screens before it attaches.
- **`editor_draft.rs`**: baseline-aware identity changes. A stale editor parks its draft at the
  requested destination instead of overwriting the peer, and does not redirect links away from it.
- **`vault_migration.rs`**: staged, verified moves of a whole vault to a new root; `vault_migration/`
  holds the manifest copy and the directory-fsync durability steps.
- **`search.rs`**: the per-vault search-engine lifecycle (start, retry, restart). The only place
  that constructs a `SearchEngine`.

## Rules that are easy to break here

- **Every mutation goes through the gate, under one vault guard.** `LocalNoteStore` serializes
  writes through its `gate` mutex and takes `vault_mutation_guard()`, so a conditional write or a
  multi-file rename-and-relink has one decision boundary. A caller that reads, decides, then calls
  back in has created a check-then-act race (AGENTS.md §4, item 6 — one such race resurrected a
  deleted note). If two calls must happen in order, add one workflow here instead.
- **One exception to the gate: the rename journal.** `futo_notes_core::files::rename_journal::with_rename_journal` and
  `set_rename_scope` are called by sync under the vault mutation guard only, to bind, claim and
  acknowledge intents. They touch only the journal file, never note content. Do not add another
  writer outside the gate; extend the journal's surface instead.
- **`MutationResult` is the complete post-commit projection.** It carries `upserted` (each with its
  position in the sort order), `removed`, `renamed`, `folders`, the collision-resolved `final_id` /
  `final_folder`, and `warnings`. Shells apply it verbatim. Never leave a shell to reconstruct a
  collision outcome, a backlink rewrite, or a list position — ADR-0001 forbids a shell-side
  comparator or final-id heuristic.
- **Sort order lives only in `vault.rs`.** Shells splice the engine-reported positions.
- **The raw save primitives stay private and `flush_draft` (with its merging sibling
  `flush_draft_merged`) is the save verb**, returning a
  `FlushDisposition` the shells render rather than decide. Read
  `docs/adr/0001-shells-are-projections.md` before touching that surface — it owns the reasoning,
  and its consequences section says what re-exposing a primitive would undo.
- **Never hand-build a path.** Use `safe_note_path` / `ensure_safe_note_id` from `futo-notes-core`.
- **This crate must run on Windows too.** Plain `std::fs` is used freely here and that is fine; what
  must go through `futo-notes-core`'s `vault_fs` is anything **platform-divergent** — no-replace
  create, atomic move, missing-parent semantics. Its `contract_tests.rs` compiles the Windows
  fallback everywhere and stamps one rule set over both implementations, because a `cfg`-gated
  branch whose tests are gated to the other platform ships untested (AGENTS.md M26). That cost
  github#48: `exists` answered a missing parent with an I/O error instead of `Ok(false)`, so from
  v1.6.1 every note a peer put in a folder the Windows client lacked failed on every sync cycle.

## Performance

`just bench-vault` (`benches/vault_open.rs`) measures what every shell waits on at launch:
`bootstrap_with_search` over a synthetic 10k-note vault, plus a cold `bootstrap`, `startup_listing`
and a flat vault. Method and numbers: `docs/perf/vault-open-hill-climb.md`.

## Testing

Tests are inline: `src/tests.rs` (`#[cfg(test)] mod tests`, shared helpers) with one module per
behavior in `src/tests/`, and fixtures in `src/test_support.rs`.
`LocalNoteStore` carries two `#[cfg(test)]` fault-injection hooks — one firing between id allocation
and installation, one inside a flush's check/write span — so concurrent-writer races are exercised
deterministically rather than by timing. Use them for any new check-then-act path.

## Verification (required)

| What changed | Run |
|---|---|
| Anything in this crate | `cargo test -p futo-notes-store` + `cargo test -p futo-notes-core` |
| Note identity, collision resolution, or link rewriting | the above + `just test-cross-platform` — those outcomes reach the sync protocol |
| A note rule's behavior | the above + `just test-rust` — the goldens and the TS↔Rust differential |
| Broad or risky work | `just test-rust-full` — the whole cargo workspace |
