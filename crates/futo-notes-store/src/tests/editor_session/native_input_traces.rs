use super::*;
use futo_notes_editor::{DisplayUtf16Offset, DisplayUtf16Range};
use serde_json::Value;

fn read(name: &str) -> Value {
    let file = format!(
        "{}/../../tests/fixtures/editor-native-input/{name}.json",
        env!("CARGO_MANIFEST_DIR")
    );
    serde_json::from_str(&fs::read_to_string(file).unwrap()).unwrap()
}
fn units(value: &Value) -> Vec<u16> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|v| u16::try_from(v.as_u64().unwrap()).unwrap())
        .collect()
}
fn range16(value: &Value) -> DisplayUtf16Range {
    DisplayUtf16Range {
        start: DisplayUtf16Offset(value[0].as_u64().unwrap() as usize),
        end: DisplayUtf16Offset(value[1].as_u64().unwrap() as usize),
    }
}

/// History grouping never expires, so the 500 ms boundary cannot flake under load.
struct FrozenClock;
impl EditorClock for FrozenClock {
    fn now(&self) -> Duration {
        Duration::ZERO
    }
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
fn captured_native_results_keep_only_commits_in_the_draft_and_checkpoint() {
    let cases = read("native-input-cases");
    assert_eq!(cases.as_array().unwrap().len(), 6);
    for case in cases.as_array().unwrap() {
        let root = TestRoot::new();
        let store = store(&root);
        let source = case["source"].as_str().unwrap();
        let trace = read_trace(case["name"].as_str().unwrap());
        store.create("", "input", source).unwrap();
        let final_source;
        {
            let mut editor = store
                .open_editor_with_clock("input", Arc::new(FrozenClock))
                .unwrap();
            let mut view = case["display"].as_str().unwrap().to_owned();
            let history = case["history"].as_array().unwrap();
            for step in case["steps"].as_array().unwrap() {
                let event = trace["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|e| e["id"] == step["event"])
                    .unwrap();
                let snapshot = &event["after"];
                let revision = editor.revision();
                let delta = match step["operation"].as_str().unwrap() {
                    "select" => {
                        editor
                            .select_utf16(revision, range16(&snapshot["selected"]))
                            .unwrap();
                        None
                    }
                    "marked" => {
                        let marked = range16(&snapshot["marked"]);
                        let raw = units(&snapshot["textUTF16"]);
                        let overlay = editor
                            .compose_utf16(
                                revision,
                                range16(&case["range"]),
                                &raw[marked.start.0..marked.end.0],
                            )
                            .unwrap();
                        let mut provisional = view.clone();
                        provisional.replace_range(
                            overlay.range.start.0..overlay.range.end.0,
                            &overlay.text,
                        );
                        assert_eq!(provisional, String::from_utf16(&raw).unwrap());
                        assert_eq!(editor.revision(), revision);
                        assert_eq!(store.read("input").unwrap(), source);
                        None
                    }
                    "typing" => {
                        let parent = trace["events"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|e| e["id"] == event["parent"])
                            .unwrap();
                        Some(
                            editor
                                .replace_utf16(
                                    revision,
                                    range16(&parent["before"]["selected"]),
                                    &units(&parent["arguments"]["textUTF16"]),
                                )
                                .unwrap(),
                        )
                    }
                    "commit" => editor.commit_composition_utf16(revision, None).unwrap(),
                    "replace" => editor
                        .replace_os_utf16(
                            revision,
                            range16(&step["serviceRange"]),
                            &step["serviceText"]
                                .as_str()
                                .unwrap()
                                .encode_utf16()
                                .collect::<Vec<_>>(),
                            &[],
                        )
                        .unwrap(),
                    _ => panic!("unknown trace operation"),
                };
                if let Some(delta) = delta {
                    view.replace_range(delta.range.start.0..delta.range.end.0, &delta.inserted);
                    assert_eq!(editor.revision().0, revision.0 + 1);
                    assert_eq!(
                        editor
                            .display_to_utf16(editor.revision(), editor.selection())
                            .unwrap(),
                        range16(&snapshot["selected"])
                    );
                    assert_eq!(
                        view,
                        String::from_utf16(&units(&snapshot["textUTF16"])).unwrap()
                    );
                }
                assert_eq!(editor.source_text(), step["source"].as_str().unwrap());
            }
            for expected in history.iter().rev().skip(1) {
                let delta = editor.undo(editor.revision()).unwrap().unwrap();
                view.replace_range(delta.range.start.0..delta.range.end.0, &delta.inserted);
                assert_eq!(editor.source_text(), expected["source"].as_str().unwrap());
                assert_eq!(view, expected["display"].as_str().unwrap());
                assert_eq!(
                    editor
                        .display_to_utf16(editor.revision(), editor.selection())
                        .unwrap(),
                    range16(
                        expected
                            .get("undoSelection")
                            .unwrap_or(&expected["selection"])
                    )
                );
            }
            for expected in history.iter().skip(1) {
                let delta = editor.redo(editor.revision()).unwrap().unwrap();
                view.replace_range(delta.range.start.0..delta.range.end.0, &delta.inserted);
                assert_eq!(editor.source_text(), expected["source"].as_str().unwrap());
                assert_eq!(view, expected["display"].as_str().unwrap());
                assert_eq!(
                    editor
                        .display_to_utf16(editor.revision(), editor.selection())
                        .unwrap(),
                    range16(&expected["selection"])
                );
            }
            assert!(editor
                .commit_composition_utf16(editor.revision(), None)
                .unwrap()
                .is_none());
            editor.checkpoint().unwrap();
            final_source = case["steps"].as_array().unwrap().last().unwrap()["source"]
                .as_str()
                .unwrap()
                .to_owned();
        }
        let mut recovered = store.open_editor("input").unwrap();
        assert_eq!(recovered.source_text(), final_source);
        assert!(recovered.composition().is_none());
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("input").unwrap(), final_source);
        drop(recovered);
        assert_eq!(
            store.open_editor("input").unwrap().source_text(),
            final_source
        );
    }
}
