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
  Android mounts the gutter-handle drag and never emits it.
- Toolbar parity gaps found by the suite, all **#104**: `link` with an empty selection does nothing,
  `indent` needs a preceding sibling item, and list markers serialize as `*` rather than `-`.
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
3. **Bullet-number escape**: the pre-parse string pass stays (`* 0. item` → `* 0\. item`) — remark
   transformers run post-parse, after CommonMark has already resolved the ambiguity into a nested
   list. Same skip-fences/inline-code rules as the parked WIP.
4. **Canary tests**: pin the Milkdown version; a test reproduces each upstream bug against the
   *unpatched* preset so the day upstream fixes it the canary flips and the fork gets deleted.
   Register the fork in `scripts/drift-registry.json` if `check-drift` flags it.
5. **Upstream**: file the `<br>`-deletion and empty-link bugs against Milkdown with the minimal
   repros from the census report.
6. **M6 carve-out**: these transforms are Milkdown-implementation adapters, not note rules — no
   Rust mirror. Record the carve-out in `packages/editor/AGENTS.md` when the module lands.
7. **Re-census** after the rewrite: full foreign corpus + a second leg over Justin's real vault
   (local, never committed). Diff against `corpus-results-baseline.jsonl` (regenerated baseline on
   the spike). Target: the two real-loss classes at zero, zero new regressions, the 16
   uninvestigated `html_loss` notes dispositioned. Per D4 this is tracked, not gating — but the
   report is a required deliverable (`spike-notes` successor doc or `tests/` local artifact).

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
boundary it can find, ~15 chunks per note on average. Final run: **25,344 notes took the progressive
path and every one of them parsed identically chunked and whole; zero divergent, zero crashes**
(`docs/evidence/milkdown-chunk-census.md`). Six notes were abandoned by the loader mid-flight and are
excluded rather than scored as matches — for those it compared a whole parse against a whole parse,
which proves nothing.

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

## 6. WebView floor

Run the editor down the existing Chromium tier ladder (start at `futo-api30` / Chromium 83 — see
the emulator-tier notes in memory/github#8 history). Set the floor where it actually breaks; show
the existing update-WebView notice below it. If the floor would rise above currently-supported
devices, stop and ask Justin (support-surface change).

## 7. Rollout and teardown

1. **Dogfood gate**: dev builds (`com.futo.notes.dev`) on Justin's phone, the old Android phone,
   and desktop, against a copy of his real vault, for real writing over days–weeks. This is also
   the de-facto IME exposure (D8) and the normalize-once shakedown on notes he cares about.
2. **Release**: simultaneous three-platform big-bang. Mixed-fleet window is safe by construction:
   CM6 never rewrites bytes, so normalization flows one way and settles; no ping-pong.
3. **Teardown, same MR chain as the CM6 deletion** (not before, not lingering): CM6 editor path,
   `liveMarkdownTransform`, CM6 scroll compensation, the factory/Obsidian judge harness, the
   markdown-spec harness (mine its cases into plugin tests first). The editor gauntlet **stays** as
   the regression suite, with tier-3 byte-diff assertions relaxed to loss-only per ADR-0002.
4. The P1 intent compiler (bake-off graduate, never merged) is not productionized; bake-off §12
   items are void.

## 8. Rules that bind

- M5: serialization off the keystroke path — `getMarkdown()` is whole-doc (~210 ms at 14k lines);
  saves stay debounced/background.
- M6/M7: compat plugins carry the recorded carve-out (§3.6); the wikilink *rules* (resolution,
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
