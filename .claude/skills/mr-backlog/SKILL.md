---
name: mr-backlog
description: Work down a backlog of open merge requests — review each, address or comment on findings, resolve conflicts, and land them in dependency order. Use when the user says "work through the MR backlog", "review the N oldest MRs", "get these merged or closed", "clear the open MRs", or names several MRs to triage at once, or asks to "address the review comments on my open MRs". Not for QA-ing an MR on real devices (that is /mr-qa) and not for a single deep review (/slow-review).
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Agent, SendMessage
---

# MR backlog burndown

Goal for every MR in scope: **merged, or closed with a reason.** "Reviewed and
still open" is not an outcome. Verdicts are ship / ship-after-fixes / no-ship,
and an MR not worth shipping gets said out loud.

Merging is the user's call every time. Review, fix, comment, rebase, push — all
fine unprompted. **Never merge without explicit authorization in this session**;
"keep going" is not it.

---

## Step 1 — Enumerate

Set this once; every snippet below uses it:

```bash
API="https://gitlab.futo.org/api/v4/projects/futo-notes%2Ffuto-notes"

curl -s --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "$API/merge_requests?state=opened&per_page=100&order_by=created_at&sort=asc" \
  | python3 -c "
import json,sys
for m in json.load(sys.stdin):
    print(m['iid'], '|draft' if m['draft'] else '|LIVE', '|', m['created_at'][:10],
          '|', m['author']['username'], '|', m['title'][:60], '| notes:', m['user_notes_count'])"
```

Skip drafts unless asked. Then for each MR pull its `detailed_merge_status`,
`has_conflicts`, head pipeline, and its **comment history** (Step 1b). Two
buckets:

- **Has unaddressed review comments** → address them (or comment back).
- **No review** → review it.

Above ~10 MRs, bucket everything first, then work in waves of about five,
re-running this step between waves — the open set drifts while you work.

Write the buckets to `test-screenshots/mr-backlog/run.md` (gitignored) as a
one-line-per-MR ledger: iid, author, verdict, what changed, merged/open. Update
it as each MR resolves. A ten-MR pass will not fit in one context window, and
this is what lets a fresh session pick the run up without re-reviewing anything
— see *Context discipline*.

## Step 1b — Read the comment history properly

On an old MR the thread, not the diff, is where the state lives. Read it whole
and in order before forming a verdict — the most common way to waste everyone's
time is re-raising something already discussed, or "addressing" a point the
author already rebutted.

```bash
curl -s --header "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  "$API/merge_requests/<iid>/discussions?per_page=100" | python3 -c "
import json,sys
for d in json.load(sys.stdin):
    for n in d['notes']:
        if n.get('system'): continue
        flag = 'RESOLVED' if n.get('resolved') else ('OPEN-THREAD' if n.get('resolvable') else 'note')
        print(f\"[{flag}] {n['author']['username']} {n['created_at'][:16]}\")
        print(n['body'][:2000], '\n---')"
```

Use `/discussions`, not `/notes` — it groups replies into threads and carries the
`resolved` flag. **But do not lean on that flag here:** reviews on this project
are almost always posted as plain top-level comments, which are not resolvable at
all (sampled 2026-07-31: of seven MRs, only one had any resolvable notes). An
unresolved thread means nothing was clicked, not that the finding is live. You
have to decide "addressed" by reading the code.

- **Filter system notes out of the reading, but scan them for signal.** They are
  noise line-by-line ("added 3 commits") yet they date the force-pushes, target
  changes, and rebases. A review written *before* the last force-push may already
  be stale; a changed target branch means someone stacked it.
- **One comment can hold many findings.** A numbered list of four points is four
  items to track, and partially addressing it — fixing three, silently skipping
  the fourth — is the usual failure. Enumerate them explicitly before you start.
- **"Unaddressed" is about the code, not about replies.** A later commit may have
  fixed a point with no reply, and an author may have rebutted a point without
  changing anything. Check the current tree for each claim rather than trusting
  the absence of a response.
