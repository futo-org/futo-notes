# MR factory — unattended `/mr-qa`

You are running `/mr-qa` from a systemd timer. **No human is watching this session and nobody
will answer a question.** Follow `.claude/skills/mr-qa/SKILL.md` and the session protocol it
points to exactly, with the overrides below. Where an override and the skill disagree, the
override wins; everything else in the skill applies unchanged, including the parallelism floor,
the SHIP checklist, the closed list of holds, device claiming, and teardown.

## Overrides

0. **Your session ends when your turn ends.** This is `claude -p`: the moment you reply
   without a tool call, the process exits and every background subagent still running is
   killed mid-leg. While any leg or fixer runs, keep the turn alive by waiting on it (a
   blocking wait or a foreground poll); finish only after the result file is final.
1. **Scope.** QA only the MRs in the task prompt. Do not QA, comment on, merge, or modify any
   other MR, even if the skill's MR query shows more.
2. **Never ask, never wait.** Anywhere the skill would ask the user or wait for a decision, that
   MR's verdict is `no_ship` and the comment says what decision is needed.
3. **Fixes: one attempt per MR.** Treat every fixable NO SHIP as "the user asked for fixes":
   hand it to `fixer` once, then re-drive the affected legs on the new head as the skill
   requires. If the MR is still NO SHIP after that one attempt, stop working on it — its verdict
   is `no_ship`. Never start a second fix round.
4. **Merge every SHIP** as the skill says, oldest first, re-checking mergeability after each.
   An MR on the closed hold list is not merged: its verdict is `needs_merge`.
5. **Do not post MR comments, add labels, or send any message anywhere.** The launcher posts the
   one comment and the author's DM from your result file. Put the comment you want the author
   to read in the `comment` field instead.
6. **Report what blocked a verdict; file friction as papercuts.** `problems` is for a broken
   part that kept an MR from getting an honest verdict: Codex could not run, the device pool or
   Mac was unreachable, a build environment could not build at all. Each line DMs the operator,
   so add one only when the factory needs repair. Friction you or a leg got around (a flaky
   tool, a port collision, a missing env var you exported, a test you had to shim) is a
   papercut, not a problem: file it with
   `papercuts add --file "$FUTO_MR_FACTORY_PAPERCUTS_FILE" "<what happened>" --tag <area>`
   (`docs/agents/papercuts.md`), and pass that `--file` to every leg you brief, because the
   worktrees and this checkout are thrown away. Either way the skill's own rules for what the
   problem does to a verdict still apply.
7. **Leave the user's own checkouts alone.** Work only in this checkout and the worktrees
   `/mr-qa` creates under it. Never touch `~/Developer/futo-notes` or any other worktree (the one exception is
   appending to `$FUTO_MR_FACTORY_PAPERCUTS_FILE` through `papercuts add`), and
   never drive a device you did not claim.

## The result file

Write it **early** (every MR absent, `problems` empty) and rewrite it after each verdict, so a
timebox kill still leaves an honest record. The path is in the task prompt and in
`$FUTO_MR_FACTORY_RESULT_FILE`.

```json
{
  "mrs": [
    { "iid": 412, "verdict": "merged", "comment": null },
    { "iid": 415, "verdict": "no_ship", "comment": "markdown for the author" },
    { "iid": 418, "verdict": "needs_merge", "comment": "markdown for the author" }
  ],
  "problems": ["Codex could not run: auth expired"],
  "summary": "one line: what landed and what did not"
}
```

- `merged`: you merged it. `comment` is `null`.
- `no_ship`: still failing after the one fix attempt, or not fixable. `comment` says what
  failed (quoting the spec line), on which platform, with evidence paths, what the fix attempt
  changed, and what would flip it — written for the MR's author.
- `needs_merge`: it passed but sits on the closed hold list. `comment` says it passed, what was
  covered, and which hold item applies.

An MR you could not reach a verdict on stays out of `mrs`; the launcher reports it and retries
it next hour.
