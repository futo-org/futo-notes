//! Live Code-literal provenance is transient across real recovery boundaries.
use super::*;
use futo_notes_editor::InlineFormat;

#[test]
fn code_literal_release_rejects_atomically_restores_history_and_reopens_without_live_ownership() {
    for fault in [storage::Fault::Append, storage::Fault::ShortWrite] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "code-literal", "").unwrap();
        let disk = Arc::new(Mutex::new(storage::Disk::default()));
        let mut editor = store
            .open_editor_with_recovery("code-literal", storage::options(&disk))
            .unwrap();
        editor
            .replace(Revision(0), range(0, 0), "<https://x.test/path")
            .unwrap();
        editor.replace(Revision(1), range(20, 20), ">").unwrap();
        editor.select(Revision(2), range(15, 20)).unwrap();
        editor
            .toggle_format(Revision(2), InlineFormat::Code)
            .unwrap()
            .unwrap();
        let guarded = editor.source_text();
        let before = editor.project(Revision(3), range(0, 21)).unwrap();
        let formats = editor.active_formats();
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.toggle_format(Revision(3), InlineFormat::Code),
            Err(EditorStoreError::Editor(
                futo_notes_editor::EditorError::Persistence(_)
            ))
        ));
        assert_eq!(editor.source_text(), guarded);
        assert_eq!(editor.revision(), Revision(3));
        assert_eq!(editor.selection(), range(15, 20));
        assert_eq!(editor.active_formats(), formats);
        assert_eq!(editor.project(Revision(3), range(0, 21)).unwrap(), before);
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor
            .toggle_format(Revision(3), InlineFormat::Code)
            .unwrap()
            .unwrap();
        let released = editor.source_text();
        editor.select(Revision(4), range(21, 21)).unwrap();
        let literal = editor.project(Revision(4), range(0, 21)).unwrap();
        assert!(literal.links.is_empty());
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.replace(Revision(4), range(21, 21), " "),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), released);
        assert_eq!(editor.revision(), Revision(4));
        assert_eq!(editor.selection(), range(21, 21));
        assert_eq!(editor.project(Revision(4), range(0, 21)).unwrap(), literal);
        assert_eq!(store.read("code-literal").unwrap(), "");
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor.replace(Revision(4), range(21, 21), " ").unwrap();
        let linked = editor.source_text();
        let active = editor.project(Revision(5), range(0, 22)).unwrap();
        assert_eq!(active.text, "<https://x.test/path> ");
        assert_eq!(active.links.len(), 1);
        assert_eq!(active.links[0].destination, "https://x.test/path");
        assert_eq!(active.links[0].range, range(1, 20));
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.undo(Revision(5)),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), linked);
        assert_eq!(editor.project(Revision(5), range(0, 22)).unwrap(), active);
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor.undo(Revision(5)).unwrap().unwrap();
        assert_eq!(editor.source_text(), released);
        assert!(editor
            .project(Revision(6), range(0, 21))
            .unwrap()
            .links
            .is_empty());
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.redo(Revision(6)),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), released);
        assert!(editor
            .project(Revision(6), range(0, 21))
            .unwrap()
            .links
            .is_empty());
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor.redo(Revision(6)).unwrap().unwrap();
        assert_eq!(editor.source_text(), linked);
        editor.undo(Revision(7)).unwrap().unwrap();
        editor.undo(Revision(8)).unwrap().unwrap();
        assert_eq!(editor.source_text(), guarded);
        editor.redo(Revision(9)).unwrap().unwrap();
        assert_eq!(editor.source_text(), released);
        assert!(editor
            .project(Revision(10), range(0, 21))
            .unwrap()
            .links
            .is_empty());
        // Redo restores the trusted scalar, so another actual word-end links.
        editor.replace(Revision(10), range(21, 21), " ").unwrap();
        assert_eq!(
            editor
                .inspect_link(Revision(11), range(1, 2))
                .unwrap()
                .unwrap()
                .destination,
            "https://x.test/path"
        );
        editor.undo(Revision(11)).unwrap().unwrap();
        assert_eq!(editor.source_text(), released);
        editor.flush_recovery().unwrap();
        drop(editor);
        let mut reopened = store
            .open_editor_with_recovery("code-literal", storage::options(&disk))
            .unwrap();
        assert_eq!(reopened.source_text(), released);
        assert_eq!(reopened.display_text(), "<https://x.test/path>");
        // Recovery owns standard Markdown, never the old live scalar witness.
        reopened
            .replace(reopened.revision(), range(21, 21), " ")
            .unwrap();
        assert!(reopened
            .project(reopened.revision(), range(0, 22))
            .unwrap()
            .links
            .is_empty());
        let literal_source = reopened.source_text();
        reopened.checkpoint().unwrap();
        assert_eq!(store.read("code-literal").unwrap(), literal_source);
    }
}
