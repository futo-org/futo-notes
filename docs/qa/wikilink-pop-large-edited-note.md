# Wikilink pop of a large, edited note

## Why a person, not a test

Both native shells share one editor WebView between every open note, and the editor's
`change` message says nothing about which note it describes: the shell saves it into
whichever note it has bound when the message arrives. What decides the outcome here is
the order in which the OS runs two things during a **system** pop (the Back button or
the edge swipe) from a note opened through a wikilink:

- the linking note's view re-entering the window, whose adopt rebinds the WebView's
  callbacks and pushes the linking note's text, and
- the popped note's exit, which reads its document and commits it.

UIKit runs the first one first. Nothing below the real navigation stack reproduces that
order, so the automated seams each cover one half:

- `tests/editor-embed-milkdown.spec.ts`, "Note switch": the bundle posts nothing for the
  outgoing note once the shell has read it, and the switch itself posts nothing
  (`npx playwright test --config playwright.editor-embed.config.ts tests/editor-embed-milkdown.spec.ts -g "switch|exit read"`);
- `apps/ios/Tests/Editor/EditorDepartureCaptureTests.swift`: the read the adopt makes of
  the outgoing note, the `change` fence while it is pending, and the popped exit
  answering from it (`just test-ios-native`);
- Android's exit reads the note before it navigates (`EditorSessionTest`, "navigation
  commits the body before the title, then leaves"), so it has no pop-order window.

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

## Not proven by this run

- Android: the pop-order window does not exist there (the exit reads before it
  navigates), so this story is iOS-only. A late `change` on Android after the exit's
  read is covered by the bundle half, not by a device run.
- A note so large that finishing its load outlasts the popped exit's three capture
  attempts (about 18 s; 150000 sections on the simulator): the linking note stays
  untouched, but the exit commits the shell's copy, so an edit made while the tail
  streamed is lost. That is the specified bound for a capture that cannot answer, not
  a cross-note write.
- iOS 27: not run on this build; the original failure was confirmed there.
- A WebContent process that dies while the read is pending: the host resolves the read
  as "no document" and the exit falls back to the shell's copy. Not driven here.
