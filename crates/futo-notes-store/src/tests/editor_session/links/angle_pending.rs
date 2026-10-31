use super::*;

#[test]
fn typed_angle_completion_rejects_before_acceptance_and_reopens_standard_clean_source() {
    for fault in [storage::Fault::Append, storage::Fault::ShortWrite] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "angle-pending", "").unwrap();
        let disk = Arc::new(Mutex::new(storage::Disk::default()));
        let mut editor = store
            .open_editor_with_recovery("angle-pending", storage::options(&disk))
            .unwrap();
        editor
            .replace(Revision(0), range(0, 0), "<https://x.test")
            .unwrap();
        let before_source = editor.source_text();
        let before = editor.project(editor.revision(), range(0, 15)).unwrap();
        let formats = editor.active_formats();
        assert!(before.links.is_empty());
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.replace(Revision(1), range(15, 15), ">"),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), before_source);
        assert_eq!(editor.display_text(), "<https://x.test");
        assert_eq!(editor.selection(), range(15, 15));
        assert_eq!(editor.revision(), Revision(1));
        assert_eq!(editor.active_formats(), formats);
        assert_eq!(editor.project(Revision(1), range(0, 15)).unwrap(), before);
        assert!(editor.composition().is_none());
        assert_eq!(store.read("angle-pending").unwrap(), "");
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor.replace(Revision(1), range(15, 15), ">").unwrap();
        assert_eq!(editor.source_text(), "<<https://x.test>>");
        assert_eq!(editor.display_text(), "<https://x.test>");
        assert_eq!(editor.selection(), range(16, 16));
        assert!(editor
            .inspect_link(Revision(2), range(1, 2))
            .unwrap()
            .is_none());
        editor
            .replace_action(
                Revision(2),
                range(16, 16),
                " ",
                futo_notes_editor::InputAction::Isolated,
            )
            .unwrap();
        assert_eq!(
            editor
                .inspect_link(Revision(3), range(1, 2))
                .unwrap()
                .unwrap()
                .destination,
            "https://x.test"
        );
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.undo(Revision(3)),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), "<<https://x.test>> ");
        assert!(editor
            .inspect_link(Revision(3), range(1, 2))
            .unwrap()
            .is_some());
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor.undo(Revision(3)).unwrap().unwrap();
        assert_eq!(editor.source_text(), "<<https://x.test>>");
        assert!(editor
            .inspect_link(Revision(4), range(1, 2))
            .unwrap()
            .is_none());
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.redo(Revision(4)),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), "<<https://x.test>>");
        assert!(editor
            .inspect_link(Revision(4), range(1, 2))
            .unwrap()
            .is_none());
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor.redo(Revision(4)).unwrap().unwrap();
        assert_eq!(editor.source_text(), "<<https://x.test>> ");
        editor.undo(Revision(5)).unwrap().unwrap();
        assert_eq!(editor.source_text(), "<<https://x.test>>");
        editor.flush_recovery().unwrap();
        drop(editor);
        let mut reopened = store
            .open_editor_with_recovery("angle-pending", storage::options(&disk))
            .unwrap();
        assert_eq!(reopened.source_text(), "<<https://x.test>>");
        assert_eq!(reopened.display_text(), "<https://x.test>");
        // Recovery restores standard source, not transient live timing ownership.
        let link = reopened
            .inspect_link(reopened.revision(), range(1, 2))
            .unwrap()
            .unwrap();
        assert_eq!(link.destination, "https://x.test");
        assert_eq!(link.range, range(1, 15));
        reopened.checkpoint().unwrap();
        assert_eq!(store.read("angle-pending").unwrap(), "<<https://x.test>>");
    }
}
