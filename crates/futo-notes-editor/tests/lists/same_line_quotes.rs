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
