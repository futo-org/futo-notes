# Block movement

A block is moved to a boundary between lines as one edit (#311). The engine decides which lines
move together, where they may land and the move; a renderer names only the display position under
the finger and the boundary it is dropped on ([the mobile gesture](../mobile/block-drag.md)). Every line stays its own block in the projection: this is only
which lines move together. → crates/futo-notes-editor/src/engine/commands/moves.rs

## What lifts

- A plain line, a heading or a divider lifts alone. → crates/futo-notes-editor/src/engine/commands/moves.rs `block_lines`, crates/futo-notes-editor/src/engine/tests/moves.rs
- A plain line indented under a list item lifts alone when it is the line named. → crates/futo-notes-editor/src/engine/commands/moves.rs `block_lines`
- A list item lifts with the lines under it: the lines after it at its quote depth that are indented further, and a fence opened under it with its code, down to the first line that is not (the lines Indent moves with it, list-indent.md). A blank line ends it. → crates/futo-notes-editor/src/engine/commands/moves.rs `block_lines`
- A quoted line lifts the whole run of consecutive quote lines it is in, any list inside the quote included; a list item in a quote cannot lift on its own. → crates/futo-notes-editor/src/engine/commands/moves.rs `block_lines`
- A line of a closed code block lifts the whole block, fences included. → crates/futo-notes-editor/src/engine/commands/moves.rs `block_lines`
- A line of a table lifts the whole table. → crates/futo-notes-editor/src/engine/commands/moves.rs `block_lines`
- An image that shares its line with other content (text or another image; markers and whitespace do not count) lifts alone when the position named is on it: `Nice!![](a.jpg)` lifts `![](a.jpg)`, and each of `![](a.jpg)![](b.jpg)` lifts alone. Anywhere else on that line the line lifts as above, the image with it. → crates/futo-notes-editor/src/engine/commands/moves.rs `image_lifted`, crates/futo-notes-editor/src/engine/tests/moves.rs
- An image lifts with its line, as above, when it is alone on it (`![](a.jpg)`, `- ![](a.jpg)`), inside another mark (`[![](a.jpg)](u) x`, `**![](a.jpg)** x`, which taking it out would leave empty), or on a quote, table, code or front matter line. → crates/futo-notes-editor/src/engine/commands/moves.rs `image_lifted`
- A blank line and front matter lift nothing. → crates/futo-notes-editor/src/engine/commands/moves.rs `block_lines`
- A code block nothing closes (code to the note's end) lifts nothing, and neither does a list item whose lines run into one: wherever it went, the lines after it would turn to code. → crates/futo-notes-editor/src/engine/commands/moves.rs `block_lines`

## Where it lands

- A block may land on any boundary between lines, the top and end of the note included, except its own two edges and the boundaries inside it. → crates/futo-notes-editor/src/engine/commands/moves.rs `block_slots`
- Nothing lands above or inside front matter. → crates/futo-notes-editor/src/engine/commands/moves.rs `inside_unit`
- Nothing lands inside a code block, after code nothing closes, inside a table or inside a run of quote lines. → crates/futo-notes-editor/src/engine/commands/moves.rs `inside_unit`
- Strictly between two lines of a list (consecutive list items and the lines under them, with no blank line between) only an unquoted list item or a single unquoted plain line lands; a quote lands beside a list, never inside it. → crates/futo-notes-editor/src/engine/commands/moves.rs `block_slots`
- A lifted image lands where a single plain line would, and also on its own line's two edges: dropped directly above or below that line it leaves it. Neither edge is ever its own: no slot changes nothing. → crates/futo-notes-editor/src/engine/commands/moves.rs `image_slots`
- Boundaries at the same display position are one slot, the first of them: after a note's final line ending, the empty last line has no width, so the slot at the display's end is the boundary above it. A boundary at the display position of the block's own top or bottom edge is no slot: the block above that empty last line cannot land at the display's end, and a move there is refused. → crates/futo-notes-editor/src/engine/commands/moves.rs `block_slots`

## The move

- A move of lines reorders whole lines and writes no other byte, with one exception: the note's last line has no line ending, so a block moving to or from the last line trades endings with the line that becomes last (`a\nb\nc` with `a` moved to the end gives `b\nc\na`; `a\r\nb` gives `b\r\na`). → crates/futo-notes-editor/src/engine/commands/moves.rs `move_command`, crates/futo-notes-editor/src/engine/tests/moves.rs
- An image's move takes its source out of its line and writes nothing else there (its spaces stay: `a ![](x.jpg) b` leaves `a  b`), and inserts it with a line ending as a line of its own at the slot. The ending is its line's, else the line's above, else `\n`; at the note's end it goes before the image instead (`Nice!![](a.jpg)` dropped below its line gives `Nice!\n![](a.jpg)`, `Nice!![](a.jpg)\r\nb` dropped at the end gives `Nice!\r\nb\r\n![](a.jpg)`). → crates/futo-notes-editor/src/engine/commands/moves.rs `image_move_command`, crates/futo-notes-editor/src/engine/tests/moves.rs
- Blank lines are never added, removed or lifted. → crates/futo-notes-editor/src/engine/tests/moves.rs
- A block arriving in a list keeps its bytes as written: no indent, marker, checkbox or number is rewritten. → crates/futo-notes-editor/src/engine/tests/moves.rs
- A move is one host acceptance and one Undo step that restores the exact bytes and selection. → crates/futo-notes-editor/src/engine/tests/moves.rs
- A selection of exactly a lifted image travels with it; a caret beside it, or any other selection, stays with its text. → crates/futo-notes-editor/src/engine/commands/moves.rs `image_move_command`
- A caret or selection in the moved block moves with its text; one elsewhere stays with its line. A selection that starts in the block and ends at its end takes the whole block with it, line ending included (moved to the note's end, the ending stays behind with the line that was last); a caret at the block's end stays with the line below. → crates/futo-notes-editor/src/engine/commands/moves.rs `move_command`
- Reading and display after a move equal a fresh open of the same bytes. → crates/futo-notes-editor/src/engine/tests/moves.rs
- A move is cancelled, with no edit and no Undo step, when any line (the moved ones, the ones it passes, or a neighbor) would read as another kind of block afterwards: a plain `|---|` dropped under a pipe line, a `---` reaching line 1 with a later `---`, an image taken out of `---![](a.jpg)` leaving a divider. → crates/futo-notes-editor/src/engine/command/mod.rs `Command::same_kind`, crates/futo-notes-editor/src/engine/tests/moves.rs
- A line that lifts nothing, or a boundary that is not one of the block's slots, is refused with nothing changed. → crates/futo-notes-editor/src/engine/commands/moves.rs `move_block`
- A move against a stale revision is rejected and changes nothing. → crates/futo-notes-editor/src/engine/tests/moves.rs
- While text is marked a move is refused (`CompositionActive`), as table commands are. → crates/futo-notes-editor/src/engine/commands/moves.rs `move_block`
- Hosts address blocks in display coordinates: `block_at` gives the display extent a press at an offset lifts (the position under the finger: on an image, the image's characters; anywhere else on a line, that line), `block_slots` each slot as the display offset of the line start below it (or the display's end), and `move_block` moves the block to one of them. Native sessions take display bytes. _(native shells)_ → crates/futo-notes-ffi/src/editor/moves.rs, crates/futo-notes-ffi/tests/editor_block_move.rs
- *(iOS)* Puppet's `MoveBlock {line, column?, before | after}` moves what a press at UTF-16 `column` of a display line lifts (its start by default, so an image first on its line lifts alone) to the boundary above `before` or below `after`, through the same session calls. → apps/ios/Sources/App/PuppetNative/PuppetNativeVerbs+MoveBlock.swift, apps/ios/Sources/Editor/TextFirst/TextFirstEditorController+BlockMove.swift
- *(iOS)* Puppet's `MoveBlock` answers 409 for a boundary that is not a slot, or a move the engine refuses. → apps/ios/Sources/App/PuppetNative/PuppetNativeVerbs+MoveBlock.swift
