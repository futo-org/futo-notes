# Gap Inventory — GENERATED, do not edit

One line per inline `> **Gap:**` note in docs/spec/*.md (the source of
truth). Regenerate with `just spec-gaps`; `just spec-gaps-check` (part of
`just check`) fails when this file is stale and runs closure probes that
flag gaps the codebase suggests have been implemented.

## app.md

- [app.md:61](app.md#L61) — the native shells have no crash capture/report pipeline.

## editor.md

- [editor.md:65](editor.md#L65) — the native shells have no tag bar — tags can only be edited as text in the body. → NoteEditorScreen.kt / NoteEditorView.swift
- [editor.md:75](editor.md#L75) — the native shells show the full path — the suffix resolver needs the vault note list, which only the Tauri shell feeds to the editor (observed Android native 2026-06-09).
- [editor.md:86](editor.md#L86) — the native shells render wikilinks but do not navigate on tap (the tap just places the cursor; verified Android native 2026-06-09), have no autocomplete, and do not relink on rename/move — the relink logic lives in TS (`rewriteWikilinksForRename`), not in the shared Rust crates, so a rename on a native device silently breaks backlinks vault-wide.
- [editor.md:119](editor.md#L119) — the native shells have no markdown toolbar — formatting is typed by hand.
- [editor.md:128](editor.md#L128) — the native shells do not render local images in the editor WebView and have no insert/paste path.

## list.md

- [list.md:42](list.md#L42) — the Tauri mobile shell focuses the **body**, not the title, for both "+ New" and Quick capture (observed Android Tauri 2026-06-09).
- [list.md:62](list.md#L62) — the native Android editor menu has **only** "Delete note" — no move, no copy-path. iOS native's editor menu is thinner still (Rename only; share/delete/move live on the list rows). **Both native shells delete immediately with no confirmation** (verified on emulator + sim 2026-06-09) — a data-safety divergence from the Tauri confirm dialog.
- [list.md:71](list.md#L71) — Android native has no move UI at all (`store.moveNote()` exists, nothing calls it).
- [list.md:78](list.md#L78) — Android native has no New Folder affordance.
- [list.md:118](list.md#L118) — desktop (Tauri) and Android do not yet expose a folder-delete UI; the shared core `delete_folder` is available for them to wire up.

## search.md

- [search.md:60](search.md#L60) — the hybrid search crate is reachable only via Tauri commands — it is NOT exposed through `futo-notes-ffi` (the generated Swift/Kotlin bindings have no search symbol; verified on-device 2026-06-04). So the native SwiftUI (`apps/ios`) and Compose (`apps/android`) shells stay substring-only. Wiring `futo-notes-search` into the FFI facade is the remaining work for the native apps.
- [search.md:67](search.md#L67) — the Android **Tauri** debug/offline APK does not bundle the SPLADE model file — `search_status` reports `splade.fallbackReason: "model_file_missing"` and search runs BM25-only (observed 2026-06-09, emulator). Keyword search still covers note bodies; only the semantic upgrade is missing.

## settings.md

- [settings.md:13](settings.md#L13) — the native **iOS** app has no Settings surface at all — the nav-bar cloud button opens the Sync sheet directly (server, password, Connect & Sync, status, plus a notes-folder path readout), so there is no theme control, account header, or about section (verified on simulator 2026-06-09). The lines below currently describe Android only.
- [settings.md:43](settings.md#L43) — the native shells have no crash-reporting toggle, no full reset, and no notes-directory affordances.

## sync.md

- [sync.md:91](sync.md#L91) — The native session (auth token + vault key) is held in memory only. On **iOS** the password is persisted in the Keychain (`kSecAttrAccessibleWhenUnlocked`) and the app auto-reconnects on a cold launch (`SyncManager.restoreSession`), so live sync survives a force-quit — at the cost of storing the password on-device (device compromise → password → vault key). It is cleared on explicit disconnect. On **Android** the session is still in-memory only, so process death / Activity recreation drops it and the user must reconnect; a normal background→foreground resume keeps it.
- [sync.md:239](sync.md#L239) — the native clean-adopt resets the editor caret (the embed's `FutoEditor.setContent` does a full replacement). The desktop's `applyExternalContent` preserves the selection and parks dirty drafts as conflict copies; the native shells adopt-when-clean / keep-draft-when-dirty without selection preservation or conflict-copy minting.

_17 gaps._
