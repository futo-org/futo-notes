use super::*;

#[test]
fn nested_text_lift_keeps_quote_ancestry_and_foreign_list_owner() {
    let raw = "> - parent\n>   - child😀\n>     - grandchild\n>   - sibling\n> - following";
    let expected = "> - parent\n>\n> child😀\n> - grandchild\n> + sibling\n> - following";
    let shown = "parent\nchild😀\ngrandchild\nsibling\nfollowing";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new(shown);
    s.select_with_affinity(s.revision(), range(7, 16), Affinity::Backward)
        .unwrap();
    view.apply(
        s.block_command(
            s.revision(),
            range(7, 16),
            BlockCommand::Heading(0),
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), expected);
    assert_eq!(
        view.text,
        "parent\n\nchild😀\ngrandchild\nsibling\nfollowing"
    );
    assert_eq!(s.selection(), range(8, 17));
    let child = s.project(s.revision(), range(8, 17)).unwrap();
    assert!(child
        .blocks
        .iter()
        .all(|block| block.list.is_none() && block.quote_depth == 1));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(view.text, shown);
    assert_eq!(s.selection(), range(7, 16));
    assert_eq!(s.affinity(), Affinity::Backward);
}

#[test]
fn nested_text_lift_removes_each_selected_sibling_in_one_action() {
    let raw = "- parent\n  - one\n  - two\n  - keep\n- following";
    let expected = "- parent\n\none\ntwo\n+ keep\n- following";
    let shown = "parent\none\ntwo\nkeep\nfollowing";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new(shown);
    s.select(s.revision(), range(7, 14)).unwrap();
    let mut accepted = 0;
    view.apply(
        s.block_command(
            s.revision(),
            range(7, 14),
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
    assert_eq!(view.text, "parent\n\none\ntwo\nkeep\nfollowing");
    assert_eq!(s.selection(), range(8, 15));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(view.text, shown);
    assert_eq!(s.selection(), range(7, 14));
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), expected);
}

#[test]
fn nested_heading_lifts_all_list_ancestry_before_setting_the_heading() {
    let raw = "- parent\n  - child😀\n    - grandchild\n  - sibling\n- following";
    let expected = "- parent\n\n## child😀\n- grandchild\n+ sibling\n- following";
    let shown = "parent\nchild😀\ngrandchild\nsibling\nfollowing";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new(shown);
    s.select_with_affinity(s.revision(), range(7, 16), Affinity::Backward)
        .unwrap();
    let mut accepted = 0;
    view.apply(
        s.block_command(
            s.revision(),
            range(7, 16),
            BlockCommand::Heading(2),
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
    assert_eq!(
        view.text,
        "parent\n\nchild😀\ngrandchild\nsibling\nfollowing"
    );
    assert_eq!(s.selection(), range(8, 17));
    let p = s.project(s.revision(), range(8, 17)).unwrap();
    assert!(p
        .blocks
        .iter()
        .all(|block| block.list.is_none() && block.heading == 2));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(view.text, shown);
    assert_eq!(s.selection(), range(7, 16));
    assert_eq!(s.affinity(), Affinity::Backward);
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), expected);
}

#[test]
fn text_command_includes_a_next_item_first_text_endpoint_but_not_the_prior_text_end() {
    for (end, expected) in [
        (6, "first\nsecond\n- third"),
        (5, "first\n- second\n- third"),
    ] {
        let raw = "- first\n- second\n- third";
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new("first\nsecond\nthird");
        let selected = range(0, end);
        s.select_with_affinity(s.revision(), selected, Affinity::Backward)
            .unwrap();
        view.apply(
            s.block_command(
                s.revision(),
                selected,
                BlockCommand::Heading(0),
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
        );
        assert_eq!(s.source_text(), expected, "endpoint {end}");
        assert_eq!(view.text, "first\nsecond\nthird");
        assert_eq!(s.selection(), selected);
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), selected);
        assert_eq!(s.affinity(), Affinity::Backward);
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
    }
}

#[test]
fn text_lifting_through_a_quote_inside_an_item_is_refused_unchanged() {
    // Lifting a list whose item contains a quoted list would respell the quote
    // across container levels; refused before acceptance (DECISIONS #20).
    for (raw, selected) in [
        (
            "- parent\n  > - child\n  >   - grandchild\n  > - sibling\n- following",
            range(7, 12),
        ),
        (
            "- outer\n  > - middle\n  >   > - child\n  >   >   - grandchild\n  >   > - inner sibling\n  > - middle sibling\n- following",
            range(13, 18),
        ),
    ] {
        let mut s = EditorSession::open(raw);
        s.select_with_affinity(s.revision(), selected, Affinity::Backward)
            .unwrap();
        assert!(matches!(
            s.block_command(
                s.revision(),
                selected,
                BlockCommand::Heading(0),
                &mut |_| panic!("accepted")
            ),
            Err(EditorError::UnrepresentableFormat)
        ));
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), selected);
        assert_eq!(s.revision(), Revision(0));
    }
}

#[test]
fn text_selection_starting_in_an_ancestor_keeps_the_descendant_list_subtree() {
    // The actual toolbar loop stops once selection.from has left its list.
    let raw = "- parent\n  - child😀\n    - grandchild\n  - sibling\n- following";
    let expected = "parent\n+ child😀\n  - grandchild\n+ sibling\n- following";
    let shown = "parent\nchild😀\ngrandchild\nsibling\nfollowing";
    let selected = range(0, 16);
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new(shown);
    s.select_with_affinity(s.revision(), selected, Affinity::Backward)
        .unwrap();
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
    assert_eq!(s.selection(), selected);
    let p = s.project(s.revision(), range(0, shown.len())).unwrap();
    let depths = p
        .blocks
        .iter()
        .filter_map(|block| {
            block
                .list
                .as_ref()
                .filter(|list| list.first)
                .map(|list| list.depth)
        })
        .collect::<Vec<_>>();
    assert_eq!(depths, vec![1, 2, 1, 1]);
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.selection(), selected);
    assert_eq!(s.affinity(), Affinity::Backward);
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), expected);
}
