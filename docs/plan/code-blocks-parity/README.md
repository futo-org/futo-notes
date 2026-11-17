# Code blocks: parity with !300

This table lists every behaviour a person can see in the fenced code blocks of !300, the hand-tuned code blocks on the old web editor, one row each. Do each row's gesture on the !300 build and on the new build, and compare. The rows describe what the user does and sees, not how !300 built it.

## Sources

- !300 (`origin/claude/ux-editor-improvements-7e44ca`, commit `9de2e7c06`):
  - `cb` = `docs/spec/code-blocks.md` (all 1009 lines)
  - `ed` = `docs/spec/editor.md`
  - `app` = `docs/spec/app.md`
  - `vis` = `docs/spec/editor-visual.md`
  - `l10n` = `docs/spec/localization.md`
  - `list` = `docs/spec/list.md`
  - `tb` = `packages/editor/src/toolbar.ts` (the native toolbar's item list)
- Engine today (`origin/feat/android-code-blocks`, commit `3b31d0bba`), all in `docs/spec/editor/portable-core/`:
  - `fc` = `fenced-code.md`
  - `pt` = `paired-typing.md`
  - `clip` = `clipboard.md`
  - `ii` = `interpretation-and-input.md`
  - `ld` = `linedown.md`

A reference such as `cb 717-721` is a line range in that file.

## Columns

- **ID**: P001 onward, across the whole file.
- **Do**: the setup and gesture.
- **!300 result**: what the user sees, or the bytes that result. "The spec does not state" means that !300's spec is silent, and the row exists because of a pick of Mason's or an ambiguity.
- **Ref**: where !300 states it.
- **Applies**: `touch`, `hardware keyboard`, `both`, or `desktop only`. Where !300 differs between iOS and Android, the row records Android and notes iOS.
- **Engine today**: from the five engine files only. It starts with one of these tokens:
  - `same`: the engine states the same behaviour. Where !300 is silent, it is compared with the pick in Target.
  - `differs: …`: the engine states something else. Where !300 is silent and Target is `ask Mason`, it means the engine has a rule that !300 does not state.
  - `not built`: the engine files cover this area and state that the thing is absent.
  - `host's job`: the engine leaves it to the app. This rests only on `fc 6`, where hosts draw a block from the facts the engine reports, and on `fc 30`, where caret movement and presses on the header and edges are the host's.
  - `unknown`: the five files say nothing about it.
- **Target**: `!300`, `Mason's pick: …`, or `ask Mason`. `ask Mason` is used where !300 and a later pick conflict, where !300 is ambiguous (the ambiguous words are quoted), or where !300 itself had a known problem.

Mason's settled picks, which override !300:

- Enter in code is always a line break and never leaves the block. A block that ends the note is left by ArrowDown or by the "add a line below" target.
- Enter on a block selected as one object puts the caret at the end of its last code line.
- Enter with exactly all of a block's code selected (an ordinary selection) removes the code and leaves the block with one empty line.
- An unclosed fence runs to the end of the note.
- There are no backtick typing conveniences inside a code block, and a typed closing fence ends the block.
- Backspace and Delete at block edges follow !300's rules.
- Android has no syntax colouring in this pass.
- The header fields are name and language only.
- Line marks should follow their lines (but see the marks rows: !300's spec says it already did this).
- On desktop a click on a header field edits it. The phone rule is undecided.

## Files

- [1. Reading and saving](01-reading-and-saving.md)
- [2. Look](02-look.md)
- [3. Caret and taps](03-caret-and-taps.md)
- [4. Typing and Enter](04-typing-and-enter.md)
- [5. Backspace and Delete](05-backspace-and-delete.md)
- [6. Whole-block selection](06-whole-block-selection.md)
- [7. Selection across a block's edges, copy, cut, paste](07-selection-across-edges-copy-cut-paste.md)
- [8. Header fields (name, language)](08-header-fields-name-language.md)
- [9. Line-number menu and marks](09-line-number-menu-and-marks.md)
- [10. Add a line above/below](10-add-a-line-above-below.md)
- [11. Creating a block and removing one](11-creating-a-block-and-removing-one.md)
- [12. Tab and indent](12-tab-and-indent.md)
- [13. Arrow keys and hardware keyboard](13-arrow-keys-and-hardware-keyboard.md)
- [14. Undo and redo](14-undo-and-redo.md)
- [15. Find](15-find.md)
- [16. Soft keyboard, autocorrect and IME](16-soft-keyboard-autocorrect-and-ime.md)
- [17. Accessibility](17-accessibility.md)
- [18. Performance promises](18-performance-promises.md)
- [Known problems in !300](known-problems-in-300.md)
- [Left out, and why](left-out-and-why.md)
- [Engine differs or is silent](engine-differs-or-is-silent.md)