- **Distinguish review findings from design discussion.** Long architectural
  essays in a thread are context, not a checklist; the actionable items are
  usually a short reviewer comment further down.
- **Your own past comments age too.** If you commented on an MR and main has
  since moved, re-read what you wrote before doing anything else — advice that
  was right when posted can now send the author somewhere that no longer exists.
  Correct it in place rather than leaving it to be followed.

## Step 2 — Route by author

Check `author.username` before touching anything.

The split is **mechanical work vs. authored work**, not "hands off":

- **Someone else's MR** → rebasing, resolving conflicts, regenerating generated
  files, and retargeting are all fine, including `--force-with-lease`. What you
  do NOT do is write their fix: findings go in a review comment, plainly (see
  *Comment style*). Say in the comment that you rebased and what you resolved.
- **The requesting user's own MR** → fix it directly on the branch.

Unblocking a colleague's MR is a favor; silently rewriting the code they authored
is not. Keep the conflict resolution faithful to their intent — if resolving one
requires a judgment call about their behavior, stop and ask in the comment
instead of picking for them.

If an MR gains new commits after your review starts, re-diff against the new
head before commenting or merging. A review of a stale head is worse than none —
it sends the author chasing findings they already fixed.

## Step 3 — Review

Small/mechanical MRs (a few files, docs, config): review inline yourself, faster
than delegating.

Substantive MRs: one review subagent each, in parallel, **read-only**. Give each
the MR's own claims and tell it to be skeptical of them. Demand: verdict, defects
with `file:line`, whether tests genuinely pin the behavior, and real command
output.

**Bound the report.** A subagent reading a 50-file diff costs you nothing; its
3,000-word write-up costs you plenty, and that is what actually exhausts the
orchestrator. Ask for: verdict line, then at most ~8 defects as one to three
sentences each with `file:line`, then the commands run with their result lines.
Tell it explicitly not to reproduce diffs, file contents, or its reasoning
narrative — you will ask follow-ups if you need them, and a named agent can be
resumed with `SendMessage` at full context later. That resumability is the point:
the detail stays available in the subagent without living in your window.

Then **verify the load-bearing claims yourself** — subagents are
confidently wrong often enough that a claim you are about to act on (or repeat to
the user) needs your own `git show` / test run behind it. Your own reproduced
evidence wins any disagreement; one you cannot settle with a direct command goes
in the report as unresolved rather than being quietly decided.

Reviews worth asking for explicitly, because they catch this repo's recurring
failures:

- Does the change do what the description says, or is the description stale?
- **M17** — is the same bug/constant/pattern present in sibling files, fixed 1-of-N?
- **M11** — can any path report success while accomplishing nothing?
- **M8** — was a generated file hand-edited instead of regenerated?
- **M19** — did behavior change without `docs/spec/` moving?
- Does a test-only MR leave a real defect it discovered unfixed and untracked?
- Is a claimed defect actually a *tooling* artifact? (See the gap trap below.)

## Step 4 — Check the branch against **current main**, not the merge base

`git diff origin/main...origin/<branch>` (three-dot) shows the branch's own
changes — it will happily show a fix that **main already landed independently**.
Before accepting any hunk, confirm the problem still exists on main:

```bash
git show origin/main:<path> | grep -n '<the thing being fixed>'
```

A hunk that main already fixed is a guaranteed conflict and pure noise. Drop it
in the rebase and say why in the commit body.

## Step 5 — Fix findings

The user's own MRs: fix on the branch, one worktree per MR, small per-concern
commits with bodies naming the finding, then `git push --force-with-lease`.
Delegate bigger fix sets to a fixer subagent — each must do its own full
AGENTS.md + `codebase-organization.md` read.

## Step 6 — Conflicts

