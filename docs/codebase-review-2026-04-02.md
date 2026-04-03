# Stonefruit Codebase Review

**Date:** 2026-04-02

This review is intentionally narrow. It only keeps issues with clear user-facing benefit and cuts broader cleanup that is mostly about code organization.

## Scope

The only items worth pursuing from the original review are:

1. `liveMarkdownTransform` hot-path fixes
2. startup/index caching for large vaults
3. `note_id_from_filename` correctness fix
4. filename normalization at search/server boundaries

If a proposed change does not directly support one of those four items, it should be out of scope.

## 1. `liveMarkdownTransform` Hot-Path Fixes

This is the strongest frontend performance opportunity.

### Why it matters

The editor transform plugin is doing expensive work in paths that run during typing, cursor movement, and decoration rebuilds. In large notes, this can show up as input lag, cursor lag, and scroll jank.

### Current issues

- `ensureSyntaxTree(view.state, view.state.doc.length, 200)` is called in multiple hot paths, not just during initial setup.
- `extractHeaderTagBlock(view.state.doc.toString())` does a full-document string materialization during decoration rebuilds.
- Wikilink processing scans `doc.toString()` with regex.
- Inline tag processing also scans `doc.toString()` with regex and recomputes the header tag block boundary.

### Recommendation

- Remove `ensureSyntaxTree` from selection-only rebuild paths.
- Stop materializing the full document string on every rebuild where possible.
- Move wikilink and inline-tag work off the main decoration rebuild path if practical.
- Cache header tag block parsing so it only recomputes on document changes.

### User benefit

Faster typing and smoother editing in long notes.

### Kanban tasks

1. Remove `ensureSyntaxTree` from selection-only `liveMarkdownTransform` rebuild paths
Done when: cursor movement and focus-only updates no longer call `ensureSyntaxTree`, and the editor still renders decorations correctly.

2. Cache header tag block parsing in `liveMarkdownTransform`
Done when: header tag block boundaries are derived from cached document-change state instead of recomputing from `doc.toString()` during every rebuild.

3. Replace full-document wikilink scanning with an incremental approach
Done when: wikilink decorations no longer depend on regex over `doc.toString()` for every rebuild, and wikilink rendering behavior is unchanged.

4. Replace full-document inline tag scanning with an incremental or cached approach
Done when: inline tag decorations no longer rescan the full document on every rebuild, and header tag block exclusions still work correctly.

5. Add regression coverage for `liveMarkdownTransform` performance-sensitive behavior
Done when: tests cover decoration correctness for wikilinks/tags and guard against the specific hot-path regressions being fixed.

## 2. Startup / Index Caching For Large Vaults

This is the biggest likely startup-time win for users with large note collections.

### Why it matters

Startup currently rebuilds the Rust note index by scanning and reading every markdown file. That is simple and correct, but it does unnecessary work when most files have not changed since the last launch.

### Current issues

- `initNotes()` calls the Rust rebuild path on startup.
- `core_rebuild_index` calls `scan_notes`.
- `scan_notes` reads every note file and rebuilds previews/tags/indexed data from scratch.

### Recommendation

- Add an mtime-based cache for note metadata used at startup.
- Stat files first, then only re-read files whose mtime changed.
- Reuse cached preview/tag metadata for unchanged files.
- Keep full search/index data lazy where possible instead of rebuilding everything at app launch.

### User benefit

Much faster cold startup for large vaults, especially users with thousands of notes.

### Kanban tasks

1. Add a persisted mtime-based startup metadata cache for indexed note previews
Done when: cached metadata can be loaded from disk and keyed by filename plus mtime.

2. Reuse cached preview/tag metadata for unchanged files during `core_rebuild_index`
Done when: startup only re-reads note bodies for changed files and still produces the same preview payload shape.

3. Keep full search/index data lazy during startup where possible
Done when: app launch does not eagerly rebuild more indexed content than is needed to show the initial note list.

4. Add Rust tests for startup cache correctness
Done when: tests cover unchanged files, changed files, added files, deleted files, and cache invalidation behavior.

## 3. `note_id_from_filename` Correctness Fix

This is small but should be fixed because it is a real correctness bug.

### Current issue

`note_id_from_filename` uses `trim_end_matches(".md")`, which strips repeated trailing `.md` suffixes. That means a filename like `note.md.md` is treated as `note` instead of `note.md`.

### Recommendation

- Replace `trim_end_matches(".md")` with `strip_suffix(".md")`.
- Update tests to reflect the correct single-suffix behavior.

### User benefit

Prevents surprising filename collisions and makes filename handling match actual on-disk data.

### Kanban tasks

1. Fix `note_id_from_filename` to strip only a single `.md` suffix
Done when: `note.md.md` resolves to `note.md`, not `note`.

2. Update Rust tests for double-suffix filename handling
Done when: existing adversarial tests reflect the corrected behavior and pass.

## 4. Filename Normalization At Search / Server Boundaries

This is worth fixing because the current mapping logic is compensating for an inconsistent boundary contract.

### Current issue

Client search result mapping currently works around inconsistent filename formats by checking multiple shapes, including `.md`, `.md.md`, and bare IDs.

### Recommendation

- Normalize filenames once at the boundary where server results enter the client.
- Use one canonical representation internally.
- Remove scattered suffix-repair logic once the boundary contract is clean.

### User benefit

More reliable search result mapping and less chance of edge-case mismatches between client and server note identifiers.

### Kanban tasks

1. Define one canonical filename format for client/server search boundaries
Done when: the expected representation is documented in code and used consistently at the boundary.

2. Normalize server search result filenames at the client boundary
Done when: search result mapping converts incoming filenames to the canonical form before note lookup.

3. Remove `.md.md` fallback mapping and related suffix-repair workarounds
Done when: client search mapping no longer depends on multi-shape fallback keys for the same note.

4. Add regression tests for search/server filename normalization
Done when: tests cover `.md`, bare-id, and malformed/double-suffix inputs and verify stable note lookup behavior.

## Priority

1. `liveMarkdownTransform` hot-path fixes
2. startup/index caching for large vaults
3. `note_id_from_filename` correctness fix
4. filename normalization at search/server boundaries
