//! Final physical Code-word split validation remains before durable acceptance.
use super::*;
use futo_notes_editor::{
    Affinity, BlockCommand, DisplayUtf16Offset, DisplayUtf16Range, InlineFormat,
};

#[test]
fn a_partial_guarded_code_split_rejects_before_store_acceptance_and_recovers_exact_source() {
    let shown = "pre <https://x.test/p\n\u{fffc}\n\nath>";
    let expected = "pre <https\\://x.test`/p`\n***\n\n`ath`>";
    for fault in [storage::Fault::Append, storage::Fault::ShortWrite] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "split-code", "pre ").unwrap();
        let disk = Arc::new(Mutex::new(storage::Disk::default()));
        let mut editor = store
            .open_editor_with_recovery("split-code", storage::options(&disk))
            .unwrap();
        editor
            .replace(Revision(0), range(4, 4), "<https://x.test/path")
            .unwrap();
        editor.replace(Revision(1), range(24, 24), ">").unwrap();
        editor
            .select_with_affinity(Revision(2), range(19, 24), Affinity::Backward)
            .unwrap();
        editor
            .toggle_format(Revision(2), InlineFormat::Code)
            .unwrap()
            .unwrap();
        let guarded = editor.source_text();
        let before = editor.project(Revision(3), range(0, 25)).unwrap();
        let formats = editor.active_formats();
        let cut = DisplayUtf16Range {
            start: DisplayUtf16Offset(21),
            end: DisplayUtf16Offset(21),
        };
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.block_command_utf16(Revision(3), cut, BlockCommand::Divider),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.revision(), Revision(3));
        assert_eq!(editor.source_text(), guarded);
        assert_eq!(editor.selection(), range(19, 24));
        assert_eq!(editor.active_formats(), formats);
        assert_eq!(editor.project(Revision(3), range(0, 25)).unwrap(), before);
        assert_eq!(store.read("split-code").unwrap(), "pre ");
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor
            .block_command_utf16(Revision(3), cut, BlockCommand::Divider)
            .unwrap()
            .unwrap();
        assert_eq!(editor.source_text(), expected);
        assert_eq!(editor.display_text(), shown);
        let after = editor.project(Revision(4), range(0, shown.len())).unwrap();
        assert!(after.links.is_empty());
        assert_eq!(editor.selection(), range(26, 26));
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.undo(Revision(4)),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), expected);
        assert_eq!(
            editor.project(Revision(4), range(0, shown.len())).unwrap(),
            after
        );
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor.undo(Revision(4)).unwrap().unwrap();
        assert_eq!(editor.source_text(), guarded);
        assert_eq!(editor.selection(), range(19, 24));
        assert_eq!(editor.active_formats(), formats);
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.redo(Revision(5)),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), guarded);
        assert_eq!(
            editor.project(Revision(5), range(0, 25)).unwrap().runs,
            before.runs
        );
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor.redo(Revision(5)).unwrap().unwrap();
        assert_eq!(editor.source_text(), expected);
        editor.flush_recovery().unwrap();
        drop(editor);
        let mut recovered = store
            .open_editor_with_recovery("split-code", storage::options(&disk))
            .unwrap();
        assert_eq!(recovered.source_text(), expected);
        assert_eq!(recovered.display_text(), shown);
        let reopened = recovered
            .project(recovered.revision(), range(0, shown.len()))
            .unwrap();
        assert_eq!(reopened.runs, after.runs);
        assert!(reopened.links.is_empty());
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("split-code").unwrap(), expected);
    }
}
