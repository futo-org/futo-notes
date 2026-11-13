# Typed list markers

There are no list shortcuts. Typing writes exactly the typed characters (nothing is escaped or respelled because of what is typed), and a line is a list item when its text reads as one (linedown.md). Undo removes typed markers as it removes any typing. What each former shortcut became:

- Typing `- `, `* ` or `+ ` at a line's start makes a bullet because the line now reads as one; nothing else is written. → crates/futo-notes-editor/src/engine/edit/mod.rs, crates/futo-notes-editor/tests/fixtures/engine/lists/typed.json
- Typing digits then `. ` or `) ` at a line's start makes a numbered item with its number as typed, of any length (ten digits and leading zeros included). Typing never renumbers. → crates/futo-notes-editor/tests/fixtures/engine/lists/typed.json
- Typing `[ ] `, `[x] ` or `[X] ` after a bullet's marker makes a task. A numbered item has no box: `1. [ ] a` is a numbered item with the text `[ ] a`. → crates/futo-notes-editor/tests/fixtures/engine/lists/typed.json
- Typing a marker on the line under a plain line makes an item right there: no blank line is written above it. → crates/futo-notes-editor/tests/fixtures/engine/lists/typed.json
- Typing a marker into an empty item adds text to that item: `1. x` typed into `- ` gives `- 1. x`, a bullet with the text `1. x`. The toolbar's list buttons change an item's kind (lists.md). → crates/futo-notes-editor/tests/fixtures/engine/lists/typed.json
- Spaces or tabs typed before a marker stay: they are the item's indent. → crates/futo-notes-editor/src/lines/block.rs
