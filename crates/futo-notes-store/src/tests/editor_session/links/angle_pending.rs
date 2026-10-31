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

#[test]
fn pending_angle_format_and_link_commands_reject_atomically_and_recover_canonical_source() {
    use futo_notes_editor::InlineFormat;
    for fault in [storage::Fault::Append, storage::Fault::ShortWrite] {
        for command in 0..3 {
            let root = TestRoot::new();
            let store = store(&root);
            store.create("", "angle-command", "").unwrap();
            let disk = Arc::new(Mutex::new(storage::Disk::default()));
            let mut editor = store
                .open_editor_with_recovery("angle-command", storage::options(&disk))
                .unwrap();
            editor
                .replace(Revision(0), range(0, 0), "<https://x.test")
                .unwrap();
            editor.replace(Revision(1), range(15, 15), ">").unwrap();
            let selected = if command == 1 {
                range(1, 15)
            } else {
                range(1, 4)
            };
            editor
                .select_with_affinity(Revision(2), selected, futo_notes_editor::Affinity::Backward)
                .unwrap();
            let before = editor.project(Revision(2), range(0, 16)).unwrap();
            let formats = editor.active_formats();
            let apply_command = |editor: &mut crate::StoreEditorSession<'_>| {
                let revision = editor.revision();
                match command {
                    0 => editor.toggle_format(revision, InlineFormat::Bold),
                    1 => editor.toggle_format(revision, InlineFormat::Code),
                    _ => editor.set_link(revision, selected, "https://new.test"),
                }
            };
            disk.lock().unwrap().fault = Some(fault);
            let failure = apply_command(&mut editor);
            // Preserve the existing public adapter distinction: formatting
            // wraps engine Persistence, while SetLink projects RecoveryAppend.
            let expected_error = if command < 2 {
                matches!(
                    &failure,
                    Err(EditorStoreError::Editor(
                        futo_notes_editor::EditorError::Persistence(_)
                    ))
                )
            } else {
                matches!(&failure, Err(EditorStoreError::RecoveryAppend(_)))
            };
            assert!(expected_error, "command={command}; failure={failure:?}");
            assert_eq!(editor.source_text(), "<<https://x.test>>");
            assert_eq!(editor.display_text(), "<https://x.test>");
            assert_eq!(editor.revision(), Revision(2));
            assert_eq!(editor.selection(), selected);
            assert_eq!(editor.active_formats(), formats);
            assert_eq!(editor.project(Revision(2), range(0, 16)).unwrap(), before);
            assert!(editor.composition().is_none());
            assert_eq!(store.read("angle-command").unwrap(), "");
            disk.lock().unwrap().fault = None;
            editor.resume_recovery().unwrap();
            apply_command(&mut editor).unwrap().unwrap();
            assert_eq!(editor.display_text(), "<https://x.test>");
            assert_eq!(editor.selection(), selected);
            let changed = editor.source_text();
            let after = editor.project(Revision(3), range(0, 16)).unwrap();
            if command == 2 {
                assert_eq!(after.links.len(), 1);
                assert_eq!(after.links[0].range, range(1, 4));
                assert_eq!(after.links[0].destination, "https://new.test");
            } else {
                assert!(after.links.is_empty());
                let expected = if command == 0 {
                    InlineFormat::Bold
                } else {
                    InlineFormat::Code
                };
                let spans: Vec<_> = after
                    .runs
                    .iter()
                    .filter(|run| run.formats.contains(&expected))
                    .map(|run| run.range)
                    .collect();
                assert_eq!(spans, vec![selected]);
            }
            disk.lock().unwrap().fault = Some(fault);
            assert!(matches!(
                editor.undo(Revision(3)),
                Err(EditorStoreError::RecoveryAppend(_))
            ));
            assert_eq!(editor.source_text(), changed);
            assert_eq!(editor.project(Revision(3), range(0, 16)).unwrap(), after);
            disk.lock().unwrap().fault = None;
            editor.resume_recovery().unwrap();
            let undone = editor.undo(Revision(3)).unwrap().unwrap();
            assert_eq!(undone.affinity, futo_notes_editor::Affinity::Backward);
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
            assert_eq!(editor.source_text(), changed);
            editor.flush_recovery().unwrap();
            drop(editor);
            let mut reopened = store
                .open_editor_with_recovery("angle-command", storage::options(&disk))
                .unwrap();
            assert_eq!(reopened.source_text(), changed);
            assert_eq!(reopened.display_text(), "<https://x.test>");
            let links = reopened
                .project(reopened.revision(), range(0, 16))
                .unwrap()
                .links;
            match command {
                0 => {
                    assert_eq!(links.len(), 1);
                    assert_eq!(links[0].destination, "https://x.test");
                }
                1 => assert!(links.is_empty()),
                _ => {
                    assert_eq!(links.len(), 1);
                    assert_eq!(links[0].range, range(1, 4));
                    assert_eq!(links[0].destination, "https://new.test");
                }
            }
            reopened.checkpoint().unwrap();
            assert_eq!(store.read("angle-command").unwrap(), changed);
        }
    }
}
