## 2. Findings, ranked by impact

Impact is judged on two things: the seconds an agent loses per step, and whether a person can
reconstruct afterwards what happened.

### F1. `do` receipts are raw pretty JSON, so agents throw them away and read again (driving, highest)

- `crates/futo-agent/src/main.rs:1524` prints every `do` as `pretty(&Value::Array(receipts))`.
  `render_diff`/`render_action` exist (`main.rs:1189`, `1318`), but only gestures and `diff` use
  them. The skill promises "a receipt saying what changed". What the agent actually gets is 50 to
  115 lines of nested JSON. One `Type "  "` came to 2,495 B over 115 lines, when one line would
  have said the same.
- Transcripts: of the 122 `do` calls Claude made, **87 (71%) were piped to `tail`/`head`/`grep`
  or `>/dev/null`**, and that cut the diff off. **81 of the 226 agent Bash calls were chained
  commands**, and the most common chains were `do && doc` (28), `do; do; doc` (12), `do && state`
  (8) and `do && actions` (3). The coordinator's count agrees: 115 `do`, 60 with a read chained
  into the same command (`doc` 53 times, `state` 14).
- What the receipt contains is mostly noise. In `.agent/trace.jsonl`:
  - 42% of `diff.elements.changed` entries change only a rect (layout shifts: checkbox widgets
    move when text is typed).
  - 41% are a container or editor row whose `textContent` repeats the doc
    (`NoteWorkspace.svelte div "+ Tag 1.one2.two…"`, `agentElements.ts:185-191`).
  - The `editor` block (`agentInspector.ts:176`, the full `editorState()` with 8 selection fields
    and `find`) is attached to every editor verb, and restates `diff.selection` and `diff.doc`.
    It is 14% of all `do` bytes.
  - `selected` on `Select` repeats `diff.selection` once more.
- The doc change arrives as a minimal hunk (`doc @27 -"" +"x"`, `agentTrace.ts:412-425`). It does
  not give the lines as they now read, so the agent runs `doc` to see them. The skill tells it to
  do exactly that (commands.md: "`doc` is the answer to 'what does it say now'").
- Cost: a chained read is ≈0.6 s of tool time plus the tokens it brings in. A separate read costs
  a whole model turn. 28 of the 146 actions (19%) were followed by a separate read, and Claude
  thought for 4.7 s on average before each one.

### F2. The receipt misses real changes, and says "no change" when the UI did change (driving and diagnosis)

- **Editor state is not in the snapshot.** `takeSnapshot` stores `screen`, `elements`, `doc`,
  `selection` and `shell` (`agentTrace.ts:380-392`). It does not store `editor.find` or `focused`.
  An input's value is also invisible, because `textOf` prefers `aria-label` over `value`
  (`agentElements.ts:186-190`), and the find field carries an aria-label
  (`findPanel.ts:62-63`). The result, from a recorded drive
  (`03-find-highlight-lingers/gate2`): `#4 SetFindQuery {"query":""} → 200 · no change`. In fact
  `find.query` went from `"the"` to `""` and `find.total` went to 0. This is the very bug the
  scenario asks about, and the receipt calls it nothing.
- **Receipts are taken before async renders finish.** `recordDo` snapshots straight after a
  synchronous verb returns (`agentTrace.ts:563`). The trace records 7 `changedSinceLast` cases:
  - `OpenNote`'s document arrived after its receipt (18:48:30, 20:27:40).
  - `OpenSettings` rendered "Reset to default" after its receipt (4 times).

  `step` works around this with its own loop (`main.rs:1578-1597`, 1.5 s ceiling). That loop
  "costs the whole wait" for an empty note. iOS and Android each wait on a real loaded signal
  (`AgentActionServer.swift:957-975`, `.kt:998`). So there are three separate "note is loaded"
  waits, and plain `do` on desktop has none.
- **`changedSinceLast` gets lost.** `await_pending` rebuilds 202 receipts and drops it
  (`main.rs:691-698`). `changedSince` goes silent once the previous `after` snapshot has left the
  40-entry ring (`agentTrace.ts:512`). On iOS, each `step` note-load poll takes a page `state`,
  and each `state` pushes a snapshot (`agentInspector.ts:476`).
- **Native verbs carry no diff at all.** `receipt()` returns `{ok, verb, …fields}`
  (`AgentActionServer.swift:706-710`, `.kt:701`). In jev-ios-final, 46 of 109 turns got a receipt
  with nothing about what changed (for example `OpenNote {"noteId":"work/standup","ok":true}`,
  with no screen after it).

