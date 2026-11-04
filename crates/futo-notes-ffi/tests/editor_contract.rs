mod support;
use futo_notes_ffi::{EditorByteRange, EditorUtf16Range, NoteStore};
use support::{path_string, TempTree};

#[test]
fn native_save_delay_tracks_unsaved_edits_and_checkpoint_clears_it() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("plain".into(), "".into(), "before".into())
        .unwrap();
    let session = store.open_editor("plain".into()).unwrap();
    assert_eq!(session.save_delay().unwrap(), None);
    assert_eq!(session.save_status().unwrap().save_deadline, None);
    session
        .replace_utf16(0, EditorUtf16Range { start: 6, end: 6 }, vec![33])
        .unwrap();
    let delay = session.save_delay().unwrap().unwrap();
    assert!(delay <= std::time::Duration::from_millis(500));
    let status = session.save_status().unwrap();
    assert_eq!((status.revision, status.saved), (1, 0));
    assert!(status.save_deadline.is_some());
    // The foreign caller can be descheduled past the deadline between these
    // calls. Assert the authoritative outcome, rather than predicting elapsed
    // time from an earlier delay. Exact debounce boundaries are covered by the
    // store's controllable-clock tests.
    match session.save_if_due().unwrap() {
        None => {
            assert_eq!(store.read("plain".into()).unwrap(), "before");
            assert_eq!(session.save_status().unwrap().saved, 0);
        }
        Some(_) => {
            assert_eq!(store.read("plain".into()).unwrap(), "before!");
            assert_eq!(session.save_status().unwrap().saved, 1);
        }
    }
    session.checkpoint().unwrap();
    assert_eq!(store.read("plain".into()).unwrap(), "before!");
    assert_eq!(session.save_delay().unwrap(), None);
    assert_eq!(session.save_status().unwrap().saved, 1);
}

#[test]
fn native_relink_is_one_undo_step_and_delete_fences_the_same_attachment() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("old".into(), "".into(), "[[old]]".into())
        .unwrap();
    let session = store.open_editor("old".into()).unwrap();
    let mut view = "[[old]]".to_owned();
    let mut apply = |change: futo_notes_ffi::EditorViewChange| {
        view.replace_range(
            change.range.start as usize..change.range.end as usize,
            &change.inserted,
        );
    };
    apply(
        session
            .replace_utf16(0, EditorUtf16Range { start: 7, end: 7 }, vec![33])
            .unwrap(),
    );
    session.checkpoint().unwrap();
    store.rename("old".into(), "long name".into()).unwrap();
    assert_eq!(session.note_id().unwrap(), "long name");
    let changes = session.take_coordinated_changes().unwrap();
    assert_eq!(changes.len(), 1);
    apply(changes.into_iter().next().unwrap());
    assert!(session.take_coordinated_changes().unwrap().is_empty());
    drop(apply);
    assert_eq!(view, "[[long name]]!");
    assert_eq!(session.source_text().unwrap(), "[[long name]]!");
    session.undo(2).unwrap().unwrap();
    assert_eq!(session.source_text().unwrap(), "[[old]]!");
    session.redo(3).unwrap().unwrap();
    assert_eq!(session.source_text().unwrap(), "[[long name]]!");
    store.delete("long name".into()).unwrap();
    store
        .create_note("long name".into(), "".into(), "fresh".into())
        .unwrap();
    assert!(matches!(
        session.checkpoint(),
        Err(futo_notes_ffi::EditorSessionError::SessionDeleted)
    ));
    assert!(matches!(
        session.take_coordinated_changes(),
        Err(futo_notes_ffi::EditorSessionError::SessionDeleted)
    ));
    session.detach().unwrap();
    assert_eq!(
        store
            .open_editor("long name".into())
            .unwrap()
            .source_text()
            .unwrap(),
        "fresh"
    );
}

