use super::*;

#[test]
fn supported_alternate_markers_keep_lists_apart_when_a_neighbor_style_is_free() {
    for (raw, at, command, expected, shown) in [
        (
            "9. before\n\n* a\n* b",
            8,
            BlockCommand::OrderedList,
            "9. before\n\n1) a\n2) b",
            "before\n\na\nb",
        ),
        (
            "* a\n* b\n\n9. after",
            0,
            BlockCommand::OrderedList,
            "1) a\n2) b\n\n9. after",
            "a\nb\n\nafter",
        ),
        (
            "- before\n\n1. a\n2. b\n\n+ after",
            8,
            BlockCommand::BulletList,
            "- before\n\n* a\n* b\n\n+ after",
            "before\n\na\nb\n\nafter",
        ),
    ] {
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(shown);
        view.apply(
            s.block_command(s.revision(), range(at, at), command, &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, shown);
        assert_eq!(EditorSession::open(expected).display_text(), shown);
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
    }
}

#[test]
fn conflicting_neighbors_merge_the_following_list_without_writing_a_comment() {
    // Both delimiters are taken, so the new list joins the one below it:
    // its items keep 1 and 2 and the untouched `7.` item is renumbered 3.
    let raw = "9) before\n\n* a\n* b\n\n7. after";
    let expected = "9) before\n\n1. a\n2. b\n\n7. after";
    let shown = "before\n\na\nb\n\nafter";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new(shown);
    view.apply(
        s.block_command(
            s.revision(),
            range(8, 8),
            BlockCommand::OrderedList,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), expected);
    assert_eq!(view.text, shown);
    assert_eq!(EditorSession::open(expected).display_text(), shown);
    let fresh = EditorSession::open(expected);
    let items: Vec<_> = fresh
        .project(fresh.revision(), range(0, shown.len()))
        .unwrap()
        .blocks
        .into_iter()
        .filter_map(|block| {
            block
                .list
                .filter(|list| list.first)
                .map(|list| list.number())
        })
        .collect();
    assert_eq!(items, [Some(9), Some(1), Some(2), Some(3)]);
}

#[test]
fn authored_empty_comments_show_as_text_and_survive_body_edits() {
    let raw = "1. __a__\r\n\r\n<!---->\r\n\r\n8. b\r\n1. c";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new("a\r\n\r\n<!---->\r\n\r\nb\r\nc");
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.display_text(), view.text);
    view.apply(
        s.replace(s.revision(), range(17, 17), "!", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(
        s.source_text(),
        "1. __a__\r\n\r\n<!---->\r\n\r\n8. b!\r\n1. c"
    );
    assert_eq!(view.text, "a\r\n\r\n<!---->\r\n\r\nb!\r\nc");
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    for (raw, shown) in [
        (
            "<!-- keep -->\r\n<div>keep</div>\r\n<!----> suffix\r\n",
            "<!-- keep -->\r\n<div>keep</div>\r\n<!----> suffix\r\n",
        ),
        ("ab <!-- --> cd", "ab <!-- --> cd"),
        ("`<!-- -->`", "<!-- -->"),
        ("<!---->", "<!---->"),
    ] {
        let s = EditorSession::open(raw);
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.display_text(), shown);
    }
}
