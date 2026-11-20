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
- "Also seems like tapping and having the keyboard come up is a bit laggy. Just doesn't feel great. Definitely want an agent looking into that on desktop". Its own agent on the desktop, branch `perf/android-keyboard-open`.

Relayed by the Desktop Editor chat (2026-11-19), on M1: "We can have more for the Android editor". The desktop stack is three MRs on the engine MR; that count does not limit Android's. How many Android MRs, and which, is still open with Mason.

### Scope for the MR (2026-11-19, afternoon)

Asked how long until an MR, I proposed keeping four things out to reach the next day: tables stay as they are (S2; T1–T4 wait for the table deep dive), marker highlighting lands with the desktop stack (L1B), block drag stays on the scratch branch until !716 merges (the caret edge-scroll ramp with it), and blocks 2–9 are skimmed once with only must-change items done before the MR. Mason: "Okay, sounds good. I'm really shooting for tomorrow. Really hoping we can nail the dragging blocks by tomorrow too"

So: **S2**, **L1B**, T1–T4 deferred; block drag is made solid on `play/android-code-blocks-block-drag`. H1 runs on its default (H1A) until he says otherwise.

- "Also, the / menu isn't there" (2026-11-19). The `/` menu is a desktop-only line in the spec (interactive-elements.md) and was never in the native Android or iOS editor. Asked: **Z1** build it on the phone after this MR (Z1A) or inside it (Z1B).
- "took a screenshot of the caret dragging off screen with a picture above not allowing the scrolling up. This goes with the speed thing I talked abotu earlier." (build `f26b323a6`, 16:09). The screenshot: the insertion handle at the top-left corner of a tall photo at the top edge of the note, the note not scrolling further; an empty white menu pill over the back arrow.
- "When I cycle to the first result in the find in note, the keyboard drops" (build `f26b323a6`).

- **C1B** (2026-11-19): the lifted block's card stays at 80% of the page colour, as !716 specifies, though the independent check called it hard to read in dark mode. Asked: C1A opaque on Android, C1B keep 80%. Mason: "c1b"

## S23 reports, 2026-11-20 (drag build `4e55a159b`, installed 08:38)

- "dragged a block from towards the bottom of this note – under the pictures, brought it up, and the text preview in the note is not showing up anymore". His 08:39 screenshot: the gap is open under the lifted card but holds no dimmed copy of the block. After the release the text was not at the gap and the file had not been rewritten a minute later.
- "caret placement seems off in the screeenshot I jsut took, compared to desktop at least mabye. It just doesn't seem centered properly.??" His 08:42 screenshot: the caret on an empty line between a code block and a photo starts 2 px under the block and ends 12 px above the row's end.
- "If I enter in teh middle of the numbered list, then enter again to remove the number on that line, it stops rendering number for the atom for the item underneath."
- "When creating the code block with ```, the caret is in the block body for a second before moving to the language field. Should just be in the language field to start"
- "The ghost preview that you drag for code blocks has whitespace above and below it. This is the case with photos and other things too. I think we do want some whitespace around the things, but I want it to be even around everything and look clean always"
- "Highlight on photos (might be more things too) is cut off before the top bar. screenshot taken". His 08:58 screenshot: a selected photo scrolled under the title bar, untinted in a strip about 48 px tall right under the bar.
- "Also, we want it so if you're selecting a new line on the last / first part of selection, it shows the new line as selected (since I'm assuming it is if you're cuttitng / copying)". A requested change: the spec promised the stub only for an empty row.
- "took a screenshot of a pucture getting cut off while block dragging, it also seemed to create blank spaces where I coudl drop the block, but I'm not quite sure exactl" (build `798a8b166`, 09:24). The screenshot and the phone's drag log: everything blank is the drag's drawing tiles 20–25, the edge inside the cut photo is at 26 × 256 px, so some tiles are recorded or left empty and never drawn again. The missing dimmed copy of the first report is the same fault.
- "Looks like that caret thing is just a thing on every line. I think the caret is too high up on the lines?"
- Asked: the h1's text sits 14 px low in its row; 1A leave for after this MR, 1B fix now. Mason: "Also, the text spacing on the bigger headings sucks, but idk what to do about it. It just doesn't read well right now. 1b. Let's fix this heading stuff now". The caret measured: body text is centred in its row within 1 px; the caret reaches 20 px above the capitals and 1 px below the descenders.
- "Also, looks like text in inline code might be not aligned either. Have an agent look at all alignment" / "A sol 6.2 agent". Started as a measuring audit on its own branch `audit/android-alignment`; fixes go to the builder.
- Relayed by the Desktop Editor chat (not said in this chat): Mason, of the desktop's picture fixes of 2026-11-20, "these things should go to android as well". His desktop request: "I also think the caret size should match the picture height when on the sides. This goes for all different sized blocks like this". Building the picture-tall caret on Android. The relay's other two (the view not moving off a picture when the caret steps onto its line; no format bar for a picture-only selection) are the relay's guess at what he meant: asked.
- Heading sheet 1 (V0 today, V1 desktop rule, V2 tight wraps, V3 tight wraps with 65/35 room). Mason: "I like the inner-heading sizing of v3, but I think there's too much space around the headings though. We don't want that much space". Settled: wrapped h1/h2 rows 1.25 × the font apart. Open: the room above and below (sheet 2).
- Heading sheet 2 (R0–R3, less and less room around headings). Mason: "Actually, there sohuldn't be any extra whitespace tbh. We want people to add their own whitespace with empty lines" and "This goes for desktop too". Rule built: h1/h2 rows 1.25 × the font, h3–h6 one body line, visible text centred, no space above or below. Passed to the Desktop Editor chat.

