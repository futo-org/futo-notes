### Round three: handing steps back and forth

`drive --handoff` lets Jev give one step to the agent and take the driving back. Jev asked for
that itself in ≤2% of turns even while looping, so the handoff is code's decision, on three
signals: a hesitant pick (`next` confidence under 0.5) on a **write verb** or a verb with a
required value no list has; a document state revisited three times (insert, undo, insert…);
the same move with arguments twice running. Navigation Jev is unsure of stays Jev's to try:
gating every hesitant pick made it hand off `OpenNote` and `Undo` and burned six handoffs on
one task. The run stops with `outcome: needs-agent`, a `need:` line, exit 3, and the trace on
disk; `drive --resume <trace> '{"texts":[…]}'` (strings for Jev to write) or `'{"did":"… →
200"}'` (a step the agent took, with its receipt) continues with history intact. The turn
after a resume never hands off again: the answer is there to be acted on. Each handoff is a
line in the account, so the record says which steps were whose.

Measured with the harness playing the agent (one short Sonnet call per handoff, given only
the account, the open document and the screen's verbs, answering `texts` or one `do`):

| arm                                                                     | passed | Jev turns | handoffs        | wall  | cost  | per task |
| ----------------------------------------------------------------------- | ------ | --------- | --------------- | ----- | ----- | -------- |
| Jev alone (jev-workflows-4)                                             | 14/20  | 120       | —               | 98 s  | $0.05 | 4.9 s    |
| Jev + agent handoffs (jev-claude-workflows-2)                           | 17/20  | 109       | 9 on 8 tasks    | 142 s | $0.30 | 7.1 s    |
| Jev + agent handoffs, fixed surface + verifier (jev-claude-workflows-3) | 18/20  | 149       | 15 on 10 tasks  | 364 s | $0.66 | 18 s     |
| Claude alone with `drive` documented                                    | 18/20  | —         | never delegated | 545 s | $2.05 | 27 s     |
| Claude alone, no `drive` (round 0)                                      | 18/20  | —         | —               | 523 s | $1.68 | 26 s     |

Of the nine handoffs, four were writes Jev had no composed text for (the agent answered with
`texts` or one `InsertLine`/`ReplaceLine`), four were loops the cycle detector caught (the agent
answered with the one verb Jev kept missing: `PickFolder`, `MoveNote`, `ActivateTabAt`), one
was the agent replying nothing. Misses: `merge-lists` (the appended block lacks the blank line
before `## Shopping`; a composition detail in the agent's text), `two-untitled` (after the
handoff Jev chose a verb not on the `editor:new` screen), `background-tabs`, whose verifier was
wrong (see the misses table); with it fixed the mixed arm and Claude pass, and this arm is 18/20. A first pass of this arm with the gate on every hesitant pick scored
16/20 at $0.69 with 21 handoffs, two tasks exhausting the six-handoff safety.

Two things that sweep exposed, both fixed after it. `off-menu` on `two-untitled` was the
controller: when Jev says `answer` and the done-gate disagrees, the runner-up could be
`needAgent`, which is not a verb. And `editor:new` offered 73 verbs including
`MoveCurrentNote`, `DeleteCurrentNote`, `CopyCurrentNotePath` and the move picker, which act
on a file that does not exist yet (`MoveCurrentNote` there answers 200 with a "no longer
available" toast). `NoteWorkspace.svelte` now registers those four only once the note has an
id, so `actions` lists what can succeed. Re-swept: 17/20 again, 15 handoffs on 10 tasks, $0.66,
with six of the handoffs on `merge-lists`, whose stand-in agent sees only the account and the
open document and so cannot read the other note it must copy from. A real agent would query
it. The 18/20 figures for this arm and for Claude-with-`drive` are with the `background-tabs`
verifier fixed and that task rerun; the round-0 Claude row keeps its recorded 18/20. Jev alone
missed the rerun by skipping the final activate, so its 14 stands. `two-untitled` now ends `answered` with one untitled note instead of two.

**Claude never called `drive`**: 0 of its 124 commands, with `drive` in the usage text and
the command reference it was handed. Its own loop was good enough for tasks this size (17/20,
one more miss than round 0, well inside noise), so the docs alone do not make an agent delegate.
The eval prompt carries `commands.md`, not the skill; whether the skill's _Delegate the driving_
section changes that is unmeasured. Where delegation should pay is a bug scenario: many driving
steps to reproduce a symptom, then reasoning over the account.
