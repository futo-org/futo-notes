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
