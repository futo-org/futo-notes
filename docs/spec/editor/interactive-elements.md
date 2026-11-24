## Interactive elements

The desktop editor's checkboxes, tables, lists, undo, typed Markdown, selection toolbar and `/` menu
are specified under [desktop](desktop/blocks.md) ([tables](desktop/tables.md),
[toolbar](desktop/toolbar.md), [the `/` menu](desktop/slash-menu.md), [links](desktop/links.md),
[paired typing](desktop/paired-typing.md), [outside changes](desktop/outside-changes.md)); native
mobile's under [mobile](mobile.md). The rules both share (list keys, the checkbox toggle, table
keys and paste, undo, typed line starts) are the engine's, under [portable-core](portable-core.md)
([lists](portable-core/lists.md), [tables](portable-core/tables.md),
[clipboard](portable-core/clipboard.md), [input](portable-core/interpretation-and-input.md)).

- The portable core prepares link, formatting and structural changes before one accepted edit, including pending marked text and exact source/selection history; [its link contract](portable-core/links.md) distinguishes in-session input lifetimes from saved source. → crates/futo-notes-editor/src/engine/command/run.rs `run`, crates/futo-notes-editor/src/engine/edit/compose.rs
- _(Android text-first editor)_ The note body and the table-cell field are never autofill targets: their text-selection menu offers no system "Autofill" item, so nothing covers Paste or Select all. → apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstEditText.kt, apps/android/app/src/main/java/com/futo/notes/textfirst/TableCellEditText.kt
