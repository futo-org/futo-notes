use super::*;

#[test]
fn supported_alternate_markers_avoid_comments_when_a_neighbor_style_is_free() {
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
fn quoted_crlf_conflicting_lists_keep_exact_bodies_and_one_reversible_empty_comment() {
    let raw = "> 9. before\r\n> \r\n> * __a__\r\n> * b\r\n> \r\n> 7) after";
    let expected = "> 9. before\r\n> \r\n> 1) __a__\r\n> 2) b\r\n> <!-- -->\r\n> \r\n> 7) after";
    let shown = "before\r\n\r\na\r\nb\r\n\r\nafter";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new(shown);
    s.select(s.revision(), range(10, 10)).unwrap();
    assert_eq!(s.display_text(), shown);
    let initial = s.project(s.revision(), range(0, shown.len())).unwrap();
    let shape: Vec<_> = initial
        .blocks
        .into_iter()
        .filter_map(|block| {
            block
                .list
                .filter(|list| list.first)
                .map(|list| (list.number, block.quote_depth))
        })
        .collect();
    assert_eq!(
        shape,
        vec![(Some(9), 1), (None, 1), (None, 1), (Some(7), 1)]
    );
    assert_eq!(
        s.source_at(s.revision(), DisplayOffset(18), Affinity::Forward)
            .unwrap()
            .0,
        raw.find("after").unwrap()
    );
    assert!(matches!(
        s.block_command(
            s.revision(),
            range(10, 10),
            BlockCommand::OrderedList,
            &mut |_| Err("append".into())
        ),
        Err(EditorError::Persistence(_))
    ));
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.selection(), range(10, 10));
    view.apply(
        s.block_command(
            s.revision(),
            range(10, 10),
            BlockCommand::OrderedList,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), expected);
    assert_eq!(view.text, shown);
    assert_eq!(s.selection(), range(10, 10));
    let fresh = EditorSession::open(expected);
    assert_eq!(fresh.display_text(), shown);
    let numbers: Vec<_> = fresh
        .project(fresh.revision(), range(0, shown.len()))
        .unwrap()
        .blocks
        .into_iter()
        .filter_map(|block| block.list.filter(|list| list.first).map(|list| list.number))
        .collect();
    assert_eq!(numbers, vec![Some(9), Some(1), Some(2), Some(7)]);
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), expected);
}

#[test]
fn an_after_boundary_comment_preserves_existing_blank_lines_and_following_start() {
    let raw = "9) before\n\n* a\n* b\n\n7. after";
    let expected = "9) before\n\n1. a\n2. b\n<!-- -->\n\n7. after";
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
}

#[test]
fn authored_empty_comment_bytes_survive_body_edits_while_other_html_and_code_stay_unchanged() {
    let raw = "1. __a__\r\n\r\n<!---->\r\n\r\n8. b\r\n1. c";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new("a\r\n\r\n\r\nb\r\nc");
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.display_text(), view.text);
    view.apply(
        s.replace(s.revision(), range(8, 8), "!", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(
        s.source_text(),
        "1. __a__\r\n\r\n<!---->\r\n\r\n8. b!\r\n1. c"
    );
    assert_eq!(view.text, "a\r\n\r\n\r\nb!\r\nc");
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

#[test]
fn typing_after_an_existing_empty_comment_keeps_its_full_line_and_exact_undo() {
    let raw = "<!-- -->\r\n";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new("");
    assert_eq!(s.display_text(), "");
    view.apply(
        s.replace(s.revision(), range(0, 0), "X", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(s.source_text(), "<!-- -->\r\nX");
    assert_eq!(view.text, "X");
    assert_eq!(s.selection(), range(1, 1));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
}
