use super::*;

#[test]
fn active_composition_survives_own_relink_with_exact_source_and_new_identity() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "[[old]]").unwrap();
    let mut editor = store.open_editor("old").unwrap();
    editor.compose(Revision(0), range(7, 7), "にほん").unwrap();
    let mutation = store.rename("old", "long name").unwrap();
    assert_eq!(mutation.relinked, ["long name"]);
    assert_eq!(editor.id(), "long name");
    assert!(editor.take_coordinated_changes().unwrap().is_empty());
    assert_eq!(editor.source_text(), "[[old]]\n");
    assert_eq!(editor.composition().unwrap().text, "にほん");
    let change = editor
        .commit_composition(Revision(0), Some("日本"))
        .unwrap()
        .unwrap();
    let mut view = "[[old]]".to_owned();
    view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
    assert_eq!(view, "[[old]]日本");
    assert_eq!(editor.source_text(), "[[old]]日本\n");
    assert_eq!(
        editor.checkpoint().unwrap().disposition,
        FlushDisposition::Wrote
    );
    assert_eq!(store.read("long name").unwrap(), "[[old]]日本\n");
    editor.undo(Revision(1)).unwrap().unwrap();
    assert_eq!(editor.source_text(), "[[old]]\n");
    assert_eq!(store.read_existing("old").unwrap(), None);
}

#[test]
fn marked_text_is_not_recovered_but_final_correction_is_exact_and_protected() {
    let root = TestRoot::new();
    let store = store(&root);
    store
        .create("", "input", "teh __middle__ & wrng\r\n")
        .unwrap();
    {
        let mut editor = store.open_editor("input").unwrap();
        editor.compose(Revision(0), range(0, 3), "discard").unwrap();
        assert_eq!(editor.source_text(), "teh __middle__ & wrng\r\n");
    }
    {
        let mut editor = store.open_editor("input").unwrap();
        assert_eq!(editor.revision(), Revision(0));
        editor.compose(Revision(0), range(0, 3), "teh").unwrap();
        editor
            .commit_composition(Revision(0), Some("the"))
            .unwrap()
            .unwrap();
        editor
            .replace_os(
                editor.revision(),
                range(0, 19),
                "the middle & wrong\r\n",
                &[],
            )
            .unwrap()
            .unwrap();
        assert_eq!(editor.source_text(), "the __middle__ & wrong\r\n");
        editor.undo(editor.revision()).unwrap().unwrap();
        assert_eq!(editor.source_text(), "the __middle__ & wrng\r\n");
        editor.redo(editor.revision()).unwrap().unwrap();
        editor.checkpoint().unwrap();
    }
    let mut recovered = store.open_editor("input").unwrap();
    assert_eq!(recovered.source_text(), "the __middle__ & wrong\r\n");
    recovered.checkpoint().unwrap();
    assert_eq!(
        store.read("input").unwrap(),
        "the __middle__ & wrong\r\n"
    );
}

#[test]
fn implicit_commit_and_paragraph_key_keep_the_separate_history_result() {
    use futo_notes_editor::ParagraphKey;
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "input", "__a__ tail\r\n").unwrap();
    {
        let mut editor = store.open_editor("input").unwrap();
        editor.compose(Revision(0), range(1, 1), "日").unwrap();
        editor
            .paragraph_key_utf16(
                Revision(0),
                futo_notes_editor::DisplayUtf16Range {
                    start: futo_notes_editor::DisplayUtf16Offset(2),
                    end: futo_notes_editor::DisplayUtf16Offset(2),
                },
                ParagraphKey::Enter,
            )
            .unwrap()
            .unwrap();
        assert_eq!(editor.source_text(), "__a日__\r\n tail\r\n");
        assert_eq!(editor.revision(), Revision(1));
        editor.undo(Revision(1)).unwrap().unwrap();
        assert_eq!(editor.source_text(), "__a日__ tail\r\n");
        editor.checkpoint().unwrap();
    }
    let mut editor = store.open_editor("input").unwrap();
    assert_eq!(editor.source_text(), "__a日__ tail\r\n");
    assert_eq!(editor.revision(), Revision(0));
    assert!(editor.undo(Revision(0)).unwrap().is_none());
    editor.checkpoint().unwrap();
    assert_eq!(store.read("input").unwrap(), "__a日__ tail\r\n");
}
