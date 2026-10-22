# `futo-agent` tool evaluation — three rounds, Sonnet, 31 tasks

Method: platform.claude.com/cookbook/tool-evaluation, pointed at `futo-agent` (see `README.md`).
The model is handed the CLI's usage text and `commands.md` and nothing else; every task has one
right answer read off the fixture vault; the app is reset between tasks. Strict = exact answer;
lenient = the right answer inside prose (prompt-following, not a tool problem). One run per arm.

| arm | strict | lenient | tool calls | wall | cost | what changed |
|---|---|---|---|---|---|---|
| baseline (`51e48fc8`) | 27/31 | 31/31 | 140 | 670s | $2.34 | — |
| revised | 25/31 | 30/31 | 67 | 368s | $1.66 | rows carry `note=`/`folder=`; gestures take `{"ref"}`; `find {"note"}`; `find {"text"}` off-editor is 409; `SetFindQuery` receipt has the count; verb return values no longer leak into receipts; `actions {"json":true}`; the `no such note` refusal names the id format; `commands.md` says open notes by id, never by clicking |
| revised2 | 28/31 | 31/31 | 60 | 329s | $1.63 | `doc` lines carry `L<n>`; `commands.md` states `screen` shapes, `[before, after]` receipt pairs, desktop `CreateNote` has no arguments |

Accuracy was never the problem: the baseline already answered 31/31 leniently. **The tool cost
2.3× the calls it needed.** Where they went, from the baseline transcripts:

1. **Opening a note by clicking its row** (delete-status 12 calls, rename 9, replace 9, line-text 9,
   find-total 12). `find {"component":"FolderTreeNoteRow.svelte"}` showed text but no id, so agents
   clicked the rect's corner, missed (the corner is padding, receipt says `no change`), re-read
   with `show`, clicked the centre, then read `state.note.id`. One agent passed an element ref as a
   `noteId`. Fix: rows carry the id, `OpenNote {noteId}` is documented as the way, `click {"ref"}`
   aims at the centre for the cases that genuinely need a click.
2. **Collapsed folders hid notes** (wikilink 9). Agents searched, opened search, clicked results.
   Same fix: `note=recipes/pancakes` is visible on the row, and the id opens it regardless.
3. **Stale receipt** (find-total 12). `SetFindQuery`'s receipt reported `total: 0` because the
   panel recomputes a frame later; the agent tried four queries and `StepFind` before trusting
   `state`. Fix: the verb scans synchronously.
4. **Miscounted lines** (line-text ✗ in revised). `doc` printed offsets only, and a blank line
   between two lines of text was skipped in the count. Fix: `L4  37│Today: eval harness.`
5. **Reference gaps** the agents named in `<feedback>`: `screen` values undocumented, receipt
   `shell.tabs: [[a],[a,b]]` unlabeled as before/after, desktop `CreateNote` takes no title.

Defects found by probing, not by the sweep: `do GoHome` exited 1 with `inspector reply has no
status` (the handler returned its tab object and `agentVerb` treated any return as a receipt);
`actions {"json":true}` printed the table.

## Per task

| task | baseline-sonnet ok/calls/s | revised2-sonnet ok/calls/s | Δcalls |
|---|---|---|---|
| screen-home | ✓ 1 10.2 | ✓ 1 5.78 | 0 |
| sidebar-view | ✓ 1 5.96 | ✓ 1 6.21 | 0 |
| line-of-word | ✓ 5 17.87 | ✓ 1 8.03 | -4 |
| line-text | ✓ 9 30.4 | ✓ 1 5.63 | -8 |
| offsets | ✓ 5 19.25 | ✓ 2 11.19 | -3 |
| row-component | ✓ 1 10.4 | ✓ 1 6.6 | 0 |
| wikilink | ✓ 9 41.26 | ✓ 2 12.09 | -7 |
| cursor | ✓ 2 11.92 | ✓ 2 9.39 | 0 |
| open-screen | ✓ 3 30.88 | ✓ 1 7.48 | -2 |
| tabs | ✓ 5 35.7 | ✓ 2 10.18 | -3 |
| settings-open | ~ 1 10.6 | ✓ 1 8.16 | 0 |
| sidebar-toggle | ~ 1 7.88 | ✓ 1 9.8 | 0 |
| search | ✓ 1 8.18 | ✓ 2 9.26 | 1 |
| folder-count | ✓ 2 14.33 | ✓ 2 11.25 | 0 |
| delete-status | ✓ 12 38.59 | ✓ 1 12.98 | -11 |
| theme | ✓ 2 9.72 | ✓ 1 7.79 | -1 |
| rename | ✓ 9 57.07 | ✓ 1 9.39 | -8 |
| bold | ~ 7 19.57 | ✓ 3 15.16 | -4 |
| replace | ✓ 9 26.78 | ~ 4 14.94 | -5 |
| insert-eol | ✓ 6 29.93 | ✓ 3 14.79 | -3 |
| italic | ✓ 5 26.43 | ✓ 4 13.86 | -1 |
| undo | ✓ 7 22.31 | ✓ 3 13.3 | -4 |
| find-total | ✓ 12 44.36 | ✓ 2 9.14 | -10 |
| create-note | ✓ 3 17.6 | ✓ 4 17.87 | 1 |
| click-row | ✓ 2 14.3 | ~ 2 13.57 | 0 |
| drag-select | ✓ 7 34.56 | ✓ 4 20.08 | -3 |
| batch | ~ 3 22.53 | ~ 3 15.18 | 0 |
| undo-refusal | ✓ 5 16.7 | ✓ 1 7.79 | -4 |
| unknown-verb | ✓ 1 6.44 | ✓ 1 6.76 | 0 |
| missing-arg | ✓ 3 18.26 | ✓ 2 9 | -1 |
| wrong-screen | ✓ 1 10.13 | ✓ 1 6.42 | 0 |

baseline-sonnet: strict 27/31 · lenient 31 · calls 140 · 670s · $2.34

revised2-sonnet: strict 28/31 · lenient 31 · calls 60 · 329s · $1.63

## What is left, per the revised2 feedback

- `replace`, `batch`, `click-row`: right answer wrapped in prose. Prompt-following; the eval
  prompt already says "nothing else".
- A `click` that lands on a container still reports `200 · no change`; with `{"ref"}` the miss
  mostly disappears, but the receipt could name what it hit (`at` already knows).
- `SetTitle` is async (debounced save) and the receipt does not say so; agents `sleep 3` and poll.
  `RenameNote {noteId, title}` is immediate and now the documented path.
- Phones are unmeasured. The harness is desktop-only until `reset.mjs` learns `FUTO_AGENT_TARGET`.

## Caveats

n=1 per arm on a machine that was also building; ±1 task and ±10% wall is noise. The revised →
revised2 call delta (67 → 60) is within that noise; the baseline → revised delta (140 → 67) is not.
