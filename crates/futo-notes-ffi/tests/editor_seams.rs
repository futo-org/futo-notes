mod support;
use futo_notes_ffi::*;
use support::{path_string, TempTree};
fn range(a: u64, z: u64) -> EditorUtf16Range {
    EditorUtf16Range { start: a, end: z }
}

#[test]
fn native_structural_seams_and_raw_composition_keep_exact_recovery_and_carets() {
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../futo-notes-editor/tests/fixtures/structural-seams.json"
    ))
    .unwrap();
    assert_eq!(cases.as_array().unwrap().len(), 11);
    for case in cases.as_array().unwrap() {
        let text = |key: &str| case[key].as_str().unwrap();
        let tree = TempTree::new();
        std::fs::create_dir_all(tree.path("vault")).unwrap();
        let store = NoteStore::new(path_string(&tree.path("vault")));
        store
            .create_note("seam".into(), "".into(), text("source").into())
            .unwrap();
        let s = store.open_editor("seam".into()).unwrap();
        let mut view = text("display").to_owned();
        let mut last = None;
        let mut apply = |change: EditorViewChange| {
            view.replace_range(
                change.range.start as usize..change.range.end as usize,
                &change.inserted,
            );
            last = Some(change.selection);
        };
        let selected = range(
            case["range"][0].as_u64().unwrap(),
            case["range"][1].as_u64().unwrap(),
        );
        let inserted: Vec<_> = text("text").encode_utf16().collect();
        let mode = text("mode");
        if mode == "noop_indent" {
            assert!(s
                .block_command_utf16(0, range(0, 0), EditorBlockCommand::Heading { level: 1 })
                .unwrap()
                .is_none());
            assert_eq!(s.revision().unwrap(), 0);
            assert_eq!(s.source_text().unwrap(), text("source"));
        }
        if matches!(mode, "indent" | "noop_indent" | "indent_os") {
            apply(
                s.block_command_utf16(
                    s.revision().unwrap(),
                    range(0, 0),
                    EditorBlockCommand::Indent,
                )
                .unwrap()
                .unwrap(),
            );
        }
        if mode == "composition_commit" {
            for value in ["に", "日本"] {
                let marked = s
                    .compose_utf16(0, range(0, 0), value.encode_utf16().collect())
                    .unwrap();
                assert_eq!(marked.text, value);
                assert_eq!(s.source_text().unwrap(), text("source"));
                assert_eq!(s.revision().unwrap(), 0);
            }
            s.cancel_composition(0).unwrap();
            assert!(s.composition().unwrap().is_none());
            s.compose_utf16(0, range(0, 0), inserted).unwrap();
            apply(s.commit_composition_utf16(0, None).unwrap().unwrap());
        } else if mode == "composition_os" {
            s.compose_utf16(0, range(0, 0), vec![33]).unwrap();
            apply(
                s.replace_os_utf16(0, selected, inserted, vec![])
                    .unwrap()
                    .unwrap(),
            );
            assert_eq!(s.revision().unwrap(), 1);
        } else if matches!(mode, "os" | "indent_os") {
            apply(
                s.replace_os_utf16(s.revision().unwrap(), selected, inserted, vec![])
                    .unwrap()
                    .unwrap(),
            );
        } else if mode == "typing" {
            apply(
                s.replace_utf16_action(0, selected, inserted, EditorInputAction::Isolated)
                    .unwrap(),
            );
        } else if mode == "batch" {
            let replacements = [(0, 1, "!"), (1, 2, "?"), (3, 5, "AC")].map(|(a, z, text)| {
                EditorUtf16Replacement {
                    range: range(a, z),
                    inserted: text.encode_utf16().collect(),
                }
            });
            apply(s.replace_many_utf16(0, replacements.into()).unwrap());
        }
        assert_eq!(view, text("expectedDisplay"), "{}", text("name"));
        assert_eq!(s.source_text().unwrap(), text("expectedSource"));
        let caret = s
            .display_to_utf16(s.revision().unwrap(), last.unwrap())
            .unwrap();
        assert_eq!(caret.start, case["caret"].as_u64().unwrap());
        assert_eq!(caret.start, caret.end);
        for _ in 0..case["history"].as_u64().unwrap() {
            s.undo(s.revision().unwrap()).unwrap().unwrap();
        }
        assert_eq!(s.source_text().unwrap(), text("source"));
        for _ in 0..case["history"].as_u64().unwrap() {
            s.redo(s.revision().unwrap()).unwrap().unwrap();
        }
        assert_eq!(s.source_text().unwrap(), text("expectedSource"));
        s.flush_recovery().unwrap();
        s.detach().unwrap();
        let recovered = store.open_editor("seam".into()).unwrap();
        assert_eq!(recovered.source_text().unwrap(), text("expectedSource"));
        assert_eq!(recovered.display_text().unwrap(), text("expectedDisplay"));
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("seam".into()).unwrap(), text("expectedSource"));
    }
}
