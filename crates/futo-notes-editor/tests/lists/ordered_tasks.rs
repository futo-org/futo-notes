use super::*;

#[test]
fn ordered_tasks_keep_the_existing_start_and_raw_padding_when_checkboxes_are_removed() {
    for (raw, expected) in [
        (
            "7) [x] parent\n   - child\n8) [ ] following",
            "7) parent\n   - child\n8) following",
        ),
        (
            "7)\t[x] parent\n\t- child\n8)\t[ ] following",
            "7)\tparent\n\t- child\n8)\tfollowing",
        ),
    ] {
        let shown = "parent\nchild\nfollowing";
        let selected = range(3, 3);
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(shown);
        assert_eq!(s.display_text(), shown);
        // The literal source plan has the same canonical start, nesting and text.
        let opened = EditorSession::open(expected);
        assert_eq!(opened.display_text(), shown);
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
        assert_eq!(s.selection(), selected);
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
        let projected = s.project(s.revision(), range(0, shown.len())).unwrap();
        assert_eq!(
            projected
                .blocks
                .iter()
                .filter_map(
                    |block| block.list.as_ref().filter(|list| list.first).map(|list| (
                        list.depth,
                        list.number,
                        list.checked
                    ))
                )
                .collect::<Vec<_>>(),
            vec![(1, Some(7), None), (2, None, None), (1, Some(8), None)]
        );
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), selected);
        assert_eq!(s.affinity(), Affinity::Backward);
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, shown);
    }
}

#[test]
fn a_mixed_task_owner_restarts_at_one_after_its_ordered_child_is_lifted() {
    assert_split_owner(
        "- [ ] parent\n  1. child\n- [x] following",
        "1. parent\n\nchild\n1. following",
        "parent\n\nchild\nfollowing",
        1,
    );
}

#[test]
fn an_existing_ordered_task_owner_copies_its_start_after_its_child_is_lifted() {
    assert_split_owner(
        "7) [ ] parent\n   1. child\n8) [x] following",
        "7) parent\n\nchild\n\n7) following",
        "parent\n\nchild\n\nfollowing",
        7,
    );
}

fn assert_split_owner(raw: &str, expected: &str, shown: &str, start: u64) {
    let selected = range(0, 12);
    let mapped = range(0, 13);
    let mut plan = EditorSession::open(expected);
    assert_eq!(plan.display_text(), shown);
    let projected = plan
        .project(plan.revision(), range(0, shown.len()))
        .unwrap();
    assert_eq!(
        projected
            .blocks
            .iter()
            .filter_map(
                |block| block.list.as_ref().filter(|list| list.first).map(|list| (
                    list.depth,
                    list.number,
                    list.checked
                ))
            )
            .collect::<Vec<_>>(),
        vec![(1, Some(start), None), (1, Some(start), None)]
    );
    // Retargeting only the following fragment cannot change the parent owner.
    let tail = shown.find("following").unwrap();
    plan.block_command(
        plan.revision(),
        range(tail, tail),
        BlockCommand::BulletList,
        &mut |_| Ok(()),
    )
    .unwrap()
    .unwrap();
    assert!(plan.source_text().starts_with(&format!(
        "{start}{} parent",
        if start == 7 { ")" } else { "." }
    )));
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new("parent\nchild\nfollowing");
    assert_eq!(s.display_text(), view.text);
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
    assert_eq!(s.selection(), selected);
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
    assert_eq!(s.selection(), mapped);
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.selection(), selected);
    assert_eq!(s.affinity(), Affinity::Backward);
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), expected);
    assert_eq!(view.text, shown);
    assert_eq!(s.selection(), mapped);
}
