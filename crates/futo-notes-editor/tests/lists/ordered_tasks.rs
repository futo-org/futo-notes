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
            "7)  parent\n\t- child\n8) following",
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
                        list.depth(),
                        list.number(),
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
fn repeated_ordered_child_lifts_keep_new_owner_starts_between_foreign_lists() {
    for (raw, expected, shown, end, start) in [
        (
            "9) before\n\n- [ ] p0\n  1. c0\n- [x] p1\n  1. c1\n- [ ] tail\n\n3. after",
            "9) before\n\n1. p0\n\nc0\n1. p1\n\nc1\n1) tail\n\n3. after",
            "before\n\np0\n\nc0\np1\n\nc1\ntail\n\nafter",
            21,
            1,
        ),
        (
            "9. before\n\n7) [ ] p0\n   1. c0\n8) [x] p1\n   1. c1\n9) [ ] tail\n\n3. after",
            "9. before\n\n7) p0\n\nc0\n\n7) p1\n\nc1\n\n7) tail\n\n3. after",
            "before\n\np0\n\nc0\n\np1\n\nc1\n\ntail\n\nafter",
            22,
            7,
        ),
    ] {
        let plan = EditorSession::open(expected);
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
                        list.depth(),
                        list.number(),
                        list.checked
                    ))
                )
                .collect::<Vec<_>>(),
            vec![
                (1, Some(9), None),
                (1, Some(start), None),
                (1, Some(start), None),
                (1, Some(start), None),
                (1, Some(3), None)
            ]
        );
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new("before\n\np0\nc0\np1\nc1\ntail\n\nafter");
        assert_eq!(s.display_text(), view.text);
        let selected = range(8, 19);
        s.select_with_affinity(s.revision(), selected, Affinity::Backward)
            .unwrap();
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
        assert_eq!(s.selection(), range(8, end));
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
fn quoted_and_ancestor_selected_ordered_fragments_keep_their_canonical_owners() {
    for (raw, expected, before, shown, selected_end, mapped_end, quotes, items) in [
        (
            "> - [ ] parent\n>   1. child\n> - [x] following",
            "> 1. parent\n>\n> child\n> 1. following",
            "parent\nchild\nfollowing",
            "parent\n\nchild\nfollowing",
            12,
            13,
            1,
            2,
        ),
        (
            "- [ ] parent\n  1. child\n     1. grandchild\n- [x] following",
            "1. parent\n\nchild\n1. grandchild\n1) following",
            "parent\nchild\ngrandchild\nfollowing",
            "parent\n\nchild\ngrandchild\nfollowing",
            23,
            24,
            0,
            3,
        ),
    ] {
        let plan = EditorSession::open(expected);
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
                        list.depth(),
                        list.number(),
                        list.checked,
                        block.quote_depth
                    ))
                )
                .collect::<Vec<_>>(),
            vec![(1, Some(1), None, quotes); items]
        );
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(before);
        assert_eq!(s.display_text(), before);
        let selected = range(0, selected_end);
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
        assert_eq!(s.selection(), range(0, mapped_end));
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
fn choosing_ordered_on_a_cut_ordered_task_list_retargets_the_whole_owner() {
    let list: String = (1..=1_000)
        .map(|i| format!("{i}. [ ] task {i}\n"))
        .collect();
    let plain: String = (1..=1_000).map(|i| format!("{i}. task {i}\n")).collect();
    let original = format!("before\n\n{list}\nafter");
    let expected = format!("before\n\n{plain}\nafter");
    let mut s = EditorSession::open(&original);
    let shown = s.display_text();
    let at = shown.find("task 501").unwrap();
    let selected = range(at, at);
    s.select_with_affinity(s.revision(), selected, Affinity::Backward)
        .unwrap();
    let mut accepted = 0;
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
    .unwrap();
    assert_eq!(
        s.source_text().matches("[ ]").count(),
        0,
        "OrderedList is a whole-list retarget, not a repeated Task command"
    );
    assert_eq!(s.source_text(), expected);
    assert_eq!(s.display_text(), shown);
    assert_eq!(s.selection(), selected);
    assert_eq!(accepted, 1);
    s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(s.source_text(), original);
    assert_eq!(s.selection(), selected);
    assert_eq!(s.affinity(), Affinity::Backward);
    s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(s.source_text(), expected);
}
