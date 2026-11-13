mod common;
use common::ReferenceView;
use futo_notes_editor::*;
use serde_json::Value;

const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/fixtures/editor-native-input"
);

fn text(value: &Value) -> String {
    String::from_utf16(&units(value)).unwrap()
}
fn units(value: &Value) -> Vec<u16> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_u64().unwrap() as u16)
        .collect()
}
fn range(value: &Value) -> DisplayUtf16Range {
    DisplayUtf16Range {
        start: DisplayUtf16Offset(value[0].as_u64().unwrap() as usize),
        end: DisplayUtf16Offset(value[1].as_u64().unwrap() as usize),
    }
}
fn read(name: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(format!("{FIXTURES}/{name}.json")).unwrap())
        .unwrap()
}

fn read_trace(name: &str) -> Value {
    let mut trace = read(name);
    trace["events"] = Value::Array(
        trace["eventFiles"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|file| read(file.as_str().unwrap()).as_array().unwrap().clone())
            .collect(),
    );
    trace
}

#[test]
fn captured_uikit_results_replay_without_fictional_or_duplicate_callbacks() {
    let cases = read("native-input-cases");
    assert_eq!(cases.as_array().unwrap().len(), 6);
    for case in cases.as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let trace = read_trace(name);
        let source = case["source"].as_str().unwrap();
        // The captures opened `&amp;`, which the editor no longer decodes; the cases write
        // it as `&`, so every recorded display, range and keyboard result is unchanged.
        assert_eq!(text(&trace["sourceUTF16"]).replace("&amp;", "&"), source);
        let mut session = EditorSession::open(source);
        let mut view = ReferenceView::new(case["display"].as_str().unwrap());
        let mut records = Vec::new();

        let mut previous_event = 0;
        for step in case["steps"].as_array().unwrap() {
            let id = step["event"].as_u64().unwrap();
            assert!(id > previous_event);
            previous_event = id;
            let event = trace["events"]
                .as_array()
                .unwrap()
                .iter()
                .find(|e| e["id"] == id)
                .unwrap();
            let snapshot = &event["after"];
            let recorded = text(&snapshot["textUTF16"]);
            let expected = session.revision();
            let count = records.len();
            let mut accept = |edit: &SourceEdit| {
                records.push(edit.clone());
                Ok(())
            };
            match step["operation"].as_str().unwrap() {
                "select" => {
                    assert_eq!(event["method"], "didChangeSelection");
                    assert_eq!(recorded, view.text);
                    session
                        .select_utf16(expected, range(&snapshot["selected"]))
                        .unwrap();
                }
                "marked" => {
                    // These captures contain delegate storage edits, NOT setMarkedText calls.
                    assert_eq!(event["method"], "didChange");
                    assert!(event["parent"].is_null());
                    let marked = range(&snapshot["marked"]);
                    let raw = units(&snapshot["textUTF16"]);
                    let overlay = session
                        .compose_utf16(
                            expected,
                            range(&case["range"]),
                            &raw[marked.start.0..marked.end.0],
                        )
                        .unwrap();
                    let mut displayed = view.text.clone();
                    displayed
                        .replace_range(overlay.range.start.0..overlay.range.end.0, &overlay.text);
                    assert_eq!(displayed, recorded, "{name} callback {id}");
                    assert_eq!(session.revision(), expected);
                    assert_eq!(records.len(), count);
                }
                "commit" => {
                    assert_eq!(event["method"], "didChange");
                    let parent = event["parent"].as_u64().unwrap();
                    let unmark = trace["events"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|e| e["id"] == parent)
                        .unwrap();
                    assert_eq!(unmark["method"], "unmarkText");
                    assert!(snapshot["marked"].is_null());
                    view.apply(
                        session
                            .commit_composition_utf16(expected, None, &mut accept)
                            .unwrap()
                            .unwrap(),
                    );
                    assert_eq!(
                        records.len(),
                        count + 1,
                        "nested callback commits exactly once"
                    );
                }
                "typing" => {
                    let parent = event["parent"].as_u64().unwrap();
                    let insertion = trace["events"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|e| e["id"] == parent)
                        .unwrap();
                    assert_eq!(insertion["method"], "insertText");
                    assert_eq!(text(&insertion["before"]["textUTF16"]), view.text);
                    view.apply(
                        session
                            .replace_utf16(
                                expected,
                                range(&insertion["before"]["selected"]),
                                &units(&insertion["arguments"]["textUTF16"]),
                                &mut accept,
                            )
                            .unwrap(),
                    );
                    assert_eq!(records.len(), count + 1);
                }
                "replace" => {
                    assert_eq!(event["method"], "didChange");
                    assert!(snapshot["marked"].is_null());
                    if let Some(parent) = event["parent"].as_u64() {
                        let insertion = trace["events"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|e| e["id"] == parent)
                            .unwrap();
                        assert_eq!(
                            insertion["method"],
                            step.get("parentMethod")
                                .and_then(Value::as_str)
                                .unwrap_or("insertText")
                        );
                    } else {
                        // UIKit may notify selection between the actual request and
                        // didChange. Pin the recorded request rather than inventing one.
                        let request_id = step["requestEvent"].as_u64().unwrap_or(id - 1);
                        let request = trace["events"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|e| e["id"].as_u64() == Some(request_id))
                            .unwrap();
                        assert_eq!(request["method"], "shouldChangeText");
                        assert_eq!(request["returned"], true);
                        assert_eq!(request["arguments"]["range"], step["serviceRange"]);
                        assert_eq!(
                            text(&request["arguments"]["textUTF16"]),
                            step["serviceText"]
                        );
                        assert_eq!(text(&request["before"]["textUTF16"]), view.text);
                    }
                    // Korean removes the old syllable BEFORE insertText. The accepted
                    // text-service result is the didChange snapshot, not append(arguments).
                    let service_range = range(&step["serviceRange"]);
                    let inserted = step["serviceText"].as_str().unwrap();
                    let edit_range = session.display_from_utf16(expected, service_range).unwrap();
                    let mut reconstructed = view.text.clone();
                    reconstructed.replace_range(edit_range.start.0..edit_range.end.0, inserted);
                    assert_eq!(
                        reconstructed, recorded,
                        "literal service footprint matches native result"
                    );
                    view.apply(
                        session
                            .replace_os_utf16(
                                expected,
                                service_range,
                                &inserted.encode_utf16().collect::<Vec<_>>(),
                                &[],
                                &mut accept,
                            )
                            .unwrap()
                            .unwrap(),
                    );
                    assert_eq!(records.len(), count + 1);
                }
                other => panic!("unknown replay operation {other}"),
            }
            assert_eq!(
                session.source_text(),
                step["source"].as_str().unwrap(),
                "{name} callback {id}"
            );
            if step["operation"] != "marked" {
                assert_eq!(view.text, recorded, "{name} callback {id}");
                assert_eq!(
                    session
                        .display_to_utf16(session.revision(), session.selection())
                        .unwrap(),
                    range(&snapshot["selected"])
                );
            }
        }
        assert_eq!(view.text, text(&trace["current"]["textUTF16"]));
        assert_eq!(
            session
                .display_to_utf16(session.revision(), session.selection())
                .unwrap(),
            range(&trace["current"]["selected"])
        );
        assert!(session.composition().is_none());
        assert!(session
            .commit_composition_utf16(session.revision(), None, &mut |_| panic!(
                "duplicate final notification"
            ))
            .unwrap()
            .is_none());
        let history = case["history"].as_array().unwrap();
        for expected in history.iter().rev().skip(1) {
            view.apply(
                session
                    .undo(session.revision(), &mut |_| Ok(()))
                    .unwrap()
                    .unwrap(),
            );
            assert_eq!(session.source_text(), expected["source"].as_str().unwrap());
            assert_eq!(view.text, expected["display"].as_str().unwrap());
            assert_eq!(
                session
                    .display_to_utf16(session.revision(), session.selection())
                    .unwrap(),
                range(
                    expected
                        .get("undoSelection")
                        .unwrap_or(&expected["selection"])
                )
            );
        }
        assert!(session
            .undo(session.revision(), &mut |_| panic!("extra source history"))
            .unwrap()
            .is_none());
        for expected in history.iter().skip(1) {
            view.apply(
                session
                    .redo(session.revision(), &mut |_| Ok(()))
                    .unwrap()
                    .unwrap(),
            );
            assert_eq!(session.source_text(), expected["source"].as_str().unwrap());
            assert_eq!(view.text, expected["display"].as_str().unwrap());
            assert_eq!(
                session
                    .display_to_utf16(session.revision(), session.selection())
                    .unwrap(),
                range(&expected["selection"])
            );
        }
    }
}
