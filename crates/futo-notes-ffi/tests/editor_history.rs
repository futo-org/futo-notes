mod support;
use futo_notes_ffi::{EditorInputAction, EditorUtf16Range, EditorUtf16Replacement, NoteStore};
use support::{path_string, TempTree};

#[test]
fn native_isolated_input_and_compound_runs_preserve_exact_history_and_validate_every_run() {
    let tree = TempTree::new();
    std::fs::create_dir_all(tree.path("vault")).unwrap();
    let store = NoteStore::new(path_string(&tree.path("vault")));
    let opening = "__cat__ &amp; _dog_\r\n";
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
    assert_eq!(session.source_text().unwrap(), "__kitten__ &amp; _ox_\r\n");
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
        "__kitten__ &amp; _ox日本_\r\n"
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
        "__kitten__ &amp; _ox日本!_\r\n"
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
        (3, "__kitten__ &amp; _ox日本_\r\n"),
        (4, "__kitten__ &amp; _ox_\r\n"),
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
        "__kitten__ &amp; _ox日本!_\r\n"
    );
    session.detach().unwrap();
    let recovered = store.open_editor("history".into()).unwrap();
    assert_eq!(
        recovered.source_text().unwrap(),
        "__kitten__ &amp; _ox日本!_\r\n"
    );
    assert!(recovered.undo(9).unwrap().is_none());
}
