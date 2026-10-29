mod common;
use common::ReferenceView;
use futo_notes_editor::*;
fn range(a: usize, b: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(a),
        end: DisplayOffset(b),
    }
}
#[test]
fn opening_blocks_hides_markers_and_preserves_their_exact_bytes() {
    let raw = "### Head ###\r\n> > **deep**\r\n> lazy\r\n\r\n* * *\r\nend";
    let session = EditorSession::open(raw);
    assert_eq!(session.source_text(), raw);
    assert_eq!(
        session.display_text(),
        "Head\r\ndeep\r\nlazy\r\n\r\n\u{fffc}\r\nend"
    );
}
#[test]
fn typing_in_a_heading_keeps_neighboring_quote_and_marker_spelling() {
    let mut session = EditorSession::open("### A ###\r\n> **B**\r\n");
    let mut view = ReferenceView::new("A\r\nB\r\n");
    let change = session
        .replace(Revision(0), range(1, 1), "x", &mut |_| Ok(()))
        .unwrap();
    view.apply(change);
    assert_eq!(session.source_text(), "### Ax ###\r\n> **B**\r\n");
    assert_eq!(view.text, "Ax\r\nB\r\n");
    assert_eq!(session.selection(), range(2, 2));
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
fn structural_enter_splits_headings_and_continues_or_exits_nested_quotes() {
    for (raw, shown, at, expected, display, caret) in [
        ("## ab", "ab", 0, "\n## ab", "\nab", 1),
        ("## ab", "ab", 1, "## a\nb", "a\nb", 2),
        ("## ab", "ab", 2, "## ab\n", "ab\n", 3),
        ("> > ab", "ab", 0, "\n> > ab", "\nab", 1),
        ("> > ab", "ab", 1, "> > a\n> >\n> > b", "a\n\nb", 3),
        ("> > ab", "ab", 2, "> > ab\n> >\n> > ", "ab\n\n", 4),
        ("> > ", "", 0, "> ", "", 0),
        ("> ", "", 0, "", "", 0),
    ] {
        let mut s = EditorSession::open(raw);
        let mut v = ReferenceView::new(shown);
        v.apply(
            s.paragraph_key(
                s.revision(),
                range(at, at),
                ParagraphKey::Enter,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
        );
        assert_eq!(s.source_text(), expected, "{raw:?} at {at}");
        assert_eq!(v.text, display);
        assert_eq!(s.selection(), range(caret, caret));
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(v.text, shown);
    }
}
#[test]
fn divider_command_leaves_one_editable_paragraph_and_exact_undo() {
    let mut s = EditorSession::open("");
    let mut v = ReferenceView::new("");
    v.apply(
        s.block_command(
            s.revision(),
            range(0, 0),
            BlockCommand::Divider,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "---\n");
    assert_eq!(v.text, "\u{fffc}\n");
    assert_eq!(s.selection(), range(4, 4));
    v.apply(
        s.replace(s.revision(), s.selection(), "X", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(s.source_text(), "---\nX");
    assert_eq!(v.text, "\u{fffc}\nX");
    v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "---\n");
    v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "");
}
#[test]
fn typed_heading_and_quote_shortcuts_are_one_triggering_action() {
    for (trigger, expected, shown) in [("# ", "# ", ""), ("> ", "> ", "")] {
        let mut s = EditorSession::open("");
        let mut v = ReferenceView::new("");
        for ch in trigger.chars() {
            v.apply(
                s.replace(
                    s.revision(),
                    s.selection(),
                    &ch.to_string(),
                    &mut |_| Ok(()),
                )
                .unwrap(),
            );
        }
        assert_eq!(s.source_text(), expected);
        assert_eq!(v.text, shown);
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(v.text, &trigger[..trigger.len() - 1]);
        v.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
    }
}
#[test]
fn setext_headings_keep_their_spelling_when_typing_and_change_locally_by_command() {
    let mut s = EditorSession::open("Title\r\n=====\r\nnext\r\n");
    let mut v = ReferenceView::new("Title\r\nnext\r\n");
    assert_eq!(s.display_text(), v.text);
    v.apply(
        s.replace(s.revision(), range(5, 5), "X", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(s.source_text(), "TitleX\r\n=====\r\nnext\r\n");
    v.apply(
        s.block_command(
            s.revision(),
            range(0, 0),
            BlockCommand::Heading(3),
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "### TitleX\r\nnext\r\n");
    assert_eq!(v.text, "TitleX\r\nnext\r\n");
    v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "TitleX\r\n=====\r\nnext\r\n");
}

#[test]
fn empty_quote_paragraph_exit_survives_reopen_at_each_depth() {
    let mut s = EditorSession::open("> > deep");
    s.paragraph_key(s.revision(), range(4, 4), ParagraphKey::Enter, &mut |_| {
        Ok(())
    })
    .unwrap();
    assert_eq!(s.source_text(), "> > deep\n> >\n> > ");
    s.paragraph_key(
        s.revision(),
        s.selection(),
        ParagraphKey::Enter,
        &mut |_| Ok(()),
    )
    .unwrap();
    assert_eq!(s.source_text(), "> > deep\n>\n> ");
    s.paragraph_key(
        s.revision(),
        s.selection(),
        ParagraphKey::Enter,
        &mut |_| Ok(()),
    )
    .unwrap();
    assert_eq!(s.source_text(), "> > deep\n\n");
    s.replace(s.revision(), s.selection(), "outside", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(s.source_text(), "> > deep\n\noutside");
    let reopened = EditorSession::open(&s.source_text());
    let projection = reopened.project(reopened.revision(), range(6, 13)).unwrap();
    assert!(projection.blocks.iter().all(|block| block.quote_depth == 0));
}
#[test]
fn structural_splits_keep_inline_styles_and_exact_neighboring_source() {
    for (opening, at, expected, shown, caret) in [
        (
            "## __ab__\r\nuntouched",
            1,
            "## __a__\n__b__\r\nuntouched",
            "a\nb\r\nuntouched",
            2,
        ),
        (
            "> __ab__\r\n\r\nuntouched",
            1,
            "> __a__\n>\n> __b__\r\n\r\nuntouched",
            "a\n\nb\r\n\r\nuntouched",
            3,
        ),
    ] {
        let mut s = EditorSession::open(opening);
        let change = s
            .paragraph_key(
                s.revision(),
                range(at, at),
                ParagraphKey::Enter,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap();
        assert_eq!(s.source_text(), expected);
        assert_eq!(s.display_text(), shown);
        assert_eq!(change.selection, range(caret, caret));
    }
    let mut s = EditorSession::open("__ab__\r\nend");
    s.block_command(
        s.revision(),
        range(1, 1),
        BlockCommand::Divider,
        &mut |_| Ok(()),
    )
    .unwrap();
    assert_eq!(s.source_text(), "__a__\n***\n\n__b__\r\nend");
    assert_eq!(s.display_text(), "a\n\u{fffc}\n\nb\r\nend");
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
fn typed_dividers_leave_the_editable_paragraph_and_undo_the_trigger_only() {
    for trigger in ["---", "___ ", "*** "] {
        let mut s = EditorSession::open("");
        let mut v = ReferenceView::new("");
        for ch in trigger.chars() {
            v.apply(
                s.replace(
                    s.revision(),
                    s.selection(),
                    &ch.to_string(),
                    &mut |_| Ok(()),
                )
                .unwrap(),
            );
        }
        assert_eq!(s.source_text(), "---\n", "{trigger:?}");
        assert_eq!(v.text, "\u{fffc}\n");
        assert_eq!(s.selection(), range(4, 4));
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(v.text, trigger[..trigger.len() - 1]);
        v.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), "---\n");
    }
    let mut s = EditorSession::open("before\r\n\r\nafter");
    s.select(s.revision(), range(8, 8)).unwrap();
    for _ in 0..3 {
        s.replace(s.revision(), s.selection(), "-", &mut |_| Ok(()))
            .unwrap();
    }
    assert_eq!(s.source_text(), "before\r\n***\n\r\nafter");
    assert_eq!(s.display_text(), "before\r\n\u{fffc}\n\r\nafter");
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
fn selecting_heading_or_quote_text_then_enter_is_one_exact_action() {
    for (raw, selection, expected, shown) in [
        (
            "## __abcd__\r\nend",
            range(1, 3),
            "## __a__\n__d__\r\nend",
            "a\nd\r\nend",
        ),
        ("> abcd", range(0, 2), "\n> cd", "\ncd"),
    ] {
        let mut s = EditorSession::open(raw);
        s.select(s.revision(), selection).unwrap();
        let mut accepted = 0;
        s.paragraph_key(s.revision(), selection, ParagraphKey::Enter, &mut |_| {
            accepted += 1;
            Ok(())
        })
        .unwrap()
        .unwrap();
        assert_eq!(accepted, 1);
        assert_eq!(s.source_text(), expected);
        assert_eq!(s.display_text(), shown);
        s.undo(s.revision(), &mut |_| Ok(())).unwrap();
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), selection);
    }
}
#[test]
fn commands_commit_marked_text_before_formatting_with_distinct_exact_history() {
    let mut s = EditorSession::open("A\r\nend");
    let mut v = ReferenceView::new("A\r\nend");
    s.compose(s.revision(), range(1, 1), "日本").unwrap();
    let mut calls = 0;
    v.apply(
        s.block_command(
            s.revision(),
            range(7, 7),
            BlockCommand::Heading(2),
            &mut |_| {
                calls += 1;
                Ok(())
            },
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(calls, 1);
    assert!(s.composition().is_none());
    assert_eq!(s.source_text(), "## A日本\r\nend");
    assert_eq!(v.text, "A日本\r\nend");
    assert_eq!(s.selection(), range(7, 7));
    v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "A日本\r\nend");
    v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "A\r\nend");
}

#[test]
fn empty_heading_enter_puts_the_caret_in_a_following_paragraph() {
    let mut s = EditorSession::open("## ");
    let change = s
        .paragraph_key(s.revision(), range(0, 0), ParagraphKey::Enter, &mut |_| {
            Ok(())
        })
        .unwrap()
        .unwrap();
    assert_eq!(s.source_text(), "## \n");
    assert_eq!(change.selection, range(1, 1));
    assert_eq!(
        s.project(s.revision(), range(1, 1)).unwrap().blocks[0].heading,
        0
    );
}
#[test]
fn quote_shortcut_isolates_its_line_from_following_plain_text() {
    let mut s = EditorSession::open("before\r\n\r\nafter");
    s.select(s.revision(), range(8, 8)).unwrap();
    s.replace(s.revision(), s.selection(), ">", &mut |_| Ok(()))
        .unwrap();
    s.replace(s.revision(), s.selection(), " ", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(s.source_text(), "before\r\n> \r\n\nafter");
    s.replace(s.revision(), s.selection(), "Q", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(s.source_text(), "before\r\n> Q\r\n\nafter");
    assert_eq!(
        s.project(s.revision(), range(12, 17))
            .unwrap()
            .blocks
            .last()
            .unwrap()
            .quote_depth,
        0
    );
}
#[test]
fn divider_caret_edges_create_text_paragraphs_and_deleting_the_atom_undoes_exactly() {
    for (at, expected, shown, caret) in [
        (0, "X\n* * *\r\nend", "X\n\u{fffc}\r\nend", 1),
        (3, "* * *\nX\r\nend", "\u{fffc}\nX\r\nend", 5),
    ] {
        let mut s = EditorSession::open("* * *\r\nend");
        let mut v = ReferenceView::new("\u{fffc}\r\nend");
        v.apply(
            s.replace(s.revision(), range(at, at), "X", &mut |_| Ok(()))
                .unwrap(),
        );
        assert_eq!(s.source_text(), expected);
        assert_eq!(v.text, shown);
        assert_eq!(s.selection(), range(caret, caret));
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), "* * *\r\nend");
        v.apply(
            s.replace(s.revision(), range(0, 3), "X", &mut |_| Ok(()))
                .unwrap(),
        );
        assert_eq!(s.source_text(), "X\r\nend");
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), "* * *\r\nend");
    }
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
fn typing_before_a_dash_divider_keeps_it_a_divider_instead_of_a_setext_heading() {
    let mut s = EditorSession::open("---\r\nend");
    s.replace(s.revision(), range(0, 0), "X", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(s.source_text(), "X\n***\r\nend");
    assert_eq!(s.display_text(), "X\n\u{fffc}\r\nend");
    s.undo(s.revision(), &mut |_| Ok(())).unwrap();
    assert_eq!(s.source_text(), "---\r\nend");
}
#[test]
fn quote_backspace_joins_within_its_container_and_first_block_backspace_exits() {
    for (raw, display, at, expected, shown) in [
        ("> __a__\n>\n> __b__", "a\n\nb", 3, "> __ab__", "ab"),
        ("> a\n> b", "a\nb", 2, "> ab", "ab"),
        ("> > ab", "ab", 0, "> ab", "ab"),
        ("## ab", "ab", 0, "ab", "ab"),
    ] {
        let mut s = EditorSession::open(raw);
        let mut v = ReferenceView::new(display);
        v.apply(
            s.paragraph_key(
                s.revision(),
                range(at, at),
                ParagraphKey::Backspace,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
        );
        assert_eq!(s.source_text(), expected, "{raw:?}");
        assert_eq!(v.text, shown);
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
    }
}
#[test]
fn quote_forward_join_and_delete_at_heading_start_keep_structure_and_exact_history() {
    for (raw, display, at, expected, shown) in [
        ("> __a__\n>\n> __b__", "a\n\nb", 1, "> __ab__", "ab"),
        ("###### ab", "ab", 0, "###### b", "b"),
        ("> ab", "ab", 0, "> b", "b"),
    ] {
        let mut s = EditorSession::open(raw);
        let mut v = ReferenceView::new(display);
        v.apply(
            s.paragraph_key(
                s.revision(),
                range(at, at),
                ParagraphKey::Delete,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
        );
        assert_eq!(s.source_text(), expected, "{raw:?}");
        assert_eq!(v.text, shown);
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
    }
}
