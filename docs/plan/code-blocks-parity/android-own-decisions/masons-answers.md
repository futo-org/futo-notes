# Mason's answers to the own-decisions list

The 63 numbered items are the ones given to Mason in chat on 2026-11-18 (the same content as
`../android-own-decisions.md` and `by-area.md`, numbered). He answers them in blocks; each answer is
recorded here when it arrives. `A` = keep what is built, `B`/`C` = the alternative named in chat.

## Blocks

| Block | Items | Asked | Answered |
| --- | --- | --- | --- |
| 1 Spec-level | 1, 62, 63, 17, 18, 9 | 2026-11-18 | 2026-11-18 |
| 2 Header fields | 2, 19–26 | 2026-11-18 | |
| 3 Taps, holds, add-a-line | 3, 4, 5, 7, 8, 10, 11, 12 | | |
| 4 Keys and typing | 6, 13, 14, 15, 16, 27, 28, 29 | | |
| 5 Look | 30–38 | | |
| 6 Android's native behaviour | 39–44 | | |
| 7 Engine, part 1 (with P082, P292, P146, three backticks) | 45–51 | | |
| 8 Engine, part 2 (with P185, quick open) | 52–57 | | |
| 9 Desktop rules on the phone, not-built list, polish leftovers | 58–61 | | |

## Answers

### Block 1 (2026-11-18)

- **1A** keep select-first for Backspace after an image. "ios should act in this way too, but that's something to do later." Owed on iOS.
- **62A** keep: toolbar Bold with the caret in a word turns the whole word bold.
- **63B** build the spec's form for a tap on a wikilink to a missing note: an empty note opens under the link's target as its title and the file is written on the first edit. "should be deleted if going away with no edits": leaving with no edits leaves no note.
- **17A** keep: a header field writes the fence on every keystroke.
- **18B** the language field's keyboard has capitals and suggestions, as the !300 app had.
- **9A** keep, and more: "should be deactivated along with everything else that doesn't do anything as well". Every toolbar button that would change nothing in the current state is shown disabled.

Reported with block 1 (bugs, not picks):

- "caret around photos is acting weird. it's interacting with the text still, so backspacing is just removing text and the rendering is all off because of it"
- "tapping a photo shouldn't show a caret. the photo should just be selected, like code blocks". This replaces the mobile spec's "a plain tap on an image puts a caret right after it".

Owed on iOS later: image select-first on Backspace, a tap selecting the image with no caret, disabled toolbar buttons.

### Reported on the S23, build `a409ea1cb` (2026-11-19)

Tables (a change of the mobile spec's design, Android):

- "What's up with this table stuff? It's such a strange implementation. you've got this undo done bar instead of the normal one with the stuff you can't do taken away. I hate it. I can't click on empty cells either. It should basically be the same as the new desktop's"
- Cause of the dead taps in his note: the last row is `| lon![](…)`, one cell under a three-column header, and a tap on a column the row lacks does nothing.

Code blocks (bugs):

- "we can't usually hold down to cut/copy/paste the entire code blocks. I was able to get it once, but it was kinda busted."
- "when we tap on a block to select it, the view doesn't get scrolled to show it with the keyboard coming up."
- "the highlight seems too far down for the name and language for code blocks as well. (not centered on text or in their containers)"

### Asked 2026-11-19, unanswered

- **64** a wikilink whose target holds characters a file name cannot (`[[a:b?c]]`): 64A leave (a tap makes `abc`, the link still shows missing, a later tap makes `abc-2`), 64B a tap does nothing, 64C the link resolves through the title rule (shared note rules).
- **T1** the phone's form of the desktop's row and column grips. **T2** how a table is made on the phone.
- **T3** (all hosts, from the Desktop Editor chat) where a caret may rest in a row such as `| milk | 2 |`: T3A only in a cell's text on every host (its recommendation; the desktop changes too), T3B every character for arrows and only placed carets fitted, T3C a per-session setting (desktop yes, phones no).
- **T4** (all hosts) a press on a column the row lacks: T4A it fills in the row and enters that cell, through a new engine call `enter_table_cell` (the desktop today puts the caret at the end of the row's last cell), T4B as today.
