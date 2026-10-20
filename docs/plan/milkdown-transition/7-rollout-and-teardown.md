## 7. Rollout and teardown

1. **Dogfood gate**: dev builds (`com.futo.notes.dev`) on Justin's phone, the old Android phone,
   and desktop, against a copy of his real vault, for real writing over days–weeks. This is also
   the de-facto IME exposure (D8) and the normalize-once shakedown on notes he cares about.
2. **Release**: simultaneous three-platform big-bang. Mixed-fleet window is safe by construction:
   CM6 never rewrites bytes, so normalization flows one way and settles; no ping-pong.
3. **Teardown, same MR chain as the CM6 deletion** (not before, not lingering): CM6 editor path,
   `liveMarkdownTransform`, CM6 scroll compensation, the gauntlet's CodeMirror leg
   (`tests/editor-gauntlet/cm6Adapter.ts` and `tests/editor-gauntlet/driver/`, plus the `gauntlet-cm6*`
   recipes), the markdown-spec harness (mine its cases into plugin tests first). The editor gauntlet
   **stays** as the regression suite, with tier-3 byte-diff assertions relaxed to loss-only per
   ADR-0002. The factory/Obsidian judge harness was already deleted ahead of this on main
   (docs/learnings/factory-obsidian-judge.md).
4. The P1 intent compiler (bake-off graduate, never merged) is not productionized; bake-off §12
   items are void.

### Swap and teardown outcome (#111, done)

Steps 2 and 3 landed on branch `feat/milkdown-editor` as three commits: `ea65cf5a` (the swap plus
the CM6 deletion), `569ba4c6` (the markdown-spec harness), `dcac3010` (the gauntlet's CodeMirror
leg). One engine, one plugin set, all three surfaces.

- **Desktop mounts `MilkdownEditor.svelte`.** It was the last surface still on CM6 — both native
  shells already ran Milkdown through `editor.html` — so the `editor.html?cm` engine switch is gone
  and the CodeMirror editor is deleted, ~7,600 lines of `src/`: `MarkdownEditor.svelte`,
  `liveMarkdownTransform` + `live-preview/**`, `interactions/**`, `table/**`, `toolbar/**`,
  `editorUX/**`, `noteHistory`, and every co-located test. `codeFenceLanguages.ts` stays, and with
  it the `@codemirror/lang-*` grammars the fence highlighter still renders through, as do
  `imagePasteSink.ts`, `wikilinkSuggestions.ts`, `NoteTagBar.svelte` and `keyboard.svelte.ts`.
- **`EditorApi` is engine-neutral now.** It loses `getView`, `setCaret`, `retargetOpenNote`,
  `forgetNoteHistory`, `blur` and `setContent`'s CodeMirror options object; it gains `applyEdit`,
  `insertMarkdown`, `contentElement` and `placeCaretAtCoords`. Per-note undo history is GONE —
  `prosemirror-history` has no equivalent of the serialized-state stash `noteHistory.ts` kept — so
  `openNote` clears the stack instead. The data-safety half survives and is still tested (undo
  after a note switch cannot replay the previous note's steps into this file); the convenience half
  is recorded as a Gap in `docs/spec/editor.md`.
- **The markdown-spec harness is deleted, its cases mined rather than ported**, as §7.3 said.
  `markdown-spec/` and `tests/markdown-spec.spec.ts` are gone, and with them the
  `test-markdown-spec` recipe and its `pnpm` script — do not reach for them. The structural
  coverage lives in `tests/editor-gauntlet/` and `tests/editor-embed-milkdown*`; the
  cursor-reveal/marker-hidden cases describe behavior a WYSIWYG editor does not have.
- **The gauntlet stays; its second adapter does not.** `cm6Adapter.ts`, the three specs that
  instantiated it, the `window.__driver` installer under `driver/`, and the `gauntlet-cm6*` recipes
  are gone. `just gauntlet-milkdown`, `just gauntlet-milkdown-perf` and
  `just gauntlet-milkdown-foreign` are the surviving legs.
- **Drift registry**: `toolbar-block-transitions` and `editor-ime-attributes` are deleted, not
  trimmed — both were CM6-copy/Milkdown-copy pairs, and one copy is not a drift pair. The
  `editor-perf-floor-fixture` entry stays: it is between the desktop harness and the Android device
  runner, not between engines.

The editor's verification chain is therefore `pnpm run test:e2e:editor-embed` (the
`editor-embed-milkdown*` family, driving the same single-file `editor.html` the native shells
ship), `just gauntlet-milkdown`, `just gauntlet-milkdown-perf`, and the desktop Playwright suite.
Selectors are `.futo-milkdown` (the mount) and `.ProseMirror` (the editable element).
