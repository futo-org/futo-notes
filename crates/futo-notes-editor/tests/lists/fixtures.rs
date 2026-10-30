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
    let cases: Value = serde_json::from_str(include_str!("../fixtures/list-actions.json")).unwrap();
    assert_eq!(cases.as_array().unwrap().len(), 26);
    for case in cases.as_array().unwrap() {
        let text = |key: &str| case[key].as_str().unwrap();
        let mut s = EditorSession::open(text("source"));
        let mut view = ReferenceView::new(text("display"));
        assert_eq!(s.display_text(), view.text, "{}", text("name"));
        let initial = native(case.get("selection").unwrap_or(&case["range"]));
        s.select_utf16(s.revision(), initial).unwrap();
        let selected = native(&case["range"]);
        let inserted: Vec<u16> = case["text"].as_str().unwrap_or("").encode_utf16().collect();
        let action = text("action");
        if action == "ComposeToggleTask" {
            s.compose_utf16(s.revision(), native(&case["composeRange"]), &inserted)
                .unwrap();
            assert_eq!(s.source_text(), text("source"));
        }
        let mut accepts = 0;
        let mut accept = |_: &SourceEdit| {
            accepts += 1;
            Ok(())
        };
        let change = match action {
            "Typing" => s
                .replace_utf16_action(
                    s.revision(),
                    selected,
                    &inserted,
                    InputAction::Typing,
                    &mut accept,
                )
                .unwrap(),
            "Enter" | "Backspace" => s
                .paragraph_key_utf16(
                    s.revision(),
                    selected,
                    if action == "Enter" {
                        ParagraphKey::Enter
                    } else {
                        ParagraphKey::Backspace
                    },
                    &mut accept,
                )
                .unwrap()
                .unwrap(),
            command => s
                .block_command_utf16(
                    s.revision(),
                    selected,
                    match command {
                        "BulletList" => BlockCommand::BulletList,
                        "OrderedList" => BlockCommand::OrderedList,
                        "TaskList" => BlockCommand::TaskList,
                        "ToggleTask" | "ComposeToggleTask" => BlockCommand::ToggleTask,
                        _ => panic!("unknown fixture action {command}"),
                    },
                    &mut accept,
                )
                .unwrap()
                .unwrap(),
        };
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
            let items: Vec<_> = blocks
                .into_iter()
                .filter_map(|block| {
                    block.list.filter(|list| list.first).map(|list| {
                        assert_eq!(list.depth, 1);
                        assert_eq!(
                            block.quote_depth,
                            case["quoteDepth"].as_u64().unwrap_or(0) as usize
                        );
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
