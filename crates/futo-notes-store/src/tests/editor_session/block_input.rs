use super::*;
use futo_notes_editor::{InlineFormat, InputAction};

struct FixedClock;
impl RecoveryClock for FixedClock {
    fn now(&self) -> Duration {
        Duration::from_millis(10)
    }
}

#[test]
fn repaired_ordinary_input_groups_survive_failed_append_and_recover_exact_source() {
    let cases: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../futo-notes-editor/tests/fixtures/structural-seams.json"
    ))
    .unwrap();
    let cases: Vec<_> = cases
        .as_array()
        .unwrap()
        .iter()
        .filter(|case| case["mode"] == "typing_sequence")
        .collect();
    assert_eq!(cases.len(), 10);
    for case in cases {
        let text = |key: &str| case[key].as_str().unwrap();
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "typing", text("source")).unwrap();
        let disk = Arc::new(Mutex::new(storage::Disk::default()));
        let options = || RecoveryOptions {
            clock: Arc::new(FixedClock),
            ..storage::options(&disk)
        };
        {
            let mut session = store
                .open_editor_with_recovery("typing", options())
                .unwrap();
            if let Some(format) = case["format"].as_str() {
                assert!(session
                    .toggle_format(
                        session.revision(),
                        serde_json::from_value::<InlineFormat>(format.into()).unwrap()
                    )
                    .unwrap()
                    .is_none());
            }
            let opening_formats = session.active_formats();
            for input in case["inputs"].as_array().unwrap() {
                let source = session.source_text();
                let revision = session.revision();
                let selection = session.selection();
                let formats = session.active_formats();
                let inserted = input[1].as_str().unwrap();
                let action: InputAction = serde_json::from_value(input[0].clone()).unwrap();
                disk.lock().unwrap().fault = Some(storage::Fault::Append);
                assert!(matches!(
                    session.replace_action(revision, selection, inserted, action),
                    Err(EditorStoreError::RecoveryAppend(_))
                ));
                assert_eq!(session.source_text(), source);
                assert_eq!(session.revision(), revision);
                assert_eq!(session.selection(), selection);
                assert_eq!(session.active_formats(), formats);
                assert!(session.recovery_status().paused);
                disk.lock().unwrap().fault = None;
                session.resume_recovery().unwrap();
                session
                    .replace_action(revision, selection, inserted, action)
                    .unwrap();
            }
            assert_eq!(session.source_text(), text("expectedSource"));
            assert_eq!(session.display_text(), text("expectedDisplay"));
            let caret = case["caret"].as_u64().unwrap() as usize;
            assert_eq!(session.selection(), range(caret, caret));
            let revision = session.revision();
            disk.lock().unwrap().fault = Some(storage::Fault::Append);
            assert!(matches!(
                session.undo(revision),
                Err(EditorStoreError::RecoveryAppend(_))
            ));
            assert_eq!(session.source_text(), text("expectedSource"));
            assert_eq!(session.revision(), revision);
            disk.lock().unwrap().fault = None;
            session.resume_recovery().unwrap();
            for _ in 0..case["history"].as_u64().unwrap() {
                session.undo(session.revision()).unwrap().unwrap();
            }
            assert_eq!(session.source_text(), text("source"), "{}", text("name"));
            assert_eq!(session.display_text(), text("display"));
            assert_eq!(session.selection(), range(0, 0));
            assert_eq!(session.active_formats(), opening_formats);
            assert!(session.undo(session.revision()).unwrap().is_none());
            for _ in 0..case["history"].as_u64().unwrap() {
                session.redo(session.revision()).unwrap().unwrap();
            }
            assert_eq!(session.source_text(), text("expectedSource"));
            assert_eq!(session.active_formats(), opening_formats);
            session.flush_recovery().unwrap();
        }
        disk.lock().unwrap().power_loss();
        let mut recovered = store
            .open_editor_with_recovery("typing", options())
            .unwrap();
        assert_eq!(recovered.source_text(), text("expectedSource"));
        assert_eq!(recovered.display_text(), text("expectedDisplay"));
        assert!(recovered.undo(recovered.revision()).unwrap().is_none());
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("typing").unwrap(), text("expectedSource"));
        drop(recovered);
        assert_eq!(
            store.open_editor("typing").unwrap().source_text(),
            text("expectedSource")
        );
    }
}
