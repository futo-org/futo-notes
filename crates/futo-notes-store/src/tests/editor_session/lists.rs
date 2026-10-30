use super::*;
use futo_notes_editor::{DisplayUtf16Offset, DisplayUtf16Range, ParagraphKey};

fn native(at: usize) -> DisplayUtf16Range {
    DisplayUtf16Range {
        start: DisplayUtf16Offset(at),
        end: DisplayUtf16Offset(at),
    }
}

#[test]
fn list_keys_protect_exact_history_and_recover_after_append_failures_and_flush() {
    for (opening, shown, at, expected, display, caret) in [
        (
            "* __ab__\r\n\r\n+ keep",
            "ab\r\n\r\nkeep",
            1,
            "* __a__\n* __b__\r\n\r\n+ keep",
            "a\nb\r\n\r\nkeep",
            2,
        ),
        (
            "- [X] done\r\n\r\n+ keep",
            "done\r\n\r\nkeep",
            0,
            "- [ ] \n- [X] done\r\n\r\n+ keep",
            "\ndone\r\n\r\nkeep",
            1,
        ),
        (
            "* a\r\n* \r\n* b",
            "a\r\n\r\nb",
            3,
            "* a\r\n\r\n<!-- -->\n* b",
            "a\r\n\r\nb",
            3,
        ),
        (
            "9. a\n1. b\n\n* keep",
            "a\nb\n\nkeep",
            1,
            "9. a\n10. \n11. b\n\n* keep",
            "a\n\nb\n\nkeep",
            2,
        ),
    ] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "lists", opening).unwrap();
        let disk = Arc::new(Mutex::new(storage::Disk::default()));
        {
            let mut editor = store
                .open_editor_with_recovery("lists", storage::options(&disk))
                .unwrap();
            assert_eq!(editor.display_text(), shown);
            editor.select_utf16(Revision(0), native(at)).unwrap();
            disk.lock().unwrap().fault = Some(storage::Fault::Append);
            assert!(matches!(
                editor.paragraph_key_utf16(Revision(0), native(at), ParagraphKey::Enter),
                Err(EditorStoreError::RecoveryAppend(_))
            ));
            assert_eq!(editor.source_text(), opening);
            assert_eq!(editor.revision(), Revision(0));
            assert!(matches!(
                editor.paragraph_key_utf16(Revision(0), native(at), ParagraphKey::Enter),
                Err(EditorStoreError::RecoveryPaused)
            ));
            disk.lock().unwrap().fault = None;
            editor.resume_recovery().unwrap();
            let change = editor
                .paragraph_key_utf16(Revision(0), native(at), ParagraphKey::Enter)
                .unwrap()
                .unwrap();
            let mut view = shown.to_owned();
            view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
            assert_eq!(view, display);
            assert_eq!(editor.source_text(), expected);
            assert_eq!(editor.selection(), range(caret, caret));
            disk.lock().unwrap().fault = Some(storage::Fault::Append);
            assert!(matches!(
                editor.undo(editor.revision()),
                Err(EditorStoreError::RecoveryAppend(_))
            ));
            assert_eq!(editor.source_text(), expected);
            disk.lock().unwrap().fault = None;
            editor.resume_recovery().unwrap();
            editor.undo(editor.revision()).unwrap().unwrap();
            assert_eq!(editor.source_text(), opening);
            assert_eq!(editor.selection(), range(at, at));
            editor.redo(editor.revision()).unwrap().unwrap();
            assert_eq!(editor.source_text(), expected);
            assert_eq!(store.read("lists").unwrap(), opening);
            assert_eq!(editor.flush_recovery().unwrap().durable, editor.revision());
        }
        disk.lock().unwrap().power_loss();
        let mut recovered = store
            .open_editor_with_recovery("lists", storage::options(&disk))
            .unwrap();
        assert_eq!(recovered.source_text(), expected);
        assert_eq!(recovered.display_text(), display);
        assert!(recovered.undo(recovered.revision()).unwrap().is_none());
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("lists").unwrap(), expected);
        drop(recovered);
        assert_eq!(store.open_editor("lists").unwrap().source_text(), expected);
    }
}
