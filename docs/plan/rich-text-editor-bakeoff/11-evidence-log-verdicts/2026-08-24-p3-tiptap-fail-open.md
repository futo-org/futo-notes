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
