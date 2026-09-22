# AGENTS.md — futo-notes-store

**The** local note engine: one durable owner for a Markdown vault and its derived search index.
Every shell — Tauri desktop, native iOS, native Android — reaches note CRUD through this crate
(desktop directly, mobile through `futo-notes-ffi`). Nothing else may read or write the vault.

Layering: `futo-notes-model` decides note rules (no filesystem), `futo-notes-core` provides the
primitives (path safety, atomic writes, conflict names, the vault mutation guard),
`futo-notes-search` is the index engine. This crate is where those meet a real directory.

## Modules

- **`lib.rs`**: `LocalNoteStore` and the whole public workflow surface — `bootstrap`,
  `startup_listing`, `snapshot`, `read`, `create`, `write`, `save`, `flush_draft`, `rename`,
  `move_note`, `delete`, the folder workflows, `reset`, and the vault-migration entry points.
- **`vault.rs`**: the corpus walk, snapshot building, and `note_list_order` — **the** note-list sort
  rule (modified desc, id asc).
- **`paths.rs`**: collision resolution (`unique_note_id`, `unique_folder_path`).
- **`editor_draft.rs`**: baseline-aware identity changes. A stale editor parks its draft at the
  requested destination instead of overwriting the peer, and does not redirect links away from it.
- **`vault_migration.rs`**: staged, verified moves of a whole vault to a new root.
- **`search.rs`**: the per-vault search-engine lifecycle (start, retry, restart). The only place
  that constructs a `SearchEngine`.

## Rules that are easy to break here

- **Every mutation goes through the gate, under one vault guard.** `LocalNoteStore` serializes
  writes through its `gate` mutex and takes `vault_mutation_guard()`, so a conditional write or a
  multi-file rename-and-relink has one decision boundary. A caller that reads, decides, then calls
  back in has created a check-then-act race (AGENTS.md §4, item 6 — one such race resurrected a
  deleted note). If two calls must happen in order, add one workflow here instead.
- **`MutationResult` is the complete post-commit projection.** It carries `upserted` (each with its
  position in the sort order), `removed`, `renamed`, `folders`, the collision-resolved `final_id` /
  `final_folder`, and `warnings`. Shells apply it verbatim. Never leave a shell to reconstruct a
  collision outcome, a backlink rewrite, or a list position — ADR-0001 forbids a shell-side
  comparator or final-id heuristic.
- **Sort order lives only in `vault.rs`.** Shells splice the engine-reported positions.
- **The raw save primitives stay private and `flush_draft` is the one save verb**, returning a
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

## Testing

Tests are inline: `src/tests.rs` (`#[cfg(test)] mod tests`) with helpers in `src/test_support.rs`.
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
