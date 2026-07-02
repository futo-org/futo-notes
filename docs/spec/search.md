# Search — Spec

Search is on-device keyword retrieval. The shared Rust engine indexes note
title, folder, tags, and body text with Tantivy BM25. The older client-side
MiniSearch index remains as the warm-up and non-Tauri fallback.

## Behavior

- Search runs fully on-device; no query or note content leaves the device.
- The Rust index builds in the background and never blocks the UI. Until
  `search_status.keyword.ready` is true, callers fall back to MiniSearch.
- Non-empty queries return ranked note IDs from BM25. On the Tauri search popup
  and Android an empty query shows the 8 most-recent notes. iOS is the
  exception by design: it has no dedicated search popup — search is an inline
  `.searchable` bottom bar on the folder browser, so an empty query simply shows
  the current folder's normal list (not an 8-recent list). → NoteListView.swift
  `.searchable`
- Store mutations feed `search_notify`; bulk wipes and live pulls trigger a
  rescan so the index stays in lockstep with the vault. This holds on every
  app: the native shells rescan after a live pull, and on desktop
  `handleSyncComplete` reindexes each peer change (`peerUpdatedIds` →
  `change`, `peerDeletedIds` → `unlink`, `renamed` → `rename`) into the
  engine. Without it a synced-in note stayed in MiniSearch but missing from
  Tantivy — unsearchable until the next app launch, since sync's Rust-side
  writes have their watcher echo suppressed and never reach `search_notify`.

## Search UI *(Tauri)*

- The drawer/sidebar search bar (or Ctrl/Cmd+P) opens a search popup with the
  input autofocused; queries debounce about 100 ms. → SearchPopup.svelte
- Results show title, a folder badge when the note is foldered, and a preview
  snippet; matches include note body text, not just titles.
- An empty query shows the 8 most-recent notes; x clears; Escape closes.
- Arrow keys navigate results, Enter opens; Ctrl/Cmd+click or Shift+click
  opens the result in a new tab. *(desktop)*

## Status & Platform Coverage

- Implemented in the shared `crates/futo-notes-search` crate as a Tantivy BM25
  index plus background reconciler, consumed by Tauri through
  `apps/tauri/src-tauri/src/search.rs`.
- Native shells use the same crate through the `futo-notes-ffi` `SearchEngine`
  facade. Both native shells query the Rust engine, map hits back onto their
  live note lists, and fall back to substring filtering while the index warms.
- SPLADE / learned-sparse search is preserved on the `splade-search` branch and
  is not part of `main`.
