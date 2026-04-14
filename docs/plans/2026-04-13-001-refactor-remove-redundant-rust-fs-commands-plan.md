---
title: Remove redundant Rust FS commands replaceable by @tauri-apps/plugin-fs
type: refactor
status: active
date: 2026-04-13
---

# Remove redundant Rust FS commands replaceable by @tauri-apps/plugin-fs

## Overview

Five remaining Tauri commands in `apps/tauri/src-tauri/src/core.rs` wrap operations that `@tauri-apps/plugin-fs` already supports now that we have the `**` scope configured. Removing them cuts ~85 lines of Rust, eliminates one IPC round-trip per image/dir operation, and aligns the codebase with the audit floor documented in the Rust-to-TS migration ledger.

Target commands to remove: `fs_ensure_dir`, `fs_list_dir_files`, `fs_delete_file`, `fs_save_image_bytes`, `fs_get_image_path`.

Commands that stay Rust for genuine platform reasons: `fs_paste_clipboard_image` (native Linux/Wayland clipboard), `fs_save_image` (reads from arbitrary file-picker paths), `fs_set_mtime` (plugin-fs has no mtime API), `resolve_default_notes_root` (reads `STONEFRUIT_DATA_DIR` + `#[cfg(debug_assertions)]` fake-notes gate), `notes_dir_override_load/save` (app-data-dir file the rest of TS can't reach without broader plugin-fs scope), watcher, supersearch, and sync.

## Problem Frame

The Rust-to-TS migration landed `@tauri-apps/plugin-fs` with a `**` scope per permission and `requireLiteralLeadingDot: false`. At that point, several `fs_*` commands in `core.rs` became redundant — they do exactly what plugin-fs does, just with more code and more IPC. They survived the migration because the migration was already large and risky. Now that the core platform is stable, removing them is safe and keeps our "thin shell" story honest.

## Requirements Trace

- R1. All five target commands are removed from `core.rs` and from `lib.rs`'s `generate_handler![]` registration.
- R2. Every production TS caller of the target commands is rewritten to use `@tauri-apps/plugin-fs` directly (or inline TS for path building).
- R3. `cargo check -p futo-notes-tauri` passes with zero warnings after the removal.
- R4. `pnpm exec tsc --noEmit`, `pnpm run test:unit`, and `pnpm run build` all pass.
- R5. Dev build still defaults to `~/Documents/fake-notes` and production to `~/Documents/stonefruit` (the isolation guarantee from `AGENTS.md`).
- R6. The `tauriPaths.getNotesRoot` chain continues to create the notes dir on first use (so image paste and note save don't race the dir into existence).

## Scope Boundaries

- **In scope:** removing the five listed commands and their TS invoke call sites. Deleting Rust helpers and struct definitions that become dead (`DirFileEntry`) and tightening imports (`ensure_safe_note_id` from `stonefruit_core::files` becomes test-only after removal).
- **Out of scope:** Touching sync (`core_*_v2`), supersearch (`supersearch_*`), watcher (`fs_start_watcher`), clipboard image paste (`fs_paste_clipboard_image`), arbitrary-source image save (`fs_save_image`), mtime setting (`fs_set_mtime`), or the config path commands (`resolve_default_notes_root`, `notes_dir_override_load`, `notes_dir_override_save`). Each of these has a real justification documented in the audit.
- **Not a public API change.** No behavior visible to end users should change.
- **No new tests for the Rust side.** We are subtracting code. TS test coverage for images/notes-root already exists.

## Context & Research

### Relevant Code and Patterns

- `src/lib/platform/tauri.ts` already uses `@tauri-apps/plugin-fs` for every appdata/note operation. The 5 remaining `invoke()` call sites for our targets are all in this file, lines 228-247. Example patterns to mirror:
  - `readAppData` (atomicWrite + scope-aware path build): the template for any "resolve notes root then call plugin-fs" method.
  - `writeAppData`: uses `writeAtomicText` adapter. Image writes don't need atomicity (binary blob, overwrite-safe) so plain `writeFile` is fine.
- `src/lib/platform/tauriPaths.ts` — `getNotesRoot` currently calls `invoke('fs_ensure_dir', { path: root })`. Replace with `mkdir(root, { recursive: true })`. `ensureDir(path)` public helper does the same.
- `src/lib/images.ts` — already fully TS; consumes `getFS().listDirFiles()` and `getFS().deleteFile()`. No changes needed to callers once the underlying `tauriFS` methods are rewritten.
- `src/lib/notesIndex.ts:50` also calls `fs.listDirFiles()` from `convertTxtToMd`. Same: no caller changes needed.
- `src/lib/markdownToolbar.ts` and `src/lib/imagePaste.ts` call `fs.saveImageBytes()` and `fs.getImageUrl()`. These consume `PlatformFS` methods by name; again no caller changes.
- Rust-side helpers that survive after cleanup: `write_image_to_notes`, `validate_image_ext`, `rand_suffix` stay (still used by `fs_paste_clipboard_image` and `fs_save_image`).
- Rust-side items that become dead: `DirFileEntry` struct (only used by `fs_list_dir_files`).
- `ensure_safe_note_id` from `stonefruit_core::files` — only call in core.rs is inside `fs_get_image_path`, using the questionable `filename.replace('.', "")` pattern. After removal, the import is test-only. The test `ensure_safe_note_id_allows_whitespace_only` is testing an upstream crate's behavior; `pathSafety.test.ts` already covers the TS port. The Rust test can be deleted along with the import.

### Institutional Learnings

- **Dev-vs-prod isolation is load-bearing** (`AGENTS.md:63`). The current `getNotesRoot()` chain must keep creating the folder. Replacing `fs_ensure_dir` with plugin-fs `mkdir` preserves this, but the plan verification must confirm a clean launch into `~/Documents/fake-notes` still works.
- **plugin-fs scope recipe** (`apps/tauri/src-tauri/tauri.conf.json` + `capabilities/default.json`): `{ "path": "**" }` on every `fs:allow-*` permission + `requireLiteralLeadingDot: false`. No capability changes are needed for this refactor — we're adding no new permissions, and `mkdir`/`readDir`/`stat`/`writeFile`/`remove` are already granted.
- **`.sf-tmp-` atomic write dotfiles** (`atomicWrite.ts`) only matter for text writes. Image writes are single-shot `writeFile` — no temp file needed, so no dotfile matching concern.
- **Watcher suppression during writes** lives in Rust (`fs_start_watcher`). None of the removed commands interact with that system, so suppression behavior is unchanged.

### External References

Not applicable — this is a local cleanup with clear plugin-fs equivalents that have been used elsewhere in the codebase for weeks.

## Key Technical Decisions

- **Replace `fs_ensure_dir` with plugin-fs `mkdir({ recursive: true })` rather than deleting it entirely.** The call sites in `tauriPaths.ts` are load-bearing for the dev-isolation guarantee; they create the notes dir on first use. `mkdir(recursive)` is safe if the dir already exists.
- **`fs_get_image_path` becomes pure TS path building plus `convertFileSrc`.** The Rust implementation's `ensure_safe_note_id(&filename.replace('.', ""))` pattern is almost certainly unintentional (stripping dots from `"foo.png"` to validate `"foopng"` defeats the point). Replace with a proper image-filename check (`isImageFilename` + traversal guard) in `images.ts`/`tauri.ts`. This fixes a latent validation bug as a side effect.
- **Keep `saveImage` and `saveImageBytes` in the `PlatformFS` interface.** The interface shape is a product of the web-vs-tauri split, not this refactor. Rewriting the Tauri implementation to use plugin-fs is enough; interface, web stub, and test FS stub stay as-is.
- **Do not change the returned image filename format.** Rust returns `"{now_ms}-{rand 0-9999}.{ext}"`; TS `generateImageFilename` returns `"image-{timestamp}-{12 hex}.{ext}"`. Callers don't depend on a specific format (the filename is round-tripped through `insertImageMarkdown` and `registerLocalImageUrl`). We adopt the TS format, which is stronger against collisions.
- **Remove `DirFileEntry` struct and the `ensure_safe_note_id` import from core.rs** once their last users are gone. Delete the single Rust test that only covers the upstream crate's behavior (`ensure_safe_note_id_allows_whitespace_only`) — `pathSafety.test.ts` already covers the TS port.

## Open Questions

### Resolved During Planning

- **Does plugin-fs `mkdir` tolerate an already-existing directory?** Yes with `recursive: true` (mirrors `fs::create_dir_all` in Rust). No try/catch needed.
- **Will removing `fs_get_image_path` break `convertFileSrc`?** No. `convertFileSrc` is imported from `@tauri-apps/api/core` and works on any path string — it doesn't require a Rust round-trip. The only reason it went through Rust was path resolution, which TS now has via `getNotesRoot()`.
- **Are `fs_list_dir_files` / `fs_delete_file` / `fs_save_image_bytes` called from anything besides `platform/tauri.ts`?** No. A repo-wide grep confirms all three are only referenced by the `tauriFS` object. Safe to retire in lockstep with the TS rewrite.
- **Does removing `DirFileEntry` affect the serialization of values that TS reads?** No — after the rewrite, plugin-fs returns its own shape (`{ name, isFile, isDirectory, ... }`) that we map to our `DirFileEntry` interface in TS. The Rust struct is unused.

### Deferred to Implementation

- Exact mapping between plugin-fs `DirEntry` + `stat()` results and the `DirFileEntry { name, size, mtime }` shape TS expects. The fields are obvious but the specific plugin-fs call sequence (`readDir` then `stat` each, or a different API) is confirmable at edit time.
- Whether the existing `images.test.ts` needs mock tweaks when the underlying `tauriFS.listDirFiles` / `deleteFile` stop using `invoke()`. Likely no — tests mock `$lib/platform`, not `@tauri-apps/plugin-fs` directly. Confirm during Unit 3.

## Implementation Units

- [ ] **Unit 1: Replace `fs_ensure_dir` callers with plugin-fs `mkdir`**

**Goal:** Move notes-root directory creation and the `ensureDir` helper to `@tauri-apps/plugin-fs` so the `fs_ensure_dir` Rust command has no remaining callers.

**Requirements:** R2, R5, R6

**Dependencies:** None

**Files:**
- Modify: `src/lib/platform/tauriPaths.ts`
- Test: existing `src/lib/platform/tauriPaths.test.ts` — update mocks from `invoke('fs_ensure_dir')` to `@tauri-apps/plugin-fs.mkdir`.

**Approach:**
- Import `mkdir` from `@tauri-apps/plugin-fs` in `tauriPaths.ts`.
- Inside `getNotesRoot()`, replace `await invoke('fs_ensure_dir', { path: root })` with `await mkdir(root, { recursive: true })`.
- Inside `ensureDir()`, replace the invoke with the same `mkdir(path, { recursive: true })`.
- The `invoke` import remains (used by `notes_dir_override_load/save` and `resolve_default_notes_root`).

**Patterns to follow:**
- `src/lib/platform/tauri.ts` already uses `mkdir` from `@tauri-apps/plugin-fs` inside `writeAppData` and `writeBinaryAppData`.

**Test scenarios:**
- Notes root resolution returns the override dir when set, creating it if missing.
- Notes root resolution returns the Rust-resolved default when no override, creating it if missing.
- `ensureDir` creates a non-existent path without error.
- `ensureDir` is a no-op on an already-existing path (verify no exception propagates).

**Verification:**
- `pnpm run test:unit -- src/lib/platform/tauriPaths.test.ts` passes.
- Dev launch (`just td`) writes first-run state into `~/Documents/fake-notes` without any init error.

---

- [ ] **Unit 2: Rewrite `listDirFiles` and `deleteFile` in `tauriFS` to use plugin-fs**

**Goal:** Replace the `fs_list_dir_files` and `fs_delete_file` invoke-based implementations with direct `@tauri-apps/plugin-fs` calls.

**Requirements:** R2

**Dependencies:** None (independent of Unit 1)

**Files:**
- Modify: `src/lib/platform/tauri.ts`
- Test: existing `src/lib/images.test.ts` and `src/lib/notesIndex.test.ts` — confirm they still pass (both consume via `$lib/platform` mock which doesn't touch these internals).

**Approach:**
- In `tauriFS.listDirFiles()`:
  - Resolve the notes root via the existing `getNotesRoot()` cache helper.
  - Call plugin-fs `readDir(root)`; for each entry where `isFile === true`, call `stat(path)` to get `size` and `mtime`.
  - Map to the existing `DirFileEntry` TS interface `{ name, size, mtime }`.
  - Run stats in parallel with `Promise.all` (matches the pattern already used in `listNoteFiles`).
- In `tauriFS.deleteFile(filename)`:
  - Reject path separators and `..` inline (cheap defensive check at the boundary, same as `ensureSafeNoteId` pattern used elsewhere in the file).
  - Call plugin-fs `remove(${root}/${filename})`.
  - Swallow NotFound via `isNotFound(e)` from `fsErrors.ts` to match the old Rust behavior (which ignored missing files silently? confirm at implementation — Rust `fs::remove_file` errors on missing, so the old command threw; we preserve that throw here by letting the error propagate).

**Patterns to follow:**
- `src/lib/platform/tauri.ts` `listNoteFiles` method for the `readDir + parallel stat` shape.
- `src/lib/platform/tauri.ts` `deleteNoteFile` for the "validate then plugin-fs remove with NotFound handling" shape.

**Test scenarios:**
- `listImageFiles` returns entries sorted by mtime descending after the rewrite.
- `convertTxtToMd` still finds `.txt` files when called through the new `listDirFiles`.
- `deleteImage` rejects path-traversal filenames before any FS call.
- `deleteImage` on a missing file behaves the same way it did before (confirm whether the old Rust threw or swallowed; mirror exactly).

**Verification:**
- `pnpm run test:unit` passes including `images.test.ts` and `notesIndex.test.ts`.
- Manual: open the sidebar Images view, verify images list loads; delete one; verify it disappears and the file is removed from disk.

---

- [ ] **Unit 3: Rewrite `saveImageBytes` and `getImageUrl` in `tauriFS` to use plugin-fs + inline TS**

**Goal:** Replace `fs_save_image_bytes` and `fs_get_image_path` with TypeScript that builds paths via `getNotesRoot()` and writes/resolves through plugin-fs + `convertFileSrc`.

**Requirements:** R2

**Dependencies:** None (independent of Units 1 and 2)

**Files:**
- Modify: `src/lib/platform/tauri.ts`
- Test: existing `src/lib/imagePaste.test.ts`, `src/lib/images.test.ts`

**Approach:**
- In `tauriFS.saveImageBytes(data, ext)`:
  - Use `generateImageFilename(ext)` from `src/lib/images.ts` to produce a unique filename. (Prefer moving this into `tauri.ts`'s local helpers only if a cross-module import cycle appears; the existing export from `images.ts` is fine since `tauri.ts` already lives one layer down from `images.ts` in the dep graph — confirm at edit time.)
  - Resolve the notes root, build the absolute path, call plugin-fs `writeFile(path, new Uint8Array(data))`.
  - Return the filename.
- In `tauriFS.getImageUrl(filename)`:
  - Validate with `isImageFilename(filename)` and reject traversal characters (`..`, `/`, `\`).
  - Resolve the notes root, build the absolute path.
  - Return `convertFileSrc(absPath)`.
- Delete the `toBytes(data: ArrayBuffer)` helper in `tauri.ts` if it becomes dead after this unit (it's currently used only by `saveImageBytes`).

**Technical design:** *(directional sketch, not implementation spec)*

```
saveImageBytes(data, ext):
  filename = generateImageFilename(ext)        // images.ts already does validation
  root     = await getNotesRoot()
  await writeFile(`${root}/${filename}`, Uint8Array.from(data))
  return filename

getImageUrl(filename):
  if !isImageFilename(filename) or traversal(filename): throw
  root = await getNotesRoot()
  return convertFileSrc(`${root}/${filename}`)
```

**Patterns to follow:**
- `src/lib/platform/tauri.ts` `writeBinaryAppData` — path validation + plugin-fs `writeFile` + `new Uint8Array(data)`.
- `src/lib/platform/tauri.ts` `getImageUrl` original shape — keep the final `convertFileSrc` call; only the path-resolution step changes.

**Test scenarios:**
- Pasting an image inserts a `![](filename)` marker and the referenced file appears on disk under notes root.
- Using the toolbar "insert image bytes" flow writes the file and returns a valid URL that resolves via `asset://` / `convertFileSrc`.
- `getImageUrl('../../evil.png')` throws.
- `getImageUrl('not-an-image.md')` throws (fails `isImageFilename`).

**Verification:**
- `pnpm run test:unit` passes including `imagePaste.test.ts`.
- Manual: paste a screenshot into the editor, confirm it renders; restart the app, confirm the image still renders (proves `convertFileSrc` works against the new TS path resolution).

---

- [ ] **Unit 4: Remove Rust commands, dead helpers, and unused imports**

**Goal:** Delete the five Tauri commands, their now-dead helpers/types, and trim the `generate_handler![]` list. Verify `cargo check -p futo-notes-tauri` comes back clean with zero warnings.

**Requirements:** R1, R3

**Dependencies:** Units 1, 2, and 3 must all land before this unit — otherwise removal breaks TS callers.

**Files:**
- Modify: `apps/tauri/src-tauri/src/core.rs`
- Modify: `apps/tauri/src-tauri/src/lib.rs`

**Approach:**
- From `core.rs`, remove:
  - `pub async fn fs_list_dir_files`
  - `pub async fn fs_delete_file`
  - `pub async fn fs_save_image_bytes`
  - `pub async fn fs_get_image_path`
  - `pub async fn fs_ensure_dir`
  - `pub struct DirFileEntry` (no remaining users)
  - The `ensure_safe_note_id` name from the `use stonefruit_core::files::{...}` import (keeping `file_mtime_ms` and `set_file_mtime_ms`, both still used).
  - The `ensure_safe_note_id_allows_whitespace_only` test (redundant — covered by `src/lib/platform/pathSafety.test.ts`).
- From `lib.rs`, remove the five command names from `tauri::generate_handler![ ... ]`.
- Keep: `write_image_to_notes`, `validate_image_ext`, `rand_suffix` — still used by `fs_paste_clipboard_image` and `fs_save_image`.
- Keep: the `convert_txt_to_md` Rust helper (still called by sync prep; will go away when sync migrates).
- Run `cargo check -p futo-notes-tauri` to surface any remaining unused imports or helpers the rustc warning pass flags.

**Patterns to follow:**
- `ce9bb37` — previous "Remove dead Rust commands after TypeScript migration" commit. Use the same methodology: remove commands first, then let the compiler identify newly-dead helpers, then remove those.

**Test scenarios:**
- `cargo check -p futo-notes-tauri` completes with zero warnings.
- `cargo test -p futo-notes-tauri` passes (the remaining tests cover sync, watcher suppression, txt migration, clipboard warning filter).
- `pnpm exec tsc --noEmit` still passes (no reference to the removed commands survives).

**Verification:**
- Output of `git diff HEAD -- apps/tauri/src-tauri/` shows only deletions plus handler-list edits — no inadvertent changes to sync, watcher, supersearch, or clipboard commands.
- `pnpm run build` produces the same `dist/` output (modulo hash changes from the tauri.ts edits in earlier units).
- Launch via `just td` and run `node tests/verify-sync.mjs` — end-to-end sync round-trip still passes, proving nothing we kept was accidentally broken.

## System-Wide Impact

- **Interaction graph:** Only `src/lib/platform/tauri.ts`, `src/lib/platform/tauriPaths.ts`, and the Rust sides are touched. Consumers of `PlatformFS` (images.ts, imagePaste.ts, markdownToolbar.ts, notesIndex.ts) are unchanged because the interface is unchanged.
- **Error propagation:** plugin-fs errors reach TS as thrown `Error`s with message strings. The `isNotFound` helper already normalizes this. No change to how errors surface to UI.
- **State lifecycle risks:** First-run directory creation must still happen before any `readAppData`/`writeAppData` call. Unit 1 preserves this via plugin-fs `mkdir(recursive)` in `getNotesRoot()`.
- **API surface parity:** The web platform shim (`src/lib/platform/web.ts`) and the test FS (`src/lib/platform/__test__/nodeFS.ts`) both implement the `PlatformFS` interface. No interface change, so neither needs edits.
- **Integration coverage:** `tests/verify-sync.mjs` still exercises the full client + server round trip. A successful run after Unit 4 confirms the surviving Rust commands (sync, watcher, mtime, clipboard, image source-path save, supersearch) still work.

## Risks & Dependencies

- **Risk: `stat` behavior on broken symlinks.** plugin-fs's `readDir` + `stat` may throw on dangling symlinks where Rust `read_dir` iterated them. Mitigation: wrap the per-entry stat in a `Promise.allSettled` or inline try/catch, matching how the Rust version used `.filter_map(|entry| entry.ok())` to drop unreadable entries.
- **Risk: `generateImageFilename` import direction.** `tauri.ts` currently sits "below" `images.ts` in the dep graph. Importing `images.ts` from `tauri.ts` may create a cycle. Mitigation options, in order of preference: (a) inline a small filename generator in `tauri.ts`; (b) move `generateImageFilename` to a small shared module; (c) accept the import if no cycle surfaces. Pick at implementation time.
- **Risk: removing the `ensure_safe_note_id` Rust import breaks tests we forgot about.** Mitigation: the Unit 4 `cargo check` step is the gate — compiler errors will flag any forgotten user immediately.
- **Dependency:** the fs-plugin scope must stay at `{ "path": "**" }` per permission (already in `capabilities/default.json`) and `requireLiteralLeadingDot: false` (already in `tauri.conf.json`). No capability change is part of this plan.

## Documentation / Operational Notes

- Update `docs/tauri-rust-to-ts-migration-ledger.md` to reflect the shrunk Rust surface (the five rows move from "remaining" to "removed"). Minor, but worth keeping the ledger accurate.
- No runbook, migration, or rollout impact. This is a pure refactor of identical behavior. If a regression shipped, it would show up immediately on next `just td` or next developer's `pnpm run test:unit`.

## Sources & References

- Audit conversation: Rust interrogation that produced the "~85 lines of easy cleanup" list.
- Migration ledger: `docs/tauri-rust-to-ts-migration-ledger.md`.
- Prior cleanup precedent: commit `ce9bb37` — "Remove dead Rust commands after TypeScript migration".
- AGENTS.md Key Constraints section on dev-vs-prod isolation (load-bearing for Unit 1 verification).
