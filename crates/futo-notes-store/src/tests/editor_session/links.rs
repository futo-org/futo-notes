use super::*;

#[test]
fn failed_link_acceptance_keeps_draft_selection_history_and_retry_recovery_exact() {
    for fault in [storage::Fault::Append, storage::Fault::ShortWrite] {
        let root = TestRoot::new();
        let store = store(&root);
        let original = "[teh __docs__](https://old.test 'Title')\r\n";
        store.create("", "links", original).unwrap();
        let disk = Arc::new(Mutex::new(storage::Disk::default()));
        let mut session = store
            .open_editor_with_recovery("links", storage::options(&disk))
            .unwrap();
        session.replace(Revision(0), range(0, 3), "the").unwrap();
        session
            .select_with_affinity(
                Revision(1),
                range(1, 2),
                futo_notes_editor::Affinity::Forward,
            )
            .unwrap();
        let before = session.project(Revision(1), range(0, 10)).unwrap();
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            session.set_link(Revision(1), range(1, 2), "https://x.test"),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(
            session.source_text(),
            "[the __docs__](https://old.test 'Title')\r\n"
        );
        assert_eq!(session.selection(), range(1, 2));
        assert_eq!(session.project(Revision(1), range(0, 10)).unwrap(), before);
        assert!(session.recovery_status().paused);
        disk.lock().unwrap().fault = None;
        session.resume_recovery().unwrap();
        session
            .set_link(Revision(1), range(1, 2), "https://x.test")
            .unwrap()
            .unwrap();
        let updated = "[the __docs__](https://x.test 'Title')\r\n";
        assert_eq!(session.source_text(), updated);
        session.undo(Revision(2)).unwrap().unwrap();
        assert_eq!(
            session.source_text(),
            "[the __docs__](https://old.test 'Title')\r\n"
        );
        session.redo(Revision(3)).unwrap().unwrap();
        session.flush_recovery().unwrap();
        drop(session);
        let mut recovered = store
            .open_editor_with_recovery("links", storage::options(&disk))
            .unwrap();
        assert_eq!(recovered.source_text(), updated);
        assert_eq!(recovered.display_text(), "the docs\r\n");
        assert_eq!(
            recovered
                .inspect_link(Revision(4), range(1, 2))
                .unwrap()
                .unwrap()
                .destination,
            "https://x.test"
        );
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("links").unwrap(), updated);
    }
}

#[test]
fn last_reference_use_visibility_and_selection_survive_rejected_append_retry_and_recovery() {
    for fault in [storage::Fault::Append, storage::Fault::ShortWrite] {
        let root = TestRoot::new();
        let store = store(&root);
        let original = "[id]: <https://x.test> 'T'\n\nmiddle\n\n[one][id] end";
        let unlinked = "[id]: <https://x.test> 'T'\n\nmiddle\n\none end";
        store.create("", "references", original).unwrap();
        let disk = Arc::new(Mutex::new(storage::Disk::default()));
        let mut session = store
            .open_editor_with_recovery("references", storage::options(&disk))
            .unwrap();
        session
            .select_with_affinity(
                Revision(0),
                range(9, 10),
                futo_notes_editor::Affinity::Forward,
            )
            .unwrap();
        let before = session.project(Revision(0), range(0, 15)).unwrap();
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            session.set_link(Revision(0), range(9, 10), ""),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(session.source_text(), original);
        assert_eq!(session.display_text(), "middle\n\none end");
        assert_eq!(session.selection(), range(9, 10));
        assert_eq!(session.project(Revision(0), range(0, 15)).unwrap(), before);
        assert_eq!(
            session
                .inspect_link(Revision(0), range(8, 11))
                .unwrap()
                .unwrap()
                .destination,
            "https://x.test"
        );
        disk.lock().unwrap().fault = None;
        session.resume_recovery().unwrap();
        session
            .set_link(Revision(0), range(9, 10), "")
            .unwrap()
            .unwrap();
        assert_eq!(session.source_text(), unlinked);
        assert_eq!(session.display_text(), unlinked);
        assert_eq!(session.selection(), range(37, 38));
        session.undo(Revision(1)).unwrap().unwrap();
        assert_eq!(session.source_text(), original);
        assert_eq!(session.display_text(), "middle\n\none end");
        assert_eq!(session.selection(), range(9, 10));
        session.redo(Revision(2)).unwrap().unwrap();
        session.flush_recovery().unwrap();
        drop(session);
        let mut recovered = store
            .open_editor_with_recovery("references", storage::options(&disk))
            .unwrap();
        assert_eq!(recovered.source_text(), unlinked);
        assert_eq!(recovered.display_text(), unlinked);
        assert!(recovered
            .inspect_link(Revision(3), range(36, 39))
            .unwrap()
            .is_none());
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("references").unwrap(), unlinked);
    }
}

