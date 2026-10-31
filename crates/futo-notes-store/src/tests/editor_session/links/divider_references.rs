//! Actual-parent definition repair is protected by the one real Store append.
use super::*;
use futo_notes_editor::{BlockCommand, DisplayUtf16Offset, DisplayUtf16Range};

#[test]
fn exposed_literal_definition_repair_rejects_atomically_and_recovers_exact_semantics() {
    let original = "prefix [id]: /target 'T'\n\n[one][id]";
    let changed = "prefix \n***\n\n\\[id]: /target 'T'\n\n[one][id]";
    let shown = "prefix \n\u{fffc}\n\n[id]: /target 'T'\n\n[one][id]";
    for fault in [storage::Fault::Append, storage::Fault::ShortWrite] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "divider-definition", original).unwrap();
        let disk = Arc::new(Mutex::new(storage::Disk::default()));
        let mut editor = store
            .open_editor_with_recovery("divider-definition", storage::options(&disk))
            .unwrap();
        editor
            .select_with_affinity(
                Revision(0),
                range(2, 2),
                futo_notes_editor::Affinity::Forward,
            )
            .unwrap();
        let before = editor
            .project(Revision(0), range(0, original.len()))
            .unwrap();
        let command_range = DisplayUtf16Range {
            start: DisplayUtf16Offset(7),
            end: DisplayUtf16Offset(7),
        };
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.block_command_utf16(Revision(0), command_range, BlockCommand::Divider),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), original);
        assert_eq!(editor.display_text(), original);
        assert_eq!(editor.revision(), Revision(0));
        assert_eq!(editor.selection(), range(2, 2));
        assert_eq!(
            editor
                .project(Revision(0), range(0, original.len()))
                .unwrap(),
            before
        );
        assert_eq!(store.read("divider-definition").unwrap(), original);
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor
            .block_command_utf16(Revision(0), command_range, BlockCommand::Divider)
            .unwrap()
            .unwrap();
        assert_eq!(editor.source_text(), changed);
        assert_eq!(editor.display_text(), shown);
        assert_eq!(editor.selection(), range(12, 12));
        let after = editor.project(Revision(1), range(0, shown.len())).unwrap();
        assert!(after.links.is_empty());
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.undo(Revision(1)),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), changed);
        assert_eq!(
            editor.project(Revision(1), range(0, shown.len())).unwrap(),
            after
        );
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor.undo(Revision(1)).unwrap().unwrap();
        assert_eq!(editor.source_text(), original);
        assert_eq!(editor.selection(), range(2, 2));
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.redo(Revision(2)),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), original);
        assert!(editor
            .project(Revision(2), range(0, original.len()))
            .unwrap()
            .links
            .is_empty());
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor.redo(Revision(2)).unwrap().unwrap();
        assert_eq!(editor.source_text(), changed);
        editor.flush_recovery().unwrap();
        drop(editor);
        let mut recovered = store
            .open_editor_with_recovery("divider-definition", storage::options(&disk))
            .unwrap();
        assert_eq!(recovered.source_text(), changed);
        assert_eq!(recovered.display_text(), shown);
        assert!(recovered
            .project(recovered.revision(), range(0, shown.len()))
            .unwrap()
            .links
            .is_empty());
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("divider-definition").unwrap(), changed);
    }
}
