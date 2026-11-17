# Block movement

A block is moved to a boundary between lines as one edit (#311). The engine decides which lines
move together, where they may land and the move; a renderer names only the line under the finger
and the boundary it is dropped on. Every line stays its own block in the projection: this is only
which lines move together. → crates/futo-notes-editor/src/engine/commands/moves.rs

## What lifts

- A plain line, a heading or a divider lifts alone; so does a plain line indented under a list item when it is the line named. → crates/futo-notes-editor/src/engine/commands/moves.rs `block_lines`, crates/futo-notes-editor/src/engine/tests/moves.rs
- A list item lifts with the lines under it: the lines after it at its quote depth that are indented further, and a fence opened under it with its code, down to the first line that is not (the lines Indent moves with it, list-indent.md). A blank line ends it. → crates/futo-notes-editor/src/engine/commands/moves.rs `block_lines`
- A quoted line lifts the whole run of consecutive quote lines it is in, any list inside the quote included; a list item in a quote cannot lift on its own. → crates/futo-notes-editor/src/engine/commands/moves.rs `block_lines`
- A line of a closed code block lifts the whole block, fences included, and a line of a table lifts the whole table. → crates/futo-notes-editor/src/engine/commands/moves.rs `block_lines`
- A blank line, front matter, and a code block nothing closes (code to the note's end) lift nothing. → crates/futo-notes-editor/src/engine/commands/moves.rs `block_lines`

## Where it lands

- A block may land on any boundary between lines, the top and end of the note included, except its own two edges and the boundaries inside it. → crates/futo-notes-editor/src/engine/commands/moves.rs `block_slots`
- Nothing lands above or inside front matter, or inside a code block (after code nothing closes too), a table or a run of quote lines. → crates/futo-notes-editor/src/engine/commands/moves.rs `inside_unit`
- Strictly between two lines of a list (consecutive list items and the lines under them, with no blank line between) only a list item or a single plain line lands. → crates/futo-notes-editor/src/engine/commands/moves.rs `block_slots`

## The move

- A move reorders whole lines. No other byte changes, with one exception: the note's last line has no line ending, so a block moving to or from the last line trades endings with the line that becomes last (`a\nb\nc` with `a` moved to the end gives `b\nc\na`; `a\r\nb` gives `b\r\na`). Blank lines are never added, removed or lifted. → crates/futo-notes-editor/src/engine/commands/moves.rs `move_command`, crates/futo-notes-editor/src/engine/tests/moves.rs
- A block arriving in a list keeps its bytes as written: no indent, marker, checkbox or number is rewritten. → crates/futo-notes-editor/src/engine/tests/moves.rs
- The move is one host acceptance and one Undo step that restores the exact bytes and selection. A caret or selection in the moved block moves with its text; one elsewhere stays with its line. Reading and display afterwards equal a fresh open of the same bytes. → crates/futo-notes-editor/src/engine/tests/moves.rs
- A move is cancelled, with no edit and no Undo step, when any line (the moved ones, the ones it passes, or a neighbor) would read as another kind of block afterwards: a plain `|---|` dropped under a pipe line, a list ending in unclosed code passing a line. A line that lifts nothing, or a boundary that is not one of the block's, is also refused with nothing changed; a stale revision is rejected, and marked text refuses the move (`CompositionActive`). → crates/futo-notes-editor/src/engine/command/mod.rs `Command::same_kind`, crates/futo-notes-editor/src/engine/tests/moves.rs
- Hosts address blocks in display coordinates: `block_at` gives the display extent the line at an offset lifts, `block_slots` each landing boundary as the display offset of the line start below it (or the display's end), and `move_block` moves the block to one of them. Native sessions take display bytes. _(native shells)_ → crates/futo-notes-ffi/src/editor/moves.rs, crates/futo-notes-ffi/tests/editor_block_move.rs
- *(iOS)* Puppet's `MoveBlock {line, before | after}` moves the block a display line lifts to the boundary above `before` or below `after` through the same session calls; a boundary that is not a slot, or a refused move, answers 409. There is no drag gesture yet. → apps/ios/Sources/App/PuppetNative/PuppetNativeVerbs+MoveBlock.swift, apps/ios/Sources/Editor/TextFirst/TextFirstEditorController+BlockMove.swift
