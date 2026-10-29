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
    native.close().unwrap();
    assert!(matches!(
        native.source_text(),
        Err(EditorSessionError::Unavailable)
    ));
    let recovered = store.open_editor("plain".into()).unwrap();
    assert_eq!(recovered.source_text().unwrap(), "a日本\0\0z\r\n");
}
