# Own decisions by area (every `leave` and `ask Mason` in VERDICT.md)

Numbers are VERDICT.md's. "Android does" is today's behaviour. Reverse: `one line`, `small` or `large`.

## Reports 1-3 and areas 2-3

- **v.7 Active block while a field is open**: the edited block shows its ghost and labels; !300 app keeps the previous block's, or none. Why: the field's block is the one being edited. Reverse: one line.
- **v.8 Field keyboard lowercase, action "→"**: !300 app capitals and "›". Why: a language is lowercase; Go is this block's code (spec). Reverse: one line.
- **v.9 Field ink, caret and selection colours**: text #1E1E1E, caret 1 dp, selection #E8CCA8; !300 app #0F0F0F, ~3 px, #E6C8B8. Why: app theme. Reverse: small.
- **v.10 / 8.6 Caret handles**: Android shows its handle after a tap in code, none in a field; !300 app the reverse. Why: platform default. Reverse: small.
- **v.12 Toolbar in code**: undo/redo, greyed inline formats; !300 app enabled formats, no undo. Why: Android's toolbar (area 16). Reverse: small.
- **v.13 / 3.10 Quote and front matter look**: grey bar, upright; monospace strip. !300 app orange italic; rule and plain text. Why: the editor's look, out of scope. Reverse: small.
- **v.14 Spec over the !300 app**: a hold selects the whole name; Enter goes to this block's code; "below" puts the caret on the new line and shows under a note-ending block; a long language is not scrolled out. Why: !300's spec. Reverse: small each.
- **3.1 Long-press then drag** extends the selection on a real touch stream; adb could not show it. Reverse: none needed.
- **3.3 Handle released on the header** keeps the finger's column on code line 1 (!300 app column 0). Why: native handle. Reverse: small.
- **3.4 Triple-tap** selects a code line without its newline (!300 app includes it). Why: native. Reverse: small.
- **3.5 Caret height** 77 px in body and code (!300 app 82 / 70). Why: Mason's equal-height rule; the font. Reverse: small.
- **3.6 Caret colour** #FF9000, orange handle (!300 app #F26B1F, blue handle). Why: app accent. Reverse: one line.
- **3.7 Up into the line above a block** keeps the column (!300 app column 0). Why: native line movement. Reverse: small.
- **3.8 Copy target** reaches the card's right edge (!300 app stops ~18 px short). Why: easier to hit. Reverse: one line.
- **3.9 "name" ghost** shows with the caret inside (and, since area 6, when selected); !300 app only when selected. Reverse: one line.
- **3.11 A tap on the band's gutter** puts the caret at column 0 (!300 app ignores it). Reverse: small.
- **3.12 A long-press on the band** selects the word (spec; !300 app caret and menu). Reverse: small.
- **3.13 A tap in a selected empty block then a letter** types into the block (spec; !300 app types above). Reverse: small.
- **2.8 Code font** JetBrains Mono; line breaks differ. Reverse: one line.
- **2.9 Editor colours** (selection, caret, text, copy check). Reverse: small.
- **2.10 Empty block** draws an empty code row "1" (!300 app header only). Why: the engine keeps one line for the caret; cb 732-735. Reverse: large.
- **2.11 Selection band in code** fills the row. Reverse: small.
- **2.12 A header tap** selects the code (the engine's block selection); !300 app selects with fences. Reverse: engine.
- **2.13 `c sharp`** shows `c` (the first word). Why: the engine's language. Reverse: engine.
- **2.14 Body text metrics** (text higher in its line, more space under headings). The editor's. Reverse: large.
- **2.15 Font scale 2.0**: Android scales the header; !300 app draws none (its bug). Reverse: none.

## Areas 4-8

- **4.3 Enter's indent** copies the line's own indent (!300 app indents by the language). Undecided. Reverse: large (needs per-language rules).
- **5.2 Ctrl/Alt+Backspace** delete one character (!300 app a word or line). No engine key. Reverse: small (host word boundary) .
- **5.3 Ctrl+Shift+K** does nothing (!300 app deletes the line). No engine command. Reverse: small with an engine command.
- **5.6 Empty pairs** `**` and `[[` take two Backspaces, `~~` and a backtick one. The engine's spec. Reverse: engine.
- **5.7 Spec over the !300 app** at fences with modifiers. Reverse: small.
- **6.6 Enter on a selected empty block** stays on its line (!300 app the line below). Undecided. Reverse: engine.
- **6.7 Select All then Bold** bolds the prose (engine; !300 app nothing). Undecided. Reverse: engine.
- **6.9-6.11 Spec over the !300 app**: header tap on a note-opening block selects it; handles after a long-press; Ctrl(+Shift)+Enter open a line. Reverse: small each.
- **6.12 Selection band in prose** reaches the card's border. Reverse: small.
- **p.2 A suggestion inside `**|**`** gets the keyboard's space before the closing marker (unbolds). Keyboard's. Reverse: small (host could move the space out).
- **p.4 Gboard's tool row** after a symbol. Gboard's. Reverse: none.
- **p.5 Field caret black** while the code caret is orange. Why: the field is inked as text. Reverse: one line.
- **7.4 A partly selected wrapped code line** widens its wrapped row to the edge. Reverse: small.
- **7.5 Paste a block into another block's code** writes fences into it. Engine. Reverse: engine.
- **7.6 Prose-into-code selection then Paste** takes the block whole and pastes (!300 app ignores). Reverse: small.
- **7.7 A pasted line starting with a space** shows no indent (kept in the file). Reverse: small.
- **7.8 Spec or pick over the !300 app** (P160, P162, P163, P176, P182/P183). Reverse: small each.
- **8.5 The 750 px jump** when the keyboard hides at the note's end (no animation). The editor's resize. Reverse: small.
- **8.7 No Cut/Copy/Paste menu** after a hold opens a field. Reverse: small.
- **8.8 Copy check grey; system toast** (!300 app orange; own toast). Reverse: one line / small.
- **8.9 Up in a field** keeps the caret at the end (!300 app the start). Reverse: one line.
- **8.10 The ghost "language"** shows while the name field is open. Reverse: one line.
- **8.11 A long name's field** scrolls to its end when selected (!300 app its start). Reverse: one line.
- **8.12 Spec over the !300 app** (P190 trailing space trimmed, P197, P206, P221-P223). Reverse: small each.

## Areas 10-13

- **10.1 Labels switch at once** (!300 app fades 100-150 ms). Reverse: small.
- **10.2-10.4 Spec over the !300 app**: "below" under a note-ending block; a tap under it adds a newline; the caret goes on the new line. Reverse: small each.
- **10.5 The handle dropped over "add a line below"** (see the guards). Reverse: small.
- **11.5 Three backticks before `go`** put the caret in the body with `go` as the language. Engine. Reverse: engine.
- **11.6 A code-block button and Undo/Redo** on the phone toolbar (!300 app has neither). Reverse: small.
- **11.7 Language field lowercase**; one Undo step fewer. Reverse: one line.
- **12.1 Tab mid-line** writes two spaces at the caret (!300 app indents the line). Undecided. Reverse: engine.
- **12.2 Shift-Tab on tabs** takes off one tab (!300 app converts and outdents by 2). Engine. Reverse: engine.
- **12.3 Toolbar Indent** writes a tab, the keyboard's Tab two spaces. Reverse: small.
- **12.4 Shift-Tab over prose through a block** does nothing (!300 app outdents the code). Reverse: small.
- **12.5 Tint plus highlight after Undo** restores a selected block. Not built. Reverse: small.
- **13.3 Up/Down across a block keep the column** (!300 app column 0 / line end). Reverse: small.
- **13.4 Shift+PageUp stops at a block's code start.** Reverse: small.
- **13.5 Shift+arrows stop at a block's edges.** Reverse: small.

## Areas 14-15

- **14.2 A paste ending in a closed block** leaves the caret on the line after it, opening one at the note's end (!300 app: the end of the pasted code). Engine's rule. Reverse: engine.
- **14.3 Redo of Backspace below a block** re-selects the block (!300 app: caret at the code's end). Engine spec. Reverse: engine.
- **14.4 Three typed backticks** write an empty block with no code line, take two Undo steps, and Redo reopens the language field (!300 app: an empty code line, one step). Engine. Reverse: engine.
- **14.5 Toolbar Undo/Redo** (!300 app has none). Reverse: small.
- **15.2 A word only in a block's info string** is not found (!300 app finds it). Engine searches display text. Reverse: engine.
- **15.3 The first › after typing** selects the current match without stepping (desktop's rule; !300 app steps). Reverse: engine.
- **15.4 Closing find keeps the match selected** (desktop's rule; !300 app restores the old selection). Reverse: small.
