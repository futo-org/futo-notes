## Round seven: the same driver on a phone (2026-09-22)

`drive` could not run on iOS or Android at all, and not for want of verbs: `futo-puppet step` calls
`observe`, an in-page command, and the native listeners routed a fixed query list without it. The
iOS listener answers it now — composed natively from the state, the vault, this screen's verbs and
(with the editor up) the page's document and rows — alongside `notes` and `clipboard`. Two more
things were in the way: the page queries were forwarded from every screen, so a native list
answered about the note the one long-lived webview still held; and everything between the store and
the webview — the title field, the find bar, the ⋯ menu — is `@State` inside one SwiftUI view, so
`PuppetVerbs` gives a screen the native `registerPuppetVerbs`. Detail: `docs/research/agent-native-app-design.md`, "Verbs live with their controls".

The harness took the phone as a target (`reset.mjs` reading `FUTO_PUPPET_TARGET`, the vault from the
simulator container). The phone's store does not watch its vault — it reads it at launch — so a
phone reset writes the fixture and relaunches the app, and both platforms now settle on `notes`
rather than on rows a collapsed folder or a native list would hide.

| run (Jev alone)                   | passed    | calls | wall  | cost  |
| --------------------------------- | --------- | ----- | ----- | ----- |
| jev-ios-1 (first phone sweep, 20) | 15/20     | 96    | 132 s | $0.03 |
| jev-ios-v4 (after the fixes, 20)  | **17/20** | 96    | 128 s | $0.04 |
| jev-desktop-v3 (same build, 20)   | **19/20** | 80    | 96 s  | $0.05 |

`arrange-tabs` and `background-tabs` are marked `desktopOnly` in the harness: a phone's shell has no
tab strip, so those are not harder versions of the same job, they are jobs that do not exist there.
Off desktop the runner skips them by name and says so, and the phone's score is **17 of 18** against
the desktop's 19 of 20 — with the same single failure, `two-untitled`. That is parity.

Five things the phone found. Three are the controller's and true everywhere, which is the argument
for running the sweep on both surfaces: the same driver somewhere else is a second opinion about the
questions, not only about the app.

- **A rename was offered its own current name**, and a move its own current folder. The task names
  both ends in backticks and only the vault says which is which: Jev renamed `work` to `work` at
  0.71 against 0.29, and moved `work/q3 plan` into `work`. On desktop an `Undo` or a stray refusal
  bought a second chance; on a phone there is no editor open to undo into, so it stalled. `title`,
  `name` and `folderPath` now fan out per subject (`DEPENDS_ON`), and under that premise what is
  already true is not an option (later labelled as a no-op instead, in the second request). `rename-folder` went from a stall to one call.
- **Opening a note puts the caret at the start**, and the offsets on offer called the end of the
  last line "end of line 5". Jev pressed Enter twice and pasted the grocery list above the recipe.
  That offset now reads "the END of the document", and `PlaceCaret`'s rubric says appending starts
  there: `merge-lists` passes 3 for 3 where it had been 2 for 3.
- **A verb name never said which step it was.** With the move picker open Jev kept choosing
  `OpenMoveNotePicker` (0.8) over `PickFolder`, and `ChooseContextMenuItem` was offered TAB indexes,
  so it chose item 0 — Rename — for a task that said move. The open menu's items are the indexes
  now, and `computed.overlay` names the overlay that is up, the way `computed.caret` did for Enter.
- **`DeleteFolder` diverged.** Deleting a folder's last note deletes the folder, so by the last step
  of `tidy-work` it is already gone: desktop answers 200, iOS answered 400. Jev went looking for
  more work and renamed its own result back. iOS answers 200 with `alreadyGone` now.
- **Switching notes costs three calls on a phone**, because the iOS shell refuses to navigate out of
  an open editor (that exit commits a pending rename and unmirrored keystrokes) — so every switch is
  `OpenNote` refused, `GoBack`, `OpenNote`. That is the app's real behaviour, and the refusal now
  names `SetTitle` for the one case that does not need it: renaming the note you are looking at,
  which went from 4 turns and 13 s to 2 turns and 1.1 s.

Android is untouched: no `observe`, no `notes`, so `drive` does not run there yet.
