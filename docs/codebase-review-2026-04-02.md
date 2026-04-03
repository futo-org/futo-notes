# Stonefruit Codebase Review

**Date:** 2026-04-02
**Reviewer:** Claude Opus 4.6 (full codebase in context — 266 files, 50K lines)

## Executive Summary

This is a well-architected offline-first notes app with a clean separation between platforms, a solid sync protocol, and a thoughtful test suite. The Rust backend is particularly strong. The frontend has grown organically and has accumulated complexity that can be reduced. The biggest opportunities are in the sync client stack, the editor plugin, and the component decomposition.

---

## 1. Architecture: What's Working Well

**The Rust core crate is the best part of this codebase.** `stonefruit-core` is cleanly factored — files, hash, sync, merge, graph, search, invariants — each module has a single job and is independently testable. The server imports it directly, the Tauri app imports it directly, nobody reimplements what core provides. This is the right pattern.

**The sync protocol is sound.** V2 inventory-based sync with SHA-256 content hashing, three-way merge via `diffy`, conflict copy generation, device snapshots, rename detection via hash matching — this is a production-grade sync engine. The property-based tests in `proptest_sync.rs` (convergence, idempotency, invariant stability) give real confidence.

**Platform abstraction is clean.** `PlatformFS` interface with `tauri.ts` and `web.ts` implementations, `__mocks__/index.ts` for tests with `createNodeFS()` — components never branch on platform. The `nodeFS` contract test suite ensures implementations stay compatible.

**The cross-platform sync test harness is impressive.** Real Tauri binaries, real servers, MCP bridge WebSocket control, Android emulator support, 12 scenarios covering editor roundtrip, three-way merge, rename propagation, draft protection during sync, external watcher behavior. This is rare for a project this size.

---

## 2. Structural Weaknesses

### 2a. `NotesShell.svelte` is a god component

At ~600 lines of script, `NotesShell` is the orchestration hub for the entire app. It owns:
- Drawer state (open/close/progress/swipe)
- Note selection and navigation
- Editor focus management
- Settings screen lifecycle
- Search popup lifecycle
- Graph sidebar lifecycle
- Note menu (three-dot dropdown)
- Delete confirmation dialog
- Toast notifications
- Keyboard inset compensation
- Sync manager wiring
- Note session wiring
- File watcher delegation
- Global keyboard shortcuts
- Tauri-specific lifecycle (close handler, menu actions)

You extracted `syncManager.svelte.ts` and `noteSession.svelte.ts` — good instincts. But the shell still has too many responsibilities. The template is a flat list of `{#if}` blocks for settings, delete confirm, search, toast, graph fullscreen — each with its own state variables.

**Recommendation:** Extract `DrawerController`, `NoteMenuController`, and `KeyboardInsetController` as Svelte 5 rune-based state objects (same pattern as `createSyncManager`). The shell should be ~200 lines of wiring, not 600.

### 2b. The `liveMarkdownTransform.ts` plugin is monolithic

This is a single 900-line file containing:
- 8 widget classes (HorizontalRule, HiddenMarker, TaskCheckbox, Image, Bullet, Number, Table implied)
- Image preloading and caching
- The main `LiveMarkdownPlugin` class with `buildDecorations`
- 12 `process*` methods for each markdown element
- Wikilink processing
- Inline tag processing
- All the reveal/cursor-line logic
- Exported test helpers

The `buildDecorations` method calls `doc.toString()` for wikilink regex scanning and header tag extraction on every rebuild. For a 50KB note, this allocates and scans the full string multiple times per keystroke.

**Recommendation:**
1. Extract widgets into `widgets/` directory (one file per widget class)
2. Extract `processWikilinks` and `processInlineTags` into standalone ViewPlugins that maintain their own DecorationSets — they don't need to rebuild on every syntax tree change
3. Cache the `extractHeaderTagBlock` result in a StateField (it only changes on doc change, not on cursor move)
4. For wikilinks, use a MatchDecorator (like you already do for autolinks) instead of regex over `doc.toString()`

