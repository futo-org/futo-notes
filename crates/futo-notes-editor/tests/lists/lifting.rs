use super::*;

#[test]
fn nested_text_lift_keeps_quote_ancestry_and_foreign_list_owner() {
    let raw = "> - parent\n>   - child😀\n>     - grandchild\n>   - sibling\n> - following";
    let expected = "> - parent\n>\n> child😀\n> + grandchild\n> + sibling\n> - following";
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
