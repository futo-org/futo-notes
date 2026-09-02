---
name: mason
description: Turn the thing under discussion into a GitLab work item assigned to Mason Abbruzzese, and DM him the link on Zulip. Use when the user says "/mason", "assign this to mason", "open an item for mason", "file this and send it to mason", or hands over a GitHub mirror issue for Mason to pick up.
allowed-tools: Bash, Read, Grep, Glob
---

# /mason — file a work item for Mason

Assignee: **`mason`** (Mason Abbruzzese) · Zulip user_id **`3633`**.

Follow `docs/agents/issue-tracker.md` → "Assigning a work item to a person" for the whole
procedure: duplicate search, reading the upstream GitHub issue, writing the description, creating
with `--assignee mason`, verifying the assignee landed, and DMing the bare work-item URL.

What this skill adds on top of that doc:

- Mason is not the one running the session, so the **Zulip DM always happens**. The URL alone,
  nothing else, unless the user asked for a covering note.
- The user's own words for the title and description are the spec. Use them verbatim; put your
  research below a `---` as **Context**, never in place of what they said.
- Say plainly in your reply if the request conflicts with something in the repo — a description
  that asks for behavior the current design forbids (a shell-side sort against ADR-0001, a
  no-migration vault switch where every switch migrates today) still gets filed as written, with
  the conflict named in the Context block and in what you tell the user.
