# Benchmarks for `just puppet`

What these benchmarks found, run by run, is in `docs/learnings/puppet-agent-driving.md`.
Three harnesses live here:

|                  |                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| `*-scenario.mjs` | the instruction-set A/B below: one old fix undone, one arm per commit, graded on the fix                  |
| `diagnose.mjs`   | a short bug report and a seeded bug (`bugs/`): did the agent reproduce it in the app, and find why        |
| `tool-eval/`     | goals a person would give, driven through `just puppet` and verified on the vault (`tool-eval/README.md`) |

`diagnose.mjs` can build its scenario from another checkout, e.g. main without `just puppet`:
`DIAGNOSE_SOURCE=<checkout> DIAGNOSE_PATCHES=main` uses `bugs/main/<id>.patch` where a bug had
to be ported by hand, and `bugs/<id>.patch` where it applies as is. Give each checkout its own
`DIAGNOSE_DIR` outside every checkout. "Recreated" counts only calls that reached the running
app (`appCallsOf` in `diagnose/grade.mjs`), the same rule for both.

The harness is committed; its runs, scenario repos and the held-out vault are not
(`.gitignore`). An agent being measured must never see it, nor the write-up:
`build-scenario.mjs` and `diagnose.mjs` leave `experiments/` and `docs/learnings/`
out of every scenario repo, and `tool-eval/run.mjs` denies its sessions reads of the
harness and the write-up. The arms' base commits (`ARM_BASE`) are from the experiment's draft history,
which only local `backup/` branches keep.

## The instruction-set A/B (`*-scenario.mjs`)

Measures whether how the tool is documented changes how well an agent fixes real
FUTO Notes bugs. Every arm has the CLI; each arm is a real commit (`ARM_BASE` in
`build-scenario.mjs`), from the tool as a reference file under the verify skill to
its own skill with a gate, so the routing in AGENTS.md and the skills cannot drift
between arms.

## The four scripts

```bash
node find-candidates.mjs            # which past fixes can still become scenarios
node build-scenario.mjs [<id>] [--arm baseline|treatment]
node verify-scenario.mjs [<id>]     # red-proof: the withheld test must FAIL
node run-scenario.mjs <id> [--arm …] [--model sonnet]
node grade-scenario.mjs <id> [--arm …] [--run <runId>]
```

## How a scenario withholds the answer

A scenario is **today's codebase with one old fix undone** — not a checkout at
the fix, which would predate the tooling being measured.

|                       |                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| source hunks          | reverted — this is the bug                                                                                                  |
| tests the fix touched | withheld — otherwise `just check` prints the answer                                                                         |
| `docs/learnings/`     | deleted — prose naming the root cause                                                                                       |
| `docs/spec/`          | **kept** — a spec that states correct behaviour over broken code is the realistic case, and what a real engineer would read |

The result is copied into a **fresh `git init`** with one commit. A worktree
would share the object store, so `git log main`, `git reflog` and
`git show <sha>` would all still reach the answer.

The withheld tests are the answer key. `verify-scenario.mjs` restores and runs
them against the broken tree and requires them to fail; a scenario that is green
before the agent touches it measures nothing.

Only **29 of 133** recent `fix(...)` commits still revert cleanly onto HEAD —
the rest were overtaken by later work, and hand-resolving the conflict would
invent a bug rather than restore the real one. `find-candidates.mjs` prints the
pool. Widen `--limit` to grow it.

## Grading

Four signals per run, in `runs/<runId>/scorecard.json`:

| Signal      | What it is                                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fixed`     | the withheld regression test, restored, now passes — the strongest, and `null` for a bug no test can express                                         |
| `intact`    | `just check` still green: no collateral damage                                                                                                       |
| `overlap`   | did the diff land on the lines the real fix touched (±8, since the revert shifts them)                                                               |
| `judgement` | a grader model reads every tool call against the real fix: same root cause, or papered over; did they ever run the app; did they touch `just puppet` |

## Two things the runner does on purpose

**A PATH shim refuses `pkill` and `killall`.** `pkill -f vite` reaches every
checkout on this machine (AGENTS.md M25); one unattended agent doing it takes
out the human's dev stack and every scenario beside it, and the damage reads
exactly like a real test failure. The shim refuses and logs the attempt to
`blocked-kills.log` rather than silently rewriting it — whether an agent reaches
for it is a finding.

**Each scenario repo is nudged onto a free slot.** Ports and QA devices come
from a hash of the repo path, so two scenarios (or a scenario and the checkout
you are working in) can land on the same simulator. The builder suffixes the
directory until `slotOf` is unique, which is why a scenario may be at
`<id>--<arm>-2`.

The runner passes `--setting-sources project`, so the agent gets the scenario's
own `AGENTS.md` and skills and never the operator's personal `~/.claude/CLAUDE.md`.
