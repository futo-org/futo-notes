# iOS note-list construction — 2026-11-15

Investigated cold-launch scrolling and folder push/back latency with 2,000 short
synthetic notes. Base: `cdc66fe3b`. macOS, Xcode 27.2, iOS 27.2 iPhone 17 Pro
simulator, Debug Swift and dev-profile Rust. No personal notes were used.

## Findings and changes

The `.id(ListRowID.note(...))` modifier inside each `ForEach` row forced SwiftUI
to construct every row to discover its scroll identity. The native reproduction
mounted the real `FolderContentsView` with 2,000 notes: **all 2,000 `NoteRow`
instances were constructed**, although only a screenful could be visible.
These modifiers entered the folder list in `4c772ce41` with puppet support.

Give `ForEach` the prefixed identities directly, for notes, folders and search
results. Accessibility identifiers and `ScrollViewReader` targets keep their
existing values. The same test now constructs **11 rows**. Its assertion permits
up to 99, allowing prefetching without admitting whole-collection construction.
The DEBUG-only initializer observer measures real row construction; it is absent
from Release builds and unset during ordinary app use.

Separately, `Localization.renderTemplate` created and configured a number
formatter even for plain action labels. It now creates one lazily only if a
numeric placeholder needs it, retaining per-message reuse and locale behavior.

| Focused measurement                               |  Before the respective change |              After |
| ------------------------------------------------- | ----------------------------: | -----------------: |
| 20,000 plain list-action lookups                  | 109.6 ms; fails 100 ms budget | 7.4–7.9 ms; passes |
| Rows constructed when opening a 2,000-note folder | 2,000; fails `<100` assertion |         11; passes |

The row test's initial hosting-window/layout time was 163.6 ms before the
identity change and 147.2 ms after. That includes first-use UIKit/SwiftUI work;
the row-count reduction is **not** a claim of a corresponding reduction in
whole-screen latency or a measured iPhone frame rate.

## Reproduction and verification

After claiming an iOS simulator, run:

```sh
just test-ios-native NoteListLazinessTests LocalizationTests TextFirstLeaveTests
```

`LIST_BUILD_BENCH` and `LIST_LABEL_BENCH` print the measurements. Both performance
tests were run red before their fixes. `NoteListLazinessTests` seeds its own
2,000-note vault and cleans up only that fixture.

Live-app QA used a separate 2,000-note collection: 1,000 root notes and ten
folders of 100 notes, with sync disconnected. `just puppet` exercised launch,
vertical scrolling, folder opening, real edge-swipe Back, offscreen note/folder
scroll targets, opening notes from those targets, and opening a search result.
The final app was visually inspected. Instruments Time Profiler identified the
row-construction/localization work and showed it reduced after the fixes.
Puppet inspection stacks were excluded when attributing app work. Animation
Hitches is unsupported on this simulator; these captures do not establish
physical-device frame pacing or performance during active sync.

## Note integrity

Four native fixtures covered straight/curly apostrophes, ampersands, character
references, literal entity-like text, CRLF, front matter and alternate Markdown
spelling. Opening and leaving them changed neither bytes nor modification times;
all 2,000 fixture files remained unchanged after browsing. Native tests also
cover selection, a lifecycle checkpoint and close. The Milkdown bridge suite
passed all 24 tests, including added first-open character-reference cases.

The native editor displays an existing `&#39;` or `&amp;` literally, as specified
by `docs/spec/editor/portable-core/linedown.md`; its list preview can decode it.
This can reveal an encoding already stored by an older editor. It is a plausible
explanation for the reported characters, whose original sequence was unavailable,
not proof of their origin. No conversion or migration of user files was added.

Local traces, logs, fixture manifests and scripts are retained under
`verification-runs/ios-list-integrity/` in the investigation worktree; puppet
receipts and screenshots are under `.puppet/`. These generated artifacts are
not committed.
