# Tauri Rust to TypeScript Migration Ledger

Status date: 2026-04-13

This ledger tracks the client-side Rust surface that would need to be kept, deleted, or moved to TypeScript if Stonefruit becomes a Tauri thin shell. It covers:

- `apps/tauri/src-tauri/src/lib.rs`
- `apps/tauri/src-tauri/src/core.rs`
- `stonefruit-core` helpers currently imported by the Tauri client

It intentionally tracks behavior-bearing helpers, not only exported `#[tauri::command]` functions. Many migration risks live in helpers such as preview-cache invalidation, watcher suppression, mtime repair, and path safety.

## Status Key

| Status | Meaning |
|---|---|
| `kept as-is` | Should remain Rust for now. Usually native shell/platform behavior. |
| `not started` | Still fully owned by Rust. |
| `mostly moved` | TypeScript implementation already exists or equivalent API exists, but Rust is still wired in. |
| `moved, Rust still shimmed` | TypeScript owns behavior, but a thin Rust command is still required. |
| `delete with feature removal` | Remove if the corresponding product feature is intentionally removed. |
| `delete after callers gone` | Rust helper goes away naturally once its command callers are removed. |

## Migration Principles

| Principle | Decision |
|---|---|
| Preserve storage semantics first | Do not silently move notes-root files into Tauri app data. Today only `notes-dir-override.json` lives in app data; app config, engagement, search caches, and sync state are notes-root-relative through the platform appdata API. |
| Port behavior, not command names | A Rust command can disappear only when every helper behavior underneath it is covered in TypeScript tests. |
| Keep native shell work in Rust | Clipboard image paste, fd-limit tuning, Linux theme monitoring, iOS webview inset fixes, and maybe mtime setting remain appropriate Rust shell concerns. |
| Prove watcher parity early | A TypeScript watcher via `@tauri-apps/plugin-fs` is plausible, but desktop plus mobile behavior needs direct QA before removing `notify`-based Rust watching. |
| Treat semantic search and graph as product choices | Removing Tauri vector artifacts is separate from removing server HTTP semantic search and graph UX. |

## Recommended Migration Order

| Order | Area | Why |
|---|---|---|
| 1 | Engagement | Duplicated TS logic already exists; low-risk branch removal. |
| 2 | App metadata and notes-dir override | Small surface; use Tauri JS APIs while preserving current storage locations. |
| 3 | Path safety and atomic write modules | Foundation for all later ports. Needs parity tests before file I/O moves. |
| 4 | Filesystem read/write/image operations | Replace command calls with `@tauri-apps/plugin-fs`, but keep watcher and sync Rust during transition. |
| 5 | Note index and keyword search | Port preview cache, `.txt` migration, tags, headings, snippets, and MiniSearch wiring together. |
| 6 | Sync engine | Port from Rust implementation, not the current mock. Must keep dirty fast path, baselines, mtime cache, timestamp repair, and watcher suppression. |
| 7 | Watcher | Move only after platform parity is proven on desktop, Android, and iOS if possible. |
| 8 | Supersearch and graph | Decide product direction separately. Delete Tauri-local vector artifacts if unused. |
| 9 | Rust cleanup | Remove dead state, dependencies, and commands after zero callers and parity tests pass. |

## Public Tauri Command Surface

These are the functions currently registered in `tauri::generate_handler![]`.

