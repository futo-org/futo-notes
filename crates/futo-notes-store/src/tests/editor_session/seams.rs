use super::*;
use futo_notes_editor::{
    BlockCommand, DisplayUtf16Offset, DisplayUtf16Range, DisplayUtf16Replacement, InlineFormat,
    InputAction, ViewChange,
};

const CASES: [&str; 2] = [
    include_str!("../../../../futo-notes-editor/tests/fixtures/structural-seams.json"),
    include_str!("../../../../futo-notes-editor/tests/fixtures/fence-physical-rows.json"),
];
fn range(a: usize, z: usize) -> DisplayUtf16Range {
    DisplayUtf16Range {
        start: DisplayUtf16Offset(a),
        end: DisplayUtf16Offset(z),
    }
}

/// Runs the one accepting input.
fn accept(
    s: &mut crate::StoreEditorSession<'_>,
    mut op: impl FnMut(&mut crate::StoreEditorSession<'_>) -> Result<ViewChange, EditorStoreError>,
) -> ViewChange {
    op(s).unwrap()
}

/// The shared structural-seam fixtures through a real store session: each
/// case's input, undo, redo, checkpoint, reopen.
#[test]
fn structural_seams_and_raw_composition_keep_exact_source_and_carets() {
    let cases: Vec<serde_json::Value> = CASES
        .into_iter()
        .flat_map(|source| serde_json::from_str::<Vec<serde_json::Value>>(source).unwrap())
        .collect();
    assert_eq!(cases.len(), 72);
    for case in &cases {
        {
            let text = |key: &str| case[key].as_str().unwrap();
            let root = TestRoot::new();
            let store = store(&root);
            plant_note(&root, "seam", text("source"));
            {
                let mut s = store.open_editor("seam").unwrap();
                let mut view = text("display").to_owned();
                let mut apply = |change: ViewChange| {
                    view.replace_range(change.range.start.0..change.range.end.0, &change.inserted)
                };
                let selected = range(
                    case["range"][0].as_u64().unwrap() as usize,
                    case["range"][1].as_u64().unwrap() as usize,
                );
                let inserted: Vec<_> = text("text").encode_utf16().collect();
                let mode = text("mode");
                if mode == "noop_indent" {
                    assert!(s
                        .block_command_utf16(s.revision(), range(0, 0), BlockCommand::Heading(1))
                        .unwrap()
                        .is_none());
                    assert_eq!(s.revision(), Revision(0));
                    assert_eq!(s.source_text(), text("source"));
                }
                if matches!(mode, "indent" | "noop_indent" | "indent_os") {
                    apply(
                        s.block_command_utf16(s.revision(), range(0, 0), BlockCommand::Indent)
                            .unwrap()
                            .unwrap(),
                    );
                }
                if mode == "composition_commit" {
                    for value in ["に", "日本"] {
                        let marked = s
                            .compose_utf16(
                                s.revision(),
                                selected,
                                &value.encode_utf16().collect::<Vec<_>>(),
                            )
                            .unwrap();
                        assert_eq!(marked.text, value);
                        assert_eq!(s.source_text(), text("source"));
                        assert_eq!(s.revision(), Revision(0));
                    }
                    s.cancel_composition(s.revision()).unwrap();
                    assert!(s.composition().is_none());
                    s.compose_utf16(s.revision(), selected, &inserted).unwrap();
                    apply(accept(&mut s, |s| {
                        s.commit_composition_utf16(s.revision(), None)
                            .map(Option::unwrap)
                    }));
                } else if mode == "composition_batch" {
                    s.compose_utf16(s.revision(), selected, &inserted).unwrap();
                    assert_eq!(s.source_text(), text("source"));
                    let replacements: Vec<_> = case["replacements"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|run| DisplayUtf16Replacement {
                            range: range(
                                run[0].as_u64().unwrap() as usize,
                                run[1].as_u64().unwrap() as usize,
                            ),
                            inserted: run[2].as_str().unwrap().encode_utf16().collect(),
                        })
                        .collect();
                    apply(accept(&mut s, |s| {
                        s.replace_many_utf16(s.revision(), &replacements)
                    }));
                    assert_eq!(s.revision(), Revision(1));
                } else if matches!(mode, "composition_os" | "distant_composition_os") {
                    let at = if mode == "distant_composition_os" {
                        17
                    } else {
                        0
                    };
                    s.compose_utf16(s.revision(), range(at, at), &[33]).unwrap();
                    apply(accept(&mut s, |s| {
                        s.replace_os_utf16(s.revision(), selected, &inserted, &[])
                            .map(Option::unwrap)
                    }));
                    assert_eq!(s.revision(), Revision(1));
                } else if matches!(mode, "os" | "indent_os") {
                    apply(accept(&mut s, |s| {
                        s.replace_os_utf16(s.revision(), selected, &inserted, &[])
                            .map(Option::unwrap)
                    }));
                } else if mode == "typing_sequence" {
                    if let Some(format) = case["format"].as_str() {
                        assert!(s
                            .toggle_format(
                                s.revision(),
                                serde_json::from_value::<InlineFormat>(format.into()).unwrap()
                            )
                            .unwrap()
                            .is_none());
                    }
                    for input in case["inputs"].as_array().unwrap() {
                        let selected = s.display_to_utf16(s.revision(), s.selection()).unwrap();
                        let typed: Vec<_> = input[1].as_str().unwrap().encode_utf16().collect();
                        apply(accept(&mut s, |s| {
                            s.replace_utf16_action(
                                s.revision(),
                                selected,
                                &typed,
                                serde_json::from_value(input[0].clone()).unwrap(),
                            )
                        }));
                    }
                } else if mode == "typing" {
                    apply(accept(&mut s, |s| {
                        s.replace_utf16_action(
                            s.revision(),
                            selected,
                            &inserted,
                            InputAction::Isolated,
                        )
                    }));
                } else if mode == "explicit" {
                    let replacements: Vec<_> = if let Some(runs) = case["replacements"].as_array() {
                        runs.iter()
                            .map(|run| DisplayUtf16Replacement {
                                range: range(
                                    run[0].as_u64().unwrap() as usize,
                                    run[1].as_u64().unwrap() as usize,
                                ),
                                inserted: run[2].as_str().unwrap().encode_utf16().collect(),
                            })
                            .collect()
                    } else {
                        vec![DisplayUtf16Replacement {
                            range: selected,
                            inserted,
                        }]
                    };
                    apply(accept(&mut s, |s| {
                        s.replace_many_utf16(s.revision(), &replacements)
                    }));
                } else if mode == "batch" {
                    let replacements =
                        [(0, 1, "!"), (1, 2, "?"), (3, 5, "AC")].map(|(a, z, text)| {
                            DisplayUtf16Replacement {
                                range: range(a, z),
                                inserted: text.encode_utf16().collect(),
                            }
                        });
                    apply(accept(&mut s, |s| {
                        s.replace_many_utf16(s.revision(), &replacements)
                    }));
                }
                assert_eq!(view, text("expectedDisplay"), "{}", text("name"));
                assert_eq!(s.source_text(), text("expectedSource"));
                let caret = s.display_to_utf16(s.revision(), s.selection()).unwrap();
                assert_eq!(caret.start.0, case["caret"].as_u64().unwrap() as usize);
                assert_eq!(caret.start, caret.end);
                for _ in 0..case["history"].as_u64().unwrap() {
                    s.undo(s.revision()).unwrap().unwrap();
                }
                assert_eq!(s.source_text(), text("source"));
                for _ in 0..case["history"].as_u64().unwrap() {
                    s.redo(s.revision()).unwrap().unwrap();
                }
                assert_eq!(s.source_text(), text("expectedSource"));
                let redone = s.display_to_utf16(s.revision(), s.selection()).unwrap();
                let redo_caret = case["redoCaret"]
                    .as_u64()
                    .unwrap_or(case["caret"].as_u64().unwrap())
                    as usize;
                assert_eq!(redone, range(redo_caret, redo_caret));
                assert_eq!(store.read("seam").unwrap(), text("source"));
                s.checkpoint().unwrap();
            }
            // The save appended the note's final line ending, if it had none.
            let (saved, shown) = saved_forms(text("expectedSource"), text("expectedDisplay"));
            let mut recovered = store.open_editor("seam").unwrap();
            assert_eq!(recovered.source_text(), saved);
            assert_eq!(recovered.display_text(), shown);
            assert!(recovered.undo(recovered.revision()).unwrap().is_none());
            recovered.checkpoint().unwrap();
            assert_eq!(store.read("seam").unwrap(), saved);
            drop(recovered);
            let reopened = store.open_editor("seam").unwrap();
            assert_eq!(reopened.source_text(), saved);
            assert_eq!(reopened.display_text(), shown);
        }
    }
}
