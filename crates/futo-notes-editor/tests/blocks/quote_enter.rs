use super::*;

fn enter(s: &mut EditorSession, v: &mut ReferenceView) {
    v.apply(
        s.paragraph_key(
            s.revision(),
            s.selection(),
            ParagraphKey::Enter,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
}

#[test]
fn quote_enter_continues_the_quote_a_line_at_a_time_and_exits_on_the_empty_line() {
    let mut s = EditorSession::open("> quote");
    let mut v = ReferenceView::new("quote");
    s.select(s.revision(), range(5, 5)).unwrap();
    enter(&mut s, &mut v);
    assert_eq!(s.source_text(), "> quote\n> ");
    assert_eq!(v.text, "quote\n");
    assert_eq!(s.selection(), range(6, 6));
    v.apply(
        s.replace(s.revision(), s.selection(), "more", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(s.source_text(), "> quote\n> more");
    assert_eq!(v.text, "quote\nmore");
    v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "> quote\n> ");
    enter(&mut s, &mut v);
    assert_eq!(s.source_text(), "> quote\n\n");
    assert_eq!(v.text, "quote\n\n");
    assert_eq!(s.selection(), range(7, 7));
    let reopened = EditorSession::open(&s.source_text());
    let projection = reopened.project(reopened.revision(), range(0, 7)).unwrap();
    assert!(projection
        .blocks
        .iter()
        .all(|b| b.range.start.0 >= 6 || b.quote_depth > 0));
    v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "> quote\n> ");
    assert_eq!(v.text, "quote\n");
}

#[test]
fn quote_enter_mid_line_and_before_a_later_line_splits_without_a_separator() {
    for (raw, shown, at, expected, display, caret) in [
        ("> ab", "ab", 1, "> a\n> b", "a\nb", 2),
        ("> a\n> b", "a\nb", 2, "> a\n> \n> b", "a\n\nb", 3),
        ("> > ab", "ab", 1, "> > a\n> > b", "a\nb", 2),
        ("> > ab", "ab", 2, "> > ab\n> > ", "ab\n", 3),
    ] {
        let mut s = EditorSession::open(raw);
        let mut v = ReferenceView::new(shown);
        s.select(s.revision(), range(at, at)).unwrap();
        enter(&mut s, &mut v);
        assert_eq!(s.source_text(), expected, "{raw:?} at {at}");
        assert_eq!(v.text, display);
        assert_eq!(s.selection(), range(caret, caret));
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
    }
}

#[test]
fn nested_quote_enter_on_an_empty_line_exits_one_level_at_a_time() {
    let mut s = EditorSession::open("> > x");
    let mut v = ReferenceView::new("x");
    s.select(s.revision(), range(1, 1)).unwrap();
    for expected in ["> > x\n> > ", "> > x\n>\n> ", "> > x\n\n"] {
        enter(&mut s, &mut v);
        assert_eq!(s.source_text(), expected);
    }
}

#[test]
fn quote_enter_at_the_end_keeps_a_following_plain_line_out_of_the_quote() {
    let mut s = EditorSession::open("> ab\nplain");
    let mut v = ReferenceView::new("ab\nplain");
    s.select(s.revision(), range(2, 2)).unwrap();
    enter(&mut s, &mut v);
    assert_eq!(s.source_text(), "> ab\n> \nplain");
    assert_eq!(v.text, "ab\n\nplain");
    let reopened = EditorSession::open(&s.source_text());
    let projection = reopened.project(reopened.revision(), range(0, 9)).unwrap();
    assert!(projection
        .blocks
        .iter()
        .all(|b| b.quote_depth == 0 || b.range.end.0 <= 3));
}
