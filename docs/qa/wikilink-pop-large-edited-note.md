# Wikilink pop of a large, edited note

## Why a person, not a test

Mobile uses separate native views over Rust editor sessions. A finger-tracked edge
swipe during early input checks the interaction between OS navigation and a pending
open/save. The native leave suites cover draft ownership and durable saving; this
story checks the gesture on a real app.

## Setup

Use a claimed debug device and synthetic notes only. Create `Parent.md` containing
`[[Child]]`, and a large `Child.md` with a known final line. Save copies of their exact
bytes before the run. `just test-ios-stories` runs the native automated leave, find,
selection and keyboard-edge suites; it does not run the old WebView story runner.

## The story

1. Open Parent and follow its Child link.
2. As soon as the first text appears, focus Child and type a unique marker.
3. Edge-swipe Back while the large note is still opening or saving.
4. Confirm Parent shows its own text. Wait for pending saves to settle.
5. Read both files and reopen Child.

Expected: Parent's exact bytes remain unchanged; Child contains the marker and its
known final line. Reopening shows the saved content. Repeat with an ordinary Back
tap and with a short Child, typing and leaving immediately.

The runs below exercised the retired WebView renderer. They do not establish native
Linedown acceptance; a new gesture run is still required.

## Last run

2026-09-28, branch `fix/editor-note-switch-integrity`, iOS 26.5 simulator (`futo-qa-0`,
iPhone 17 Pro), automated steps via `just test-ios-stories`:

- before the fix (`main` at 573675236): with a 40000-section linked note, "the linking
  note was overwritten (2377788 bytes, holds the linked body: true); the linked note lost
  the typed marker". With 150000 sections the popped view showed the linked note's body
  under the linking note's title for minutes, then `Parent.md` became the linked body plus
  the marker;
- after the fix: passed twice. `Parent.md` 33 bytes as seeded, `Child.md` with the
  marker and `## Section 39999`.

The finger-tracked edge swipe was not run by a person on this build.

## Current implementation run

2026-10-03, `step1-editor-ownership`, claimed iOS 27 iPhone 17 Pro simulator
`futo-qa-0`, bridge v9: passed the automated wikilink-pop story on the warm
simulator with `IOS_TEXT_INPUT=softwareKeyboard IOS_STORY_NO_RESTART=1`.
The 40,000-section child retained the marker and final section; the parent's
bytes remained exactly as seeded. Sustained typing also passed without extra
notes or lost characters.

The first HID-input run did not type. A separate unchanged-baseline probe
confirmed that AXe HID events had no effect while a software-keyboard touch saved
correctly. A cold-launch attempt also failed with simulator launch errors; the
warm run establishes the document result, not cold-launch reliability.

## Not proven by this run

- Finger-tracked edge swipe, renderer termination and OS process kill require
  separate evidence; the old three-read deadline is no longer shipped behavior.