### 2c. Dual state systems: `appState.ts` and `appState` facades

`appState.ts` has a unified `AppState` type but then provides three separate facade APIs:
- `loadPreferences()` / `getCachedPreferences()` / `savePreferences()` — returns `AppPreferences`
- `loadV2SyncState()` / `saveV2SyncState()` — returns `V2SyncState`
- `loadAppState()` / `getAppState()` / `saveAppState()` / `updateAppState()` — returns `AppState`

Components and libraries pick whichever API is convenient, leading to:
- `syncServiceV2.ts` reads `getCachedPreferences()` for server URL/token
- `syncManager.svelte.ts` imports from both `notes` and `appState`
- `authFetch.ts` reads `getCachedPreferences()` for server URL/token
- `testSync.ts` uses `getAppState()` directly

The migration code from legacy files (`.preferences.json`, `.sync-state-v2.json`) is still active — this is good for existing users but adds ~80 lines of code that will eventually be dead weight.

**Recommendation:** Pick one API surface. `getAppState()` + `updateAppState()` should be the only public interface. The `Preferences` and `V2SyncState` types are just views — make them computed getters, not separate load/save paths.

---

## 3. Performance Concerns

### 3a. `ensureSyntaxTree` with timeout on every decoration rebuild

```typescript
ensureSyntaxTree(view.state, view.state.doc.length, 200);
```

This appears in `LiveMarkdownPlugin.constructor`, `buildDecorations`, `update`, and `scheduleParseRefresh`. For large documents, this blocks the main thread for up to 200ms per call. The scroll-fix handoff report (`docs/scroll-fix-handoff-report.md`) already flagged the 5000ms variant as P0 — you reduced it to 200ms, but it's still called on every cursor-line change.

**Recommendation:** Call `ensureSyntaxTree` only once in the constructor (or on doc change), not on every selection change. For cursor-line-only rebuilds, the tree is already parsed — you're paying for a no-op that still has overhead.

### 3b. `doc.toString()` in hot paths

`liveMarkdownTransform.ts` calls `view.state.doc.toString()` in:
- `processWikilinks` (regex scan over full doc)
- `processInlineTags` (regex scan over full doc)
- `buildDecorations` (for `extractHeaderTagBlock`)

`editorContentSync.ts`'s `docMatchesText` avoids `toString()` with clever probe sampling — apply the same thinking to the transform plugin. Use `doc.sliceString()` with line iterators instead of full materialization.

### 3c. Search index persistence

`searchIndex.ts` serializes the entire MiniSearch index to JSON and writes it as `.search-index-v1.json`. For a vault with 1000+ notes, this can be several MB. It's written on every `persistIndex()` call. Since the Rust core now handles keyword search (`keywordSearchRust`), the MiniSearch index is only used for wikilink autocomplete. Consider whether it's still worth persisting.

### 3d. Startup reads every file unconditionally

`initNotes()` calls `rebuildRustIndex()` → `core_rebuild_index` → `scan_notes()`, which reads every `.md` file in the vault on every launch. For 2400 notes this takes ~6s. Most of that time is spent in `fs::read_to_string` + `build_indexed_note` (headings, tags, preview extraction) — work that's wasted when files haven't changed since the last launch.

The fix is an mtime-based file cache (`.file-cache.json`) that stores `{mtime, hash, preview, tags}` per file. On startup, `stat()` all files (~50ms), only read the ones whose mtime changed, and return cached previews for the rest. The full search index (`IndexedNote` with lowercase body, headings map) is built lazily on first search, not at startup.

This also subsumes the `hashCache` currently shuttled between TS and Rust via `V2SyncState` (see 2c). Moving hash ownership entirely into Rust eliminates the `hashCache` field from `AppState`, `V2SyncState`, `saveV2SyncState`, `clearV2SyncState`, and `testSync.clearServerScopedState` — a meaningful reduction in the sync client complexity flagged in 4b.

### 3e. Image preloading

