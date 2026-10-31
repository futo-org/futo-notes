use super::*;

#[test]
fn a_bare_quote_becomes_an_independent_root_list_between_foreign_lists() {
    let raw = "- before\n\n> middle\n\n- after";
    let expected = "- before\n\n+ middle\n\n- after";
    let shown = "before\n\nmiddle\n\nafter";
    let selected = range(8, 14);
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new(shown);
    s.select_with_affinity(s.revision(), selected, Affinity::Backward)
        .unwrap();
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
    let p = s.project(s.revision(), range(0, shown.len())).unwrap();
    assert_eq!(
        p.blocks
            .iter()
            .filter_map(|block| block
                .list
                .as_ref()
                .filter(|list| list.first)
                .map(|list| (list.depth, block.quote_depth)))
            .collect::<Vec<_>>(),
        vec![(1, 0), (1, 0), (1, 0)]
    );
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.selection(), selected);
    assert_eq!(s.affinity(), Affinity::Backward);
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), expected);
}

#[test]
fn a_heading_inside_a_quote_keeps_its_quote_when_becoming_a_list() {
    let raw = "> ## heading";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new("heading");
    let selected = range(3, 3);
    s.select_with_affinity(s.revision(), selected, Affinity::Backward)
        .unwrap();
    view.apply(
        s.block_command(
            s.revision(),
            selected,
            BlockCommand::BulletList,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "> - heading");
    assert_eq!(view.text, "heading");
    assert_eq!(s.selection(), selected);
    let p = s.project(s.revision(), range(0, 7)).unwrap();
    assert!(p
        .blocks
        .iter()
        .all(|block| block.quote_depth == 1
            && block.list.as_ref().is_some_and(|list| list.depth == 1)));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.selection(), selected);
    assert_eq!(s.affinity(), Affinity::Backward);
}

#[test]
fn retargeting_an_existing_quoted_list_keeps_its_quote_and_outer_neighbors() {
    let raw = "> - parent\n>   - child\n> - following";
    let expected = "> - parent\n>   1. child\n> - following";
    let shown = "parent\nchild\nfollowing";
    let selected = range(7, 12);
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new(shown);
    s.select(s.revision(), selected).unwrap();
    view.apply(
        s.block_command(
            s.revision(),
            selected,
            BlockCommand::OrderedList,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), expected);
    assert_eq!(view.text, shown);
    assert_eq!(s.selection(), selected);
    let p = s.project(s.revision(), selected).unwrap();
    assert!(p.blocks.iter().all(|block| block.quote_depth == 1
        && block
            .list
            .as_ref()
            .is_some_and(|list| list.depth == 2 && list.number == Some(1))));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.selection(), selected);
}

#[test]
fn mixed_selected_kinds_toggle_independently_in_one_protected_action() {
    let raw = "- bullet\n\n> quoted\n\nplain\n\n1. numbered";
    let expected = "bullet\n\n- quoted\n\n+ plain\n\n- numbered";
    let shown = "bullet\n\nquoted\n\nplain\n\nnumbered";
    let selected = range(0, 31);
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
    let p = s.project(s.revision(), selected).unwrap();
    assert_eq!(
        p.blocks
            .iter()
            .filter_map(|block| block
                .list
                .as_ref()
                .filter(|list| list.first)
                .map(|list| (list.depth, block.quote_depth)))
            .collect::<Vec<_>>(),
        vec![(1, 0), (1, 0), (1, 0)]
    );
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(view.text, shown);
    assert_eq!(s.selection(), selected);
    assert_eq!(s.affinity(), Affinity::Backward);
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), expected);
    assert_eq!(s.selection(), selected);
}

#[test]
fn ordered_outer_items_keep_their_sequence_across_a_selected_nested_item() {
    let raw = "- parent\n  - child\n- following";
    let expected = "1. parent\n   1. child\n2. following";
    let shown = "parent\nchild\nfollowing";
    let selected = range(7, 13);
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new(shown);
    s.select_with_affinity(s.revision(), selected, Affinity::Backward)
        .unwrap();
    assert!(matches!(
        s.block_command(
            s.revision(),
            selected,
            BlockCommand::OrderedList,
            &mut |_| Err("append rejected".into())
        ),
        Err(EditorError::Persistence(_))
    ));
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.revision(), Revision(0));
    let mut accepted = 0;
    view.apply(
        s.block_command(
            s.revision(),
            selected,
            BlockCommand::OrderedList,
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
    assert_eq!(
        p.blocks
            .iter()
            .filter_map(|block| block
                .list
                .as_ref()
                .filter(|list| list.first)
                .map(|list| (list.depth, list.number)))
            .collect::<Vec<_>>(),
        vec![(1, Some(1)), (2, Some(1)), (1, Some(2))]
    );
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.selection(), selected);
    assert_eq!(s.affinity(), Affinity::Backward);
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), expected);
    assert_eq!(s.selection(), selected);
}

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
        items.iter().map(|list| list.depth).collect::<Vec<_>>(),
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
fn mixed_nested_selection_at_outer_first_text_keeps_the_retired_paragraph_separate() {
    let raw = "- parent\n  1. child\n  2. sibling\n- following";
    let expected = "parent\n- child\n- sibling\n\nfollowing";
    let before = "parent\nchild\nsibling\nfollowing";
    let after = "parent\nchild\nsibling\n\nfollowing";
    let selected = range(0, 21);
    let mapped = range(0, 22);
    let plan = EditorSession::open(expected);
    assert_eq!(plan.display_text(), after);
    let p = plan
        .project(plan.revision(), range(0, after.len()))
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
        vec![1, 1]
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
    assert_eq!(view.text, after);
    assert_eq!(s.selection(), mapped);
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(view.text, before);
    assert_eq!(s.selection(), selected);
    assert_eq!(s.affinity(), Affinity::Backward);
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), expected);
    assert_eq!(view.text, after);
    assert_eq!(s.selection(), mapped);
}