| Command | Current TS callers | What it does | TS destination | Migration approach | Gotchas | Required parity checks | Status |
|---|---|---|---|---|---|---|---|
| `fs_list_note_files` | `src/lib/platform/tauri.ts` | Lists `.md` note files sorted by mtime and performs `.txt` migration first. | `src/lib/platform/tauri.ts`, `src/lib/notesIndex.ts` | Replace with plugin-fs `readDir`/`stat`; move `.txt` migration into index/bootstrap. | Do not drop `.txt` migration or file-only filtering. | Unit tests for sort/filter/migration; large-vault startup smoke. | `not started` |
| `fs_read_note` | `src/lib/platform/tauri.ts` | Reads a safe note ID from notes root. | `src/lib/platform/tauri.ts`, `src/lib/platform/pathSafety.ts` | Replace with plugin-fs `readTextFile`. | Must preserve exact note ID safety semantics. | Path traversal tests; read missing/error tests. | `not started` |
| `fs_write_note` | `src/lib/platform/tauri.ts` | Atomic note write, optional mtime set, index update, returns actual mtime. | `src/lib/platform/tauri.ts`, `src/lib/platform/atomicWrite.ts` | Port write and index update to TS; keep thin `fs_set_mtime` Rust shim if needed. | Must return actual post-write mtime. Watcher may fire differently. | Write/mtime tests; editor save smoke; sync timestamp smoke. | `not started` |
| `fs_delete_note_file` | `src/lib/platform/tauri.ts` | Deletes a safe note file and updates Rust index. | `src/lib/platform/tauri.ts`, `src/lib/notesIndex.ts` | Replace with plugin-fs `remove`; update TS cache/index. | Current Rust ignores missing file. Preserve or decide explicitly. | Delete missing/existing tests; cache/index update tests. | `not started` |
| `fs_note_exists` | `src/lib/platform/tauri.ts` | Checks whether a safe note path exists. | `src/lib/platform/tauri.ts` | Replace with plugin-fs `exists`. | Path validation happens before exists. | Path safety and unique-title tests. | `not started` |
| `fs_delete_all_content` | `src/lib/platform/tauri.ts` | Deletes all files/directories under notes root and clears Rust index. | `src/lib/platform/tauri.ts`, `src/lib/notes.ts` | Replace with plugin-fs recursive removal where safe. | Destructive; must not delete outside notes root. Hidden files and directories are currently deleted too. | Unit test with nested dir; reset flow smoke. | `not started` |
| `appdata_read` | `src/lib/platform/tauri.ts` | Reads a notes-root-relative appdata file, returns null if missing. | `src/lib/platform/tauri.ts`, `src/lib/platform/pathSafety.ts` | Replace with plugin-fs but preserve notes-root-relative storage. | Claude plan said `BaseDirectory.AppData`; that would move user data. | Tests for missing/null, traversal, same on-disk location. | `not started` |
| `appdata_write` | `src/lib/platform/tauri.ts` | Atomic write under notes root, creating parents. | `src/lib/platform/tauri.ts`, `src/lib/platform/atomicWrite.ts` | Port to TS atomic write. | Preserve parent creation and traversal blocking. | App state/config/engagement persistence tests. | `not started` |
| `appdata_delete` | `src/lib/platform/tauri.ts` | Deletes a notes-root-relative appdata file; ignores missing. | `src/lib/platform/tauri.ts` | Replace with plugin-fs `remove` wrapped for missing. | Preserve ignore-missing behavior. | Unit test missing/existing delete. | `not started` |
| `appdata_list` | `src/lib/platform/tauri.ts` | Lists filenames in notes-root-relative appdata dir; empty if missing. | `src/lib/platform/tauri.ts` | Replace with plugin-fs `readDir`. | Preserve empty-on-missing behavior. | Unit tests for missing and traversal. | `not started` |
| `appdata_read_binary` | `src/lib/platform/tauri.ts` | Reads binary appdata under notes root, null if missing. | `src/lib/platform/tauri.ts` | Replace with plugin-fs `readFile`. | Preserve `ArrayBuffer` conversion and null-on-missing. | Binary read/write roundtrip tests. | `not started` |
| `appdata_write_binary` | `src/lib/platform/tauri.ts` | Writes binary appdata under notes root, creating parents. | `src/lib/platform/tauri.ts` | Replace with plugin-fs `writeFile`. | Current Rust write is not atomic for binary. Decide if TS should improve it. | Binary roundtrip and parent-dir tests. | `not started` |
| `supersearch_has_artifacts` | `src/lib/platform/tauri.ts` only | Checks local vector artifact files. | None if feature removed. | Delete if local vector artifacts are dead. | Distinct from server HTTP semantic search. | Build plus search UX decision tests. | `delete with feature removal` |
| `supersearch_download` | `src/lib/platform/tauri.ts` only | Downloads vector artifacts from server into notes root. | None if feature removed. | Delete if local vector artifacts are dead. | Requires product decision; may have stale artifacts on disk. | Build plus artifact cleanup/migration decision. | `delete with feature removal` |
| `supersearch_query` | `src/lib/platform/tauri.ts` only | Local top-k vector search over downloaded artifacts. | None or TS vector module. | Prefer delete if server-side semantic search is also removed. | Can be expensive in JS if reintroduced locally. | Semantic search acceptance tests if kept. | `delete with feature removal` |
| `supersearch_note_vector` | `src/lib/platform/tauri.ts` only | Computes averaged vector for one note. | None or TS vector module. | Delete with local vector artifacts. | Graph code no longer appears to call this directly. | Build and dead-code check. | `delete with feature removal` |
| `supersearch_all_note_vectors` | `src/lib/platform/tauri.ts` only | Computes averaged vectors for all notes. | None or TS graph/vector module. | Delete with local vector artifacts. | Current graph code is server-layout based, not local-vector based. | Build and graph UX decision. | `delete with feature removal` |
| `fs_save_image` | `src/lib/platform/tauri.ts` | Reads picked source path and writes copied image to notes root. | `src/lib/platform/tauri.ts`, `src/lib/images.ts` | Replace with plugin-fs `copyFile` or `readFile`/`writeFile`. | Source path permissions and extension validation. | Image insert/display smoke. | `not started` |
| `fs_save_image_bytes` | *(removed)* | Writes image bytes into notes root with generated filename. | `src/lib/platform/tauri.ts`, `src/lib/images.ts` | Replaced in-place with plugin-fs `writeFile` + TS `generateImageFilename`. | Allowed extensions still validated via `validateImageExt` in TS. | Paste/drop image byte tests. | `removed` |
| `fs_paste_clipboard_image` | `src/lib/imagePaste.ts` | Native clipboard image paste, mainly Linux/Wayland fallback. | Rust shell | Keep. | Browser clipboard is insufficient on Linux/Wayland. | Manual clipboard image paste smoke. | `kept as-is` |
| `fs_get_image_path` | *(removed)* | Resolves image filename to absolute path for `convertFileSrc`. | `src/lib/platform/tauri.ts`, `src/lib/images.ts` | Replaced in-place with TS path resolution (`getNotesRoot()` + `convertFileSrc`) plus `isImageFilename` + traversal guard (fixes the prior `replace('.', '')` validation oddity). | None — validation now uses the same `isImageFilename` rules as the rest of TS. | Path traversal tests; image display smoke. | `removed` |
| `fs_start_watcher` | `src/lib/platform/tauri.ts` | Starts native `notify` watcher, emits `fs:change`, suppresses sync writes, invalidates Rust index. | `src/lib/platform/tauriWatcher.ts` or keep Rust | Try plugin-fs `watch`, but keep Rust until parity is proven. | Mobile behavior, duplicate events, temp-file events, sync suppression races. | Desktop + Android watcher QA; sync apply loop tests. | `not started` |
| `app_get_config` | `src/lib/platform/tauri.ts` | Returns notes dir, default dir, custom-dir flag, sidebar widths. | `src/lib/platform/tauriPaths.ts`, `src/lib/platform/tauri.ts` | Port to TS using Tauri path APIs and preserved config location. | Do not move `.app-config.json` without migration. | Settings restart persistence smoke. | `not started` |
| `app_save_config` | `src/lib/platform/tauri.ts` | Persists sidebar widths into `.app-config.json`. | `src/lib/platform/tauri.ts` | Port to TS atomic write. | Preserve option/null update semantics. | Config unit tests; restart smoke. | `not started` |
| `app_set_notes_dir` | `src/lib/platform/tauri.ts` | Validates absolute custom dir, creates it, writes override. | `src/lib/platform/tauriPaths.ts` | Port to TS, or keep tiny command if path validation needs native help. | Must reject relative paths and create target dir. | Settings custom-dir tests on desktop/mobile. | `not started` |
| `app_get_version` | `src/lib/platform/tauri.ts` | Returns package version. | `@tauri-apps/api/app.getVersion` | Replace with Tauri JS API. | None. | Build/typecheck. | `mostly moved` |
| `app_get_platform` | No current TS caller found | Returns Rust target OS. | Existing TS platform detection | Delete if unused. | If needed, Tauri JS OS APIs may be better. | Dead-code check. | `mostly moved` |
| `core_rebuild_index` | `src/lib/rustCore.ts` | Full Rust scan and index rebuild. | `src/lib/notesIndex.ts`, `src/lib/searchIndex.ts` | Port preview cache plus MiniSearch index rebuild. | Must preserve `.txt` migration, tags, headings, cache, sort. | Search/index unit tests; large-vault smoke. | `not started` |
| `core_get_note_list` | `src/lib/rustCore.ts` | Fast preview-only scan, no body index population. | `src/lib/notesIndex.ts` | Port as TS preview cache scan. | Easy to regress startup by reading every body. | Preview cache tests and startup profiling. | `not started` |
| `core_get_note_previews` | `src/lib/rustCore.ts` | Returns previews from loaded Rust index. | `src/lib/notesIndex.ts` | Remove with Rust index. | May become same as TS cache state. | Notes list tests. | `not started` |
| `core_keyword_search` | `src/lib/rustCore.ts` | Keyword search with snippets over Rust index. | `src/lib/searchIndex.ts` | Use MiniSearch plus TS snippet extraction. | Ranking and Unicode snippet boundary parity. | Search quality tests; Unicode snippet tests. | `not started` |
| `core_prepare_sync_payload_v2` | `src/lib/syncServiceV2.ts` | Builds sync payload with dirty fast path, inventory, hashes, baselines. | `src/lib/syncEngine.ts` | Port Rust implementation, not current mock. | Correctness-critical; hash cache key semantics matter. | Sync unit tests; cross-platform sync. | `not started` |
| `core_apply_sync_delta_v2` | `src/lib/syncServiceV2.ts` | Applies server updates/deletes/conflicts, mtimes, watcher suppression, index updates. | `src/lib/syncEngine.ts`, `src/lib/platform/tauriWatcher.ts` | Port with thin `fs_set_mtime` shim. | Must suppress watcher events before writes. | Cross-platform sync plus watcher loop tests. | `not started` |
| `core_list_image_files` | `src/components/SidebarImageView.svelte` | Lists image files with size and mtime. | `src/lib/images.ts` | Replace with plugin-fs `readDir`/`stat`. | Preserve allowed extensions and sort. | Image gallery test/smoke. | `not started` |
| `core_delete_image_file` | `src/lib/images.ts` | Validates and deletes image file. | `src/lib/images.ts` | Replace with plugin-fs `remove`. | Must block traversal; missing behavior currently errors. | Image delete unit/smoke tests. | `not started` |
| `engagement_load` | `src/lib/engagement.ts` | Loads engagement data into Rust cache. | `src/lib/engagement.ts` | Delete Rust branch; TS fallback already loads data. | Ensure TS appdata path matches current Rust location. | Engagement load invalid/missing tests. | `mostly moved` |
| `engagement_track_open` | `src/lib/engagement.ts` | Increments open count and last-opened timestamp. | `src/lib/engagement.ts` | Delete Rust call; TS already duplicates update. | Timer flush behavior must remain. | Engagement unit test. | `mostly moved` |
| `engagement_track_edit` | `src/lib/engagement.ts` | Increments edit count and last-edited timestamp. | `src/lib/engagement.ts` | Delete Rust call; TS already duplicates update. | Timer flush behavior must remain. | Engagement unit test. | `mostly moved` |
| `engagement_remove` | `src/lib/engagement.ts` | Removes engagement record. | `src/lib/engagement.ts` | Delete Rust call; TS already duplicates update. | None beyond flush. | Engagement unit test. | `mostly moved` |
| `engagement_rename` | `src/lib/engagement.ts` | Moves record from old note ID to new note ID. | `src/lib/engagement.ts` | Delete Rust call; TS already duplicates update. | Preserve no-op when old record absent. | Rename engagement test. | `mostly moved` |
| `engagement_get_all` | `src/lib/engagement.ts` | Returns Rust engagement cache. | `src/lib/engagement.ts` | Delete with Rust engagement cache. | TS cache must be loaded before reads. | Engagement load/get tests. | `mostly moved` |
| `engagement_flush` | `src/lib/engagement.ts` | Atomic write of dirty Rust engagement cache. | `src/lib/engagement.ts` | Delete Rust call; TS `writeEngagement` becomes sole path. | Must use atomic write helper after FS port. | Flush tests; app restart smoke. | `mostly moved` |
| `supersearch_is_ready` | No direct TS caller found | Checks cached supersearch metadata and artifact presence. | None if feature removed. | Delete with Tauri-local vector artifacts. | Distinct from server search readiness. | Dead-code check. | `delete with feature removal` |
| `supersearch_get_state` | No direct TS caller found | Returns cached supersearch metadata. | None if feature removed. | Delete with Tauri-local vector artifacts. | May leave stale `.supersearch-state.json`. | Artifact cleanup decision. | `delete with feature removal` |

