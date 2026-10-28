## Round two: the agent keeps the eyes, Jev gets the hands (2026-09-21, later)

The goal was never Jev alone. It is an agent that offloads the driving and then reasons over
what happened, with Jev's speed. So the controller became a command of the tool:

```
futo-puppet drive '<goal>'            →  the account (text, for the agent)
                                        .puppet/drive/<time>.json (the full trace)
```

`scripts/jev-drive.mjs` is the controller, committed; the CLI is the doorway. The **account**
is one line per turn — verb, arguments, receipt status, `REFUSED` when the app said no, Jev's
confidence, and what changed in the CLI's own diff vocabulary (`screen`, `doc @27 -"fox"
+"**fox**"`, `selection`, `tabs`, `toast`) — then `outcome` (`answered`, `stalled`, `off-menu`,
`ceiling`), the final state, and the trace path. The trace holds every observation Jev saw,
every question with its probabilities, every receipt. The agent reads the account, opens the
trace where a line needs explaining, and queries the app (`state`, `doc`, `events`, `at`) for
what neither says. `.claude/skills/puppet/SKILL.md` § _Delegate the driving_ is the contract.

### Text input

The first workflow sweep put Jev at **8/20**, 692 actions, and two runaways (merge-lists
inserted `## Shopping` eleven times over 445 turns). Every text miss was one of three things:
no candidate carried a line break (`- butter` existed, `\n- butter` did not), only word ranges
were offered when the target was a whole line, and nothing stopped a repeated insert once the
wanted state was unreachable. Text is not Jev's job, and three changes took it off Jev's plate:

1. **Text comes from the caller.** `drive` takes `{"goal", "texts": [...]}` as well as prose.
   The agent composes the exact string, newlines included; Jev's text question is "which of
   these goes here". Prose goals keep backticked spans as the fallback source.
2. **Placement is structural, in the tool.** Three editor verbs, `ReplaceLine {line, text}`,
   `InsertLine {afterLine, text}` (0 = before the first) and `AppendLine {text}`, own the line
   break. A line number is a small closed set Jev picks well; offsets leave Jev's world for the
   common cases. An empty document's blank line is filled, not pushed down. These help the LLM
   arm too: the tool evaluation had already shown agents miscounting lines and offsets.
3. **Code verifies and stops.** After a write, code checks the text is in the document and the
   account says `TEXT NOT IN DOCUMENT` when it is not. A move identical to the previous one with
   non-empty arguments is a stall.

Also from the traces: the observation now carries the vault's `notes` and `folders` (a collapsed folder hid
`work/standup` from every candidate list); `from`/`to` are asked once per candidate text
("the verb writes `oat milk`; which range?") so "replace A with B, then C with D" pairs
correctly; a `mode` rubric says the empty home tab takes the first note; a bare word in the
task is not a note id until a row shows it; `x`/`y` a task gave no number for are omitted, not
nulled; `step` no longer waits for `editor:new` to load.

### Workflow results (20 tasks, verifier over the vault, 14 train + 6 held-out)

| arm                                                                    | passed | actions | wall  | cost  | per task |
| ---------------------------------------------------------------------- | ------ | ------- | ----- | ----- | -------- |
| Claude + `futo-puppet`, no `drive` (loop1 round 0)                      | 18/20  | 114     | 523 s | $1.68 | 26 s     |
| Jev, prose goals, before round two                                     | 8/20   | 692     | 337 s | $0.32 | 17 s     |
| Jev, prose goals, after (jev-workflows-4)                              | 14/20  | 102     | 98 s  | $0.05 | 4.9 s    |
| Claude + `futo-puppet` with `drive` documented (claude-drive-workflows) | 18/20  | 124     | 545 s | $2.05 | 27 s     |

Jev per turn after: observe 275 ms, Jev 260 ms, 9k tokens. Runs 2–4 landed on 13, 12 and 12 before the `AppendLine` fix; the 14 is that run with its two
trailing-blank-line tasks rerun after it, so ±1 is noise. The eight prose misses, by class:

| task                              | what happened                                                                                                                                                                           | class                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `note-in-folder`, `weekly-review` | three-part content (heading, blank, bullet) from prose; Jev orders the parts wrong                                                                                                      | prose cannot carry composed text → **use `texts`**                                             |
| `merge-lists`                     | needs the lines of another note copied in                                                                                                                                               | same; unreachable from prose by construction                                                   |
| `tick-and-add`, `append-link`     | `AppendLine` on a file ending in a line break added a second blank line; Claude's arm failed `append-link` the same way with the same verb                                              | tool defect, fixed after the sweep: `AppendLine` fills a trailing blank line                   |
| `two-untitled`                    | after `CreateNote` (screen `editor:new`) Jev creates again or opens another note instead of writing                                                                                     | model error on an empty screen; the `editor:new` state gives it little to anchor on            |
| `context-menu-move`               | passed twice, then took `MoveCurrentNote` instead of the picker the task demands                                                                                                        | rubric side effect, n=1 variance                                                               |
| `background-tabs`                 | the verifier encoded the browser convention for where two background tabs land; the app's spec says "immediately after the active tab", so a correct drive ends with the notes reversed | **check was wrong**; rewritten to test the driving (first tab, both open, active = second tab) |

Agent-composed goals close the first class: with `texts`, `note-in-folder` lands exactly in
5 turns / 5.8 s and `merge-lists` in 3 turns / 1.7 s (the doubled blank line in that run was
in the string I composed, which is the point: the caller owns the text).
