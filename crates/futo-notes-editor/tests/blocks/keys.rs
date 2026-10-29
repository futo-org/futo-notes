use super::*;

#[test]
fn enter_at_a_supplied_heading_start_returns_its_own_affinity_and_history() {
    let mut s = EditorSession::open("# __ab__\nplain");
    let mut v = ReferenceView::new("ab\nplain");
    s.select(s.revision(), range(8, 8)).unwrap();
    let change = s
        .paragraph_key(s.revision(), range(0, 0), ParagraphKey::Enter, &mut |_| {
            Ok(())
        })
        .unwrap()
        .unwrap();
    assert_eq!(change.affinity, Affinity::Forward);
    v.apply(change);
    assert_eq!(s.source_text(), "\n# __ab__\nplain");
    assert_eq!(s.active_formats(), vec![InlineFormat::Bold]);
    v.apply(
        s.replace(s.revision(), s.selection(), "c", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(s.source_text(), "\n# __cab__\nplain");
    assert_eq!(v.text, "\ncab\nplain");
    v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    let undo = s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(undo.affinity, Affinity::Backward);
    v.apply(undo);
    assert_eq!(s.selection(), range(8, 8));
    assert_eq!(s.source_text(), "# __ab__\nplain");
}

#[test]
fn enter_carries_inline_formats_from_the_supplied_range_without_a_selection_echo() {
    for raw in ["# __ab__", "> __ab__"] {
        let mut s = EditorSession::open(raw);
        s.paragraph_key(s.revision(), range(2, 2), ParagraphKey::Enter, &mut |_| {
            Ok(())
        })
        .unwrap()
        .unwrap();
        assert_eq!(s.active_formats(), vec![InlineFormat::Bold]);
        s.replace(s.revision(), s.selection(), "c", &mut |_| Ok(()))
            .unwrap();
        assert_eq!(
            s.source_text(),
            if raw.starts_with('#') {
                "# __ab__\n__c__"
            } else {
                "> __ab__\n>\n> __c__"
            }
        );
    }
}

#[test]
fn enter_at_a_supplied_heading_range_does_not_carry_formats_from_another_caret() {
    let mut s = EditorSession::open("# ab\nplain");
    let mut v = ReferenceView::new("ab\nplain");
    s.select(s.revision(), range(8, 8)).unwrap();
    s.toggle_format(s.revision(), InlineFormat::Bold, &mut |_| Ok(()))
        .unwrap();
    v.apply(
        s.paragraph_key(s.revision(), range(0, 0), ParagraphKey::Enter, &mut |_| {
            Ok(())
        })
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "\n# ab\nplain");
    assert_eq!(v.text, "\nab\nplain");
    assert_eq!(s.selection(), range(1, 1));
    assert!(s.active_formats().is_empty());
    v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.selection(), range(8, 8));
    assert_eq!(s.active_formats(), vec![InlineFormat::Bold]);
}

#[test]
fn enter_before_heading_text_preserves_an_explicit_inline_format_toggle() {
    let mut s = EditorSession::open("# __ab__");
    let mut v = ReferenceView::new("ab");
    s.toggle_format(s.revision(), InlineFormat::Bold, &mut |_| Ok(()))
        .unwrap();
    assert!(s.active_formats().is_empty());
    v.apply(
        s.paragraph_key(s.revision(), range(0, 0), ParagraphKey::Enter, &mut |_| {
            Ok(())
        })
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "\n# __ab__");
    assert_eq!(v.text, "\nab");
    assert!(s.active_formats().is_empty());
    v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "# __ab__");
    assert!(s.active_formats().is_empty());
    v.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "\n# __ab__");
    assert!(s.active_formats().is_empty());
}

#[test]
fn enter_at_a_later_physical_quote_line_adds_only_the_paragraph_separator() {
    let mut s = EditorSession::open("> a\r\n> __日__\r\n\r\nneighbor");
    let mut v = ReferenceView::new("a\r\n日\r\n\r\nneighbor");
    s.select(s.revision(), range(3, 3)).unwrap();
    v.apply(
        s.paragraph_key(
            s.revision(),
            s.selection(),
            ParagraphKey::Enter,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "> a\r\n>\n> __日__\r\n\r\nneighbor");
    assert_eq!(v.text, "a\r\n\n日\r\n\r\nneighbor");
    assert_eq!(s.selection(), range(4, 4));
    v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "> a\r\n> __日__\r\n\r\nneighbor");
    assert_eq!(v.text, "a\r\n日\r\n\r\nneighbor");
    assert_eq!(s.selection(), range(3, 3));
}

#[test]
fn heading_and_quote_enter_carry_bold_into_an_empty_continuation() {
    for (raw, expected, shown, entered) in [
        ("# __ab__", "# __ab__\n__c__", "ab\nc", "# __ab__\n"),
        (
            "> __ab__",
            "> __ab__\n>\n> __c__",
            "ab\n\nc",
            "> __ab__\n>\n> ",
        ),
    ] {
        let mut s = EditorSession::open(raw);
        let mut v = ReferenceView::new("ab");
        s.select(s.revision(), range(2, 2)).unwrap();
        v.apply(
            s.paragraph_key(
                s.revision(),
                s.selection(),
                ParagraphKey::Enter,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
        );
        assert_eq!(s.source_text(), entered);
        assert_eq!(s.active_formats(), vec![InlineFormat::Bold]);
        v.apply(
            s.replace(s.revision(), s.selection(), "c", &mut |_| Ok(()))
                .unwrap(),
        );
        assert_eq!(s.source_text(), expected);
        assert_eq!(v.text, shown);
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), entered);
        assert_eq!(s.active_formats(), vec![InlineFormat::Bold]);
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(v.text, "ab");
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

#[test]
fn structural_splitting_treats_heading_body_as_inline_content() {
    let mut s = EditorSession::open("# # ab\r\nend");
    let mut v = ReferenceView::new("# ab\r\nend");
    v.apply(
        s.paragraph_key(s.revision(), range(2, 2), ParagraphKey::Enter, &mut |_| {
            Ok(())
        })
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "# \\# \nab\r\nend");
    assert_eq!(v.text, "# \nab\r\nend");
    v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "# # ab\r\nend");
}

#[test]
fn structural_split_keeps_fence_like_inline_text_visible() {
    let mut s = EditorSession::open("# a ``` b\r\nneighbor");
    let mut v = ReferenceView::new("a ``` b\r\nneighbor");
    v.apply(
        s.paragraph_key(s.revision(), range(2, 2), ParagraphKey::Enter, &mut |_| {
            Ok(())
        })
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "# a \n\\``` b\r\nneighbor");
    assert_eq!(v.text, "a \n``` b\r\nneighbor");
    v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "# a ``` b\r\nneighbor");
}