## Tauri Runtime Bootstrap Functions

These are not business logic and are not good TS migration candidates.

| Function | What it does | Migration approach | Gotchas | Status |
|---|---|---|---|---|
| `should_suppress_libsoup_http2_warning` | Identifies one noisy Linux WebKit/libsoup warning. | Keep in Rust. | Unit test already exists. | `kept as-is` |
| `install_linux_log_filters` | Installs GLib log filter on Linux. | Keep in Rust. | Platform-native process logging. | `kept as-is` |
| `linux_color_scheme_watcher` | Watches XDG Desktop Portal via `gdbus` and emits `linux-theme-changed`. | Keep in Rust unless Tauri exposes a reliable JS alternative. | Handles a Tauri Linux gap. | `kept as-is` |
| `raise_fd_limit` | Raises Unix fd soft limit for large-vault sync, especially iOS. | Keep in Rust. | Must happen before app workload. | `kept as-is` |
| `run` | Builds Tauri app, registers plugins, setup hooks, commands, and platform tweaks. | Keep, but shrink command handler and managed state. | Add `tauri-plugin-fs` here if FS moves to plugin. | `kept as-is` |

## Path, Config, and Storage Helpers

| Function | What it does | TS destination | Migration approach | Gotchas | Status |
|---|---|---|---|---|---|
| `env_data_dir` | Reads `STONEFRUIT_DATA_DIR` dev/test override. | `src/lib/platform/tauriPaths.ts` | Port exactly. | Test harness may rely on this. | `not started` |
| `override_file_path` | Resolves where `notes-dir-override.json` is stored. | `src/lib/platform/tauriPaths.ts` | Port using Tauri path API and env override. | This is app data, unlike other appdata APIs. | `not started` |
| `load_notes_dir_override` | Reads custom notes dir override. | `src/lib/platform/tauriPaths.ts` | Port. | Invalid JSON currently means no override. | `not started` |
| `save_notes_dir_override` | Atomically writes custom notes dir override. | `src/lib/platform/tauriPaths.ts`, `atomicWrite.ts` | Port. | Preserve pretty JSON if desired. | `not started` |
| `io_err_to_string` | Normalizes IO error to string. | None | Delete after callers gone. | May be replaced by TS error wrapping. | `delete after callers gone` |
| `task_join_err` | Normalizes Rust background task join errors. | None | Delete after async Rust commands are gone. | Not relevant in TS. | `delete after callers gone` |
| `default_notes_root` | Resolves default notes directory, with dev override and document-dir fallback. | `src/lib/platform/tauriPaths.ts` | Port using `documentDir()` and `appDataDir()` fallback. | Current default folder is lowercase `stonefruit`. Preserve unless intentionally changing. | `not started` |
| `notes_root` | Returns custom/default notes root and creates it. | `src/lib/platform/tauriPaths.ts` | Port; maybe keep Rust helper for kept commands. | Clipboard paste still needs this in Rust unless passed a path. | `not started` |
| `load_app_config` | Reads `.app-config.json` under notes root. | `src/lib/platform/tauri.ts` | Port. | Storage location must remain notes-root-relative unless migrated. | `not started` |
| `save_app_config` | Atomically writes `.app-config.json` under notes root. | `src/lib/platform/tauri.ts`, `atomicWrite.ts` | Port. | Preserve nullable update semantics in command wrapper. | `not started` |
| `load_note_cache` | Reads `.note-preview-cache.json`. | `src/lib/notesIndex.ts` | Port or replace with existing `.search-index-v1.json` after explicit design. | Do not accidentally create two competing caches. | `not started` |
| `save_note_cache` | Writes `.note-preview-cache.json`. | `src/lib/notesIndex.ts` | Port or consolidate with MiniSearch persistence. | Current write is best-effort. | `not started` |

