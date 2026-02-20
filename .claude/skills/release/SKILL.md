---
name: release
description: Full release workflow: run tests, create MR, generate changelog with Zulip mentions, monitor pipeline, and post release announcement. Use when the user says "release", "ship it", "merge and release", or is ready to merge changes to main.
argument-hint: [version-tag, e.g. v0.0.8]
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, AskUserQuestion
---

# Release Workflow

Full release cycle: test → commit → MR → changelog → pipeline → Zulip announcement.

## Prerequisites

One-time setup:

1. **Zulip release bot** at https://zulip.futo.org/#settings/your-bots
   - Type: **Generic bot**
   - Store credentials in `~/.zshrc`:
     ```
     export ZULIP_RELEASE_BOT_EMAIL="<bot-email>"
     export ZULIP_RELEASE_BOT_KEY="<bot-api-key>"
     ```

2. **Tools**: `glab` (GitLab CLI, authenticated), `wl-copy` (Wayland clipboard)

---

## Step 1: Run All Tests

```bash
npm test
```

**If ANY test fails, STOP.** Report failures to the user. Do not proceed.

## Step 2: Commit Changes

1. Run `git status` and `git diff --stat` to understand the changes.
2. Analyze the diff and draft a concise commit message.
3. Present the proposed commit message to the user via **AskUserQuestion** for confirmation or editing.
4. After approval:
   ```bash
   git add <relevant files>
   git commit -m "<approved message>"
   git push origin <current-branch>
   ```

## Step 3: Create Merge Request

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

Fetch recent messages from `notes-app` to cross-reference with changes:

```bash
source ~/.zshrc && curl -sSX GET -G "https://zulip.futo.org/api/v1/messages" \
    -u "justin@futo.org:$ZULIP_API_KEY" \
    --data-urlencode 'anchor=newest' \
    --data-urlencode 'num_before=200' \
    --data-urlencode 'num_after=0' \
    --data-urlencode 'narrow=[{"operator": "channel", "operand": "notes-app"}]'
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

Present both versions to the user for review/editing before proceeding.

## Step 5: Copy Changelog to Clipboard

Copy the **Zulip version** (with `@_**Name**` mentions):

```bash
printf '%s' "$ZULIP_CHANGELOG" | wl-copy
```

Confirm to the user that the Zulip changelog is on their clipboard.

## Step 6: Add Changelog to GitLab MR

Update the MR description with the **GitLab version** (plain names):

```bash
glab mr update <MR_NUMBER> --description "$GITLAB_CHANGELOG"
```

## Step 7: Merge, Tag, and Monitor Pipeline

### 7a. Merge the MR

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
- Confirm with the user via AskUserQuestion.

```bash
git tag <version>
git push origin <version>
```

### 7c. Monitor the pipeline

The tag push triggers CI: build-android → build-ios → upload-apk → create-release.

Poll pipeline status until it finishes:

```bash
glab ci status
```

**GATE: Do NOT proceed to Step 8 until the pipeline status is `success`.**

- If the pipeline is still running, wait 30s and check again.
- If any job fails, report details (`glab ci view`) and **STOP**. Ask the user how to proceed. Do NOT post to Zulip.
- Only continue to Step 8 after confirming pipeline passed.

## Step 8: Post to Zulip

**Pre-flight check**: Confirm with the user via AskUserQuestion that they're ready to announce. Show them the Zulip changelog one more time.

Post the **Zulip version** of the changelog to `#notes-app`:

```bash
source ~/.zshrc && curl -sSX POST "https://zulip.futo.org/api/v1/messages" \
    -u "$ZULIP_RELEASE_BOT_EMAIL:$ZULIP_RELEASE_BOT_KEY" \
    --data-urlencode 'type=channel' \
    --data-urlencode 'to=notes-app' \
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
| 7c | Pipeline fails | Show job logs. Ask user how to proceed. |
| 8 | Zulip post fails | Changelog is on clipboard — suggest manual post. |
