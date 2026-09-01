# Rich-Text Editor Bake-off — Five Approaches, One Contract

> **Status: WRAPPED 2026-08-25 — P1 is the sole graduate; P2/P3/P4/P5 were
> killed by their predeclared metrics. Both exhaustive existing-editor baselines
> and the non-causal Step 0 census are complete. Long post-verdict/current-HEAD
> characterizations were stopped without aggregates at Justin's request after
> host contention made the six-hour jobs impractical; §12 records the bounded
> next work. Criteria below were fixed before any experiment ran.** Created
> 2026-08-24 from a design discussion with Justin.
> The goal is a rich-text editing experience that keeps this project's
> file-over-app promise: the user's markdown file stays authoritative, and the
> app never tells them their markdown is formatted weird.
>
> **Update 2026-08-27: the Tier-3 "diff discipline" criterion (§1) and the §4
> rejection-without-probe of Milkdown/Lexical are SUPERSEDED by
> `docs/adr/0002-roundtrip-normalization-accepted.md` (Justin) — round-trip
> normalization is now acceptable, so tree-owned editors are back on the
> table. Do not cite this doc to block that work. Tiers 1–2 (never refuse,
> never warn — extended by the ADR to never LOSE content) still bind, as does
> the ADR's one-serializer-everywhere rule. The verdicts and measurements
> below remain valid historical evidence under the criteria as they stood.**
>
> This is a sibling of `docs/plan/editor-decision.md` (the native-vs-CM6
> decision, DEFERRED 2026-07-17 — CM6 ships everywhere for now). This doc does
> NOT reopen that decision. Approach 5 below overlaps with it; if Approach 5
> graduates, the result feeds that parked decision as new evidence. Unparking
> it is Justin's call, not an agent's (AGENTS.md §11.5 — changing specified
> intent).

## 1. The requirement (the contract every approach is scored against)

Three tiers, in order of severity. These are the fixed pass/fail criteria.

1. **Never refuse.** Every markdown file opens editable. No modal, no blocked
   save, no whole-note "source-mode only" degradation.
2. **Never warn.** No user-facing message in any wording that means "your
   markdown is formatted weird" — no banners, no per-note error states, no
   recovery-draft flows triggered by ordinary editing.
3. **Diff discipline.** Saving after an edit changes only the bytes the user
   actually touched. Untouched content is byte-exact, including whitespace,
   escapes, marker style (`__` vs `**`, `1)` vs `1.`), and LF/CRLF. Silently
   re-spelling an _edited_ block (autolink → inline link, table re-padding,
   list-marker normalization) is a **soft violation**: the user finds out
   later via git diff or sync churn, which is the same insult delivered
   quietly. The measured TipTap branch does this on 18.94% of edits — that
   number is the anti-goal.

Tier 1 and 2 violations are hard kills. Tier 3 is scored (percentage of edits
whose diff exceeds the touched region); the bar is ~0% for the common-construct
set, with any residue enumerated and justified per construct.

## 2. The reframe that shapes everything

The motivating CM6 bug — bold two words, put the caret in the middle, press
Enter, rendering breaks — is a **source-integrity bug, not a rendering bug**.
The editor writes `**bo⏎ld**` into the file; that genuinely is not bold in
CommonMark; live preview then renders the broken source faithfully.

