## 1. Inventory of state today

### 1.1 Every field, by source, with size and consumers

Sizes are measured live on desktop (`grocery list` open) and averaged per turn over the iOS/Android
sweeps. "Claude" means the field was read in a transcript. "Jev" means `jev-drive.mjs` reads it, or
a recorded answer path used it.

| source → field | platforms | size | consumed by | verdict |
|---|---|---|---|---|
| page `state.snapshot` | desktop, **and leaked into iOS/Android `state`/`observe`** through the `where object[key] == nil` merge | 12 B | nobody. Each call pushes a snapshot into the 40-ring, which evicts the ones receipts need (F2) | **delete** |
| `screen` | all | 21 B | Claude, Jev (menu, visits), CLI `step` loop | keep |
| `editor.ready` | all (page) | 12 B | CLI `step` loop only | fold into `editor: null` / `{loading:true}` |
| `editor.docVersion` | all | 22 B | Jev `fillArguments`, visits; Claude as a proof (rule 6) | keep |
| `editor.docLength` | all | 15 B | CLI `step` loop only | **delete** (derivable, and "0" cannot tell empty from loading) |
| `editor.docHead` | all | ≤45 B | Claude `grep docHead` ×2, only because the receipt has no lines. Truncated at 40 chars, so `"1. first step\n\n3. inserted middle step2.…"` hid the bug it was grepped for | **delete** → `lines` |
| `editor.selection` {anchor, head, from, to, empty, text, line, col} | all | 90 B | Jev: head/from/to. Claude: from/to/text (find bug: `11-14 "The"`) | reshape: `caret {line,col,offset}` plus `selection {from,to,text}` only when it is not empty |
| `editor.focused` | all | 16 B | Claude (click and find bugs) | move to top-level `focus` |
| `editor.find` {open, query, current, total} | all | 50 B | Claude ×9 `state` reads after find verbs. Jev answer `app.editor.find.total`. **Not in the snapshot, so no receipt diff contains it** (F2) | keep; `null` while closed |
| `editor.clipboard` | all | 16 B | Jev (Paste rubric, `text` candidate) | keep; `null` when empty |
| `note` {id, title, dirty} | **desktop only** | 58 B | Jev answers: `app.note.id` ×16, `app.note.title` ×12, **none of which exist on phones** | keep; **add on phones** |
| `tabs` | desktop | 16 B | Jev (position/index candidates), answers | keep (desktop only) |
| `sidebar` {collapsed, view} | desktop | 34 B | no read, no answer | keep in full state; shown in lean output only when it changes |
| `settingsOpen`, `searchOpen` | desktop | 40 B | Jev answered `app.settingsOpen` for "is the *dropdown* open", which was wrong | **delete** → `overlay[]` / `screen` |
| `toast` | desktop | 10 B | Jev answers via `receipt.changed.shell.toast[1]` ×2 | keep; `null` when empty |
| `sheet` | iOS | 4 B | — | **fold into `overlay[]`** |
| `settings` {theme, issueReporting} | iOS, Android | 69 B | Jev answer leaves only | keep. **Add on desktop**, and add `language` everywhere: the language-dropdown bug has no state field at all |
| `sync` {connected, busy, live, serverUrl, status, lastError} | iOS, Android | 134 B | nobody in the recorded runs | keep in full state; lean output shows it only when it changes |
| `search` {query, hits} | iOS (list), Android (Search) | 7 B | Jev candidates | keep; `null` when absent |
| `notes` / `observe.notes,folders` (vault) | all (desktop via `observe`/`notes` only, **not in `state`**) | 93 B here (grows with the vault) | Jev candidates; `find` hints; rename/move/delete results | **move into `AppState.vault`**, so a rename or move diffs like everything else |
| `actions` (names + JSON Schema) | all | 7,956 B desktop (72% of `step`), 4,318 B iOS | Jev: verb filter plus argument names. Claude: 12 `actions` reads | `AppState.verbs` = names. Schemas stay behind `actions` and are cached per name |
| `observe.elements` {ref, component, role, text} | page | 2,248 B (25 rows, hidden ones included) | Jev: `ref`/menu-item candidates. `components` (202 B/turn in Jev's `app`) is never used by any rubric | sibling (b): visible rows plus flags; **drop `components`** |
| `observe.lines` {line, from, to, text} | page | 224 B | Jev (the core of every editing decision) | keep; in AppState as `editor.lines` |
| receipt `editor` block (full `editorState()`) | page verbs | 14% of all `do` bytes | restates `diff.selection` and `diff.doc` | **delete** (audit) |
| receipt `selected`, `action`, `events` count | page verbs | ~60 B | none | move to trace only |
| receipt `diff.elements` (rect-only 42%, doc-echo 41%) | page verbs | most of the receipt | Claude cuts it off (`tail`) | trace only |
| native receipt `{ok, verb, …fields}` | iOS, Android | 95–160 B | says nothing about what changed | replaced by the CLI's AppState diff |

### 1.2 Payload sizes today

| payload | size | notes |
|---|---|---|
| `state` (desktop, pretty) | 764 B, 0.26 s | half of it is the `editor` block |
| `step` observe (desktop) | 11,132 B | actions 7,956 · elements 2,248 · editor 283 · lines 224 · rest 421 |
| `do` receipt, pretty (9,049 in trace, CloseTab excluded) | median 571 B, p90 2,090 B | editor verbs: median 1,179 B |
| Jev request (317 turns, rebuilt) | median 37.5 KB = **9.8k tokens**; desktop 47 KB = 12.2k | the state is **3.5%** of the request |

Where the Jev request goes. This is a per-turn average over 317 turns. It sharpens audit F5:

| part | chars/turn | share |
|---|---|---|
| **the same ~285-char `stepRule` sentence repeated in every argument question (≈48/turn)** | 16,985 | **44%** |
| argument-question criteria (candidate lists) | 8,061 | 21% |
| premise fan-out (`arg:x@<subject>`, 27.6/turn): `mode`, `title`, `folderPath`, `name` × every note/folder, `from`/`to` × every text | 16,231 | 42% (overlaps the two rows above) |
| `next` (verbs + rubric + layout) | 5,648 | 15% |
| `answer` (71 paths) | 2,464 | 6% |
| `state` (app + receipt + computed + history) | 1,360 | 3.5% |

### 1.3 Defects found here (new against the audit)

- **N1. Phones leak the page's `snapshot`.** Every iOS/Android `state` call snapshots the page.
  `AgentActionServer.swift:588` merges page keys where they are missing, so `snapshot` appears in
  every phone observation. Each read also evicts the snapshot ring.
- **N2. The stored Jev state is not the state Jev saw.** `buildTurn` puts the live `history` array
  into `state` by reference (`jev-drive.mjs:554`), and `history.push` later mutates it. **252 of
  305** stored turns show a different history length than they were sent. For example, turn 1 of
  `.agent/drive/2026-09-24T18-48-31-364Z.json` shows 4 steps where there were 0. A trace cannot
  reproduce a request. (Sibling (a)'s file format should store an id plus a copy, never a
  reference.)
- **N3. The phones have no `note`.** 28 recorded answers used `app.note.id`/`title`, a path that
  does not exist on iOS/Android. On the phones, the open note's title field is native, so no state
  field carries it.
- **N4. Desktop has no settings in state at all,** so theme and language changes do not show in
  any receipt.
- **N5. Keys vanish instead of going null.** iOS omits `editor` whenever a sheet is up
  (`.swift:582`), and `search` appears only on some screens. Any before/after diff then reports a whole
  subtree added or removed.
- **N6.** `observe` sends `components` (a list of Svelte file names) into Jev's `app`, where no
  rubric uses it. The answer options also include 5 `searchOpen`/`settingsOpen`/`sidebar` leaves
  per turn that no recorded answer used.

---
