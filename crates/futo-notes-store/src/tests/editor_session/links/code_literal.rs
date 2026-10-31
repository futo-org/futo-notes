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
        editor
            .select_with_affinity(
                Revision(2),
                range(15, 20),
                futo_notes_editor::Affinity::Backward,
            )
            .unwrap();
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
        editor
            .select_with_affinity(
                Revision(4),
                range(21, 21),
                futo_notes_editor::Affinity::Forward,
            )
            .unwrap();
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

#[test]
fn divider_scalar_transport_rejects_atomically_and_recovery_never_persists_live_ownership() {
    use futo_notes_editor::{BlockCommand, DisplayUtf16Offset, DisplayUtf16Range};
    for fault in [storage::Fault::Append, storage::Fault::ShortWrite] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "divider-literal", "pre ").unwrap();
        let disk = Arc::new(Mutex::new(storage::Disk::default()));
        let mut editor = store
            .open_editor_with_recovery("divider-literal", storage::options(&disk))
            .unwrap();
        editor
            .replace(Revision(0), range(4, 4), "<https://x.test/path")
            .unwrap();
        editor.replace(Revision(1), range(24, 24), ">").unwrap();
        editor
            .select_with_affinity(
                Revision(2),
                range(19, 24),
                futo_notes_editor::Affinity::Backward,
            )
            .unwrap();
        editor
            .toggle_format(Revision(2), InlineFormat::Code)
            .unwrap()
            .unwrap();
        let guarded = editor.source_text();
        let before = editor.project(Revision(3), range(0, 25)).unwrap();
        let formats = editor.active_formats();
        let at = DisplayUtf16Range {
            start: DisplayUtf16Offset(4),
            end: DisplayUtf16Offset(4),
        };
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.block_command_utf16(Revision(3), at, BlockCommand::Divider),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), guarded);
        assert_eq!(editor.revision(), Revision(3));
        assert_eq!(editor.selection(), range(19, 24));
        assert_eq!(editor.active_formats(), formats);
        assert_eq!(editor.project(Revision(3), range(0, 25)).unwrap(), before);
        assert_eq!(store.read("divider-literal").unwrap(), "pre ");
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor
            .block_command_utf16(Revision(3), at, BlockCommand::Divider)
            .unwrap()
            .unwrap();
        let divided = editor.source_text();
        assert_eq!(
            editor.display_text(),
            "pre \n\u{fffc}\n\n<https://x.test/path>"
        );
        editor
            .select_with_affinity(
                Revision(4),
                range(25, 30),
                futo_notes_editor::Affinity::Backward,
            )
            .unwrap();
        editor
            .toggle_format(Revision(4), InlineFormat::Code)
            .unwrap()
            .unwrap();
        let released = editor.source_text();
        editor
            .select_with_affinity(
                Revision(5),
                range(31, 31),
                futo_notes_editor::Affinity::Forward,
            )
            .unwrap();
        editor.replace(Revision(5), range(31, 31), " ").unwrap();
        let linked = editor.source_text();
        let active = editor.project(Revision(6), range(0, 32)).unwrap();
        assert_eq!(active.links.len(), 1);
        assert_eq!(active.links[0].range, range(11, 30));
        assert_eq!(active.links[0].destination, "https://x.test/path");
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.undo(Revision(6)),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), linked);
        assert_eq!(editor.project(Revision(6), range(0, 32)).unwrap(), active);
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor.undo(Revision(6)).unwrap().unwrap();
        assert_eq!(editor.source_text(), released);
        assert!(editor
            .project(Revision(7), range(0, 31))
            .unwrap()
            .links
            .is_empty());
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.redo(Revision(7)),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), released);
        assert!(editor
            .project(Revision(7), range(0, 31))
            .unwrap()
            .links
            .is_empty());
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor.redo(Revision(7)).unwrap().unwrap();
        assert_eq!(editor.source_text(), linked);
        editor.undo(Revision(8)).unwrap().unwrap();
        editor.undo(Revision(9)).unwrap().unwrap();
        assert_eq!(editor.source_text(), divided);
        editor.undo(Revision(10)).unwrap().unwrap();
        assert_eq!(editor.source_text(), guarded);
        editor.redo(Revision(11)).unwrap().unwrap();
        assert_eq!(editor.source_text(), divided);
        editor.flush_recovery().unwrap();
        drop(editor);
        let mut recovered = store
            .open_editor_with_recovery("divider-literal", storage::options(&disk))
            .unwrap();
        assert_eq!(recovered.source_text(), divided);
        recovered
            .select_with_affinity(
                recovered.revision(),
                range(25, 30),
                futo_notes_editor::Affinity::Backward,
            )
            .unwrap();
        recovered
            .toggle_format(recovered.revision(), InlineFormat::Code)
            .unwrap()
            .unwrap();
        recovered
            .select_with_affinity(
                recovered.revision(),
                range(31, 31),
                futo_notes_editor::Affinity::Forward,
            )
            .unwrap();
        recovered
            .replace(recovered.revision(), range(31, 31), " ")
            .unwrap();
        assert!(recovered
            .project(recovered.revision(), range(0, 32))
            .unwrap()
            .links
            .is_empty());
        let literal = recovered.source_text();
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("divider-literal").unwrap(), literal);
    }
}

