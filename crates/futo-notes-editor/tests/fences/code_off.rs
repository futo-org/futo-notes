use super::*;

#[test]
fn code_off_keeps_table_shaped_contents_plain() {
    for (body, command) in [
        ("a | b\n|-|-|", BlockCommand::WrapCodeBlock),
        ("a | b\n|-|-|", BlockCommand::CodeBlock),
        (
            "| a | b |\n| - | - |\n| c | d |",
            BlockCommand::WrapCodeBlock,
        ),
        ("| a | b |\n| - | - |\n| c | d |", BlockCommand::CodeBlock),
    ] {
        let opening = format!("```\n{body}\n```");
        let mut session = EditorSession::open(&opening);
        let mut view = ReferenceView::new(body);
        let selected = range(0, body.len());
        session.select(session.revision(), selected).unwrap();
        assert!(session
            .inspect_tables(session.revision(), selected)
            .unwrap()
            .is_empty());
        let mut accepted = 0;
        view.apply(
            session
                .block_command(session.revision(), selected, command, &mut |_| {
                    accepted += 1;
                    Ok(())
                })
                .unwrap()
                .unwrap(),
        );
        assert_eq!(accepted, 1);
        assert_eq!(view.text, body);
        assert_eq!(session.selection(), selected);
        assert!(session
            .project(session.revision(), selected)
            .unwrap()
            .blocks
            .iter()
            .all(|block| !block.code && block.heading == 0 && block.list.is_none()));
        // Tables keep their pipes in display text, but hosts draw a grid from
        // this separate canonical query. Text equality alone misses the bug.
        assert!(
            session
                .inspect_tables(session.revision(), selected)
                .unwrap()
                .is_empty(),
            "code-off text became a table: {:?}",
            session.source_text()
        );
        let converted = session.source_text();
        let reopened = EditorSession::open(&converted);
        assert_eq!(reopened.display_text(), body);
        assert!(reopened
            .inspect_tables(reopened.revision(), selected)
            .unwrap()
            .is_empty());
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), opening);
        assert_eq!(session.selection(), selected);
        assert_eq!(view.text, body);
        view.apply(
            session
                .redo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), converted);
        assert_eq!(session.selection(), selected);
        assert!(session
            .inspect_tables(session.revision(), selected)
            .unwrap()
            .is_empty());
    }
}

#[test]
fn code_off_keeps_a_genuine_table_outside_its_rows() {
    let body = "literal | pipe";
    let genuine = "| keep | safe |\n| - | - |";
    let opening = format!("```\n{body}\n```\n\n{genuine}");
    let mut session = EditorSession::open(&opening);
    let display = session.display_text();
    let mut view = ReferenceView::new(&display);
    let all = range(0, display.len());
    let before = session.inspect_tables(session.revision(), all).unwrap();
    assert_eq!(before.len(), 1);
    let selected = range(0, body.len());
    session.select(session.revision(), selected).unwrap();
    view.apply(
        session
            .block_command(
                session.revision(),
                selected,
                BlockCommand::WrapCodeBlock,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.display_text(), display);
    assert_eq!(view.text, display);
    assert_eq!(session.selection(), selected);
    assert!(session.source_text().ends_with(genuine));
    let after = session.inspect_tables(session.revision(), all).unwrap();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0].display, before[0].display);
    assert_eq!((after[0].columns, after[0].rows.len()), (2, 1));
    view.apply(
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap(),
    );
    assert_eq!(session.source_text(), opening);
    assert_eq!(session.selection(), selected);
    assert_eq!(
        session
            .inspect_tables(session.revision(), all)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn code_off_does_not_adopt_an_untouched_header_as_a_table() {
    let opening = "a | b\n```\n|-|-|\n```";
    for command in [BlockCommand::WrapCodeBlock, BlockCommand::CodeBlock] {
        let mut session = EditorSession::open(opening);
        let display = "a | b\n|-|-|";
        let mut view = ReferenceView::new(display);
        let all = range(0, display.len());
        let selected = range(6, 6);
        session.select(session.revision(), selected).unwrap();
        assert!(session
            .inspect_tables(session.revision(), all)
            .unwrap()
            .is_empty());
        view.apply(
            session
                .block_command(session.revision(), selected, command, &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(view.text, display);
        assert_eq!(session.selection(), selected);
        assert!(session.source_text().starts_with("a | b\n"));
        // The new table's header would start outside the converted code row.
        assert!(session
            .inspect_tables(session.revision(), all)
            .unwrap()
            .is_empty());
        let converted = session.source_text();
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), opening);
        assert_eq!(session.selection(), selected);
        view.apply(
            session
                .redo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), converted);
        assert!(session
            .inspect_tables(session.revision(), all)
            .unwrap()
            .is_empty());
    }
}
