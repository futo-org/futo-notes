mod support;
use futo_notes_ffi::*;
use support::{path_string, TempTree};
fn range(a: u64, z: u64) -> EditorUtf16Range {
    EditorUtf16Range { start: a, end: z }
}

/// A note holding exactly `source`, which may lack the final line ending every
/// authored write appends (portable-core/recovery.md).
fn plant_note(tree: &TempTree, id: &str, source: &str) {
    std::fs::write(tree.path(&format!("vault/{id}.md")), source).unwrap();
}

/// Source and display after an authored save of `source`: a nonempty note
/// without a final line ending gains its own (CRLF or LF). The gained ending's
/// display is the editor's own projection of the saved bytes.
fn saved_forms(source: &str, display: &str) -> (String, String) {
    if source.is_empty() || source.ends_with('\n') {
        return (source.to_owned(), display.to_owned());
    }
    let ending = if source.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let saved = format!("{source}{ending}");
    let shown = futo_notes_editor::EditorSession::open(&saved).display_text();
    (saved, shown)
}

#[test]
fn native_structural_seams_and_raw_composition_keep_exact_saves_and_carets() {
    let cases: Vec<serde_json::Value> = [
        include_str!("../../futo-notes-editor/tests/fixtures/structural-seams.json"),
        include_str!("../../futo-notes-editor/tests/fixtures/fence-physical-rows.json"),
    ]
    .into_iter()
    .flat_map(|source| serde_json::from_str::<Vec<serde_json::Value>>(source).unwrap())
    .collect();
    assert_eq!(cases.len(), 69);
    for case in &cases {
        let text = |key: &str| case[key].as_str().unwrap();
        let tree = TempTree::new();
        std::fs::create_dir_all(tree.path("vault")).unwrap();
        let store = NoteStore::new(path_string(&tree.path("vault")));
        plant_note(&tree, "seam", text("source"));
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
        if mode == "composition_commit" {
            for value in ["に", "日本"] {
                let marked = s
                    .compose_utf16(0, selected, value.encode_utf16().collect())
                    .unwrap();
                assert_eq!(marked.text, value);
                assert_eq!(s.source_text().unwrap(), text("source"));
                assert_eq!(s.revision().unwrap(), 0);
            }
            s.cancel_composition(0).unwrap();
            assert!(s.composition().unwrap().is_none());
            s.compose_utf16(0, selected, inserted).unwrap();
            apply(s.commit_composition_utf16(0, None).unwrap().unwrap());
        } else if mode == "composition_batch" {
            s.compose_utf16(0, selected, inserted).unwrap();
            assert_eq!(s.source_text().unwrap(), text("source"));
            let replacements = case["replacements"]
                .as_array()
                .unwrap()
                .iter()
                .map(|run| EditorUtf16Replacement {
                    range: range(run[0].as_u64().unwrap(), run[1].as_u64().unwrap()),
                    inserted: run[2].as_str().unwrap().encode_utf16().collect(),
                })
                .collect();
            apply(s.replace_many_utf16(0, replacements).unwrap());
            assert_eq!(s.revision().unwrap(), 1);
        } else if matches!(mode, "composition_os" | "distant_composition_os") {
            s.compose_utf16(
                0,
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
                vec![33],
            )
            .unwrap();
            apply(
                s.replace_os_utf16(0, selected, inserted, vec![])
                    .unwrap()
                    .unwrap(),
            );
            assert_eq!(s.revision().unwrap(), 1);
        } else if mode == "os" {
            apply(
                s.replace_os_utf16(s.revision().unwrap(), selected, inserted, vec![])
                    .unwrap()
                    .unwrap(),
            );
        } else if mode == "typing_sequence" {
            if let Some(format) = case["format"].as_str() {
                let format = match format {
                    "Bold" => EditorInlineFormat::Bold,
                    "Code" => EditorInlineFormat::Code,
                    _ => panic!("invalid fixture format"),
                };
                assert!(s.toggle_format(0, format).unwrap().is_none());
            }
            let mut caret = selected;
            for input in case["inputs"].as_array().unwrap() {
                let action = match input[0].as_str().unwrap() {
                    "Typing" => EditorInputAction::Typing,
                    "Isolated" => EditorInputAction::Isolated,
                    _ => panic!("invalid fixture action"),
                };
                let change = s
                    .replace_utf16_action(
                        s.revision().unwrap(),
                        caret,
                        input[1].as_str().unwrap().encode_utf16().collect(),
                        action,
                    )
                    .unwrap();
                caret = s
                    .display_to_utf16(s.revision().unwrap(), change.selection)
                    .unwrap();
                apply(change);
            }
        } else if mode == "typing" {
            apply(
                s.replace_utf16_action(0, selected, inserted, EditorInputAction::Isolated)
                    .unwrap(),
            );
        } else if mode == "explicit" {
            let replacements: Vec<_> = if let Some(runs) = case["replacements"].as_array() {
                runs.iter()
                    .map(|run| EditorUtf16Replacement {
                        range: range(run[0].as_u64().unwrap(), run[1].as_u64().unwrap()),
                        inserted: run[2].as_str().unwrap().encode_utf16().collect(),
                    })
                    .collect()
            } else {
                vec![EditorUtf16Replacement {
                    range: selected,
                    inserted,
                }]
            };
            apply(s.replace_many_utf16(0, replacements).unwrap());
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
        let mut redone = None;
        for _ in 0..case["history"].as_u64().unwrap() {
            redone = s.redo(s.revision().unwrap()).unwrap();
        }
        assert_eq!(s.source_text().unwrap(), text("expectedSource"));
        let caret = case["redoCaret"]
            .as_u64()
            .unwrap_or(case["caret"].as_u64().unwrap());
        assert_eq!(
            s.display_to_utf16(s.revision().unwrap(), redone.unwrap().selection)
                .unwrap(),
            range(caret, caret)
        );
        s.checkpoint().unwrap();
        s.detach().unwrap();
        // The save appended the note's final line ending, if it had none.
        let (saved, shown) = saved_forms(text("expectedSource"), text("expectedDisplay"));
        let recovered = store.open_editor("seam".into()).unwrap();
        assert_eq!(recovered.source_text().unwrap(), saved);
        assert_eq!(recovered.display_text().unwrap(), shown);
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("seam".into()).unwrap(), saved);
    }
}