#[test]
fn native_session_preserves_unicode_nul_and_saves_on_detach() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let path = path_string(&tree.path("vault"));
    let store = NoteStore::new(path.clone());
    store
        .create_note("plain".into(), "".into(), "a😀\0z\r\n".into())
        .unwrap();
    let session = store.open_editor("plain".into()).unwrap();
    drop(store);
    let change = session
        .replace_utf16(
            0,
            EditorUtf16Range { start: 1, end: 3 },
            "🇯🇵".encode_utf16().collect(),
        )
        .unwrap();
    assert_eq!(change.previous_revision, 0);
    assert_eq!(change.revision, 1);
    assert_eq!(change.range.start, 1);
    assert_eq!(change.range.end, 5);
    assert_eq!(change.inserted, "🇯🇵");
    assert_eq!(change.selection.start, 9);
    assert_eq!(session.source_text().unwrap(), "a🇯🇵\0z\r\n");
    assert_eq!(session.save_status().unwrap().saved, 0);
    let saved = session.detach().unwrap();
    assert_eq!(saved.mutation.unwrap().final_id.as_deref(), Some("plain"));
    let store = NoteStore::new(path);
    assert_eq!(store.read("plain".into()).unwrap(), "a🇯🇵\0z\r\n");
}

#[test]
fn native_input_errors_selection_and_history_match_the_direct_session() {
    use futo_notes_editor::{
        DisplayUtf16Offset, DisplayUtf16Range, EditorError, EditorSession, Revision,
    };
    use futo_notes_ffi::EditorSessionError;
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("plain".into(), "".into(), "a😀\0z\r\n".into())
        .unwrap();
    let native = store.open_editor("plain".into()).unwrap();
    let mut direct = EditorSession::open("a😀\0z\r\n");
    for (start, end, input, expected) in [
        (2, 3, vec![65], EditorError::InvalidRange),
        (4, 3, vec![65], EditorError::InvalidRange),
        (1, 3, vec![0xd800], EditorError::InvalidText),
        (1, 3, vec![0xdc00], EditorError::InvalidText),
        (99, 99, vec![65], EditorError::InvalidRange),
    ] {
        let error = direct
            .replace_utf16(
                Revision(0),
                DisplayUtf16Range {
                    start: DisplayUtf16Offset(start),
                    end: DisplayUtf16Offset(end),
                },
                &input,
                &mut |_| Ok(()),
            )
            .unwrap_err();
        assert_eq!(error, expected);
        let native_error = native
            .replace_utf16(
                0,
                EditorUtf16Range {
                    start: start as u64,
                    end: end as u64,
                },
                input,
            )
            .unwrap_err();
        assert!(matches!(
            (&error, native_error),
            (EditorError::InvalidText, EditorSessionError::InvalidText)
                | (EditorError::InvalidRange, EditorSessionError::InvalidRange)
        ));
        assert_eq!(native.source_text().unwrap(), "a😀\0z\r\n");
        assert_eq!(native.revision().unwrap(), 0);
    }
    let selected = native
        .select_utf16(0, EditorUtf16Range { start: 1, end: 3 })
        .unwrap();
    assert_eq!(selected.selection.start, 1);
    assert_eq!(selected.selection.end, 5);
    assert_eq!(
        native.display_to_utf16(0, selected.selection).unwrap(),
        EditorUtf16Range { start: 1, end: 3 }
    );
    assert_eq!(
        native
            .utf16_to_display(0, EditorUtf16Range { start: 1, end: 3 })
            .unwrap(),
        selected.selection
    );
    assert!(matches!(
        native.utf16_to_display(0, EditorUtf16Range { start: 2, end: 3 }),
        Err(EditorSessionError::InvalidRange)
    ));
    assert!(matches!(
        native.utf16_to_display(9, EditorUtf16Range { start: 1, end: 3 }),
        Err(EditorSessionError::StaleRevision { .. })
    ));
    let bytes = "日本\0".encode_utf16().collect::<Vec<_>>();
    let changed = native
        .replace_utf16(0, EditorUtf16Range { start: 1, end: 3 }, bytes.clone())
        .unwrap();
    let change = direct
        .replace_utf16(
            Revision(0),
            DisplayUtf16Range {
                start: DisplayUtf16Offset(1),
                end: DisplayUtf16Offset(3),
            },
            &bytes,
            &mut |_| Ok(()),
        )
        .unwrap();
    assert_eq!(changed.range.start, change.range.start.0 as u64);
    assert_eq!(changed.range.end, change.range.end.0 as u64);
    assert_eq!(changed.inserted, "日本\0");
    assert_eq!(native.display_text().unwrap(), "a日本\0\0z\r\n");
    assert!(matches!(
        native.replace_utf16(0, EditorUtf16Range { start: 0, end: 0 }, vec![65]),
        Err(EditorSessionError::StaleRevision {
            expected: 0,
            actual: 1
        })
    ));
    let undone = native.undo(1).unwrap().unwrap();
    assert_eq!(undone.selection.start, 1);
    assert_eq!(undone.selection.end, 5);
    assert_eq!(native.source_text().unwrap(), "a😀\0z\r\n");
    native.redo(2).unwrap().unwrap();
    assert_eq!(native.source_text().unwrap(), "a日本\0\0z\r\n");
    native.detach().unwrap();
    assert!(matches!(
        native.source_text(),
        Err(EditorSessionError::Unavailable)
    ));
    let reopened = store.open_editor("plain".into()).unwrap();
    assert_eq!(reopened.source_text().unwrap(), "a日本\0\0z\r\n");
}

