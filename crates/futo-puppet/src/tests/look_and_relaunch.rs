use super::*;

#[test]
fn relaunch_on_desktop_is_refused_with_what_to_do() {
    let error = relaunch(&Target::Desktop(1)).unwrap_err();
    assert!(error.contains("just tauri-dev"), "{error}");
}

/// A read the app cannot answer yet (Android's `notes` while its first-run screen has no vault)
/// prints its refusal where its line goes, and `look` reads the rest.
#[test]
fn look_prints_a_refused_notes_and_reads_on() {
    let (port, _) = super::gestures::fake_bridge(|script| {
        let (status, body) = if script.contains(r#"run("notes""#) {
            (409, json!({"ok": false, "error": "no vault yet"}))
        } else {
            (200, json!({"screen": "storage"}))
        };
        json!({"id": "futo-puppet", "success": true,
               "data": json!({"status": status, "body": body}).to_string()})
    });
    let out = look(&Target::Desktop(port)).expect("look reads on");
    assert!(
        out.contains("notes: ") && out.contains("no vault yet"),
        "{out}"
    );
}

/// A verb a row already shows is named once, with what it takes; the rest are listed in
/// full, as `actions` lists them.
#[test]
fn look_lists_the_verbs_no_row_shows_and_names_the_rest() {
    let elements = json!({ "elements": [{ "ref": "n1", "verb": "OpenSettings" }] });
    let actions = json!({ "screen": "list", "actions": [
        { "name": "OpenSettings", "schema": {} },
        { "name": "OpenNote", "schema": {
            "properties": { "noteId": { "type": "string" } }, "required": ["noteId"] } },
    ] });
    let verbs = look_verbs(&elements, &actions);
    assert!(
        verbs.starts_with("verbs no row shows:\nOpenNote"),
        "{verbs}"
    );
    assert!(!verbs.contains("screen: list"), "{verbs}");
    assert!(verbs.ends_with("verbs on rows: OpenSettings\n"), "{verbs}");
}
