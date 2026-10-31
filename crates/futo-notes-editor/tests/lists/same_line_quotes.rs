use super::*;

#[test]
fn same_line_quotes_have_canonical_outer_list_ownership_after_wide_and_tab_padding() {
    for (raw, number) in [
        ("- > b", None),
        ("1000. > b", Some(1000)),
        ("1000.\t> b", Some(1000)),
    ] {
        let mut s = EditorSession::open(raw);
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.display_text(), "b");
        let projected = s.project(s.revision(), range(0, 1)).unwrap();
        assert!(projected.blocks.iter().any(|block| block.quote_depth == 1
            && block
                .list
                .as_ref()
                .is_some_and(|list| list.first && list.depth == 1 && list.number == number)));
    }
    let mut negative = EditorSession::open("> b");
    let p = negative.project(negative.revision(), range(0, 1)).unwrap();
    assert!(p
        .blocks
        .iter()
        .all(|block| block.list.is_none() && block.quote_depth == 1));
}

#[test]
fn text_lifts_the_outer_same_line_list_and_retains_its_empty_paragraph_before_the_quote() {
    let expected = "\n> b";
    let mut plan = EditorSession::open(expected);
    assert_eq!(plan.display_text(), "\nb");
    let projected = plan.project(plan.revision(), range(0, 2)).unwrap();
    assert!(projected.blocks.iter().all(|block| block.list.is_none()));
    assert_eq!(projected.blocks.last().unwrap().quote_depth, 1);
    for raw in ["- > b", "1000. > b"] {
        let mut s = EditorSession::open(raw);
        assert_eq!(s.display_text(), "b");
        let mut view = ReferenceView::new("b");
        let selected = range(0, 0);
        s.select_with_affinity(s.revision(), selected, Affinity::Backward)
            .unwrap();
        assert!(matches!(
            s.block_command(
                s.revision(),
                selected,
                BlockCommand::Heading(0),
                &mut |_| Err("append rejected".into())
            ),
            Err(EditorError::Persistence(_))
        ));
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.revision(), Revision(0));
        assert_eq!(s.selection(), selected);
        let mut accepted = 0;
        view.apply(
            s.block_command(
                s.revision(),
                selected,
                BlockCommand::Heading(0),
                &mut |_| {
                    accepted += 1;
                    Ok(())
                },
            )
            .unwrap()
            .unwrap(),
        );
        assert_eq!(accepted, 1);
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, "\nb");
        assert_eq!(s.selection(), range(1, 1));
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), selected);
        assert_eq!(s.affinity(), Affinity::Backward);
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, "\nb");
    }
}

#[test]
fn canonical_same_line_prefix_order_hides_only_owned_quote_and_heading_markers() {
    for (raw, depth, quotes, heading) in [
        ("- > - > b", 2, 2, 0),
        ("> - > b", 1, 2, 0),
        ("- # b", 1, 0, 1),
        ("- > # b", 1, 1, 1),
        ("> - > # b", 1, 2, 1),
    ] {
        let mut s = EditorSession::open(raw);
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.display_text(), "b", "{raw}");
        let p = s.project(s.revision(), range(0, 1)).unwrap();
        assert!(
            p.blocks.iter().any(|b| b.quote_depth == quotes
                && b.heading == heading
                && b.list.as_ref().is_some_and(|l| l.first && l.depth == depth)),
            "{raw}"
        );
    }
}

#[test]
fn escaped_and_code_quote_markers_remain_opaque_to_container_prefixes() {
    for (raw, quotes, code) in [
        ("- \\> b", 0, false),
        ("- `> b`", 0, false),
        ("> \\> b", 1, false),
        ("> ```\n> > b\n> ```", 1, true),
    ] {
        let mut s = EditorSession::open(raw);
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.display_text(), "> b", "{raw}");
        let p = s.project(s.revision(), range(0, 3)).unwrap();
        assert!(
            p.blocks
                .iter()
                .all(|b| b.quote_depth == quotes && b.code == code),
            "{raw}"
        );
    }
}

