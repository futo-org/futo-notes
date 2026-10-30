use crate::*;

#[test]
fn nested_selected_retarget_does_not_copy_each_prefix_for_every_ancestor() {
    for depth in [8, 64] {
        let raw = (0..depth)
            .map(|at| format!("{}- n{at}\n", "  ".repeat(at)))
            .collect::<String>();
        let expected = (0..depth)
            .map(|at| format!("{}1. n{at}\n", "   ".repeat(at)))
            .collect::<String>();
        let shown = (0..depth).map(|at| format!("n{at}\n")).collect::<String>();
        let selected = DisplayRange {
            start: DisplayOffset(0),
            end: DisplayOffset(shown.len() - 1),
        };
        let mut session = EditorSession::open(&raw);
        assert_eq!(session.display_text(), shown);
        session.select(Revision(0), selected).unwrap();
        crate::inline::CONTAINER_METADATA_VISITS.with(|visits| visits.set(0));
        let change = session
            .block_command(
                Revision(0),
                selected,
                BlockCommand::OrderedList,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap();
        let visits = crate::inline::CONTAINER_METADATA_VISITS.with(|visits| visits.get());
        let mut view = shown.clone();
        view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
        assert_eq!(view, shown);
        assert_eq!(session.source_text(), expected);
        assert_eq!(session.selection(), selected);
        // A conservative constant copy budget for the actual touched bytes.
        // Repeated prefix copies at every selected ancestor grow beyond it.
        assert!(
            change.work.materialized_source_bytes < 32 * raw.len(),
            "depth={depth} input={} materialized={} parsed={} metadata={visits}",
            raw.len(),
            change.work.materialized_source_bytes,
            change.work.parsed_source_bytes
        );
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(session.source_text(), raw);
    }
}

#[test]
fn alternating_quote_retarget_does_not_copy_each_prefix_for_every_container() {
    for depth in [8, 64] {
        let raw = (0..depth)
            .map(|at| format!("{}- n{at}\n", "  > ".repeat(at)))
            .collect::<String>();
        let expected = (0..depth)
            .map(|at| format!("{}1. n{at}\n", "   > ".repeat(at)))
            .collect::<String>();
        let shown = (0..depth).map(|at| format!("n{at}\n")).collect::<String>();
        let selected = DisplayRange {
            start: DisplayOffset(0),
            end: DisplayOffset(shown.len() - 1),
        };
        let mut session = EditorSession::open(&raw);
        assert_eq!(session.display_text(), shown);
        session.select(Revision(0), selected).unwrap();
        crate::inline::CONTAINER_METADATA_VISITS.with(|visits| visits.set(0));
        let change = session
            .block_command(
                Revision(0),
                selected,
                BlockCommand::OrderedList,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap();
        let visits = crate::inline::CONTAINER_METADATA_VISITS.with(|visits| visits.get());
        let mut view = shown.clone();
        view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
        assert_eq!(view, shown);
        assert_eq!(session.source_text(), expected);
        assert_eq!(session.selection(), selected);
        // A conservative constant copy budget for the actual touched bytes.
        // Repeated prefix copies at every selected ancestor grow beyond it.
        assert!(
            change.work.materialized_source_bytes < 32 * raw.len(),
            "depth={depth} input={} materialized={} parsed={} metadata={visits}",
            raw.len(),
            change.work.materialized_source_bytes,
            change.work.parsed_source_bytes
        );
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(session.source_text(), raw);
    }
}
