use super::*;
use futo_notes_editor::{
    BlockCommand, DisplayUtf16Offset, DisplayUtf16Range, DisplayUtf16Replacement, InlineFormat,
    InputAction,
};

const CASES: &str =
    include_str!("../../../../futo-notes-editor/tests/fixtures/structural-seams.json");
fn range(a: usize, z: usize) -> DisplayUtf16Range {
    DisplayUtf16Range {
        start: DisplayUtf16Offset(a),
        end: DisplayUtf16Offset(z),
    }
}

#[test]
fn structural_seams_and_raw_composition_recover_exact_source_and_carets() {
    let cases: serde_json::Value = serde_json::from_str(CASES).unwrap();
    assert_eq!(cases.as_array().unwrap().len(), 50);
    for case in cases.as_array().unwrap() {
        let text = |key: &str| case[key].as_str().unwrap();
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "seam", text("source")).unwrap();
        {
            let mut s = store.open_editor("seam").unwrap();
            let mut view = text("display").to_owned();
            let mut apply = |change: futo_notes_editor::ViewChange| {
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
                            range(0, 0),
                            &value.encode_utf16().collect::<Vec<_>>(),
                        )
                        .unwrap();
                    assert_eq!(marked.text, value);
                    assert_eq!(s.source_text(), text("source"));
                    assert_eq!(s.revision(), Revision(0));
                }
                s.cancel_composition(s.revision()).unwrap();
                assert!(s.composition().is_none());
                s.compose_utf16(s.revision(), range(0, 0), &inserted)
                    .unwrap();
                apply(
                    s.commit_composition_utf16(s.revision(), None)
                        .unwrap()
                        .unwrap(),
                );
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
                apply(s.replace_many_utf16(s.revision(), &replacements).unwrap());
                assert_eq!(s.revision(), Revision(1));
            } else if matches!(mode, "composition_os" | "distant_composition_os") {
                s.compose_utf16(
                    s.revision(),
                    range(
                        if mode == "distant_composition_os" {
                            17
                        } else {
                            0
                        },
                        if mode == "distant_composition_os" {
                            17
                        } else {
                            0
                        },
                    ),
                    &[33],
                )
                .unwrap();
                apply(
                    s.replace_os_utf16(s.revision(), selected, &inserted, &[])
                        .unwrap()
                        .unwrap(),
                );
                assert_eq!(s.revision(), Revision(1));
            } else if matches!(mode, "os" | "indent_os") {
                apply(
                    s.replace_os_utf16(s.revision(), selected, &inserted, &[])
                        .unwrap()
                        .unwrap(),
                );
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
                    apply(
                        s.replace_utf16_action(
                            s.revision(),
                            selected,
                            &input[1]
                                .as_str()
                                .unwrap()
                                .encode_utf16()
                                .collect::<Vec<_>>(),
                            serde_json::from_value(input[0].clone()).unwrap(),
                        )
                        .unwrap(),
                    );
                }
            } else if mode == "typing" {
                apply(
                    s.replace_utf16_action(
                        s.revision(),
                        selected,
                        &inserted,
                        InputAction::Isolated,
                    )
                    .unwrap(),
                );
            } else if mode == "explicit" {
                apply(
                    s.replace_many_utf16(
                        s.revision(),
                        &[DisplayUtf16Replacement {
                            range: selected,
                            inserted,
                        }],
                    )
                    .unwrap(),
                );
            } else if mode == "batch" {
                let replacements = [(0, 1, "!"), (1, 2, "?"), (3, 5, "AC")].map(|(a, z, text)| {
                    DisplayUtf16Replacement {
                        range: range(a, z),
                        inserted: text.encode_utf16().collect(),
                    }
                });
                apply(s.replace_many_utf16(s.revision(), &replacements).unwrap());
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
                .unwrap_or(case["caret"].as_u64().unwrap()) as usize;
            assert_eq!(redone, range(redo_caret, redo_caret));
            assert_eq!(store.read("seam").unwrap(), text("source"));
            assert_eq!(s.flush_recovery().unwrap().durable, s.revision());
        }
        let mut recovered = store.open_editor("seam").unwrap();
        assert_eq!(recovered.source_text(), text("expectedSource"));
        assert_eq!(recovered.display_text(), text("expectedDisplay"));
        assert!(recovered.undo(recovered.revision()).unwrap().is_none());
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("seam").unwrap(), text("expectedSource"));
        drop(recovered);
        let reopened = store.open_editor("seam").unwrap();
        assert_eq!(reopened.source_text(), text("expectedSource"));
        assert_eq!(reopened.display_text(), text("expectedDisplay"));
    }
}

