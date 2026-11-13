mod support;
use futo_notes_ffi::{EditorInputAction, EditorUtf16Range, EditorUtf16Replacement, NoteStore};
use support::{path_string, TempTree};

#[test]
fn native_isolated_input_and_compound_runs_preserve_exact_history_and_validate_every_run() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    let opening = "__cat__ & _dog_\r\n";
    store
        .create_note("history".into(), "".into(), opening.into())
        .unwrap();
    let session = store.open_editor("history".into()).unwrap();
    session
        .replace_many_utf16(
            0,
            vec![
                EditorUtf16Replacement {
                    range: EditorUtf16Range { start: 0, end: 3 },
                    inserted: "kitten".encode_utf16().collect(),
                },
                EditorUtf16Replacement {
                    range: EditorUtf16Range { start: 6, end: 9 },
                    inserted: "ox".encode_utf16().collect(),
                },
            ],
        )
        .unwrap();
    assert_eq!(session.source_text().unwrap(), "__kitten__ & _ox_\r\n");
    session
        .replace_utf16_action(
            1,
            EditorUtf16Range { start: 11, end: 11 },
            "日本".encode_utf16().collect(),
            EditorInputAction::CompositionCommit,
        )
        .unwrap();
    assert_eq!(
        session.source_text().unwrap(),
        "__kitten__ & _ox日本_\r\n"
    );
    session
        .replace_utf16_action(
            2,
            EditorUtf16Range { start: 13, end: 13 },
            vec![33],
            EditorInputAction::Isolated,
        )
        .unwrap();
    assert_eq!(
        session.source_text().unwrap(),
        "__kitten__ & _ox日本!_\r\n"
    );
    assert!(matches!(
        session.replace_many_utf16(
            3,
            vec![
                EditorUtf16Replacement {
                    range: EditorUtf16Range { start: 0, end: 6 },
                    inserted: vec![97]
                },
                EditorUtf16Replacement {
                    range: EditorUtf16Range { start: 9, end: 11 },
                    inserted: vec![0xd800]
                },
            ]
        ),
        Err(futo_notes_ffi::EditorSessionError::InvalidText)
    ));
    assert_eq!(session.revision().unwrap(), 3);
    for (revision, expected) in [
        (3, "__kitten__ & _ox日本_\r\n"),
        (4, "__kitten__ & _ox_\r\n"),
        (5, opening),
    ] {
        session.undo(revision).unwrap().unwrap();
        assert_eq!(session.source_text().unwrap(), expected);
    }
    assert!(session.undo(6).unwrap().is_none());
    for revision in 6..9 {
        session.redo(revision).unwrap().unwrap();
    }
    assert_eq!(
        session.source_text().unwrap(),
        "__kitten__ & _ox日本!_\r\n"
    );
    session.detach().unwrap();
    let reopened = store.open_editor("history".into()).unwrap();
    assert_eq!(
        reopened.source_text().unwrap(),
        "__kitten__ & _ox日本!_\r\n"
    );
    assert!(reopened.undo(0).unwrap().is_none());
}

#[test]
fn native_checkpoint_adopts_merged_source_and_undo_retains_remote_contribution() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("merge".into(), "".into(), "first\n\nsecond\n".into())
        .unwrap();
    let session = store.open_editor("merge".into()).unwrap();
    session
        .replace_utf16_action(
            0,
            EditorUtf16Range { start: 7, end: 13 },
            "LOCAL".encode_utf16().collect(),
            EditorInputAction::Isolated,
        )
        .unwrap();
    std::fs::write(tree.path("vault/merge.md"), "REMOTE🦀\n\nsecond\n").unwrap();
    session.checkpoint().unwrap();
    assert_eq!(session.source_text().unwrap(), "REMOTE🦀\n\nLOCAL\n");
    assert_eq!(session.take_coordinated_changes().unwrap().len(), 1);
    session.undo(session.revision().unwrap()).unwrap().unwrap();
    assert_eq!(session.source_text().unwrap(), "REMOTE🦀\n\nsecond\n");
    session.detach().unwrap();
    assert_eq!(store.read("merge".into()).unwrap(), "REMOTE🦀\n\nsecond\n");

    store
        .create_note("raw".into(), "".into(), "REMOTE\n\nsecond\n".into())
        .unwrap();
    let merged = store
        .flush_draft_merged(
            "raw".into(),
            "first\n\nsecond\n".into(),
            "first\n\nLOCAL\n".into(),
        )
        .unwrap();
    assert_eq!(merged.source, "REMOTE\n\nLOCAL\n");
    assert_eq!(
        merged.flush.mutation.unwrap().final_id.as_deref(),
        Some("raw")
    );
}

#[test]
fn native_utf16_same_paragraph_merge_survives_undo_redo_detach_and_reopen() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    store
        .create_note("merge".into(), "".into(), "猫 middle last\r\n".into())
        .unwrap();
    let session = store.open_editor("merge".into()).unwrap();
    session
        .replace_utf16_action(
            0,
            EditorUtf16Range { start: 9, end: 13 },
            "LOCAL".encode_utf16().collect(),
            EditorInputAction::Isolated,
        )
        .unwrap();
    std::fs::write(tree.path("vault/merge.md"), "日本🦀 middle last\r\n").unwrap();
    session.checkpoint().unwrap();
    assert_eq!(session.source_text().unwrap(), "日本🦀 middle LOCAL\r\n");
    session.undo(session.revision().unwrap()).unwrap().unwrap();
    assert_eq!(session.source_text().unwrap(), "日本🦀 middle last\r\n");
    session.redo(session.revision().unwrap()).unwrap().unwrap();
    session.detach().unwrap();
    assert_eq!(
        store.read("merge".into()).unwrap(),
        "日本🦀 middle LOCAL\r\n"
    );
    assert_eq!(
        store
            .open_editor("merge".into())
            .unwrap()
            .source_text()
            .unwrap(),
        "日本🦀 middle LOCAL\r\n"
    );
}
