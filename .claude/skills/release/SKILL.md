---
name: release
description: Full release workflow: run tests, review, push or open an MR, generate changelog with Zulip mentions, monitor pipeline, and post release announcement. Use when the user says "release", "merge and release", or is ready to merge a large change or cut a release. A small change ("ship it") is pushed straight to main after `just check` and a fresh-agent review (AGENTS.md §5); the MR steps below apply only to a large change or one already in an MR.
argument-hint: [version-tag, e.g. v0.0.8]
allowed-tools: Bash, Read, Write, Edit, Grep, Glob
---

# Release Workflow

Full release cycle: test → review → commit → push or MR → changelog → pipeline → Zulip announcement.

## Prerequisites

One-time setup:

1. **Zulip release bot** at https://zulip.futo.org/#settings/your-bots
   - Type: **Generic bot**
   - Store credentials in `~/.zshrc`:
     ```
     export ZULIP_RELEASE_BOT_EMAIL="<bot-email>"
     export ZULIP_RELEASE_BOT_KEY="<bot-api-key>"
     ```

2. **Tools**: `glab` (GitLab CLI, authenticated), `wl-copy` (Wayland) or `pbcopy` (macOS) for the clipboard step

---

## Step 1: Run the Pre-Merge Checks

```bash
just check        # with the review below, the AGENTS.md §7.10 bar; use `just prepush` for a broad release
```

§7.10 also requires a review by a fresh agent that did not write the change (AGENTS.md §5), ideally a different model family: when Claude wrote it, run `codex exec` read-only on `git diff HEAD` and fix every HIGH. Record it in the commit as a `Reviewed:` line.

**If ANY test fails, STOP.** Report failures to the user. Do not proceed.

## Step 2: Commit Changes

1. Run `git status` and `git diff --stat` to understand the changes.
2. Analyze the diff and draft a concise commit message.
3. Show the proposed commit message and ask for approval or edits as numbered plain-text options.
4. After approval:
   ```bash
   git add <relevant files>
   git commit -m "<approved message>"
   git push origin <current-branch>
   ```

## Step 3: Push to main, or Create Merge Request

A small change (bug fix, tooling, small UI tweak) that is not being tagged, and passed Step 1 and its review, is pushed directly: `git fetch origin && git rebase origin/main && git push origin HEAD:main`. If the rebase moved the tree, re-run `just check` first. Stop there: no tag, so no changelog. A release (a tag) goes through an MR, because Step 4d puts the store notes on the tagged commit. Open an MR also when the change is large or already in one:

```bash
glab mr create --target-branch main --fill --push
```

Save the MR number and URL from the output. If the user wants a specific title or description, use `--title "..." --description "..."` instead of `--fill`.

## Step 4: Generate Changelog

### 4a. Gather ALL changes since the last tag

First, ensure you have the latest state:

```bash
git fetch origin --tags
```

Get the last tag:

```bash
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
```

If there is a last tag, gather ALL commits between it and the current HEAD (including anything merged into main from other branches):

```bash
git log ${LAST_TAG}..HEAD --oneline --no-merges
```

Also read the full diff to understand what actually changed (commit messages alone may be incomplete or vague):

```bash
git diff ${LAST_TAG}..HEAD --stat
git diff ${LAST_TAG}..HEAD
```

If there is no previous tag, use the last 30 commits as context:

```bash
git log -30 --oneline --no-merges
git diff HEAD~30..HEAD --stat
```

**IMPORTANT**: Base the changelog on the actual code diff, not just commit messages. Commit messages may be misleading, incomplete, or overly granular. Read the diff, understand the user-facing changes, and group related commits into meaningful changelog entries.

### 4b. Check Zulip for related feature requests

Fetch recent messages from `futo-notes` to cross-reference with changes:

```bash
source ~/.zshrc && curl -sSX GET -G "https://zulip.futo.org/api/v1/messages" \
    -u "justin@futo.org:$ZULIP_API_KEY" \
    --data-urlencode 'anchor=newest' \
    --data-urlencode 'num_before=200' \
    --data-urlencode 'num_after=0' \
    --data-urlencode 'narrow=[{"operator": "channel", "operand": "futo-notes"}]'
```

Parse messages. Identify any that requested features or reported bugs addressed by the commits. Note the sender's full name.

### 4c. Create two changelog versions

**Zulip version** — with silent mentions using `@_**Full Name**` format:
```
## FUTO Notes <version>

- Fixed crash when opening large files (reported by @_**Jane Smith**)
- Added swipe-to-delete on note list
- Improved search performance
```

**GitLab version** — plain names, no Zulip formatting:
```
## FUTO Notes <version>

- Fixed crash when opening large files (reported by Jane Smith)
- Added swipe-to-delete on note list
- Improved search performance
```

**Store version** — what App Store and Google Play users read. This is NOT the
same audience: cut anything that only means something to someone who has read
the diff, and lead with what a user would notice. The App Store body must
never name Android, Google Play or the Play Store — App Review rejected v1.9.0
for it (Guideline 2.3.10). Android-only items go only in `## Short`, which only
Play shows.

Present all three versions to the user for review/editing before proceeding.

### 4d. Commit the store release notes

