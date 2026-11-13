use super::*;
use futo_notes_editor::{BlockCommand, DisplayUtf16Offset, DisplayUtf16Range};
fn range(a: usize, b: usize) -> DisplayUtf16Range {
    DisplayUtf16Range {
        start: DisplayUtf16Offset(a),
        end: DisplayUtf16Offset(b),
    }
}
#[test]
fn block_commands_edit_in_memory_and_stop_at_the_terminal_fence() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "body", "ab").unwrap();
    let mut editor = store.open_editor("body").unwrap();
    editor
        .replace_utf16(Revision(0), range(2, 2), &[33])
        .unwrap();
    assert_eq!(editor.source_text(), "ab!");
    editor
        .block_command_utf16(Revision(1), range(0, 0), BlockCommand::Heading(3))
        .unwrap()
        .unwrap();
    assert_eq!(editor.source_text(), "### ab!");
    store.delete("body").unwrap();
    store.create("", "body", "fresh").unwrap();
    assert!(matches!(
        editor.block_command_utf16(editor.revision(), range(0, 0), BlockCommand::Divider),
        Err(EditorStoreError::SessionDeleted)
    ));
    assert_eq!(store.read("body").unwrap(), "fresh");
}
