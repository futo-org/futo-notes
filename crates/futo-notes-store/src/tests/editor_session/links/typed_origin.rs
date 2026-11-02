//! Real recovery acceptance owns every transient typing-origin transition.
use super::*;

#[test]
fn failed_first_www_eligibility_keeps_prefix_history_and_retries_the_same_input() {
    for fault in [storage::Fault::Append, storage::Fault::ShortWrite] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "typed-origin", "").unwrap();
        let disk = Arc::new(Mutex::new(storage::Disk::default()));
        let mut editor = store
            .open_editor_with_recovery("typed-origin", storage::options(&disk))
            .unwrap();
        editor.replace(Revision(0), range(0, 0), "<www.").unwrap();
        let before = editor.project(Revision(1), range(0, 5)).unwrap();
        let selected = editor.selection();
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.replace(Revision(1), range(5, 5), "x.test/path"),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), "<www.");
        assert_eq!(editor.revision(), Revision(1));
        assert_eq!(editor.selection(), selected);
        assert_eq!(editor.project(Revision(1), range(0, 5)).unwrap(), before);
        assert_eq!(store.read("typed-origin").unwrap(), "");
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        // A rejected eligibility step never entered history. Its exact Prefix
        // snapshot is restored by real Undo/Redo before the same-intent retry.
        editor.undo(Revision(1)).unwrap().unwrap();
        assert_eq!(editor.source_text(), "");
        editor.redo(Revision(2)).unwrap().unwrap();
        assert_eq!(editor.source_text(), "<www.");
        editor
            .replace(Revision(3), range(5, 5), "x.test/path")
            .unwrap();
        assert_eq!(editor.source_text(), "<www.x.test/path");
        assert!(editor
            .project(Revision(4), range(0, 16))
            .unwrap()
            .links
            .is_empty());
        editor.replace(Revision(4), range(16, 16), ">").unwrap();
        assert!(editor
            .project(Revision(5), range(0, 17))
            .unwrap()
            .links
            .is_empty());
        editor
            .select_with_affinity(
                Revision(5),
                range(0, 0),
                futo_notes_editor::Affinity::Forward,
            )
            .unwrap();
        editor
            .select_with_affinity(
                Revision(5),
                range(17, 17),
                futo_notes_editor::Affinity::Forward,
            )
            .unwrap();
        editor.replace(Revision(5), range(17, 17), " ").unwrap();
        let active = editor.project(Revision(6), range(0, 18)).unwrap();
        assert_eq!(active.text, "<www.x.test/path> ");
        assert_eq!(active.links.len(), 1);
        assert_eq!(active.links[0].destination, "http://www.x.test/path");
        assert_eq!(active.links[0].range, range(1, 16));
    }
}

#[test]
fn failed_www_closer_and_history_retain_the_exact_origin_pending_handoff() {
    for fault in [storage::Fault::Append, storage::Fault::ShortWrite] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "typed-close", "").unwrap();
        let disk = Arc::new(Mutex::new(storage::Disk::default()));
        let mut editor = store
            .open_editor_with_recovery("typed-close", storage::options(&disk))
            .unwrap();
        editor
            .replace(Revision(0), range(0, 0), "<www.x.test/path")
            .unwrap();
        let opening = editor.source_text();
        let before = editor.project(Revision(1), range(0, 16)).unwrap();
        let selection = editor.selection();
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.replace(Revision(1), range(16, 16), ">"),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), opening);
        assert_eq!(editor.revision(), Revision(1));
        assert_eq!(editor.selection(), selection);
        assert_eq!(editor.project(Revision(1), range(0, 16)).unwrap(), before);
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor.replace(Revision(1), range(16, 16), ">").unwrap();
        let closed = editor.source_text();
        let pending = editor.project(Revision(2), range(0, 17)).unwrap();
        assert!(pending.links.is_empty());
        let loaded = futo_notes_editor::EditorSession::open(&closed);
        assert_eq!(
            loaded
                .inspect_link(Revision(0), range(1, 2))
                .unwrap()
                .unwrap()
                .destination,
            "http://www.x.test/path"
        );
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.undo(Revision(2)),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), closed);
        assert_eq!(editor.revision(), Revision(2));
        assert_eq!(editor.project(Revision(2), range(0, 17)).unwrap(), pending);
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor.undo(Revision(2)).unwrap().unwrap();
        assert_eq!(editor.source_text(), opening);
        let restored = editor.project(Revision(3), range(0, 16)).unwrap();
        assert!(restored.links.is_empty());
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            editor.redo(Revision(3)),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(editor.source_text(), opening);
        assert_eq!(editor.revision(), Revision(3));
        assert_eq!(editor.project(Revision(3), range(0, 16)).unwrap(), restored);
        disk.lock().unwrap().fault = None;
        editor.resume_recovery().unwrap();
        editor.redo(Revision(3)).unwrap().unwrap();
        assert_eq!(editor.source_text(), closed);
        editor.replace(Revision(4), range(17, 17), " ").unwrap();
        assert_eq!(
            editor
                .inspect_link(Revision(5), range(1, 2))
                .unwrap()
                .unwrap()
                .destination,
            "http://www.x.test/path"
        );
        editor.undo(Revision(5)).unwrap().unwrap();
        assert_eq!(editor.source_text(), closed);
        assert!(editor
            .project(Revision(6), range(0, 17))
            .unwrap()
            .links
            .is_empty());
        editor.flush_recovery().unwrap();
        drop(editor);
        let recovered = store
            .open_editor_with_recovery("typed-close", storage::options(&disk))
            .unwrap();
        assert_eq!(recovered.source_text(), closed);
        // The canonical closed spelling survives, while live pending intent
        // does not cross the raw-source recovery boundary.
        assert_eq!(
            recovered
                .inspect_link(recovered.revision(), range(1, 2))
                .unwrap()
                .unwrap()
                .destination,
            "http://www.x.test/path"
        );
    }
}

#[test]
fn recovery_of_an_unfinished_www_word_does_not_restore_its_typing_origin() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "typed-recover", "").unwrap();
    let disk = Arc::new(Mutex::new(storage::Disk::default()));
    let mut editor = store
        .open_editor_with_recovery("typed-recover", storage::options(&disk))
        .unwrap();
    for ch in "<www.x.test/path".chars() {
        let at = editor.display_text().len();
        editor
            .replace(editor.revision(), range(at, at), &ch.to_string())
            .unwrap();
    }
    editor.flush_recovery().unwrap();
    drop(editor);
    let mut recovered = store
        .open_editor_with_recovery("typed-recover", storage::options(&disk))
        .unwrap();
    assert_eq!(recovered.source_text(), "<www.x.test/path");
    recovered
        .replace(recovered.revision(), range(16, 16), ">")
        .unwrap();
    recovered
        .replace(recovered.revision(), range(17, 17), " ")
        .unwrap();
    assert_eq!(recovered.display_text(), "<www.x.test/path> ");
    assert!(recovered
        .project(recovered.revision(), range(0, 18))
        .unwrap()
        .links
        .is_empty());
}
