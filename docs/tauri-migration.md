# Tauri v2 Migration (POC)

## Scope

This POC migrates the active app shell from Capacitor/Electron runtime paths to a Tauri v2 shell and moves sync/search heavy work into Rust commands to keep the Svelte UI responsive during large syncs.

## Architecture

### 1. Shell migration

- New Tauri workspace: `apps/tauri`
- Rust backend + command layer: `apps/tauri/src-tauri/src/core.rs`
- App entry: `apps/tauri/src-tauri/src/lib.rs`, `apps/tauri/src-tauri/src/main.rs`
- Root scripts now include:
  - `npm run tauri:dev`
  - `npm run tauri:build`
  - `npm run tauri:test:rust`
  - `npm run tauri:android:dev` / `npm run tauri:ios:dev`

### 2. Platform abstraction

- `PlatformName` now includes `tauri`
- Runtime detection now checks for Tauri internals first
- New adapter: `src/lib/platform/tauri.ts`
- Existing frontend calls continue to use `getFS()` / `PlatformFS` API

### 3. Rust core responsibilities

Implemented in `apps/tauri/src-tauri/src/core.rs`:

- Filesystem services:
  - list/read/write/delete note files
  - appdata read/write/delete/list
  - image save/path resolution
- Sync heavy path:
  - `core_prepare_sync_payload` (scan + hash + diff payload prep)
  - `core_apply_sync_delta` (bulk apply update/delete/rename + state updates)
- Search/index path:
  - in-memory note index
  - `core_rebuild_index`
  - `core_get_note_previews`
  - `core_keyword_search` with snippet highlighting

All heavy operations run via `spawn_blocking`; file scans/hashing use parallel processing (`rayon`) where useful.

### 4. Frontend integration

- New bridge module: `src/lib/rustCore.ts`
- `src/lib/sync.ts`:
  - uses Rust prep/apply commands on Tauri
  - keeps previous JS path for non-Tauri runtimes/tests
- `src/lib/notes.ts`:
  - on Tauri, initializes/refreshes from Rust index
  - keyword search can run async through Rust (`searchKeyword`)
- `src/components/SearchPopup.svelte`:
  - keyword mode uses async debounced search function (Rust-backed on Tauri)

## Behavior guarantees kept

- Filename-title invariant preserved: title remains exact filename stem (`.md` removed only).
- Svelte UI layer remains intact; no large UI rewrite.
- Monorepo root scripts remain the primary workflow entrypoint.

## Notable assumptions (POC)

- Notes root in Tauri is `Documents/FUTO Notes` (fallback to app data dir if documents path unavailable).
- Legacy Capacitor/Electron runtime paths have been removed in favor of Tauri + web.
- Folder-import native plugin behavior is not implemented in this POC.

## Next hardening steps

- Add a Tauri-native folder picker/import command for mobile parity with legacy Android plugin behavior.
- Add a Rust-side incremental index persistence format to avoid full cold rebuilds on very large datasets.
- Add end-to-end Tauri mobile device profiling for 1k/5k note sync batches.