### F3. Overlays, focus and element state never reach anyone's state (Jev's blind spot, and Claude's `actions` reads)

- The desktop shell's state is `note, tabs, sidebar, settingsOpen, searchOpen, toast`
  (`NotesShell.svelte:327-338`). It has nothing for a context menu, folder picker, create-folder
  dialog, confirm dialog or dropdown. iOS reports `sheet`. Android reports nothing, even though
  `AgentVerbs.modalUp()` knows (`AgentVerbs.kt:50`).
- `observe` takes every element (`collectElements({all:true})`, `agentInspector.ts:741`) and keeps
  only `ref, component, role, text` (`:764-771`). It drops `flags` (focused, expanded, selected,
  checked, disabled) and `rect`, so a hidden element looks like a visible one. Live example: the
  closed slash menu `e25 listbox "Insert block" 0×0` appears in every observation.
  `<input type=checkbox>` reads `"on"` and has no `checked` flag (`agentElements.ts:194-204`).
- Jev's state then removes elements altogether (`jev-drive.mjs:497`). It guesses the overlay from
  which verbs exist, and only for two cases (`computed.overlay`, `:509-514`). `slimReceipt` drops
  element changes (`:688`). Answer options are leaves of `app`/`receipt`/`computed`, so **Jev can
  answer only about state fields, never about what is on screen.** Recorded
  (`.agent/drive/2026-09-24T18-48-33-297Z.json`): the goal was "open the language dropdown,
  press it again to close it, report whether the dropdown is open". The listbox
  `e171 "System English 简体中文"` was in the observation. Jev skipped the second press and
  answered `app.settingsOpen = true`.
- Claude has the same gap. After an action, the separate read it made most often was `actions`
  (9 of 28). The receipt does not name the verbs that just appeared (`ChooseContextMenuItem`,
  `CloseSettings`, …). The account prints only `elements +4 -0`
  (`jev-drive.mjs:1063-1064`), which does not say what opened.

### F4. Fixed per-call overhead is spent outside the app (driving)

- `just agent` → `cargo run -q` costs ≈430 ms per call (justfile `agent`, line 720). Over the 226
  diagnose calls that is ≈100 s, against ≈30 run-seconds of actual app work.
- Every CLI process re-verifies the target by spawning node twice: `qa-target.mjs` at 130 ms and
  `slot.mjs` at 20 ms (`main.rs:383-409`). That is 65% of desktop `step` time (225 ms). iOS, which
  has no check, takes 100 ms. A Jev turn is ≈0.55 s, so the check is ≈20–25% of it. A press turn
  pays it twice (`click`, then `step`) and also a fixed 400 ms quiet window (`SETTLE_QUIET`,
  `main.rs:83`) that polls `events` every 100 ms.
