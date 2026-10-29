use super::*;

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