#[test]
fn native_projection_preserves_rich_semantics_and_source_correspondence() {
    use futo_notes_ffi::{EditorByteRange, EditorInlineFormat};
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("inline".into(), "".into(), "__日😀__ tail\r\n".into())
        .unwrap();
    let session = store.open_editor("inline".into()).unwrap();
    let projected = session
        .project(0, EditorByteRange { start: 0, end: 14 })
        .unwrap();
    assert_eq!(projected.text, "日😀 tail\r\n");
    assert_eq!(projected.runs[0].formats, vec![EditorInlineFormat::Bold]);
    assert_eq!(
        projected.runs[0].range,
        EditorByteRange { start: 0, end: 7 }
    );
    let change = session
        .replace_utf16(
            0,
            EditorUtf16Range { start: 1, end: 3 },
            "中".encode_utf16().collect(),
        )
        .unwrap();
    assert_eq!(session.source_text().unwrap(), "__日中__ tail\r\n");
    assert_eq!(change.projection.text, "日中 tail\r\n");
    assert_eq!(change.projection.revision, 1);
    assert_eq!(
        change.projection.runs[0].formats,
        vec![EditorInlineFormat::Bold]
    );
    use futo_notes_ffi::EditorCorrespondenceKind::{Hidden, Literal};
    let kinds: Vec<_> = change
        .projection
        .correspondence
        .iter()
        .map(|part| part.kind)
        .collect();
    assert_eq!(kinds, [Hidden, Literal, Hidden, Literal]);
}

#[test]
fn native_save_failure_keeps_the_session_attached_and_accepting_input() {
    let tree = TempTree::new();
    let root = tree.path("vault");
    std::fs::create_dir_all(&root).unwrap();
    let store = NoteStore::new(path_string(&root));
    store
        .create_note("plain".into(), "".into(), "before".into())
        .unwrap();
    let session = store.open_editor("plain".into()).unwrap();
    session
        .replace_utf16(0, EditorUtf16Range { start: 6, end: 6 }, vec![33])
        .unwrap();
    // A directory in the note's place makes the markdown write fail.
    let note = root.join("plain.md");
    std::fs::remove_file(&note).unwrap();
    std::fs::create_dir(&note).unwrap();
    assert!(session.detach().is_err());
    assert_eq!(session.source_text().unwrap(), "before!");
    session
        .replace_utf16(1, EditorUtf16Range { start: 7, end: 7 }, vec![33])
        .unwrap();
    assert_eq!(session.source_text().unwrap(), "before!!");
    assert!(!root.join(".futo-editor-recovery").exists());
}

