# Leaving a note on iOS

What the user waits on between tapping Back and seeing the note list again,
in the native iOS app. Written 2026-10-08 as lane L2 of the editor
performance campaign. Android's counterpart is a separate lane.

## The premise that turned out false

The campaign brief assumed iOS Back waited on the commit: drain the editor
bridge, write the body to disk, apply the rename, and only then pop, the way
Android's `NoteEditorScreen.navigateAfterSaving` does. iOS does not.

- **Back is the system button.** `NoteEditorView` keeps UIKit's own back
  button on purpose, because hiding it also disables the finger-tracked edge
  swipe (docs/learnings/ios-swipe-back-over-webview.md). Back and the edge
  swipe both pop the editor before any app code runs.
- **The commit runs after the pop.** The popped editor's `onDisappear` calls
  `finishLeave`, which is synchronous up to a detached task. That task waits
  for the editor's mailbox, writes or parks the body under the claimed draft
  token, commits the title, and only then releases the token. A failed write
  stays retained for the lifecycle retry.
- **`requestNavigation` is the wikilink push only.** Its one caller is
  `openLinkedNote`. There, waiting before navigating is right: the push can
  still be refused, and the editor stays put with its draft.

So there was no Back-path change to make. This lane added instruments and
locks instead.

## Locks

`apps/ios/Tests/Editor/EditorBackAffordanceTests.swift`, source scans of
`NoteEditorView.swift`:

- The system back button is never hidden.
- `onDisappear` hands a pop to `finishLeave`, which ends the session with
  `.navigate`.
- `finishLeave` is not `async` and contains no `await` before its detached
  task, so the pop can never be gated on a bridge round trip or a disk write.
- `requestNavigation` has exactly one caller, the wikilink push. A custom Back
  routed through it fails the suite.

## How to measure

On the Mac, with this worktree's claimed simulator:

```
SIM=<udid> node scripts/perf/ios-close-bench.mjs --sizes 1000,10000 --repeat 7
```

It builds the Rust core (release-ffi), the editor bundle and the Xcode
project, then runs one XCUITest, `EditorClosePerfTests`. For every sample the
test seeds a fresh vault under `apps/ios/.build/close-bench` with one note of
N one-line blocks separated by blank lines, launches the Debug app against it
through `FUTO_NOTES_DATA_DIR`, opens the note, lets it settle, optionally
types one character, and taps Back. Samples are
interleaved: every size and edit state gets its n-th sample before any gets
its (n+1)-th. The app is relaunched for every sample.

Every number is read from the app's Debug-only `CloseLedger`, which logs each
phase to os_log on the wall clock. Release builds compile every mark to
nothing.

| Mark | Meaning |
|---|---|
| `touchUp` | the finger lifted off Back; the origin of every number |
| `popObserved` | the navigation path shrank |
| `listFrame` | the first display-link tick after that, a drawn frame |
| `editorDisappeared` | the popped editor's `onDisappear`, the pop animation done |
| `bodyCurrent` | its mailbox answered |
| `bodyClean` / `bodyCommitted` | nothing to write / the Rust flush returned |
| `titleCommitted` | the title commit returned |
| `exitSettled` | `finishLeave`'s chain finished |

Four harness traps shaped this, each found by a failed run:

- **XCUITest cannot time a tap.** Every query snapshots the accessibility
  tree, and an open note's web view makes that slow. Resolving the Back
  button at tap time took 21 s on a 1k-block note, so the first run's
  numbers were all about 22 s. The test reads the button's frame once, as
  soon as the nav bar shows it, and taps that coordinate. Even then XCUITest
  spends 1 to 3 s inside the tap call before it synthesizes the touch, so the
  test's clock only brackets the tap and the app's `touchUp` mark is the
  origin.
- **Querying into the page stalls the app.** Waiting for the note's first
  block made WebKit build the accessibility tree of the whole 10k-block
  document, and the app's main run loop stopped answering:
  `XCTPerformOnMainRunLoop work timed out after 60.0s`. The test now makes
  no query inside the web view. The open settles on a fixed wait of
  2 s + 1 s per 1,000 blocks, the edit is a coordinate tap on the keyboard's
  "x" key, and nothing is queried between the tap and four seconds later.
