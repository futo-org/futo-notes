use super::*;
use serde_json::Value;

fn native(value: &Value) -> DisplayUtf16Range {
    DisplayUtf16Range {
        start: DisplayUtf16Offset(value[0].as_u64().unwrap() as usize),
        end: DisplayUtf16Offset(value[1].as_u64().unwrap() as usize),
    }
}

#[test]
fn shared_literal_list_actions_cover_native_coordinates_and_exact_history() {
    let original: Vec<Value> =
        serde_json::from_str(include_str!("../fixtures/list-actions.json")).unwrap();
    let shortcuts: Vec<Value> =
        serde_json::from_str(include_str!("../fixtures/list-shortcuts.json")).unwrap();
    assert_eq!(original.len(), 29);
    assert_eq!(shortcuts.len(), 38);
    let staging: Vec<Value> =
        serde_json::from_str(include_str!("../fixtures/list-staging.json")).unwrap();
    assert_eq!(staging.len(), 12);
    let nested: Vec<Value> =
        serde_json::from_str(include_str!("../fixtures/nested-containers.json")).unwrap();
    assert_eq!(nested.len(), 35);
    let commands: Vec<Value> =
        serde_json::from_str(include_str!("../fixtures/container-commands.json")).unwrap();
    assert_eq!(commands.len(), 27);
    let headers: Vec<Value> =
        serde_json::from_str(include_str!("../fixtures/list-header-commands.json")).unwrap();
    assert_eq!(headers.len(), 14);
    let frames: Vec<Value> =
        serde_json::from_str(include_str!("../fixtures/prefix-frame-commands.json")).unwrap();
    assert_eq!(frames.len(), 24);
    let fences: Vec<Value> =
        serde_json::from_str(include_str!("../fixtures/fence-container-commands.json")).unwrap();
    assert_eq!(fences.len(), 23);
    let headings: Vec<Value> =
        serde_json::from_str(include_str!("../fixtures/heading-quote-commands.json")).unwrap();
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
        let mut s = EditorSession::open(text("source"));
        let mut view = ReferenceView::new(text("display"));
        assert_eq!(s.display_text(), view.text, "{}", text("name"));
        let initial = native(case.get("selection").unwrap_or(&case["range"]));
        s.select_utf16(s.revision(), initial).unwrap();
        let selected = native(&case["range"]);
        let inserted: Vec<u16> = case["text"].as_str().unwrap_or("").encode_utf16().collect();
        let action = text("action");
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
            assert_eq!(s.source_text(), text("source"));
        }
        let mut accepts = 0;
        let mut accept = |_: &SourceEdit| {
            accepts += 1;
            Ok(())
        };
        let result = match action {
            "Typing" => s
                .replace_utf16_action(
                    s.revision(),
                    selected,
                    &inserted,
                    InputAction::Typing,
                    &mut accept,
                )
                .map(Some),
            "Enter" | "Backspace" | "Delete" => s.paragraph_key_utf16(
                s.revision(),
                selected,
                if action == "Enter" {
                    ParagraphKey::Enter
                } else if action == "Delete" {
                    ParagraphKey::Delete
                } else {
                    ParagraphKey::Backspace
                },
                &mut accept,
            ),
            command => s.block_command_utf16(
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
                &mut accept,
            ),
        };
        if case["refused"].as_bool() == Some(true) {
            // Outside the generic list path: refused before acceptance.
            assert!(
                matches!(result, Err(EditorError::UnrepresentableFormat)),
                "{}",
                text("name")
            );
            assert_eq!(accepts, 0);
            assert_eq!(s.source_text(), text("source"));
            continue;
        }
        let change = result.unwrap().unwrap();
        view.apply(change);
        assert_eq!(accepts, 1, "{}", text("name"));
        assert_eq!(s.source_text(), text("expected"), "{}", text("name"));
        assert_eq!(view.text, text("shown"), "{}", text("name"));
        assert_eq!(
            s.display_to_utf16(s.revision(), s.selection()).unwrap(),
            native(&case["resultRange"]),
            "{}",
            text("name")
        );
        let fresh = EditorSession::open(text("expected"));
        assert_eq!(fresh.display_text(), text("shown"));
        for session in [&s, &fresh] {
            // A nonempty projection slice excludes a zero-width final item;
            // request its caret slice too, just as a view at EOF does.
            let mut blocks = session
                .project(session.revision(), range(0, view.text.len()))
                .unwrap()
                .blocks;
            for block in session
                .project(session.revision(), range(view.text.len(), view.text.len()))
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
                text("name")
            );
        }
        let histories = case["undoSources"].as_array().map_or(1, Vec::len);
        for step in 0..histories {
            view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
            let source = case["undoSources"][step].as_str().unwrap_or(text("source"));
            let shown = case["undoDisplays"][step]
                .as_str()
                .unwrap_or(text("display"));
            assert_eq!(s.source_text(), source, "{} undo {step}", text("name"));
            assert_eq!(view.text, shown);
            let selection = case["undoRanges"].get(step).map(native).unwrap_or(initial);
            assert_eq!(
                s.display_to_utf16(s.revision(), s.selection()).unwrap(),
                selection
            );
        }
        assert!(s.undo(s.revision(), &mut |_| Ok(())).unwrap().is_none());
        for _ in 0..histories {
            view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        }
        assert_eq!(s.source_text(), text("expected"));
        assert_eq!(view.text, text("shown"));
        assert_eq!(
            s.display_to_utf16(s.revision(), s.selection()).unwrap(),
            native(&case["resultRange"])
        );
    }
}