The missing piece is a layer that compiles the _intent_ ("split this
paragraph") into well-formed markdown (`**bo**⏎⏎**ld**`). The
`codex/tiptap-desktop` branch already emits exactly that for the same
keystroke (locked in `tests/tiptap-desktop-roundtrip.spec.ts`, "Enter inside
bold serializes only the edited paragraph region").

**Consequence: every approach must own "edits never produce malformed
markdown." That obligation is orthogonal to which model owns the document** —
it exists whether truth is a source string, a token stream, or a semantic
tree. The approaches differ in where that layer lives and what it costs.

## 3. What we already know (evidence log)

| Evidence                                                                                                                                                                                                                                                                                           | Source                                                                                                                                      | Bears on                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| TipTap experiment: untouched blocks byte-exact (594-edit sweep, 0 defects), but 0.38% of edits refuse to save, 1.19% of notes contain a refusing block, 5/2,608 notes (0.19%) open `exact-only` where every edit fails closed                                                                      | branch `codex/tiptap-desktop`, `src/features/editor/tiptap/localizedMarkdownEditSweep.test.ts`, spec `docs/spec/editor.md` (TipTap section) | Tree-owned truth fails tier 1/2 without further work                                                                       |
| TipTap: 18.94% of real-vault edits rewrite the edited block beyond what was typed (11,131-edit census)                                                                                                                                                                                             | same branch, `tiptap/vaultMeasurement.test.ts`                                                                                              | Tier-3 soft violation is structural to serialize-on-save                                                                   |
| TipTap: open cost is super-linear — 73 ms @1k lines, 5.5 s @10k, 210 s @50k; 10 MB fixture ≈ 21 s                                                                                                                                                                                                  | same branch, `tiptap-large-note-performance.spec.ts`, GAPS.md                                                                               | Whole-note parse into a tree has a perf wall                                                                               |
| TipTap's exact-source sidecar (`tiptap/localizedMarkdown.ts`) already builds a source↔block map with stable anchors, trailing-run attribution, and reference-definition handling                                                                                                                   | same branch                                                                                                                                 | Reusable asset for Approaches 2 and 4 regardless of TipTap's fate                                                          |
| CM6 live preview breaks visually when an edit splits an inline construct (the bold/Enter case, reported by Justin)                                                                                                                                                                                 | user report, 2026-08-24; now regression-locked in the durable gauntlet                                                                      | The split-torture baseline is 14/56; P1 raises its fixed target matrix to 32/32                                            |
| Rust engine `crates/futo-notes-editor`: source-owned projectional editor, 268/268 markdown-spec fixtures headless; region-scoped reveal (tap table cell → grid dissolves to pipes → edit → re-render); widget spikes green on Android (per-line ReplacementSpans, no overlays) and iOS (TextKit 2) | branches `worktree-gpui-desktop-rewrite`, `poc/full-native-editors`; `docs/plan/editor-decision.md` §2                                      | Approach 5 is partially proven; parked, not killed                                                                         |
| A 31k-note foreign corpus exists: `~/Developer/futo-notes-ml/dataset/` — 30,995 human-authored notes, 18.2M tokens, 58% Obsidian Publish / 34% GitHub / 8% HF                                                                                                                                      | `futo-notes-ml` README + DATASET_CARD.md                                                                                                    | 12× the reference vault, and it is _other people's_ markdown — the actual file-over-app scenario. See §6 note on licensing |
| Obsidian ships an excellent live-preview editor on CM6                                                                                                                                                                                                                                             | factory/ judge harness exists to diff against it                                                                                            | CM6 presentation ceiling is high; the bold-split class is fixable in principle                                             |

## 4. The candidates

Five approaches. Each entry states the document model, why it can satisfy the
contract, what exists already, and the kill condition its probe targets.
Approach 1 is the incumbent evolution and fully reversible; the burden of
proof rises with distance from the shipping stack.

### Approach 1 — CM6 + intent compiler on source

Markdown text stays the only document. Add a semantic command layer: a CM6
transaction filter that recognizes edits which would break a construct
(Enter/Backspace/paste across an inline mark, wikilink, code span) and
rewrites the transaction into well-formed source before it lands. Pair with
marker auto-heal (typing inside a bold span keeps the span; deleting one `*`
of a pair removes both).

- **Contract:** tiers 1–3 hold by construction — source is never serialized.
  The open question is purely presentation quality.
- **Exists already:** the whole markdown-spec fixture system, the factory
  judge, `packages/editor` hot-path rules. Smallest delta from today; works
  in all three shells unchanged.
- **Kill condition:** whack-a-mole. If passing the split-torture matrix
  requires N bespoke rules with no shared mechanism (rule count grows
  linearly in constructs × operations), the approach does not scale.
  Secondary ceiling: markers still reveal near the caret — decorated source
  may never read as "rich text" to the target user.

### Approach 2 — Block-projectional hybrid: rendered blocks, one live edit region

The document is the source string plus a block map (reuse the sidecar's map
from `codex/tiptap-desktop`, minus ProseMirror). Inactive blocks render as
pure HTML projections of the token stream — never re-serialized, so arbitrary
syntax survives untouched by construction. The block under the caret mounts a
real editor (a per-block CM6 instance) over that block's source slice. Where
the block map cannot be built, that block quietly edits as source — per-block,
no banner. The Typora/Bear family, with the file kept authoritative.

- **Contract:** serialization never happens anywhere; worst case for exotic
  markdown is "this one block edits as source," which is tier-1/2 clean.
- **Exists already:** the block map, the live-preview render pipeline, CM6.
- **Kill condition:** feel at the seams. Caret crossing a block boundary
  flips modes; a flicker or a 1-pixel layout shift reads as broken.
  Cross-block selection/drag and IME composition across a boundary are the
  known-hard parts — test them first, not last.

### Approach 3 — TipTap fail-open: verbatim islands

Keep the `codex/tiptap-desktop` architecture but invert every failure. A
block the model cannot own becomes an atomic verbatim node: rendered as a
faithful preview, byte-exact on save, tap-to-edit via an inline source
micro-field. A note whose block map fails degrades per-block instead of the
current whole-note `exact-only` mode. The reparse-and-compare guard stays,
but a refusal converts the block to a verbatim island instead of blocking the
save. Separately: fix serializer escaping upstream to push the 18.94%
edited-block rewrite rate toward 0, and prototype block-local incremental
lexing against the super-linear open.

- **Contract:** tiers 1–2 become satisfiable. Tier 3 is structural risk: as
  long as saving means "serialize the semantic tree for the edited block,"
  some rewrites are inherent.
- **Exists already:** most of it — sidecar, anchors, recovery machinery, two
  test suites, a census harness.
- **Kill condition:** the residual silent-rewrite rate after serializer fixes
  stays material on the common-construct set, or block-local incremental
  lexing proves impossible while the sidecar requires the whole token stream.

### Approach 4 — TipTap as pure renderer, source as document (transaction→patch mapping)

Never serialize TipTap at all. The rich document is a _view_; every
ProseMirror transaction (insert text, split node, toggle mark) is mapped at
input time into an exact source patch via a bidirectional position map
maintained per block down to inline level. The user edits TipTap's mature
surface — selection, IME, history, tables — but the file is only ever
modified the way CM6 modifies it: by text patches.

- **Contract:** all three tiers hold _if the mapping is total_, because
  markdown is never regenerated from the tree.
- **Exists already:** the block-level half of the map (the sidecar); the
  inline-level half does not exist and is the hardest code in this space.
- **Kill condition:** any transaction class whose source patch is ambiguous
  (e.g. "lift list item" in a list mixing task and plain items). One
  ambiguous class found by the fuzzer is the kill signal — do not rationalize
  it away with a normalization fallback, because that fallback IS Approach 3.

### Approach 5 — Rust engine, rehosted: projectional editing over source, everywhere

`crates/futo-notes-editor` already is a source-owned projectional editor with
region-scoped reveal and a proven widget model (see §3). Two hosting
variants: (a) the parked native renderers (TextKit 2 / EditText / gpui);
(b) **compile the engine to wasm and let it drive a DOM renderer inside the
existing WebViews** — one engine on all three platforms without the gpui bet,
and it satisfies the Rust-owns-the-domain rule (M6) instead of straining it.
The probe below targets only variant (b); variant (a) is the parked
editor-decision and is out of scope here.

- **Contract:** same reason as 1 and 2 — source truth, projection rendering —
  with the projection written once in Rust.
- **Exists already:** the engine, 268/268 fixtures, both mobile widget
  spikes, the interaction-judge harness.
- **Kill condition:** keystroke latency through the wasm boundary, or IME
  composition correctness in the WebView DOM surface. Scope honesty: even a
  green probe leaves the parked ship-gates (widgets-on 10k perf, keyboard
  matrix, a11y) as the real bar.

### Rejected without a probe: buy an existing library

Surveyed once, recorded so it isn't re-litigated: Milkdown and Lexical are
tree-owned (same class as TipTap, same tier-3 problem). Typora and Obsidian's
live preview are closed source. MarkText/Zettlr are the block-hybrid family
but effectively unmaintained. There is no maintained, source-owned, rich
markdown editor to buy. A half-day re-verification of this claim is permitted
before probes start; anything longer is waste.

## 5. The shared gauntlet (build once, run against everything)

One harness, four components. It outlives the bake-off: whichever approach
wins keeps the gauntlet as its regression suite. Suggested home:
`tests/editor-gauntlet/` (corpus-derived fixtures generated locally and
gitignored — see §6 licensing note).

1. **Split-torture matrix.** Scripted edits at every inline-construct
   boundary: {bold, italic, strike, inline code, double-backtick code span,
   wikilink, markdown link} × {Enter mid-span, Backspace joining two blocks,
   paste across the boundary, type at the marker edge}. ~60 cases, seeded
   from Justin's bug report. Each case asserts three things: (a) the saved
   file is well-formed markdown whose meaning matches the intent, (b) the
   rendering never shows broken state, (c) undo restores the prior source
   byte-exactly.
2. **Foreign-file preservation sweep.** For each corpus note: open, walk the
   caret through it, make one edit per block, save. Assert tier 1 (zero
   refusals), tier 2 (zero warnings), tier 3 (byte-diff confined to edited
   blocks; report the rewrite rate). Template:
   `src/features/editor/tiptap/vaultMeasurement.test.ts` on the TipTap
   branch.
3. **Perf floor.** Open time and keystroke p95 at 1k / 10k / 50k lines plus
   the existing 10 MB adversarial fixture. Budgets already in the repo:
   typing under ~16 ms per keystroke, open under 1 s.
4. **Feel oracle.** The factory/Obsidian judge (`just factory-judge`) for
   whatever subset the prototype renders. Not a pass/fail gate — a divergence
   report a human reads.

A fixed probe kill ends qualification: later common-stack work cannot resurrect
the candidate and is not a remaining gate. Already launched sweeps may finish as
post-verdict characterization. P4 is a transaction-to-patch mapping module, not
a standalone editor surface, so the UI foreign/performance/feel drivers are
structurally inapplicable; its real-transaction fuzzer is its public-surface
discriminator. P3's literal census rerun remains required because it is part of
P3's declared probe scope, even though its two earlier kill conditions already
fixed the verdict. P5's three-case no-Obsidian run is only a driver smoke, not a
feel oracle; its common feel round was short-circuited after the fixed
performance kill.

## 6. Step 0 — corpus census (run FIRST; ~1 day; re-prices everything)

Point the TipTap branch's census harness at `futo-notes-ml`:

- Input: `~/Developer/futo-notes-ml/dataset/notes_corpus.jsonl.gz`
  (30,995 notes; `dataset/sample.jsonl` for schema eyeballing).
- Measure, per note: block-map failure rate, refusal rate, exact-only rate,
  edited-block rewrite rate, and a **histogram of which constructs cause
  each**. The same numbers the 2,608-note vault census produced, on 12× the
  data — and on _foreign_ files, which is the population that matters.
- Also run the corpus through the CM6 parse/render path and count where
  today's live preview mis-renders (the factory judge's neutral-theme visual
  diff can sample this).

Why first: if wild markdown is 5–10× weirder than the reference vault
(likely — Obsidian Publish notes carry callouts, footnotes, embedded HTML,
dataview blocks), tree-owned approaches (3, and 4's mapping coverage) get
repriced downward before anyone spends two weeks on them. If it is _tamer_,
Approach 3's residue may be acceptable. Either way the histogram tells
Approach 1 exactly which constructs its intent rules must cover.

**Licensing note:** the corpus is public-web harvested. Read
`futo-notes-ml/NOTICE.md` before redistributing anything derived from it.
Using it as a local test corpus is fine; do NOT commit corpus-derived
fixtures into this repo without checking provenance — generate them locally
and gitignore them.

## 7. Baselines (run SECOND; ~2–3 days)

Run the split-torture matrix against the two existing editors before any new
code:

- **Current CM6** (main): quantifies today's pain as a number instead of an
  anecdote, and turns the bold-split report into failing regression cases.
- **Current TipTap branch** (`codex/tiptap-desktop`, worktree at
  `~/Developer/futo-notes-tiptap-desktop`): expected to pass most of the
  matrix (its Enter-inside-bold behavior is the reference), giving the
  quality bar the winner must meet. Note the branch is ~698 commits behind
  main; run it in its own worktree, do not rebase it for this.

## 8. The probes

Each probe is timeboxed at 1–2 weeks, targets the approach's most-likely
kill, and ends in one of three verdicts (same discipline as
`editor-decision.md`): **graduate** (kill condition did not fire; approach
stays in the pool), **kill** (condition fired with no named, bounded fix), or
**iterate** (condition fired but the fix is named and bounded — re-run once;
a second fire on the same probe is a kill, per the two-strikes rule in
AGENTS.md §11).

| #   | Probe                     | Scope (deliberately minimal)                                                                                                                                                                               | Kill metric                                                                                                                                                                                                                                                                               |
| --- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | CM6 intent compiler       | Enter + Backspace + paste for bold/italic/inline-code only, as a transaction filter; no toolbar work                                                                                                       | Rule count/shape: a small shared core + per-construct data = graduate; N bespoke rules with no shared mechanism = kill. Secondary: undo granularity surprises (auto-heal must undo as one step)                                                                                           |
| P2  | Block hybrid              | Inactive blocks rendered by the existing preview pipeline; ONE CM6 instance mounted into the active block; desktop only                                                                                    | Caret-crossing must complete within one frame with zero layout shift; IME composition across a block boundary must work; cross-block selection must be _implementable_ (design on paper accepted, demo preferred). Any of the three failing unfixably = kill                              |
| P3  | TipTap fail-open          | Convert refusals → verbatim islands; kill `exact-only`; rerun the §6 census on the branch                                                                                                                  | Residual silent-rewrite rate on edited blocks after serializer fixes stays material on the common-construct set = kill. Separately probe block-local incremental lexing; impossible = kill for large-note viability                                                                       |
| P4  | Transaction→patch mapping | Inline position map for ONE family only (paragraphs with bold/italic/links); drive real TipTap transactions through it; fuzz: random transactions → patch source → reparse → diff reparsed doc vs live doc | One ambiguous transaction class found by the fuzzer = kill. No normalization fallback allowed (that fallback is Approach 3)                                                                                                                                                               |
| P5  | Rust engine wasm rehost   | Compile the engine's buffer/parse/decor/reveal layers to wasm; drive a bare DOM surface in the desktop WebView; typing only, no widgets                                                                    | Keystroke p95 through the wasm boundary blows the 16 ms budget = kill. IME composition incorrect in the DOM surface = kill (the repo's known WebView IME traps are the test list). Prior wasm work: see memory notes on MR !172 (`poc/wasm-rules-single-source`) for build/bundling traps |

## 9. Sequencing and elimination

```
Step 0 census (1 day)
  → Baselines (2–3 days)
    → P1 + P2 in parallel        (cheapest, both source-owned, P2 reuses the sidecar map)
      → P4                       (the wildcard: TipTap feel without TipTap's serialization sin)
        → P3 only if P4 dies     (its best case still soft-violates tier 3)
      → P5 whenever Mac/wasm bandwidth exists (strategic info about the parked
                                  native direction; not on the critical path)
```

Elimination rules, fixed now:

1. A tier-1 or tier-2 violation with no named bounded fix kills the approach.
2. Tier 3 is a score, not a binary — but an approach whose _best case_
   soft-violates tier 3 (currently: Approach 3) loses any tie against one
   that satisfies it by construction.
3. Two probes surviving is the expected end state. The tiebreaker round is a
   feel bake-off: both prototypes implement the same three user stories
   (write a note with bold/lists/table; edit a foreign corpus note; the
   bold-split scenario) and Justin drives both. Numbers eliminate; feel
   decides among survivors. Feel is Justin's call, never an agent's.
4. If P1, P2 and P4/P5 all survive, note the convergence: approaches 2, 4,
   and 5 all reduce to "who owns the block map and the projection." That
   shared piece becomes the deep module to design first — small interface
   ("apply this intent, return exact source changes"), everything else behind
   it — and the remaining choice is renderer technology, not architecture.
5. Every probe verdict is appended to §11 of this doc with the evidence
   (exact commands and numbers, plus screenshots where they are probative and
   privacy-safe), same as the editor-decision log. A verdict may reference a
   candidate-local README or ignored artifact rather than duplicating it here,
   but the revision and evidence path must be explicit.

## 10. Practical pointers for the executing agent

- **Worktrees:** the Step 0 TipTap census is
  `~/Developer/futo-notes-tiptap-desktop` (`poc/bakeoff-census@aae8969e`);
  the historical TipTap gauntlet is
  `~/Developer/futo-notes-tiptap-gauntlet`
  (`poc/tiptap-gauntlet-baseline@9ac43afe`); the current CM6 gauntlet is
  `~/Developer/futo-notes-editor-gauntlet`
  (`test/editor-gauntlet@8bc8920d`). P1–P5 use the named `futo-notes-editor-p*`
  worktrees recorded with their verdicts below. The Rust engine source branch
  remains `poc/full-native-editors`; do not merge main into historical/parked
  worktrees merely to modernize them.
- **Corpus:** `~/Developer/futo-notes-ml/dataset/notes_corpus.jsonl.gz`.
  Schema: self-contained `(title, body)` JSON per line. 45 MB on disk.
- **Existing harnesses to reuse, not rebuild:** the census
  (`vaultMeasurement.test.ts`, TipTap branch), the edit sweep
  (`localizedMarkdownEditSweep.test.ts`, TipTap branch), the factory judge
  (`just factory-judge`, main), markdown-spec cases
  (`markdown-spec/cases/`, main), the 10 MB perf fixture
  (`tiptap-large-note-performance.spec.ts`, TipTap branch).
- **Rules that bind this work:** M5 (typing is sacred — nothing added per
  keystroke outside sanctioned hot paths), M6/M7 (Rust owns note rules; any
  TS mirror needs the conformance lock), M19 (spec updates travel with
  behavior changes — but nothing in this plan changes shipped behavior until
  a winner lands), §11 two-strikes (a second failed fix on the same probe
  means stop and re-diagnose, not a third attempt).
- **Prototype hygiene:** probes are throwaway; build them in worktrees on
  `poc/*` branches, never behind product flags on main. The gauntlet is NOT
  throwaway; build it clean.

## 11. Evidence log / verdicts

### 2026-08-24 — Step 0 corpus census — base complete; causal follow-up stopped

- **Candidate revision:** `poc/bakeoff-census` at `aae8969e`; corpus SHA-256
  `1edbcf888da2d3fe633cf10c838cd811d14bf8957dda3d0f4ae3aaa2a21adc32`.
- **Coverage:** four strict shards merged to exactly 30,995/30,995 notes and
  104,201,276 UTF-8 bytes, with zero load failures, identity serialization
  failures, or identity mismatches. The strict merge rejects missing,
  duplicate, overlapping, differently configured, and differently fingerprinted
  shards.
- **Block-map burden:** 3,720 notes (12.0019%) failed the exact-only block map:
  3,700 `blockNodeMismatch`, 19 `tokenRawMismatch`, and one
  `incompleteSourceCoverage`. The largest divergence classes were HTML→list
  (2,134), HTML→paragraph (867), HTML→heading (350), and HTML→end (154).
- **Edited-block census:** 194,715 sampled edits: 163,579 clean (84.0094%),
  22,147 silent rewrites (11.3741%), and 8,989 refusals (4.6165%). Refusals
  occurred in 5,598 notes (18.061%): 7,578 unowned-HTML and 1,411 semantic
  round-trip failures. Internal undo changed the TipTap document in 81,804
  trials; 81,802 reset byte-exactly and two were explicit identity-refused
  baseline failures. There were zero source/editor block-count mismatches.
- **Construct histogram:** labels co-occur and therefore describe burden rather
  than causal attribution. The leading clean labels were paragraph (88,092),
  ATX heading (48,579), heading block (47,746), wikilink (19,173), and Markdown
  link (15,350). Rewrites most often co-occurred with list block (9,550),
  unordered list (9,334), paragraph (7,220), indented code (4,857), and Markdown
  link (4,635). Refusals most often co-occurred with HTML tag (7,608), Markdown
  link (7,430), paragraph (7,322), wikilink (3,332), and inline code (3,259).
  The independently reformatted aggregate is byte-identical to the original
  (SHA-256 `30a9898e95b50551abb35ca10a7b9d5682ce326280beba568603361d59302104`).
- **Causal attribution rerun:** `c8b6ca3c` replaces the co-occurrence-only
  labels with one causal owner per edit and passed 63 focused tests (four
  corpus tests opt in separately), formatting, lint, type checking, and
  `just build`. Its first four-shard attempt reached roughly 21,000 assigned
  notes before all workers hit the harness's inherited 7,200,000 ms ceiling;
  the empty partials contain no candidate result and are excluded. Revision
  `1d44906d` adds a fingerprinted `censusTimeoutMs` that the merger verifies
  and restarted all four shards from note zero with a 12-hour ceiling under
  `/tmp/futo-causal-full-v3.u3CPoq`. The clean v3 run reached emitted
  checkpoints totaling 18,000 assigned notes / 130,463 edits
  (4k/4k/5k/5k) with no reported errors before it was stopped on 2026-08-25.
  The shard outputs are intentionally empty until completion, so there is no
  partial candidate result, causal rate, or merge. A future causal result must
  restart all shards from note zero, close the strict aggregate, and match every
  non-attribution counter in the original census exactly.
- **CM6 parse/render census:** 30,995 parses, zero parse exceptions and zero
  syntax-tree coverage mismatches. A bounded jsdom renderer logged 13
  `RangeError`s in 30,970 attempts; the Chromium sweep is the discriminator.
- **Visual sample:** `poc/corpus-visual-census` at `0ae475f2` stratified 24
  notes. Sixteen were manually reviewable without exposing corpus text: nine
  had observable CM6/Obsidian parity misses, four were capture noise, and three
  put the changed region outside the common crop. This is a presentation
  comparison, not a claim that Obsidian defines Markdown correctness.
- **Corpus-wide CM6 render census:** `poc/corpus-visual-census` at `3b05fe81`
  streamed all 30,995 notes through the real Chromium-hosted current-CM6
  live-preview driver. Four shards each saw all 30,995 records, reached uncapped
  EOF, and selected/completed exactly 7,749/7,749/7,749/7,748 notes. The strict
  merge therefore closed 30,995 selected = 30,995 completed = 30,995 classified:
  15,107 confirmed structural mis-renders (48.740119%), 376 render errors
  (1.213099%; all exact-source identity mismatches), zero input errors, and
  15,512 residual-human notes (50.046782%). There were zero incomplete parses,
  missing content DOMs, invalid decoration ranges, or runtime exceptions.
- **CM6 render oracle boundary:** only absolute product invariant failures or
  invalid live-DOM/source mappings enter the confirmed count. The 15,107
  confirmed notes are therefore a 48.740119% **lower bound**, not the total
  mis-render rate; 15,512 notes remain deliberately unclassified for human
  review. Confirmed notes produced 15,767 invariant occurrences: 14,453
  `list-line-hanging-indent`, 1,179 `cursor-reveal-does-not-shift-content`, and
  135 `no-quote-marker-bleeds-through`. Successful pipeline completion cannot
  prove semantic visual correctness, so every other successful note remains
  `residualHuman`. Exhaustive screenshots were deliberately not run: all 30,995
  observations record `screenshotNotRun`, with zero pixel-drift, size-crop, or
  offscreen candidates; none can inflate the confirmed count.
- **CM6 render strictness/performance:** all shards shared corpus SHA-256
  `1edbcf888da2d3fe633cf10c838cd811d14bf8957dda3d0f4ae3aaa2a21adc32`,
  config fingerprint
  `ca5113accbcd238a80296e36c918a5ee88d1a0e0514175548bad8bc70c9b9621`,
  candidate `3b05fe81`, and adapter fingerprint
  `182c73fb118d25b859c58bd59041d057a101e9f1a45a268d48c1229456459640`.
  The deterministic aggregate SHA-256 is
  `5d6c38269dedc9a440b37c80cc291d650433e6fa67c676800cff6dfd51b2e437`;
  a second strict merge reproduced it byte-for-byte. Slowest-shard wall was
  806,353.512 ms, summed Node CPU was 157,455.781 ms, and maximum measured Node
  RSS was 199,112 KiB; Chromium child-process memory is explicitly not claimed.
- **CM6 render verification:** the public-seam driver, classifier, streaming,
  privacy, and merger suites passed 13/13; targeted ESLint and `pnpm run build`
  passed; a 100-record real-Chromium discriminator and both strict full merges
  passed. `just check` reached `check:agent-docs` and then stopped on the
  pre-existing nonexistent `factory/holdout/` reference, recorded as papercut
  `pc_4051c8ffcf54`. Reports are aggregate-only and remain local/ignored.
- **Verification:** the 49-test TipTap suite (four opt-in corpus tests skipped),
  strict four-shard aggregation, formatting/lint, and `just build` passed.
  Full wall time was 3,042 seconds; peak measured RSS was 1,443,635,200 bytes.
- **Decision:** tree-owned approaches are repriced sharply downward. P4 still
  runs because it promises source patches rather than serialization; P3 remains
  conditional on P4 dying, as sequenced above. Recorded by Codex from the
  fixed harness criteria.

### 2026-08-24 — existing-editor baselines — complete

- **Durable gauntlet:** `test/editor-gauntlet` at `bf302e3e` contains the
  split-torture matrix, performance floor, strict foreign-corpus sharding and
  aggregation, factory visual census, and evidence/config fingerprints. Four
  post-`6296971e` hardening commits lock one stable scratch-note/cache identity,
  CRLF measurement without a hang, transformed opens without gated rendering,
  and fingerprinted capture-off/retry-on-failure artifacts.
- **Current CM6 split matrix:** 14/56 passed. All 14 marker-edge controls passed;
  all 42 Enter, Backspace-join, and cross-boundary paste cases failed. The
  persistence, read-back, single-undo, and adapter-contract assertions passed.
- **Current CM6 performance:** open/settled times were 45.9/26.3 ms at 1k,
  52.2/28.5 ms at 10k, 68.1/44.4 ms at 50k, and 282.8/41.4 ms on the 10 MB
  adversarial fixture. Synchronous keystroke p95 stayed between 1.4 and 3.8 ms.
- **Current CM6 feel oracle:** 54/60 factory comparisons passed; the expected
  non-zero exit and registry restoration were both asserted.
- **Historical TipTap split matrix:** 32/56 passed: 18 confirmed product
  failures and six atomic-wikilink selection cases not proven by the adapter.
  Its performance wall reproduced: 308.8 ms open/143.2 ms typing p95 at 1k,
  7.022 s open/16.661 s for one insertion at 10k, 226.919 s open at 50k, and
  43.371 s open on the 10 MB fixture.
- **Historical TipTap exhaustive sweep:** strict-v3 semantics at `9ac43afe`
  accounted for exactly 30,995 assigned records and 104,201,276 bytes; the
  underlying candidate adapter came from `56146687`. The aggregate binds the
  exact corpus and configuration but predates revision fields, so this
  attribution also relies on the preserved clean worktree/command log rather
  than claiming the JSON self-identifies both commits. Of 465,099 parsed
  blocks, 440,509 were editable and 24,590 were explicitly uneditable. It
  attempted 439,904 edits and applied 438,417:
  310,427 clean, 46,439 edited-block rewrites (10.59242684476195%), and 81,551
  refusals accompanied by 81,551 real product warnings. There were zero
  outside-block changes, diff-uncheckable outcomes, lost edits, undo failures,
  load failures, or reset failures.
- **TipTap completeness accounting:** 30,990 notes completed. Four byte-exact
  source-restoration failures abandoned 51 later editable blocks; one note
  exceeded the fixed 600,000 ms budget and left 554 blocks unswept. Thus
  `440,509 - 51 - 554 = 439,904` attempted; 1,487 `insert-threw` application
  failures leave 438,417 applied, whose three outcome buckets close exactly.
  The caret walk completed 904,306 of 916,710 attempted stops with 12,404
  explicit failures; 930,198 caret stops were planned in total. Source bytes
  were equal before each of 184,773 ProseMirror baseline resets, and all resets
  restored `doc.eq`; the preceding undo identity changes still fail the
  candidate's internal-document-restoration contract. The maximum shard elapsed
  time was 36,682,123.84 ms
  (10:11:22.124); the four-shard elapsed sum was 139,153,713.24 ms.
- **TipTap strictness/privacy:** shard counts were exactly
  7,749/7,749/7,749/7,748 with matching corpus/config fingerprints. The merger
  emitted aggregate-only evidence, then exited 1 for the candidate's contract
  violations. A prior v2 run stopped at 12,700 notes after exposing a harness
  proof defect: source-restoration mismatches were not session-fatal. It is
  preserved but excluded from every candidate rate. Forty-four focused tests,
  TypeScript, targeted ESLint, Prettier, and both commit checks passed; the
  worktree is clean.
- **Current CM6 exhaustive sweep:** candidate `bf302e3e` accounted for exactly
  30,995/30,995 notes, 486,022/486,022 planned/completed block edits,
  30,995/30,995 caret walks, and 972,044/972,044 caret positions across 64
  unique modulo shards. There were five edited-block rewrites and 1,146
  outside-block rewrites: 1,151/486,022 = 0.2368205554481073%, an honest tier-3
  candidate red. Failed edits, refusals, warnings, exact-only notes, parse,
  uneditable, budget, adapter, and stage failures were all zero.
- **CM6 strictness/performance:** every shard saw all 30,995 corpus records,
  reached EOF uncapped, and shared corpus SHA
  `1edbcf888da2d3fe633cf10c838cd811d14bf8957dda3d0f4ae3aaa2a21adc32`,
  config fingerprint
  `7ee0270e5393ba05d580d44007acbe3125845f352aa4569a22acf70192326bc5`,
  and candidate/adapter revisions. All 64 Playwright exits were complete
  candidate assertion failures, not infrastructure failures. Maximum shard
  wall was 5,462,567.95 ms and maximum RSS was 1,419,048 KiB. The strict
  aggregate SHA-256 is
  `88b0b543d72a22e1ebb8247306aae0171c266ceb8350e22e42e95c66deb97a58`.
- **CM6 harness verification:** the public-seam suite passed 15/15 tests;
  TypeScript, targeted ESLint, and the clean-worktree check passed. Harness HEAD
  `8bc8920d` is post-evidence and adds only papercut `pc_94b79ff1b253` for a
  literal `--` aggregate-CLI trap; the tested candidate remains `bf302e3e`.
  Aggregate artifacts are local/ignored and contain no corpus content or note
  identifiers.
- **Preserved harness failures:** the first attempt used a new scratch-note ID
  per block, growing the note list/cache and creating roughly 6 GB of failure
  video in 22 minutes. Subsequent hardening fixed CRLF raw-offset waits, removed
  an invalid candidate-document-equality gate, fingerprint-bumped lightweight
  exhaustive artifacts, and corrected a Zsh readonly-variable coordinator
  wrapper. None of those invalid/partial attempts contributes to the candidate
  rate.

### 2026-08-24 — P2 block hybrid — iterate

- **Revision:** `poc/editor-block-hybrid` at `38b8be89`. This includes the P1
  compiler via conflict-free cherry-pick `5f85e264`, the real-Tauri handoff at
  `3c6616bc`, strict performance/foreign-evidence identity, the candidate-specific
  gauntlet/factory adapters at `92ccdd9c`/`6d61a255`, and the single bounded
  active-block render iterate at `d054efeb`, the first exhaustive-run recovery
  guard at `8ac0dd7d`, the CRLF source-offset fix at `875707d0`, and bounded
  active-window materialization at `86bf6d85`, measured virtual geometry at
  `d80053be`, and bounded, topology-safe transitions at current HEAD.
- **Contract shape:** one exact source string and Lezer block map own the note;
  one CM6 instance owns only the active block. Common inactive blocks are pure
  projections; exotic/raw-HTML blocks are quiet, editable source islands.
  Composition defers remapping until `compositionend`.
- **Seam result:** repeated 100-crossing runs stayed below one frame; the
  slowest observed run was 5.6 ms p95 and 12.6 ms max, with zero measured
  layout shift and exactly one contenteditable.
  Synthetic composition created a new block boundary and remapped to the right
  exact-source block without a warning.
- **Performance:** at pre-render revision `4650f2e8`, the shared
  1k/10k/50k/10 MB fixtures opened in
  58.9/120.1/254.4/738.9 ms. Synchronous keystroke p95 was
  1.2/1.1/1.7/6.9 ms. All remain inside the fixed budgets.
  Two later 10 MB reruns under an unrelated Kotlin language server consuming
  roughly 20 of 32 cores reproduced 1.683/1.692 s and are retained as
  noisy-host failures, not substituted for the clean result. The second used
  a fixed eight-core affinity while the unpinned first did not, ruling out the
  affinity as the cause. No threshold changed. A current-revision repeat is not
  a remaining qualification gate because P2 was killed by the fixed second
  caret-crossing strike.
- **Selection:** `tests/editor-gauntlet/P2_SELECTION_DESIGN.md` defines global
  UTF-16 source selections, exact copy/delete, pointer capture, virtualization,
  Shift+Arrow, and composition arbitration; model tests prove segmentation.
  Real pointer-drag/auto-scroll remains production work.
- **Intent integration:** the shared P1 filter turns the bold-split story into
  `**bold**\n\n**words**`; a generic source-owner remount keeps one editor after
  the block split, and one undo restores the original bytes. No P2 delimiter or
  construct rule was added.
- **Candidate-specific full matrix:** the first immutable adapter run at
  `6d61a255` failed 56/56 because the active CM6 mounted raw Markdown syntax
  highlighting rather than the established live-preview projection. That was
  a named bounded omission, so the one permitted iterate installed the existing
  `liveMarkdownTransform` and made both gauntlet and factory read the actual
  candidate DOM. The exact rerun at `d054efeb` passed 32/56 and failed 24/56.
  Residue is all seven cross-block Backspace joins; Enter, Backspace, and paste
  for strike/wikilink/Markdown-link outside P1's bounded intent family; and the
  two strike marker-edge presentation cases. Save-payload/persistence and undo
  assertions did not fail. No second matrix fix was attempted. A detached exact
  current-revision rerun at `d80053be` remained 32/56 with the same 24
  semantic/render failures and zero undo failures. Its content-free artifact is
  ignored
  `tests/editor-gauntlet/local/p2-split-matrix-d80053be4d8b.json`, SHA-256
  `db7c479dacd1e566e2a9c570fbf5645210fa8b19bfb41a2afe3d4643cff247a5`.
  The exact `38b8be89` rerun also passed 32/56 and failed the same 24 cases,
  with zero skipped/flaky cases and zero undo failures; its canonical
  `{id, ok, failureKinds}` vector is byte-identical to `d80053be`. The current
  content-free artifact is ignored
  `tests/editor-gauntlet/local/p2-split-matrix-38b8be893081.json`, SHA-256
  `d90713549409e247745cf5e68c9dc729e932fc64f38930de95bdb92acb30d0bf`.
- **Exhaustive-run recovery:** revision `8ac0dd7d` handled the known exception
  from activating a block beyond the prototype's leading 250-block viewport,
  but the first full run disproved the assumption that this was the only poison
  path. Four completed shards failed 6,836/7,437, 7,098/7,820, 7,377/8,078, and
  6,435/7,356 edits, respectively, after one caret-walk failure in each. A
  content-free 4.7-second replay minimized the first failure to CM6 throwing
  `Selection points outside of document`: the source-owned model retained raw
  UTF-16 offsets while CM6 auto-normalized a two-code-unit CRLF to one document
  position. The exception also left the render re-entrancy guard latched, so
  every later note lost its active editor. The four reports are preserved but
  excluded from candidate rates under ignored
  `tests/editor-gauntlet/local/p2-foreign-8ac0dd7d/`.
- **Corrected candidate:** `875707d0` makes CM6 treat only LF as its line separator,
  retaining CR as an exact source code unit even in mixed-ending blocks, and
  releases the render guard in `finally` on every error path. The four-character
  `a\r\nb` regression failed before the fix and passed after it; the original
  two-note corpus replay then completed 12/12 edits. A preflight then identified
  the separately known hard cap: blocks after index 249 could not satisfy the
  strict every-planned-edit invariant. Rather than run a known-incomplete
  census, `86bf6d85` centers a bounded 250-block DOM window on the active source
  block and retains height placeholders on both sides. Its regression failed
  first on block 251, then proved the real exhaustive adapter could select,
  edit, save, and preserve exact source there. The focused browser suite passed
  10/10, model/adapter tests 7/7, and TypeScript, ESLint, Prettier, and
  `just build` passed. Read-only review then caught an 8px geometry regression:
  recentering at block 125→126 replaced a measured 35px paragraph with a fixed
  27px spacer. `d80053be` keeps the mounted window stable through ordinary
  crossings and uses measured hidden-block heights when the window edge moves.
  Its regression failed first at 8px, then measured 0px at both 125→126 and the
  actual 249→250 virtual-window edge. A subsequent read-only audit proved that
  the edge still rebuilt and measured all 250 projections in 38–63 ms and found
  stale cross-note/suffix heights, pointer remounts, deferred-topology drift,
  composition ownership, and remount-undo failures. `38b8be89` slides one
  entering/leaving block, applies deferred offsets lazily, locally confirms
  risky prefix edits before any remount, invalidates numeric caches on real
  topology changes, and preserves live-CM caret/undo state across structural
  and composition transactions. The final adversarial audit reported no
  remaining in-scope finding. Its 21 Chromium tests passed: the virtual edge
  measured 3.6 ms, the edited 5,001-block edge 4.0 ms, pointer activation
  3.8 ms, and 100 ordinary crossings 5.5 ms p95 / 7.9 ms max with zero shift.
  Eleven model/adapter tests, targeted lint/format/diff checks, and `just build`
  also passed. A private standard-shape remeasure recorded 10k-line sync/settled
  p95 at 3.0/17.5 ms and 50k at 4.3/20.2 ms; the tracked P2 performance test now
  rejects gross settled-to-paint jank as well as synchronous overruns.
  A 500 KB unbroken-paragraph diagnostic remained about 49.8 ms because the one
  active CM6/live-Markdown block is itself unbounded; that non-standard shape is
  recorded as a prototype limitation, not substituted for or added to the
  declared 1k/10k/50k-line plus 10 MB contract. A fresh strict 64-shard
  full-corpus run was started at current revision under ignored
  `tests/editor-gauntlet/local/p2-foreign-38b8be89/`, then stopped on 2026-08-25
  before any shard report completed. Its logs are retained but excluded; no
  aggregate or candidate rate exists.
- **Candidate-specific feel oracle:** the final `d054efeb` factory round
  completed 266/266 comparisons without a driver error: 41 matched and 225
  diverged (15.4135% match). Its aggregate SHA-256 is
  `afbe9830fadf9543ea0c1caa5a374174ae1d9e771eea6f7c338ea17a0836cf83`;
  buckets are 323 Obsidian-only decorations, 215 FUTO-only decorations, ten
  visible-text drifts, eight cursor drifts, eight selection drifts, and four
  document mismatches. As designed, this is a human-read comparison rather
  than an automated feel verdict. This artifact predates the later transition
  repairs, but P2's fixed second-strike kill means a post-verdict rerun cannot
  affect qualification and is not a remaining gate.
- **Candidate-specific evidence commands:** the matrix used
  `EDITOR_GAUNTLET_ADAPTER=p2-block-hybrid EDITOR_GAUNTLET_CANDIDATE=p2-block-hybrid EDITOR_GAUNTLET_ARTIFACT_CAPTURE=off-retry-on-failure pnpm run test:editor-gauntlet:cm6`;
  the exact current-revision artifact added
  `CHOKIDAR_USEPOLLING=1 CHOKIDAR_INTERVAL=2000 FUTO_DEV_PORT=6757 PW_RUN_ID=p2-matrix-d80053be-poll` to that environment;
  the `38b8be89` rerun used the same polling/candidate environment with
  `FUTO_DEV_PORT=6758 PW_RUN_ID=p2-matrix-38b8be89-poll`;
  the oracle used
  `FACTORY_CANDIDATE_PATH=/p2-block-hybrid.html FACTORY_CANDIDATE_READY_SELECTOR=#probe just factory-judge`.
  The content-free matrix log is retained under ignored
  `tests/editor-gauntlet/local/p2-full-d054efeb/`; the oracle aggregate is
  ignored `factory/captures/last-run.json`. No screenshot was needed to decide
  either mechanical result.
- **Real WebView smoke:** the isolated launcher was exercised in the actual
  Fedora Tauri WebKitGTK surface through the webview bridge. Common bold, list,
  and table projections rendered with one CM6 instance; a CRLF note containing
  raw HTML stayed byte-exact with a quiet source island; Enter split the fixed
  bold story and one undo restored it exactly. A synthetic composition commit
  produced `alpha\n\n日本\n\nbeta`, remapped to the new middle block, retained
  one editor, and emitted no warning. Console capture contained no application
  error. This smoke also predates the post-verdict transition repairs and lacks
  a durable exact-command ledger; it is retained only as historical
  characterization, not qualification evidence.
- **Verification:** nine unit tests, five Chromium seam/story tests, the shared
  performance test, lint/formatting, and `just build` passed. The final handoff
  revision reran the four owning model tests and five Chromium tests (100 seam
  crossings: 2.6 ms p95, 3.1 ms max, zero layout shift), plus script syntax,
  targeted ESLint/Prettier, recipe discovery, and the real WebView smoke above.
  At candidate revision `38b8be89`, eleven focused model/adapter tests and 21
  Chromium seam/story/driver tests pass; targeted ESLint, Prettier,
  `git diff --check`, and `just build` pass.
  The once-planned current-revision three-run browser discriminator is no
  longer a decision gate after the fixed second strike.
- **Verdict:** **kill**, recorded by Codex. `86bf6d85` first fired the
  predeclared caret-crossing condition by shifting layout 8 px at the virtual
  edge. The permitted iterate, `d80053be`, removed that shift but fired the
  same composite condition again by rebuilding 250 projections in 38–63 ms,
  beyond one frame. The fixed two-strikes rule therefore killed P2 at
  `d80053be`; the later `38b8be89` work is useful post-verdict characterization
  but cannot resurrect the candidate. Physical IME and P1-vs-P2 feel are no
  longer gates because only P1 survives.

### 2026-08-24 — P1 CM6 intent compiler — graduate

- **Revision ledger:** current branch HEAD is `692f47ae`. The compiler itself
  landed at `00ee6acb`; `fa4572a2` added the isolated human handoff;
  `810a6798`/`8f617652` made three-run performance evidence strict and then
  centralized its identity; `b03fc4a2` bound factory/foreign evidence to P1;
  and `692f47ae` ported capture-off exhaustive artifacts. Those later commits
  change qualification infrastructure, not the compiler rule set.
- **Rule shape:** one Rust-canonical `compile_editor_intent` and conformance-
  locked TS mirror accept a UTF-16 source operation and return one replacement
  or `null`. Six delimiter descriptor rows cover `**`, `__`, `*`, `_`, and
  single/double backticks. Generic strategies own Enter split, whitespace-only
  Backspace join, and crossed-boundary paste; there is no construct×operation
  branch. CM6 substitutes one transaction, preserving one-step undo.
- **Result:** the fixed target matrix improved from 8/32 to 32/32 with no failed
  IDs. Thirty-six hand-reviewed goldens and 23,360/23,360 Rust↔TS differential
  probes passed, including 136 generated intent probes.
- **Full survivor matrix:** the public 56-case split gauntlet at `8f617652`
  passed 38/56. All bold, italic, inline-code, double-backtick-code, and 14
  marker-edge cases passed. The 18 honest failures are Enter, Backspace-join,
  and cross-boundary paste for the deliberately out-of-probe strike, wikilink,
  and Markdown-link families. Persistence and undo still passed; the semantic
  oracle correctly rejected the malformed/unsplit outcomes. This is the
  complete matrix score, not a retroactive expansion of P1's fixed 32-case
  probe scope. A detached exact-current-revision rerun at `692f47ae` reproduced
  38/56 with the same 18 semantic/render failures and zero undo failures. Its
  content-free artifact is ignored
  `tests/editor-gauntlet/local/p1-split-matrix-692f47ae5b58.json`, SHA-256
  `58b1edd08cb7463433136211cbaa4e0144b90f42e151124898429ab94e8f722c`;
  the exact command was
  `CHOKIDAR_USEPOLLING=1 CHOKIDAR_INTERVAL=2000 FUTO_DEV_PORT=6701 PW_RUN_ID=p1-matrix-692f47ae-poll EDITOR_GAUNTLET_ARTIFACT_CAPTURE=off-retry-on-failure pnpm run test:editor-gauntlet:cm6`.
- **Full feel oracle:** `just factory-judge` at candidate branch HEAD
  `b03fc4a2` completed 266/266 comparisons without a driver error: 207 matched
  and 59 produced the expected human-review divergences (77.8195% match). The
  local ignored aggregate SHA-256 is
  `d28b9021165a9d5f5da340adc792a039d116fa60efb476fc483506bd3cb26dde`;
  its buckets are 38 Obsidian-only decorations, 19 FUTO-only decorations, 20
  visible-text drifts, four cursor drifts, four selection drifts, four document
  mismatches, and two layout violations. The judge's non-zero exit is a
  divergence report, not a product-test failure or an automated feel verdict.
- **Verification:** editor conformance 272/272, CM6 integration 5/5, editor
  minimal 317/317, Rust conformance 7/7, Markdown spec 44/44, drift check,
  formatting/lint, and `just build` passed.
- **Human handoff:** follow-up revision `fa4572a2` adds the safe, worktree-
  isolated P1 feel-drive instructions for the same foreign note and three fixed
  stories used by P2.
- **Performance evidence:** the existing strict three-run artifact identifies
  candidate revision `810a6798`, labels it `p1-cm6-intent-compiler`, and binds
  CPU affinity, fixed budget/config fingerprint, complete fixture order, and
  per-fixture worst cases. Two mounted runs and a matched compiler-disabled run
  each had one migrating p95 miss while an unrelated Kotlin language server
  saturated the host; the disabled baseline also missed (17.8 ms at 10k), so
  those remain inconclusive rather than compiler regressions. Three subsequent
  standalone fixed-affinity runs passed, with worst settled opens of
  83.9/64.4/109.8/90.2 ms and worst typing p95 of
  14.9/14.5/13.3/10.8 ms. The first post-commit strict three-run artifact then
  caught a 19.2 ms 1k typing outlier and failed honestly. No threshold changed;
  P1's quiet-host performance discriminator remains future qualification work
  at current revision `692f47ae`; the existing ignored artifact is
  `tests/editor-gauntlet/local/p1-intent-compiler-performance.json` (SHA-256
  `38c88df63d37824a840b1f59a527dfc8d74065dc3fd5c32598b3d5714eee340b`).
- **Exhaustive preservation sweep:** a fresh exact-current-revision 64-shard
  run under ignored `tests/editor-gauntlet/local/p1-full-692f47ae-r2/` used
  candidate revision `692f47ae`, capture-off artifacts, the exact corpus
  fingerprint, and the shared foreign-file preservation driver. It was healthy,
  not hung, but the 32-core host had a 57–69 run queue, 0% idle CPU, and full
  swap. Five initial shards reached 300/485 notes; seven remained below their
  first 100-note checkpoint after roughly three hours. The run was stopped on
  2026-08-25 before its six-hour whole-test deadline; no shard report or
  aggregate exists, and all partial logs are excluded.
- **Verdict:** **graduate**, recorded by Codex. The fixed whack-a-mole kill did
  not fire: the final four cases closed through delimiter policy data only.

### 2026-08-24 — P4 TipTap transaction-to-patch map — kill

- **Revision:** `poc/tiptap-transaction-patch` at `6febad67`.
- **Positive boundary:** a Lezer-backed exact inline map handled real
  ProseMirror text insertion, Markdown escaping, bold/italic/link add, full and
  partial mark removal, and nested wrappers without invoking a serializer.
- **Counterexample:** deterministic seed `0x5eed2026` found a non-planar
  crossing `AddMarkStep` at transaction 12. Minimized source `**mma** de` plus
  italic over `ma d` makes bold and italic intervals cross. Splitting/reopening
  either the existing or new wrapper while preserving the original `**` bytes
  reparses to a different ProseMirror document.
- **Why this is the fixed kill:** an equivalent spelling can be manufactured as
  `**m***__ma__ d*e`, but it changes part of the pre-existing bold marker to
  `__`. That is normalization of syntax the transaction did not edit—the exact
  fallback P4 forbids, and the same tier-3 behavior as P3 at a smaller scope.
- **Verification:** five focused tests preserve both the minimized case and the
  seeded search; formatting/lint and `just build` passed. The exact discriminator
  was
  `pnpm exec vitest run tests/editor-gauntlet/transactionPatchMapper.test.ts --reporter=verbose`,
  followed by
  `pnpm exec eslint tests/editor-gauntlet/transactionPatchMapper.ts tests/editor-gauntlet/transactionPatchMapper.test.ts`
  and `just build`. At `6febad67`, the mapper SHA-256 is
  `c5f80a9ab3300cd6256af8cd8995d056ca676f3b53d7d7e63b52acf59f99ea55`
  and its test SHA-256 is
  `f966e01a788e1b678eb44376d663d9239dbfa4de6b9ccbc78c3078bcfc3856f4`.
- **Verdict:** **kill**, recorded by Codex. P3 is therefore activated as the
  sequence requires.

### 2026-08-24 — P3 TipTap fail-open — kill

- **Revision:** `poc/tiptap-fail-open` at `e360b394`, based on the strict
  historical-gauntlet revision `9ac43afe`.
- **Positive boundary:** generic load-time serialize/reparse certification now
  turns unsafe source blocks into anchored `verbatimBlock` islands with a
  rendered preview and exact-source textarea. A dynamic refusal converts only
  its anchored block; one undo restores the original bytes. The bounded corpus
  discriminator completed 23/23 editable-block edits with zero refusal,
  warning, exact-only mode, lost edit, outside-block change, or undo/reset
  failure.
- **Rewrite kill:** all five minimized common-construct fixtures rewrote bytes
  outside the inserted sentinel: double-underscore bold, underscore italic,
  asterisk list, parenthesized ordered list, and compact table. The bounded
  corpus result was 19 clean / 4 rewrites (17.3913%). The broader edge sweep
  recorded 602 edits, 32 island edits, zero refusals or semantic defects, and
  132 edited-block churns. Fixing these cases requires the inline source-patch
  mapping already disproved by P4, not a bounded serializer policy.
- **Incremental kill:** changing a reference definition changes the token for
  an earlier reference paragraph, so true one-block token replacement is not
  equivalent to the authoritative parse. On the 10k-block fixture the full
  Marked+TipTap path took 19,831.47 ms versus 0.276 ms for the non-equivalent
  isolated lex. The second fixed kill condition therefore fired independently.
- **Secondary evidence:** the split gauntlet remained 32/56. At 1k lines, open
  took 2,127.9 ms and synchronous typing p95 was 504.6 ms, both over budget.
  Forty-six focused tests passed and two kill-condition regressions remain
  expected failures. TypeScript, Svelte, ESLint, Prettier, and `just build`
  passed. Six of 19 historical TipTap E2E cases failed honestly because four
  old recovery flows no longer address rich text inside islands, plus Cmd-B and
  table interaction gaps.
- **Evidence commands and identity:** the five-fixture rewrite discriminator was
  `pnpm exec vitest run src/features/editor/tiptap/tiptapMarkdownAdapter.test.ts --reporter=verbose`
  (tracked test SHA-256
  `c4c9e5c1aa2cad7c28e0ba774f371055fb9af0beea1ed9e7ffaef751d3f54639`),
  and the 602-edit edge sweep was
  `pnpm exec vitest run src/features/editor/tiptap/localizedMarkdownEditSweep.test.ts --reporter=verbose`
  (source SHA-256
  `55e83023188cf7c46113f0c187424fdf25f6dbfce59040358fe096badd200cd6`).
  The incremental discriminator was
  `pnpm exec vitest run src/features/editor/tiptap/blockLocalLexingProbe.test.ts --reporter=verbose`
  (source SHA-256
  `3696cfb0d877dbb71edeba336f1a820c9fc62c787b5b6ac6196e9ca3d555c339`);
  its original timing was console-only; a future characterization should retain
  a durable ignored log. The bounded exact-corpus command was
  `FUTO_FOREIGN_ONLY_INDEXES=0,23767 FUTO_FOREIGN_OUTPUT_DIR=tests/editor-gauntlet/local/p3-discriminator-final pnpm run test:editor-gauntlet:tiptap:foreign`;
  `discriminator.json` has SHA-256
  `71b2fc6c79b547bf8ff467cdf7d1530509e3c6664c26980df5d3117153d38799`.
  The matrix command was `pnpm run test:editor-gauntlet:tiptap`; ignored
  `tests/editor-gauntlet/local/historical-tiptap-split.json` has SHA-256
  `ea3d54b70aa02a11fb16ccbbce8eaab41fda159310187224097bb2c94ab4d60b`.
  The 1k performance command was
  `TIPTAP_GAUNTLET_PERF=1 VITE_TIPTAP_EDITOR=true pnpm exec playwright test -c playwright.tiptap-gauntlet.config.ts --grep '1k'`;
  ignored `tests/editor-gauntlet/local/historical-tiptap-performance.json` has
  SHA-256
  `3133b9631cdd12ad8af905d2c6978ccd876b3a8a00d66f6da65caf3099de6b72`.
  The last two historical filenames do not self-bind Git revision; their
  attribution is to the preserved clean `e360b394` worktree and exact commands,
  not to fields they do not contain.
- **Verdict:** **kill**, recorded by Codex. Both predeclared switches fired; no
  exhaustive result can reverse either verdict. A strict four-shard
  foreign-file preservation sweep was subsequently launched to quantify the
  failed candidate over all 30,995 notes; this is the generic §5 sweep and its
  run was stopped under ignored
  `tests/editor-gauntlet/local/p3-full-e360b394/` at 15,225 selected / 15,205
  completed notes and 282,458 attempted edits. Its checkpoints recorded 248,693
  clean edits, 32,758 edited-block rewrites, zero refusals/warnings/outside-block
  changes/lost edits, 16 baseline-restoration failures, four load failures, and
  991 application failures. These are incomplete checkpoint totals, not a rate
  or aggregate, and are excluded from qualification. The generic sweep does
  **not** satisfy P3's
  separate literal “rerun the §6 census” scope because it lacks block-map,
  exact-only, and causal construct-attribution counters. After the preservation
  aggregate closes, the fingerprinted causal census harness from the original
  TipTap Step 0 run would need to be ported to `e360b394` for a literal rerun.
  That follow-up was not started and cannot change the two independent kill
  results. No corpus content or raw report is committed.

### 2026-08-25 — P5 Rust engine wasm rehost — kill

- **Revision:** `poc/rust-editor-wasm-rehost` at `a8d15b12`, with the shared
  gauntlet adapter introduced at `fe76045b` and isolated prebuilt-wasm shards at
  `a8d15b12`. The wasm artifact remains 1,502,230 raw bytes.
- **Shared semantic matrix:** the final split-torture run was 0/56. Fourteen
  cases reached the expected semantic and rendered result but failed the
  one-step-undo assertion because this typing-only prototype deliberately has
  no history implementation; the other 42 also failed their semantic/rendered
  expectation. Every case reached edit, save, and undo, so these were candidate
  outcomes rather than adapter or startup failures. The dedicated content-free
  artifact is ignored
  `tests/editor-gauntlet/local/p5-split-matrix-a8d15b129fb0.json`, SHA-256
  `cdc1f9f70d557894b566b8eb3e7254cb00f3e637138ea88e874ebb726d784bf5`.
  It was reproduced from a detached exact-revision worktree with
  `just p5-wasm-build`, then
  `CHOKIDAR_USEPOLLING=1 CHOKIDAR_INTERVAL=2000 FUTO_DEV_PORT=6702 PW_RUN_ID=p5-matrix-a8d15b12-poll P5_GAUNTLET_WASM_PREBUILT=1 EDITOR_GAUNTLET_ARTIFACT_CAPTURE=off-retry-on-failure pnpm run test:editor-gauntlet:p5`.
- **Actual rendered-path performance:** the clean current-revision run measured
  document open and `beforeinput` through Rust, contenteditable projection, and
  paint rather than only the original probe's inner wasm telemetry. At 1k
  lines, open/synchronous-open/typing-p95/settled-paint-p95 were
  123.9/103.6/1.9/19.3 ms. At 10k they were 971.3/732.5/25.8/213.8 ms; at 50k,
  4,671.8/3,490.7/141.8/1,362.7 ms; and on the exact 10 MiB fixture (10,493,072
  bytes, 43,523 lines), 5,352.2/3,928.8/125.4/1,016.0 ms. The latter three
  fixtures failed the fixed 16 ms synchronous-keystroke budget. The ignored
  report is
  `tests/editor-gauntlet/local/p5-wasm-contenteditable-performance.json`, with
  config fingerprint
  `252dab52cb3aa60d6fbde3bb50cac8978b990dd6158ab4e076e78e690f8064c9`
  and report SHA-256
  `e3e7e17854c7a0f5c25ab83b3db251531e543cd9680bb2f5696c4342aca7a3f9`.
  The much smaller `c3c85b2f` numbers above remain useful wasm-boundary
  telemetry, but they did not measure the complete rendered candidate path
  required by the common performance contract.
- **Performance command:** `just p5-wasm-build`, followed by
  `EDITOR_GAUNTLET_PERF_RUNS=1 P5_GAUNTLET_WASM_PREBUILT=1 EDITOR_GAUNTLET_ARTIFACT_CAPTURE=off-retry-on-failure pnpm run test:editor-gauntlet:p5:perf`.
- **Foreign/factory boundary:** a bounded foreign sweep selected one note from
  100 records and completed 68 caret positions and 34 edits with zero
  failures, refusals, warnings, block rewrites, or outside-block rewrites. Its
  ignored report is
  `tests/editor-gauntlet/local/p5-bounded-foreign-a8d15b12.json`; its SHA-256 was
  `0ca607f4069857ae37143b4461d7f8e6b47dce05d251a26b72a4f51062373e39`.
  The exact command was `just p5-wasm-build`, followed by
  `P5_GAUNTLET_WASM_PREBUILT=1 EDITOR_GAUNTLET_CORPUS=/home/justin/Developer/futo-notes-ml/dataset/sample.jsonl EDITOR_GAUNTLET_CORPUS_LIMIT=1 EDITOR_GAUNTLET_ARTIFACT_CAPTURE=off-retry-on-failure EDITOR_GAUNTLET_REPORT_PATH=tests/editor-gauntlet/local/p5-bounded-foreign-a8d15b12.json pnpm run test:editor-gauntlet:p5:foreign`.
  The no-Obsidian factory smoke completed its configured three-case maximum 3/3,
  which sampled only `h1-basic`, `h2-basic`, and `h3-basic`; it is a
  driver/layout smoke, not the §5 parity/feel oracle. The ignored artifact is
  `factories/obsidian-factory/captures/last-run.json`, SHA-256
  `34b901161f7b4822ef592a18449f7bb21fd71b3c6fc7bd745b36bbdc71d97876`.
  A strict 64-shard census of all 30,995 notes was launched at this revision for
  post-verdict characterization. Six shards completed before the run was stopped
  on 2026-08-25; the remaining partial logs and those six reports are retained
  under ignored `tests/editor-gauntlet/local/p5-full-a8d15b12/`. They were not
  merged, yield no valid corpus-wide rate, and cannot reverse the performance
  kill.
- **Verification:** six adapter/browser checks and 23 focused tests passed;
  the Rust suite passed 297 tests. The wasm target check, TypeScript, ESLint,
  `just p5-wasm-build`, and the production build also passed. The worktree is
  clean.
- **Verdict:** **kill**, recorded by Codex. The fixed P5 kill condition fired
  directly: synchronous keystroke p95 exceeded 16 ms by 1.6× at 10k lines,
  8.9× at 50k, and 7.8× at 10 MiB. That is not a near-threshold result needing
  a quieter rerun, and no bounded fix was named. Physical three-engine IME is
  therefore moot for this bake-off verdict; the four synthetic composition
  scenarios remain positive boundary evidence, not a survival gate. The
  parked editor-decision ship gates remain intact.

## 12. Decision and bounded next work

P1 is the only surviving approach, so there is no physical-input or subjective
feel tiebreaker. P2's human IME gate became moot when the fixed second
caret-crossing strike killed it; synthetic evidence is not being substituted
for that human observation.

Next, in order:

1. On a quiet host, rerun P1's revision-bound strict three-run performance
   discriminator at `692f47ae`.
2. If exhaustive current-HEAD characterization is still desired, rerun P1's
   foreign sweep with materially lower concurrency and resumable/per-note
   checkpoints rather than another 12-way six-hour batch.
3. Review and productionize P1's Rust-canonical, conformance-locked intent
   compiler. Strike, wikilink, and Markdown-link intent rows are explicitly
   outside the probe and should be separate, data-driven follow-ups.
4. The original causal Step 0 histogram can be restarted later to prioritize
   those follow-ups. Do not spend more time on P2/P3/P4/P5 qualification; their
   fixed kills already decide this bake-off.
