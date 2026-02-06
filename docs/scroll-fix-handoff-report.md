# Scroll-Fix Branch Handoff Report

Date: 2026-02-06
Branch reviewed: `scroll-fix` vs `main`

## Product constraints from requester

1. Scroll test note generation must be dev-only.
2. "Book-length" notes (very large text notes) must be supported.

## Executive summary

The branch addresses visible scroll jump in the external scroll container setup, but it introduces startup/performance risks that conflict with large-note support and includes dev/test content in production code paths. The P0 items below should be fixed before merge.

## P0 findings (fix before merge)

### 1) Synchronous full-document parsing can block UI on large notes

Severity: High

Evidence:
- `src/lib/liveMarkdownTransform.ts:298` calls `ensureSyntaxTree(view.state, view.state.doc.length, 5000)`.
- `src/lib/tableRenderingField.ts:27` calls `ensureSyntaxTree(state, state.doc.length, 5000)`.
- CodeMirror API docs (local type definitions) state this can spend up to `timeout` ms parsing (`node_modules/@codemirror/language/dist/index.d.ts:185`).

Why this matters:
- For book-length notes, synchronous parsing on open can create long main-thread stalls and poor input responsiveness.
- This directly conflicts with the requirement to support very large text notes.

Suggested fix:
1. Remove startup `ensureSyntaxTree(..., 5000)` calls.
2. Build decorations from current tree immediately (possibly partial).
3. Rebuild decorations incrementally when the tree grows (non-blocking path).
4. Keep/restore asynchronous tree-growth rebuild logic for table replacements (similar to the previous watcher pattern in `main`).
5. Optional hardening: for very large docs, degrade to a lighter render mode (fewer transforms) until idle parsing catches up.

Acceptance criteria:
1. Opening a very large note does not create multi-second UI stalls.
2. First paint and typing remain responsive after note open.
3. Decorations still converge correctly as parsing completes.

Manual repro for regression check:
1. Create/open a note >= 1 MB plain text.
2. Measure responsiveness during open and first scroll.
3. Confirm no visible freeze and no large input lag.

### 2) Scroll test fixtures are included in production runtime path

Severity: High

Evidence:
- `src/components/NotesShell.svelte:10` imports `SCROLL_TEST_NOTES` at module load.
- `src/lib/scrollTestNotes.ts` eagerly constructs a large in-memory dataset.
- Long-press path using this data is reachable in app code (`src/components/NotesShell.svelte:344` to `src/components/NotesShell.svelte:352`).

Why this matters:
- Violates requirement: this should be dev-only.
- Adds unnecessary startup work and memory pressure in production.

Suggested fix:
1. Guard behavior with `import.meta.env.DEV`.
2. Remove top-level import of `SCROLL_TEST_NOTES`.
3. Dynamically import test data only in the dev-only path.
4. Ensure long-press test-note creation is disabled/no-op in production builds.

Acceptance criteria:
1. Production build does not include `scrollTestNotes` module code/data.
2. Long-press test-note creation only works in development.
3. No behavior regression for normal note creation.

### 3) Image preload/cache strategy can cause network, memory, and layout issues

Severity: Medium (escalates to High on low-memory/mobile data conditions)

Evidence:
- Eager preloading is triggered on editor create and on `setContent`:
  - `src/components/MarkdownEditor.svelte:45`
  - `src/components/MarkdownEditor.svelte:127`
- `preloadImages` fetches every markdown image URL (`src/lib/liveMarkdownTransform.ts:105` to `src/lib/liveMarkdownTransform.ts:125`).
- Global cache is unbounded (`src/lib/liveMarkdownTransform.ts:96`).
- Image wrapper uses fixed height and hidden overflow:
  - `src/lib/liveMarkdownTransform.ts:144` / `src/lib/liveMarkdownTransform.ts:166`
  - `src/styles/markdown.css:168`

Why this matters:
- Unbounded cache can grow without limit across note opens.
- Eagerly requesting all image URLs can increase data use and leak requests for images the user never views.
- Fixed wrapper heights can become stale after viewport changes (orientation/resize), causing clipping or whitespace artifacts.

Suggested fix:
1. Avoid global eager preload by default, or cap it aggressively.
2. Add bounded cache (LRU or max-entry cap + eviction).
3. Replace fixed-height wrapper approach with responsive sizing (for example aspect-ratio placeholder + natural image sizing).
4. Recompute or avoid stale fixed heights on resize/orientation change.

Acceptance criteria:
1. Cache size is bounded.
2. No image clipping/blank gaps after viewport size changes.
3. Network requests are proportional to viewed/near-viewed content.

## Tests to add

1. Large-note performance regression test:
   - Open a very large note and assert editor remains interactive quickly.
2. Dev-gating test:
   - Build production and verify `scrollTestNotes` is absent from output bundle.
3. Image resize behavior test:
   - Render image note, change viewport size, assert no clipping/incorrect spacing.
4. Scroll compensation stability test:
   - Scroll long wrapped-content note and verify viewport anchor does not jump on delayed decoration/layout changes.

## Recommended implementation order

1. P0: Remove synchronous full parse and restore non-blocking parse/decorate flow.
2. P0: Dev-gate and lazy-load scroll test fixtures.
3. P1: Fix image preload/cache and responsive wrapper behavior.
4. P1: Add regression tests for large notes and dev/prod gating.

## Validation done during review

1. `npm run build` passed on `scroll-fix`.
2. `npm run lint` passed.
3. `npm test -- tests/markdown-rendering.spec.ts` passed (28/28).

Note: Existing tests do not cover large-note startup performance, dev-only gating, or image-resize correctness.