- The desktop transport has no client timeout. `bridge_execute_js` blocks on `socket.read()`
  (`main.rs:573-581`). The bridge's own 5 s timeout (`tauri-plugin-mcp-bridge-0.10.0
  execute_js.rs:168`) fired only after 180 s in this session while the machine was under load. In
  transcripts, `elements` took 120 s or more (the tool timed out), `state` 60 s and `find` 55 s
  (11-language-dropdown-reopens/gate2: 287 s of that run's 417 s driving time was calls running).

### F5. Jev requests are about 70% speculative argument questions (driving cost, Jev latency)

Rebuilt from real traces (`jevsize.mjs`), one editor turn is 46 KB (≈12.9k tokens, which matches
the trace's 14.1k tokens per turn):

| part | chars |
|---|---|
| `arg:*` questions (56 of them) | 33,012 (72%) |
| `next` verb choice (80 options) | 7,141 |
| `answer` paths (71) | 3,078 |
| state: app+receipt+computed+history | ≈2,000 (4%) |

- `arg:mode` alone is 5,231 characters. `DEPENDS_ON` fans it out into one question per note id
  (`jev-drive.mjs:613-632`), although `mode` matters only for `OpenNote` and the task names one
  note.
- `from`/`to` together are 8.3k characters, `folderPath`/`title`/`name` 8.3k, and arguments of
  verbs no task uses (`width`, `x`, `y`, `fromIndex`, `toIndex`, `view`, `position`) 3k.
- The part Jev reads to understand the app is 4% of the request, and it lacks overlays, focus and
  what the last step changed (F3).

### F6. The CLI trace cannot be joined back to anything (diagnosis)

- A `.agent/trace.jsonl` line is `{at, kind, record}` (`main.rs:875-892`), and `record` is
  `{verb, status, result}` (`main.rs:1517`). It has **no args**: 24 of 25,583 lines contain
  `"args"`, and those are gestures. It also has no session id, no drive-run id or turn, no target
  platform, no page or app instance, no duration and no exit code. Reads are not recorded at all.
- Page timestamps are `performance.now()` (`agentTrace.ts:175`) and the CLI's are epoch ms, with
  no offset recorded between them. Action, snapshot and event ids reset on every page reload, and
  nothing identifies the page instance. So `receipt.result.action = 38` matches several different
  actions over a day.
- A `do` receipt gives the number of events it caused, not their ids (`agentInspector.ts:470`).
  The events stay in a 1,000-entry ring that is gone after a reload. Only gestures save their
  events in the CLI trace.
- The file is shared by every session and harness in the worktree. 65% of its lines are
  `CloseTab` from `reset.mjs`. It is never rotated. Concurrent writers interleave, because
  `writeln!` on an unbuffered `File` issues many small writes: 3 lines are corrupt JSON.
- Drive traces: each turn stores the full observation (≈55 KB per turn, 72% verb schemas) but not
  the **questions** Jev was asked, which are 70% of what it saw. `buildTurn` changes with every
  rubric edit, so an old trace cannot reproduce the old request. Turns have no timestamp
  (`jev-drive.mjs:837-846`). The file is written once, at the end (`:1206-1210`). When the app
  stops answering mid-run, the process exits before writing (`:1201-1204`), so **the failing run
  leaves no trace**.

### F7. Platform inconsistency (all of the above, multiplied)

| | desktop | iOS | Android |
|---|---|---|---|
| state keys | screen, editor, note, tabs, sidebar, settingsOpen, searchOpen, toast | screen, sheet, settings, sync, search, editor | screen, settings, sync, search, editor |
| overlay / modal in state | settingsOpen, searchOpen only | `sheet` | none (knows `modalUp`) |
| settings / sync values in state | **absent** | present | present |
| toast | yes | no | no |
| native verb receipt diff | — | none | none |
| page verb receipt diff | yes | yes (page only; the native title and find bar are not seen) | yes (same) |
| "note loaded" wait | CLI `step` docLength poll, 1.5 s; `do`: none | `awaitEditorLoaded` 3 s | `awaitEditorLoaded` |
| target check per call | 150 ms of node | none | none (adb forward) |
| `notes` | page | native store | native store (`.kt:488`), yet commands.md:42 says "Android still has no `notes` (501)", and `agentInspector.ts:589` has a stale refusal text |

### F8. Smaller gaps found along the way

- `Press` takes no modifiers, so keyboard shortcuts cannot be driven. The undo bug's agent tried
  `Press {"key":"z","mod":"Mod"}` and got a 400. The `Undo` verb calls CodeMirror's `undo()`
  directly, not the keymap a person's Cmd+Z reaches.
- `state` takes a whole snapshot only to return its id (`agentInspector.ts:476`). The id is noise
  to an agent, and the snapshot evicts ones the receipts need (F2).
- `jev-drive.mjs` `describeChanges` (`:1032-1066`) is a second copy of the Rust `render_diff`
  vocabulary, and the two have already drifted: the account counts elements, the CLI lists them.
- A refusal exits 2, and `just` then adds `error: recipe agent failed on line 721`, which is noise
  in every refused receipt.

### The user's hypothesis, tested

The hypothesis: "state should come back automatically with every action".

**Partly right.** Claude almost never needed the full state after an action: 6 separate and 14
chained `state` reads over 146 actions. What it read after actions was the **document as it now
reads** (53 chained and 5 separate `doc`), **the verbs now on offer** (12 `actions`), and a few
`find`/`elements`/`events`. It got those by reading again because the receipt either lacked them
or buried them in JSON it had cut off.

Sending the whole state (763 B pretty) with every action would add tokens, and most of them would
repeat the previous state. What should come back is:

- a **"where you are" header**, always, about 80 characters: screen, the top overlay, focus, and
  the caret;
- **only the changes**: state paths before and after, changed lines as they now read, verbs added
  or removed, overlays opened or closed.

For Jev the hypothesis is already implemented, since `step` means act then observe. There the
problem is what the observation leaves out (F3) and what the request wastes (F5), not how often
state is fetched.

---
