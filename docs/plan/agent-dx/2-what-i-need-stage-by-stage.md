## 2. What I need, stage by stage

Each row: what the stage needs, what exists, and the gap. "Have" means it works today in a fresh
worktree on both machines.

### 2.1 Orient (first 30 seconds)

- **Need:** one command that says which worktree and slot I am in, which ports and devices are
  mine, whether `node_modules` and `target/` are warm, what is dirty, which QA server is up, and
  which open papercuts touch the area I am about to work in.
- **Have:** `just ports`, `just qa-status`, `git status`, `papercuts list` — four commands, four
  formats, and nothing prints them unprompted.
- **Gap:** no orientation summary and no `SessionStart` hook to deliver it. Agents rediscover the
  slot model from `verify/SKILL.md` every session.

### 2.2 Build

- **Need:** a green baseline in minutes, on a warm cache when one exists nearby.
- **Have:** `just check` in 2 m 02 s from a cold worktree on jfedora; `just qa-clone-target` on
  macOS (APFS). `pnpm install` is 1 s here.
- **Gap:** no Linux equivalent of the clone (`cp --reflink=auto` on btrfs is the same one-liner);
  `qa-clone-target` is documented as macOS-only. Cold Rust for iOS on the Mac is ~10 minutes per the
  papercuts, and `test-ios-native` fails on a missing `node_modules/.bin/vite` only _after_ those 10
  minutes (`pc` 08-27). Fresh-worktree failures should fail in the first 5 seconds, not the last.

### 2.3 Run the real app without touching the real one

- **Need:** launch an isolated instance and prove it is mine.
- **Have:** the strongest part of the harness. `FUTO_NOTES_DATA_DIR`, `com.futo.notes.dev.wt<slot>`,
  `scripts/qa-target.mjs` (exit 3 on anything unsafe), `check-qa-input-safety` keeping the
  technique out of docs, `just qa-server` with a pinned SQLite server and no Docker.
- **Gap:** enforcement stops at the docs. A session that improvises OS input or a process-name kill
  from memory is only discouraged (`docs/architecture-gates.md` says so). Two Mac sessions in the
  transcripts got the user's "stop opening the app!!" — foregrounding a simulator or app during
  parallel work is the same class of problem and equally hookable.

### 2.4 Drive the UI

- **Need:** read the screen as structure, act on it by reference, get a definite answer about
  whether the action landed.
- **Have (desktop):** the Tauri MCP bridge — 140 `webview_execute_js` calls in the jfedora
  transcripts, the single most-used non-Bash tool. Loopback-only, slot-based port.
- **Have (Android):** `android-drive` with named debug hooks plus CDP for the editor WebView.
- **Have (iOS):** `simctl` + `axe` + `describe-ios-ui.mjs`.
- **Gap (desktop):** #115 — the bridge retargets unqualified calls to whichever app connected last.
  Every call must carry `appIdentifier`; nothing enforces it.
- **Gap (iOS):** the weakest link. `axe` absent on the Mac (`pc_d6d02599daa0`), `describe-ios-ui`
  reports "screen unknown (from no framed root) — 0 rows" for every screen on iOS 26.5
  (`pc_5fb25554deab`), HID typing hides the software keyboard for the rest of the boot
  (`pc_dd41a046601b`), headless-booted simulators return a 0×0 a11y root (`pc` 08-11), and the
  documented repair flag was never implemented (`pc_3c182ee6440d`). The iOS pre-push story gate fails
  on a pristine `origin/main` for the same keyboard reason (`pc` 08-31).
- **Gap (Android, closed by retiring the driver):** `android-drive`'s label tap scrolled the target
  under the status bar (`pc` 08-17); a bare `&` in a label was eaten by `just` argument parsing
  (`pc_9b7fd5dba746`); no-args help exited 2. `just puppet do <Verb>` and `tap` replaced it.

### 2.5 Observe what the app did

- **Need:** after an action, read what actually happened: which bridge message arrived, which FFI
  call ran, what the watcher suppressed, how long a keystroke took.
- **Have:** `just journal` for desktop sync runs (stream 1 of the agentic-first plan); `just emu-logs`
  tag greps on Android and `xcrun simctl spawn "$SIM" log stream --predicate 'process ==
  "FutoNotesNative"'` on iOS; `window.__testSync`.
- **Gap:** journal streams 2–4 (editor latency, watcher, bridge/FFI) are unbuilt; native shells do
  not journal; desktop has no log tail (#41). M21 ("suspect the tool before the app") stays a
  heuristic because there is no bridge trace to look up.

### 2.6 Wait

- **Need:** block on a condition and get a structured answer when it resolves: a pipeline finishing,
  a subagent's ledger reaching a row, a simulator booting.
- **Have:** `Monitor` in the harness; `until` loops in the skills.
- **Gap:** no repo helper. The result is the polling loops in §1: 28 hand-rolled `for i in $(seq …)`
  and `until` loops per machine among the slow calls, most against the GitLab API, several against a
  sibling agent's ledger file, each capped at 10 minutes and then re-issued. The `sleep` family fails
  a third of the time because the harness blocks bare sleeps.

### 2.7 Gate

- **Need:** know which suite proves my change, run exactly that, and get a machine-readable verdict.
- **Have:** the per-layer chains in the nested `AGENTS.md` files; `just check` as the umbrella;
  `just prepush` as the maximal chain; the mid-tier is CI.
- **Gap:** the mapping from "files I touched" to "recipes I must run" lives only in prose
  (`verify/SKILL.md` step 1). Recipes end with a `tail -40`, not a verdict line. The 50% pipeline
  failure rate in the last 60 runs is partly intentional red-proofing, but nobody can tell from the
  API which failures were expected.

### 2.8 Hand off

- **Need:** survive my own death. A killed session's successor should inherit what was verified.
- **Have:** the incremental verdict ledger in `app-qa`, the run manifest in `verify-specs`,
  `test-screenshots/<leg>-ledger.md`.
- **Gap:** no ledger for ordinary fix work; a successor reads the diff and re-runs everything. The
  user's "5 background agents were stopped by the user" appears 11 times across the transcripts;
  each stop costs whatever those agents had not written down.
