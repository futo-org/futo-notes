### T5 outcome (#102, done)

Tags, task checkboxes, and fenced-code highlighting, on branch
`feat/milkdown-editing-parity`.

- **Saving a note was un-tagging it.** `mdast-util-to-markdown` escapes EVERY line-leading `#`
  (`{atBreak: true, character: '#'}`, no condition on what follows), so the first edit to a note
  whose first line is the header tag block `#alpha #beta` saved it as `\#alpha #beta` — and
  `\#alpha` is a tag to nothing: not to `scanTags`, not to `extractHeaderTagBlock`, not to the
  desktop tag bar, not to Obsidian. The escape is over-broad rather than wrong in principle: an ATX
  heading is 1-6 `#` followed by a space, a tab, or end of line, which `#alpha` (and `#5`, and
  `#######x`) is not. `packages/editor/src/milkdown-compat/atxEscape.ts` states that condition and
  replaces the blanket rule; `stringifyHandlers.ts` applies it by wrapping Milkdown's own `text`
  handler, because unsafe patterns can only be ADDED through an extension while handlers can be
  replaced. This is the first tenant of §3's `milkdown-compat/` home, with §3.5's canary shape:
  three tests lock the UNPATCHED behavior of the pinned `mdast-util-to-markdown` so the day
  upstream narrows its own rule they go red and the fix gets deleted. §3.6 reporting (upstream) still to do.
- **Tags are decorated, not modelled.** `tagDecorations.ts` paints `scanTags` matches; the document
  holds a tag as ordinary text exactly as the file does. A schema node would have made a tag
  undeletable by character and put an IME-hostile boundary mid-word. Inline code and fenced blocks
  are blanked before scanning (their positions preserved), which is the spec's code/fence isolation.
- **DIVERGENCE, for the bucket-2 spec MR to settle: the leading header tag block is NOT hidden.**
  The CodeMirror editor hides it while the caret is away, and cursor motion there runs over the
  document, so the hidden line stays reachable. A ProseMirror node rendered `display: none` cannot
  be reached by caret or click at all — implemented and measured, `Ctrl+Home` does not enter it —
  so hiding it would leave the note's tags unreadable AND uneditable, and on the native shells
  (no tag bar) that is the only place they exist. It is also silently joinable: Backspace at the
  start of the following paragraph would merge an invisible block. Left visible, with a test
  locking that. The desktop swap is where this editor and the tag bar first meet and is the right
  place to decide it.
- **Checkboxes are a real input in a real tap target.** The `::before` glyph the spike drew was
  ~1em wide (17px, under the 44pt/48dp minimum), and tapping it focused the editable — so on a
  phone every tick raised the keyboard over the list being ticked. `taskCheckbox.ts` renders the
  CodeMirror editor's contract instead: `<input type="checkbox">` in a font-independent 28px box,
  `mousedown` defaultPrevented (the one line that keeps the keyboard down), one undoable step per
  toggle. The box takes the item's own marker column rather than reaching back into the list's or
  the editor's padding, so it cannot drift into the 20px screen-edge strip iOS's back-swipe owns.
  An ordered task list keeps its number.
- **Fence highlighting reuses the curated set verbatim** — `codeFenceLanguages.ts`, same ~35
  languages, same aliases, same lazy per-language load. Only the renderer changes: Lezer's
  `highlightTree` + `classHighlighter` produce the same `tok-*` class names CodeMirror produces, so
  ONE stylesheet (`src/styles/code-tokens.css`, off theme.css's `--syntax-*`) now paints both
  editors and the palette mapping is no longer duplicated. Cost to the shipped bundle: **+4,280
  bytes** (2,111,592 -> 2,115,872), because the grammars were already there.
- **Both published ProseMirror highlight plugins were rejected on measurement, not taste.** On a
  14k-line note with 280 fences (fast desktop, 2026-08-28) `prosemirror-highlight` costs **82 ms
  per keystroke** — its decoration cache calls `doc.nodeAt` once per fence and `doc.nodeAt` scans
  the document's children, so the cost is fences x blocks; `@milkdown/plugin-prism` walks the whole
  document twice on any edit spanning two blocks (pressing Enter) and re-highlights every fence,
  and its static `import { refractor } from 'refractor'` would have added 62 eager grammars
  (114 KB minified) next to the ones we already ship. `blockDecorations.ts` is the ~40 lines they
  are replaced with: map the existing set through the transaction, rebuild only the blocks the
  transaction's own steps touched. Tags and highlighting both run on it (M5).
- Found by the review round, third time: moving `taskCheckbox` onto `repaintBlocks` broke NESTED
  task items. `repaintBlocks` clears a block's whole range before rebuilding it, and a task item's
  range contains any task item nested inside it — so typing in the parent's own paragraph cleared
  the child's checkbox and re-added only the parent's. Two checkboxes before the keystroke, one
  after. `blocksIn` must return blocks that do not contain one another, which textblocks and fences
  satisfy for free and task items do not; `taskItemsIn` now returns only OUTERMOST items and
  `decorateTaskItem` covers their whole subtree. The requirement is written into `repaintBlocks`.
- Found by the review round, after the first commit — the M5 rule bit twice more. `repaintBlocks`
  fixed the per-keystroke cost of REBUILDING decorations, but the fence highlighter also put one
  node decoration per fence on the document to carry a CSS class, and a node decoration spanning a
  whole top-level block is stored in the decoration tree's ROOT — so MAPPING them cost O(fences) on
  every keystroke: 4.6 ms at 1000 fences, against 0.075 ms with the decoration gone (a 33x gap over
  an empty-plugin baseline). The class is gone; `src/styles/code-tokens.css` names both editors'
  fences instead, which costs nothing at runtime. `codeHighlight.test.ts` locks the scaling as a
  ratio of ratios, so it says nothing about how fast the machine is.
- Found by the review round, after the first commit: `repaintBlocks` removed stale decorations
  with `set.find(pos, pos + nodeSize)`, and `DecorationSet.find` returns everything TOUCHING that
  range — so a node decoration on the NEXT block, which starts exactly where this one ends, was
  removed and never re-added. Typing in one fence silently un-highlighted the fence below it.
  Removal is now containment, not touching, with a test. The same review caught `taskCheckbox`
  rebuilding every widget in the document on each keystroke — the exact shape the two rejected
  libraries were rejected for — now on `repaintBlocks` like the other two.
- Coverage: `tests/editor-embed-milkdown-parity.spec.ts` (28 cases) drives the real `editor.html`
  with Playwright mouse AND CDP touch — the phone case is the one that catches a checkbox that
  toggles but steals focus. Unit tests cover the escape narrowing, the tag scanner, the bounded
  repaint, the checkbox, and language matching. `playwright.editor-embed.config.ts` and the
  `test:e2e:editor-embed` `changes:` list both name the new spec (T1's M11 lesson), and that list
  now also names `src/styles/**` — the embed inlines app.css and these tests assert computed
  colours.

Deferred, deliberately: the editor-gauntlet legs for these three surfaces. The gauntlet adapter for
this editor is **#100**'s deliverable and did not exist when this landed; adding a second harness
here would have been the thing #100 is for. It exists now — see the T3 outcome above, which scored
this editor after these three surfaces landed.
