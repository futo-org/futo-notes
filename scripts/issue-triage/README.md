# GitHub issue triage

Every new issue on the GitHub mirror
([futo-org/futo-notes](https://github.com/futo-org/futo-notes/issues)) is posted
to Zulip **#futo-notes-alerts**; bugs additionally get an autonomous
reproduction attempt, and — when reproduced — a `/bugfix`-protocol fix MR on
GitLab that links back to the issue. **No bot ever writes to GitHub.**

Design rationale and decisions live in
[`docs/plan/github-issue-triage.md`](../../docs/plan/github-issue-triage.md);
this file is the operator's manual.

## Two tiers

| Tier                             | What                                                                                                          | When it runs                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **1 — notify** (`poll.mjs`)      | Poll the mirror, post each new issue to Zulip, queue bugs for tier 2. No LLM.                                 | systemd user timer, every 15 min |
| **2 — triage** (`runTriage.mjs`) | One queued bug at a time: reproduce (45-min timebox), and if reproduced, open a fix MR. Headless Claude Code. | Manually / on demand (see below) |

Splitting them keeps a flaky agent run from ever losing an issue notification.

## Files

| File                                      | Responsibility                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| `poll.mjs`                                | Tier-1 orchestrator: read state → fetch new issues → post → queue            |
| `githubIssues.mjs`                        | GitHub provider: fetch issues (read-only PAT), normalize payloads            |
| `zulipAlerts.mjs`                         | Zulip provider: build + post the per-issue alert                             |
| `classifyIssue.mjs`                       | Pure bug / feature / other classifier                                        |
| `triageState.mjs`                         | Cross-process state transactions, persistence, watermark math                |
| `*.test.mjs`                              | Co-located unit tests (`node_modules/.bin/vitest run scripts/issue-triage/`) |
| `env.example`                             | Credential template for the systemd `EnvironmentFile`                        |
| `futo-notes-issue-triage.{service,timer}` | systemd user units (templated)                                               |
| `install-timer.sh`                        | Fill in node/repo paths, install + enable the timer                          |

## Credentials

Three secrets, read from the environment:

- **`GITHUB_PAT`** — a fine-grained PAT scoped to `futo-org/futo-notes`,
  **Issues: read only**. This read-only scope is the enforcement of "no bot
  writes to GitHub"; never grant it more.
- **`ZULIP_TRIAGE_BOT_EMAIL` / `ZULIP_TRIAGE_BOT_KEY`** — the dedicated
  "Issue Triage" Zulip generic bot.
- **`GITLAB_TOKEN`** — only needed by tier 2, to open the fix MR.

Interactive runs read these from `~/.zshrc`. The systemd service reads them from
`~/.config/futo-notes-issue-triage/env` (copy `env.example`, `chmod 600`).

The tier-2 child agent receives an explicit environment allowlist, not the
operator's whole shell environment. It retains GitLab push/MR credentials,
Claude authentication, and non-secret toolchain paths; the GitHub PAT, Zulip
bot key, cloud credentials, and unrelated host secrets stay in the launcher.

## State file

`~/.local/state/futo-notes-issue-triage/state.json` (override with
`FUTO_ISSUE_TRIAGE_STATE_DIR`). Machine-local operational state, **not**
committed.

```json
{
  "watermark": "2026-07-23T04:36:27Z",
  "issues": {
    "8": {
      "status": "queued",
      "title": "Android app \"bug\": Black text against the Android global dark mode",
      "url": "https://github.com/futo-org/futo-notes/issues/8",
      "author": "decloyd",
      "createdAt": "2026-07-23T04:22:28Z",
      "updatedAt": "2026-07-23T04:36:27Z",
      "classifiedAs": "bug",
      "zulipTopic": "gh#8: Android app \"bug\": Black text against the Andr…",
      "zulipMessageId": 462663,
      "mrUrl": null
    }
  }
}
```

`status` lifecycle: `posted` (feature/other stop here) → `queued` → `reproducing`
→ one of `mr_filed` | `not_reproduced` | `needs_human`.

Tier 1 and tier 2 update this file through a cross-process lock and atomic
read-modify-write transaction. Running the manual tier-2 command while the
timer polls cannot overwrite either process's state transition.

`watermark` is the max issue `updated_at` seen. It defaults to `2000-01-01`
(**not** the Unix epoch — GitHub's `since` filter treats `1970-01-01T00:00:00Z`
as unset and returns nothing). The state map, not the watermark, is the dedup
key, so a re-seen edited issue is never re-posted.

## Rollout (the autonomy dial)

Move one step at a time; hold at each until it looks trustworthy on real traffic.

0. **Dry run** — `… poll.mjs --dry-run` prints what it would post; eyeball it.
1. **Notify only** — enable the timer; tier 2 stays off.
2. **Triage live** — run tier 2 against queued bugs.

### Phase 0 — dry run

```bash
# Reads GITHUB_PAT from the env; uses a throwaway state dir so nothing is posted
# and the real watermark is untouched.
GITHUB_PAT=$(grep -oP 'GITHUB_PAT="\K[^"]+' ~/.zshrc) \
FUTO_ISSUE_TRIAGE_STATE_DIR=$(mktemp -d) \
node scripts/issue-triage/poll.mjs --dry-run
```

### Phase 1 — enable the notify timer

```bash
cp scripts/issue-triage/env.example ~/.config/futo-notes-issue-triage/env
$EDITOR ~/.config/futo-notes-issue-triage/env   # fill in secrets
chmod 600 ~/.config/futo-notes-issue-triage/env
scripts/issue-triage/install-timer.sh
```

The first live poll posts the existing backlog — each open issue as its own
Zulip topic. That flood is expected and fine at this volume.

### Phase 2 — run tier-2 triage (manual / on demand)

Tier 2 is never on a timer; you launch it against queued bugs. It runs a
headless Claude Code agent (`--dangerously-skip-permissions`) in an isolated
worktree with a throwaway `FUTO_NOTES_DATA_DIR`, 45-minute timebox, one issue at
a time. Credentials come from `~/.zshrc`.

```bash
# The oldest queued bug:
node scripts/issue-triage/runTriage.mjs

# A specific issue (also how you re-run one after adding repro info):
node scripts/issue-triage/runTriage.mjs --issue 8

# Set up the worktree + print the exact prompt without launching the agent:
node scripts/issue-triage/runTriage.mjs --issue 8 --dry-run
```

By default, tier 2 uses the repository checkout that contains
`runTriage.mjs`; it does not assume a particular `~/Developer` layout. Set
`FUTO_TRIAGE_REPO_DIR=/absolute/path/to/futo-notes` only when the worktrees
should be managed by a different checkout.

The launcher — not the agent — owns the Zulip follow-up and the state
transition, so a crashed or timed-out agent still reports `needs_human` to the
issue's topic. The agent writes a JSON result to `$TRIAGE_RESULT_FILE`; a fix,
if produced, is a GitLab MR left **open** (never merged), linking the issue.
Malformed results are treated as `needs_human`; `reproduced_fixed` is accepted
only with a valid `https://gitlab.futo.org/.../-/merge_requests/<number>` URL.
Cleanup runs even when the agent cannot spawn or the Zulip follow-up fails. A
Zulip failure exits non-zero after recording `needs_human` (and preserving a
valid MR URL), so the run is visible and safely recoverable.

## Recovery / re-runs

- **Re-run tier 2 on an issue** (e.g. a comment added new repro info): set that
  issue's `status` back to `queued` in `state.json` and run tier 2.
- **Force a re-post**: delete the issue's entry from `state.json`. The next poll
  treats it as new.
- **A poll failed** (unit is `failed`): `journalctl --user -u
futo-notes-issue-triage.service` for the error. The failure is the alarm —
  the poller never exits 0 on a GitHub/Zulip error.
- **A tier-2 Zulip follow-up failed**: the issue is left at `needs_human` and
  its valid MR URL is retained. Re-post from the run log, then set the intended
  terminal status in the state file.
- **Stop everything**: `systemctl --user disable --now futo-notes-issue-triage.timer`.
