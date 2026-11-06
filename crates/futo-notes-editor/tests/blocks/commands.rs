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
    assert_eq!(s.source_text(), "before\r\n> A\r\n\r\nB\r\nend");
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

#[test]
fn heading_conversion_preserves_visible_indentation_and_a_usable_native_caret() {
    let mut s = EditorSession::open("   foo");
    let mut v = ReferenceView::new("   foo");
    s.select(s.revision(), range(6, 6)).unwrap();
    let change = s
        .block_command_utf16(
            s.revision(),
            DisplayUtf16Range {
                start: DisplayUtf16Offset(6),
                end: DisplayUtf16Offset(6),
            },
            BlockCommand::Heading(2),
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap();
    v.apply(change);
    assert_eq!(s.source_text(), "## &#32;  foo");
    assert_eq!(v.text, "   foo");
    assert_eq!(s.selection(), range(6, 6));
    v.apply(
        s.replace(s.revision(), s.selection(), "x", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(v.text, "   foox");
    v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "   foo");
    assert_eq!(s.selection(), range(6, 6));
}

#[test]
fn text_conversion_retires_heading_indentation_without_exposing_spaces() {
    for (raw, expected, shown) in [
        ("   # foo", "foo", "foo"),
        (
            "  >   ## 猫🦊 ##\r\n\r\nend",
            "  > 猫🦊\r\n\r\nend",
            "猫🦊\r\n\r\nend",
        ),
    ] {
        let mut s = EditorSession::open(raw);
        assert_eq!(s.display_text(), shown);
        let mut v = ReferenceView::new(shown);
        v.apply(
            s.block_command(
                s.revision(),
                range(0, 0),
                BlockCommand::Heading(0),
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
        );
        assert_eq!(s.source_text(), expected);
        assert_eq!(v.text, shown);
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
    }
}

#[test]
fn explicit_quote_on_a_quoted_heading_takes_one_quote_level_off_and_keeps_the_heading() {
    for (raw, expected, shown, level, depth) in [
        ("> ## Title ##", "## Title ##", "Title", 2, 0),
        (
            "> > ### 猫🦊 ###\r\n\r\nend",
            "> ### 猫🦊 ###\r\n\r\nend",
            "猫🦊\r\n\r\nend",
            3,
            1,
        ),
        ("> > > ###### x ######", "> > ###### x ######", "x", 6, 2),
    ] {
        let mut s = EditorSession::open(raw);
        let mut v = ReferenceView::new(shown);
        let mut accepted = 0;
        v.apply(
            s.block_command(s.revision(), range(0, 0), BlockCommand::Quote, &mut |_| {
                accepted += 1;
                Ok(())
            })
            .unwrap()
            .unwrap(),
        );
        assert_eq!(accepted, 1);
        assert_eq!(s.source_text(), expected);
        assert_eq!(v.text, shown);
        let blocks = s.project(s.revision(), range(0, 0)).unwrap().blocks;
        assert_eq!(blocks[0].heading, level);
        assert_eq!(blocks[0].quote_depth, depth);
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(v.text, shown);
        v.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
    }
}

#[test]
fn all_heading_levels_preserve_body_spaces_unicode_selection_and_exact_history() {
    for (level, expected) in [
        (1, "# &#32; 猫🦊\r\n\r\nend  "),
        (2, "## &#32; 猫🦊\r\n\r\nend  "),
        (3, "### &#32; 猫🦊\r\n\r\nend  "),
        (4, "#### &#32; 猫🦊\r\n\r\nend  "),
        (5, "##### &#32; 猫🦊\r\n\r\nend  "),
        (6, "###### &#32; 猫🦊\r\n\r\nend  "),
    ] {
        let raw = "  猫🦊\r\n\r\nend  ";
        let mut s = EditorSession::open(raw);
        let mut v = ReferenceView::new(raw);
        s.select(s.revision(), range(2, 9)).unwrap();
        v.apply(
            s.block_command_utf16(
                s.revision(),
                DisplayUtf16Range {
                    start: DisplayUtf16Offset(2),
                    end: DisplayUtf16Offset(5),
                },
                BlockCommand::Heading(level),
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
        );
        assert_eq!(s.source_text(), expected);
        assert_eq!(v.text, raw);
        assert_eq!(s.selection(), range(2, 9));
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), range(2, 9));
        v.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
        assert_eq!(v.text, raw);
    }
}

#[test]
fn text_command_on_each_setext_quote_line_keeps_body_prefixes_and_exact_history() {
    for (raw, expected, shown, selections) in [
        (
            "> foo\n> bar\n> ===",
            "> foo\n> bar",
            "foo\nbar",
            [range(0, 3), range(4, 7), range(0, 7)],
        ),
        (
            "> > 猫🦊\r\n> > café\r\n> > ===\r\n",
            "> > 猫🦊\r\n> > café\r\n",
            "猫🦊\r\ncafé\r\n",
            [range(0, 7), range(9, 14), range(0, 14)],
        ),
    ] {
        for selected in selections {
            let mut s = EditorSession::open(raw);
            let mut v = ReferenceView::new(shown);
            s.select(s.revision(), selected).unwrap();
            v.apply(
                s.block_command(
                    s.revision(),
                    selected,
                    BlockCommand::Heading(0),
                    &mut |_| Ok(()),
                )
                .unwrap()
                .unwrap(),
            );
            assert_eq!(s.source_text(), expected);
            assert_eq!(v.text, shown);
            assert_eq!(s.selection(), selected);
            v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(s.source_text(), raw);
            assert_eq!(s.selection(), selected);
            v.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(s.source_text(), expected);
            assert_eq!(v.text, shown);
        }
    }
}

#[test]
fn whole_setext_quote_depth_changes_every_owned_prefix_and_exact_history() {
    for (raw, shown, command, expected, depth) in [
        ("> x\n> =", "x", BlockCommand::Indent, "> > x\n> > =", 2),
        ("> x\n> =", "x", BlockCommand::Outdent, "x\n=", 0),
        (
            "  > x\r\n  > y\r\n  > ---\r\n",
            "x\r\ny\r\n",
            BlockCommand::Indent,
            "> > x\r\n> > y\r\n> > ---\r\n",
            2,
        ),
        (
            "> > 猫🦊\r\n> > e\u{301}\r\n> > ===",
            "猫🦊\r\ne\u{301}",
            BlockCommand::Outdent,
            "> 猫🦊\r\n> e\u{301}\r\n> ===",
            1,
        ),
    ] {
        let mut s = EditorSession::open(raw);
        let mut v = ReferenceView::new(shown);
        let selected = range(0, shown.len());
        s.select(s.revision(), selected).unwrap();
        let revision = s.revision();
        assert!(s
            .block_command(revision, selected, command, &mut |_| Err("blocked".into()))
            .is_err());
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), selected);
        assert_eq!(s.revision(), revision);
        let mut accepts = 0;
        v.apply(
            s.block_command(revision, selected, command, &mut |_| {
                accepts += 1;
                Ok(())
            })
            .unwrap()
            .unwrap(),
        );
        assert_eq!(accepts, 1);
        assert_eq!(s.source_text(), expected);
        assert_eq!(v.text, shown);
        assert_eq!(s.selection(), selected);
        let blocks = s.project(s.revision(), selected).unwrap().blocks;
        assert!(blocks
            .iter()
            .all(|b| b.quote_depth == depth && b.heading > 0));
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), selected);
        v.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
        assert_eq!(v.text, shown);
    }
}

#[test]
fn a_block_command_on_the_last_empty_line_reports_that_line_s_new_block() {
    for raw in ["", "text\n", "text\n\n\n", "text\n\n\nmore"] {
        for command in [
            BlockCommand::Heading(1),
            BlockCommand::Quote,
            BlockCommand::CodeBlock,
        ] {
            let mut s = EditorSession::open(raw);
            let caret = if raw.ends_with("more") { 6 } else { raw.len() };
            let change = s
                .block_command(s.revision(), range(caret, caret), command, &mut |_| Ok(()))
                .unwrap()
                .unwrap();
            let carries_it = change.projection.blocks.iter().any(|b| {
                b.range.start.0 <= caret
                    && caret <= b.range.end.0
                    && match command {
                        BlockCommand::Heading(level) => b.heading == level,
                        BlockCommand::Quote => b.quote_depth > 0,
                        _ => b.code,
                    }
            });
            assert!(
                carries_it,
                "{raw:?} {command:?}: {:?}",
                change.projection.blocks
            );
        }
    }
}