`preloadImages` scans the full markdown text with a regex on every `setContent` call. For notes with many images, this fires network requests eagerly. The `imageSizeCache` is unbounded and never evicted. This was flagged in the scroll-fix report but not addressed.

---

## 4. Simplification Opportunities

### 4a. The `searchIndex.ts` module may be redundant

With `hasRustCore()` returning true on all Tauri platforms, the only caller of `searchNotes()` from `searchIndex.ts` is `wikilinkAutocomplete.ts`. The Rust keyword search (`core_keyword_search`) is more capable (title boost, heading boost, recency boost). Consider routing wikilink autocomplete through the Rust search and dropping the MiniSearch dependency entirely.

### 4b. `writeSuppression.ts` + `watcherBatch.ts` + `syncCoordinator.ts` + `syncManager.svelte.ts`

The sync coordination stack has four layers:
1. `writeSuppression.ts` — tracks recent local/sync writes to suppress watcher echo
2. `watcherBatch.ts` — debounces, deduplicates, and bulk-refreshes watcher events
3. `syncCoordinator.ts` — connects autoSync callbacks to watcher batch, tracks sync-vs-edit version
4. `syncManager.svelte.ts` — owns reactive state, wires everything to the session

Each is independently tested (good), but the layering means a single watcher event passes through 4 modules before reaching the UI. The `drainPostSync` -> `onBulkRefresh` -> `refreshNotesFromStorage` -> `deps.refreshNotesList` chain is hard to trace.

