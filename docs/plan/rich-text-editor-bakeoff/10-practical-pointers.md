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
