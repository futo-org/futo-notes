---
name: slow-review
description: Multi-agent slow code review. Runs Claude's code-review, /codex:review, and /codex:adversarial-review against the current diff or a PR, dedupes findings, ranks them critical/high/medium/low, and walks through fixes high-severity first. Inspired by Nolan Lawson's "using AI to write better code more slowly" workflow. Use when the user says "slow review", "deep review", "review with codex", "multi-agent review", "triple review", or wants a thorough cross-checked review before merging — especially before shipping sync, auth, encryption, migration, or other high-stakes changes. Trades speed for catching real bugs and surfacing pre-existing issues. Not for tiny diffs.
---

# Slow Review

Three independent reviewers, dedupe, rank, fix the important ones. Inspired by Nolan Lawson's *"using AI to write better code more slowly"* — AI is a quality-assurance partner, not a slop cannon. Expect to uncover pre-existing issues; treat the side-quests as the point.

## When this is the right tool

- Before merging anything non-trivial — especially sync, auth, encryption, migrations, anything user-data-touching.
- After a long coding session where you want a sanity sweep.
- When the user says "slow review", "deep review", "triple review", "review with codex".

Skip for: formatting-only diffs, fast-iterate-throwaway exploration, single-line fixes that already have a regression test.

## Workflow

### 1. Pin down scope

```bash
git fetch origin main --quiet 2>/dev/null || true
git diff --stat origin/main...HEAD
```

If the user named a PR, branch, or commit range, use that instead. Show the file list and confirm scope in one sentence before starting. If the diff is empty, stop and tell them.

### 2. Fan out three independent reviewers

The point of independence is that each reviewer sees the diff with no shared context. That kills the echo chamber and surfaces findings any single pass would miss.

Track the three reviews with TaskCreate so none get lost.

**Reviewer A — Claude `/code-review` at high effort.** Invoke via the Skill tool with `code-review` and effort `high`. This is your own pass, in-conversation.

**Reviewers B + C — Codex.** The `/codex:review` and `/codex:adversarial-review` *slash commands* are user-only (`disable-model-invocation: true`), but the slash command is just a thin wrapper around the companion script — **you can and should run that script yourself**, no hand-off needed. Fire both directly:

```bash
COMP="$HOME/.claude/plugins/cache/openai-codex/codex/<ver>/scripts/codex-companion.mjs"  # ver = installed plugin version, e.g. 1.0.5
# Reviewer B — standards/correctness pass:
node "$COMP" review --wait --base origin/main --scope branch
# Reviewer C — adversarial "should we even do this?" pass:
node "$COMP" adversarial-review --wait --base origin/main --scope branch
```

Critical invocation details (learned the hard way — get these wrong and the review silently reviews nothing):