**Recommendation:** Merge `writeSuppression` into `watcherBatch` (it's the only consumer). Merge `syncCoordinator` into `syncManager` (the "coordinator" adds one function: `shouldDeferSync`, which is 3 lines). This reduces the stack from 4 modules to 2 without losing testability.

### 4c. `serverSearch.ts` + `searchIndex.ts` + `notes.ts` search

There are three search paths:
1. `notes.ts` -> `search()` / `searchKeyword()` -> `keywordSearchRust()` (Tauri)
2. `searchIndex.ts` -> MiniSearch (wikilink autocomplete only)
3. `serverSearch.ts` -> `fetchServerSearchResults()` (hybrid keyword+vector from server)

`SearchPopup.svelte` uses paths 1 and 3, fusing results via `fuseConnectedSearchResults`. This works but means the search popup maintains two independent result lists, two debounce timers, and two loading states.

**Recommendation:** Unify by having `searchKeyword` always go through Rust, drop MiniSearch for autocomplete (use Rust instead), and have the search popup call one function that returns `{ local: results[], server: results[] | null }`.

### 4d. Two CSS files for one visual system

`components.css` (700+ lines) and `markdown.css` (200+ lines) are both in `@layer(components)`. The components file contains layout for every component in the app — sidebar, drawer, FAB, toolbar, search, settings, graph, delete dialog, toast, tag bar, image gallery. The markdown file is just CodeMirror decoration styles.

**Recommendation:** Split `components.css` into per-component CSS. Svelte supports `<style>` blocks — the inline styles in `DrawerSidebar.svelte`, `GraphSidebarPanel.svelte`, etc. are already partially there. Move the remaining global styles into the components that own them.

### 4e. Engagement tracking is duplicated

`engagement.ts` has two code paths for every operation: one for `hasRustCore()` (calls Rust then updates local cache) and one without (updates local cache then writes JSON). The non-Rust path is only used in web dev mode, where engagement data doesn't persist anyway. You could simplify by making the Rust path the only path and stubbing it in tests.

---

## 5. Correctness Issues

### 5a. `note_id_from_filename` is greedy

```rust
pub fn note_id_from_filename(name: &str) -> Option<String> {
    if !name.ends_with(".md") { return None; }
    let id = name.trim_end_matches(".md").to_string();
    // ...
}
```

`trim_end_matches(".md")` strips *all* trailing `.md` suffixes. `"note.md.md"` becomes `"note"`, not `"note.md"`. This is documented in tests as "known behavior" but it means a file literally named `note.md.md` on disk would collide with `note.md`. Use `strip_suffix(".md")` instead of `trim_end_matches`.

### 5b. `serverSearch.ts` filename mapping is fragile

```typescript
notesByFilename.set(`${note.id}.md`, note);
notesByFilename.set(`${note.id}.md.md`, note);
notesByFilename.set(note.id, note);
```

This triple-mapping is a workaround for the server returning filenames with inconsistent `.md` suffixes. The root cause is that the server stores filenames as `note.md` but the client's note IDs strip the extension. Fix the mapping at the boundary (server response normalization) rather than scattering `.md.md` handling across `serverSearch.ts`, `graphData.ts`, and `syncServiceV2.ts`.

### 5c. `sanitizeUrl` in `tableWidget.ts` decodes HTML entities before checking

The function tries to decode `&amp;`, `&lt;`, etc. before checking for `javascript:`. But `escapeHtml` already runs before `sanitizeUrl` is called (inside `renderInlineMarkdown`). This means the decoded string is checked, but the *original* (already-escaped) string is returned. If an attacker could get `javascript:` past the HTML escaping (they can't, because `escapeHtml` would turn `:` into... well, `:` isn't escaped). The logic is correct but the decoding step is unnecessary and confusing.

---

## 6. Testing Gaps

### 6a. No unit tests for `syncManager.svelte.ts`

This is the most complex coordination module in the frontend. It handles:
- `handleSyncComplete` with rename tracking, content reload, draft protection
- `handleSingleWatcherEvent` with suppression, draft protection, external rescan
- Auto-sync lifecycle start/stop

It's only tested via the cross-platform integration tests (real Tauri binaries). A unit test with mocked dependencies would catch regressions faster.

### 6b. No tests for `liveMarkdownTransform.ts` decoration correctness

The Playwright tests check that `.cm-md-h1` exists, but they don't verify the *positions* of decorations. A decoration that starts one character too early or late is visually wrong but passes the "class exists" check. The `liveMarkdownTransform.reveal.test.ts` tests the reveal helpers but not the actual decoration building.

### 6c. No performance benchmarks

The `sync_10k.rs` test verifies correctness for 10K notes but doesn't measure latency. The `docs/testing-roadmap.md` mentions "stress & performance testing" as medium-term — this should be promoted. A regression where sync takes 30s instead of 3s would not be caught by any current test.

---

## 7. Dependency Observations

- **CodeMirror pinning is critical.** The `editorInit.test.ts` and `markdownRendering.test.ts` tests exist specifically because pnpm can hoist duplicate `@codemirror/state` copies. The exact version pins in `package.json` (`"6.6.0"`, `"6.40.0"`) are correct — don't change these to `^` ranges.

- **`force-graph` is 240KB gzipped** for a feature (semantic graph) that's optional and lazy-loaded. Good that it's behind dynamic `import()` in `GraphSidebarPanel`. Keep it that way.

- **`minisearch` may be droppable** if wikilink autocomplete moves to Rust (see 4a above). That's one fewer JS dependency.

- **The `diffy` crate** for three-way merge is simple and correct. No concerns.

---

## 8. Priority Recommendations

| Priority | Change | Impact |
|---|---|---|
| **High** | Extract wikilink/tag processing from `liveMarkdownTransform` into separate ViewPlugins | Eliminates `doc.toString()` on every cursor move |
| **High** | Cache `extractHeaderTagBlock` result in a StateField | Eliminates redundant full-doc scan per rebuild |
| **High** | Remove `ensureSyntaxTree` from non-constructor paths | Reduces main-thread blocking on large notes |
| **High** | Unified file cache for startup (mtime-based `.file-cache.json`, lazy search index) | Startup from ~6s to ~200ms for 2400 notes; eliminates `hashCache` TS↔Rust shuttling |
| **Medium** | Decompose `NotesShell.svelte` into smaller controllers | Reduces cognitive load, easier to modify |
| **Medium** | Unify `appState.ts` API surface | Eliminates confusion between 3 accessor patterns |
| **Medium** | Merge `writeSuppression` into `watcherBatch`, `syncCoordinator` into `syncManager` | Reduces sync coordination from 4 modules to 2 |
| **Medium** | Fix `note_id_from_filename` to use `strip_suffix` | Prevents `.md.md` collision bug |
| **Medium** | Add unit tests for `syncManager.svelte.ts` | Catches coordination regressions without full E2E |
| **Low** | Drop MiniSearch in favor of Rust keyword search for autocomplete | Removes a dependency, simplifies search paths |
| **Low** | Bound the `imageSizeCache` | Prevents unbounded memory growth |
| **Low** | Split `components.css` into per-component styles | Better locality, easier maintenance |

---

## 9. What I Would Not Change

- The sync protocol. It's correct, well-tested, and handles edge cases (rename detection, three-way merge, lost state recovery, convergence detection).
- The platform abstraction layer. It's clean and well-tested.
- The Rust core crate factoring. It's the gold standard for this codebase.
- The cross-platform test harness. It's thorough and catches real bugs.
- The AGENTS.md / CLAUDE.md documentation. It's detailed and accurate.
- The `editorContentSync.ts` minimal-diff algorithm. It's clever, correct, and avoids `toString()`.

---

## 10. Implementation Chunks

Work from this review is grouped into six chunks, sequenced by impact and dependency. Each chunk is independently shippable.

**Recommended order: 1 → 2 → 5 → 3 → 4 → 6**

---

### Chunk 1: Startup Performance (File Cache)

**Sections:** 3d, 2c (hashCache portion)

**Scope:**
- New `core_startup_previews` Tauri command backed by mtime-based `.file-cache.json`
- `initNotes()` calls the new command instead of `rebuildRustIndex()`
- `core_get_note_previews` uses cached previews when the search index isn't loaded
- Full search index (`scan_notes()`) deferred to first `core_keyword_search` call
- `hashCache` removed from `V2SyncState`, `AppState`, and all TS sync plumbing — Rust owns it via the file cache
- Migration path: first launch seeds cache from existing `hashCache` in `.app-state.json`
- Watcher invalidates specific cache entries on file change

**Acceptance criteria:**
- [ ] Warm startup (no files changed) completes in < 500ms for 2400 notes
- [ ] Cold startup (no cache file) produces identical note list to current behavior
- [ ] Modifying a note externally and relaunching shows updated preview
- [ ] Deleting a note externally and relaunching removes it from the list
- [ ] First keyword search after startup returns correct results (lazy index loads)
- [ ] Sync works end-to-end without `hashCache` in TS (server test suite passes)
- [ ] `just test` and `just server-test` pass
- [ ] `.app-state.json` no longer contains `hashCache` after first launch on new code

**Dependencies:** None. Can start immediately.

---

### Chunk 2: Editor Hot-Path Performance

**Sections:** 3a, 3b, 2b

**Scope:**
- Remove `ensureSyntaxTree` calls from `update()` and `buildDecorations()` — keep only the constructor call
- Extract `processWikilinks` into a standalone ViewPlugin using `MatchDecorator` instead of `doc.toString()` regex
- Extract `processInlineTags` into a standalone ViewPlugin, same approach
- Cache `extractHeaderTagBlock` result in a `StateField` that only recomputes on doc change
- Extract widget classes from `liveMarkdownTransform.ts` into `src/lib/editor/widgets/` (one file per widget)

**Acceptance criteria:**
- [ ] `liveMarkdownTransform.ts` is under 400 lines (down from 900)
- [ ] No `doc.toString()` calls remain in any decoration rebuild path
- [ ] `ensureSyntaxTree` is called only once per plugin lifecycle (constructor)
- [ ] All existing Playwright markdown spec tests pass (`just test-markdown-spec`)
- [ ] All existing decoration tests pass (`liveMarkdownTransform.reveal.test.ts`)
- [ ] Manual check: open a 50KB note, cursor movement feels responsive (no visible lag)
- [ ] `just build` passes (no missing imports)

**Dependencies:** None. Independent of Chunk 1.

---

### Chunk 5: Correctness Fixes

**Sections:** 5a, 5b

**Scope:**
- Replace `trim_end_matches(".md")` with `strip_suffix(".md")` in `note_id_from_filename`
- Normalize server search response filenames at the boundary (one place) instead of triple-mapping in `serverSearch.ts`, `graphData.ts`, and `syncServiceV2.ts`

**Acceptance criteria:**
- [ ] `note_id_from_filename("note.md.md")` returns `Some("note.md")`, not `Some("note")`
- [ ] Server search results for filenames with `.md` suffix map correctly to local note IDs
- [ ] No `.md.md` triple-mapping workarounds remain in client code
- [ ] `just test` and `just server-test` pass
- [ ] Regression test added for the `.md.md` filename case

**Dependencies:** None. These are small, ship whenever.

---

### Chunk 3: Search Path Unification

**Sections:** 4a, 4c, 3c

**Scope:**
- Route wikilink autocomplete through `core_keyword_search` (Rust) instead of MiniSearch
- Remove `searchIndex.ts` and the `minisearch` dependency
- Remove `.search-index-v1.json` persistence
- Unify `SearchPopup.svelte` to call one function that returns `{ local: results[], server: results[] | null }` instead of managing two independent result lists

**Acceptance criteria:**
- [ ] `minisearch` removed from `package.json`
- [ ] No `searchIndex.ts` file exists
- [ ] `.search-index-v1.json` is no longer written or read
- [ ] Wikilink autocomplete returns results with equivalent quality to current MiniSearch (title matches, recency)
- [ ] `SearchPopup.svelte` has one debounce timer and one loading state, not two
- [ ] `just build` and `just test` pass
- [ ] Manual check: wikilink `[[` autocomplete is responsive (< 100ms)

**Dependencies:** Chunk 1 should land first (lazy search index means `core_keyword_search` triggers a full scan on first call — that's fine, but the behavior should be established before rerouting autocomplete through it).

---

### Chunk 4: Sync Client Simplification

**Sections:** 4b, 6a

**Scope:**
- Add unit tests for `syncManager.svelte.ts` covering: `handleSyncComplete` with renames, content reload, draft protection; `handleSingleWatcherEvent` with suppression and external rescan; auto-sync start/stop
- Merge `writeSuppression.ts` into `watcherBatch.ts` (its only consumer)
- Merge `syncCoordinator.ts` into `syncManager.svelte.ts` (`shouldDeferSync` is 3 lines)
- Sync coordination goes from 4 modules to 2

**Acceptance criteria:**
- [ ] `syncManager.svelte.ts` has unit tests covering the three flows above
- [ ] `writeSuppression.ts` and `syncCoordinator.ts` no longer exist as separate files
- [ ] All existing sync tests pass (`just server-test`, `just test-cross-platform`)
- [ ] No change in sync behavior — this is a pure refactor
- [ ] `just test` passes

**Dependencies:** Write the unit tests *before* merging modules. The tests are the safety net for the refactor.

---

### Chunk 6: Frontend Cleanup

**Sections:** 2a, 4d, 4e, 3e

**Scope:**
- Extract `DrawerController`, `NoteMenuController`, `KeyboardInsetController` from `NotesShell.svelte` as Svelte 5 rune-based state objects
- Move component-specific styles from `components.css` into Svelte `<style>` blocks where components already exist
- Remove non-Rust engagement path (stub in tests)
- Add LRU eviction or max-size bound to `imageSizeCache`

**Acceptance criteria:**
- [ ] `NotesShell.svelte` script section is under 250 lines
- [ ] `components.css` is under 400 lines (down from 700+)
- [ ] `engagement.ts` has no `if (!hasRustCore())` branches
- [ ] `imageSizeCache` has a bounded size (e.g., 500 entries max)
- [ ] `just build` and `just test` pass
- [ ] Manual check: drawer swipe, note menu, keyboard inset behavior unchanged

**Dependencies:** None, but lowest priority. Pick up items opportunistically.