#[test]
fn failed_last_code_body_deletion_preserves_the_old_owner_and_retries_a_fresh_uri_payload() {
    for fault in [storage::Fault::Append, storage::Fault::ShortWrite] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "code-delete", "").unwrap();
        let disk = Arc::new(Mutex::new(storage::Disk::default()));
        let mut editor = store
            .open_editor_with_recovery("code-delete", storage::options(&disk))
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
        let selected = editor.selection();
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.replace_action(
                Revision(3),
                range(15, 20),
                "",
                futo_notes_editor::InputAction::Isolated
            ),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), guarded);
        assert_eq!(editor.revision(), Revision(3));
        assert_eq!(editor.selection(), selected);
        assert_eq!(editor.project(Revision(3), range(0, 21)).unwrap(), before);
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor
            .replace_action(
                Revision(3),
                range(15, 20),
                "",
                futo_notes_editor::InputAction::Isolated,
            )
            .unwrap();
        let deleted = editor.source_text();
        let literal = editor.project(Revision(4), range(0, 16)).unwrap();
        assert_eq!(literal.text, "<https://x.test>");
        assert!(literal.links.is_empty());
        assert!(literal
            .runs
            .iter()
            .all(|run| !run.formats.contains(&InlineFormat::Code)));
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.undo(Revision(4)),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), deleted);
        assert_eq!(editor.project(Revision(4), range(0, 16)).unwrap(), literal);
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor.undo(Revision(4)).unwrap().unwrap();
        assert_eq!(editor.source_text(), guarded);
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.redo(Revision(5)),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), guarded);
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor.redo(Revision(5)).unwrap().unwrap();
        assert_eq!(editor.source_text(), deleted);
        editor.select(Revision(6), range(16, 16)).unwrap();
        editor.replace(Revision(6), range(16, 16), " ").unwrap();
        let active = editor
            .inspect_link(Revision(7), range(1, 2))
            .unwrap()
            .unwrap();
        assert_eq!(active.destination, "https://x.test");
        assert_eq!(active.range, range(1, 15));
        editor.undo(Revision(7)).unwrap().unwrap();
        assert_eq!(editor.source_text(), deleted);
        editor.flush_recovery().unwrap();
        drop(editor);
        let mut recovered = store
            .open_editor_with_recovery("code-delete", storage::options(&disk))
            .unwrap();
        assert_eq!(recovered.source_text(), deleted);
        recovered
            .replace(recovered.revision(), range(16, 16), " ")
            .unwrap();
        assert!(recovered
            .project(recovered.revision(), range(0, 17))
            .unwrap()
            .links
            .is_empty());
    }
}
