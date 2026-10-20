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
