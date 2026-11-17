# 8. Header fields (name, language)

!300's spec states no Escape or cancel behaviour for a field. Each keystroke is written at once (see below), so there is no separate commit.

| ID | Do | !300 result | Ref | Applies | Engine today | Target |
| --- | --- | --- | --- | --- | --- | --- |
| P188 | Look at what a block's header lets you edit. | Two fields: name (left) and language (right). | cb 598-601 | both | differs: Android shows a language label only, and a fence with no language has no header (fc 12) | Mason's pick: header fields are name and language only |
| P189 | Type into either field and watch the file. | Every keystroke rewrites the fence line's info string. There is no second buffer and no separate commit step. | cb 602-604 | both | unknown | !300 |
| P190 | Type a name ending in a space. | The field keeps the trailing space while you are typing, even though the parsed value has none. | cb 604-605 | both | unknown | !300 |
| P191 | Type `objective c` into the language field. | The space becomes a hyphen: `objective-c`. | cb 371-372 | both | unknown | !300 |
| P192 | Type a space at the start of the language field. | It is dropped. | cb 372 | both | unknown | !300 |
| P193 | Type spaces and any characters into the name field. | Nothing is rewritten. | cb 372-373 | both | unknown | !300 |
| P194 | On desktop, with the caret elsewhere in the note (the block not active), click the name field. | Self-contradictory. One line says "A MOUSE click on the name field edits it, wherever the caret was". Another says "a click or tap on it edits only while the block is active … otherwise it selects the block". | cb 374-379; cb 681-684 | desktop only | host's job (fc 30) | Mason's pick: on desktop a click on a header field edits it |
| P195 | On a phone, with the block not active, tap the name field. | The block is selected, and the field does not open. A stray tap on the empty name chip cannot open an editor. | cb 375-377; cb 681-684 | touch | host's job (fc 30) | ask Mason (phone rule undecided) |
| P196 | On a phone, with the caret inside the block or the block selected, tap the name field. | The name field opens for editing. | cb 376-377; cb 681-683 | touch | host's job (fc 30) | ask Mason (phone rule undecided) |
| P197 | On a phone, long-press the name field, from anywhere. | The field is focused and its text is selected. | cb 622-623; cb 684-685 | touch | host's job (fc 30) | ask Mason (phone rule undecided) |
| P198 | On desktop, click the language chip, both on a block with a language and on one showing only the ghost "language". | The block's code is copied, every time. | cb 606-608 | desktop only | host's job (fc 30) | Mason's pick: on desktop a click on a header field edits it (copy on click is not carried over) |
| P199 | On desktop, double-click the language chip. | It copies twice. | cb 608 | desktop only | host's job (fc 30) | Mason's pick: click edits (not carried over) |
| P200 | On desktop, right-click the language chip. | The language field opens for editing. The clipboard is untouched. | cb 609-611 | desktop only | host's job (fc 30) | !300 |
| P201 | On a phone, with the block not active, tap the language chip. | The block's code is copied. | cb 606-608 | touch | host's job (fc 30) | ask Mason (phone rule undecided) |
| P202 | On a phone, long-press the language chip (500 ms or more, without drifting past the slop). | The language field opens for editing. The platform context menu and the iOS callout are suppressed, and the clipboard is untouched. | cb 609-611; cb 615-618 | touch | host's job (fc 30) | ask Mason (phone rule undecided) |
| P203 | Finish that long-press. | The hold swallows the click that follows it, so nothing is copied on release. | cb 618-619 | touch | host's job (fc 30) | ask Mason (phone rule undecided) |
| P204 | Long-press either field on iOS and release. | The field focuses on RELEASE (not when the timer elapses), so the keyboard comes up. | cb 618-621 | touch | host's job (fc 30) | ask Mason (phone rule undecided) |
| P205 | On a phone, with the caret inside the block, tap the chip's label (or the revealed ghost "language"). | The language field opens instead of copying. | cb 611-614 | touch | host's job (fc 30) | ask Mason (phone rule undecided) |
| P206 | On a phone, with the caret inside the block, tap the copy glyph. | It copies. The copy target never goes away. | cb 614-615 | touch | host's job (fc 30) | ask Mason (phone rule undecided) |
| P207 | Copy using the chip. | The glyph flips to a checkmark for about a second, and a "Copied to clipboard" toast shows. Nothing else changes: the label or ghost keeps its text and place, and nothing reflows. | cb 641-645 | both | unknown | !300 |
| P208 | Copy using the chip in the native iOS and Android apps. | The "Copied to clipboard" toast appears there too. | app 347-350 | touch | unknown | !300 |
| P209 | Copy with the chip while the system refuses the clipboard write. | A toast says that the copy failed. | cb 638-639 | both | unknown | !300 |
| P210 | On desktop (macOS WebKit) or iOS, press once on the chip's label text. | One press copies. Before this fix, the label was rebuilt under the press and copying took two presses. | cb 624-630 | both | host's job (fc 30) | !300 |
| P211 | On a block with no language, press the chip once while the block is not active. | One press copies. The chip's hit box is the same in both states, so it does not grow under the pointer and swallow the click. | cb 631-637 | both | host's job (fc 30) | !300 |
| P212 | Select a block (or text), then press into a header field. | The note's selection is cleared, so the block's paint goes away, and the field gets focus. | cb 285-290; cb 298-299 | both | host's job (fc 30) | !300 |
| P213 | Click in the middle of a field's value. | The field's caret lands where you clicked, not at the end of the value. | cb 290-292 | both | host's job (fc 30) | !300 |
| P214 | Drag inside a field. | The field's text is selected. | cb 292-293 | both | host's job (fc 30) | !300 |
| P215 | Enter a field while a block is selected. | No caret flashes on the header or the opening fence for a frame before the focus moves. | cb 293-297 | both | host's job (fc 30) | !300 |
| P216 | Move keyboard focus into a field (Tab) while text is selected. | The note's selection is cleared in the same way. | cb 297 | hardware keyboard | unknown | !300 |
| P217 | In the name field, press Tab. | Focus moves to the language field. | cb 966 | hardware keyboard | unknown | !300 |
| P218 | In the language field, press Tab. | Focus moves to the code. | cb 966 | hardware keyboard | unknown | !300 |
| P219 | In the language field, press Shift-Tab. | Focus moves to the name field. | cb 966-967 | hardware keyboard | unknown | !300 |
| P220 | With the caret at the very start of the block's first content line, press Shift-Tab. | Focus moves to the language field. Outdent is a no-op there anyway. | cb 967-968 | hardware keyboard | differs: code claims Shift+Tab on its lines (fc 23) | !300 |
| P221 | In the name field, press Shift-Tab. | Nothing happens: there is no Shift-Tab out of the name field. | cb 968 | hardware keyboard | unknown | !300 |
| P222 | In either field, press Enter. | The caret moves into the code. | cb 969 | both | unknown | !300 |
| P223 | On Android, in the language field of a block, with another block further down the note, press the soft keyboard's Enter key. | The caret moves into THIS block's code. Focus never jumps to the next block's name field: each field names its own Enter key. | cb 971-978 | touch | unknown | !300 |
| P224 | In either field, press ArrowUp. | Focus leaves the block for the line above. | cb 979-980 | hardware keyboard | unknown | !300 |
| P225 | In either field, press ArrowDown. | The caret enters the code at the first content line. | cb 980-982 | hardware keyboard | unknown | !300 |
| P226 | In a field of a block that opens the note, press ArrowUp. | Focus stays in the field. | cb 982-984 | hardware keyboard | unknown | !300 |
| P227 | In a field of a block with no content line at all, press ArrowDown. | Focus leaves the block BELOW it. | cb 985-987 | hardware keyboard | unknown | ask Mason (cb 732 says no block is ever without a content line) |
| P228 | On a phone, with a header field focused, tap the toolbar's dismiss chevron. | The keyboard goes away. | app 271-274 | touch | unknown | !300 |