## Text Parsing, Tags, Preview Cache, and Keyword Search

| Function | What it does | TS destination | Migration approach | Gotchas | Status |
|---|---|---|---|---|---|
| `extract_headings` | Extracts Markdown headings for search weighting. | `src/lib/searchIndex.ts` | Mostly exists as `extractHeadings`; verify exact parity. | Rust trims leading spaces; TS regex currently requires heading at column 0. | `mostly moved` |
| `extract_tags` | Extracts unique hashtags outside fenced and inline code. | `@futo-notes/shared` | Use shared TS implementation if parity exists; otherwise port tests first. | Tag parsing is user-visible in sidebar. | `mostly moved` |
| `strip_inline_code` | Removes inline code spans before tag extraction. | `@futo-notes/shared` | Keep in shared TS tag implementation. | Multi-backtick edge cases. | `mostly moved` |
| `extract_tags_from_line` | Extracts tags from one cleaned line. | `@futo-notes/shared` | Keep in shared TS tag implementation. | Case-insensitive dedupe and punctuation rules. | `mostly moved` |
| `make_preview` | First 100 chars with newlines replaced by spaces. | `src/lib/notesIndex.ts` | Port or standardize with existing TS preview behavior. | Current TS paths sometimes use 200 chars or 3 lines. Pick one deliberately. | `not started` |
| `convert_txt_to_md` | One-way migration from `.txt` to `.md`, collision-safe. | `src/lib/notesIndex.ts` or migration module | Port before removing list/index commands. | Hidden behavior. Dropping it abandons old vaults. | `not started` |
| `floor_char_boundary` | Snaps byte offset down to UTF-8 boundary for snippets. | `src/lib/searchIndex.ts` | TS strings are UTF-16; write Unicode-aware snippet tests instead of literal port. | Emoji/combining character snippets. | `not started` |
| `ceil_char_boundary` | Snaps byte offset up to UTF-8 boundary for snippets. | `src/lib/searchIndex.ts` | Same as above. | Unicode boundary correctness. | `not started` |
| `build_indexed_note` | Builds Rust indexed note with lowercased fields, preview, headings, tags. | `src/lib/notesIndex.ts`, `src/lib/searchIndex.ts` | Port as index document builder. | Keep title equals filename ID. | `not started` |
| `note_to_preview` | Converts indexed note to UI preview payload. | `src/lib/notesIndex.ts` | Port. | Sort order and field names. | `not started` |
| `scan_notes` | Full scan, cache reuse, parallel body reads, cache write. | `src/lib/notesIndex.ts` | Port behavior or replace with tested MiniSearch persistence design. | Performance and cache invalidation. | `not started` |
| `backfill_bodies` | Loads note bodies lazily for cache-hit entries before search. | `src/lib/notesIndex.ts` | Port if preview cache defers bodies. | Avoid startup body reads but still search full bodies. | `not started` |
| `scan_note_previews` | Fast preview-only scan without populating search index. | `src/lib/notesIndex.ts` | Port. | This is key startup behavior. | `not started` |
| `ensure_index_loaded` | Lazily builds Rust search index. | `src/lib/notesIndex.ts` | Replace with TS index lifecycle. | Avoid duplicated index state. | `not started` |
| `build_highlighted_segments` | Splits snippet into highlighted/non-highlighted segments. | `src/lib/searchIndex.ts` | Mostly exists as `buildHighlightedSegments`; add parity tests. | Current TS term matching uses UTF-16 string indices. | `mostly moved` |
| `snippet_for_note` | Creates snippet window around first matched term. | `src/lib/searchIndex.ts` | Mostly exists as `extractSnippet`; tune parity. | Ranking/snippet UI drift. | `mostly moved` |
| `keyword_search_impl` | Searches title/headings/body with ranking and snippets. | `src/lib/searchIndex.ts` | Replace with MiniSearch or port ranking if needed. | MiniSearch ranking differs from Rust; test with real vault. | `not started` |

