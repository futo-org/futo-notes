use super::*;

#[test]
fn selection_ending_before_multiline_code_preserves_its_neighbor_bytes() {
    let mut s = EditorSession::open("a\r\n`b\r\nc`");
    let mut v = ReferenceView::new("a\r\nb c");
    v.apply(
        s.block_command(
            s.revision(),
            range(0, 3),
            BlockCommand::Heading(1),
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "# a\r\n`b\r\nc`");
    assert_eq!(v.text, "a\r\nb c");
    v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "a\r\n`b\r\nc`");
}

#[test]
fn heading_command_keeps_a_multiline_inline_code_visible_line_intact() {
    for (raw, shown, expected) in [
        (
            "`a\r\nb`\r\n\r\nneighbor",
            "a b\r\n\r\nneighbor",
            "## `a b`\r\n\r\nneighbor",
        ),
        (
            "> `a\r\n> b`\r\n\r\nneighbor",
            "a b\r\n\r\nneighbor",
            "> ## `a b`\r\n\r\nneighbor",
        ),
        (
            "``a\r\n`\r\nb``\r\n\r\nneighbor",
            "a ` b\r\n\r\nneighbor",
            "## ``a ` b``\r\n\r\nneighbor",
        ),
        (
            "x ````a ``` b````\r\n\r\nneighbor",
            "x a ``` b\r\n\r\nneighbor",
            "## x ````a ``` b````\r\n\r\nneighbor",
        ),
    ] {
        let mut s = EditorSession::open(raw);
        let mut v = ReferenceView::new(shown);
        s.select(s.revision(), range(1, 1)).unwrap();
        v.apply(
            s.block_command(
                s.revision(),
                s.selection(),
                BlockCommand::Heading(2),
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
        );
        assert_eq!(s.source_text(), expected, "{raw:?}");
        assert_eq!(v.text, shown);
        assert_eq!(s.selection(), range(1, 1));
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(v.text, shown);
    }
}

#[test]
fn block_formatting_preserves_carried_inline_formats() {
    let mut s = EditorSession::open("");
    let mut v = ReferenceView::new("");
    s.toggle_format(s.revision(), InlineFormat::Bold, &mut |_| Ok(()))
        .unwrap();
    v.apply(
        s.block_command(
            s.revision(),
            s.selection(),
            BlockCommand::Heading(2),
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.active_formats(), vec![InlineFormat::Bold]);
    v.apply(
        s.replace(s.revision(), s.selection(), "a", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(s.source_text(), "## **a**");
    assert_eq!(v.text, "a");
    v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "## ");
    assert_eq!(s.active_formats(), vec![InlineFormat::Bold]);
    v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "");
    assert_eq!(s.active_formats(), vec![InlineFormat::Bold]);
}

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

#[test]
fn block_formatting_keeps_visible_block_punctuation_literal() {
    for (raw, command, expected, display) in [
        ("A #", BlockCommand::Heading(1), "# A \\#", "A #"),
        ("# # x", BlockCommand::Heading(0), "\\# x", "# x"),
        ("# > x", BlockCommand::Heading(0), "\\> x", "> x"),
        ("# - x", BlockCommand::Heading(0), "\\- x", "- x"),
        ("# ```", BlockCommand::Heading(0), "\\```", "```"),
        ("# # x", BlockCommand::Quote, "> \\# x", "# x"),
    ] {
        let mut s = EditorSession::open(raw);
        let mut v = ReferenceView::new(display);
        v.apply(
            s.block_command(s.revision(), range(0, 0), command, &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(s.source_text(), expected, "{raw:?} {command:?}");
        assert_eq!(v.text, display);
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
    }
}

#[test]
fn structural_commands_split_inline_runs_only_at_the_new_block_seams() {
    for (raw, selected, command, expected, shown) in [
        (
            "__a\nb__",
            range(2, 3),
            BlockCommand::Heading(2),
            "__a__\n## __b__",
            "a\nb",
        ),
        (
            "__a\nb__",
            range(0, 3),
            BlockCommand::Heading(2),
            "## __a__\n## __b__",
            "a\nb",
        ),
        (
            "> __a\n> b__",
            range(2, 3),
            BlockCommand::Heading(2),
            "> __a__\n> ## __b__",
            "a\nb",
        ),
        (
            "__a\nb__",
            range(2, 3),
            BlockCommand::Quote,
            "__a__\n> __b__",
            "a\nb",
        ),
        (
            "> __a\n> b__",
            range(2, 3),
            BlockCommand::Indent,
            "> __a__\n> > __b__",
            "a\nb",
        ),
        (
            "> __a\n> b__",
            range(2, 3),
            BlockCommand::Outdent,
            "> __a__\n\n__b__",
            "a\n\nb",
        ),
    ] {
        let mut s = EditorSession::open(raw);
        let mut v = ReferenceView::new("a\nb");
        let mut calls = 0;
        v.apply(
            s.block_command(s.revision(), selected, command, &mut |_| {
                calls += 1;
                Ok(())
            })
            .unwrap()
            .unwrap(),
        );
        assert_eq!(calls, 1);
        assert_eq!(s.source_text(), expected, "{raw:?} {command:?}");
        assert_eq!(v.text, shown);
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(v.text, "a\nb");
    }
}
