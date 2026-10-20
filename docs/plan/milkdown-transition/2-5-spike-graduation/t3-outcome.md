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
