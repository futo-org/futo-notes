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
