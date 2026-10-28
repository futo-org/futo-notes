## 3. Proposed record model

One rule: **the CLI is the one writer of the record, because it is the only process that sees
every platform and every actor.** The page, the listeners and Jev hand their parts to it in
replies it already receives. The record is one JSONL file per run, appended line by line.

### 3.1 Files and identity

```
.agent/runs/<run>.jsonl      one per run; the only agent record (replaces trace.jsonl and drive/*.json)
.agent/logs/<platform>-<id>.log   captured app stdout/stderr where the platform needs it (iOS)
```

- **`run`**: `FUTO_AGENT_RUN` if it is set. `drive` sets it for its children (`AS_DRIVER`), and
  harnesses set their own (`reset-…` for resets). Otherwise it is `session-<CLAUDE_CODE_SESSION_ID>`,
  or `person-<yyyy-mm-dd>` at a terminal. A drive run id is `<iso>-jev`.
- Every line: `{"v":1,"ts":<epoch ms>,"type":…,"run":…,"data":{…}}`. This is the journal's
  envelope plus `run`, so `jq` habits carry over.
- **One clock: wall-clock epoch ms everywhere.** The CLI, the page (`Date.now()`), the journal,
  `logcat -v epoch` and os_log all use it. Every page reply carries `now` (the page's
  `Date.now()`), so the CLI records `skewMs` per call. That matters for Android, where the
  device clock is not the host's.
  - *Correction to the audit's C7:* `timeOrigin + performance.now()` stops advancing while a
    Mac sleeps, so on a dev app that lives for days it drifts from the wall clock. Use
    `Date.now()` for `t`, and keep `performance.now()` for handler `ms`.
  - *Ceiling:* an NTP step can misorder events across sources. Within a source, ids stay
    authoritative.
- **Page id**: the crash handler's per-load UUID, exported and put in every page reply. Page
  keys become `(page, action|event|snapshot)`, which are unique forever. Crash reports join on
  the same id.

### 3.2 Record types

Examples are illustrative. The field sizes come from measurements.

```jsonc
// once per run file (and again whenever the target pid or page id changes)
{"v":1,"ts":1790283513297,"type":"run_start","run":"2026-09-24T18-48-33-297Z-jev","data":{
  "session":"b97890e7-…","actor":"jev","parent":"session-b97890e7-…",
  "goal":"Open the language dropdown, press it again to close it, …","texts":[],
  "target":{"platform":"desktop","port":9269,"pid":26881,"exec":"target/debug/futo-notes-tauri","dataDir":".tauri-data"},
  "repo":{"head":"9bc08048","dirty":false},"schemas":{"OpenNote":{…},…}}}   // verb schemas once, not per turn

// Jev: written after its reply, BEFORE the step it chose runs
{"v":1,"ts":…,"type":"turn","run":"…","data":{"turn":3,
  "request":{"model":"…","state":{…},"questions":{…}},          // verbatim what went to TypeSafe: replayable
  "reply":{"answers":{…},"usage":{"input_tokens":12697},"ms":250},
  "decision":{"next":"ToggleLanguageOptions","confidence":0.82,"override":null},  // or "runner-up: actionsDone 0.31"
  "move":{"verb":"ToggleLanguageOptions","args":{}}}}

// every CLI invocation, written BEFORE the request: a hung call leaves this line
{"v":1,"ts":…,"type":"call","run":"…","data":{"call":"51234.1","turn":3,"cmd":"step","verb":"ToggleLanguageOptions","args":{}}}

// its outcome, including errors and client timeouts
{"v":1,"ts":…,"type":"result","run":"…","data":{"call":"51234.1","ms":212,"status":200,"exit":0,
  "page":{"id":"4f1c…","now":1790283513510,"skewMs":1,"action":2,"before":{"id":2,"t":…},"after":{"id":3,"t":…},"events":[57,63]},
  "receipt":{…raw page body: diff, changedSinceLast, result…},
  "events":[…the TraceEvents in (57,63]…],
  "between":{"events":[…since the last reply this page shipped…],"moves":12,"clipped":0},
  "state":{…the full AppState after (sibling a); ~3–4 KB without schemas…},
  "printed":214}}                                               // bytes the caller got, so a truncation is visible

// reads: call + result with {cmd,args,ms,status,bytes}; the body only when status >= 400
// drive handoffs
{"type":"handoff","data":{"reason":"asked","detail":"…","refused":[…],"picks":[…]}}
{"type":"resume","data":{"did":"ran SetTitle myself"}}          // or {"texts":[…]}
// every exit path: answered, needs-agent, take-over, error, signal
{"type":"run_end","data":{"outcome":"answered","actual":"…","seconds":5.1,"observeMs":…,"jevMs":…,"inputTokens":…,"costUsd":…}}
```

A native verb (iOS or Android) gets the same `result`. `state` is the platform's `state` after
the verb (the CLI already needs it for the generic native diff, sibling C5), `page` is absent,
and `between` comes from the embed page when an editor is open.

### 3.3 Page-side changes (small)

1. `t = Date.now()`. Every reply carries `page: {id, now}`.
2. `do`, `trace end` and `step` replies include the action's `events`, `between` (events since
   the last reply this page shipped), and the full `after` snapshot. The CLI **writes** these
   and **strips** them before printing, so what Claude and Jev receive does not grow.
