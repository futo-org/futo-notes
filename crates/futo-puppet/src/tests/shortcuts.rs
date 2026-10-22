use super::*;

fn folder_menu() -> Value {
    let mut menu = json!({
        "screen": "home",
        "actions": [
            {"name": "OpenCreateFolderDialog",
             "schema": {"type":"object","properties":{"name":{"type":"string"}},"required":[]},
             "shortcuts": {"name": [["SetNewFolderName", {"name": "$"}], ["SubmitNewFolder"]]}},
            {"name": "OpenFolderContextMenu",
             "schema": {"type":"object","properties":{"path":{"type":"string"},"item":{"type":"string"}},"required":["path"]},
             "shortcuts": {"item": [["$"]]}},
            {"name": "DeleteNote",
             "schema": {"type":"object","properties":{"answer":{"type":"string","enum":["confirm","dismiss"]}},"required":[]}}
        ]
    });
    answer_through_dialog(&mut menu);
    menu
}

#[test]
fn actions_say_which_steps_a_shortcut_argument_takes() {
    let text = render_actions(&folder_menu());
    assert!(text.contains(
        "OpenCreateFolderDialog  {name?: string}\n                          name: shortcut, then SetNewFolderName {\"name\":\"<name>\"}, SubmitNewFolder\n"
    ), "{text}");
    assert!(text.contains("item: shortcut, then <item>\n"), "{text}");
    assert!(
        text.contains("answer: shortcut, then confirm: ConfirmDialog; dismiss: DismissDialog\n"),
        "{text}"
    );
}

#[test]
fn a_shortcut_argument_becomes_the_steps_it_stands_for() {
    let menu = folder_menu();
    assert_eq!(
        shortcut_steps(&menu, "OpenCreateFolderDialog", &json!({"name": "trips"})),
        Some(vec![
            ("SetNewFolderName".into(), json!({"name": "trips"})),
            ("SubmitNewFolder".into(), json!({}))
        ])
    );
    assert_eq!(
        shortcut_steps(
            &menu,
            "OpenFolderContextMenu",
            &json!({"path": "work", "item": "NewSubfolder"})
        ),
        Some(vec![("NewSubfolder".into(), json!({}))])
    );
    assert_eq!(
        shortcut_steps(&menu, "DeleteNote", &json!({"answer": "dismiss"})),
        Some(vec![("DismissDialog".into(), json!({}))])
    );
    // No shortcut argument given, or a verb with none: nothing to expand.
    assert_eq!(
        shortcut_steps(&menu, "OpenFolderContextMenu", &json!({"path": "work"})),
        None
    );
    assert_eq!(shortcut_steps(&menu, "Bold", &json!({"name": "x"})), None);
}
