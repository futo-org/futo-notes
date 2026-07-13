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

- `notes.test.ts` asserts startup never reads or writes
  `.search-index-v1.json`.
- `searchEngineNotify.test.ts` asserts an authoritative empty Rust result does
  not fall through to another search implementation.
- `docs/spec/search.md` records Rust/Tantivy as the sole full-text owner.
