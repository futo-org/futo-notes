## 1. Current map

| record | producer | format / location | lifetime | ids and clock | growth (measured) | reload | crash / hang |
|---|---|---|---|---|---|---|---|
| Page events | `agentTrace.ts` `capture` | ring in page memory | 1,000 entries | id resets per load; `t` = `performance.now()` | 353 B median per event; a `do` causes 0–6 | **lost** | lost |
| Page snapshots | `takeSnapshot` (before and after every action, and every `state`/`elements`) | ring | 40 entries | same | a few KB each | **lost** | lost |
| Page actions (`ActionRecord`, incl. `changedSinceLast`) | `recordDo`, `begin/endGesture` | ring | 100 entries | same | — | **lost** | lost |
| CLI trace | `append_trace` (`main.rs:875`) for `do`, `step`'s receipt and gestures | `.agent/trace.jsonl`, one file per worktree, every writer | forever, never rotated | CLI `at` epoch ms; page action id inside | 6.5 MB in 4 days (1.6 MB/day); line median 138 B, p99 1.5 KB, max 9.7 KB; 65% are `CloseTab` from `reset.mjs` | survives | a hung call writes **nothing** (written after the reply); 3 corrupt lines |
| Drive trace | `jev-drive.mjs:1210` | `.agent/drive/<iso>.json`, pretty, whole run | forever | no timestamp per turn (`observeMs`, `jevMs` only); `session` since 09-24 | 8.6 MB for 28 runs; 55 KB/turn pretty; one run 3.9 MB | survives | **nothing** on hang, unreachable app or SIGTERM |
| Harness turn copy | `tool-eval/run.mjs:108,171` | `runs/<sweep>/<task>.jsonl`, compact, at the end | kept | as drive | 136 MB in 110 sweeps | — | at the end only |
| Diagnose run | `diagnose.mjs` | `runs-diagnose/<bug>/<iso>/`: transcript, app.log, score | kept | Claude transcript timestamps | 8.4 MB in 30 runs | — | `.agent` **wiped, never copied** |
| Desktop instance journal | `futo_notes_core::journal` | `.tauri-data/journal/journal-NNNNNN.jsonl`, `{v,ts,type,data}` | 4 MB × 5 segment ring | epoch `ts`; no pid | 10 `app_launch` lines | survives | background writer, drops are counted |
| Desktop console | mcp-bridge `bridge.js` | `window.__MCP_CONSOLE_LOGS__` | unbounded, in memory | `Date.now()` | 2 entries live | **lost** | lost |
| Desktop Rust stdout/stderr | `println!`/`eprintln!` | the launching terminal | scrollback | none | — | — | lost unless teed |
| Crash reports | `crashHandler.ts` | appData `.crashlogs/crash-<ts>-<sid>-<eh>.json` | until sent | ISO time + per-load UUID `session_id` | rare | survives | survives (that is their job) |
| iOS native listener | `AgentActionServer.swift` | `print` (4 lines) | not captured | — | — | — | — |
| iOS app logs | 25 `print`, 2 `Logger` | os_log (Logger only) | unified log, retroactive with `log show` | wall clock (host = sim) | — | survives | survives in the unified log |
| Android native listener | `AgentActionServer.kt` | logcat `FutoAgent` (bind and fail only) | logcat ring | device clock | — | — | ring rolls over |
| Android app logs | `Log.*` on ~12 tags | logcat | ring buffer, retroactive with `logcat -d -T` | **device** clock | — | survives | until the ring rolls |
| Claude transcripts | Claude Code | `~/.claude/projects/<proj>/<session>.jsonl` | kept | ISO per message | — | — | — |

Nothing joins these records. The keys that would join them exist, but none is written down:
the session id (in env), the page id (in `crashHandler`), the pid (qa-target prints it and the
CLI throws it away), the run id (the drive file name).

---