## Sync Engine

| Function | What it does | TS destination | Migration approach | Gotchas | Status |
|---|---|---|---|---|---|
| `prepare_dirty_only` | Builds sync payload from dirty journal only, no full vault walk. | `src/lib/syncEngine.ts` | Port from Rust. | Dirty journal is not cleared here; TS clears accepted entries later. | `not started` |
| `prepare_sync_payload_v2_impl` | Full/dirty sync payload prep with hash cache, inventory, baselines, deletions. | `src/lib/syncEngine.ts` | Port from Rust behavior. | Current mock lacks several production fields and semantics. | `not started` |
| `apply_sync_delta_v2_impl` | Applies server delta, writes/deletes/conflicts, sets mtimes, suppresses watcher, updates index. | `src/lib/syncEngine.ts` | Port; keep `fs_set_mtime` shim. | Must suppress watcher before writes and repair timestamps for unchanged files. | `not started` |
| `core_prepare_sync_payload_v2` | Tauri command wrapper around sync prep. | None after port. | Delete after `syncServiceV2` imports TS engine. | Keep tests equivalent to Rust `_impl` tests. | `not started` |
| `core_apply_sync_delta_v2` | Tauri command wrapper around sync apply. | None after port. | Delete after `syncServiceV2` imports TS engine. | Needs watcher/index coordination in TS. | `not started` |

