# Editor snappiness campaign — 2026-10-08

Six interactions, one question each: what does the user wait on, and is it on the
frame they are looking at? Six lanes ran in parallel worktrees off
`editor-hillclimb-faster` at `13021342d`, each with its own before/after. This file
is the index; each lane's method, tables and caveats live in its own doc.

**Every device number here is from an x86 Android emulator or the desktop dev build.
The reference phone (moto g play 2023) was not attached, and the Mac was offline for
most of the window.** Deltas are meaningful; absolute figures are not phone figures.

| Interaction | Change | Before → after (median) | Doc |
|---|---|---|---|
| Closing a note (Android Back) | navigate first, commit in the background; hold the pane height while the keyboard closes | navigation starts 9 → 1 ms (dirty 1k), 21 → 0 ms (dirty 10k); keyboard-up frame p90 34 → 16 ms; list first frame unchanged (~55 ms, Compose) | `mobile-close-baseline.md` |
| Closing a note (iOS) | none needed: Back already pops first (`finishLeave`); bench fixed (it had measured clean closes and a 21 s accessibility lookup) | baseline only: first list frame 50 ms clean / 83 ms dirty (the keyboard going down), pop animation ~520–550 ms (UIKit), commit chain after the pop 1–31 ms | `mobile-close-ios.md` |
| Switching tabs (desktop) | read the incoming note while the outgoing save runs, per-id fence; per-tab editor state measured and rejected | read on the critical path 1–5 → 0 ms; switch is save-bound (15–80 ms) | `tab-switch-dirty-and-parse.md` |
| Moving blocks / drag frames | one pointer move per animation frame; `--budget` gate; **bug fix:** reflow preview was lost after every `setContent` | Android real app unchanged within noise (gap-frame p95 17.7 → 17.0 ms); WebKitGTK after-run blocked by a locked session | `block-drag-baseline.md` |
| Opening a note | hold the streaming tail while a tap/focus is pending; first chunk sized to the viewport; read-ahead measured and rejected (read is 2–9 % of an open) | tap into a still-streaming real note 332 → 68 ms; keystroke while streaming 70 → 17 ms; first focus after a full load unchanged | `note-open-focus.md` |
| Typing | one interaction ledger; dev-only keystroke tripwire; #113 attribution tool | tripwire cost: none measurable; emulator keystroke is 81–96 % browser style/layout, JS ~0.5 ms | `keystroke-attribution.md` |

## What the campaign settled

- The slow part of a dirty Android close was the save on the critical path, not the
  save itself. After it, the list's own composition (45–55 ms) is the next hill.
- Per-tab editor state retention is a loss: swapping a retained state rebuilds the whole
  document's DOM (12–113 ms) where today's switch parses one chunk (2–5 ms).
- Read-ahead for note open is not worth building; the shell's tap-to-open effect (~30 ms)
  and the bridge push of a large body are the costs.
- On Chromium a keystroke's time is the renderer's style/layout scope, not editor JS.
  Whether that holds on the phone is the open question for #113.

## Not measured, and why

- The moto g play (not attached): every budget verdict and #113 itself.
- WebKitGTK block drag after coalescing: the desktop session was locked, so the bench
  window got no frames (papercut pc_c03328e0e70a). Commands are in the drag doc.
- Three `editor-embed` Playwright drag stories fail on this branch and on the base commit
  identically (`a mouse drag on the ⠿ handle reorders the block`, `previews ONE slot per
  gap`, `the slot closes over the dragged block's own boundaries`): pre-existing.
