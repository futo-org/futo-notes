# Wikilink pop of a large, edited note

## Why a person, not a test

Both native shells now route posted document changes by note id and generation. A
switch flushes the outgoing edit before loading the incoming note. UIKit's
adopt-before-exit order is the part nothing below the navigation stack reproduces:
the parent reattaches the shared WebView before the child's exit finishes.

The bundle ownership tests (`tests/editor-embed-ownership.spec.ts`) pin outgoing
identity and flush ordering. Both native mailbox test suites pin routing, bounded
waits and renderer death. This story verifies their composition with native Back.

This story is the whole chain on a device.

## Setup

Synthetic notes only. The story seeds a linking note (`Parent.md`, one line and a
`[[Child]]` link) and a linked note (`Child.md`, 20000 sections) large enough that its
tail is still streaming a few seconds after it opens. Its steps 1–5 are automated as the
"wikilink pop" check in `tests/ios-editor-stories.mjs`:

```sh
eval "$(just qa-claim ios)"           # claim before anything
just test-ios-stories                 # builds + installs the debug app, then runs the stories
```

The check taps the `[[Child]]` chip at a fixed point (the pool's iPhone 17 Pro, 402 pt
wide); on another device model, change `LINK_CHIP_POINT`. What it cannot do is the
finger-tracked edge swipe, which is the variant a person runs below.

## The story

1. Open **Parent**. Its body and the `[[Child]]` link show.
2. Tap `[[Child]]`. **Child** opens and starts streaming: "Loading the rest" shows under
   the first sections.
3. While it still streams, tap into the first section and type a marker word.
4. Tap Back (or edge-swipe) before the stream finishes. **Parent** shows its own text.
5. Wait for the save (a few seconds for a note this size), then read both files.

Expected:

- `Parent.md` is byte-for-byte what was seeded: one line and the link, not the child's body;
- `Child.md` carries the marker and every section of the original;
- the sync queue has no write for `Parent.md`.

The automated check asserts the first two and names whichever broke.

Repeat step 3 on a small **Child** (a few lines), typing and pressing Back inside a
quarter of a second: the typed word must reach `Child.md` and not `Parent.md`.

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