#[test]
fn nested_reference_composition_and_source_anchored_history_survive_append_and_history_faults() {
    for fault in [storage::Fault::Append, storage::Fault::ShortWrite] {
        let root = TestRoot::new();
        let store = store(&root);
        let original = "[id]: /target 'T'\n\npreamble\n\nbuffer\n\n[one][id]\n\nbody\n\ntail";
        let committed = "[id]: /target 'T'\n\npreamble\n\nbuffer\n\n\n\nbody\n\ntail";
        let changed = "[id]: /target 'T'\n\npreamble\n\nbuffer\n\n\n\nBODY\n\ntail";
        store.create("", "nested-references", original).unwrap();
        let disk = Arc::new(Mutex::new(storage::Disk::default()));
        let mut session = store
            .open_editor_with_recovery("nested-references", storage::options(&disk))
            .unwrap();
        session
            .select_with_affinity(
                Revision(0),
                range(18, 21),
                futo_notes_editor::Affinity::Backward,
            )
            .unwrap();
        let marked = session.compose(Revision(0), range(18, 21), "").unwrap();
        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            session.replace(Revision(0), range(20, 24), "BODY"),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(session.source_text(), original);
        assert_eq!(session.selection(), range(18, 21));
        assert_eq!(session.composition(), Some(marked));
        disk.lock().unwrap().fault = None;
        session.resume_recovery().unwrap();
        session.replace(Revision(0), range(20, 24), "BODY").unwrap();
        assert_eq!(session.source_text(), changed);
        assert_eq!(session.display_text(), changed);
        assert_eq!(session.selection(), range(43, 43));
        assert!(session.composition().is_none());

        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            session.undo(Revision(1)),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(session.source_text(), changed);
        assert_eq!(session.selection(), range(43, 43));
        disk.lock().unwrap().fault = None;
        session.resume_recovery().unwrap();
        session.undo(Revision(1)).unwrap().unwrap();
        assert_eq!(session.source_text(), committed);
        assert_eq!(session.selection(), range(37, 37));

        disk.lock().unwrap().fault = Some(fault);
        assert!(matches!(
            session.redo(Revision(2)),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(session.source_text(), committed);
        assert_eq!(session.selection(), range(37, 37));
        disk.lock().unwrap().fault = None;
        session.resume_recovery().unwrap();
        session.redo(Revision(2)).unwrap().unwrap();
        assert_eq!(session.source_text(), changed);
        assert_eq!(session.selection(), range(43, 43));
        session.undo(Revision(3)).unwrap().unwrap();
        session.undo(Revision(4)).unwrap().unwrap();
        assert_eq!(session.source_text(), original);
        assert_eq!(session.selection(), range(18, 21));
        session.redo(Revision(5)).unwrap().unwrap();
        session.redo(Revision(6)).unwrap().unwrap();
        assert_eq!(session.source_text(), changed);
        assert_eq!(session.selection(), range(43, 43));
        session.flush_recovery().unwrap();
        drop(session);
        let mut recovered = store
            .open_editor_with_recovery("nested-references", storage::options(&disk))
            .unwrap();
        assert_eq!(recovered.source_text(), changed);
        assert_eq!(recovered.display_text(), changed);
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("nested-references").unwrap(), changed);
    }
}

mod derived;

mod angle_pending;

mod code_literal;

mod divider_references;

mod typed_origin;

mod literal_retirement;

mod partial_ending;
