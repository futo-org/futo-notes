use super::*;

#[test]
fn heading_command_targets_only_touched_visible_lines_and_exact_history() {
    for level in 1..=6 {
        let mut s = EditorSession::open("before\r\nA\r\nB\r\nafter\r\n");
        let mut v = ReferenceView::new("before\r\nA\r\nB\r\nafter\r\n");
        s.select(Revision(0), range(8, 12)).unwrap();
        v.apply(
            s.block_command(
                Revision(0),
                range(8, 12),
                BlockCommand::Heading(level),
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
        );
        assert_eq!(
            s.source_text(),
            format!(
                "before\r\n{} A\r\n{} B\r\nafter\r\n",
                "#".repeat(level as usize),
                "#".repeat(level as usize)
            )
        );
        assert_eq!(v.text, "before\r\nA\r\nB\r\nafter\r\n");
        assert_eq!(s.selection(), range(8, 12));
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), "before\r\nA\r\nB\r\nafter\r\n");
        assert_eq!(s.selection(), range(8, 12));
    }
}
#[test]
fn explicit_quote_choice_replaces_heading_and_indent_changes_one_level() {
    let mut s = EditorSession::open("## Title ##\r\n\r\nend");
    s.block_command(s.revision(), range(0, 0), BlockCommand::Quote, &mut |_| {
        Ok(())
    })
    .unwrap();
    assert_eq!(s.source_text(), "> Title\r\n\r\nend");
    assert!(s
        .block_command(s.revision(), range(0, 0), BlockCommand::Quote, &mut |_| Ok(
            ()
        ))
        .unwrap()
        .is_none());
    s.block_command(s.revision(), range(0, 0), BlockCommand::Indent, &mut |_| {
        Ok(())
    })
    .unwrap();
    assert_eq!(s.source_text(), "> > Title\r\n\r\nend");
    s.block_command(
        s.revision(),
        range(0, 0),
        BlockCommand::Outdent,
        &mut |_| Ok(()),
    )
    .unwrap();
    assert_eq!(s.source_text(), "> Title\r\n\r\nend");
}

#[test]
fn quote_commands_do_not_adopt_neighboring_lazy_lines() {
    let mut s = EditorSession::open("before\r\nA\r\nB\r\nend");
    let mut v = ReferenceView::new("before\r\nA\r\nB\r\nend");
    v.apply(
        s.block_command(s.revision(), range(8, 9), BlockCommand::Quote, &mut |_| {
            Ok(())
        })
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "before\r\n> A\r\n\nB\r\nend");
    let p = s.project(s.revision(), range(12, 13)).unwrap();
    assert!(p.blocks.iter().all(|b| b.quote_depth == 0));
    v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "before\r\nA\r\nB\r\nend");
    let mut s = EditorSession::open("> a\n> b\n> c");
    s.block_command(
        s.revision(),
        range(2, 3),
        BlockCommand::Outdent,
        &mut |_| Ok(()),
    )
    .unwrap();
    assert_eq!(s.source_text(), "> a\n\nb\n> c");
    let p = s.project(s.revision(), range(3, 4)).unwrap();
    assert_eq!(p.blocks[0].quote_depth, 0);
}
#[test]
fn commands_on_lazy_quote_lines_retain_the_requested_container_depth() {
    for (command, expected, depth, heading) in [
        (BlockCommand::Heading(3), "> a\n> ### b\n> c", 1, 3),
        (BlockCommand::Indent, "> a\n> > b\n>\n> c", 2, 0),
        (BlockCommand::Outdent, "> a\n\nb\n> c", 0, 0),
    ] {
        let mut s = EditorSession::open("> a\nb\n> c");
        s.block_command(s.revision(), range(2, 3), command, &mut |_| Ok(()))
            .unwrap();
        assert_eq!(s.source_text(), expected, "{command:?}");
        let point = if command == BlockCommand::Outdent {
            3
        } else {
            2
        };
        let p = s.project(s.revision(), range(point, point + 1)).unwrap();
        assert_eq!(p.blocks[0].quote_depth, depth);
        assert_eq!(p.blocks[0].heading, heading);
    }
}