#[test]
fn task_body_markers_remain_literal_and_wide_continuations_keep_quote_ownership() {
    for (raw, shown, quotes) in [
        ("- [x] > b", "> b", 0),
        ("- [x] # b", "# b", 0),
        ("> - [x] > b", "> b", 1),
    ] {
        let mut s = EditorSession::open(raw);
        assert_eq!(s.display_text(), shown);
        assert_eq!(s.source_text(), raw);
        let p = s.project(s.revision(), range(0, shown.len())).unwrap();
        assert!(p.blocks.iter().all(|b| b.quote_depth == quotes
            && b.heading == 0
            && b.list.as_ref().is_some_and(|l| l.checked == Some(true))));
    }
    let raw = "1000. parent\n      > b";
    let mut s = EditorSession::open(raw);
    assert_eq!(s.display_text(), "parent\nb");
    assert_eq!(s.source_text(), raw);
    let p = s.project(s.revision(), range(7, 8)).unwrap();
    assert!(p.blocks.iter().any(|b| b.quote_depth == 1
        && b.list
            .as_ref()
            .is_some_and(|l| !l.first && l.depth == 1 && l.number == Some(1000))));
}

#[test]
fn same_line_quote_lifting_preserves_physical_quotes_crlf_and_entity_interior_carets() {
    for (raw, expected, before, shown, selected, mapped) in [
        ("> - > b", "> \n> > b", "b", "\nb", 0, 1),
        ("- > b\r\n", "\r\n> b\r\n", "b\r\n", "\r\nb\r\n", 0, 2),
        (
            "\r\n- > b\r\n",
            "\r\n\r\n> b\r\n",
            "\r\nb\r\n",
            "\r\n\r\nb\r\n",
            2,
            4,
        ),
        (
            "- > &acE;",
            "\n> &acE;",
            "\u{223e}\u{0333}",
            "\n\u{223e}\u{0333}",
            3,
            4,
        ),
    ] {
        assert_text_source(raw, expected, before, shown, selected, mapped);
    }
}

#[test]
fn clearing_task_list_state_keeps_literal_quote_and_heading_body_text() {
    for (raw, expected, shown) in [
        ("- [x] > b", "\\> b", "> b"),
        ("- [x] # b", "\\# b", "# b"),
        ("> - [x] > b", "> \\> b", "> b"),
    ] {
        assert_text_source(raw, expected, shown, shown, 0, 0);
    }
}

fn assert_text_source(
    raw: &str,
    expected: &str,
    before: &str,
    shown: &str,
    at: usize,
    after: usize,
) {
    let plan = EditorSession::open(expected);
    assert_eq!(plan.display_text(), shown);
    for affinity in [Affinity::Backward, Affinity::Forward] {
        let mut s = EditorSession::open(raw);
        assert_eq!(s.display_text(), before);
        let mut view = ReferenceView::new(before);
        let selected = range(at, at);
        s.select_with_affinity(s.revision(), selected, affinity)
            .unwrap();
        assert!(matches!(
            s.block_command(
                s.revision(),
                selected,
                BlockCommand::Heading(0),
                &mut |_| Err("append rejected".into())
            ),
            Err(EditorError::Persistence(_))
        ));
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.revision(), Revision(0));
        assert_eq!(s.selection(), selected);
        let mut accepted = 0;
        view.apply(
            s.block_command(
                s.revision(),
                selected,
                BlockCommand::Heading(0),
                &mut |_| {
                    accepted += 1;
                    Ok(())
                },
            )
            .unwrap()
            .unwrap(),
        );
        assert_eq!(accepted, 1);
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, shown);
        assert_eq!(s.selection(), range(after, after));
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), selected);
        assert_eq!(s.affinity(), affinity);
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, shown);
        assert_eq!(s.selection(), range(after, after));
    }
}

