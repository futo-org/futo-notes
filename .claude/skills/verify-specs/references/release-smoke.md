# Release smoke — deep on the diff, shallow on everything else

`/verify-specs release smoke` (or "smoke test before the release", "pre-release
QA") is the pre-tag pass. It is a **scoped run plus a baseline**:

1. **Deep legs**: the scoped run from `references/scoping.md` against
   `git diff "$LAST_TAG"..HEAD`. These legs sweep their surfaces in full, and each
   gets a `changes` brief so it exercises what changed first.
2. **Smoke legs**: one leg per platform that runs the fixed checklist below,
   covering only the surfaces the deep legs *don't* cover on that platform.
3. **Mesh smoke**: if the scope already includes the sync mesh, the full mesh
   leg covers it. If not, add a mesh leg with `focus` = the **Mesh** row below. A
   release always gets at least one cross-client round-trip.

## The `changes` brief

Build it from `git log --no-merges --format='%h %s' "$LAST_TAG"..HEAD` and
`docs/release/` notes for the upcoming version, if they exist. Give each deep
leg only the entries that map to its surfaces, one line per behavior change in
plain words ("Enter on an empty checklist item now exits the list"), not the
commit subject. Skip refactors, CI, and test-only commits. A deep leg with no
entries gets no `changes` field.

## Topology

- Deep legs: use the scoping.md worktrees and devices.
- Smoke legs: put them in **their own worktree** (`extra-S`) with their own
  iOS, Android, and desktop claims. They run concurrently with the deep legs,
  and each platform still gets one leg per claimed device. On a small machine,
  run them as a second wave after the deep legs free their devices.
- Smoke leg manifest entry: `"id": "S-<platform>"`, `"idPrefix": "sm"`,
  `"surfaces"` = every surface whose checklist rows survive the filter,
  `"focus"` = those rows pasted verbatim.
- If the diff touches nothing, there are no deep legs. The run is then smoke
  legs plus mesh smoke, which is the cheapest useful pre-release pass.

## Checklist

Drop a row for a platform when that platform's deep legs already cover its
surface. Rows tagged for one platform run only there. Every row needs an
assertion (disk read, log line, DOM/bridge eval) as evidence, same as any leg.

| Surface | Row |
|---|---|
| app | Cold launch to an interactive note list with an existing vault; no crash or error dialog; the vault's notes are all listed. |
| app | Kill the app mid-edit (after the debounce), relaunch: the edit is on disk and shown. |
| editor | New note → type a heading, a paragraph, a checklist item, and a bold word → the file on disk is the expected Markdown. |
| editor | Reopen that note: it renders WYSIWYG (heading styled, checkbox toggleable) and toggling the checkbox writes `[x]` to disk. |
| list | The new note appears at the top of the list; rename it and the file renames on disk; delete it and it leaves the list and the vault. |
| list | Create a folder, move a note into it, and browse into it. |
| nav | Open note → back to list → open another note; no stale content. *(desktop)* The app menu and window chrome behave per nav.md. |
| tabs | *(desktop)* Open two notes in tabs, switch with the keyboard shortcut, close one; the right note stays. |
| search | Search a word that's unique to one note: that note is found, and opening the result shows it. |
| settings | Change one setting (theme or font size), relaunch: it persisted. |
| settings-visual | Light and dark theme screenshots of the list and an open note look right: no unthemed surfaces, legible text. |
| license | The license screen/state shows the expected state for this build (licensed or unlicensed copy per license.md). |
| localization | Switch UI language to one non-English catalog: the list and settings chrome are translated; switch back. |
| sync | *(Mesh)* Connect desktop, iOS, and Android to the qa-server. Create a uniquely named note on each client. All three notes land on disk on every client. Then edit one note and check the edit propagates. |

Keep this list short. A row earns its place by catching "the release is broken
for everyone" (a crash, data loss, a dead core flow), not an edge case. Edge
cases belong to the deep legs.

## Report

Same as Step 5, but split the summary into **Changed since `<tag>`** (deep legs)
and **Baseline smoke** (smoke + mesh legs), and end with a one-line release
verdict: **GO** (no confirmed FAILs, no legs needing resume) or **NO GO** with
the blocking FAILs listed.
