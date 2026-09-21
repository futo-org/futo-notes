---
name: justin
description: Turn the thing under discussion into a GitLab work item assigned to Justin Fowler. Use when the user says "/justin", "assign this to me" (when the user is Justin), "assign this to justin", "open an item for justin", or wants a request captured on Justin's plate rather than acted on now.
allowed-tools: Bash, Read, Grep, Glob
---

# /justin — file a work item for Justin

Assignee: **`justin`** (Justin Fowler) · Zulip user_id **`1557`**.

Follow `docs/agents/issue-tracker.md` → "Assigning a work item to a person" for the whole
procedure: duplicate search, reading the upstream GitHub issue, writing the description, creating
with `--assignee justin`, and verifying the assignee landed.

What this skill adds on top of that doc:

- **Skip the Zulip DM when Justin is the one running the session** — check the git user
  (`git config user.email`) rather than assuming. A self-DM is noise. If someone else is driving,
  DM the bare URL to `1557`.
- Filing is not doing. `/justin` captures a request for later; it is not permission to start
  implementing it. If the work should happen now instead, say so in one line and let the user pick.
- The user's own words for the title and description are the spec. Use them verbatim; put your
  research below a `---` as **Context**.