The tag pipeline submits both app stores by itself, and `release-notes/<tag>.md`
is the only source of that copy — there is no console step left to fix it in.
The file must be on the TAGGED commit, so it goes in THIS MR; committing it
later means re-tagging.

Write `release-notes/v<version>.md` in the format `release-notes/README.md`
documents (body = App Store, ≤4000 chars; an optional `## Short` section =
Google Play, ≤500 chars), then verify and commit it:

```bash
just release-notes-check v<version>
git add release-notes/v<version>.md
git commit -m "docs(release): store release notes for v<version>"
```

`check:release-notes` fails the tag pipeline in its first minute if this is
missing, too long, or names Android in the App Store text, so do not skip it.

## Step 5: Copy Changelog to Clipboard

Copy the **Zulip version** (with `@_**Name**` mentions):

```bash
# Clipboard is platform-specific: wl-copy on Wayland, pbcopy on macOS.
printf '%s' "$ZULIP_CHANGELOG" | { command -v wl-copy >/dev/null && wl-copy || pbcopy; }
```

Confirm to the user that the Zulip changelog is on their clipboard.

## Step 6: Add Changelog to GitLab MR (MR only)

Update the MR description with the **GitLab version** (plain names):

```bash
glab mr update <MR_NUMBER> --description "$GITLAB_CHANGELOG"
```

## Step 7: Merge, Tag, and Monitor Pipeline

### 7a. Merge the MR (MR only)

Ask the user if they're ready to merge. If yes:

```bash
glab mr merge <MR_NUMBER>
```

### 7b. Tag the release

Determine the version tag:
- If `$ARGUMENTS` contains a version (e.g. `v0.0.8`), use that.
- Otherwise, check the latest tag and suggest a semver bump:
  ```bash
  git describe --tags --abbrev=0
  ```
- Show the proposed tag and ask for approval as numbered plain-text options.

Releases are **annotated** `vX.Y.Z` tags — never a lightweight tag:

```bash
git tag -a <version> -m "<version>"
git push origin <version>
```

### 7c. Monitor the pipeline

The tag push runs the build jobs (`publish:ios` uploads to TestFlight as soon as `build:ios-native` is done), then `release:gate`, then `publish:android`, `publish:ios:appstore`, and `release`, then `publish:website-post` (allow-failure: posts the changelog to notes.futo.tech unless the website already has one; see `release-notes/README.md`).

Watch it with `just ci-wait`, run with the Bash tool's `run_in_background`. Do not write
your own polling loop: hand-written watchers have repeatedly missed failed jobs.

```bash
just ci-wait ref:v<version>
```

It exits 1 as soon as any blocking job fails, even while the rest of the pipeline is still
running, and prints that job's log tail. It exits 0 only when the pipeline succeeds. It retries
API errors itself.

**GATE: Do NOT proceed to Step 8 until `just ci-wait` exits 0.**

- On exit 1, report the failed jobs and **STOP**. Ask the user how to proceed. Do NOT post to Zulip.
- Only continue to Step 8 after confirming pipeline passed.

The two store-submission jobs are the slow tail, and both are safe to retry:

- `publish:android` uploads the AAB and **releases it to the Play production
  track**. Play can still reject an update after it commits (v1.8.0 was
  rejected 28 minutes later), so check Play Console's Publishing overview
  before calling Android shipped. A 403 `PERMISSION_DENIED` at "Committing"
  means the service account lacks "Release to production" in Play Console.
- `publish:ios:appstore` waits for Apple to finish processing the TestFlight
  build (5-30 minutes is normal, 60m timeout) and then submits for review.
  A timeout here is NOT a failed release — the binary is already in TestFlight.
  Retry the job once App Store Connect shows the build as processed; no rebuild
  is needed. Apple's review itself then takes a day or two, and the version goes
  live by itself on approval (`releaseType: AFTER_APPROVAL`).

## Step 8: Post to Zulip

**Pre-flight check**: Ask the user, as numbered plain-text options, whether they're ready to announce. Show them the Zulip changelog one more time.

Post the **Zulip version** of the changelog to `#futo-notes`:

```bash
source ~/.zshrc && curl -sSX POST "https://zulip.futo.org/api/v1/messages" \
    -u "$ZULIP_RELEASE_BOT_EMAIL:$ZULIP_RELEASE_BOT_KEY" \
    --data-urlencode 'type=channel' \
    --data-urlencode 'to=futo-notes' \
    --data-urlencode 'topic=Releases' \
    --data-urlencode "content=$ZULIP_CHANGELOG"
```

Report success. If it fails, remind the user the changelog is still on their clipboard from Step 5.

---

## Error Handling

| Step | On Failure | Action |
|------|-----------|--------|
| 1 | Tests fail | **STOP**. Report failures. Do not continue. |
| 3 | MR creation fails | Check `glab auth status`. Report error. |
| 4d | `just release-notes-check` fails | Fix `release-notes/v<version>.md` before merging — after the tag it costs a re-tag. |
| 7c | Pipeline fails | Show job logs. Ask user how to proceed. |
| 7c | `publish:ios:appstore` times out | Not a failed release. Retry the job once the build finishes processing. |
| 8 | Zulip post fails | Changelog is on clipboard — suggest manual post. |
