use super::*;

#[test]
fn backspace_can_empty_a_nested_item_before_a_sibling() {
    let mut s = EditorSession::open("- What about\n  - Nested\n  - Elements");
    let end = s.display_text().find("Nested").unwrap() + 6;
    s.select(s.revision(), range(end, end)).unwrap();
    for letter in 0..6 {
        if letter == 5 {
            let before = s.source_text();
            let revision = s.revision();
            assert!(matches!(
                s.paragraph_key(
                    revision,
                    s.selection(),
                    ParagraphKey::Backspace,
                    &mut |_| Err("append refused".into())
                ),
                Err(EditorError::Persistence(_))
            ));
            assert_eq!(s.source_text(), before);
            assert_eq!(s.revision(), revision);
        }
        s.paragraph_key(
            s.revision(),
            s.selection(),
            ParagraphKey::Backspace,
            &mut |_| Ok(()),
        )
        .unwrap()
        .expect("delete the next letter");
    }
    assert_eq!(s.source_text(), "- What about\n  - \n  - Elements");
    s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(s.source_text(), "- What about\n  - N\n  - Elements");
    s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(s.source_text(), "- What about\n  - \n  - Elements");
}
