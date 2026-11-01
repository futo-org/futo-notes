use super::*;
use futo_notes_editor::{BlockCommand, DisplayUtf16Offset, DisplayUtf16Range};
fn range(a: usize, b: usize) -> DisplayUtf16Range {
    DisplayUtf16Range {
        start: DisplayUtf16Offset(a),
        end: DisplayUtf16Offset(b),
    }
}
#[test]
fn block_commands_share_the_attachment_recovery_and_terminal_fences() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "body", "ab").unwrap();
    let disk = Arc::new(Mutex::new(storage::Disk::default()));
    let mut editor = store
        .open_editor_with_recovery("body", storage::options(&disk))
        .unwrap();
    editor
        .replace_utf16(Revision(0), range(2, 2), &[33])
        .unwrap();
    disk.lock().unwrap().fault = Some(storage::Fault::Append);
    assert!(matches!(
        editor.block_command_utf16(Revision(1), range(0, 0), BlockCommand::Heading(3)),
        Err(EditorStoreError::RecoveryAppend(_))
    ));
    assert_eq!(editor.source_text(), "ab!");
    assert!(matches!(
        editor.block_command_utf16(Revision(1), range(0, 0), BlockCommand::Divider),
        Err(EditorStoreError::RecoveryPaused)
    ));
    disk.lock().unwrap().fault = None;
    editor.resume_recovery().unwrap();
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