## Supersearch and Local Vector Artifacts

These are Tauri-local vector artifact functions. Current visible search also uses `src/lib/serverSearch.ts` over HTTP; do not remove that accidentally when deleting this layer.

| Function | What it does | TS destination | Migration approach | Gotchas | Status |
|---|---|---|---|---|---|
| `load_vector_artifacts_from_disk` | Loads and validates `.supersearch-manifest.json` and vector binary. | None unless local vector search survives. | Delete with local artifacts or port to TS binary parser. | Potential stale files remain. | `delete with feature removal` |
| `ensure_vectors_loaded` | Caches loaded vector artifacts in Rust state. | None unless local vector search survives. | Delete with local artifacts. | Remove `vectors` from `CoreState`. | `delete with feature removal` |
| `load_supersearch_meta` | Reads `.supersearch-state.json`. | None unless local vector search survives. | Delete with local artifacts. | Separate from server search config. | `delete with feature removal` |
| `dot_product_unrolled` | Optimized vector dot product. | None or TS vector utility. | Delete if vector artifacts removed. | Performance only matters if local vectors remain. | `delete with feature removal` |
| `should_replace_min_score` | Tie-break logic for vector top-k heap. | None or TS vector utility. | Delete if vector artifacts removed. | Preserve stable ordering if ported. | `delete with feature removal` |
| `push_top_score` | Maintains bounded min-heap of vector hits. | None or TS vector utility. | Delete if vector artifacts removed. | JS heap implementation needed only if ported. | `delete with feature removal` |
| `vector_search_impl` | Runs top-k vector search and returns chunk rows. | None or TS vector module. | Delete if vector artifacts removed. | Could be expensive on main thread if ported. | `delete with feature removal` |

## Filesystem, Images, Watcher, and Config Helpers

