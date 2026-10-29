use super::*;
use futo_notes_editor::{
    CaretDirection, DisplayOffset, DisplayRange, DisplayUtf16Offset, DisplayUtf16Range,
    EditorError, Revision,
};

fn native(start: usize, end: usize) -> DisplayUtf16Range {
    DisplayUtf16Range {
        start: DisplayUtf16Offset(start),
        end: DisplayUtf16Offset(end),
    }
}

#[test]
fn unicode_native_edits_history_recovery_and_checkpoint_preserve_exact_bytes() {
    let root = TestRoot::new();
    let store = store(&root);
    let original = "😀e\u{301}日\r\n한\rن\n";
    store.create("", "unicode", original).unwrap();
    {
        let mut editor = store.open_editor("unicode").unwrap();
        editor.select_utf16(Revision(0), native(0, 5)).unwrap();
        editor
            .replace_utf16(
                Revision(0),
                native(0, 5),
                &"👩🏽\u{200d}💻中文".encode_utf16().collect::<Vec<_>>(),
            )
            .unwrap();
        editor.undo(Revision(1)).unwrap().unwrap();
        assert_eq!(editor.source_text(), original);
        assert_eq!(
            editor.selection(),
            DisplayRange {
                start: DisplayOffset(0),
                end: DisplayOffset(10)
            }
        );
        editor.redo(Revision(2)).unwrap().unwrap();
        editor
            .replace_utf16(Revision(3), native(11, 12), &[0x65E5, 0x672C])
            .unwrap();
        assert_eq!(editor.source_text(), "👩🏽\u{200d}💻中文\r\n日本\rن\n");
        assert_eq!(
            editor.replace_utf16(Revision(4), native(1, 1), &[0x61]),
            Err(EditorStoreError::Editor(EditorError::InvalidRange))
        );
        assert_eq!(
            editor.replace_utf16(Revision(4), native(0, 0), &[0xD800]),
            Err(EditorStoreError::Editor(EditorError::InvalidText))
        );
        assert_eq!(
            editor.move_caret(Revision(3), CaretDirection::Forward),
            Err(EditorStoreError::Editor(EditorError::StaleRevision {
                expected: Revision(3),
                actual: Revision(4)
            }))
        );
    }
    assert_eq!(store.read("unicode").unwrap(), original);
    let mut recovered = store.open_editor("unicode").unwrap();
    assert_eq!(recovered.source_text(), "👩🏽\u{200d}💻中文\r\n日本\rن\n");
    assert_eq!(recovered.revision(), Revision(4));
    assert_eq!(
        recovered.checkpoint().unwrap().disposition,
        FlushDisposition::Wrote
    );
    assert_eq!(
        store.read("unicode").unwrap(),
        "👩🏽\u{200d}💻中文\r\n日本\rن\n"
    );
    drop(recovered);
    let reopened = store.open_editor("unicode").unwrap();
    assert_eq!(reopened.source_text(), "👩🏽\u{200d}💻中文\r\n日本\rن\n");
    assert_eq!(reopened.revision(), Revision(0));
}

#[test]
fn selection_only_native_callbacks_do_not_write_notes_or_recovery() {
    let root = TestRoot::new();
    let observer = Arc::new(RecordingObserver::default());
    let store = LocalNoteStore::with_before_write(root.0.clone(), observer.clone());
    store.create("", "unicode", "a😀e\u{301}日\r\n").unwrap();
    observer.0.lock().unwrap().clear();
    {
        let mut editor = store.open_editor("unicode").unwrap();
        editor.select_utf16(Revision(0), native(1, 3)).unwrap();
        let selection = editor
            .move_caret(Revision(0), CaretDirection::Forward)
            .unwrap();
        assert_eq!(
            selection.selection,
            DisplayRange {
                start: DisplayOffset(5),
                end: DisplayOffset(5)
            }
        );
        assert_eq!(selection.revision, Revision(0));
        assert!(editor.undo(Revision(0)).unwrap().is_none());
    }
    assert_eq!(store.read("unicode").unwrap(), "a😀e\u{301}日\r\n");
    assert!(observer.0.lock().unwrap().is_empty());
    assert_eq!(fs::read_dir(&root.0).unwrap().count(), 1);
}
