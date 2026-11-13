//! Real recovery acceptance owns every transient typing-origin transition.
use super::*;

#[test]
fn recovery_of_an_unfinished_www_word_does_not_restore_its_typing_origin() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "typed-recover", "").unwrap();
    let mut editor = store.open_editor("typed-recover").unwrap();
    for ch in "<www.x.test/path".chars() {
        let at = editor.display_text().len();
        editor
            .replace(editor.revision(), range(at, at), &ch.to_string())
            .unwrap();
    }
    editor.checkpoint().unwrap();
    drop(editor);
    let mut recovered = store.open_editor("typed-recover").unwrap();
    assert_eq!(recovered.source_text(), "<www.x.test/path");
    recovered
        .replace(recovered.revision(), range(16, 16), ">")
        .unwrap();
    recovered
        .replace(recovered.revision(), range(17, 17), " ")
        .unwrap();
    assert_eq!(recovered.display_text(), "<www.x.test/path> ");
    assert!(recovered
        .project(recovered.revision(), range(0, 18))
        .unwrap()
        .links
        .is_empty());
}
