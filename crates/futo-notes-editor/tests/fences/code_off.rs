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

#[test]
fn code_command_at_a_saved_body_end_removes_its_own_fence() {
    for command in [BlockCommand::CodeBlock, BlockCommand::WrapCodeBlock] {
        let source = "```\ncode\n```\n";
        let mut session = EditorSession::open(source);
        let mut view = ReferenceView::new("code");
        session.select(session.revision(), range(4, 4)).unwrap();
        view.apply(
            session
                .block_command(session.revision(), range(4, 4), command, &mut |_| Ok(()))
                .unwrap()
                .expect("the body-end caret belongs to the code"),
        );
        assert_eq!(session.source_text(), "code\n");
        assert_eq!(view.text, "code\n");
        assert_eq!(session.selection(), range(4, 4));
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), source);
        assert_eq!(view.text, "code");
        assert_eq!(session.selection(), range(4, 4));
        view.apply(
            session
                .redo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), "code\n");
        assert_eq!(view.text, "code\n");
        assert_eq!(session.selection(), range(4, 4));
    }
}

fn assert_code_off_preserves_body(
    opening: &str,
    display: &str,
    selected: DisplayRange,
    markers: usize,
    retained_code: &[usize],
) {
    for command in [BlockCommand::CodeBlock, BlockCommand::WrapCodeBlock] {
        let mut session = EditorSession::open(opening);
        assert_eq!(session.display_text(), display);
        let mut view = ReferenceView::new(display);
        session.select(session.revision(), selected).unwrap();
        // Quote reads active over prose inside a quote, and code lines are set
        // aside from that test (Quote never changes them), so the fenced body
        // reads inactive while it is code and active once its text is quoted.
        let quoted = opening.starts_with('>');
        let mut accepted = 0;
        view.apply(
            session
                .block_command(session.revision(), selected, command, &mut |_| {
                    accepted += 1;
                    Ok(())
                })
                .unwrap()
                .expect("Code off changes the fenced body"),
        );
        assert_eq!(accepted, 1);
        assert_eq!(view.text, display, "{opening:?} {command:?}");
        assert_eq!(session.display_text(), display);
        assert_eq!(session.selection(), selected);
        assert!(!session.toolbar_state().code);
        assert_eq!(
            session.toolbar_state().quote,
            quoted,
            "{opening:?}: enclosing quote remains"
        );
        for &at in retained_code {
            assert!(
                session
                    .project(session.revision(), range(at, at))
                    .unwrap()
                    .blocks
                    .iter()
                    .any(|block| block.code),
                "{opening:?}: unselected row at{at} stays code"
            );
        }
        let count = session
            .project(session.revision(), range(0, display.len()))
            .unwrap()
            .blocks
            .iter()
            .filter(|block| block.list.as_ref().is_some_and(|list| list.first))
            .count();
        assert_eq!(count, markers, "{opening:?}: first marker appears once");
        let converted = session.source_text();
        assert_eq!(EditorSession::open(&converted).display_text(), display);
        view.apply(
            session
                .undo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), opening);
        assert_eq!(view.text, display);
        assert_eq!(session.selection(), selected);
        view.apply(
            session
                .redo(session.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(session.source_text(), converted);
        assert_eq!(view.text, display);
        assert_eq!(session.selection(), selected);
    }
}

#[test]
fn code_off_keeps_hidden_list_padding_out_of_visible_text() {
    for (opening, display) in [
        ("- ```\n  \n  ```", ""),
        ("- ```\n  ```", ""),
        ("- ```\n", ""),
        ("- ```", ""),
        ("- ```\n  x\n  ```", "x"),
        ("9. ```\n   x\n   ```", "x"),
        ("> - ```\n>   x\n>   ```", "x"),
    ] {
        assert_code_off_preserves_body(opening, display, range(0, display.len()), 1, &[]);
    }
}

#[test]
fn code_off_hidden_padding_controls_keep_root_and_quote_text() {
    for (opening, display) in [
        ("```\n\n```", ""),
        ("```\n```", ""),
        ("```\n", ""),
        ("```", ""),
        ("```\nx\n```", "x"),
        ("> ```\n> \n> ```", ""),
        ("> ```\n> ```", ""),
        ("> ```\n", ""),
        ("> ```", ""),
        ("> ```\n> x\n> ```", "x"),
    ] {
        assert_code_off_preserves_body(opening, display, range(0, display.len()), 0, &[]);
    }
}

#[test]
fn code_off_retires_hidden_fence_indent_but_keeps_opaque_spaces() {
    for (opening, display) in [
        ("  ```\n  x\n  ```", "x"),
        ("  ```\n    x\n  ```", "  x"),
        ("  ```\n  \n  ```", ""),
    ] {
        assert_code_off_preserves_body(opening, display, range(0, display.len()), 0, &[]);
    }
}

#[test]
fn code_off_split_rows_keep_the_container_marker_once() {
    for (opening, display, carets, markers) in [
        ("- ```\n  x\n  y\n  z\n  ```", "x\ny\nz", [0, 2, 4], 1),
        ("9. ```\n   x\n   y\n   z\n   ```", "x\ny\nz", [0, 2, 4], 1),
        (
            "> - ```\n>   x\n>   y\n>   z\n>   ```",
            "x\ny\nz",
            [0, 2, 4],
            1,
        ),
        (
            "9. ```lang\r\n   x\r\n   y\r\n   z\r\n   ```",
            "x\r\ny\r\nz",
            [0, 3, 6],
            1,
        ),
        ("-\t```\n\tx\n\ty\n\tz\n\t```", "x\ny\nz", [0, 2, 4], 1),
        (
            "- parent\n  - ```\n    x\n    y\n    z\n    ```",
            "parent\nx\ny\nz",
            [7, 9, 11],
            2,
        ),
    ] {
        for caret in carets {
            let retained: Vec<_> = carets.into_iter().filter(|&at| at != caret).collect();
            assert_code_off_preserves_body(
                opening,
                display,
                range(caret, caret),
                markers,
                &retained,
            );
        }
    }
}

#[test]
fn code_off_keeps_one_marker_across_partitioned_fence_rows() {
    for eol in ["\n", "\r\n"] {
        let row = format!("opaque{eol}");
        let display = row.repeat(2_000).trim_end_matches(['\r', '\n']).to_owned();
        let opening = format!(
            "9. ```lang{eol}   {}{eol}   ```",
            display.replace(eol, &format!("{eol}   "))
        );
        let caret = row.len() * 1_000;
        assert_code_off_preserves_body(
            &opening,
            &display,
            range(caret, caret),
            1,
            &[0, row.len() * 1_999],
        );
    }
}
