# Code blocks (`cb`)

Source: `origin/desktop/new-editor:docs/spec/editor/desktop/code-blocks.md`. P-numbers are rows of this folder's parity tables; "V" is a row of VERDICT.md.

| # | Desktop does | Kind | Phone form / reason | Android now | Action |
| --- | --- | --- | --- | --- | --- |
| cb-1 | Draws a block as one flat card: well, hairline, Martian Mono, 27px header, 10px skirt, 4px between blocks. | Android's earlier decision | Android draws !300's card: its code size, line height, gutter and spacing (P017, P021, P036, P039 "Keep 300s spacing"). | same as !300 (V area 2; 2.1 fixed); code font is open (V 2.8) | none |
| cb-2 | Numbers each code line in a gutter; numbers are not text; gutter as wide as the line count's digits, at least two. | host: phone form | The same. | same (P042, P044, P045; V area 2) | none |
| cb-3 | Makes the caret in code as tall as in a paragraph. | host: phone form | The same. | same (P329; V area 3) | none |
| cb-4 | Puts name, language and copy in a header that is not text; Up and Down cross it. | host: phone form | The same. | same (P188 fixed, P069) | none |
| cb-5 | Sizes each field to its value plus a collar; caps the name at 30 chars or 45%, the language at 14 or 30%; ellipsis. | host: phone form | The same. | same (V 2.5, #4, #5 fixed) | none |
| cb-6 | Stands each field and the copy button 2px from the card's top and side. | host: phone form | The same. | same (P021; V 2.4 fixed) | none |
| cb-7 | Shows a field's placeholder while the caret is in the block, the block is selected, or the pointer is over the header. | host: phone form | No hover: shows while the caret is in the block or the block is selected. | selected-block ghost fixed (V 6.5); caret-inside ghost and "language" ghost are open (V 3.9, 8.10) | none |
| cb-8 | A click on a field edits it, wherever the caret was. | Android's earlier decision | !300's touch rule: a chip tap copies unless the caret is in the block, a hold edits; desktop's "click edits" is not copied. | same as !300 (P195-P197, P201-P205) | none |
| cb-9 | The copy button copies the code without fences, shows a check and "Copied to clipboard"; works read-only. | host: phone form | A tap on the copy glyph. | same (P206, P207, P209); check colour and toast style open (V 8.8) | none |
| cb-10 | While a field has focus the note draws no caret; a note selection ends when a field takes focus. | host: phone form | The same. | same (P212) | none |
| cb-11 | Treats a field as a buffer written once when focus leaves; language spaces become hyphens; name trimmed. | Android's earlier decision | !300: each keystroke is written at once, one letter per Undo (P189). Hyphen and trim rules kept. | same as !300 (P189-P192) | none |
| cb-12 | Field keys: Enter/Down to the code, Up above, Tab walks name-language-code, Escape restores and leaves. | host: phone form | Soft keyboard's action key is Enter; a hardware keyboard keeps every key (Esc for Escape). | Tab, Enter, Down, Up walk as desktop; Escape does not restore (the field writes per keystroke) and closes the keyboard | differs: Escape. Follows from writing per keystroke (own decision); recommend Escape = Undo of the field's edits, not built |
| cb-13 | After a third backtick (or Undo to that caret) the language field takes focus; Enter goes to the code. | engine | `writes_language` (fenced-code.md); the host opens the field. | same | measured |
| cb-14 | Puppet's state names the open header field. | host: phone form | Android Puppet's own state. | to measure | none |
| cb-15 | Gives a block "add a line above/below" labels only where no ordinary line is beyond that edge; none read-only. | host: phone form | The same. | same (P261, P265-P267) | none |
| cb-16 | Hides a label until the pointer is on its edge; one label at a time. | host: phone form | No hover: labels show while the block is active. | same (P278, P279) | none |
| cb-17 | Centres "above" between name and language, "below" in the skirt; labels take no room. | host: phone form | The same. | same (P259, P260; V area 10) | none |
| cb-18 | Draws label words from the catalog; never text. | host: phone form | The same. | same (P275) | none |
| cb-19 | A click on a label opens a line there; a press below "below" too; a press in the skirt goes to the last code line. | host: phone form | A tap. | same (P258, P276, P277, P280, P282) | none |
| cb-20 | A press in the strip above a block that opens the note lands in its first code line. | Android's earlier decision | !300: that strip answers nothing (P073). | same as !300 (P073 fixed) | none |
| cb-21 | Highlights a selection in code over the code column only, never the gutter. | host: phone form | The same. | same (P172, P175, P177); band width open (V 2.11, 7.4) | none |
| cb-22 | Fills the whole card for a selected block or one taken whole; no caret. | host: phone form | The same. | same (P125, P131, P136, P161; V 3.2 fixed) | none |
| cb-23 | Squares a filled card's corner where the highlight runs on past it; touching blocks keep facing corners round. | host: phone form | The same. | corners stay round where the band runs on; the band is inset ~13 px from the card's sides | differs; recommend squaring the meeting corners, host, small; not built |
| cb-24 | Keeps a selection anchored in code inside that code; Shift+Down stops at the edge. | host: phone form | A handle drag stops at the code's edge; hardware Shift+arrows stop there. | same (P157-P159; V 13.5) | none |
| cb-25 | A selection from below that stops at the code's end starts past the line break instead. | host: phone form | The same (Mason's host rule, P166). | fixed (V 7.1) | none |
| cb-26 | A drag off a code row's side stops at that row's start or end; outward from the code's edge selects nothing. | host: phone form | A handle dragged past a row's side. | same for handle drags | measured |
| cb-27 | Hides the selection toolbar for a selected block or a selection wholly in code. | host: phone form | The keyboard toolbar stays; inline formats grey out in code. | toolbar differs in code, left (V #12) | none |
| cb-28 | Keeps the engine's selected block through every change. | engine | Reported on every view and selection change (fenced-code.md). | same (P129) | none |
| cb-29 | A press on the header selects the block; a press under a note-ending block opens a line; a press in code places a caret. | host: phone form | A tap. | same (P123, P271, P281; P078 fixed); header tap selects code, open (V 2.12) | none |
| cb-30 | Arrows on a selected block: Up/Down leave it, Left/Right to code start/end; Down past a note-ending block opens a line. | host: phone form | Hardware keyboard only. | same (P138-P145, P148; V 6.2, 13.1 fixed) | none |
| cb-31 | Mod+Enter / Shift+Mod+Enter on a selected block open a line after / before. | host: phone form | Hardware Ctrl+Enter, Ctrl+Shift+Enter. | same (P149, P150; V 4.1 fixed) | none |
| cb-32 | Takes each code line's place in its block from the engine; Puppet refuses on drift. | engine | Android draws from the engine's facts (fenced-code.md, Android line). | same | none |
