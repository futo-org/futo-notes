## 1. Current map

```mermaid
flowchart LR
  subgraph Desktop["Desktop (Tauri, one webview)"]
    PG["page engine src/app/agent<br/>verbs · snapshots · diff · events ring (1000)<br/>snapshots ring (40) · actions ring (100)<br/>t = performance.now()"]
    SH["NotesShell shell.state():<br/>note, tabs, sidebar, settingsOpen, searchOpen, toast"]
    SH --> PG
  end
  subgraph iOS["iOS (SwiftUI + editor webview)"]
    IS["AgentActionServer.swift :9476<br/>state: screen, sheet, settings, sync, search (+page editor)<br/>native verbs → {ok, verb, …fields}, NO diff"]
    IP["page engine (embed, no shell)"]
    IS -- evaluateJavaScript --> IP
  end
  subgraph Android["Android (Compose + editor webview)"]
    AS["AgentActionServer.kt (adb forward :9526)<br/>state: screen, settings, sync, search (+page editor)<br/>native verbs → {ok, verb, …fields}, NO diff"]
    AP["page engine (embed, no shell)"]
    AS -- evaluateJavascript --> AP
  end

  CLI["futo-agent (Rust, one process per call)<br/>resolve target: node slot.mjs (20ms) + node qa-target.mjs (130ms)<br/>do → pretty JSON ARRAY (never rendered)<br/>gesture → rendered text + events<br/>step → {receipt, observation} JSON<br/>appends {at, kind, record} to .agent/trace.jsonl"]

  PG -- "mcp-bridge WS execute_js<br/>(JSON inside a string, 5s server timeout,<br/>no client timeout)" --> CLI
  IS -- "HTTP loopback" --> CLI
  AS -- "HTTP via adb forward" --> CLI

  JUST["just agent = cargo run -q (≈430ms per call)"] --> CLI
  CLAUDE["Claude<br/>3–9s thinking per call"] --> JUST
  CLI -- "receipt ≈1.2–3.4KB pretty JSON<br/>71% piped to tail/head/null" --> CLAUDE

  JEV["scripts/jev-drive.mjs<br/>per turn: futo-agent step (≈225ms desktop, ≈100ms iOS)<br/>buildTurn → state + ~56 questions (46KB, ~12–14k tokens)<br/>TypeSafe jev-latest (~250ms)"]
  CLI -- "step: receipt + observation ≈11KB<br/>(72% verb schemas)" --> JEV
  JEV -- "account text (one line per step)" --> CLAUDE
  JEV -- "whole run as ONE pretty JSON at the end<br/>.agent/drive/&lt;time&gt;.json (55KB/turn)" --> DT[("drive trace")]
  CLI --> TJ[(".agent/trace.jsonl")]
```

What each hop carries, measured on desktop (`measure.mjs`, 5 runs each, median):

| command | wall time (binary) | via `just agent` | output |
|---|---|---|---|
| `state` | 160 ms | ≈590 ms | 763 B pretty JSON |
| `notes` | 157 ms | 590 ms | 198 B |
| `doc` | 161 ms | — | 166 B (4-line note) |
| `actions` | 158 ms | — | 5.9 KB table / 16.1 KB JSON (75 verbs) |
| `elements` | 162 ms | — | 3.0 KB table / 7.9 KB JSON (24 rows) |
| `at` | 158 ms | — | 1.8 KB |
| `step` (observe only) | 163 ms | — | 11.1 KB: `actions` 7,956 B, `elements` 2,248 B, everything else ~800 B |

Every query costs about 157 ms, whatever its size. Of that, `node scripts/qa-target.mjs port`
takes 130 ms and `slot.mjs` takes 20 ms. The page itself and the WebSocket take under 10 ms.
Through `just agent`, the fixed cost is ≈590 ms, because `cargo run -q` spends ≈430 ms on its
freshness check every time. The transcripts show the same: an agent `do` took 1.0 s on average.

Receipt sizes by verb (`.agent/trace.jsonl`, successful calls, printed pretty the way the CLI
prints them): `Type` median 1,499 B (p90 3,413), `Select` 1,196 (p90 3,314), `Insert` 1,182,
`SetTitle` 2,641, `CreateFolder` 2,579, `Press` 1,506 (p90 4,494). All editor verbs together:
median 1,179 B (≈340 tokens), p90 2,268 B. A native receipt (`MoveNote`, `GoBack` on the phones)
is 115–160 B and says nothing about what changed.

Jev (`tool-eval/runs`):

| sweep | pass | app ms/turn (median) | Jev ms/turn (median) | input tokens/turn |
|---|---|---|---|---|
| jev-desktop-final | 18/20 | 225 | 250 | 11,824 |
| jev-desktop-v3 | 19/20 | 247 | 277 | 12,697 |
| jev-workflows-merged-5 | 19/20 | 181 | 200 | 10,064 |
| jev-ios-final | 17/20 | 100 (mean 619, from note-load waits) | 205 | 7,912 |

Drive traces show tokens per turn rising from about 6k on 09-21 to 12.7–14.1k on 09-24.

---
