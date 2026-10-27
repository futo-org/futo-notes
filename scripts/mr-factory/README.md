# MR factory

Every hour, a headless Claude session runs `/mr-qa` on the non-draft MRs that have not yet been
judged at their current head commit. It merges every SHIP. You hear about an MR only when it
needs a human: it gets one comment, the `factory::needs-human` label, and a Zulip DM to its
author from the "FUTO Notes Code Review" bot: `left a comment on [!N](link)`. If any part of
the factory breaks, Justin gets a DM.

## What it does

The rules, settled 2026-10-26:

| Rule                                                                                                                                                                                                                                                                                                     | Where                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Picks open, non-draft MRs into `main` by `justin` or `mason`, oldest first, at most 5 per sweep                                                                                                                                                                                                          | `rules.mjs` `selectMrs`                              |
| Mason's MRs wait until Justin presses **Approve** in GitLab (for now)                                                                                                                                                                                                                                    | `rules.mjs` `APPROVER_FOR`                           |
| Skips MRs labelled `factory::hold`; taking an MR out of draft means "merge it if it passes"                                                                                                                                                                                                              | `rules.mjs`                                          |
| Judges each head commit once; a new push makes the MR eligible again                                                                                                                                                                                                                                     | `state.json`, keyed by SHA                           |
| SHIP → merged by the agent, no comment, no DM                                                                                                                                                                                                                                                            | `factory-prompt.md`                                  |
| NO SHIP → one fix attempt, then the comment, label and DM                                                                                                                                                                                                                                                | `factory-prompt.md`, `sweep.mjs`                     |
| Passed but on `/mr-qa`'s closed hold list → the same comment, label and DM                                                                                                                                                                                                                               | `factory-prompt.md`, `sweep.mjs`                     |
| MRs by anyone else, and stacked MRs not targeting `main`, are left alone                                                                                                                                                                                                                                 | `rules.mjs`                                          |
| Anything that keeps an MR from a verdict (GitLab, Zulip, the agent crashing, Codex or the device pool down) DMs Justin, at most once per 6 hours, with an all-clear when it recovers. Friction the agent got around is filed with `papercuts add` into the primary checkout's `.papercuts.jsonl` instead | `alertFailure.mjs`, `sweep.mjs`, `factory-prompt.md` |

Stacked MRs are picked up once GitLab retargets them to `main`, which happens when their
parent merges.

## Files

| File                                                 | Responsibility                                                              |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| `sweep.mjs`                                          | Launcher: select MRs, refresh the checkout, run the agent, apply its result |
| `factory-prompt.md`                                  | The unattended overrides on top of `.claude/skills/mr-qa/SKILL.md`          |
| `rules.mjs`                                          | Pure decisions and message text; `rules.test.mjs` tests them                |
| `services.mjs`                                       | State files, GitLab, and the Zulip bot                                      |
| `alertFailure.mjs`                                   | The `OnFailure=` handler that DMs Justin                                    |
| `futo-notes-mr-factory{,-failure}.service`, `.timer` | systemd user units (templated)                                              |
| `install-timer.sh`                                   | Fill in paths, install and enable the timer                                 |
| `env.example`                                        | Credential template                                                         |

## How a sweep runs

1. Sends any author DM a crashed earlier sweep left unsent.
2. Selects up to 5 MRs. If none, it exits without starting Claude.
3. Removes `factory::needs-human` from any MR it is about to re-judge.
4. Resets its own checkout (`~/.local/state/futo-notes-mr-factory/checkout`, detached at
   a fresh `origin/main`) and runs `pnpm install --frozen-lockfile`. `/mr-qa` creates its
   per-MR worktrees under it.
5. Runs `claude -p … --model opus --dangerously-skip-permissions` with a 3.5-hour timebox,
   using your normal Claude and Codex logins. The Zulip bot key is removed from its environment.
6. Validates the agent's JSON result, checks every claimed merge against GitLab, then posts
   each comment, adds the label and sends the DM. Each step is recorded in `state.json` before
   the next, so a crash never comments twice.

While a sweep runs, the hourly timer's ticks do nothing. A manual run takes a lock instead.

## Install

Install from the primary checkout. The units point at the checkout that installed them, and
`just wt gc` deletes worktrees. The papercut sweep's unit pointed at a deleted worktree and
failed on 2026-10-26.

```bash
mkdir -p ~/.config/futo-notes-mr-factory && chmod 700 ~/.config/futo-notes-mr-factory
cp scripts/mr-factory/env.example ~/.config/futo-notes-mr-factory/env
$EDITOR ~/.config/futo-notes-mr-factory/env   # GITLAB_TOKEN + the bot's email and key
chmod 600 ~/.config/futo-notes-mr-factory/env
scripts/mr-factory/install-timer.sh
```

Dry run (prints the MRs it would pick and the prompt; touches nothing):

```bash
set -a; . ~/.config/futo-notes-mr-factory/env; set +a
FUTO_MR_FACTORY_STATE_DIR=$(mktemp -d) node scripts/mr-factory/sweep.mjs --dry-run
```

## Operating it

- **Pause one MR:** add `factory::hold`, or put it back in draft.
- **Re-judge an MR without a push:** delete its entry from
  `~/.local/state/futo-notes-mr-factory/state.json`.
- **Logs:** `journalctl --user -u futo-notes-mr-factory.service`; each agent session is in
  `~/.local/state/futo-notes-mr-factory/logs/`.
- **Silence a stuck outage:** `rm ~/.local/state/futo-notes-mr-factory/health.json`.
- **Stop everything:** `systemctl --user disable --now futo-notes-mr-factory.timer`.
