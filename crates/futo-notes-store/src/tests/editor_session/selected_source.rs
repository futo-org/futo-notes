use super::*;
use futo_notes_editor::{
    DisplayUtf16Offset, DisplayUtf16Range, DisplayUtf16Replacement, InputAction,
};

fn apply(view: &mut String, change: futo_notes_editor::ViewChange) {
    view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
}

fn native_range(a: usize, z: usize) -> DisplayUtf16Range {
    DisplayUtf16Range {
        start: DisplayUtf16Offset(a),
        end: DisplayUtf16Offset(z),
    }
}

#[test]
fn selected_source_ownership_survives_failed_append_retry_replay_and_checkpoint() {
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../futo-notes-editor/tests/fixtures/structural-seams.json"
    ))
    .unwrap();
    let cases: Vec<_> = cases
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| {
            case["name"]
                .as_str()
                .unwrap()
                .starts_with("selected-source-")
        })
        .collect();
    assert_eq!(cases.len(), 9);
    for case in cases {
        let text = |key: &str| case[key].as_str().unwrap();
        let selected = native_range(
            case["range"][0].as_u64().unwrap() as usize,
            case["range"][1].as_u64().unwrap() as usize,
        );
        let inserted: Vec<_> = text("text").encode_utf16().collect();
        let mode = text("mode");
        let replacements: Vec<_> = if mode == "composition_batch" {
            case["replacements"]
                .as_array()
                .unwrap()
                .iter()
                .map(|run| DisplayUtf16Replacement {
                    range: native_range(
                        run[0].as_u64().unwrap() as usize,
                        run[1].as_u64().unwrap() as usize,
                    ),
                    inserted: run[2].as_str().unwrap().encode_utf16().collect(),
                })
                .collect()
        } else {
            vec![DisplayUtf16Replacement {
                range: selected,
                inserted: inserted.clone(),
            }]
        };
        let input = |s: &mut crate::StoreEditorSession<'_>| {
            if mode == "typing" {
                s.replace_utf16_action(s.revision(), selected, &inserted, InputAction::Isolated)
            } else {
                s.replace_many_utf16(s.revision(), &replacements)
            }
        };
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "selected", text("source")).unwrap();
        let disk = Arc::new(Mutex::new(storage::Disk::default()));
        {
            let mut s = store
                .open_editor_with_recovery("selected", storage::options(&disk))
                .unwrap();
            let mut view = text("display").to_owned();
            s.select_utf16(Revision(0), selected).unwrap();
            let opening_selection = s.selection();
            let marked = if mode == "composition_batch" {
                Some(s.compose_utf16(Revision(0), selected, &inserted).unwrap())
            } else {
                None
            };
            disk.lock().unwrap().fault = Some(storage::Fault::Append);
            assert!(
                matches!(input(&mut s), Err(EditorStoreError::RecoveryAppend(_))),
                "{}",
                text("name")
            );
            assert_eq!(s.source_text(), text("source"));
            assert_eq!(s.display_text(), view);
            assert_eq!(s.revision(), Revision(0));
            assert_eq!(s.selection(), opening_selection);
            assert_eq!(s.composition(), marked);
            let failed = s.recovery_status();
            assert!(failed.paused);
            assert_eq!(failed.accepted, Revision(0));
            assert_eq!(failed.durable, Revision(0));
            disk.lock().unwrap().fault = None;
            assert!(!s.resume_recovery().unwrap().paused);
            apply(&mut view, input(&mut s).unwrap());
            assert_eq!(s.revision(), Revision(1));
            assert_eq!(s.source_text(), text("expectedSource"));
            assert_eq!(view, text("expectedDisplay"));
            let caret = case["caret"].as_u64().unwrap() as usize;
            assert_eq!(
                s.display_to_utf16(s.revision(), s.selection()).unwrap(),
                native_range(caret, caret)
            );
            assert!(s.composition().is_none());
            let history = case["history"].as_u64().unwrap();
            for step in 0..history {
                apply(&mut view, s.undo(s.revision()).unwrap().unwrap());
                if history == 2 && step == 0 {
                    assert_eq!(s.source_text(), "> > !\n>\n> ab\n> ===");
                    assert_eq!(view, "!\n\nab");
                    assert_eq!(
                        s.display_to_utf16(s.revision(), s.selection()).unwrap(),
                        native_range(1, 1)
                    );
                }
            }
            assert_eq!(s.source_text(), text("source"));
            assert_eq!(view, text("display"));
            assert_eq!(s.selection(), opening_selection);
            assert!(s.undo(s.revision()).unwrap().is_none());
            for step in 0..history {
                apply(&mut view, s.redo(s.revision()).unwrap().unwrap());
                if history == 2 && step == 0 {
                    assert_eq!(s.source_text(), "> > !\n>\n> ab\n> ===");
                }
            }
            assert_eq!(s.source_text(), text("expectedSource"));
            assert_eq!(view, text("expectedDisplay"));
            assert_eq!(
                s.display_to_utf16(s.revision(), s.selection()).unwrap(),
                native_range(caret, caret)
            );
            assert!(s.redo(s.revision()).unwrap().is_none());
            assert_eq!(store.read("selected").unwrap(), text("source"));
            assert_eq!(s.flush_recovery().unwrap().durable, s.revision());
        }
        let mut recovered = store
            .open_editor_with_recovery("selected", storage::options(&disk))
            .unwrap();
        assert_eq!(recovered.source_text(), text("expectedSource"));
        assert_eq!(recovered.display_text(), text("expectedDisplay"));
        assert!(recovered.undo(recovered.revision()).unwrap().is_none());
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("selected").unwrap(), text("expectedSource"));
        drop(recovered);
        let mut reopened = store
            .open_editor_with_recovery("selected", storage::options(&disk))
            .unwrap();
        assert_eq!(reopened.source_text(), text("expectedSource"));
        assert_eq!(reopened.display_text(), text("expectedDisplay"));
        assert!(reopened.undo(reopened.revision()).unwrap().is_none());
    }
}
