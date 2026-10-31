use super::*;

#[test]
fn reversed_mixed_runs_retarget_the_ancestor_before_lifting_the_child_and_tail() {
    let raw = "1. parent\n   - child\u{1f600}\n     - grandchild\n   - sibling\n2. following";
    let expected = "- parent\n\nchild\u{1f600}\n+ grandchild\n+ sibling\n- following";
    let before = "parent\nchild\u{1f600}\ngrandchild\nsibling\nfollowing";
    let shown = "parent\n\nchild\u{1f600}\ngrandchild\nsibling\nfollowing";
    let selected = range(0, 16);
    let mapped = range(0, 17);
    let mut plan = EditorSession::open(expected);
    assert_eq!(plan.display_text(), shown);
    let p = plan
        .project(plan.revision(), range(0, shown.len()))
        .unwrap();
    assert_eq!(
        p.blocks
            .iter()
            .filter_map(|block| block
                .list
                .as_ref()
                .filter(|list| list.first)
                .map(|list| list.depth))
            .collect::<Vec<_>>(),
        vec![1, 1, 1, 1]
    );
    plan.block_command(
        plan.revision(),
        range(18, 18),
        BlockCommand::OrderedList,
        &mut |_| Ok(()),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        plan.source_text(),
        "- parent\n\nchild\u{1f600}\n1. grandchild\n2. sibling\n- following"
    );
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new(before);
    s.select_with_affinity(s.revision(), selected, Affinity::Backward)
        .unwrap();
    assert!(matches!(
        s.block_command(
            s.revision(),
            selected,
            BlockCommand::BulletList,
            &mut |_| Err("append rejected".into()),
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
            BlockCommand::BulletList,
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
    assert_eq!(s.selection(), mapped);
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(view.text, before);
    assert_eq!(s.selection(), selected);
    assert_eq!(s.affinity(), Affinity::Backward);
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), expected);
    assert_eq!(view.text, shown);
    assert_eq!(s.selection(), mapped);
}

#[test]
fn reversed_mixed_quote_and_endpoint_literal_plans_have_the_intended_fragments() {
    for (source, shown, after_ordered, depths) in [
        (
            "parent\n> child\u{1f600}\n> + grandchild\n> - sibling\n- following",
            "parent\nchild\u{1f600}\ngrandchild\nsibling\nfollowing",
            "parent\n> child\u{1f600}\n> 1. grandchild\n> - sibling\n- following",
            &[(1, 1), (1, 1), (1, 0)][..],
        ),
        (
            "- parent\n\nchild\u{1f600}\n- grandchild\n\nsibling\n- following",
            "parent\n\nchild\u{1f600}\ngrandchild\n\nsibling\nfollowing",
            "- parent\n\nchild\u{1f600}\n1. grandchild\n\nsibling\n- following",
            &[(1, 0), (1, 0), (1, 0)][..],
        ),
    ] {
        let mut plan = EditorSession::open(source);
        assert_eq!(plan.display_text(), shown);
        let p = plan
            .project(plan.revision(), range(0, shown.len()))
            .unwrap();
        assert_eq!(
            p.blocks
                .iter()
                .filter_map(|block| block
                    .list
                    .as_ref()
                    .filter(|list| list.first)
                    .map(|list| (list.depth, block.quote_depth)))
                .collect::<Vec<_>>(),
            depths
        );
        let caret = shown.find("grandchild").unwrap();
        plan.block_command(
            plan.revision(),
            range(caret, caret),
            BlockCommand::OrderedList,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(plan.source_text(), after_ordered);
        assert_eq!(plan.display_text(), shown);
        plan.undo(plan.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(plan.source_text(), source);
    }
}
