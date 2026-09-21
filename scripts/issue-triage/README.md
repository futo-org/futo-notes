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
| `githubIssues.mjs`                        | GitHub provider: fetch issues (no credential), normalize payloads            |
| `zulipAlerts.mjs`                         | Zulip provider: build + post the per-issue alert and the health messages     |
| `classifyIssue.mjs`                       | Pure bug / feature / other classifier                                        |
| `triageState.mjs`                         | Cross-process state transactions, persistence, watermark math                |
| `healthState.mjs`                         | Outage state + alert throttling for the poller's own health                  |
| `alertFailure.mjs`                        | The `OnFailure=` handler: report a failed poll to Zulip                      |
| `jsonFile.mjs`                            | Crash-safe (tmp + rename) JSON read/write shared by both state files         |
| `*.test.mjs`                              | Co-located unit tests (`node_modules/.bin/vitest run scripts/issue-triage/`) |
| `env.example`                             | Credential template for the systemd `EnvironmentFile`                        |
| `futo-notes-issue-triage.{service,timer}` | systemd user units (templated)                                               |
| `futo-notes-issue-triage-failure.service` | systemd `OnFailure=` unit that posts the failure alert                       |
| `install-timer.sh`                        | Fill in node/repo paths, install + enable the timer                          |

## Credentials

Credential groups are read from the environment:

- **GitHub: none.** `futo-org/futo-notes` is public, so the poller reads issues
  anonymously. That is the enforcement of "no bot writes to GitHub" — a request
  carrying no identity cannot write — and it cannot expire. A fine-grained
  read-only PAT used to sit here and hit its 30-day lifetime on 2026-08-22,
  costing 11 days of missed issues. **Do not add one back.** The cost is
  GitHub's anonymous budget of 60 requests/hour/IP against the timer's 4;
  an exhausted budget is reported as a rate limit, not as a bad credential.
- **`ZULIP_TRIAGE_BOT_EMAIL` / `ZULIP_TRIAGE_BOT_KEY`** — the dedicated
  "Issue Triage" Zulip generic bot.
- **`GITLAB_TOKEN`** — only needed by tier 2, to open the fix MR.
- **`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`** — an explicit Claude
  credential required by tier 2. The launcher fails closed instead of exposing
  the operator's normal Claude configuration directory.

Interactive runs read these from `~/.zshrc`. The systemd service reads them from
`~/.config/futo-notes-issue-triage/env` (copy `env.example`, `chmod 600`).

The tier-2 child agent receives an explicit environment allowlist and a fresh
`HOME`/XDG/tool configuration rooted inside its isolated worktree. It
retains only explicit GitLab and Claude credentials plus non-secret toolchain
paths. Git pushes use HTTPS with an isolated askpass helper, so the child does
not receive the operator's SSH agent. The Zulip bot key, cloud credentials,
normal home/config files, and unrelated host secrets stay in the launcher.

## State files

Both live in `~/.local/state/futo-notes-issue-triage/` (override with
`FUTO_ISSUE_TRIAGE_STATE_DIR`). Machine-local operational state, **not**
committed. `state.json` is the issue pipeline; `health.json` is the poller's own
health, kept separate so nothing about alerting can endanger the issue map that
prevents duplicate posts.

### `state.json`

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

### `health.json`

```json
{
  "failing": true,
  "firstFailureAt": "2026-08-22T17:06:28Z",
  "lastAlertAt": "2026-08-22T17:06:29Z",
  "alertCount": 1,
  "lastError": "GitHub 401 on /repos/futo-org/futo-notes/issues: Bad credentials",
  "lastErrorAt": "2026-08-22T17:06:28Z"
}
```

Written by `alertFailure.mjs` (which opens the outage) and cleared by the first
successful poll (which posts the all-clear). `firstFailureAt` is pinned to when
the outage began, so a recovery message can state the real duration.

## Failure alerting

A red systemd unit is only an alarm if somebody reads systemd. Nobody did: the
old GitHub PAT expired on 2026-08-22, every 15-minute poll failed with 401, and
nine issues went unposted for 11 days. So the poller now reports its own
breakage to the same channel it feeds.

- The service carries `OnFailure=futo-notes-issue-triage-failure.service`, which
  runs `alertFailure.mjs` and posts to the **`poller health`** topic in
  #futo-notes-alerts — one stable topic, so an outage and its recovery thread
  together and can be followed or muted on its own.
- **Throttled to one message per 6 hours** while an outage stays open. The 11-day
  outage above would have been 1,056 failed runs; it costs 44 messages.
- `alertFailure.mjs` — not `poll.mjs` — opens the outage, because being invoked
  at all *is* the failure signal. A crash that never reaches the poller's error
  handler (missing node, OOM, unreadable `EnvironmentFile`) still alerts, just
  with a generic reason instead of the recorded one.
- The **first successful poll** posts the all-clear: how long it was down, and
  how many issues the catch-up run posted. Recovery is only observable by the
  run that succeeds, so it cannot live in the failure handler.
- The failure unit has **no `OnFailure=` of its own**. When Zulip is what is
  down, the alert cannot post either, and the right outcome is one red unit in
  the journal rather than a self-triggering loop.

## Rollout (the autonomy dial)

Move one step at a time; hold at each until it looks trustworthy on real traffic.

0. **Dry run** — `… poll.mjs --dry-run` prints what it would post; eyeball it.
1. **Notify only** — enable the timer; tier 2 stays off.
2. **Triage live** — run tier 2 against queued bugs.

### Phase 0 — dry run

```bash
# Needs no credential to read GitHub. The throwaway state dir means nothing is
# posted, the real watermark is untouched, and an open outage is not cleared.
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
issue's topic. A successful terminal state is committed only after the Zulip
follow-up succeeds, so a crash cannot falsely claim the promised alert was
sent. The agent writes a JSON result to `$TRIAGE_RESULT_FILE`; a fix, if
produced, is a GitLab MR left **open** (never merged), linking the issue.
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
- **A poll failed** (unit is `failed`): the `poller health` topic in
  #futo-notes-alerts already says so; `journalctl --user -u
futo-notes-issue-triage.service` has the full error, and `-u
futo-notes-issue-triage-failure.service` shows whether the alert itself got
  out. Nothing is lost — the watermark means missed issues post on the first
  successful run, which also posts the all-clear.
- **Alerts are too noisy / too quiet**: `ALERT_THROTTLE_MS` in
  `healthState.mjs`. Silence a stuck outage by hand with
  `rm ~/.local/state/futo-notes-issue-triage/health.json` — the next failure
  starts a fresh outage and alerts immediately.
- **A tier-2 Zulip follow-up failed**: the issue is left at `needs_human` and
  its valid MR URL is retained. Re-post from the run log, then set the intended
  terminal status in the state file.
- **Stop everything**: `systemctl --user disable --now futo-notes-issue-triage.timer`.
  The failure unit is triggered only by the service, so it stops with it.
