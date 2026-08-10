# Defect evidence — recording, attaching, retracting

The rule lives in SKILL.md ("Evidence for every defect you report"): film the
MR branch and `main` side by side, same script, same clean start. This file is
the mechanics.

**Obtain every frame through a sanctioned driver.** Playwright, the Tauri MCP
bridge (`driver_session` / `webview_execute_js`, always with an explicit
`appIdentifier`), `simctl`, `adb`. Never `osascript`/System Events keystrokes
and never `cliclick`: the process-name lookup they need cannot distinguish a QA
build from the user's installed app, and it has already put keystrokes into a
real vault. A clip recorded that way is not evidence, it is a second incident.

## By surface

- **Desktop / web** — Playwright records natively. Write the scratch spec under
  the session scratchpad, copy it into the worktree's `tests/`, run it, delete
  it (never commit a QA repro):
  `test.use({ video: { mode: 'on', size: { width: 900, height: 620 } } })`.
  Reach the editor with `page.goto('/#/note/new')` and read state through
  `window.__notesShellTest.getState()`. Prefer real `page.keyboard` input to
  `view.dispatch(...)` — a dispatch bypasses the input plumbing a user
  exercises and silently builds a different undo history.
- **Android** — `adb shell screenrecord /sdcard/repro.mp4` (Ctrl-C or
  `--time-limit`), then `adb pull`. M21: an unfocused emulator throttles
  Compose frames, so bring its window to the front or the clip shows stale UI.
- **iOS simulator** — `xcrun simctl io <udid> recordVideo repro.mp4`.
- **Anything the WebView can't see** (native GTK dialogs, real drag-and-drop,
  OS chrome) — a full-desktop recorder, after checking the display isn't
  locked. Recording the screen is fine; *driving* it from the OS is not.
- **No recorder available** — an ordered burst of screenshots, `ffmpeg`'d into a
  clip. Say in the comment that it is a reconstruction. Frame extraction from a
  capture is also how a blank-frame regression was proven.

`libx264` is often absent on these boxes — `-c:v libopenh264` works, and GitLab
renders an `.mp4` inline.

## Captioning

The clip must stand alone: which branch each pane is, the step being performed,
and the observed state at each step. Overlay a fixed banner in the page rather
than relying on the reader to infer it.

## Attaching

Upload to the project, then embed the returned markdown in the note body:

```bash
curl -s --header "PRIVATE-TOKEN: $GITLAB_TOKEN" --form "file=@repro.mp4" \
  "https://gitlab.futo.org/api/v4/projects/futo-notes%2Ffuto-notes/uploads" | jq -r .markdown
```

Brief `app-qa` legs to do this themselves — the leg that found the bug is
holding the running app, so filming is far cheaper there than rebuilding the
state in the orchestrator later.

## Retracting

**If you retract a finding, retract it loudly.** Post the correction as a new
comment with the evidence that overturned it, and edit the original note to
open with a retraction banner pointing at it. A wrong NO SHIP left standing
costs the author more than the bug would have. A retracted story is also never
eligible for carry-over into a later pass.