| Function | What it does | TS destination | Migration approach | Gotchas | Status |
|---|---|---|---|---|---|
| `map_notify_event` | Converts Rust notify events to `add/change/unlink`. | `src/lib/platform/tauriWatcher.ts` | Port mapping from plugin-fs event shapes. | Event names and duplicate events may differ. | `not started` |
| `is_image_filename` | Checks allowed image extensions. | `src/lib/images.ts` | Port. | Keep extension list consistent with picker and save. | `not started` |
| `validate_image_ext` | Validates user/source image extension. | `src/lib/images.ts` | Port. | Reject traversal and unsupported formats. | `not started` |
| `write_image_to_notes` | Generates unique image filename and writes bytes. | `src/lib/images.ts` or keep for clipboard paste | Keep Rust copy for clipboard paste; port for JS save paths. | Filename generation may need collision resistance. | `not started` |
| `list_image_files_impl` | Lists image files with metadata and sort. | `src/lib/images.ts` | Port using plugin-fs. | Size/mtime availability on mobile. | `not started` |
| `delete_image_file_impl` | Validates image filename and deletes it. | `src/lib/images.ts` | Port. | Current delete errors if missing. | `not started` |
| `rand_suffix` | Generates random suffix for image filenames. | `src/lib/images.ts` or kept for clipboard paste | Keep Rust copy for clipboard paste; TS can use `crypto.getRandomValues`. | Filename length and collision behavior. | `not started` |

## Engagement Helpers

| Function | What it does | TS destination | Migration approach | Gotchas | Status |
|---|---|---|---|---|---|
| `ensure_engagement_loaded` | Lazily loads `.engagement-v1.json` into Rust state. | `src/lib/engagement.ts` | Delete once TS path is sole path. | TS appdata location must match Rust. | `mostly moved` |

## `stonefruit-core` Helpers Imported by Tauri Client

These are not Tauri commands, but they are part of the client Rust dependency cost today.

