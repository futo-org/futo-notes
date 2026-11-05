use super::*;

/// Enter at a nonempty item's text start opens an empty item of the same list
/// above it (unchecked for a task) and keeps the caret on the original text,
/// as Google Docs and Notion do; ordered lists renumber. One Undo restores the
/// exact source and selection.
#[test]
fn enter_at_an_items_text_start_opens_an_empty_item_above() {
    for (raw, at, expected, caret) in [
        (
            "1. first step\n2. second step",
            11,
            "1. first step\n2. \n3. second step",
            12,
        ),
        ("- a\n- b", 2, "- a\n- \n- b", 3),
        ("* a\n* b\n* c", 2, "* a\n* \n* b\n* c", 3),
        ("- [ ] a\n- [ ] b", 2, "- [ ] a\n- [ ] \n- [ ] b", 3),
        ("- [x] a\n- [x] b", 2, "- [x] a\n- [ ] \n- [x] b", 3),
        ("- a\n  - b\n  - c", 4, "- a\n  - b\n  - \n  - c", 5),
        ("> - a\n> - b", 2, "> - a\n> - \n> - b", 3),
        ("> 1. a\n> 2. b", 2, "> 1. a\n> 2. \n> 3. b", 3),
        ("5) ab\n1) keep", 0, "5) \n6) ab\n1) keep", 1),
        ("- a", 0, "- \n- a", 1),
        // A new root item takes its list's indented marker column.
        ("  - a\n  - b", 2, "  - a\n  - \n  - b", 3),
        ("- a\r\n- b\r\n", 3, "- a\r\n- \r\n- b\r\n", 5),
    ] {
        let mut s = EditorSession::open(raw);
        let opening = s.display_text();
        let mut view = ReferenceView::new(&opening);
        let selected = range(at, at);
        s.select(s.revision(), selected).unwrap();
        view.apply(
            s.paragraph_key(s.revision(), selected, ParagraphKey::Enter, &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(s.source_text(), expected, "{raw:?}");
        assert_eq!(view.text, EditorSession::open(expected).display_text());
        assert_eq!(s.selection(), range(caret, caret), "{raw:?}");
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(view.text, opening);
        assert_eq!(s.selection(), selected);
        assert!(s.undo(s.revision(), &mut |_| Ok(())).unwrap().is_none());
    }
}

/// An empty item cannot interrupt a paragraph, so an item opened above the
/// first item under text gets the separating blank line a list command gives;
/// the original item and its list are unchanged.
#[test]
fn enter_at_the_first_items_text_start_under_text_keeps_the_list() {
    for (raw, at, expected) in [
        ("para\n- a", 5, "para\n\n- \n- a"),
        ("- a\n  - b", 2, "- a\n\n  - \n  - b"),
    ] {
        let mut s = EditorSession::open(raw);
        let selected = range(at, at);
        s.select(s.revision(), selected).unwrap();
        s.paragraph_key(s.revision(), selected, ParagraphKey::Enter, &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(s.source_text(), expected, "{raw:?}");
        let display = s.display_text();
        let caret = s.selection().start.0;
        assert!(
            display[caret..].starts_with(&raw[raw.len() - 1..]),
            "{raw:?}"
        );
        s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), selected);
    }
}
