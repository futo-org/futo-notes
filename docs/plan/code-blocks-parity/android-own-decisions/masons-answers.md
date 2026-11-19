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
- **M1** one Android MR or two (polish onto main, code blocks stacked on the engine MR). **S1/S2** keep the table spike going, or cancel it until the table deep dive.
- **H1** a hold with no field focused on a code block's header, its code, or a photo: the block drag of !716 lifts it; the code-block lines select the block with Cut, Copy and Paste.

Answered through the Desktop Editor chat (2026-11-19): **2B**, the engine MR carries the code-blocks layer only and the list-marker layer opens the desktop stack later. "Sure, 2b is fine, we just want it to all be in main in the end and be reasonable to navigate the mrs"

### Reported on the S23, build `a409ea1cb`, later on 2026-11-19

- Links: "looks like the links are too large. I'm tapping the row beneath one, and it's just taking me to it. Specifically the 'Linked note' in the editor demo on my s23" and "I mean the link tapping area btw, not the link text iteself". Fixed in `d94bc3db3`.
- "highlighting also looks messed up. You can check the last few screenshots on my s23 to see a few bugs I've seen". The screenshots (13:50, 10:07, 08:51) show: the selection tint on a wrapped nested task's second row running to the left margin; an empty white menu pill; the insertion handle drawn over the toolbar; a photo in a table cell drawn over the title bar.
- "The scrolling with the caret when going off screen is way too fast and doesn't have that speed gradient thing we were talking about (at least we talked about it with desktop I think)"
- "Sometimes when tapping around retapping or something i get an invisible or small caret (second screenshot there)". The 10:07 screenshot: a half-height caret on the note's empty last line.
- "can you take the android work from here and bring it in for us to play around with?" of !716 (Justin's Android block drag). Built on a scratch branch, never merged into this one.

### Reported on the S23, build `f26b323a6` (2026-11-19)

- "Can't highlight the > atom"
- "Copying form the code block has two toasts. A "Copied" one and another with the notes logo popping up. We just want the logo one"
- "bullets and chgeckmark boxes can't be highlighted iether. I think this is a deeper underlying atom thing". Cause: on this engine layer a marker is hidden source and is tinted only when its whole row is selected; the list-marker-units layer makes each bullet, number and task box one unit. A quote's `>` is a unit in neither layer.
- "Tapping a checkmark puts me at the top of the note. Not keeping scroll position. this might be a deeper thing. Seems like a bunch of things are messing with my scroll position"

Asked, unanswered: **L1** when the marker units reach Android: L1A now, under the code-blocks work; L1B later with the desktop stack, as 2B has it.
