## 0. The audit's trace findings, checked

| audit claim | verdict | evidence |
|---|---|---|
| CLI trace has no args, session, run, platform or duration | **true** | Each line is `{at, kind, record:{verb,status,result}}` (`main.rs:875-892`, `1517`). 24 of 25,583 lines have `args`, and all 24 are gestures. No line has a session, run, target, pid, ms or exit code. |
| Page clocks do not line up, and ids reset on reload | **true** | The page `t` is `performance.now()` (`agentTrace.ts:175`), and `timeOrigin` is never recorded. Action id 1 appears **180 times** and ids go down 173 times, so there were 180 page lifetimes in 4 days. Action 38 matches 20 different actions. |
| Drive traces leave out the Jev questions | **true** | No turn in the 28 files has `questions`. `state` (Jev's state) and `answers` (probabilities keyed by option) are kept, but the option text those keys stand for is not. SKILL.md:61 says "every question and probability", which is **false**. |
| A drive trace is written only at the end, so a hung run leaves nothing | **true, and worse** | There is one `writeFileSync` at `jev-drive.mjs:1210`. `AppUnreachable` exits 1 before it (`:1201-1204`). The TypeSafe `fetch` has **no timeout** (`:207`), and the `Press` `execFileSync` has **no timeout** (`:861`). The ceiling is only checked at the top of the loop. A hung request or click therefore never ends, and a SIGTERM from a tool timeout also writes nothing. |
| Concurrent writes corrupted 3 lines | **true** | Lines 13536, 13537 and 15152 interleave byte-wise (`…"elements"{:"{at""a…`). The cause: `writeln!(file, "{line}")` formats a `serde_json::Value` through `Display`, which makes many small `write(2)` calls on an unbuffered `File`. The file also **grew while I read it** (25,583 → 25,595+), because sibling sessions append to it right now. |

Further findings:

- **The diagnose harness throws the traces away.** `diagnose.mjs:52` runs
  `rmSync(join(repoDir, '.agent'))` before each run and never copies `.agent` into the run dir.
  None of the 30 diagnose runs has its CLI trace or drive trace. The two drive traces that
  diagnose agents resumed (`18-22-05-372Z`, `18-23-53-622Z`) are gone.
- **Agents never read the traces while they drive.** In 30 diagnose transcripts, the only uses
  of `.agent/` were 2 `--resume` paths. So traces are only for looking back later, and that is
  the right design point: they cost nothing in a turn.
- **Reads and observations are not recorded at all.** `state`, `doc`, `actions` and `elements`
  leave no line. `step` appends its receipt, but not the observation Jev acted on.
- **Pretty-printing doubles drive traces.** The 77-turn run is 3.9 MB pretty and 1.9 MB
  compact. Verb schemas are 72% of each observation.
- **The acting gate scans every drive trace.** `session_handed_back` reads whole files newest
  first until one contains the session. On every agent `do` that costs **5.4 ms** at 8.6 MB,
  measured as 7.0 ms against 1.6 ms, and it grows with the directory.
- **The original design was never built.** `docs/research/agent-native-app-design/inspector-engine.md` §"Trace
  file" says "One JSONL per session … action, before, after, diff, findings, and any pushed
  trace events between". What was built is one shared file with no session and no events.
- **The page-instance id already exists.** `crashHandler.ts:20` makes a
  `crypto.randomUUID()` per page load and stamps crash reports with it (`session_id`). Nothing
  in the agent records uses it.
- **Native listeners record nothing.** iOS has 4 `print`s (bind and stop), and Android has
  `Log.e`/`Log.i` on bind and request failure. Neither records a verb or a receipt.
- **iOS `print()` output is lost.** `apps/ios/run.sh:72` runs `simctl launch` without
  `--stdout`/`--stderr`. There are 25 `print()` calls in the app, and only 2 `Logger` categories
  reach os_log.
- **`just emu-logs` filters on tags that no code uses:** `FutoSearch` and `FutoToolbarDBG`.
  It leaves out tags that do exist: `FutoAgent`, `FutoEditor`, `NoteEditor`, `CrashReporter`
  and `FeedbackSubmission`. This is a papercut. It was not filed, because the brief is
  read-only.
- **The desktop journal's `app_launch` has no pid** (`instance_journal.rs:22-25`), so you cannot
  tell which launch an agent drove. With sync off, the dev journal holds nothing but 10
  `app_launch` lines.
- **Desktop console output is kept only in the page.** The MCP bridge keeps
  `window.__MCP_CONSOLE_LOGS__` (`bridge.js:55-75`): unbounded, epoch timestamps, gone on
  reload, and no CLI command reads it. The live app has 2 entries. The phones' embed has no
  equivalent.
- **Rust stdout and stderr of the dev app go only to the terminal that launched it.** This
  covers `[journal]`, `[MCP]` and panics (`scripts/tauri-dev.mjs` spawns with inherit). Only the
  diagnose harness tees it, to `app.log`.
- **The steps an agent takes between a handoff and a resume** are only in `trace.jsonl`, with
  no run id. They can be joined to the drive run by time only.

---
