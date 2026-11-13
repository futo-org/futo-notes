use super::*;

#[test]
fn whole_note_block_commands_bound_selected_boundary_membership_work() {
    use futo_notes_editor::BlockCommand;
    for lines in [1_000usize, 4_000] {
        let source: String = (0..lines).map(|i| format!("# row {i}\n")).collect();
        let expected: String = (0..lines).map(|i| format!("> # row {i}\n")).collect();
        let mut session = EditorSession::open(&source);
        let selected = DisplayRange {
            start: DisplayOffset(0),
            end: DisplayOffset(session.display_text().len()),
        };
        session.select(session.revision(), selected).unwrap();
        let change = session
            .block_command(
                session.revision(),
                selected,
                BlockCommand::Quote,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap();
        assert_eq!(session.source_text(), expected);
        // Include the ordinary inline/correspondence work plus two indexed
        // membership queries per physical boundary: an O(n log n) allowance.
        let comparisons = usize::BITS as usize - lines.leading_zeros() as usize;
        let budget = lines * (512 + 4 * comparisons);
        assert!(
            change.work.link_metadata_items <= budget,
            "{} metadata visits for {lines} rows exceeds {budget}",
            change.work.link_metadata_items
        );
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(session.source_text(), source);
        assert_eq!(session.selection(), selected);
    }
}

#[test]
fn mixed_prose_and_code_quotes_bound_physical_row_selection_work() {
    use futo_notes_editor::BlockCommand;
    let lines = 2_000usize;
    let code: String = (0..lines).map(|i| format!("opaque code {i}\n")).collect();
    let source = format!("# heading\n\n```\n{code}```\n");
    // Quote leaves a blank line at the selection's edge alone and skips code.
    let expected = format!("> # heading\n\n```\n{code}```\n");
    let mut session = EditorSession::open(&source);
    let selected = DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(session.display_text().len()),
    };
    session.select(session.revision(), selected).unwrap();
    let change = session
        .block_command(
            session.revision(),
            selected,
            BlockCommand::Quote,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text(), expected);
    let comparisons = usize::BITS as usize - lines.leading_zeros() as usize;
    let budget = lines * (512 + 4 * comparisons);
    assert!(
        change.work.link_metadata_items <= budget,
        "{} metadata visits for {lines} code rows exceeds {budget}",
        change.work.link_metadata_items
    );
    session
        .undo(session.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text(), source);
    assert_eq!(session.selection(), selected);
}

#[test]
fn list_commands_do_not_compare_every_span_with_every_line_boundary() {
    use futo_notes_editor::BlockCommand;
    let lines = 1_000usize;
    let source: String = (0..lines).map(|i| format!("# **row {i}**\n")).collect();
    let expected: String = (0..lines).map(|i| format!("- **row {i}**\n")).collect();
    let mut session = EditorSession::open(&source);
    let selected = DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(session.display_text().len()),
    };
    session.select(session.revision(), selected).unwrap();
    let change = session
        .block_command(
            session.revision(),
            selected,
            BlockCommand::BulletList,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text(), expected);
    let comparisons = usize::BITS as usize - lines.leading_zeros() as usize;
    let budget = lines * (512 + 8 * comparisons);
    assert!(
        change.work.link_metadata_items <= budget,
        "{} metadata visits for {lines} inline spans exceeds {budget}",
        change.work.link_metadata_items
    );
    session
        .undo(session.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text(), source);
    assert_eq!(session.selection(), selected);
}
