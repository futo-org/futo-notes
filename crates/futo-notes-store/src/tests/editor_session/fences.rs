use super::*;
use futo_notes_editor::ParagraphKey;

#[test]
fn fenced_edits_pause_on_append_failure_then_recover_and_checkpoint_literal_bytes() {
    for (opening, selected, inserted, expected, display) in [
        (
            "~~~ c++ extra\r\n猫🦊\r\n~~~~  \r\n\n__tail__",
            range(3, 3),
            "!",
            "~~~ c++ extra\r\n猫!🦊\r\n~~~~  \r\n\n__tail__",
            "猫!🦊\r\n\ntail",
        ),
        (
            "```js\na\n```",
            range(0, 0),
            "```\n",
            "````js\n```\na\n````",
            "```\na\n",
        ),
        (
            "\\`\\`\\`js\n\ntail",
            range(5, 5),
            " ",
            "```js\n\n```\n\ntail",
            "\n\ntail",
        ),
    ] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "code", opening).unwrap();
        let disk = Arc::new(Mutex::new(storage::Disk::default()));
        {
            let mut editor = store
                .open_editor_with_recovery("code", storage::options(&disk))
                .unwrap();
            editor
                .select_with_affinity(Revision(0), selected, futo_notes_editor::Affinity::Forward)
                .unwrap();
            disk.lock().unwrap().fault = Some(storage::Fault::Append);
            assert!(matches!(
                editor.replace(Revision(0), selected, inserted),
                Err(EditorStoreError::RecoveryAppend(_))
            ));
            assert_eq!(editor.source_text(), opening);
            assert_eq!(editor.revision(), Revision(0));
            assert!(matches!(
                editor.replace(Revision(0), selected, inserted),
                Err(EditorStoreError::RecoveryPaused)
            ));
            disk.lock().unwrap().fault = None;
            editor.resume_recovery().unwrap();
            editor.replace(Revision(0), selected, inserted).unwrap();
            assert_eq!(editor.source_text(), expected);
            assert_eq!(editor.display_text(), display);
            editor.undo(editor.revision()).unwrap().unwrap();
            assert_eq!(editor.source_text(), opening);
            editor.redo(editor.revision()).unwrap().unwrap();
            assert_eq!(editor.source_text(), expected);
            editor.flush_recovery().unwrap();
            assert_eq!(store.read("code").unwrap(), opening);
        }
        let mut recovered = store
            .open_editor_with_recovery("code", storage::options(&disk))
            .unwrap();
        assert_eq!(recovered.source_text(), expected);
        assert_eq!(recovered.display_text(), display);
        assert!(recovered.undo(recovered.revision()).unwrap().is_none());
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("code").unwrap(), expected);
        drop(recovered);
        assert_eq!(store.open_editor("code").unwrap().source_text(), expected);
    }
}

#[test]
fn nested_code_enter_recovery_preserves_all_container_and_fence_spelling() {
    let root = TestRoot::new();
    let store = store(&root);
    let opening = "> ~~~~Rust info\r\n> ab\r\n> ~~~~~ \r\n\nend";
    store.create("", "code", opening).unwrap();
    {
        let mut editor = store.open_editor("code").unwrap();
        editor
            .paragraph_key_utf16(
                Revision(0),
                futo_notes_editor::DisplayUtf16Range {
                    start: futo_notes_editor::DisplayUtf16Offset(1),
                    end: futo_notes_editor::DisplayUtf16Offset(1),
                },
                ParagraphKey::Enter,
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            editor.source_text(),
            "> ~~~~Rust info\r\n> a\n> b\r\n> ~~~~~ \r\n\nend"
        );
        editor.flush_recovery().unwrap();
    }
    let mut recovered = store.open_editor("code").unwrap();
    assert_eq!(recovered.display_text(), "a\nb\r\n\nend");
    recovered.checkpoint().unwrap();
    assert_eq!(
        store.read("code").unwrap(),
        "> ~~~~Rust info\r\n> a\n> b\r\n> ~~~~~ \r\n\nend"
    );
}
