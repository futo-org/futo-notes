# Benchmarks for driving the app

Every run is what really happens: a Claude Code session in this worktree gets a person's request,
with the repo's own instructions and the agent skill, and drives the app with `just puppet`. It is
scored by the task's verifier over the vault and the app's `state`, or by its answer containing the
expected value.

```bash
just tauri-dev                                              # this worktree's desktop app, once
node run.mjs --label <name> --set heldout --model opus      # a session per task
```

The only differences from a session of yours are the ones headless forces: nobody can approve a
plan (a note says so, since a personal "okay my plan first" rule ends a `-p` run at turn one), no
background subagents (they outlive the run), and permissions are `just puppet …` plus read-only
tools — anything else is denied and counted, where a real session would stop and ask.

| file | |
|---|---|
| `workflows.mjs` | the tuning set: multi-step goals with verifiers, on `fixture/` |
| `tasks.json` | `{id, prompt, expected}`; answers come from `fixture/` |
| `heldout/` | the judging set: 28 goals on a 497-note vault (`heldout/README.md`) |
| `reset.mjs` | home, no tabs, no overlays, the task's vault on disk, sidebar rows match |
| `runs/<label>/` | `report.md`, `summary.json`, per-task `.json` (calls, cost) and transcript `.jsonl` |

Only one run may drive an app at a time. To run two at once, give the second its own worktree
and `just tauri-dev`.
