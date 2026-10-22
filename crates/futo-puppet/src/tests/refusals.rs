use super::*;

#[test]
fn an_open_row_menu_names_its_row() {
    let rows = [
        json!({"ref": "n3", "section": "list"}),
        json!({"ref": "n9", "section": "menu · note \"Welcome\""}),
    ];
    assert_eq!(open_menu_row(&rows).as_deref(), Some("note \"Welcome\""));
    assert_eq!(open_menu_row(&[json!({"section": "menu"})]), None);
}

#[test]
fn a_misnamed_argument_is_refused_with_the_call_it_meant() {
    let menu = json!({"screen": "editor:a", "actions": [
        {"name": "Replace", "schema": {"type": "object", "required": ["text"], "properties": {
            "find": {"type": "string"}, "from": {"type": "integer"}, "to": {"type": "integer"},
            "text": {"type": "string"}}}},
        {"name": "Insert", "schema": {"type": "object", "required": ["text"], "properties": {
            "at": {"type": "integer"}, "after": {"type": "string"}, "text": {"type": "string"}}}},
        {"name": "Bold", "schema": {"type": "object", "required": [], "properties": {}}},
    ]});
    // The one required argument missing takes the one unknown.
    assert_eq!(
        argument_error(
            &menu,
            "Replace",
            &json!({"find": "$400", "with": "it's $450"})
        )
        .unwrap(),
        r#"unknown argument "with"; did you mean "text"? do Replace "{\"find\":\"\$400\",\"text\":\"it's \$450\"}""#
    );
    // Nothing required missing: the one unused parameter of the value's type.
    assert_eq!(
        argument_error(&menu, "Insert", &json!({"position": 5, "text": "x"})).unwrap(),
        r#"unknown argument "position"; did you mean "at"? do Insert '{"at":5,"text":"x"}'"#
    );
    // Two would fit: no guess, the verb's parameters.
    assert_eq!(
        argument_error(&menu, "Replace", &json!({"at": 5, "text": "x"})).unwrap(),
        r#"unknown argument "at" — takes {text: string, find?: string, from?: integer, to?: integer}"#
    );
    assert_eq!(
        argument_error(&menu, "Replace", &json!({"find": "a"})).unwrap(),
        r#"missing required argument "text" — takes {text: string, find?: string, from?: integer, to?: integer}"#
    );
    assert!(
        argument_error(&menu, "Insert", &json!({"at": "5", "text": "x"}))
            .unwrap()
            .starts_with(r#"argument "at" must be integer"#)
    );
    assert_eq!(
        argument_error(&menu, "Bold", &json!({"on": true})).unwrap(),
        r#"unknown argument "on" — takes no arguments"#
    );
    assert_eq!(
        argument_error(&menu, "Replace", &json!({"find": "a", "text": "b"})),
        None
    );
    // A string with allowed values is one of them, and the parameters say which.
    let tabs = json!({"actions": [{"name": "OpenNote", "schema": {"type": "object",
        "required": ["noteId"], "properties": {"noteId": {"type": "string"},
        "mode": {"type": "string", "enum": ["current", "foreground", "background"]}}}}]});
    assert_eq!(
        argument_error(&tabs, "OpenNote", &json!({"noteId": "a", "mode": "new"})).unwrap(),
        r#"argument "mode" must be one of current, foreground, background, not "new""#
    );
    assert_eq!(
        argument_error(&tabs, "OpenNote", &json!({"noteId": "a", "tab": "x"})).unwrap(),
        r#"unknown argument "tab" — takes {noteId: string, mode?: current|foreground|background}"#
    );
    assert_eq!(
        argument_error(
            &tabs,
            "OpenNote",
            &json!({"noteId": "a", "mode": "foreground"})
        ),
        None
    );
    // A verb the menu does not list is the app's to answer.
    assert_eq!(argument_error(&menu, "Italic", &json!({"x": 1})), None);
}