| Helper | Current Tauri use | TS destination | Migration approach | Gotchas | Status |
|---|---|---|---|---|---|
| `ensure_safe_note_id` | Note path validation and image path hack. | `src/lib/platform/pathSafety.ts` | Port exactly or delegate to shared filename validation where semantics match. | It rejects `/`, `\`, `.`, `..`, controls, and forbidden filename chars, but allows whitespace-only IDs. | `not started` |
| `safe_note_path` | Builds `base/{id}.md` after validation. | `src/lib/platform/pathSafety.ts` | Port. | Do not transform title/filename casing. | `not started` |
| `safe_appdata_path` | Joins relative path under notes root while blocking traversal. | `src/lib/platform/pathSafety.ts` | Port. | Allows normal nested relative paths; rejects root/prefix/parent. | `not started` |
| `file_mtime_ms` | Converts metadata modified time to ms. | `src/lib/platform/tauri.ts` | Use plugin-fs `stat` modified time conversion. | Missing/invalid mtime fallback currently uses `now_ms`. | `not started` |
| `set_file_mtime_ms` | Sets filesystem mtime in ms. | Thin Rust `fs_set_mtime` | Keep as shim unless plugin-fs adds this. | Needed for sync timestamp parity. | `kept as-is` |
| `now_ms` | Current Unix ms. | `Date.now()` | Replace in TS. | Rust fallback returns 0 on clock error; TS does not. | `mostly moved` |
| `write_atomic_text` | Parent mkdir, write temp file, rename. | `src/lib/platform/atomicWrite.ts` | Port. | Temp filename must stay short to avoid 255-byte filename limit. | `not started` |
| `note_id_from_filename` | Strips `.md` and rejects empty IDs. | `src/lib/platform/pathSafety.ts` or notes index utility | Port. | Rust is case-sensitive `.md`; decide whether to keep. | `not started` |
| `hash_sha256` | Sync content hashing. | `src/lib/syncEngine.ts` | Use `crypto.subtle.digest`. | Hex output must match exactly. | `not started` |
| `hash_sha256_bytes` | Binary/blob hash tests and possible server/blob paths. | `src/lib/syncEngine.ts` if needed | Use `crypto.subtle.digest` on `Uint8Array`. | Keep byte-for-byte hash parity. | `not started` |

## `stonefruit-core` Helpers Not Imported by Tauri Client

These appear in the same `stonefruit-core` modules inspected for this ledger, but they are not currently imported by the Tauri client. Removing the client dependency on `stonefruit-core` does not imply deleting these globally; the server and CLI may still need them.

| Helper | Current client role | Migration approach | Gotchas | Status |
|---|---|---|---|---|
| `is_forbidden_char` | None; private helper behind Rust title/path validation. | No client action unless porting Rust validation tests into TS. | Keep TS and Rust filename semantics aligned while server still exists. | `kept as-is` |
| `contains_forbidden` | None; private helper behind Rust title/path validation. | No client action unless porting validation tests. | Same as above. | `kept as-is` |
| `sanitize_title` | None in Tauri client; TS uses `sanitizeTitle` from `@futo-notes/shared`. | No client action. | Do not reintroduce title transformations in note IDs. | `kept as-is` |
| `validate_title` | None in Tauri client; TS uses shared validation. | No client action. | Shared package remains the client source of truth. | `kept as-is` |
| `is_valid_title` | None in Tauri client. | No client action. | Server/CLI may still use it. | `kept as-is` |
| `mtime_or_now` | None in Tauri client command code. | No client action. | Sync TS code should make its own sentinel behavior explicit. | `kept as-is` |
| `get_unique_note_id` | None in Tauri client; TS has `getUniqueNoteId`. | No client action. | If server/CLI remains, do not delete from crate casually. | `kept as-is` |

## State to Remove or Replace

| Rust state/type | What it owns | TS replacement | Removal condition | Status |
|---|---|---|---|---|
| `CoreState.index` | Rust note preview/search index. | `notesCache` plus `searchIndex.ts`/new `notesIndex.ts`. | Remove after note listing/search/sync apply no longer touch Rust index. | `not started` |
| `CoreState.watcher` | Native file watcher handle. | `tauriWatcher.ts` or keep Rust. | Remove only after plugin-fs watcher parity. | `not started` |
| `CoreState.suppressed_watcher_events` | Per-file watcher suppression during sync writes. | `tauriWatcher.ts` module state. | Remove after TS sync apply uses TS watcher suppression. | `not started` |
| `CoreState.sync_writes_until` | Bulk watcher suppression window during sync. | `tauriWatcher.ts` module state. | Remove after TS sync apply and watcher parity. | `not started` |
| `CoreState.vectors` | Cached local supersearch artifacts. | None if local vector feature removed. | Remove with local vector commands. | `delete with feature removal` |
| `CoreState.engagement` | Rust engagement cache. | `engagement.ts` cache. | Remove after engagement Rust branch is deleted. | `mostly moved` |
| `CoreState.supersearch_meta` | Cached local supersearch metadata. | None if local vector feature removed. | Remove with local vector commands. | `delete with feature removal` |
| `SearchIndexState` | Rust loaded/bodies-loaded flags and indexed notes. | `notesIndex.ts`/`searchIndex.ts`. | Remove after core search commands are gone. | `not started` |
| `EngagementState` | Rust loaded/dirty engagement state. | `engagement.ts`. | Remove after engagement commands are gone. | `mostly moved` |
| `VectorArtifacts` and manifest types | Local vector artifact cache. | None or TS local vector module. | Remove if local vector artifacts are deleted. | `delete with feature removal` |

## Minimum Parity Test Matrix

| Area | Tests before deleting Rust |
|---|---|
| Path safety | Reject traversal, root paths, path separators, controls, forbidden filename characters, and unsafe appdata paths. |
| Atomic writes | Parent dir creation, overwrite, temp filename length, failed write leaves old file intact where feasible. |
| Notes listing | `.md` filtering, mtime sort, `.txt` conversion, collisions like `x.txt` plus `x.md`. |
| Search/index | Preview cache hit/miss/delete/new behavior, body backfill, headings, tags, snippets, empty search, fuzzy/prefix behavior if MiniSearch remains. |
| Engagement | Load missing/invalid file, track open/edit, remove, rename, delayed flush, explicit flush. |
| Sync prep | Full scan, dirty-only upsert, dirty-only delete, hash cache hit/miss, new/changed/deleted classification, baseline hashes, deleted baselines, last version. |
| Sync apply | Delete/update/conflict writes, mtime setting, timestamp repair for unchanged files, watcher suppression, active-note/cache/index refresh. |
| Watcher | External create/edit/delete, temp-file atomic writes, duplicate event tolerance, sync writes do not loop, desktop and Android at minimum. |
| Images | Save picked file, save bytes, paste clipboard image, image URL display, list sort, delete, traversal rejection. |
| Config | Default notes dir, custom notes dir, reset to default, sidebar width persistence across restart. |

## First PR Candidates

| Candidate | Scope | Why it is safe |
|---|---|---|
| Engagement Rust branch removal | `src/lib/engagement.ts`, `src/lib/rustCore.ts`, Rust engagement commands/state | TS path already duplicates behavior. Add tests first. |
| App version/platform cleanup | `getAppVersion`, `app_get_version`, `app_get_platform` | Tauri JS API or existing TS constant covers this. |
| Tauri-local supersearch dead-code check | `PlatformFS` supersearch methods and commands | Current direct callers appear limited to platform wrapper, but confirm product decision first. |
| Path safety and atomic write TS modules | New TS modules only | Enables later migration without changing behavior yet. |