## Decisions, 2026-11-20 midday

- **D1B**: the code-blocks MR is stacked on Justin's !716, so the drag and today's fixes to it ship together. Asked D1A (MR without the drag, fixes handed to Justin) or D1B. Mason: "d1b". From here `feat/android-code-blocks` holds !716 (head `b529ed6ec`) and the fixes to his files as their own commits; nothing has been pushed to his branch or written on his MR.
- **Z1A**: the `/` menu on the phone is built after this MR, with the query rule in the engine. Mason: "z1a".
- **3C**: of the desktop's picture fixes, Android takes all three: the picture-tall caret (built), inline format buttons dimmed for a picture-only selection, and the picture staying in view when the caret steps onto its line. Mason: "3c".
- "Look at the most recent screeenshot. I placed teh block with drag between these callouts and now it looks like this" (build `118bdf42a`, 11:59). An empty code block dropped between two quote lines: the source saved is right, but the quote line above it draws with a code line's indent and gutter rule, the code card draws doubled, and the quote bar runs through the code rows.
- "Tehre's also this thing where the haptics are going crazy when doing the off-screen scroll. It's been doing this since the beginning. I think it's hinting at some lower bug that leads to inconsistent scrolling speeds, but that gradient is much better" / "have a sol agent look into and fix that one". A Sol agent has it on its own branch `fix/android-edge-scroll-haptics`.
- "Sometimes when I drag a block in between pictures (at least) and let go, the position scoots, jitters, jumps, and it's annoying. we don't want that. have a sol agent look into it" (build `82ded88b6`). A Sol agent has it on `fix/android-drop-landing-jump`.
- 3C, result: the photo staying in view is built (`e8200bc33`). Dimming the inline format buttons for a picture-only selection is blocked on the engine: `toolbarState()` reports BOLD, ITALIC, STRIKE and LINK as allowed for that selection and Bold wraps the image in `**`. Owed to the Desktop Editor chat (unreachable at 13:30): the request that a selection of only image atoms reports the inline formats as not allowed.

## The merge request, 2026-11-20 afternoon

- Mason, before leaving for four hours: "I want to draft an mr body exactlyy in the style of the desktop bodies before I go that you will post when you verify it all on your end. I'm not going to do a manual run for this. Then, we want all the mrs to not be drafts anymore".
- On the draft body: "We need to change the name to feat(android): new editor", "change the branch name to make sense, sicne this is the entire editor", "1a" (one MR, polish included), "3a." (mark ready !722, !724, !725 and the Android MR; leave !723 Draft), "2 sounds good." (the bar for posting: full JVM and device run sorted, `just check` green, debug commits and the plan folder out; no post on an open regression), "I want you to also post this as a draft with modified language that makes sense since you're doing the verification stuff and then update it when it's ready."
- Done: branch `android/new-editor`, Draft !729 → `editor/code-blocks`.
- List markers on the phones (the !723 work), asked and answered 2026-11-20: tap on a bullet or number, 1A like a character (left half before the marker, right half at the text's start) or 1B always the text's start: "1a". Hold on a marker, 2A selects just the marker or 2B the first word: "2a". Checkboxes, a hold 3A selects it without ticking or 3B does nothing: "3a". The quote `>`, 4A a follow-up or 4B in !723: "4a". iOS, 5A this chat does it and Justin reviews or 5B Justin does it: "5a also update the mr to say what's going on". !723's description now says so. Start: after !729 is ready.
- "The s23 will not be plugged back in. You are on your own" and, on retargeting !723: "Yeah, 723 can do whatever as long as we have a clean path to everything being ready and cleanly merged down all on your own,". My reading: restacking !723 is approved; it is not a word to merge anything. The desktop chat asked that !722, !724 and !725 stay Draft until it says "desktop stack is ready"; agreed.