- **Generated files** (`docs/spec/GAPS.md`, `ToolbarSpec.*`, `TitleSpec.*`,
  bindings): never hand-merge. Take either side, run the generator
  (`node scripts/spec-gaps.mjs --write`, `just toolbar-spec`, …), commit the
  regenerated output. Hand-merging a generated file is M8.
- **AGENTS.md / spec prose**: taking "ours" silently reverts corrections that
  landed while the branch sat. Diff main's version since the merge base and
  hand-carry each semantic change.

## Step 7 — Order the merges by shared state

Before merging anything, work out which MRs touch the same lines or the same
counter, and sequence them. Couplings that have actually occurred — yours will
differ, these are the shapes to look for:

- One MR **deletes prose** another MR **corrects** → land the correction first,
  then carry the fact into wherever the deleting MR moved it (often
  `drift-registry.json`). Otherwise the correction is lost forever.
- One MR **deletes a file** another MR **edits** → the edit is moot; land it
  first or close it, and say which.
- Several MRs edit the **same allowlist or drift-registry entry** → sequence
  them and re-run the owning gate after each merge; stale entries fail by
  design.

State the order and the reason for it before merging.

## Step 8 — Stack instead of rebasing twice

If MR B will conflict with MR A once A merges, don't wait and rebase twice.
Rebase B onto A's branch now and retarget it. **Only when both MRs belong to the
requesting user** — retargeting modifies someone's MR, so for a colleague's,
suggest the stacking in a comment instead.

```bash
curl -s --header "PRIVATE-TOKEN: $GITLAB_TOKEN" --request PUT \
  "$API/merge_requests/<B>?target_branch=<A-branch>"
```

### Before blaming a stacked MR's red pipeline, check its base is fresh

A stacked MR's pipeline runs ITS OWN branch head, which can sit on a **stale
parent**. !204/!205 were stacked on !203 from before !203's fix commit, so
`test:e2e:rest` failed on them and the failure was attributed to !203 — whose own
pipeline was green on that very test. Nothing in the MR view or the job log says
"this pipeline does not contain the parent MR's current head", and it cost a
multi-hour root-cause hunt.