- **The touch marks are bench-only.** They come from a window gesture
  recognizer that never recognizes and never cancels or delays a touch. A
  custom recognizer once broke the edge swipe, so it installs only when the
  bench's UI test sets `FUTO_CLOSE_PERF=1`.
- **A "dirty" sample was clean.** XCUITest idles for about 1.7 s after
  typing, and the editor's body save debounces at 400 ms, so the edit was on
  disk before Back. Under `FUTO_CLOSE_PERF=1` the save debounce is held, so the
  Back commit is the one that writes. The bench fails any dirty sample that
  did not log `bodyCommitted`, which also proves that sample's note had
  loaded. `CloseLedgerTests` checks the debounce is the shipped 400 ms
  without the variable.

## Results

Simulator futo-qa-6 (iPhone 17 Pro, iOS 26.5) on the maintainer's MacBook
Pro, Debug build of `hc-close-ios` with the release-ffi Rust core,
2026-10-08. Seven interleaved samples per cell, 28 in all. Every dirty
sample logged `bodyCommitted`, and every anchoring `touchUp` landed on the
Back button at (38, 84). Raw samples: `apps/ios/.build/close-bench/close-bench-full2.json`
on the Mac, not committed.

Milliseconds from the finger lifting off Back, median / p90:

| Note | Edit | Pop seen | First list frame | Pop animation done | Body done | Exit settled | Commit after pop |
|---|---|---|---|---|---|---|---|
| 1k blocks | clean | 27 / 28 | 50 / 50 | 518 / 518 | 530 / 531 | 530 / 531 | 12 / 13 |
| 1k blocks | dirty | 37 / 38 | 83 / 83 | 554 / 556 | 575 / 578 | 586 / 594 | 31 / 40 |
| 10k blocks | clean | 28 / 33 | 50 / 66 | 515 / 532 | 516 / 533 | 516 / 533 | 1 / 9 |
| 10k blocks | dirty | 38 / 40 | 83 / 84 | 547 / 548 | 558 / 559 | 559 / 560 | 12 / 13 |

What this says:

- **The list starts drawing 50 ms after the tap, 83 ms when dirty.** Those
  are three and five frames at the simulator's 60 Hz. The two extra frames
  in the dirty rows come from the keyboard, which is up only in the dirty
  samples and goes down with the pop. Note size does not move it.
- **The rest of the wait is UIKit's pop animation.** It ends about 515 to
  555 ms after the tap, the same for 1k and 10k blocks. Nothing in the app
  can shorten it short of changing the system transition.
- **The commit never sits in front of the pop.** Every body write, title
  commit and draft release starts after the animation ends, and takes 1 to
  40 ms. A Back routed through the waiting exit, as Android's Back is,
  would put that chain in front of the first list frame.
- **Note size barely shows in the commit.** The Rust write itself took
  about 8 ms for both sizes (`bodyCurrent` to `bodyCommitted`). The 1k rows'
  longer chain is the wait for the editor's mailbox to answer, about 13 to
  15 ms against 1 to 3 ms for 10k. I did not dig into why.

**Verdict: nothing on the iOS close path is worth touching for speed.** The
user waits on UIKit's pop animation and, when dirty, the keyboard. The app's
own work is the 27 to 38 ms before the pop is seen, and the save runs
after the list is fully on screen.

There is no before/after pair, because there was no Back-path change to
make. These numbers are the baseline a future change to the close path
should be compared against.

## Caveats

- **Simulator, not a phone.** Physical-device signing needs the maintainer's
  own session, so nothing here ran on an iPhone. A phone has a 120 Hz
  display and a slower disk, so the frame counts and commit times will
  differ.
- **Debug build.** The Swift side is unoptimized. The Rust core is the
  shipped release-ffi profile.
- **The edit is one character.** The commit still writes the whole body,
  which is why the 10k rows exist.
- **Separate finding, not fixed here.** An accessibility query into a
  10k-block note stalled the app's main run loop for over 60 s. That is the
  path VoiceOver takes. It is out of this lane's scope and was not
  investigated further.