#[test]
fn header_selection_preview_calls_the_host_and_history_clock_only_for_the_real_action() {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    struct Clock(AtomicUsize);
    impl HistoryClock for Clock {
        fn now(&self) -> std::time::Duration {
            self.0.fetch_add(1, Ordering::SeqCst);
            std::time::Duration::ZERO
        }
    }
    let clock = Arc::new(Clock(AtomicUsize::new(0)));
    let raw = "- > &acE;";
    let mut s = EditorSession::open_with_clock(raw, clock.clone());
    let selected = range(3, 3);
    s.select_with_affinity(Revision(0), selected, Affinity::Backward)
        .unwrap();
    let mut rejected = 0;
    assert!(matches!(
        s.block_command(Revision(0), selected, BlockCommand::Heading(0), &mut |_| {
            rejected += 1;
            Err("append rejected".into())
        }),
        Err(EditorError::Persistence(_))
    ));
    assert_eq!(rejected, 1);
    assert_eq!(clock.0.load(Ordering::SeqCst), 0);
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.revision(), Revision(0));
    assert_eq!(s.selection(), selected);
    let mut accepted = 0;
    s.block_command(Revision(0), selected, BlockCommand::Heading(0), &mut |_| {
        accepted += 1;
        Ok(())
    })
    .unwrap()
    .unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(clock.0.load(Ordering::SeqCst), 1);
    assert_eq!(s.revision(), Revision(1));
    assert_eq!(s.selection(), range(4, 4));
    s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.selection(), selected);
}

#[test]
fn canonical_heading_indent_uses_tab_columns_after_its_quote_and_list_origins() {
    for (raw, quotes, list) in [
        ("> \t# b", 1, false),
        ("- \t> \t# b", 1, true),
        ("> \t> # b", 2, false),
    ] {
        let mut s = EditorSession::open(raw);
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.display_text(), "b", "{raw}");
        let p = s.project(s.revision(), range(0, 1)).unwrap();
        assert!(
            p.blocks
                .iter()
                .any(|b| b.heading == 1 && b.quote_depth == quotes && b.list.is_some() == list),
            "{raw}"
        );
    }
    let raw = "> \t#b";
    let mut s = EditorSession::open(raw);
    assert_eq!(s.display_text(), "\t#b");
    assert_eq!(s.source_text(), raw);
    assert!(s
        .project(s.revision(), range(0, 3))
        .unwrap()
        .blocks
        .iter()
        .all(|b| b.heading == 0));
}

#[test]
fn a_same_line_quoted_item_keeps_one_empty_paragraph_after_a_listed_sibling() {
    for (expected, shown) in [
        ("- p\n\n> &acE;", "p\n\n\u{223e}\u{0333}"),
        ("\n> &acE;\n- p", "\n\u{223e}\u{0333}\np"),
    ] {
        let mut plan = EditorSession::open(expected);
        assert_eq!(plan.display_text(), shown);
        let p = plan
            .project(plan.revision(), range(0, shown.len()))
            .unwrap();
        assert_eq!(
            p.blocks
                .iter()
                .filter_map(|b| b.list.as_ref().filter(|l| l.first).map(|l| (
                    l.depth,
                    l.number,
                    l.checked,
                    b.quote_depth
                )))
                .collect::<Vec<_>>(),
            vec![(1, None, None, 0)]
        );
        assert!(p
            .blocks
            .iter()
            .any(|b| b.quote_depth == 1 && b.list.is_none()));
    }
    assert_text_source(
        "- p\n- > &acE;",
        "- p\n\n> &acE;",
        "p\n\u{223e}\u{0333}",
        "p\n\n\u{223e}\u{0333}",
        5,
        6,
    );
}

#[test]
fn a_same_line_quoted_item_keeps_its_following_list_independent() {
    assert_text_source(
        "- > &acE;\n- p",
        "\n> &acE;\n- p",
        "\u{223e}\u{0333}\np",
        "\n\u{223e}\u{0333}\np",
        3,
        4,
    );
}
