### T7 outcome (#104, done)

Toolbar command parity on ProseMirror. The three gaps T1 recorded were the visible part; driving
every manifest id through the real bundle found that most of the BLOCK commands were broken,
because Milkdown's preset ships bare `wrapIn`/`wrapInList` wrappers with no toggle and no
conversion:

- **Quote on a quote nested** (`> > text`) instead of unwrapping; Bullet on a bullet, and every
  cross-kind conversion (bullet→ordered, heading→bullet, quote→bullet, task→bullet), was a silent
  no-op. `src/features/editor/milkdown/blockCommands.ts` now implements the spec's
  one-prefix-per-line model against a ProseMirror document, built from prosemirror-commands /
  prosemirror-schema-list primitives. A conversion that is two primitives underneath lands as ONE
  transaction — one undo step, one `change`.
- **A selection spanning blocks is split into runs of same-kind blocks**, one transition each.
  Neither obvious granularity works alone: one command over the whole selection collapses a mixed
  selection (an h1 plus a paragraph, tapping Heading, has to give h2 and h1), and one command per
  block wraps two selected paragraphs into two adjacent one-item lists instead of one list.
- **Removing a list marker across a whole list did nothing.** Plain `lift` cannot lift two
  `list_item`s into the document; only the single-item case (where the range is the item's
  paragraph) worked. It uses `liftListItem` now.
- **`markActive` read a stale document** (latent since T1, exposed here). It range-checked against
  `view.state.doc` while the caller may pass a selection from a NEWER transaction — fine for a
  pure selection move, wrong once the transaction changed the document too, and an outright throw
  once the new range runs past the old document's end. It reads `selection.$from.doc` now.
- **`cursorContext` was a transaction behind** for the same reason, so a tap that turned a
  paragraph into a list never revealed Indent/Outdent. `enclosingListItem` walks the selection's
  own resolved position, and `exec()` emits cursorContext alongside formatState.
- **Bullet markers serialize as `-`** (`remarkStringifyOptionsCtx`), matching the CodeMirror engine
  and the corpus, so an edited note no longer churns its list markers on first save.
- **`formatState` has its Android consumer**: `EditorHost.activeFormats` + the accent wash in
  `EditorToolbar.kt`, matching iOS's treatment; the `BridgeCoverageTest` exemption is gone. The
  embed fallback toolbar renders the same highlight from the same set — all three surfaces now.

Recorded, not fixed: the WYSIWYG engine has no way to ENTER a link's URL, so a link the toolbar
makes has an empty href. Recorded as a Gap in `docs/spec/editor.md`; the fix is a link-editing
affordance (Milkdown ships `@milkdown/kit/component/link-tooltip`), which is a UI surface of its
own and has to coexist with the link-tap → `openUrl` behavior the native shells rely on.

`Indent` on the first item of a list is a no-op and that is correct, not a gap: an item can only
nest under a preceding sibling. Recorded as a behavior line.

The transition table now exists once per engine and is registered in `scripts/drift-registry.json`
(`toolbar-block-transitions`, locked by the two parity suites); it collapses back to one copy when
CM6 is deleted at the swap.

Verified: `just check`; the full editor-embed harness; `assembleDebug` + JVM unit tests; the real
Android app on a pooled emulator; and the real iOS app on the 26.5 simulator, driving the native
accessory toolbar with `axe` and reading the vault file after each tap — bullet → ordered → task →
bullet → plain, the h1/h2/h3/plain cycle, Quote unwrapping instead of nesting, the active-format
pill following the caret, and Indent/Outdent appearing the moment a tap creates a list and
disappearing the moment one is removed (the `cursorContext` fix).

One iOS caveat worth writing down, because it cost a false pass: on a 402 pt iPhone the accessory
bar's `list.number` sits at x 362-406 UNDER the dismiss-chevron capsule at x 352, so `axe tap
--id list.number` resolves, reports success, and blurs the editor instead. Swipe the bar left
first. A keyboard-onboarding overlay ("Speed up your typing by sliding your finger") also swallowed
a whole tap sequence while every tap reported `✓` — AGENTS.md M21, twice in one session.
