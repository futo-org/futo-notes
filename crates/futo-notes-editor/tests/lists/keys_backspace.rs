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
    assert_eq!(s.source_text(), "- What about\n\n  - \n  - Elements");
    s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(s.source_text(), "- What about\n  - N\n  - Elements");
    s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(s.source_text(), "- What about\n\n  - \n  - Elements");
}

#[test]
fn list_backspace_lifts_the_first_item_and_selected_enter_is_one_action() {
    for (raw, selected, key, expected, shown, caret) in [
        (
            "* ab\n* cd",
            range(0, 0),
            ParagraphKey::Backspace,
            "ab\n* cd",
            "ab\ncd",
            0,
        ),
        (
            "* ab\n* cd",
            range(1, 4),
            ParagraphKey::Enter,
            "* a\n* d",
            "a\nd",
            2,
        ),
        (
            "5) ab\n1) cd\n1) tail",
            range(1, 4),
            ParagraphKey::Enter,
            "5) a\n6) d\n7) tail",
            "a\nd\ntail",
            2,
        ),
        (
            "- [X] 🦊done",
            range(0, 0),
            ParagraphKey::Delete,
            "- [X] done",
            "done",
            0,
        ),
    ] {
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(&s.display_text());
        s.select(s.revision(), selected).unwrap();
        let mut accepted = 0;
        view.apply(
            s.paragraph_key(s.revision(), selected, key, &mut |_| {
                accepted += 1;
                Ok(())
            })
            .unwrap()
            .unwrap(),
        );
        assert_eq!(accepted, 1);
        assert_eq!(s.source_text(), expected, "{raw:?}");
        assert_eq!(view.text, shown);
        assert_eq!(s.selection(), range(caret, caret));
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), selected);
    }
}

#[test]
fn nested_backspace_retires_the_item_into_the_immediate_preceding_container() {
    for (raw, shown, caret, expected) in [
        ("- a\n  - b", "a\nb", 2, "- a\n  b"),
        ("- a\n  - b\n  - c", "a\nb\nc", 2, "- a\n  b\n  - c"),
        ("- a\n  - x\n  - b", "a\nx\nb", 4, "- a\n  - x\n    b"),
    ] {
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(shown);
        s.select(s.revision(), range(caret, caret)).unwrap();
        view.apply(
            s.paragraph_key(
                s.revision(),
                range(caret, caret),
                ParagraphKey::Backspace,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
        );
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, shown);
        assert_eq!(s.selection(), range(caret, caret));
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), range(caret, caret));
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
    }
}

#[test]
fn ambiguous_empty_nested_marker_remains_a_setext_heading() {
    let s = EditorSession::open("- a\n  - ");
    assert_eq!(s.display_text(), "a");
    let p = s.project(s.revision(), range(0, 1)).unwrap();
    assert_eq!(p.blocks[0].heading, 2);
}

#[test]
fn nested_backspace_preserves_outer_quotes_and_a_second_key_joins_the_continuation() {
    for (raw, shown, at, expected, final_source, final_display) in [
        ("- a\n  - b", "a\nb", 2, "- a\n  b", "- ab", "ab"),
        (
            "> - a\r\n>   - 🦊b",
            "a\r\n🦊b",
            3,
            "> - a\r\n>   🦊b",
            "> - a🦊b",
            "a🦊b",
        ),
    ] {
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(shown);
        let selected = range(at, at);
        s.select(s.revision(), selected).unwrap();
        view.apply(
            s.paragraph_key(s.revision(), selected, ParagraphKey::Backspace, &mut |_| {
                Ok(())
            })
            .unwrap()
            .unwrap(),
        );
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, shown);
        view.apply(
            s.paragraph_key(
                s.revision(),
                s.selection(),
                ParagraphKey::Backspace,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
        );
        assert_eq!(s.source_text(), final_source);
        assert_eq!(view.text, final_display);
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), selected);
    }
}
