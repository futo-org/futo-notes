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
