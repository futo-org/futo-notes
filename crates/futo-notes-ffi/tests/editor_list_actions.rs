mod support;
use futo_notes_ffi::{
    EditorBlockCommand, EditorByteRange, EditorInputAction, EditorParagraphKey, EditorUtf16Range,
    EditorViewChange, NoteStore,
};
use serde_json::Value;
use support::{path_string, TempTree};

fn native(value: &Value) -> EditorUtf16Range {
    EditorUtf16Range {
        start: value[0].as_u64().unwrap(),
        end: value[1].as_u64().unwrap(),
    }
}
fn apply(view: &mut String, change: &EditorViewChange) {
    view.replace_range(
        change.range.start as usize..change.range.end as usize,
        &change.inserted,
    );
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
fn shared_list_actions_forward_native_coordinates_history_and_exact_saves() {
    let original: Vec<Value> = serde_json::from_str(include_str!(
        "../../futo-notes-editor/tests/fixtures/list-actions.json"
    ))
    .unwrap();
    let shortcuts: Vec<Value> = serde_json::from_str(include_str!(
        "../../futo-notes-editor/tests/fixtures/list-shortcuts.json"
    ))
    .unwrap();
    assert_eq!(original.len(), 29);
    assert_eq!(shortcuts.len(), 38);
    let staging: Vec<Value> = serde_json::from_str(include_str!(
        "../../futo-notes-editor/tests/fixtures/list-staging.json"
    ))
    .unwrap();
    assert_eq!(staging.len(), 12);
    let nested: Vec<Value> = serde_json::from_str(include_str!(
        "../../futo-notes-editor/tests/fixtures/nested-containers.json"
    ))
    .unwrap();
    assert_eq!(nested.len(), 35);
    let commands: Vec<Value> = serde_json::from_str(include_str!(
        "../../futo-notes-editor/tests/fixtures/container-commands.json"
    ))
    .unwrap();
    assert_eq!(commands.len(), 27);
    let headers: Vec<Value> = serde_json::from_str(include_str!(
        "../../futo-notes-editor/tests/fixtures/list-header-commands.json"
    ))
    .unwrap();
    assert_eq!(headers.len(), 14);
    let frames: Vec<Value> = serde_json::from_str(include_str!(
        "../../futo-notes-editor/tests/fixtures/prefix-frame-commands.json"
    ))
    .unwrap();
    assert_eq!(frames.len(), 24);
    let fences: Vec<Value> = serde_json::from_str(include_str!(
        "../../futo-notes-editor/tests/fixtures/fence-container-commands.json"
    ))
    .unwrap();
    assert_eq!(fences.len(), 29);
    let headings: Vec<Value> = serde_json::from_str(include_str!(
        "../../futo-notes-editor/tests/fixtures/heading-quote-commands.json"
    ))
    .unwrap();
    assert_eq!(headings.len(), 16);
    let cases: Vec<_> = original
        .into_iter()
        .chain(shortcuts)
        .chain(staging)
        .chain(nested)
        .chain(commands)
        .chain(headers)
        .chain(frames)
        .chain(fences)
        .chain(headings)
        .collect();
    for case in &cases {
        let text = |key: &str| case[key].as_str().unwrap();
        let tree = TempTree::new();
        std::fs::create_dir_all(tree.path("vault")).unwrap();
        let store = NoteStore::new(path_string(&tree.path("vault")));
        plant_note(&tree, "lists", text("source"));
        let s = store.open_editor("lists".into()).unwrap();
        let mut view = text("display").to_owned();
        assert_eq!(s.display_text().unwrap(), view);
        let initial = native(case.get("selection").unwrap_or(&case["range"]));
        s.select_utf16(0, initial.clone()).unwrap();
        let selected = native(&case["range"]);
        let inserted: Vec<u16> = case["text"].as_str().unwrap_or("").encode_utf16().collect();
        let action = text("action");
        if case.get("composeRange").is_some() {
            s.compose_utf16(
                0,
                native(&case["composeRange"]),
                case["compositionText"]
                    .as_str()
                    .unwrap_or(case["text"].as_str().unwrap_or(""))
                    .encode_utf16()
                    .collect::<Vec<_>>(),
            )
            .unwrap();
            assert_eq!(s.source_text().unwrap(), text("source"));
        }
        let result = match action {
            "Typing" => s
                .replace_utf16_action(0, selected, inserted, EditorInputAction::Typing)
                .map(Some),
            "Enter" | "Backspace" | "Delete" => s.paragraph_key_utf16(
                0,
                selected,
                if action == "Enter" {
                    EditorParagraphKey::Enter
                } else if action == "Delete" {
                    EditorParagraphKey::Delete
                } else {
                    EditorParagraphKey::Backspace
                },
            ),
            command => s.block_command_utf16(
                0,
                selected,
                match command {
                    "CodeBlock" => EditorBlockCommand::CodeBlock,
                    "WrapCodeBlock" => EditorBlockCommand::WrapCodeBlock,
                    "Text" => EditorBlockCommand::Heading { level: 0 },
                    "Heading2" => EditorBlockCommand::Heading { level: 2 },
                    "Quote" => EditorBlockCommand::Quote,
                    "Indent" => EditorBlockCommand::Indent,
                    "Outdent" => EditorBlockCommand::Outdent,
                    "BulletList" => EditorBlockCommand::BulletList,
                    "OrderedList" => EditorBlockCommand::OrderedList,
                    "TaskList" => EditorBlockCommand::TaskList,
                    "ToggleTask" | "ComposeToggleTask" => EditorBlockCommand::ToggleTask,
                    _ => panic!("unknown fixture action {command}"),
                },
            ),
        };
        if case["refused"].as_bool() == Some(true) {
            assert!(
                matches!(
                    result,
                    Err(futo_notes_ffi::EditorSessionError::UnrepresentableFormat)
                ),
                "{}",
                text("name")
            );
            assert_eq!(s.source_text().unwrap(), text("source"));
            continue;
        }
        let change = result.unwrap().unwrap();
        apply(&mut view, &change);
        assert_eq!(change.revision, 1);
        assert_eq!(
            s.source_text().unwrap(),
            text("expected"),
            "{}",
            text("name")
        );
        assert_eq!(view, text("shown"));
        assert_eq!(
            s.display_to_utf16(1, change.selection).unwrap(),
            native(&case["resultRange"])
        );
        let mut blocks = s
            .project(
                1,
                EditorByteRange {
                    start: 0,
                    end: view.len() as u64,
                },
            )
            .unwrap()
            .blocks;
        for block in s
            .project(
                1,
                EditorByteRange {
                    start: view.len() as u64,
                    end: view.len() as u64,
                },
            )
            .unwrap()
            .blocks
        {
            if !blocks.contains(&block) {
                blocks.push(block);
            }
        }
        let mut item_index = 0;
        let items: Vec<_> = blocks
            .into_iter()
            .filter_map(|block| {
                block.list.filter(|list| list.first).map(|list| {
                    assert_eq!(
                        list.depth,
                        case["itemDepths"][item_index].as_u64().unwrap_or(1) as u64
                    );
                    assert_eq!(
                        block.quote_depth,
                        case["itemQuoteDepths"][item_index]
                            .as_u64()
                            .unwrap_or_else(|| case["quoteDepth"].as_u64().unwrap_or(0))
                    );
                    item_index += 1;
                    serde_json::json!([list.number, list.checked])
                })
            })
            .collect();
        assert_eq!(
            serde_json::json!(items),
            case["finalItems"],
            "{}",
            text("name")
        );
        let histories = case["undoSources"].as_array().map_or(1, Vec::len);
        for step in 0..histories {
            let change = s.undo(s.revision().unwrap()).unwrap().unwrap();
            apply(&mut view, &change);
            assert_eq!(
                s.source_text().unwrap(),
                case["undoSources"][step].as_str().unwrap_or(text("source"))
            );
            assert_eq!(
                view,
                case["undoDisplays"][step]
                    .as_str()
                    .unwrap_or(text("display"))
            );
            assert_eq!(
                s.display_to_utf16(change.revision, change.selection)
                    .unwrap(),
                case["undoRanges"]
                    .get(step)
                    .map(native)
                    .unwrap_or(initial.clone())
            );
        }
        assert!(s.undo(s.revision().unwrap()).unwrap().is_none());
        for _ in 0..histories {
            apply(&mut view, &s.redo(s.revision().unwrap()).unwrap().unwrap());
        }
        assert_eq!(s.source_text().unwrap(), text("expected"));
        assert_eq!(view, text("shown"));
        s.checkpoint().unwrap();
        s.detach().unwrap();
        // The save appended the note's final line ending, if it had none.
        let (saved, shown) = saved_forms(text("expected"), text("shown"));
        let recovered = store.open_editor("lists".into()).unwrap();
        assert_eq!(recovered.source_text().unwrap(), saved);
        assert_eq!(recovered.display_text().unwrap(), shown);
        assert!(recovered
            .undo(recovered.revision().unwrap())
            .unwrap()
            .is_none());
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("lists".into()).unwrap(), saved);
        recovered.detach().unwrap();
        assert_eq!(
            store
                .open_editor("lists".into())
                .unwrap()
                .source_text()
                .unwrap(),
            saved
        );
    }
}
