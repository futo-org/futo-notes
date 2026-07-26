# Duplicate search indexes turned warm startup into a cold rebuild

## Symptom

FUTO Notes 1.6.0 felt slow for roughly the first minute with a 2,500-note
vault. The Tauri and WebKit processes consumed sustained CPU, transient memory
peaked above 2 GB combined, and the backend wrote tens of megabytes despite no
notes changing.

## Root cause

Desktop maintained two complete full-text indexes:

1. Rust/Tantivy opened its index, reconciled note mtimes, and removed the
   legacy `.search-index-v1.json` artifact.
2. The frontend then observed that JSON file as missing, read every note body,
   rebuilt MiniSearch on WebKit's JavaScript thread, serialized about 10 MB of
   nested JSON, and atomically persisted it back into the vault.

That made every warm launch cold by construction. It also meant an empty Rust
result could fall through to MiniSearch, allowing search semantics to diverge.

## Rule

A shipped platform owns exactly one full-text index. Search warm-up may filter
metadata already needed for the note list, but it must not read all note bodies
or persist another index. Synchronous affordances such as wikilink completion
filter note IDs directly rather than borrowing the full-text engine.

## Guard

- Nothing on the TypeScript side can read or write `.search-index-v1.json` any
  more — the MiniSearch index was deleted outright, and the Rust indexer's
  `cleanup_legacy` (`crates/futo-notes-search/src/indexer.rs`) removes any
  leftover artifact. The original `notes.test.ts` guard went away with that
  index in commit 28a1dbfd.
- An authoritative empty engine result must not fall through to another search
  implementation — asserted by the
  `does not fall back to shell substring search` case in
  `src/features/notes/notes.contract.test.ts` (successor to the former
  `searchEngineNotify.test.ts` guard, also removed in 28a1dbfd).
- `docs/spec/search.md` records Rust/Tantivy as the sole full-text owner.
