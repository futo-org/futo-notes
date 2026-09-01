# Milkdown transition — campaign plan

> **Status: DECIDED 2026-08-28, not yet started.** Every decision below was made by Justin in a
> structured decision session (2026-08-27/28); the evidence behind each one is cited inline. This
> doc is the execution source of truth for the transition. Contract context: ADR-0002 (round-trip
> normalization accepted, tiers 1–2 stand), ADR-0003 (tree CRDT substrate). The rich-text bake-off
> (`docs/plan/rich-text-editor-bakeoff.md`) was scored against the now-superseded Tier-3 contract —
> its measurements remain valid evidence; its verdicts do not bind this work.

## 1. The decision ledger

| # | Decision | Choice |
|---|---|---|
| D1 | Sequencing | **Editor first, on existing file sync.** CRDT sync is a separate later campaign. Normalize-once churn under text sync is accepted as bounded and self-extinguishing; the conflict-copy machinery catches the rare concurrent-edit collision. |
| D2 | CRDT substrate (on paper now, per ADR-0002's gate) | **Tree CRDT, Yjs family** — see ADR-0003. The editor's engine wrapper is built with the y-prosemirror rebind in mind. |
| D3 | Foundation | **Productionize `spike/milkdown-editor`**: `@milkdown/kit` core presets + our own chrome (no Crepe). Validated by the perf probe, the 31k-note corpus census, and the working two-shell integration on that branch. |
| D4 | Data-loss bar | **Zero loss is the tracked ideal, not a release gate** (amends ADR-0002's wording). The parked guard work gets finished as ordinary v1 work; the census is a scorecard. |
| D5 | Guard architecture | **Milkdown compat plugin set in `packages/editor`** (root-cause plugin fixes), plus one pre-parse string pass for the bullet-number ambiguity only. Canary tests against upstream; bugs filed upstream. No Rust mirror — recorded M6 carve-out. |
| D6 | Feature parity | **Full bucket-1 parity** with `docs/spec/editor.md` before replacement (see §4). Live-preview/decorated-source spec sections are renegotiated, not matched. |
| D7 | Large notes | **Progressive viewport-first open (7C)**. Open budget redefined as time-to-interactive-first-viewport; saves locked until fully loaded; budgets enforced on a real low-end Android phone (Justin's old device). |
| D8 | Mobile gates | **WebView floor measured** down the Chromium tier ladder, github#8 update-notice below it. **No formal keyboard matrix** — the dogfood period covers IME organically (decided with the risk named). |
| D9 | Rollout | **Dogfood on dev builds, then big-bang three-platform replace.** No CM6 escape-hatch toggle. CM6 and its scaffolding deleted in the same MR chain. Spec renegotiation is its own reviewed MR. |

## 2. Evidence base (do not re-derive)

- **Perf probe 2026-08-27** (standalone, @milkdown/kit 7.22.1, headless Chromium): passes open <1 s
  + keystroke p95 <16 ms through 14k lines *with* `.ProseMirror > * { content-visibility: auto;
  contain-intrinsic-size: auto 24px }`; ceiling ~16k lines, bound by remark parse (~62 ms/1k lines,
  linear — no TipTap-style wall). Keystroke cost without the cv rule is 82% browser layout over the
  eager whole-doc DOM. Typing passes even at 50k with cv (+ filtering the preset's two whole-doc
  per-transaction walkers, not needed ≤16k). Numbers are from a fast desktop — low-end Android
  multiplies them, which is why D7 exists.
- **Round-trip corpus census** (`spike-notes/milkdown-corpus-report.md` on the spike): 31k notes,
  zero crashes/hangs. Two real loss classes — inline `<br>` deleted (word fusion; the standard
  multi-line table-cell idiom) and `[](url)` links deleted href-and-all — plus one corruption class
  (spurious `<br />` on `* 0.`-style bullets). All three root-caused in
  `spike-notes/roundtrip/roundtrip-findings.md`, fixes ~90% done as string guards (parked, with
  resume steps). §3 below replaces the string-guard approach.
- **Note-size population**: foreign corpus max 19,295 lines (2 notes >10k of 30,995); Justin's
  vault max 13,876 lines (next largest 978, of 2,511).
- Spike already has: `MilkdownEditor.svelte` mounted through the shared embed, bridge extensions in
  both native shells, native toolbar format-state highlighting, Notion-style block drag with
  real-device hardening, native image paste, and the load-echo guard (ADR-0002's reference
  behavior).

## 2.5 Spike graduation (how D3 is executed)

The spike branch is the **starting point, not a blessed merge**: it graduates through review, and a
clean rewrite is explicitly rejected (it would re-earn a working two-shell integration to reach the
same code). Known debts the review pays down:

- `MilkdownEditor.svelte` (1,152 lines) and `mobileBlockDnd.ts` (721 lines) need a real review
  pass (`/slow-review` grade) and likely decomposition before merge.
- `formatState`/`haptic` are iOS-only: add the Android consumers or record the asymmetry as an
  explicit spec gap — the spike's "no consumer yet" exemption is not a shippable end state.
  **Both paid: `formatState` in #104, `haptic` on 2026-09-01 when Android took the long-press block
  drag (§4) and gained `performBlockDragHaptic`.**
- The parked string guards in `spike-notes/roundtrip/` are replaced by §3's plugin set, not resumed.
- The `?cm` escape switch and the `spike-notes/` directory die at swap time; their content
  graduates into this plan, spec lines, and test fixtures.
- Rebase onto main and rename to a `feat/` branch when execution starts.

### T1 outcome (#98, done)

Branch `feat/milkdown-editor` (the spike was already on current main, so the rebase was a rename).
What the review changed:

- **Undo could destroy a note (fixed).** `resetHistory()` was a no-op, and the host calls it on
  every `initialize`/`setContent` — i.e. every note open. The first Ctrl-Z after opening a note
  un-applied the load and left the document EMPTY, and after a note switch undo replayed the
  previous note's steps into the current file. It now rebuilds the ProseMirror state around the live
  doc (prosemirror-history has no clear command), preserving doc and caret.
- **One hardened block move for both drag paths.** The iOS long-press path validated the source
  range at drop time and moved the NODE; the ⠿-handle touch fallback still trusted positions
  captured at pointerdown and inserted a re-fitted SLICE, which is exactly the "my heading stopped
  being a heading" failure the iOS path was hardened against (M17, fixed 1 of N). Both now commit
  through `blockMove.ts`.
- **`markActive` said one thing and did another.** Its comment claimed a mark must cover every
  character of a range; it used `rangeHasMark`, which is "occurs anywhere". "Anywhere" is correct —
  it matches what `toggleMark` will do to that selection — so the comment was fixed, not the code.
- **The ⠿ gutter handle was dead for one commit, and a test caught it.** The first fix for the undo
  bug rebuilt the EditorState; `EditorState.create` copies the plugin array, so `view.updateState`
  destroyed every plugin view, and @milkdown/plugin-block's BlockProvider — which parents its handle
  outside the ProseMirror DOM and only appends on its first `update()` — never put it back.
  `resetHistory` now sets the history plugin's state through the `historyKey` meta its own undo/redo
  commands use, touching nothing else.
- **Decomposition.** `MilkdownEditor.svelte` 1,152 -> 838 lines (570 script + 268 style, which
  stays with the component). Extracted into `src/features/editor/milkdown/`: `blockMove.ts`,
  `handleBlockDrag.ts` (the ⠿ touch fallback), `formatState.ts`, `caretContext.ts`,
  `toolbarExec.ts`, `blockDragMode.ts`, alongside the moved `blockDragGeometry.ts` and
  `mobileBlockDnd.ts`.
- **`mobileBlockDnd.ts` was reviewed but deliberately NOT decomposed** (669 lines, now the feature's
  largest file). Its two separable parts are already out — geometry into `blockDragGeometry.ts`, the
  commit into `blockMove.ts`. What is left is one long-press gesture state machine that has to be
  read as a single sequence (arm -> suppress selection -> lift -> drag -> release), plus the
  device-earned constraints doc comment and the stylesheet for the ghost card, which only make sense
  next to the code they explain. Splitting it would scatter one gesture across files without making
  any part of it independently understandable.
- **Tests where there were none.** `tests/editor-embed-milkdown.spec.ts` (28 cases) drives the real
  `editor.html` bundle: the load-echo guard over markdown Milkdown would normalize, the undo
  boundary, the change contract, `formatState`, and the long-press block drag through real CDP touch
  input. Unit tests cover `blockMove` and `formatState` (18 cases).
- **The CodeMirror contract suite now pins `?cm`.** Making Milkdown the default engine had silently
  turned `editor-embed-bridge.spec.ts` red (33 of 50), most of it CM6-specific DOM and
  markdown-source assertions. It loads `CM6_EDITOR_URL` and dies with CM6 at the swap.

A second review pass (standards axis) then fixed: a CI `changes:` list that did not name the new
spec files, so an MR touching only them dropped `test:e2e:editor-embed` to manual + allow_failure
(M11 class); a platform branch inside a component (`isIOS` in `MilkdownEditor.svelte`, now
`blockDragMode.ts` — src/AGENTS.md forbids the former); two comments citing rules that do not exist;
and the duplication the two drag paths had re-grown around auto-scroll and target resolution.

Recorded, not fixed here:

- `formatState` has no Android consumer — deferred to **#104** by this ticket's acceptance criteria,
  and recorded in `bridge.ts` and `BridgeCoverageTest.kt`. `haptic` is iOS-only by construction:
  Android mounts the gutter-handle drag and never emits it. **Superseded 2026-09-01 — Android now
  mounts the long-press drag and receives `haptic`; see §4.**
- Toolbar parity gaps found by the suite, all **#104** (closed there — see the T7 outcome below):
  `link` with an empty selection does nothing, `indent` needs a preceding sibling item, and list
  markers serialize as `*` rather than `-`.
- **The empty-note load echo was luck, not contract** (fixed as part of the review round). The
  guard could not fire for a note that loaded empty — `liveMarkdown` started as `''`, so
  `setContent('')` looked like content already held and skipped the path that records a baseline. It
  happened to be harmless because Milkdown serializes an empty document to `''`; a serializer change
  would have turned opening a brand-new note into a rewrite. `liveMarkdown` now starts null, and
  three spec cases cover empty and whitespace-only notes.

- **Change notification is debounced 200 ms with no maxWait** (`@milkdown/plugin-listener`), so
  sustained typing can defer the host's `change` — and therefore its autosave — indefinitely. Exit
  and background paths read `getContent()` directly, so this is a crash-window question, not a
  lost-work-on-exit one. Owned by **#105** (save semantics).
  **This is now an observed device failure, not just a risk on paper**: `just test-ios-stories`
  ("sustained typing keeps one note and every keystroke") FAILS on this branch — 30 s after the
  typing stops the note on disk still holds its original bytes. Reproduced on the iOS 26.5
  simulator 2026-08-28 at both `5bb4c5c8` (this ticket's base) and the T7 commit on top of it, with
  an identical signature, so it is the branch's behavior and not any one ticket's regression. It is
  the first red the Milkdown branch has in that suite; #105 has to make it green again before the
  swap.

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

### T3 outcome (#100, done)

The editor gauntlet — the bake-off's candidate-neutral harness, previously stranded on the unmerged
`test/editor-gauntlet` branch — is graduated onto this branch and has a Milkdown adapter. It drives
the same single-file `editor.html` the shells ship (there is no app shell running Milkdown until
D9), and the runners are untouched: the boundary is still `EditorGauntletAdapter`.

What the first scored run says (desktop chromium, 2026-08-28; full detail in
`tests/editor-gauntlet/README.md`):

- **Split torture 36/56**, scored against the editor as of T5 (wikilinks, tags, checkboxes).
  Three failure families, each in `milkdown-split-torture.baseline.json`: the wikilink is an ATOM
  (8), a caret on a mark boundary types outside the mark (7 — ProseMirror mark inclusivity), and
  pasted text inheriting the mark of the range it replaced (4). None is a data-loss finding, and
  the wikilink eight are not defects at all: the link survives every case intact, but an atom has
  no inside, so a case written to split a construct mid-span has no answer here. All three families
  are the same question for the §4 audit — whether a matrix written for source mode is asking the
  right thing of a WYSIWYG editor — and that is a decision to take deliberately, not a bug list.
- **Zero of 56 undos are byte-exact** — every one adds a trailing newline. Normalize-once, as
  designed; undo is therefore checked for loss, and the byte-exact count is reported as the D4
  scorecard.
- **Preservation is loss-only now**, per ADR-0002. The sweep still counts block rewrites and still
  reports them; they are no longer pass conditions, because a WYSIWYG round trip rewrites syntax
  document-wide (an 8-note smoke rewrote 10 of 11 edited blocks). The gate is never-refuse /
  never-warn / never-lose, with loss judged by a token-multiset oracle that reproduced the census's
  two real loss classes and produced no false positives on benign normalization.
- **The performance floor fails, and the shape of the failure matters.** Open misses the 1 s budget
  at 10k lines and keystroke p95 misses 16 ms at 50k lines and 10 MiB; absolute figures move 20-40%
  run to run, so read the report rather than quoting a constant. There is **no cliff**:
  per-line open cost at 50k is 1.4x the 10k cost, and per-byte cost at 10 MiB is 0.3x the 1 MiB
  cost. The scaling claim behind D3 holds; what is missing is §5's progressive open. Two honest
  limits on the gate itself: it measures time-to-fully-loaded while §5 budgets
  time-to-interactive-first-viewport (the same number until progressive open exists, and an upper
  bound on it after), and the adversarial fixtures get no absolute open budget at all, because §2's
  population is stated in lines and says nothing about a 1 MiB benchmark-shaped document.
  **Correction to a §2 assumption:** adding the perf probe's `content-visibility` stylesheet to the
  live page does not close the open gap, so that rule is a keystroke-layout lever, not an open-cost
  one. The floor is asserted rather than ledgered, so it stays red until progressive open moves it.

One production seam was added: `MilkdownEditor.getProseMirrorView()`, exposed by `main.ts` as
`window.__futoProseMirrorView` alongside the existing `__scrollDiag`. The gauntlet drives the
shipped bundle bytes, so it has no other way to place a caret exactly across 31k foreign notes or to
time a keystroke against the same synchronous unit CM6 is measured on.

Not in CI, by design: the split matrix is ~40 s, the perf floor minutes, and a full corpus sweep
hours. Recipes are `just gauntlet-milkdown`, `-perf`, and `-foreign`.
### T4 outcome (#101, done)

Branch `feat/milkdown-wikilinks`. Wikilinks work in the Milkdown editor:
`src/features/editor/milkdown/wikilink/` — `syntax.ts` (micromark tokenizer +
mdast from/to-markdown), `node.ts` (inline atom node + node view), `display.ts`
(which of the shared index's two answers a rendering uses), `inputRule.ts`,
`autocomplete.ts`. The survey that decided "build, don't adopt" is §3a.

- **The reason this was mandatory, measured**: unpatched, Milkdown serializes
  `[[notes/alpha]]` as `\[\[notes/alpha]]`. Every link in a note breaks on its
  first edit. Fences and code spans were already safe.
- **`![[embed]]` was corrupted twice over** and needed a second construct.
  micromark's `labelStartImage` claims the `![` pair at the `!`, leaving a lone
  `[` that cannot open a wikilink — so the whole run escaped to `!\[\[embed]]`.
  A lookahead construct at `!` now claims the `!` as plain text only when a real
  wikilink follows (`effects.check` rewinds), leaving `![alt](url)` an image.
- **Re-rendering never touches the document.** A host `setNotes` can flip a link
  from broken to resolved; doing that through a transaction would make a host
  call look like a user edit and normalize-save a note nobody touched. The node
  views mutate their own DOM instead, and a test asserts no `change` is posted
  and `getContent()` is unchanged.
- **The chip is an ATOM**, because display and source deliberately differ —
  `[[Projects/Roadmap]]` reads as "Roadmap" and a caret inside a shortened
  rendering has no honest source position. Two existing spec lines describe the
  CM6 model instead and are **bucket-2 renegotiation input**: "hidden trailing
  syntax such as a wikilink's `]]`" (marker reveal near the caret), and "a broken
  wikilink still focuses, so it can be edited" — in WYSIWYG a broken chip is
  selected and replaced, not edited in place.
- **One tap path for both link kinds.** The `touchend` leg exists because iOS
  WebKit cancels the synthetic click after a prevented mousedown — which is just
  as true of external links, so they share it rather than leaving the sibling on
  the leg that dead-ends (M17).
- **Accepted normalization, pinned by test**: `![[x]]` gains a `\!` on the first
  real edit (mdast-util-to-markdown escapes `!` before `[` and its `unsafe` list
  only grows), and literal `[[` that is not a wikilink is escaped the way a bare
  `[` already is. Both are idempotent and neither touches a wikilink.
- **Coverage**: 291 unit cases (differential vs `findWikilinks`, round trip,
  display, autocomplete matching) and 22 embed-seam cases driving the real
  `editor.html` with real keyboard and touch.
- **Desktop** reaches all of this the moment it mounts the shared bundle (D9's
  big-bang swap); it still mounts CM6 today, so "identical on all three shells"
  holds by construction — one plugin set in the one engine wrapper — not by a
  desktop-specific code path.
- Fixed in passing: `clickCaretInto` in `editor-embed-milkdown.spec.ts` measured
  a caret point without waiting for `document.fonts.ready`, so a Barlow swap
  between the measurement and the click moved every character. Seen red 3/3 on a
  loaded machine, green 25/25 after.
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

## 3. Compat plugin set (replaces the parked string guards)

Home: `packages/editor/src/milkdown-compat/` (exact name at implementation time). Both hosts and
the corpus harness consume the same module — the ADR-0002 "one serializer" rule extends to these.

1. **`<br>` fix — replace, don't wrap**: filter `remarkPreserveEmptyLinePlugin` out of the
   commonmark preset and `.use()` a fixed local copy that deletes the empty-paragraph `<br />`
   placeholder only when it is the sole child of its paragraph. Kills the protect/restore marker
   dance and both known string-guard regressions (footnote definition idx 8560, table-in-blockquote
   idx 25957) by construction — the mdast tree knows its paragraph context.
2. **Empty-link fix**: remark transformer that gives `link` nodes with zero children a text child
   equal to the URL. One-way. Images are a different mdast node type, so the `![](url)` regression
   class from the regex version cannot occur.
3. **ATX-escape narrowing** (added by T5, #102 — `milkdown-compat/atxEscape.ts`): remark-stringify
   escapes EVERY line-leading `#`, so a note's header tag block `#alpha #beta` saved as
   `\#alpha #beta` and the tag stopped being a tag to `scanTags`, `extractHeaderTagBlock`, the tag
   bar, and Obsidian. Replaces the blanket `{atBreak: true, character: '#'}` unsafe rule with the
   real CommonMark condition (1-6 `#` then space/tab/EOL) by wrapping Milkdown's own `text`
   handler — an extension can only ADD unsafe patterns, but handlers can be replaced.
4. **Bullet-number escape**: the pre-parse string pass stays (`* 0. item` → `* 0\. item`) — remark
   transformers run post-parse, after CommonMark has already resolved the ambiguity into a nested
   list. Same skip-fences/inline-code rules as the parked WIP.
5. **Canary tests**: pin the Milkdown version; a test reproduces each upstream bug against the
   *unpatched* preset so the day upstream fixes it the canary flips and the fork gets deleted.
   Register the fork in `scripts/drift-registry.json` if `check-drift` flags it.
6. **Upstream**: file the `<br>`-deletion and empty-link bugs against Milkdown with the minimal
   repros from the census report.
7. **M6 carve-out**: these transforms are Milkdown-implementation adapters, not note rules — no
   Rust mirror. Record the carve-out in `packages/editor/AGENTS.md` when the module lands.
8. **Re-census** after the rewrite: full foreign corpus + a second leg over Justin's real vault
   (local, never committed). Diff against `corpus-results-baseline.jsonl` (regenerated baseline on
   the spike). Target: the two real-loss classes at zero, zero new regressions, the 16
   uninvestigated `html_loss` notes dispositioned. Per D4 this is tracked, not gating — but the
   report is a required deliverable (`spike-notes` successor doc or `tests/` local artifact).

### T2 outcome (#99, done)

Landed as `packages/editor/src/milkdown-compat/` — `commonmarkWithCompat`, one
array that replaces `.use(commonmark)`. Numbers and the full write-up:
`docs/editor/milkdown-roundtrip-census.md`. Over 30,995 corpus notes,
`<br>` deletion **61 → 0**, empty-link deletion **26 → 0**, `html_loss`
**61 → 0**, and **zero newly-raised flags** per note; the maintainer's own
2,511-note vault agrees (run locally, results not committed).

What changed against §3 as written:

- **All three `<br>` isolation cases collapsed into one rule.** The parked
  string guards needed separate handling for bare paragraphs, table cells and
  list items, and still could not see a table nested in a blockquote or a
  footnote definition. In the mdast tree the placeholder is simply "in block
  position, or the sole child of a paragraph/table cell", and both parked
  regressions (idx 8560, 25957) cannot occur.
- **The fork keeps upstream's slice id**, `remark-preserve-empty-line`.
  `node/paragraph.ts` only emits the placeholder when
  `ctx.get('remark-preserve-empty-line')` resolves, and `Ctx#get` looks a string
  up by slice *name* — registering under a new name would have silently turned
  the serializer half off and started dropping blank lines the author typed.
- **One extra repair was needed.** remark will not write an eol directly before
  inline HTML (mdast-util-to-markdown#15), so a preserved `<br>` after a hard
  break stranded the break's backslash mid-line. A kept tag is moved in front of
  the breaks it follows; without that, six notes regressed.
- **The bullet-number escape is a partial fix, by design of the scope.** 342 →
  299. The 299 are the same placeholder mechanism reached through `* > quote` /
  `* * nested` (279), where escaping would change meaning, plus 16 digit-dot
  bullets indented past the escape's CommonMark 0–3-space allowance. The report
  names the follow-up: drop the structurally-required empty leading paragraph in
  a `listItem`. **Not done here** — it is a different fix to a different cause.
- **The census is a recipe now**, `just milkdown-census`, with a `baseline`
  variant that runs the unpatched preset. That is how "did anything regress" is
  answered from the harness itself rather than from numbers nobody can
  re-derive, and it is how the canary tests reproduce the upstream bugs.
- The two upstream bugs are **drafted, not filed** —
  `docs/editor/upstream-milkdown-issues.md` waits on Justin, since filing posts
  publicly under the project's name.
- **No `docs/spec/` change** (M19). Milkdown is not the shipping editor yet, so
  the existing spec lines stay in force until the swap (bucket 2, D9); nothing in
  this work changes CM6's behavior.

## 3a. Wikilink plugin — survey result (T4 / #101)

The ticket required a survey before a line of plugin code: adopt a maintained
extension if one fits, build only if none does. **None does — built.**
Measured 2026-08-28 against Milkdown 7.22.1's own pipeline (remark 15, micromark
4, mdast-util-from/to-markdown 2), on two requirements: serialize `[[target]]`
back byte-for-byte, and tokenize exactly what `WIKILINK_RE` tokenizes.

| candidate | downloads/mo | verdict |
|---|---|---|
| `remark-wiki-link@2.0.1` | 89k | Parses under micromark 4 despite stale declared deps, but ESCAPES `*`, `_`, `[`, `\` inside the target on serialize — `[[a_b_c]]` returns as `[[a\_b\_c]]` (9/26 byte diffs), and splits on its `:` alias divider (3/26 target mismatches). |
| `@moritzrs/*-ofm-wikilink@0.0.1` | 5.7k | Obsidian semantics baked in: the node's value is the LAST path segment, `\|` and `#` split the target, `[[ x ]]` is rewritten to `[[x]]` (9/26 target mismatches). |
| `@flowershow/remark-wiki-link@4.0.0` | 3.4k | Publishes no `dist/` — the tarball is LICENSE + README + package.json. Cannot be imported. |
| `@portaljs/remark-wiki-link@1.2.0` | 2.4k | micromark 3 / mdast-util 1 generation; throws under Milkdown's pipeline (9/9). |
| `remark-wikirefs@0.0.12-rm` | 0.7k | Same generation gap; throws (10/10). |
| `mdast-util-wikilink-syntax@2.0.1` + `micromark-extension-wikilink-syntax@2.1.1` | 22 | Right generation, but parse-only — no `toMarkdown` export at all. 0 stars. |

Two findings decide it beyond the numbers. Every candidate implements Obsidian's
`[[target|alias]]` and `[[target#heading]]`, which `docs/spec/editor.md`
explicitly rejects — our rules treat the whole inner text as the target and the
Rust port pins that. And nothing on npm is version-current, maintained AND
round-trip-safe: the popular one is four years stale, the current ones are
single-author 0.0.x.

Adopting any of them would have split the wikilink grammar in two, which is the
failure mode that matters: the editor showing a chip the Rust rename rewriter
will not rewrite (a rename silently breaks the link), or the rewriter rewriting
text the editor showed as prose (a rename mangles the user's words).

So `src/features/editor/milkdown/wikilink/` states the grammar a third time and
`syntax.test.ts` locks it with a differential against `findWikilinks` — the same
shape as the TS↔Rust rule differential — over 34 hand-picked edges plus an
80-case cross-product. Registered in `scripts/drift-registry.json`.

## 4. Parity buckets (`docs/spec/editor.md`, ~155 behavior lines)

- **Bucket 1 — full parity required before replacement**: wikilinks (navigate, shortest-unique-
  suffix display, `[[` autocomplete over `setNotes`, rename integrity — **a wikilink remark
  extension + node/mark plugin is mandatory scope**: without it Milkdown escapes `[[x]]` to
  `\[\[x]]` on save, breaking a live feature), tags + tag bar, images (vault-relative render +
  native paste), checkboxes/interactive elements, toolbar surface on PM commands via shared
  `TOOLBAR_EXEC` (M10), fence syntax highlighting (maintained Milkdown/PM highlight plugin),
  saving/rename flows, editor-exit flows, Android IME spec behaviors, theming. Audit is
  line-by-line against the spec file so "done" is checkable.
- **Bucket 2 — renegotiated**: live-preview/decorated-source sections (marker reveal near caret is
  meaningless in WYSIWYG). Rewritten to describe the new model in a dedicated MR Justin reviews
  (D9). Until the swap lands, existing spec lines stay in force (ADR-0002).
- **Bucket 3 — new spec lines**: block drag, format-state toolbar highlighting, progressive-open
  behavior (§5), normalize-once semantics.

### Android drags the block, not a handle (2026-09-01)

Both native shells now mount the SAME Notion-style long-press block drag; the ⠿ gutter handle is the
desktop browser's gesture alone. `resolveBlockDragMode(nativeShell)` is the whole gate, so the
embed's own host flag decides and no user-agent sniff is left in it. Consequences worth recording:

- The only page a headless harness can load is `editor.html`, whose host flag is a hard-coded
  `nativeShell: true`, so the ⠿ path lost its harness. `blockDragMode.ts`'s test-only override was
  widened to force EITHER mode (`?blockDragMode=gutter-handle`), which is what the handle's
  touch-drag spec now uses.
- Measured on the reference phone (moto g play 2023, Android 13, System WebView 151): Chromium shows
  NO word highlight, selection handles, floating Cut/Copy action mode or magnifier over a lifted
  block, focused or unfocused. WebKit's whole `isTextInteractionEnabled` problem simply does not
  exist here — the page's own `selectstart`/`contextmenu`/selection defences hold. So the shell
  ignores `blockDrag` entirely.
- The one leak was haptic, not visual: the WebView fires its own `LONG_PRESS` buzz 128-141 ms after
  the editor's lift (its recogniser trips around touch-down + 480 ms against the 340 ms lift), so a
  pickup felt like a stutter. `EditorWebView.setBlockPressActive` turns the WebView's view-level
  haptics off for the press and the editor's own three opt past with `FLAG_IGNORE_VIEW_SETTING`; a
  long press the editor does not claim keeps its normal buzz.

## 5. Progressive open (the large-note story)

- Parse markdown in top-level-block chunks (blank-line splits, fence/reference-definition aware).
  Mount the first chunk immediately; stream the rest as idle-time appends. The cv stylesheet makes
  offscreen DOM cheap; chunking makes offscreen *parse* deferred.
- **Save lock (CRITICAL)**: while the tail is streaming, no save may fire and the load-echo guard
  holds — serializing a half-loaded doc writes a truncated file. Save unlocks only at
  full-doc-loaded. Needs a test with teeth: kill mid-stream, assert the file untouched.
- Chunk-append transactions are non-undoable and invisible to the change listener.
- **Equivalence proof**: `chunkedParse(doc) ≡ wholeParse(doc)` asserted across the 31k corpus
  (reference definitions and setext edges care about context); the census harness does this in
  minutes.
- Worker-thread remark parse is the second lever, only if measurement demands it.
- **Budgets**: time-to-interactive-first-viewport <1 s and keystroke p95 <16 ms, enforced on the
  low-end Android reference device (Justin's old phone) and desktop. At 50k-line/10 MB fixtures the
  assertions are "typing under budget" and "open scales linearly, no cliff" — not the 1 s gate.
  Justin's large personal note joins the fixtures (local, uncommitted). A loading affordance covers
  the streaming tail.
- Verify the cv stylesheet inside the real editor chrome on all three platforms early — nested
  scroll containers can change `content-visibility` behavior; the probe only proved a bare page.

### T8 outcome (#105, done)

Built as two modules under `src/features/editor/milkdown/`: `markdownChunks.ts` decides WHERE a
document may be cut, `progressiveLoad.ts` decides WHEN each piece reaches the editor.
`MilkdownEditor.svelte` wires them and owns the save lock. Notes under 400 lines — everything in an
ordinary vault — are untouched and load exactly as before.

**The equivalence proof.** `scripts/milkdown-chunk-census.mjs` (`just chunk-census`) drives the real
`editor.html` over the 31k-note corpus through a `?census` hook, comparing a chunked parse against a
whole-document parse of the same note at the FINEST granularity the planner allows — a cut at every
boundary it can find, ~15 chunks per note on average. Run against this ticket's own base (the chain
before T4/T5 landed): **25,344 notes took the progressive path and every one of them parsed
identically chunked and whole; zero divergent, zero crashes, all 30,995 notes processed**
(`docs/evidence/milkdown-chunk-census.md`). Six notes were abandoned by the loader mid-flight and are
excluded rather than scored as matches — for those it compared a whole parse against a whole parse,
which proves nothing.

**Re-run after the merge with T4/T5, and it found a crash that is not ours.** The wikilink, tag,
task-checkbox and fence-highlight plugins change the chain, so the census was re-run on the merged
branch. Still zero divergences — but 1,581 notes (5.1%) now fail to load at all: on
`feat/milkdown-editor` at 4b6cd5d4, with no progressive-open code present, `FutoEditor.initialize`
throws `Cannot close 'paragraph': a different token ('wikilink') is open` for any note whose line
ends in `!`. Minimal repro: `"!"`. Also `"hi!"`, `"# hi!"`, `"hi!\n\nmore"`; `"hi! there"` is fine.
The extension opens an embed token on the `!` expecting `![[` and never closes it. That is #101's to
fix — it breaks the epic's "the editor never refuses to open a markdown file" outright — and it is
recorded here because the census is what surfaced it.

**The criterion is met against TODAY's plugin chain, not the final one.** #105 asks for equivalence
"with the final compat plugin chain", and #99 — which replaces the preset's empty-line plugin and
adds the empty-link and bullet-number fixes — is still open. Re-running `just chunk-census` after
#99 lands is the outstanding half of this criterion; the report says so in its own text so a reader
of the numbers cannot miss it.

It got there by finding real bugs, none of which a hand-written test suite would have proposed:

- `trailing`'s placeholder paragraph was being carried along instead of consumed, leaving every
  streamed document one empty paragraph longer than the same note parsed whole (23 of the first 23
  divergences).
- The scanner lost "we are inside a list" at an indent-0 lazy continuation or an indented fence, so
  it cut loose lists in two — and two adjacent lists must be serialized with different bullets
  (`*` then `-`, `3.` then `3)`) or they merge back into one. 73 divergences.
- A backtick fence whose info string contains a backtick (```` ```toml` ````) is a PARAGRAPH in
  CommonMark; reading it as a fence opened one the scanner never closed.
- A fence opened inside a list item cannot be closed by a line at column 0.
- An empty list item (`- ` with nothing after it) means different things depending on the block
  above it, so a cut in front of one is never safe.
- 78 notes CRASHED the editor: `formatState` computed a mark range against `view.state.doc`, which
  is one transaction behind, and a chunk append is a doc-changing transaction that also moves the
  caret — so the range could point past the end of the doc it was evaluated against.
- A chunk holding only `<br>` parses to nothing (the preset's empty-line plugin removes the node
  and the chunk boundary took away its context). The loader now refuses a chunk that parses to
  nothing and reloads the note whole; root-causing that plugin stays **#99**'s job.

**The save lock is red-proved, not asserted.** Deleting both of its doors — the `progressive.loading`
early return in the change listener and the one in `getContent()` — turns
`killing the app mid-stream leaves the note file byte-untouched` red, along with the two in-memory
lock cases. That test writes a real file from a fake host that autosaves every `change`, then closes
the browser context mid-stream. Its first version did NOT have teeth: it closed the context within
milliseconds of chunk 0, before the change listener's own 200 ms debounce could have delivered
anything, so the file came back untouched whether the lock existed or not. It now sits mid-stream
for three debounce windows first.

**Two save-lock holes the tests found, both truncation:**

- Milkdown's listener serializes the document from the transaction that STARTED its 200 ms debounce,
  not the live one, and it ignores `addToHistory: false` transactions entirely — so the first
  `change` after a progressive open could carry the note as it stood mid-stream, arriving one
  debounce window after the lock lifted. The change path re-reads the live document for that one
  callback.
- "Did the user type while the tail streamed?" cannot be answered by classifying transactions: the
  preset re-stamps heading ids in a 125-step transaction after content lands, which reads as typing
  and would have rewritten every large note on open. It is answered by `undoDepth` against a
  baseline the component keeps in step with its own `resetHistory()`.

**Open budget, redefined and measured.** `performance.measure` entries
`futo:editor-open-interactive` (first chunk mounted) and `futo:editor-open-complete` (save lock
released) — ordinary platform entries, so Playwright, DevTools and a CDP session on a real phone all
read the same number. The desktop assertion lives in `tests/editor-embed-milkdown.spec.ts`;
enforcing the same measure on the low-end Android reference device is **#106**.

**Where the planner gives up, measured.** Of the 579 corpus notes past the 400-line threshold, 515
(88.9%) take the progressive path; the other 64 decline and load exactly as they did before
(37 carry a link-reference or footnote definition, which resolves document-wide, and 27 offer no
safe boundary at all). The first chunk's budget is 80 lines and the planner takes the first SAFE
boundary at or after it, so a note that offers none early gets a bigger first chunk than the budget
asks for: p50 86 lines, p90 139, but 6 notes of 515 over 500 and one at 2,700. Those few open no
worse than they do today — they just do not open better. Tightening that would mean cutting
mid-block, which is the one thing the census proves is unsafe.

**Not done here:** the spec lines. `docs/spec/editor.md` still describes the CodeMirror editor and
carries no Milkdown behavior at all — per D9 and ADR-0002 the existing lines stay in force until the
swap, and the new progressive-open lines belong to the spec-renegotiation MR (**#109**), which
should write them from this section.

### The one-paragraph note: measured, capped, then actually fixed (2026-09-01)

§5 said a note the planner declines "opens no worse than it does today". For one shape that was true
and useless: a note with **no blank line anywhere** could not be opened at all. A user's 50,000-line
note (~1.65 MB, every line a sentence) showed a blank editor body indefinitely, and because the iOS
shell cannot read a document that never mounted, Back answered "Couldn't read the latest note.
Navigation is paused while your changes remain pending." on every tap — force-quit or Delete Note
were the only exits. Reproduced on the simulator, 2026-09-01.

**The cost is not the note's size; it is the size of its largest INLINE CONTENT RUN.** Same 1.26 MB
in every row, measured against the shipped `editor.html` in chromium:

| fixture | `initialize` |
|---|---|
| 1.26 MB on ONE line (a single inline node) | 107 ms |
| 20k lines, blank line every 200 | 667 ms |
| 20k lines, blank line every line | 2,264 ms |
| 20k lines, no blank line anywhere (one run) | 7,796 ms |

**First answer, and the wrong one: a cap.** A note past ~4,000 lines / 256 KB in one run mounted a
bounded READ-ONLY preview with a notice saying the editor could not open it. It was safe and it was
fast and the maintainer rejected it on sight — correctly. A 4,280-line note is an ordinary pasted
transcript or log, the CodeMirror editor opens it without complaint, and "more than the editor can
open" is a capitulation with a friendly voice. Reverted the same day; the shell half of that lane
(Back always leaves, `.noLiveDocument` vs `.notOurs`) is independent and stays. Both native shells
now hold that rule: iOS in `editorExitBody` (57cc910a) and Android in the same-named Kotlin
function, whose capture answers `NoLiveDocument` when the bundle has not reported `initialized` or
the renderer does not answer inside a 6 s deadline — the Android trap is the deadline, because
`isReady` is app-lifetime state on the pre-warmed WebView and stays true while `setContent` blocks
the renderer.

**Second answer: make the parse fast.** Two candidate causes, both measured rather than argued.

1. **The hardbreak explosion — real, but NOT fixable this way.** `remarkLineBreak` splits every text
   node at every newline and inserts a `break` node, and the schema renders each as its own
   `contenteditable="false"` span: one paragraph of N lines becomes 2N inline nodes. Dropping the
   plugin took a 4,000-line paragraph from 7,999 inline nodes to 1 — and **destroyed the author's
   line breaks on the first edit**: `alpha\nbravo\ncharlie` saved back as `alpha bravo charlie`.
   The nodes are what make a soft break survive an edit. Not dropped; the cost stands.
2. **micromark's text resolver — fixed.** `resolveAllText` merges adjacent `data` events with one
   `events.splice()` per run, and every splice shifts the whole tail: quadratic in the number of
   runs, and a paragraph of single-newline lines produces one run per line. Patched to collect the
   removals and compact in ONE pass, in place (`patches/micromark@4.0.2.patch`, applied by pnpm;
   upstreamable as written).

| one paragraph | before | after |
|---|---|---|
| 4,000 lines (223 KB) | 481 ms | **163 ms** |
| 10,000 lines (557 KB) | 2,147 ms | **541 ms** |
| 20,000 lines (1.1 MB) | 4,819 ms | **1,622 ms** |
| 50,000 lines (2.8 MB) | 18,100 ms | **8,862 ms** |

**The first version of that patch corrupted text on 3,912 of 4,000 corpus notes.** It returned a new
array where upstream mutates in place, so callers holding the original identity processed the
unmerged events a second time and text duplicated, compounding on every round trip
(`Git plugin Documentation` -> `Git plugin Documentationplugin Documentation`). The census caught it
before it reached the branch; the in-place version is `0 flags cleared, 0 newly raised` against the
same 4,000 notes. This is exactly what the census is for, and the reason a dependency patch here is
not a free action.

**Still open.** 50,000 lines in one paragraph is 8.9 s, and the remaining cost is item 1: 99,999
inline nodes for that fixture, all mounted at once. Fixing it needs inline-level progressive mount
(append inline content into the SAME paragraph, which changes no block structure and so no bytes) —
not a cap, and not dropping the nodes. No note in the 31k corpus has that shape; the largest real
one-run note measured 4,280 lines, which now opens in ~0.2 s.

### T9 outcome (#106, partial — one budget is MISSED)

`just test-android-perf` builds, installs and drives the REAL native Android app on a physical
low-end phone, measuring inside the editor WebView over CDP. The budget policy lives in
`tests/lib/editorDevicePerf.mjs` (unit-tested, `evaluateDeviceFloor`), the device glue in
`tests/android-editor-perf.mjs`. The keystroke loop is byte-for-byte the desktop gauntlet's
`measureKeystrokes`, so the two floors time the same unit.

Reference device: **moto g play (2023), Android 13, System WebView Chromium 151** — `$ANDROID_SERIAL`
selects it, and the recipe refuses to run without one rather than silently measuring a desktop-class
emulator.

| Fixture | Shape | Interactive | Complete | Keystroke p95 |
|---|---|---|---|---|
| 1,000 lines | real-note shaped | **185 ms** ✅ | 1.6 s | **17.5 ms** ❌ |
| 10,000 lines | real-note shaped | **126 ms** ✅ | 25.5 s | **64.0 ms** ❌ |
| 13,877 lines | the maintainer's real note | — | — | — (**cannot open**, see below) |
| 10,000 lines | no blank line anywhere | 15.3 s | 15.3 s | 544 ms |
| 25,000 lines | no blank line anywhere | 45.9 s | 45.9 s | 1,446 ms |

**Interactive-first-viewport passes with room to spare** — 185 ms and 126 ms against a 1,000 ms
budget, on the device D7 named as the hard case. That is progressive open (#105) doing exactly what
§5 predicted, and it is the headline result. (Interactive is not monotonic in document size because
the first chunk is a fixed ~80-line budget either way; the difference between those two numbers is
noise, not scaling.)

**Open scales linearly on the phone too — no cliff.** Per-line time-to-complete is 1.53 ms at 10k
lines and 1.84 ms at 25k, a ratio of **1.20x** against a 2.5x cliff factor. The TipTap-shaped wall
D3 was chosen to avoid does not appear on a low-end device either.

**Keystroke p95 misses the budget at EVERY real-note size** — 17.5 ms at 1,000 lines and 64.0 ms at
10,000, against 16 ms. The 1,000-line number is the one that matters: §2's population study puts
every note in the maintainer's vault except one at ≤978 lines, so this is not a tail case, it is the
ordinary large note. It is a real miss against the acceptance criterion and it is **not** fixed here.

Two things are worth recording about how that number was obtained, because the first version of this
work reported 10.5 ms and passed. It was measuring the wrong document: the runner pushed its first
fixture before the shell's own `FutoEditor.initialize` had landed, the host then overwrote it with
the seeded one-line note, and a stale `futo:editor-open-complete` measure made the wait return
immediately — so the first fixture of every run reported the numbers of a 1-line note. The tell was
visible in the output and was missed: interactive exactly equal to complete, a signature no chunkable
fixture can produce. The runner now waits on the host's own load and then VERIFIES that the document
on screen is the fixture it asked for, which is the guard that turned the false pass red.

What was ruled out as the cause of the keystroke cost: our own decoration plugins, which
`blockDecorations.ts` already bounds to the transaction's changed ranges. Two attribution attempts
failed and are written down so the next person does not repeat them — a device CPU profile was
dominated by ONE 200 ms-debounced whole-doc serialization (background work, not keystroke work), and
a per-plugin `reconfigure` ablation had a ±25 ms noise floor, larger than most per-plugin effects.
Attribution needs a sourcemapped bundle or a plugin-by-plugin build, which is its own ticket.

**The 50k rung §5 quotes is opt-in (`--stress`), and that is a cost decision.** On the reference
phone a 50k unchunkable document did not finish its leg inside 20 minutes: the open is a whole-
document parse and each settled-to-paint keystroke sample costs tens of seconds at that size, with
the renderer at 560 MB on a 2.8 GB device. The default ladder proves the same no-cliff property on
the 10k→25k ratio — the check is a ratio, so the rungs are interchangeable — and `--stress` adds 50k
for anyone who wants §5's exact number. A default run costs ~25 minutes on the reference phone.

**The fixture shape turned out to be load-bearing, and the first version of this work got it wrong.**
The desktop floor's `lineFixture` has no blank line anywhere, so `planMarkdownChunks` declines it
(`no-boundary`) and it loads whole — 15.3 s on this phone. Holding it to a 1 s
interactive-first-viewport budget asks progressive open for something it structurally cannot deliver,
and §5 already says those notes "open no worse than they do today". The device ladder therefore has
two generators, differing in exactly one property (block separation): `blockFixture` carries the
interactive budget, `lineFixture` carries the scaling/cliff assertion. Both facts are asserted in
`editorDevicePerf.test.mjs` so the reasoning cannot rot into a comment nobody trusts.

**The maintainer's real note still cannot be opened at all** — the local uncommitted fixture
(13,877 lines) fails with #101's `Cannot close 'paragraph': a different token ('wikilink') is open`,
the same crash §5's census recorded for any note whose line ends in `!`. The runner scores this as a
`load-failure` violation and exits red rather than reporting "every budget held" over a document that
never loaded (M11). So the criterion "budgets proven on the maintainer's largest real note" is
**blocked on #101**, not on anything here.

**Containment verified in the real editor chrome on Android and desktop, NOT on iOS.** The rule
(`.ProseMirror > *`, `content-visibility: auto` + `contain-intrinsic-size: auto 24px`) lives in
`MilkdownEditor.svelte`, and both probes assert the same three things: the computed style is live,
the caret can be driven into a rendering-skipped region, and the block it lands in is REAL rendered
content rather than a `contain-intrinsic-size` estimate.

- **Desktop** (`tests/editor-embed-milkdown.spec.ts`, chromium over the shipped `editor.html`) —
  passes, and red-proved by deleting the rule.
- **Android** (the phone, inside the real Compose chrome) — passes. Two facts the bare-page probe
  could not have given: the scroll container really is `.ProseMirror` itself (clientHeight 742,
  scrollHeight 184,209 over 5,000 top-level blocks), so the shell's chrome introduces no competing
  scroll container; and the caret's block renders at its true 27 px rather than the 24 px estimate.
- **iOS** — covered on 2026-08-31, and the answer is that the rule cannot run there. See below.

### Containment is OFF on Apple WebKit (2026-08-31, the outstanding iOS leg)

WKWebView does not merely render the rule differently — it drops text on the floor. Scrolling a
40-paragraph note in the real iOS app, recorded off the simulator's display pipeline (`xcrun simctl
io recordVideo`, so no screenshot could force a repaint and hide it), left **seven frames whose
topmost visible paragraph was mid-document with 127–327 px of blank above it**: the previous
paragraph kept its box in the flow and painted nothing, and the hole stayed while the view was
still, filling in on some later scroll. That is the user report "some text will appear to be gone
and then mysteriously re-appear".

Nothing on the page can see it: the DOM reports every block present at full height, and
`checkVisibility({ contentVisibilityAuto: true })` calls them all visible. It does not reproduce in
Playwright's WebKit (whose scrolling is not the async, tiled iOS one) or in Chromium — this is the
UI-process compositor.

So the rule is engine-gated rather than dropped (`src/features/editor/milkdown/blockContainment.ts`,
applied as `.futo-milkdown.block-containment`): Chromium — Android's WebView, where §5's budgets
were measured, and every desktop/web surface — keeps it, and Apple WebKit renders every block
eagerly. iOS therefore has no containment perf property, and if keystroke cost at real note sizes
ever needs one there, it has to come from something WebKit paints correctly (an
IntersectionObserver-driven window that sets `content-visibility: visible` well before a block
enters the viewport is the obvious candidate — it never asks WebKit to decide relevance for
on-screen content). Blank text is not a trade worth making for a perf budget.

The measurement is repeatable: the OCR oracle counts frames whose visible paragraph numbers skip
one, or that start mid-note with a band of blank above the first line (0 after the gate, 7 before).

> **Open item (Android), carried to #111:** on the phone, the FIRST `scrollIntoView` to the far end of a 10k-line note
> lands ~350 px short and leaves the caret's block just below the fold; a second scroll against the
> settled layout reaches it. The cause is inherent to the containment rule: blocks render as the
> scroll approaches them, each 24 px estimate is replaced by its real height, and the content grows
> underneath a scroll that was computed against the estimates (scrollHeight moved 184,209 → 184,405
> mid-scroll). Desktop chromium needs no second pass. The runner gates on the settled state — what a
> user is actually left looking at — and reports the first-scroll result beside it, so a regression
> in either is visible. Whether the editor should issue that corrective scroll itself is a product
> question for the swap (#111), not a harness one.

## 6. WebView floor

Run the editor down the existing Chromium tier ladder (start at `futo-api30` / Chromium 83 — see
the emulator-tier notes in memory/github#8 history). Set the floor where it actually breaks; show
the existing update-WebView notice below it. If the floor would rise above currently-supported
devices, stop and ask Justin (support-surface change).

### T10 outcome (#107, done)

**The floor stays at Chromium 80** — the github#8 support surface is unchanged, so nothing needed
Justin's call. Two things had to be fixed to keep it there.

Measured on the three tier-ladder AVDs, each a real System WebView:

| AVD | Android | WebView | Milkdown |
|---|---|---|---|
| `futo-api28` | 9 | Chromium 66 | update-WebView notice (ES2020 preflight) |
| `futo-api29` | 10 | Chromium 74 | update-WebView notice (ES2020 preflight) |
| `futo-api30` | 11 | Chromium 83 | **runs** — render, dark theme, IME typing, toolbar exec, byte-exact round-trip |

Two limits on that ladder, stated rather than papered over. **83 is the lowest
engine that runs at all** and no stock image ships 80–82, so the bottom three
versions of the supported range are reasoned, not measured — sound for the
built-in shims (the method simply does not exist below 92) and untested for CSS.
And **the audit is JS built-ins only**: the bundle's Tailwind output uses `:is()`
/ `:where()` / `aspect-ratio` (Chromium 88) and `color-mix()` (111), which
degrade rather than throw — Chromium 83 rendered every block type correctly,
including dark-theme text at `rgb(250, 250, 250)`, which is the evidence there is.

**1. Milkdown raised the runtime floor to 92, silently.** `@milkdown/transformer@7.22.1` calls
`Array.prototype.at` (Chromium 92) in its serializer stack and its mark-merge pass — every parse
and every save. On Chromium 83 that is `TypeError: this.elements.at is not a function` and a blank
editor pane. The bundle's ES2020 *syntax* target says nothing about this, which is the same trap
`Element.replaceChildren` (86) set during github#8. `editor.html` shims it beside the existing
`replaceAll` shim (non-enumerable, so nothing's `for…in` over an array changes), and
`tests/editor-embed-webview-floor.spec.ts` now holds the whole floor: it deletes each shimmed
built-in and proves the editor still runs, and audits the BUILT bundle for post-floor built-ins no
shim covers.

**2. The update-WebView notice had stopped working, and would not have come back on its own.**
On Chromium 83 the pre-shim build showed a blank pane and *never* showed the notice. Both halves of
the Android gate treated "the bundle is running" as "the editor is up", which CodeMirror made true
by mounting synchronously and Milkdown makes false by creating its editor asynchronously:
`window.FutoEditor` is published, and the bridge `initialized` reply is sent, whether or not
`Editor.make().create()` succeeded behind them. The editor now publishes
`window.__futoEditorMounted` itself (`src/editor-embed/main.ts`, drift-registry
`editor-mounted-global`); `ENGINE_PROBE_JS` reads that, and `initialized` is no longer a shortcut to
`markEngineBooted`. Verified on the device: the same unshimmed build that showed a silent blank
pane now shows the notice, naming Chromium 83 and the provider version.

The notice is recoverable, not latched. Dropping the `initialized` shortcut also dropped the one
thing that could clear a failure a slow boot had earned, so `EditorWebView` now re-probes on any
inbound bridge message while a failure stands (`rescueEngineVerdict`) — it can only ever clear one,
because the probe stays the authority. Reopening the note re-focuses the editor, which posts, which
is exactly the recovery the notice's own "then reopen the note" promises.

Also fixed while there: Milkdown's mount was an unhandled promise rejection, so an engine that
could not start left nothing anywhere. It logs now — which is how the `.at` failure was named on
the device.

Out of scope, found and left alone: `applyExternalContent with unchanged content preserves the
selection` (`tests/editor-embed-milkdown.spec.ts`) is **flaky on this branch already** — 3 failures
in 8 runs with T10's changes stashed. The caret sometimes lands at the end of the document instead
of where it was, which as a product behaviour is a sync echo moving the user's cursor mid-typing.
Worth its own ticket.

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

## 8. Rules that bind

- M5: serialization off the keystroke path — `getMarkdown()` is whole-doc (~210 ms at 14k lines);
  saves stay debounced/background.
- M6/M7: compat plugins carry the recorded carve-out (§3.7); the wikilink *rules* (resolution,
  shortest-suffix) remain the existing conformance-locked mirrors — the plugin consumes them.
- M8/M10: bridge and toolbar changes follow `packages/editor/AGENTS.md`; both native hosts per
  message; regenerate specs.
- M19: spec travels with the swap (bucket-2 MR).
- §11 stop-and-ask list unchanged — sync payload/`BRIDGE_VERSION`/`AppState` changes still ask.

## 9. CRDT rebind seam (design constraint now, work later)

Keep everything that feeds markdown strings in/out of the editor behind the engine-wrapper seam
(`MilkdownEditor.svelte` + `createFutoEditorApi`), so the later swap to a y-prosemirror-bound Ydoc
(ADR-0003) replaces the content plumbing without touching plugins, toolbar, chrome, or the bridge
surface. Prior art to read before that campaign: branch `origin/collab-spike`,
`~/Developer/stonefruit-collab-spike`.