- **`--base <ref> --scope branch` is mandatory when the work is already committed.** The reviewer's default scope is `working-tree`; if your fixes are committed ahead of `origin/main`, a bare `review` inspects the (empty/unrelated) working tree. Use the merge-base ref you pinned in step 1 (`origin/main`, a tag, etc.). For genuinely uncommitted work, omit both and it reviews the working tree.
- **Run each pass detached, not in a blocking foreground shell.** A real review of a multi-file diff can exceed a 10-minute foreground cap. Launch each `--wait` invocation with the Bash tool's `run_in_background: true` (you get the full output on completion). **Do not rely on the companion's own `--background` flag for reviews:** `review`/`adversarial-review` accept the flag but ignore it — their handler always runs in the foreground (only `task` actually enqueues a background job), so `--background` just blocks with no job ID to poll. The outer detached-shell wrapper is the only way to background a review. `node "$COMP" status --all --json` / `result <id>` / `cancel <id>` still work to inspect or cancel a review running in another shell. Peek at the detached output file after ~30s to confirm it printed `Thread ready` + `Reviewer started` (i.e. it's actually inspecting the diff, not wedged).
- **Run B and C sequentially, not concurrently.** They share one Codex runtime broker; two cold app-server spawns racing on the same socket can wedge both. Wait for B to finish, then fire C.
- **Never `pkill` the Codex processes.** The companion runs a long-lived shared broker (`app-server-broker.mjs`) that owns the `codex app-server` child; killing either orphans in-flight jobs and stalls new ones in `phase: starting`. If a run misbehaves, `node "$COMP" cancel <job-id>` the job — don't kill processes. Only as a last resort, full-reset the runtime (kill `app-server-broker.mjs`, delete the stale `broker.sock`/`broker.pid`, then re-launch a review, which respawns a fresh broker via `ensureBrokerSession`).

**Do Reviewer A (your own `/code-review`) in the foreground while B and C run detached.** When all three are in, move on. Do not skip the adversarial pass unless the user explicitly says so — that's the one Lawson highlights as having outsized value.

#### Troubleshooting: "command runner failed to start (`codex-code-mode-host` is missing)"

Codex's reviewer runs its diff-inspection shell commands through a separate helper binary, `codex-code-mode-host`, that ships in the Codex release dir but is **not** always symlinked onto `PATH` next to `codex`. When it isn't, every review dies immediately with that error and inspects nothing. Fix once, persistently, by symlinking the host onto `PATH` through the version-tracking `current` link:

```bash
ln -sf "$HOME/.codex/packages/standalone/current/bin/codex-code-mode-host" "$HOME/.local/bin/codex-code-mode-host"
which codex-code-mode-host   # should now resolve
```

Going through `current/` (not a pinned `releases/<ver>/`) means the symlink keeps working across Codex upgrades. Verify the underlying runtime is otherwise healthy with `node "$COMP" setup --json` (`ready`, `auth.loggedIn`, and a live `sessionRuntime.endpoint`) — but note `loggedIn` reads `false` whenever no app-server is currently live to verify through, even though `codex login status` shows you're logged in; that alone is not the problem.

### 3. Dedupe, rank, validate

Concatenate all findings. Then:

- **Dedupe.** Collapse near-identical findings into one row. Note which reviewers flagged it — 3/3 carries more weight than 1/3.
- **Validate.** For each finding, look at the code yourself. Confirm it reproduces. False positives are common, especially from the adversarial pass. Drop or downgrade ones that don't hold up — and note in your summary that you did.
- **Rank by severity:**
  - **Critical** — data loss, security hole, crash, encryption break, state-corrupting race.
  - **High** — wrong behavior on common paths, missing error handling at trust boundaries, obvious perf regression.
  - **Medium** — wrong behavior on rare paths, missed edge cases, poor UX, missing test for risky logic.
  - **Low** — style, naming, minor refactor opportunities, doc gaps.

### 4. Present the punch list before fixing

Show the ranked list first. Don't start fixing until the user picks what to address.

```
CRITICAL (N)
  1. <finding> — flagged by [A, B, C]
HIGH (N)
  ...
MEDIUM (N) — [user, want any of these?]
LOW (N) — [skip by default]
```

Default recommendation: **fix critical + high, skip medium + low** unless cheap. Be willing to say "this PR has a fundamental design problem — consider abandoning or restructuring" if the adversarial pass surfaces one and you agree after looking. Lawson's point is that the brave call is sometimes "throw this away," not "patch it."

### 5. Fix in passes, smallest diff per fix

For each approved fix:

- Apply the minimal change. No neighborhood cleanup — `bugfix` skill rules apply.
- If the fix exposes a pre-existing bug the PR didn't introduce, **surface it as a side-quest** the user opts into. Don't silently widen the diff.
- Add a regression test where applicable (see AGENTS.md test requirements table).
- Commit per logical fix or per severity tier — keeps reviewable history.

### 6. Re-verify and report

Run the project verification chain that matches what you touched (per AGENTS.md). If anything substantial changed, ask the user to run `/codex:review --background` once more on just the new commits.

Final report:

- **Findings** — count by severity, with how many fixed / dropped as false positive / deferred.
- **Fixes applied** — one line each, with files touched.
- **Pre-existing issues surfaced** — so the user can file follow-ups.
- **Verification** — commands run, pass/fail.
- **Recommendation** — ship / iterate / abandon.

## Custom bug rubric

Beyond standard correctness, flag findings against these (Lawson's expanded definition of "bug"):

- **KISS / DRY violations** — duplicated logic, abstractions invented before second use.
- **Accessibility** — missing labels, contrast, keyboard traps, ARIA misuse.
- **SQL / indexing** — full scans, missing indexes, N+1, transaction gaps.
- **Trust boundaries** — missing validation at user input, external API, deserialization.
- **Failure modes** — what happens when the network drops, disk fills, peer is malicious, sync conflicts.

If the user wants to add their own rubric items, save them as a project memory and apply them on subsequent runs.

## Why slow is the feature

Lawson's observation: this workflow rarely speeds you up. It surfaces tangential problems that should be fixed. *That* is the value. If the user is in a hurry, suggest plain `/code-review` instead — but tell them what they're trading away.

## Related

- `/code-review` — single-reviewer Claude pass, faster.
- `/codex:review`, `/codex:adversarial-review` — the two Codex passes this skill orchestrates.
- `/codex:rescue` — delegate a substantial fix to Codex when one finding turns into a deep investigation.
- `bugfix` skill — the discipline for applying each individual fix.
- `verify` skill — the final verification chain after fixes land.
