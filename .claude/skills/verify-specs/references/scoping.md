# Scoping a run from a diff

For a scoped `/verify-specs` (e.g. "since the last tagged release"), turn a set
of changed files into `{ surfaces, platforms }`. Prefer the spec's own
authority refs over guessing.

## Surfaces — use the spec's `→ path` refs first

Every `docs/spec/*.md` line cites the source it governs (`→ wikilinkAutocomplete.ts`,
`→ syncServiceE2ee`, …). So the reverse map is a grep: which spec file mentions
a changed file's basename?

```bash
LAST_TAG=$(git describe --tags --abbrev=0)
git diff --name-only "$LAST_TAG"..HEAD | grep -E '\.(ts|svelte|rs|swift|kt)$' | while read -r p; do
  b=$(basename "$p" | sed -E 's/\.(ts|svelte|rs|swift|kt)$//; s/\.test$//; s/\.spec$//')
  grep -lE "$b" docs/spec/*.md 2>/dev/null | xargs -n1 basename 2>/dev/null | sed 's/\.md//'
done | sort | uniq -c | sort -rn
```

The count tells you where the change concentrates; take every surface that
appears. This is exact where the spec names the file.

## Fallback table — files the spec doesn't name by basename

Some source files aren't cited by basename (e.g. `searchEngine.ts`,
`appState.ts`). Map those by path/role:

| Changed path (glob) | Surface(s) |
|---|---|
| `packages/editor/**`, `src/editor-embed/**`, `src/**/*Editor*`, `src/lib/markdownToolbar*`, `src/lib/wikilink*`, `src/lib/iosTapFocus*` | editor |
| `src/**/NoteList*`, `src/**/*List*` (list UI), `crates/futo-notes-model` scan/sort | list, app |
| `src/**/*Sidebar*`, `src/**/*Drawer*`, `src/**/*Nav*` | nav |
| `src/**/*Tab*` | tabs |
| `crates/futo-notes-search`, `src/lib/searchEngine*`, `src/**/*Search*` | search |
| `src/lib/appState*`, `src/lib/appPreferences*`, `src/**/*Settings*` | settings, settings-visual |
| `src/styles/**`, `*.css`, theme tokens | settings-visual (+ whatever surface the component belongs to) |
| `crates/futo-notes-sync`, `src/lib/syncServiceE2ee*`, `src/lib/autoSync*` | sync |
| `src/App.svelte`, startup/scan/`initialized` paths, `src/lib/notes.svelte.ts` | app |

When a change is broad shared infra (`src/lib/rules.ts`, `packages/editor`,
`crates/futo-notes-model|core`, `futo-notes-ffi`) it ships to all consumers —
treat it as touching every surface it plausibly reaches and lean toward
including rather than excluding. Read the diff if unsure; the specs' `→` refs
inside the changed area disambiguate.

## Platforms

Shared code ships to all three apps; platform-specific dirs narrow it:

- `apps/ios/**` changed → **iOS** in scope.
- `apps/android/**` changed → **Android** in scope.
- `apps/tauri/**` changed → **desktop** in scope.
- `src/**`, `packages/**`, `crates/**` changed → **all platforms** (the shared
  web editor + Rust core ship everywhere), subject to `uname -s`
  (Linux has no iOS).
- Editor changes (`packages/editor`, `src/editor-embed`) → all three, because
  the embedded `editor.html` runs inside both native shells.

## Sync mesh

Include the cross-client sync mesh whenever the scope touches `sync`, the
shared Rust core (`crates/futo-notes-core|model|sync`, `futo-notes-ffi`), or
the editor — "a change that syncs wrong is worse than one that renders wrong"
(app-qa). Skip it only for purely presentational, single-surface scopes.

## Turning scope into legs

- One leg per (platform × surface-group). Keep the `/mr-qa` groups (A =
  editor+app, B = list+nav+tabs, C = search+settings+settings-visual+sync) so
  ledger ids stay comparable across runs; drop groups the scope doesn't touch.
- Provision only as many worktrees/devices as the scope needs — a
  single-surface, single-platform scope is one leg in one worktree, no fan-out
  worth the Workflow overhead (just spawn one `app-qa` directly and skip
  Step 3).
