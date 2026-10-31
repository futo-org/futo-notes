//! Explicit empty carrier output stays atomic at real recovery acceptance.
use super::*;
use futo_notes_editor::{Affinity, InlineFormat, InputAction};

#[test]
fn literal_retirement_rejects_retries_and_restores_the_original_live_guard_in_history() {
    for fault in [storage::Fault::Append, storage::Fault::ShortWrite] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "literal-retire", "").unwrap();
        let disk = Arc::new(Mutex::new(storage::Disk::default()));
        let mut editor = store
            .open_editor_with_recovery("literal-retire", storage::options(&disk))
            .unwrap();
        editor
            .replace(Revision(0), range(0, 0), "<https://x.test/path")
            .unwrap();
        editor.replace(Revision(1), range(20, 20), ">").unwrap();
        editor
            .select_with_affinity(Revision(2), range(1, 20), Affinity::Backward)
            .unwrap();
        editor
            .toggle_format(Revision(2), InlineFormat::Code)
            .unwrap()
            .unwrap();
        let guarded = editor.source_text();
        let before = editor.project(Revision(3), range(0, 21)).unwrap();
        let selected = editor.selection();
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.replace_action(Revision(3), range(1, 20), "", InputAction::Isolated),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), guarded);
        assert_eq!(editor.revision(), Revision(3));
        assert_eq!(editor.selection(), selected);
        assert_eq!(editor.project(Revision(3), range(0, 21)).unwrap(), before);
        assert_eq!(store.read("literal-retire").unwrap(), "");
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor
            .replace_action(Revision(3), range(1, 20), "", InputAction::Isolated)
            .unwrap();
        assert_eq!(editor.source_text(), "<>");
        assert_eq!(editor.selection(), range(1, 1));
        let literal = editor.project(Revision(4), range(0, 2)).unwrap();
        assert_eq!(literal.text, "<>");
        assert!(literal.links.is_empty());
        assert!(literal.runs.iter().all(|run| run.formats.is_empty()));

        let literal_selection = editor.selection();
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.undo(Revision(4)),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), "<>");
        assert_eq!(editor.revision(), Revision(4));
        assert_eq!(editor.selection(), literal_selection);
        assert_eq!(editor.project(Revision(4), range(0, 2)).unwrap(), literal);
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor.undo(Revision(4)).unwrap().unwrap();
        assert_eq!(editor.source_text(), guarded);
        let restored = editor.project(Revision(5), range(0, 21)).unwrap();
        let restored_selection = editor.selection();
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.redo(Revision(5)),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), guarded);
        assert_eq!(editor.revision(), Revision(5));
        assert_eq!(editor.selection(), restored_selection);
        assert_eq!(editor.project(Revision(5), range(0, 21)).unwrap(), restored);
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor.redo(Revision(5)).unwrap().unwrap();
        assert_eq!(editor.source_text(), "<>");
        assert_eq!(editor.selection(), range(1, 1));

        // The actual accepted history restores live authority as well as bytes.
        editor.undo(Revision(6)).unwrap().unwrap();
        assert_eq!(editor.source_text(), guarded);
        editor
            .select_with_affinity(Revision(7), range(1, 20), Affinity::Backward)
            .unwrap();
        editor
            .toggle_format(Revision(7), InlineFormat::Code)
            .unwrap()
            .unwrap();
        editor
            .select_with_affinity(Revision(8), range(21, 21), Affinity::Forward)
            .unwrap();
        editor.replace(Revision(8), range(21, 21), " ").unwrap();
        assert_eq!(
            editor
                .inspect_link(Revision(9), range(1, 2))
                .unwrap()
                .unwrap()
                .destination,
            "https://x.test/path"
        );
        editor.undo(Revision(9)).unwrap().unwrap();
        editor.undo(Revision(10)).unwrap().unwrap();
        assert_eq!(editor.source_text(), guarded);
        editor
            .replace_action(Revision(11), range(1, 20), "", InputAction::Isolated)
            .unwrap();
        assert_eq!(editor.source_text(), "<>");
        editor.flush_recovery().unwrap();
        drop(editor);
        let mut recovered = store
            .open_editor_with_recovery("literal-retire", storage::options(&disk))
            .unwrap();
        assert_eq!(recovered.source_text(), "<>");
        let revision = recovered.revision();
        recovered.replace(revision, range(2, 2), " ").unwrap();
        let after = recovered
            .project(recovered.revision(), range(0, 3))
            .unwrap();
        assert_eq!(after.text, "<> ");
        assert!(after.links.is_empty());
        assert!(after.runs.iter().all(|run| run.formats.is_empty()));
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("literal-retire").unwrap(), "<> ");
    }
}
