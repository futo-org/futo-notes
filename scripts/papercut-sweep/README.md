# Weekly papercut sweep

Every Monday at 06:30 a headless Opus session reads the open entries of the
repository's friction log (`.papercuts.jsonl`), fixes up to five that are
tooling-, docs-, or recipe-shaped in a dedicated worktree, marks them resolved,
and opens **one draft MR**. Nothing is ever merged by it.

This is the "papercuts get a weekly owner" half of `docs/plan/agent-dx.md`
(P1.5). The filing half is `docs/agents/papercuts.md`.

## Files

| File                                        | Responsibility                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| `sweep.mjs`                                 | Launcher: worktree off `origin/main`, `pnpm install`, timebox, result, cleanup |
| `sweep-prompt.md`                           | The agent's guardrails and procedure (appended system prompt)                  |
| `sweep.test.mjs`                            | Co-located unit tests (`node_modules/.bin/vitest run scripts/papercut-sweep/`) |
| `env.example`                               | Credential template for the systemd `EnvironmentFile`                          |
| `futo-notes-papercut-sweep.{service,timer}` | systemd user units (templated)                                                 |
| `install-timer.sh`                          | Fill in node/repo/PATH, install + enable the timer                             |

## How it runs

The launcher is the deterministic half and owns everything the agent must not
be trusted with, in the same shape as `scripts/issue-triage/runTriage.mjs`:

1. Reads the open cuts, ranks blockers and majors first, caps the list at 40.
2. `git fetch origin main`, then a worktree under
   `~/.local/state/futo-notes-papercut-sweep/worktrees/sweep-<runId>` on branch
   `chore/papercut-sweep-<runId>`.
3. `pnpm install --frozen-lockfile` there.
4. Spawns `claude -p <task> --append-system-prompt-file sweep-prompt.md --model
opus --dangerously-skip-permissions`, cwd = the worktree, with a 90-minute
   timebox. `FUTO_NOTES_DATA_DIR` points inside the worktree so no real vault is
   reachable (AGENTS.md M3). The repo's own hooks (`scripts/hooks/`) apply.
5. Reads the agent's JSON result (`mrUrl`, `resolved`, `skipped`, `summary`),
   validates it, removes the worktree (keeps the branch only when an MR was
   filed), and writes `last-run.json`.

`just orient` prints the last run's date, status and MR URL in every session,
which is how a failed run gets noticed without anyone reading systemd. A run
with no result exits non-zero, so `systemctl --user --failed` shows it too.

## Credentials and identity

- **`GITLAB_TOKEN`** — push the branch, open the MR. Read from
  `~/.config/futo-notes-papercut-sweep/env`.
- **Claude** — the operator's normal login. Unlike tier-2 issue triage, the
  sweep's input is our own agents' papercut text rather than public issue text,
  so it runs with the user's environment like the other timers on this machine
  (Reddit digest, usage-window ping). The tradeoff is stated plainly: the agent
  can see everything the user can; its prompt confines it to the worktree and
  the hooks deny process-name kills, `git stash`, and OS-level input.

## Install

```bash
cp scripts/papercut-sweep/env.example ~/.config/futo-notes-papercut-sweep/env
chmod 600 ~/.config/futo-notes-papercut-sweep/env   # then fill in GITLAB_TOKEN
just papercut-sweep-install
```

`install-timer.sh` bakes the current `PATH`, `node`, and the repo path into the
unit. **Re-run it from the primary checkout after this lands on main**, so the
timer stops pointing at the worktree it was first installed from.

## Operate

```bash
just papercut-sweep --dry-run                          # worktree + prompt, no agent
systemctl --user start futo-notes-papercut-sweep.service   # one run now
journalctl --user -u futo-notes-papercut-sweep.service -n 50
cat ~/.local/state/futo-notes-papercut-sweep/last-run.json
ls ~/.local/state/futo-notes-papercut-sweep/logs/       # the agent's full output per run
systemctl --user disable --now futo-notes-papercut-sweep.timer   # stop it
```

## What the agent may and may not do

Spelled out in `sweep-prompt.md`; the short version: fix and verify on this
machine without a device; resolve with a note that says what changed; one commit
per cut; `just check` green before push; one draft MR with a short description;
never merge; never touch `keys/`, publish jobs, CRITICAL guards, sync payloads,
`BRIDGE_VERSION`, or `AppState`; skip with a reason when the fix needs a Mac, a
device, or a design call.
