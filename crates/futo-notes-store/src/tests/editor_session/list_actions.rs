use super::*;
use futo_notes_editor::{
    BlockCommand, DisplayUtf16Offset, DisplayUtf16Range, InputAction, ParagraphKey, ViewChange,
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
        "Enter" | "Backspace" => s
            .paragraph_key_utf16(
                s.revision(),
                selected,
                if name == "Enter" {
                    ParagraphKey::Enter
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

#[test]
fn shared_list_actions_survive_failed_append_undo_flush_power_loss_and_checkpoint() {
    let cases: Value = serde_json::from_str(include_str!(
        "../../../../futo-notes-editor/tests/fixtures/list-actions.json"
    ))
    .unwrap();
    assert_eq!(cases.as_array().unwrap().len(), 24);
    for case in cases.as_array().unwrap() {
        let text = |key: &str| case[key].as_str().unwrap();
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "lists", text("source")).unwrap();
        let disk = Arc::new(Mutex::new(storage::Disk::default()));
        {
            let mut s = store
                .open_editor_with_recovery("lists", storage::options(&disk))
                .unwrap();
            let mut view = text("display").to_owned();
            assert_eq!(s.display_text(), view, "{}", text("name"));
            let initial = native(case.get("selection").unwrap_or(&case["range"]));
            s.select_utf16(s.revision(), initial).unwrap();
            if text("action") == "ComposeToggleTask" {
                s.compose_utf16(
                    s.revision(),
                    native(&case["composeRange"]),
                    &text("text").encode_utf16().collect::<Vec<_>>(),
                )
                .unwrap();
            }
            let marked = s.composition();
            disk.lock().unwrap().fault = Some(storage::Fault::Append);
            assert!(
                matches!(
                    action(&mut s, case),
                    Err(EditorStoreError::RecoveryAppend(_))
                ),
                "{}",
                text("name")
            );
            assert_eq!(s.source_text(), text("source"));
            assert_eq!(s.revision(), Revision(0));
            assert_eq!(s.composition(), marked);
            assert!(matches!(
                action(&mut s, case),
                Err(EditorStoreError::RecoveryPaused)
            ));
            disk.lock().unwrap().fault = None;
            s.resume_recovery().unwrap();
            apply(&mut view, action(&mut s, case).unwrap());
            assert_eq!(s.source_text(), text("expected"), "{}", text("name"));
            assert_eq!(view, text("shown"));
            assert_eq!(
                s.display_to_utf16(s.revision(), s.selection()).unwrap(),
                native(&case["resultRange"])
            );
            assert_eq!(s.revision(), Revision(1), "one protected acceptance");
            disk.lock().unwrap().fault = Some(storage::Fault::Append);
            assert!(matches!(
                s.undo(s.revision()),
                Err(EditorStoreError::RecoveryAppend(_))
            ));
            assert_eq!(s.source_text(), text("expected"));
            disk.lock().unwrap().fault = None;
            s.resume_recovery().unwrap();
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
            assert_eq!(store.read("lists").unwrap(), text("source"));
            assert_eq!(s.flush_recovery().unwrap().durable, s.revision());
        }
        disk.lock().unwrap().power_loss();
        let mut recovered = store
            .open_editor_with_recovery("lists", storage::options(&disk))
            .unwrap();
        assert_eq!(recovered.source_text(), text("expected"));
        assert_eq!(recovered.display_text(), text("shown"));
        assert!(recovered.undo(recovered.revision()).unwrap().is_none());
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("lists").unwrap(), text("expected"));
        drop(recovered);
        assert_eq!(
            store.open_editor("lists").unwrap().source_text(),
            text("expected")
        );
    }
}
