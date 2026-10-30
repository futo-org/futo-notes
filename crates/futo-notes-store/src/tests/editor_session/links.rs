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