#[test]
fn native_entity_point_mapping_retains_source_boundary_affinity() {
    use futo_notes_ffi::{EditorAffinity, EditorDisplayByteOffset};
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("entity".into(), "".into(), "&acE;".into())
        .unwrap();
    let session = store.open_editor("entity".into()).unwrap();
    assert_eq!(session.display_text().unwrap(), "∾\u{0333}");
    assert_eq!(
        session
            .source_at(
                0,
                EditorDisplayByteOffset { offset: 3 },
                EditorAffinity::Backward
            )
            .unwrap()
            .offset,
        0
    );
    assert_eq!(
        session
            .source_at(
                0,
                EditorDisplayByteOffset { offset: 3 },
                EditorAffinity::Forward
            )
            .unwrap()
            .offset,
        5
    );
}

#[test]
fn native_projection_marks_front_matter_as_metadata() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("fm".into(), "".into(), "---\ntitle: x\n---\nbody".into())
        .unwrap();
    let session = store.open_editor("fm".into()).unwrap();
    let text = session.display_text().unwrap();
    let blocks = session
        .project(
            0,
            EditorByteRange {
                start: 0,
                end: text.len() as u64,
            },
        )
        .unwrap()
        .blocks;
    assert_eq!(blocks.iter().filter(|block| block.metadata).count(), 1);
    assert!(!blocks.last().unwrap().metadata);
}

#[test]
fn native_remote_rename_retains_draft_and_merges_at_reported_final_id() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("old".into(), "".into(), "first\n\nsecond\n".into())
        .unwrap();
    let session = store.open_editor("old".into()).unwrap();
    session
        .replace_utf16(
            0,
            EditorUtf16Range { start: 7, end: 13 },
            "LOCAL".encode_utf16().collect(),
        )
        .unwrap();
    std::fs::rename(tree.path("vault/old.md"), tree.path("vault/final.md")).unwrap();
    std::fs::write(tree.path("vault/final.md"), "REMOTE\n\nsecond\n").unwrap();
    let mutation = store
        .refresh_external_changes(
            vec![],
            vec![],
            vec![futo_notes_ffi::RenamePair {
                from_id: "old".into(),
                to_id: "final".into(),
            }],
        )
        .unwrap();
    assert_eq!(mutation.upserted[0].note.id, "final");
    assert_eq!(session.note_id().unwrap(), "final");
    assert_eq!(session.source_text().unwrap(), "first\n\nLOCAL\n");
    let saved = session.checkpoint().unwrap();
    assert_eq!(saved.mutation.unwrap().final_id.as_deref(), Some("final"));
    assert_eq!(session.source_text().unwrap(), "REMOTE\n\nLOCAL\n");
    session.undo(2).unwrap().unwrap();
    assert_eq!(session.source_text().unwrap(), "REMOTE\n\nsecond\n");
    assert!(!store.exists("old".into()));
}

#[test]
fn native_text_first_commands_preserve_explicit_portable_variants() {
    use futo_notes_ffi::{EditorBlockCommand, EditorParagraphKey};
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("n".into(), "".into(), "above\n# title".into())
        .unwrap();
    let session = store.open_editor("n".into()).unwrap();
    session
        .paragraph_key_utf16(
            0,
            EditorUtf16Range { start: 6, end: 6 },
            EditorParagraphKey::BackspaceJoiningHeading,
        )
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text().unwrap(), "abovetitle\n");
    let rev = session.revision().unwrap();
    let range = EditorUtf16Range { start: 0, end: 0 };
    session
        .block_command_utf16(
            rev,
            range.clone(),
            EditorBlockCommand::ToggleHeading { level: 1 },
        )
        .unwrap()
        .unwrap();
    session
        .block_command_utf16(
            session.revision().unwrap(),
            range.clone(),
            EditorBlockCommand::ToggleHeading { level: 1 },
        )
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text().unwrap(), "abovetitle\n");
    session
        .block_command_utf16(
            session.revision().unwrap(),
            range,
            EditorBlockCommand::WrapCodeBlock,
        )
        .unwrap()
        .unwrap();
    assert!(session
        .source_text()
        .unwrap()
        .starts_with("```\nabovetitle"));
}
