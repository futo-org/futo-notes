use super::*;

#[test]
fn marked_text_is_not_recovered_but_final_correction_is_exact_and_protected() {
    let root = TestRoot::new();
    let store = store(&root);
    store
        .create("", "input", "teh __middle__ &amp; wrng\r\n")
        .unwrap();
    {
        let mut editor = store.open_editor("input").unwrap();
        editor.compose(Revision(0), range(0, 3), "discard").unwrap();
        assert_eq!(editor.source_text(), "teh __middle__ &amp; wrng\r\n");
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
        assert_eq!(editor.source_text(), "the __middle__ &amp; wrong\r\n");
        editor.undo(editor.revision()).unwrap().unwrap();
        assert_eq!(editor.source_text(), "the __middle__ &amp; wrng\r\n");
        editor.redo(editor.revision()).unwrap().unwrap();
        editor.flush_recovery().unwrap();
    }
    let mut recovered = store.open_editor("input").unwrap();
    assert_eq!(recovered.source_text(), "the __middle__ &amp; wrong\r\n");
    recovered.checkpoint().unwrap();
    assert_eq!(
        store.read("input").unwrap(),
        "the __middle__ &amp; wrong\r\n"
    );
}
