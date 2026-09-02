# Issue tracker: GitLab

Issues and PRDs for this repo live as GitLab issues on `gitlab.futo.org/futo-notes/futo-notes`. Use the [`glab`](https://gitlab.com/gitlab-org/cli) CLI for all operations.

This file is also the repo-side adapter for the third-party skills that talk about "the issue tracker" (see CONTRIBUTING.md → "Third-party skills"); the conventions below stand on their own whether or not those skills are installed.

## Conventions

- **Create an issue**: `glab issue create --title "..." --description "..."`. Use a heredoc for multi-line descriptions. Pass `--description -` to open an editor.
- **Read an issue**: `glab issue view <number> --comments`. Use `-F json` for machine-readable output.
- **List issues**: `glab issue list -F json` with appropriate `--label` filters.
- **Comment on an issue**: `glab issue note <number> --message "..."`. GitLab calls comments "notes".
- **Apply / remove labels**: `glab issue update <number> --label "..."` / `--unlabel "..."`. Multiple labels can be comma-separated or by repeating the flag.
- **Close**: `glab issue close <number>`. `glab issue close` does not accept a closing comment, so post the explanation first with `glab issue note <number> --message "..."`, then close.
- **Merge requests**: GitLab calls PRs "merge requests". Use `glab mr create`, `glab mr view`, `glab mr note`, etc. — the same shape as `gh pr ...` with `mr` in place of `pr` and `note`/`--message` in place of `comment`/`--body`.

Infer the repo from `git remote -v` — `glab` does this automatically when run inside a clone.

## `glab` gotchas that cost real time

Each of these produced an error message that named nothing useful, and each was
reported more than once.

- **Run it from inside the checkout, or set the host.** `glab api` fills the
  endpoint's repo placeholders from *the repository of the current directory*, so
  run outside one it silently targets `gitlab.com` and returns `401`. That reads
  as "my token is broken" when the real problem is the host. Fix by running from
  the worktree, or being explicit:

  ```bash
  GITLAB_HOST=gitlab.futo.org glab api "projects/futo-notes%2Ffuto-notes"
  ```

  `--hostname gitlab.futo.org` does the same per-invocation. A bare `glab mr view`
  that "cannot recognize the repository" is the same root cause.

- **File uploads need `--form`, not `-F`.** `-F`/`--field` sends JSON, so
  `-F file=@path` uploads the literal *string* `"@path"` and the API answers
  `400 {"error":"file is invalid"}` — never mentioning the flag. `--form` sends
  `multipart/form-data`, which is what an upload endpoint requires:

  ```bash
  glab api --form file=@screenshot.png "projects/488/uploads"
  ```

  Do not mix `--form` with `--field`, `--raw-field`, or `--input`.

- **Output format is `-F json`, not `--json`.** `glab mr view --json iid,title`
  is rejected by the installed CLI. Use `glab mr view <n> -F json` (and
  `glab issue list -F json`). Note the overload: on `glab api`, `-F` means
  *field*; on `issue`/`mr` subcommands it means *output format*.

## Merge requests as a triage surface

**MRs as a request surface: no.** _(Set to `yes` if this repo treats external merge requests as feature requests; `/triage` reads this flag.)_

When set to `yes`, MRs run through the same labels and states as issues, using the `glab mr` equivalents:

- **Read an MR**: `glab mr view <number> --comments` and `glab mr diff <number>` for the diff.
- **List external MRs for triage**: `glab mr list -F json`, then keep only MRs whose author is not a project member/owner (a contributor's MR, not a maintainer's in-flight work).
- **Comment / label / close**: `glab mr note`, `glab mr update --label`/`--unlabel`, `glab mr close`.

Unlike GitHub, GitLab numbers issues and MRs separately, so `#42` is unambiguous once you know which surface the maintainer means.

## When a skill says "publish to the issue tracker"

Create a GitLab issue.

## When a skill says "fetch the relevant ticket"

Run `glab issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`, one of the optional third-party skills — it only loads once `just skills-link` has linked it, so treat this section as inert unless it did. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `glab issue create --label wayfinder:map`. (On GitLab tiers with native epics, an epic may hold the map instead; a labelled issue works everywhere.)
- **Child ticket**: an issue carrying `Part of #<map>` at the top of its description and labels `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitLab's **native blocking link** — the canonical, UI-visible representation. Add it with the `/blocked_by #<n>` quick action, posted as a note (`glab issue note <child> --message "/blocked_by #<blocker>"`). Native blocking links are a Premium/Ultimate feature; on the free tier (or where unavailable) fall back to a `Blocked by: #<n>, #<n>` line at the top of the description. A ticket is unblocked when every blocker is closed.
- **Frontier query**: `glab issue list -F json` scoped to the map's children, drop any with an open blocker — a native `blocked_by` link to an open issue (`glab api projects/:id/issues/:iid/links`), or an open issue in the `Blocked by` line — or an assignee; first in map order wins.
- **Claim**: `glab issue update <n> --assignee @me` — the session's first write.
- **Resolve**: `glab issue note <n> --message "<answer>"`, then `glab issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.

## Assigning a work item to a person (`/justin`, `/mason`)

The `/justin` and `/mason` skills are shortcuts for "turn this into a work item and put it on
someone's plate". They differ only in who the assignee is; the procedure below is the whole of it.

**People.** GitLab username is what `--assignee` takes; the Zulip id is for the notify step.

| Person           | GitLab username | Zulip user_id |
| ---------------- | --------------- | ------------- |
| Justin Fowler    | `justin`        | `1557`        |
| Mason Abbruzzese | `mason`         | `3633`        |

**1. Check for an existing work item first.** Two or three keyword searches, not one — this CLI has
no `--state` flag, and `--all` is what covers closed items too:

```bash
glab issue list --all --search "<keyword>"
```

A live match means assign that one (`glab issue update <n> --assignee <username>`) and say so, rather
than minting a near-duplicate. A _closed_ match is often the groundwork rather than the feature —
read it before deciding.

**2. If the ask came from the public GitHub mirror, read it.** Feature requests arrive at
`futo-org/futo-notes` on GitHub, and the reporter's own follow-up comments usually carry the real
requirement:

```bash
gh issue view <n> --repo futo-org/futo-notes --json number,title,state,body,author,comments
```

Bodies are often empty and the title is the entire request — `--comments` on the plain view prints
comments _without_ the body, so ask for the JSON fields.

**3. Write the description.** Whatever the requester dictated goes in verbatim, first, above a
`---`. Below it, a short **Context** block earns its place when you can name: the upstream link, the
current behavior with the file or `docs/spec/<area>.md:<line>` that sets it, and any constraint the
implementer must not trip over (ADR-0001's engine-owned list order, M2's filename-is-the-title, a
field that does not exist yet). Flag an open design question; do not answer it for them.

**4. Create and assign in one call**, then verify the assignee actually landed:

```bash
glab issue create --title "..." --description "..." --assignee <username> --yes
glab api "projects/futo-notes%2Ffuto-notes/issues/<iid>"   # confirm assignees[]
```

`glab` prints a `/-/work_items/<iid>` URL; that `<iid>` is the same number the issue API takes.

**5. Do not add labels unless asked.** `ready-for-agent` is a claim surface — `/ticket-wave` grabs
those tickets and implements them — so putting it on an item you just assigned to a human sets up a
collision.

**6. Notify on Zulip with the bare URL.** Skip this when the assignee is the person running the
session; a self-DM is noise.

```bash
source ~/.zshrc >/dev/null 2>&1
curl -sSX POST "https://zulip.futo.org/api/v1/messages" \
  -u "justin@futo.org:$ZULIP_API_KEY" \
  --data-urlencode 'type=direct' \
  --data-urlencode 'to=[<zulip user_id>]' \
  --data-urlencode 'content=https://gitlab.futo.org/futo-notes/futo-notes/-/work_items/<iid>'
```

Bare means bare: the URL alone unfurls in Zulip with the title, so a covering sentence is
redundant unless the requester asked for one.
