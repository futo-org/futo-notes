use super::*;

#[test]
fn mixed_parent_retirement_promotes_a_retargeted_child_owner_and_keeps_foreign_lists() {
    let raw = "- parent\n  1. child\u{1f600}\n     - grandchild\n  2. sibling\n- following";
    let expected = "parent\n+ child\u{1f600}\n  - grandchild\n+ sibling\n- following";
    let shown = "parent\nchild\u{1f600}\ngrandchild\nsibling\nfollowing";
    let selected = range(0, 16);
    // This hand-written source plan independently proves the intended owners;
    // the shipping serializer's blank-line/marker normalization is diagnostic.
    let plan = EditorSession::open(expected);
    assert_eq!(plan.display_text(), shown);
    let p = plan
        .project(plan.revision(), range(0, shown.len()))
        .unwrap();
    let items: Vec<_> = p
        .blocks
        .iter()
        .filter_map(|block| block.list.as_ref().filter(|list| list.first))
        .collect();
    assert_eq!(
        items.iter().map(|list| list.depth()).collect::<Vec<_>>(),
        vec![1, 2, 1, 1]
    );
    let mut plan = plan;
    plan.block_command(
        plan.revision(),
        range(7, 7),
        BlockCommand::OrderedList,
        &mut |_| Ok(()),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        plan.source_text(),
        "parent\n1. child\u{1f600}\n   - grandchild\n2. sibling\n- following"
    );
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new(shown);
    assert_eq!(s.display_text(), shown);
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
    assert_eq!(s.selection(), selected);
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.selection(), selected);
    assert_eq!(s.affinity(), Affinity::Backward);
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), expected);
    assert_eq!(s.selection(), selected);
}

#[test]
fn mixed_retirement_preserves_retained_and_enclosing_quote_scopes() {
    for (raw, expected, before, shown, selected, mapped, depths) in [
        (
            "- parent\n  > 1. child\u{1f600}\n  >    - grandchild\n  > 2. sibling\n- following",
            "parent\n  > - child\u{1f600}\n  >   - grandchild\n  > - sibling\n- following",
            "parent\nchild\u{1f600}\ngrandchild\nsibling\nfollowing",
            "parent\nchild\u{1f600}\ngrandchild\nsibling\nfollowing",
            range(0, 16),
            range(0, 16),
            &[(1, 1), (2, 1), (1, 1), (1, 0)][..],
        ),
        (
            "> - parent\n>   1. child\n>   2. sibling\n> - following",
            "> parent\n> - child\n> - sibling\n>\n> following",
            "parent\nchild\nsibling\nfollowing",
            "parent\nchild\nsibling\n\nfollowing",
            range(0, 21),
            range(0, 22),
            &[(1, 1), (1, 1)][..],
        ),
    ] {
        let plan = EditorSession::open(expected);
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
                    .map(|list| (list.depth(), block.quote_depth)))
                .collect::<Vec<_>>(),
            depths
        );
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(before);
        assert_eq!(s.display_text(), before);
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
}
