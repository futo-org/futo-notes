use super::*;
use futo_notes_editor::{
    BlockCommand, DisplayOffset, DisplayRange, DisplayUtf16Offset, DisplayUtf16Range, InputAction,
    ParagraphKey, ViewChange,
};
use serde_json::Value;

fn native(value: &Value) -> DisplayUtf16Range {
    DisplayUtf16Range {
        start: DisplayUtf16Offset(value[0].as_u64().unwrap() as usize),
        end: DisplayUtf16Offset(value[1].as_u64().unwrap() as usize),
    }
}

fn action(
    s: &mut crate::StoreEditorSession<'_>,
    case: &Value,
) -> Result<ViewChange, EditorStoreError> {
    let selected = native(&case["range"]);
    let name = case["action"].as_str().unwrap();
    Ok(match name {
        "Typing" => s.replace_utf16_action(
            s.revision(),
            selected,
            &case["text"]
                .as_str()
                .unwrap()
                .encode_utf16()
                .collect::<Vec<_>>(),
            InputAction::Typing,
        )?,
        "Enter" | "Backspace" | "Delete" => s
            .paragraph_key_utf16(
                s.revision(),
                selected,
                if name == "Enter" {
                    ParagraphKey::Enter
                } else if name == "Delete" {
                    ParagraphKey::Delete
                } else {
                    ParagraphKey::Backspace
                },
            )?
            .unwrap(),
        command => s
            .block_command_utf16(
                s.revision(),
                selected,
                match command {
                    "Text" => BlockCommand::Heading(0),
                    "Heading2" => BlockCommand::Heading(2),
                    "Quote" => BlockCommand::Quote,
                    "Indent" => BlockCommand::Indent,
                    "Outdent" => BlockCommand::Outdent,
                    "BulletList" => BlockCommand::BulletList,
                    "OrderedList" => BlockCommand::OrderedList,
                    "TaskList" => BlockCommand::TaskList,
                    "ToggleTask" | "ComposeToggleTask" => BlockCommand::ToggleTask,
                    _ => panic!("unknown fixture action {command}"),
                },
            )?
            .unwrap(),
    })
}

fn apply(view: &mut String, change: ViewChange) {
    view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
}

