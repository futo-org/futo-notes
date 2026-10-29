mod support;
use futo_notes_ffi::{EditorUtf16Range, NoteStore};
use support::{path_string, TempTree};

#[test]
fn native_session_preserves_unicode_nul_and_recovers_after_handle_release() {
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
    assert_eq!(session.recovery_status().unwrap().accepted, 1);
    assert_eq!(session.flush_recovery().unwrap().durable, 1);
    drop(session);
    let store = NoteStore::new(path);
    let recovered = store.open_editor("plain".into()).unwrap();
    assert_eq!(recovered.source_text().unwrap(), "a🇯🇵\0z\r\n");
    assert_eq!(recovered.revision().unwrap(), 1);
    let checkpoint = recovered.checkpoint().unwrap();
    assert_eq!(
        checkpoint.mutation.unwrap().final_id.as_deref(),
        Some("plain")
    );
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
    let recovered = store.open_editor("plain".into()).unwrap();
    assert_eq!(recovered.source_text().unwrap(), "a日本\0\0z\r\n");
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
    assert!(!change.projection.correspondence.is_empty());
}

#[test]
fn native_storage_failure_keeps_draft_copyable_and_reports_its_stage() {
    use futo_notes_ffi::EditorSessionError;
    let tree = TempTree::new();
    let root = tree.path("vault");
    std::fs::create_dir_all(&root).unwrap();
    let store = NoteStore::new(path_string(&root));
    store
        .create_note("plain".into(), "".into(), "before".into())
        .unwrap();
    let session = store.open_editor("plain".into()).unwrap();
    std::fs::write(root.join(".futo-editor-recovery"), "blocked").unwrap();
    assert!(matches!(
        session.replace_utf16(0, EditorUtf16Range { start: 6, end: 6 }, vec![33]),
        Err(EditorSessionError::RecoveryAppend { .. })
    ));
    assert_eq!(session.source_text().unwrap(), "before");
    assert_eq!(session.revision().unwrap(), 0);
    assert!(session.recovery_status().unwrap().paused);
    assert!(session.recovery_issue().unwrap().is_none());
    assert!(matches!(
        session.replace_utf16(0, EditorUtf16Range { start: 6, end: 6 }, vec![33]),
        Err(EditorSessionError::RecoveryPaused)
    ));
    assert!(matches!(
        session.resume_recovery(),
        Err(EditorSessionError::RecoveryResume { .. })
    ));
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
