---
name: ci-doctor
description: Diagnose and fix GitLab CI/pipeline failures, and harden .gitlab-ci.yml against this repo's recurring failure classes. Use when the user says "pipeline failed", "CI is red", "the tag build failed", "publish:android/publish:ios failed", "check the pipeline", "why didn't the release go out", "harden CI", or before tagging a release ("pre-tag check"). Also load this BEFORE editing .gitlab-ci.yml for any reason — it encodes the hard rules that past pipeline breakage taught.
allowed-tools: Bash, Read, Edit, Grep, Glob, AskUserQuestion
---

# CI Doctor

`.gitlab-ci.yml` is the most-churned file in this repo — CI firefighting is the largest recurring
time cost. This skill turns the historical failure classes into a triage procedure so a red
pipeline costs minutes, not an afternoon of push-and-watch.

Project: `futo-notes/futo-notes` on `gitlab.futo.org`. `$GITLAB_TOKEN` is in the shell; `glab` is
also available and authenticated.

## Step 1 — Get the facts (never guess from the commit diff alone)

```bash
API="https://gitlab.futo.org/api/v4/projects/futo-notes%2Ffuto-notes"
H='--header PRIVATE-TOKEN:'"$GITLAB_TOKEN"

# Latest pipelines for a ref (branch or tag)
curl -s $H "$API/pipelines?ref=main&per_page=5" | jq '.[] | {id, status, ref, sha: .sha[0:8], web_url}'

# Jobs in a pipeline — find the failures
curl -s $H "$API/pipelines/<PIPELINE_ID>/jobs?per_page=100" \
  | jq '.[] | select(.status=="failed" or .status=="canceled") | {id, name, stage, status, allow_failure}'

# The job log (the tail is where the truth is)
curl -s $H "$API/jobs/<JOB_ID>/trace" | tail -80
```

`glab ci status` / `glab ci view` work for quick looks; use the raw API when you need job traces
or to script a watch loop.

Read the log tail FIRST, then the failing job's `script:` in `.gitlab-ci.yml`, then the diff of
the commit that broke it (`git log --oneline -5 -- .gitlab-ci.yml`).

## Step 2 — Classify against the known failure taxonomy

Match the symptom before inventing a novel diagnosis. These classes account for most historical
red pipelines here:

| Class | Symptom | Root cause pattern |
|---|---|---|
| **First-contact tag job** | A publish/release job fails on its first real run at tag time | Job only executes on tags, so it was never exercised: secrets not propagated (especially into nested VMs like Cirrus), cold caches hitting timeouts, wrong artifact lookup paths |
| **CWD/path assumption** | A step "succeeds" but its effect didn't happen; later step fails mysteriously | GitLab preserves `cd` across script lines; relative path resolved elsewhere; `-f`/`|| true` masked it |
| **Silent green** | "Job succeeded" but nothing was published/uploaded | An error branch special-cased to `exit 0` |
| **Missing release-gate wiring** | A test failed but the release published anyway | New test job absent from `release:gate.needs` |
| **Artifact-path drift** | `No files to upload` / downstream job can't find inputs | Workspace layout changed; `artifacts:paths`/lookup globs didn't |
| **Cache death spiral** | Retries keep timing out at the same wall | Caches upload only `on_success`, so every retry starts cold |
| **Flake** | Same job passes on retry with no change | Fixed timeout or exact-string assertion in a cross-platform test |
| **Environment skew** | Works locally, fails in CI image | Tool version differs (strip/binutils, glibc, NDK, Xcode) — check the job's `image:`/runner tag |

## Step 3 — Fix by the hard rules

Apply the rule for the class; do not just patch the symptom:

1. **Absolute paths only** in CI scripts — anchor on `$CI_PROJECT_DIR`. Never rely on a `cd`
   from an earlier line. After any destructive/cleanup line, verify the effect (`ls`, `test -f`)
   rather than trusting `-f`.
2. **No silent green.** Every error path exits non-zero. If a failure is genuinely acceptable,
   model it as `allow_failure: true` on the JOB (visible in the UI), never as `exit 0` in the
   script. Assert outcomes: artifact exists, upload count > 0, store accepted the bundle.
3. **Every new test job goes into `release:gate.needs`** in the same commit. The needs list must
   be complete — a failing job not listed there cannot stop a publish (this nearly shipped a
   broken release twice; the comment in the file says so).
4. **Secrets into nested environments are passed explicitly** (Cirrus VM, docker-in-docker).
   Never assume a CI variable propagates one level down.
5. **Caches upload `when: always`** so a timed-out job doesn't doom every retry to a cold start.
6. **Flakes get root-caused** — wait on conditions/events, not durations; don't assert exact
   user-facing strings. One commented timeout bump is the ceiling; a second bump on the same job
   means find the real cause.
7. Keep MR-blocking vs `allow_failure`/manual intent explicit in `rules:` — don't accidentally
   promote a manual job to blocking or vice versa.

## Step 4 — Verify without burning a tag

- **MR-scoped jobs**: push a branch/MR and watch that pipeline.
- **Tag-only jobs**: never verify by tagging. Options, in order of preference:
  1. Run the job's script locally with the same inputs (most publish scripts are
     `scripts/*.py|mjs|sh` — they run outside CI).
  2. Push a temp branch with a one-commit rule override making the job run on that branch
     (`rules: - if: $CI_COMMIT_BRANCH == "ci-dryrun-x"`); revert before merge.
  3. For the updater path specifically: `just updater-localdev` rehearses build→sign→serve→verify
     end-to-end with localdev keys.
- **After a failed tag**: fix on main first. Then ask the user before any retag/new tag
  (publishing is an ask-first action). Repo convention favors bumping the patch version over
  deleting tags; release creation is retag-safe but partially-published artifacts from the failed
  run must be accounted for.

Watch loop after pushing a fix (jobs run 10–60 min; poll accordingly):

```bash
watch_pipeline() {
  curl -s $H "$API/pipelines/$1" | jq -r '"\(.status)  \(.web_url)"'
  curl -s $H "$API/pipelines/$1/jobs?per_page=100" \
    | jq -r '.[] | "\(.status | .[0:7])\t\(.stage)\t\(.name)"' | sort
}
```

## Pre-tag checklist (run when asked for a "pre-tag check" or before /release tags)

- [ ] `just check` green locally
- [ ] Last main pipeline fully green (not "green with failed-but-allowed jobs you care about")
- [ ] `.gitlab-ci.yml` diff since the last tag reviewed against the rules above (`git diff
      $(git describe --tags --abbrev=0) -- .gitlab-ci.yml`)
- [ ] Any NEW tag-only job since the last tag has been exercised (Step 4)
- [ ] `release:gate.needs` still lists every test job (`grep -A30 'release:gate' .gitlab-ci.yml`)
- [ ] Updater artifacts: signing is the LAST touch on bytes (mesa patch / notarize / Authenticode
      all happen before `.sig`) — see `docs/release/updater.md`

## Report format

State: pipeline + failing job(s) with links · the class from the taxonomy · root cause (quote the
log line) · the fix and which hard rule it enforces · how it was verified (pipeline link or local
run output) · any follow-up risk (e.g. "publish:ios remains unexercised until next tag").
