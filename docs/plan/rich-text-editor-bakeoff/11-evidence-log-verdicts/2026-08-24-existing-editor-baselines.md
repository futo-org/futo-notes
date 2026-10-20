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
