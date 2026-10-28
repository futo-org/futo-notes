## 6. Implementation plan (test first, in order)

1. **CLI record writer (Rust only, ships alone).**
   - Red tests in `main.rs`:
     - 8 threads × 500 appends of a 20 KB `Value` to one file, then every line parses. This
       fails on today's `writeln!`.
     - A pure `record_for(call)` includes `run`, `session`, `actor`, `target{platform,port,pid}`,
       `args`, `ms` and `exit`.
     - A transport error still produces `call` + `result{error}`.
   - Then: `append_record` (one `write_all`), per-run path resolution, `call` before and
     `result` after, pid kept from qa-target's stdout, reads logged without bodies, and the
     client timeout.
   - Risk: the file layout changes under the siblings' in-flight audit scripts. They only read
     `trace.jsonl`, so keep writing it for one commit if they need it, then delete it.
2. **Jev incremental record.**
   - Red tests in `jev-drive.test.mjs`, using the existing `fakeApp` binary seam:
     - A fake app that stops answering after turn 2 leaves `run_start`, 2× `turn`, the calls and
       `run_end{outcome:"error"}`. Today it leaves no file.
     - A `turn` contains `request.questions` and `decision.override`.
     - `--resume run.jsonl` rebuilds the same `resumeFrom` input as the old JSON did.
   - Then: `FUTO_AGENT_RUN`/`FUTO_AGENT_TURN` in `AS_DRIVER`, `appendFileSync` per record,
     exit and signal handlers, fetch and click timeouts, and the gate reading `run_end`.
   - Risk: the resume format change breaks a handoff that is in flight during the upgrade.
     Accept it: runs are local scratch.
3. **Page ids, clock and shipped slices.**
   - Red vitest in `agentTrace.test.ts`:
     - `t` is epoch.
     - Two page instances produce different ids for equal action ids.
     - A `do` reply contains the events it caused and the `after` snapshot.
     - A `console.error` thrown inside a verb appears in that action's events.
     - `between` holds an event dispatched between two verbs.
   - Then: export the crash handler UUID, add `now` to replies, add the console and error
     capture, and strip before printing in the CLI.
   - Risk: reply size on Android's adb forward. Measure it on the pooled emulator (budget 3 ms).
4. **`just agent trace`.**
   - Red tests: fixture run files → the list, the per-record lines, `--steps` round-trips into
     `parse_do`.
   - Then: the renderers, reusing `render_diff`/`render_events`.
   - Risk: none worth naming. It only reads files.
5. **Log correlation.**
   - `pid` in `app_launch` (Rust test on the payload).
   - `run.sh` `--stdout/--stderr` (check with `just ios-native`, then grep the listener's
     "listening on" line in `.agent/logs/`).
   - `--logs` window readers for journal, os_log and logcat (fixture tests for the window math,
     including `skewMs`).
   - Optional: tauri-dev tee.
6. **Harness and docs.** `diagnose.mjs` copies runs, and tool-eval reads run files. Update
   SKILL.md/commands.md ("Every action is recorded in `.agent/runs/<run>.jsonl`; read it with
   `just agent trace`"), the design doc and the justfile comment. Run `just check-agent-docs`,
   `just check-agent-first` and `just check`.

Standing risks:

- **Disk.** The cap is there to bound it. Whole-file pruning can drop a run someone wanted, so
  `trace` prints the retention line.
- **Two clients on one page.** Whichever reply ships `between` first takes it. Both are
  recorded, but in different run files. Documented ceiling.
- **Privacy.** Records hold note text. They cover dev vaults only (qa-target refuses anything
  else, M24). `.agent/` is gitignored and local. Jev requests already send the same text to
  TypeSafe.
- **The record must never fail a call.** Every write is best-effort: a failed write goes to
  stderr once, as the journal's `FailureReporter` does, and the exit code stays unchanged.