#[test]
fn failed_append_keeps_raw_marking_for_the_same_mapped_os_retry() {
    let root = TestRoot::new();
    let store = store(&root);
    let raw = "> > \n> ab\n> ===";
    store.create("", "seam", raw).unwrap();
    let disk = Arc::new(Mutex::new(storage::Disk::default()));
    {
        let mut s = store
            .open_editor_with_recovery("seam", storage::options(&disk))
            .unwrap();
        s.compose_utf16(Revision(0), range(0, 0), &[33]).unwrap();
        disk.lock().unwrap().fault = Some(storage::Fault::Append);
        let text: Vec<_> = "!\nAC".encode_utf16().collect();
        assert!(matches!(
            s.replace_os_utf16(Revision(0), range(0, 4), &text, &[]),
            Err(EditorStoreError::RecoveryAppend(_))
        ));
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.revision(), Revision(0));
        assert_eq!(s.composition().unwrap().text, "!");
        disk.lock().unwrap().fault = None;
        s.resume_recovery().unwrap();
        s.replace_os_utf16(Revision(0), range(0, 4), &text, &[])
            .unwrap()
            .unwrap();
        assert_eq!(s.source_text(), "> > !\n>\n> AC\n> ===");
        assert_eq!(s.revision(), Revision(1));
        s.flush_recovery().unwrap();
    }
    let mut recovered = store
        .open_editor_with_recovery("seam", storage::options(&disk))
        .unwrap();
    assert_eq!(recovered.source_text(), "> > !\n>\n> AC\n> ===");
    assert_eq!(recovered.display_text(), "!\n\nAC");
    recovered.checkpoint().unwrap();
    assert_eq!(store.read("seam").unwrap(), "> > !\n>\n> AC\n> ===");
}

#[test]
fn failed_explicit_compound_append_retains_marking_and_retries_the_same_source_identities() {
    for (raw, display, marked_range, marked_text, replacements, expected, shown, caret) in [
        (
            "a&#32; b c",
            "a  b c",
            range(5, 6),
            "C",
            vec![(1, 2, ""), (3, 4, "B")],
            "a B C",
            "a B C",
            3,
        ),
        (
            "> > \n> a&#32; b\n> =",
            "\na  b",
            range(0, 0),
            "!",
            vec![(3, 4, ""), (5, 6, "B")],
            "> > !\n>\n> a B\n> =",
            "!\n\na B",
            6,
        ),
    ] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "seam", raw).unwrap();
        let disk = Arc::new(Mutex::new(storage::Disk::default()));
        {
            let mut s = store
                .open_editor_with_recovery("seam", storage::options(&disk))
                .unwrap();
            let marked = s
                .compose_utf16(
                    Revision(0),
                    marked_range,
                    &marked_text.encode_utf16().collect::<Vec<_>>(),
                )
                .unwrap();
            let replacements: Vec<_> = replacements
                .iter()
                .map(|&(a, z, text)| DisplayUtf16Replacement {
                    range: range(a, z),
                    inserted: text.encode_utf16().collect(),
                })
                .collect();
            let selection = s.selection();
            disk.lock().unwrap().fault = Some(storage::Fault::Append);
            assert!(matches!(
                s.replace_many_utf16(Revision(0), &replacements),
                Err(EditorStoreError::RecoveryAppend(_))
            ));
            assert_eq!(s.source_text(), raw);
            assert_eq!(s.display_text(), display);
            assert_eq!(s.selection(), selection);
            assert_eq!(s.revision(), Revision(0));
            assert_eq!(s.composition(), Some(marked));
            disk.lock().unwrap().fault = None;
            s.resume_recovery().unwrap();
            s.replace_many_utf16(Revision(0), &replacements).unwrap();
            assert_eq!(s.revision(), Revision(1));
            assert_eq!(s.source_text(), expected);
            assert_eq!(s.display_text(), shown);
            assert_eq!(
                s.display_to_utf16(s.revision(), s.selection()).unwrap(),
                range(caret, caret)
            );
            for _ in 0..2 {
                s.undo(s.revision()).unwrap().unwrap();
            }
            assert_eq!(s.source_text(), raw);
            for _ in 0..2 {
                s.redo(s.revision()).unwrap().unwrap();
            }
            assert_eq!(s.source_text(), expected);
            s.flush_recovery().unwrap();
        }
        let mut recovered = store
            .open_editor_with_recovery("seam", storage::options(&disk))
            .unwrap();
        assert_eq!(recovered.source_text(), expected);
        assert_eq!(recovered.display_text(), shown);
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("seam").unwrap(), expected);
    }
}