3. Record `console.warn/error`, `error` and `unhandledrejection` into the event ring as
   `type: "console" | "error"` (message, stack head, `t`). They then fall inside the event range
   of the action that caused them, on all three platforms. On desktop this replaces reading
   `__MCP_CONSOLE_LOGS__`.
4. Optional, only if S3 still needs it after 1–3: one `mutation` marker per animation frame
   (MutationObserver, counts only). It timestamps late renders between actions. It may overlap
   sibling (b).

The rings stay as they are (1,000/40/100). Every reply ships its own slice, so the rings only
have to cover one call.

### 3.4 Writing: incremental, atomic, bounded

- **One line = one `write(2)`.** Serialize to a `Vec<u8>`, push `\n`, call `write_all` once on an
  `O_APPEND` file. On a local disk this does not interleave. (`ponytail:` not guaranteed by
  POSIX for huge lines. Move to a per-process file if a line over 1 MB ever tears.) Jev uses
  `appendFileSync(path, line)`, which is also one write. There is no fsync: at 3.5 ms each it
  would cost more than the entire record.
- **Per-run files** remove shared writers. A drive run and its children never write at the
  same time (`execFileSync`).
- **Every exit path writes `run_end`.** `jev-drive` wraps `drive()` in `finally`, registers
  `process.on('SIGINT'|'SIGTERM')`, and sets `AbortSignal.timeout(30_000)` on the TypeSafe fetch
  and `timeout: 30_000` on the `Press` `execFileSync`. The CLI gets a client read timeout on the
  bridge (audit C4), so a hung call ends in `result {status:"timeout"}`.
- **Retention.** Files in `.agent/runs/` are capped at `FUTO_AGENT_TRACE_MB` (default 200 MB),
  and the oldest files are pruned **when a run file is created**, never on each call. Estimated
  rate: ≈4 KB of state per acting call × ≈5.7k acting calls a day (today's harness-heavy rate)
  ≈ 23 MB/day, plus Jev requests ≈ 46 KB/turn (≈25 KB after sibling C6). That is roughly a week
  of history at the default.
- **The acting gate** reads the last line (`run_end`) of the newest `*-jev.jsonl` whose
  `run_start.session` matches, with a seek to the end instead of whole-file reads.
- `--resume <run.jsonl>` folds the file (run_start, turns, results, handoffs) back into the
  state that `resumeFrom` needs today.

### 3.5 How app logs correlate

The join is always **target identity + time window**. The time window is
`[call.ts, result.ts]` of an action, or a run's span.

| source | key already there | what to add | how `--logs` reads it |
|---|---|---|---|
| Desktop journal | `ts` epoch, dir `.tauri-data/journal` | `pid` in `app_launch` (one field) | import `scripts/journal.mjs`'s reader, filter by window |
| Desktop console, JS errors | — | page ring entries (§3.3 item 3) | already in `result.events` / `between` |
| Desktop Rust stdout/stderr | — | `tauri-dev.mjs` tees the child output to `.tauri-data/tauri-dev.log`, truncated on start (optional, lowest priority) | grep lines by window. Lines carry no timestamps, so only a coarse window is possible (ceiling) |
| Crash reports | `session_id` = page id | nothing | match on `page.id` |
| iOS `print` | — | `run.sh`: `simctl launch --stdout=.agent/logs/ios-$SIM.log --stderr=…` (one flag). `ponytail:` stdout is block-buffered when it is not a TTY, so lines can arrive late or be lost on a crash; switch the agent listener's prints to `Logger` if that bites | window by file line order plus the call boundaries |
| iOS os_log | wall clock, process name | nothing | `xcrun simctl spawn $SIM log show --style ndjson --start … --end … --predicate 'process == "FutoNotesNative"'` (works after the fact) |
| Android logcat | device clock, pid | nothing (fix the `emu-logs` tag list separately) | `adb logcat -d -v epoch --pid=<pid> -T <device-epoch>`, with the window shifted by `skewMs`; ceiling: the ring may have rolled |
| Claude transcript | session id | nothing | `run_start.session` → `~/.claude/projects/<proj>/<session>.jsonl`, matched on `call.ts` |

### 3.6 Minimal tooling: `just agent trace`

This is one subcommand in `futo-agent`, and it reuses `render_diff`, `render_events` and
`render_action`. `trace` is not a CLI query today (the page's `trace` is the internal gesture
bracket), so the name is free.

```text
just agent trace                         recent runs: id · actor · session · platform · calls · outcome · span · size
just agent trace <run>                   one line per record: +ms, call/turn, verb args → status ms, the diff line, errors in events
just agent trace <run> <call|turn>       that record in full (state, events, receipt; for a turn the Jev request and reply)
just agent trace <run> --steps           the acting calls as a `do` batch JSON (for replay on another platform; gestures listed, not batched)
just agent trace <run> --logs            interleaves journal / os_log / logcat lines for the run window
```

`--json` passes lines through unchanged, so `jq` keeps working. Do not build a viewer UI.

### 3.7 Stories under the new model

S1: the `turn` holds the verbatim request, reply and `override`. S2: `between` plus the
`before`/`after` `t`. S3: snapshot `t`, and the optional mutation marker. S4: `result.events`
with handlers and console errors, joined to its turn by `call.turn`. S5: `--steps`, with
`actor` and `run` filtering out resets. S6: an orphan `call` line, a `result {timeout}`, and
`--logs` over its window. S7: `session` plus `call.ts`. All 7 become answerable from files on
disk.

---
