# Block drag

Moving a block by hand in the native editor (#311). The engine decides which lines a block is,
where it may land and the move ([portable-core block movement](../portable-core/block-movement.md));
the lines here are the gesture that names the line under the finger and the slot it lands on.

The iOS long-press is an experiment (#441) awaiting the maintainer's verdict on a phone: lifting
anywhere in the body takes the platform's long-press from it. If that fails, the first fallback is
lifting only while the keyboard is down.

> **Gap:** Android has no block drag gesture yet (#444): a long-press there is still the platform's.

- *(iOS)* Holding a finger 340 ms within 10 pt anywhere on a line of the note body (its margins included) lifts the block the engine says that line lifts. → apps/ios/Sources/Editor/TextFirst/TextFirstEditorController+BlockDrag.swift `TextFirstLiftPolicy`, apps/ios/Tests/Editor/TextFirst/TextFirstBlockDragTests.swift, apps/ios/UITests/TextFirstBlockDragUITests.swift
- *(iOS)* A long-press that lifts nothing keeps the platform's (the loupe, the text menu with Paste): on a blank line, the note's empty last line, front matter, code nothing closes, and anywhere in an empty note. → apps/ios/Sources/Editor/TextFirst/TextFirstEditorController+BlockDrag.swift `liftPlan`, apps/ios/Tests/Editor/TextFirst/TextFirstBlockDragTests.swift
- *(iOS)* While a table cell is open, and while a long note is still opening, no press lifts: the long-press is the platform's everywhere in the note. A press within 22 pt of a shown selection's start or end stays the selection handle's. The title field is not part of the body and keeps its own. → apps/ios/Sources/Editor/TextFirst/TextFirstEditorController+BlockDrag.swift `TextFirstLiftPolicy`, apps/ios/Tests/Editor/TextFirst/TextFirstBlockDragTests.swift
- *(iOS)* A long-press on an image or a link lifts the block that holds it and opens nothing; on a table's grid it lifts the whole table. → apps/ios/Tests/Editor/TextFirst/TextFirstBlockDragTests.swift
- *(iOS)* In the note body a press that lifts starts neither the platform's loupe nor its long-press selection, and dragging selected text (the platform's text drag) is off; a double-tap still selects a word, and a tap, a checkbox tap, vertical scrolling and a table's sideways scroll are unchanged. → apps/ios/Sources/Editor/TextFirst/TextFirstEditorController+Taps.swift, apps/ios/UITests/TextFirstBlockDragUITests.swift
- *(iOS)* At the lift a keyboard composition is settled, an open edit menu closes, and the note stops scrolling until the finger lifts; the keyboard stays as it was, and after a move the caret or selection stays with its text. → apps/ios/Sources/Editor/TextFirst/TextFirstEditorController+BlockDrag.swift `liftShouldBegin`, `beginBlockDrag`
- *(iOS)* The lifted block is a card, a snapshot of the block at its full on-screen size (the part that shows, for a block running off screen) with a see-through background, that follows the finger; the block's place in the note is dimmed. Neighbouring blocks do not move. → apps/ios/Sources/Editor/TextFirst/TextFirstEditorController+BlockDrag.swift `TextFirstBlockDrag`
- *(iOS)* A drop line marks the engine's slot whose boundary is nearest the finger, among the slots that show (not under the keyboard); when one of the block's own two edges is nearer there is no drop line. → apps/ios/Sources/Editor/TextFirst/TextFirstEditorController+BlockDrag.swift `TextFirstDropTargets`, apps/ios/Tests/Editor/TextFirst/TextFirstBlockDragTests.swift
- *(iOS)* Releasing over a drop line moves the block there as one Undo step. Releasing with no drop line, onto a move the engine refuses, or after the note changed during the drag, changes nothing and the card slides back to its place. → apps/ios/Sources/Editor/TextFirst/TextFirstEditorController+BlockDrag.swift `endBlockDrag`, apps/ios/UITests/TextFirstBlockDragUITests.swift