fn assert_items(s: &crate::StoreEditorSession<'_>, case: &Value) {
    let end = case["shown"].as_str().unwrap().len();
    let mut blocks = s
        .project(
            s.revision(),
            DisplayRange {
                start: DisplayOffset(0),
                end: DisplayOffset(end),
            },
        )
        .unwrap()
        .blocks;
    for block in s
        .project(
            s.revision(),
            DisplayRange {
                start: DisplayOffset(end),
                end: DisplayOffset(end),
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
                    case["itemDepths"][item_index].as_u64().unwrap_or(1) as usize
                );
                assert_eq!(
                    block.quote_depth,
                    case["itemQuoteDepths"][item_index]
                        .as_u64()
                        .unwrap_or_else(|| case["quoteDepth"].as_u64().unwrap_or(0))
                        as usize
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
        case["name"]
    );
}

#[test]
fn shared_list_actions_survive_failed_append_undo_flush_power_loss_and_checkpoint() {
    let original: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../futo-notes-editor/tests/fixtures/list-actions.json"
    ))
    .unwrap();
    let shortcuts: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../futo-notes-editor/tests/fixtures/list-shortcuts.json"
    ))
    .unwrap();
    assert_eq!(original.len(), 27);
    assert_eq!(shortcuts.len(), 38);
    let staging: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../futo-notes-editor/tests/fixtures/list-staging.json"
    ))
    .unwrap();
    assert_eq!(staging.len(), 12);
    let nested: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../futo-notes-editor/tests/fixtures/nested-containers.json"
    ))
    .unwrap();
    assert_eq!(nested.len(), 35);
    let commands: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../futo-notes-editor/tests/fixtures/container-commands.json"
    ))
    .unwrap();
    assert_eq!(commands.len(), 27);
    let headers: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../futo-notes-editor/tests/fixtures/list-header-commands.json"
    ))
    .unwrap();
    assert_eq!(headers.len(), 14);
    let frames: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../futo-notes-editor/tests/fixtures/prefix-frame-commands.json"
    ))
    .unwrap();
    assert_eq!(frames.len(), 24);
    let fences: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../futo-notes-editor/tests/fixtures/fence-container-commands.json"
    ))
    .unwrap();
    assert_eq!(fences.len(), 23);
    let headings: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../futo-notes-editor/tests/fixtures/heading-quote-commands.json"
    ))
    .unwrap();
    assert_eq!(headings.len(), 6);
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
        let root = TestRoot::new();
        let store = store(&root);
        plant_note(&root, "lists", text("source"));
        {
            let mut s = store.open_editor("lists").unwrap();
            let mut view = text("display").to_owned();
            assert_eq!(s.display_text(), view, "{}", text("name"));
            let initial = native(case.get("selection").unwrap_or(&case["range"]));
            s.select_utf16(s.revision(), initial).unwrap();
            if case.get("composeRange").is_some() {
                s.compose_utf16(
                    s.revision(),
                    native(&case["composeRange"]),
                    &case["compositionText"]
                        .as_str()
                        .unwrap_or(case["text"].as_str().unwrap_or(""))
                        .encode_utf16()
                        .collect::<Vec<_>>(),
                )
                .unwrap();
            }
            let marked = s.composition();
            if case["refused"].as_bool() == Some(true) {
                // Outside the generic list path: refused before any append.
                assert!(
                    matches!(
                        action(&mut s, case),
                        Err(EditorStoreError::Editor(
                            futo_notes_editor::EditorError::UnrepresentableFormat
                        ))
                    ),
                    "{}",
                    text("name")
                );
                assert_eq!(s.source_text(), text("source"));
                assert_eq!(s.revision(), Revision(0));
                continue;
            }
            assert_eq!(s.source_text(), text("source"));
            assert_eq!(s.revision(), Revision(0));
            assert_eq!(
                s.display_to_utf16(s.revision(), s.selection()).unwrap(),
                initial
            );
            assert_eq!(s.composition(), marked);
            apply(&mut view, action(&mut s, case).unwrap());
            assert_eq!(s.source_text(), text("expected"), "{}", text("name"));
            assert_eq!(view, text("shown"));
            assert_items(&s, case);
            assert_eq!(
                s.display_to_utf16(s.revision(), s.selection()).unwrap(),
                native(&case["resultRange"])
            );
            assert_eq!(s.revision(), Revision(1), "one edit");
            assert_eq!(s.source_text(), text("expected"));
            let histories = case["undoSources"].as_array().map_or(1, Vec::len);
            for step in 0..histories {
                apply(&mut view, s.undo(s.revision()).unwrap().unwrap());
                assert_eq!(
                    s.source_text(),
                    case["undoSources"][step].as_str().unwrap_or(text("source"))
                );
                assert_eq!(
                    view,
                    case["undoDisplays"][step]
                        .as_str()
                        .unwrap_or(text("display"))
                );
                assert_eq!(
                    s.display_to_utf16(s.revision(), s.selection()).unwrap(),
                    case["undoRanges"].get(step).map(native).unwrap_or(initial)
                );
            }
            assert!(s.undo(s.revision()).unwrap().is_none());
            for _ in 0..histories {
                apply(&mut view, s.redo(s.revision()).unwrap().unwrap());
            }
            assert_eq!(s.source_text(), text("expected"));
            assert_eq!(view, text("shown"));
            assert_items(&s, case);
            assert_eq!(store.read("lists").unwrap(), text("source"));
            s.checkpoint().unwrap();
        }
        // The save appended the note's final line ending, if it had none.
        let (saved, shown) = saved_forms(text("expected"), text("shown"));
        let mut recovered = store.open_editor("lists").unwrap();
        assert_eq!(recovered.source_text(), saved);
        assert_eq!(recovered.display_text(), shown);
        assert_items(&recovered, case);
        assert!(recovered.undo(recovered.revision()).unwrap().is_none());
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("lists").unwrap(), saved);
        drop(recovered);
        let fresh = store.open_editor("lists").unwrap();
        assert_eq!(fresh.source_text(), saved);
        assert_items(&fresh, case);
    }
}
