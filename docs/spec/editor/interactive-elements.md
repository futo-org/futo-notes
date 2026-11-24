## Interactive elements

The desktop editor's checkboxes, tables, lists, undo, typed Markdown, selection toolbar and `/` menu
are specified under [desktop](desktop/blocks.md) ([tables](desktop/tables.md),
[toolbar](desktop/toolbar.md), [the `/` menu](desktop/slash-menu.md), [links](desktop/links.md),
[paired typing](desktop/paired-typing.md), [outside changes](desktop/outside-changes.md)); native
mobile's under [mobile](mobile.md).

- The portable replacement core prepares link, formatting and structural changes before one accepted edit, including pending marked text and exact source/selection history; [its link contract](portable-core/links.md) distinguishes in-session input lifetimes from saved source. Shipping renderer interactions above remain in use until cutover. → crates/futo-notes-editor/src/engine/command/run.rs `run`, crates/futo-notes-editor/src/engine/edit/compose.rs
- *(Android text-first editor)* The note body and the table-cell field are never autofill targets: their text-selection menu offers no system "Autofill" item, so nothing covers Paste or Select all. → apps/android/app/src/main/java/com/futo/notes/textfirst/TextFirstEditText.kt, apps/android/app/src/main/java/com/futo/notes/textfirst/TableCellEditText.kt
