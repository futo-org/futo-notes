# Desktop editor parity after the Milkdown swap

Status: OPEN. Written 2026-09-02 on `feat/milkdown-editor` (MR !276), the day after the desktop
app switched from the CodeMirror 6 editor to the Milkdown editor and the CodeMirror code was
deleted (commits `ea65cf5a`..`f7a099ed`; the decision is recorded in
`docs/plan/milkdown-transition.md` §7 and ADR-0002).

This document exists so nothing on this list gets lost. Each item is ALSO an inline `> **Gap:**`
note in `docs/spec/editor.md` (list them with `rg '> \*\*Gap' docs/spec/`); the spec is the
behavioral truth, this is the work list. Strike an item here when its Gap is closed.

## Why there is a list at all

The CodeMirror editor carried desktop-only features that were built for it and have no Milkdown
counterpart. Deleting it deleted them. None was dropped as a product decision: the maintainer
chose the full teardown knowing the two named at the time (selection toolbar, slash menu); the
rest surfaced while the teardown agent rewrote the spec. Nothing on this list affects the native
iOS/Android shells unless it says so.

## 1. Bugs — fix first, every platform

| #   | What                                                                                                                                                                                                                                                                                                                                              | Where it is recorded                                           | Fix shape                                                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | ~~Underscore escaping rewrites notes~~ — FIXED 2026-09-05 (`packages/editor/src/milkdown-compat/underscoreEscape.ts`: the `_` escape is narrowed to a delimiter CommonMark could read as emphasis; `tests/tags.spec.ts` un-fixme'd, parity spec case added, census diff run before landing). | — | — |
| B2  | ~~Undo can revive a superseded version~~ — FIXED 2026-09-05 (`MilkdownEditor.svelte` `loadParsedDocument`: every external load — whole or first chunk — is dispatched with `addToHistory: false`; embed test "a version adopted from outside the editor is not something undo can revive"). | — | — |
| B3  | ~~External links opened nothing on desktop~~ — FIXED in `4f295268` (`NoteWorkspace.svelte` now passes `onopenurl`). Kept here as the example of the class: shell wiring the embed had and the desktop shell did not.                                                                                                                              | —                                                              | —                                                                                                                                                                                                                                               |

## 2. Desktop features that no longer exist

| #   | Feature                            | What CodeMirror did                                                                                             | What Milkdown has today                                                                                                                                                 | Notes                                                                                                                                                               |
| --- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Selection toolbar**              | Selecting text raised a floating Bold / Italic / Strikethrough / Code / Link bar (`editorUX/selectionToolbar`). | Nothing. Desktop has NO formatting UI, only keyboard shortcuts.                                                                                                         | Named as a cost when 1A was chosen. The native shells are unaffected (native toolbars). `packages/editor/src/toolbar.ts` is the manifest a rebuilt bar should read. |
| D2  | **Slash menu**                     | `/` opened a block-insert menu.                                                                                 | Nothing.                                                                                                                                                                | Named as a cost when 1A was chosen. Milkdown ships `@milkdown/plugin-slash`; the old `slashMenuRenderer` UI is gone.                                                |
| D3  | **Table editing beyond Enter/Tab** | Right-click cell menu: add/remove column, delete row, delete table, set alignment.                              | Enter/Tab add rows (`keyboardParity.ts`); nothing else. `@milkdown/components`' table block is installed but never imported.                                            | Also affects phones — they never had the menu either, so this is a parity gap on all three.                                                                         |
| D4  | **Autolink as you type**           | `links/autolinks.ts` linkified a URL on input.                                                                  | GFM autolink literals are recognised at PARSE time only: a typed URL becomes a link after save + reopen.                                                                | An input rule on the gfm preset would close it.                                                                                                                     |
| D5  | **Per-note undo history**          | `noteHistory.ts` stashed a serialized editor state per note id; leaving and returning kept undo/redo.           | The stack is cleared on every open (`resetHistory` / `openNote`), on every platform. The data-safety half (undo never replays another note's steps) is kept and tested. | Needs a per-note snapshot `prosemirror-history` will accept back.                                                                                                   |
| D6  | **Tags shown once**                | The `#tag` header line was hidden; chips in `NoteTagBar.svelte` were the only rendering.                        | Desktop shows both the chips and the literal first line.                                                                                                                | Closing it needs an elision that still leaves tags reachable where there is no tag bar (phones). `tagDecorations.ts`.                                               |

## 3. Other behaviour changes the swap introduced (recorded, lower priority)

- **Native body inset is unread.** The shells still send `--futo-cm-pad-inline`; its only reader was a
  deleted CodeMirror selector, so the note body no longer lines up with the native title field and
  the tablet 46rem reading column is gone. Native shells only. (Also flagged by the #109 audit.)
- **Arrowing onto an empty block selects it**, and the next keystroke replaces it (`hr` measured).
  Standard WYSIWYG idiom; recorded for the destructive half.
- **iOS scroll tail moved inside `contenteditable`**, and the `preventScroll` caret guard went with
  `editorPointerInteractions`. Whether the keyboard-presentation jump it prevented
  (`docs/learnings/ios-keyboard-editor-jump.md`) is back is UNVERIFIED on a device.
- **Lazily numbered lists renumber on screen at open** (nothing written until the first edit), and
  an adopted peer version is re-rendered through the same rules rather than shown verbatim.
- **A broken wikilink is an atom**: it is selected and replaced/deleted rather than edited in place.

## 4. Verification debt

- **Desktop ⠿ handle drag is unverified on the real app.** It is native HTML5 drag-and-drop; a
  synthetic `dragstart` carries an empty `DataTransfer`, so the MCP-driven smoke could not arm it
  and OS-level input is forbidden (AGENTS.md M24). Needs a human on `just tauri-dev`.
- The deleted suites' engine-neutral cases were moved into the Milkdown specs, but coverage
  breadth dropped: `markdown-spec/`'s 276 YAML cases are gone (mined, not ported — see `569ba4c6`)
  and `editor-ux.spec.ts`'s 56 cases went with the features in §2.

## Suggested order

B1, B2 (bugs, small, every platform) → D1 + D2 (the visible desktop losses) → D3 (all platforms)
→ D4, D6, D5 → §3 as they come up. Re-measure the round-trip census after any serializer change.