For a stacked MR (one whose `target_branch` is another open MR's `source_branch`),
assert the parent's tip is actually in the child's history:

```bash
git fetch --quiet origin
git merge-base --is-ancestor origin/<target_branch> origin/<source_branch> \
  && echo "base fresh" || echo "STALE BASE — this pipeline predates its parent's head"
```

A `STALE BASE` means the run tested a base without the parent's current head, so
**its failures are not attributable to its own diff** — rebase onto the parent and
re-run before triaging anything.

Scope this to stacked MRs only. Run against `main` it would fire for every MR
that is merely behind main, which is normal, and the noise would bury the signal.

Its diff stays readable while stacked. After A merges, retarget B to `main` — it
should show **no conflicts**. Verify that rather than assuming (`grep` exits 1
when it finds nothing, so give it an `|| echo clean`):

```bash
git merge-tree --write-tree --messages origin/main origin/<B-branch> \
  | grep CONFLICT || echo clean
```

## Step 9 — Merge, one at a time

Only with explicit authorization. For each MR, in order:

1. Re-check `detailed_merge_status`. After main moves it flips to `checking`
   for a few seconds — poll, don't treat it as blocked.
2. **Check the jobs yourself.** `only_allow_merge_if_pipeline_succeeds` is
   **off** on this project, so GitLab will let you merge over a red or unfinished
   pipeline. Gate on: no `failed` job with `allow_failure=False`, and no
   `running`/`pending` one either. `manual` and `allow_failure=True` don't block.
   The macOS runner is serialized at ~8 min/job — that is a wait, not a failure.
3. Merge, then re-fetch main and re-verify the next MR against it.

`PID` is the MR's `head_pipeline.id`. It can be `null` right after a retarget —
fall back to `"$API/pipelines?ref=<branch>&per_page=5"`.

```bash
curl -s --header "PRIVATE-TOKEN: $GITLAB_TOKEN" "$API/pipelines/$PID/jobs?per_page=100" \
  | python3 -c "
import json,sys
js=json.load(sys.stdin)
print('open:',[j['name'] for j in js if j['status'] in ('running','pending','created') and not j['allow_failure']] or 'none')
print('fails:',[j['name'] for j in js if j['status']=='failed' and not j['allow_failure']] or 'none')"
```

**Closing** an MR is the user's call exactly like merging. Recommend it with
evidence (`main already has this — git show <sha>`), and never close another
author's MR yourself; put the recommendation in a comment.

## Step 10 — Verify main afterwards

`just check` on merged main. Report the real result.

---

## Run the whole gate in the worktree, not a subset

Before declaring a branch green, the floor is **`pnpm run check:arch-gate:portable`
plus `just spec-gaps-check toolbar-spec-check title-spec-check`** — the portable
arch gate does NOT include those three, and backlog MRs churn spec gaps
constantly. `just check` is the real gate when time allows. Hand-picking two or
three gates is how a branch gets called green and then fails its pipeline.

## Local commands can have real side effects

Run full suites with the triage-bot credentials scrubbed:

```bash
env -u ZULIP_TRIAGE_BOT_EMAIL -u ZULIP_TRIAGE_BOT_KEY just check
```

`scripts/issue-triage/zulipAlerts.test.mjs` calls the real `postAlert` to assert
it rejects when credentials are absent — so on a shell that exports them, it
POSTs to the live `futo-notes-alerts` channel instead. If a message does go out,
say so immediately and delete it
(`curl -X DELETE -u "$ZULIP_TRIAGE_BOT_EMAIL:$ZULIP_TRIAGE_BOT_KEY" https://zulip.futo.org/api/v1/messages/<id>`).
Assume other suites can have side effects too.

## Context discipline

A ten-MR pass does not fit in one context window. Delegation is the lever, but
only if the *returns* stay small — the orchestrator's job is to hold verdicts and
merge order, not diffs. Four rules, in order of how much they save:

1. **The ledger is the memory, not your context.** Update
   `test-screenshots/mr-backlog/run.md` the moment an MR's verdict is known and
   again when it merges. If the session dies, the next one reads that file and
   resumes at the next unresolved MR. Never keep run state only in your head.
2. **Bounded subagent reports** (Step 3). This is the single biggest consumer —
   an unbounded review write-up can cost more than reading the diff would have.
3. **Never poll in a loop that prints every tick.** A `until …; do sleep 60; done`
   that echoes each check dumps dozens of near-identical lines into the
   transcript for no information. Print only on transition, or run it in the
   background and read the tail once.
4. **Verify narrowly.** Confirming a claim means one targeted
   `git show origin/main:<file> | grep -n <thing>`, not re-reading the diff the
   subagent already read.

If you are running out of room mid-pass anyway: finish the MR in hand, write the
ledger, and tell the user which MRs remain rather than starting one you cannot
finish.

## The gap trap

An MR that records a spec **Gap** from "the tool showed nothing" is suspect.
Before accepting one, check whether the spec already documents the opposite and
whether the source implements it — a tool's blind spot recorded as an app defect
is a live failure mode here (M21). Conversely, an MR *closing* a gap needs
evidence a tool actually exercised the thing; "no error appeared" is not
evidence.

## Comment style (someone else's MR)

Plain language, no jargon, like one engineer talking to another. Lead with the
verdict. Say what you verified rather than asserting conclusions, and give
`file:line` for every defect so it's actionable. Separate blockers from
nice-to-haves, and name follow-ups that deserve their own issue instead of
padding the MR. If a conflict appears later, say so and include how to resolve
it safely (regenerate generated files; watch the ratchet).

## Reporting

Per MR: verdict, what you verified with real command output, defects, what you
changed. Then the merge order and its reasoning. Corrections belong up front —
if you called an MR green and its pipeline then failed, say that plainly before
anything else. Finish with what is still open and who owns it.
