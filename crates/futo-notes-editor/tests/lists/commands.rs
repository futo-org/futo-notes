use super::*;

#[test]
fn checkbox_intent_toggles_only_its_task_without_moving_the_active_selection() {
    let raw = "+ [X] 🦊done\r\n\r\n1) keep";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new("🦊done\r\n\r\nkeep");
    s.select(s.revision(), range(14, 14)).unwrap();
    let command: BlockCommand = serde_json::from_str("\"ToggleTask\"").unwrap();
    assert!(matches!(
        s.block_command(s.revision(), range(0, 0), command, &mut |_| Err(
            "append".into()
        )),
        Err(EditorError::Persistence(_))
    ));
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.selection(), range(14, 14));
    let mut accepted = 0;
    view.apply(
        s.block_command(s.revision(), range(0, 0), command, &mut |_| {
            accepted += 1;
            Ok(())
        })
        .unwrap()
        .unwrap(),
    );
    assert_eq!(accepted, 1);
    assert_eq!(s.source_text(), "+ [ ] 🦊done\r\n\r\n1) keep");
    assert_eq!(view.text, "🦊done\r\n\r\nkeep");
    assert_eq!(s.selection(), range(14, 14));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.selection(), range(14, 14));
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "+ [ ] 🦊done\r\n\r\n1) keep");
    assert!(s
        .block_command(s.revision(), range(14, 14), command, &mut |_| panic!(
            "non-task accepted"
        ))
        .unwrap()
        .is_none());
}

#[test]
fn bullet_command_formats_only_touched_lines_and_splits_inline_runs_at_item_boundaries() {
    let raw = "before\r\n__alpha\r\nbeta__\r\n\r\n+ neighbor  ";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new("before\r\nalpha\r\nbeta\r\n\r\nneighbor  ");
    let selected = range(8, 19);
    s.select(s.revision(), selected).unwrap();
    let command: BlockCommand = serde_json::from_str("\"BulletList\"").unwrap();
    let mut accepted = 0;
    view.apply(
        s.block_command(s.revision(), selected, command, &mut |_| {
            accepted += 1;
            Ok(())
        })
        .unwrap()
        .unwrap(),
    );
    assert_eq!(accepted, 1);
    assert_eq!(
        s.source_text(),
        "before\r\n- __alpha__\r\n- __beta__\r\n\r\n+ neighbor  "
    );
    assert_eq!(view.text, "before\r\nalpha\r\nbeta\r\n\r\nneighbor  ");
    assert_eq!(s.selection(), selected);
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.selection(), selected);
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(
        s.source_text(),
        "before\r\n- __alpha__\r\n- __beta__\r\n\r\n+ neighbor  "
    );
}

#[test]
fn cross_kind_commands_convert_the_touched_list_and_preserve_other_lists() {
    for (raw, command, expected) in [
        ("5) a\n1) b\n\n+ keep", "BulletList", "- a\n- b\n\n+ keep"),
        ("* a\n* b\n\n+ keep", "OrderedList", "1. a\n2. b\n\n+ keep"),
        (
            "5) [X] a\n1) b\n\n+ keep",
            "TaskList",
            "- [x] a\n- [ ] b\n\n+ keep",
        ),
    ] {
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new("a\nb\n\nkeep");
        s.select(s.revision(), range(2, 2)).unwrap();
        let command: BlockCommand = serde_json::from_value(serde_json::json!(command)).unwrap();
        view.apply(
            s.block_command(s.revision(), range(2, 2), command, &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(s.source_text(), expected, "{raw:?}");
        assert_eq!(view.text, "a\nb\n\nkeep");
        assert_eq!(s.selection(), range(2, 2));
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
    }
}

#[test]
fn repeating_a_list_command_lifts_only_selected_items_and_keeps_other_item_markers() {
    for (raw, command, at, expected, shown, caret) in [
        (
            "* a\n* b\n\n+ keep",
            "BulletList",
            0,
            "a\n* b\n\n+ keep",
            "a\nb\n\nkeep",
            0,
        ),
        (
            "* a\n* b\n* c\n\n+ keep",
            "BulletList",
            2,
            "* a\n\nb\n* c\n\n+ keep",
            "a\n\nb\nc\n\nkeep",
            3,
        ),
        (
            "5) a\n9) b\n\n+ keep",
            "OrderedList",
            0,
            "a\n\n9) b\n\n+ keep",
            "a\n\nb\n\nkeep",
            0,
        ),
        ("- [x] a\n- [ ] b", "TaskList", 0, "a\n- [ ] b", "a\nb", 0),
    ] {
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(&s.display_text());
        s.select(s.revision(), range(at, at)).unwrap();
        let command: BlockCommand = serde_json::from_value(serde_json::json!(command)).unwrap();
        view.apply(
            s.block_command(s.revision(), range(at, at), command, &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(s.source_text(), expected, "{raw:?}");
        assert_eq!(view.text, shown);
        assert_eq!(s.selection(), range(caret, caret));
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), range(at, at));
    }
}

#[test]
fn list_commands_and_later_line_shortcuts_keep_plain_neighbors_outside_the_new_list() {
    for (raw, at, command, expected, shown, caret) in [
        (
            "before\nword\nafter",
            7,
            Some(BlockCommand::BulletList),
            "before\n- word\n\nafter",
            "before\nword\n\nafter",
            7,
        ),
        (
            "before\n*body\nafter",
            8,
            None,
            "before\n- body\n\nafter",
            "before\nbody\n\nafter",
            7,
        ),
        (
            "before\n12.body\nafter",
            10,
            None,
            "before\n\n12. body\n\nafter",
            "before\n\nbody\n\nafter",
            8,
        ),
    ] {
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(&s.display_text());
        s.select(s.revision(), range(at, at)).unwrap();
        view.apply(if let Some(command) = command {
            s.block_command(s.revision(), range(at, at), command, &mut |_| Ok(()))
                .unwrap()
                .unwrap()
        } else {
            s.replace(s.revision(), range(at, at), " ", &mut |_| Ok(()))
                .unwrap()
        });
        assert_eq!(s.source_text(), expected, "{raw:?}");
        assert_eq!(view.text, shown);
        assert_eq!(s.selection(), range(caret, caret));
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), range(at, at));
    }
}

#[test]
fn text_and_list_commands_keep_item_continuations_and_literal_body_text() {
    for (raw, command, at, expected, shown) in [
        (
            "* a\n* b\n\n+ keep",
            BlockCommand::Heading(0),
            0,
            "a\n* b\n\n+ keep",
            "a\nb\n\nkeep",
        ),
        (
            "* first\n  second\n* third",
            BlockCommand::BulletList,
            8,
            "first\nsecond\n* third",
            "first\nsecond\nthird",
        ),
        ("  foo", BlockCommand::BulletList, 0, "- &#32; foo", "  foo"),
        (
            "[x] foo",
            BlockCommand::BulletList,
            0,
            "- \\[x] foo",
            "[x] foo",
        ),
        (
            "before\n2) text",
            BlockCommand::BulletList,
            7,
            "before\n- 2\\) text",
            "before\n2) text",
        ),
    ] {
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(&s.display_text());
        s.select(s.revision(), range(at, at)).unwrap();
        view.apply(
            s.block_command(s.revision(), range(at, at), command, &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(s.source_text(), expected, "{raw:?}");
        assert_eq!(view.text, shown);
        assert_eq!(s.selection(), range(at, at));
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
    }
}

#[test]
fn list_commands_retire_heading_syntax_while_preserving_inline_body_and_neighbors() {
    let (raw, shown) = ("## __a__ ##\r\n\r\n+ keep", "a\r\n\r\nkeep");
    {
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(shown);
        view.apply(
            s.block_command(
                s.revision(),
                range(0, 0),
                BlockCommand::TaskList,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
        );
        assert_eq!(s.source_text(), "- [ ] __a__\r\n\r\n+ keep");
        assert_eq!(view.text, shown);
        assert_eq!(EditorSession::open(&s.source_text()).display_text(), shown);
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), "- [ ] __a__\r\n\r\n+ keep");
    }
}

#[test]
fn list_commands_refuse_setext_headings_unchanged() {
    let raw = "__a__\r\n===\r\n\r\n+ keep";
    let mut s = EditorSession::open(raw);
    assert!(matches!(
        s.block_command(
            s.revision(),
            range(0, 0),
            BlockCommand::TaskList,
            &mut |_| panic!("accepted")
        ),
        Err(EditorError::UnrepresentableFormat)
    ));
    assert_eq!(s.source_text(), raw);
}

#[test]
fn a_list_command_on_a_blank_line_starts_an_empty_item() {
    // (source, caret, command, expected source)
    let cases = [
        ("", 0, BlockCommand::BulletList, "- "),
        ("", 0, BlockCommand::OrderedList, "1. "),
        ("", 0, BlockCommand::TaskList, "- [ ] "),
        ("a\n\n", 3, BlockCommand::BulletList, "a\n\n- "),
        // An empty item cannot interrupt a paragraph (it would make it a
        // setext heading), so a blank line separates them.
        ("a\n", 2, BlockCommand::BulletList, "a\n\n- "),
    ];
    for (raw, at, command, expected) in cases {
        let mut s = EditorSession::open(raw);
        let change = s
            .block_command(s.revision(), range(at, at), command, &mut |_| Ok(()))
            .unwrap();
        assert!(change.is_some(), "{command:?} on {raw:?} changed nothing");
        assert_eq!(s.source_text(), expected, "{command:?} on {raw:?}");
        s.undo(s.revision(), &mut |_| Ok(())).unwrap();
        assert_eq!(s.source_text(), raw, "undo of {command:?} on {raw:?}");
    }
}

#[test]
fn enter_at_a_lists_end_describes_the_new_empty_item() {
    let mut s = EditorSession::open("- C\n- Y");
    let end = s.display_text().len();
    let change = s
        .paragraph_key(
            s.revision(),
            range(end, end),
            ParagraphKey::Enter,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap();
    assert_eq!(s.source_text(), "- C\n- Y\n- ");
    let at = s.display_text().len();
    // The view draws a bullet only for blocks the projection describes.
    for blocks in [
        change.projection.blocks,
        s.project(s.revision(), range(0, at)).unwrap().blocks,
    ] {
        assert!(
            blocks
                .iter()
                .any(|b| b.range == range(at, at) && b.list.is_some()),
            "empty last item missing from {blocks:?}"
        );
    }
}

#[test]
fn leaving_a_list_at_its_end_types_a_separate_paragraph() {
    let mut s = EditorSession::open("- C\n- Y\n- ");
    let end = s.display_text().len();
    s.paragraph_key(
        s.revision(),
        range(end, end),
        ParagraphKey::Enter,
        &mut |_| Ok(()),
    )
    .unwrap();
    assert_eq!(s.source_text(), "- C\n- Y\n\n");
    let at = s.selection();
    s.replace_action(s.revision(), at, "x", InputAction::Typing, &mut |_| Ok(()))
        .unwrap();
    assert_eq!(s.source_text(), "- C\n- Y\n\nx");
    let lines = s
        .project(s.revision(), range(0, s.display_text().len()))
        .unwrap()
        .blocks;
    assert!(
        lines.last().is_some_and(|b| b.list.is_none()),
        "x joined the list: {lines:?}"
    );
    s.undo(s.revision(), &mut |_| Ok(())).unwrap();
    s.undo(s.revision(), &mut |_| Ok(())).unwrap();
    assert_eq!(s.source_text(), "- C\n- Y\n- ");
}

#[test]
fn indenting_an_empty_item_under_its_siblings_text_is_refused() {
    // `  * item 2\n    * ` would read the empty item as text of item 2; only
    // a blank line (loosening the list) could write it.
    let source = "* item 1\n  * item 2\n  * ";
    let mut s = EditorSession::open(source);
    let end = s.display_text().len();
    s.select(s.revision(), range(end, end)).unwrap();
    let revision = s.revision();
    let result = s.block_command(revision, range(end, end), BlockCommand::Indent, &mut |_| {
        panic!("a refused indent accepts nothing")
    });
    assert!(
        matches!(result, Err(EditorError::UnrepresentableFormat)),
        "{result:?}"
    );
    assert_eq!(s.source_text(), source);
    assert_eq!(s.revision(), revision);
    assert_eq!(s.selection(), range(end, end));
    // Once it has text, the same item indents.
    s.replace_action(
        s.revision(),
        range(end, end),
        "x",
        InputAction::Typing,
        &mut |_| Ok(()),
    )
    .unwrap();
    let end = s.display_text().len();
    s.block_command(
        s.revision(),
        range(end, end),
        BlockCommand::Indent,
        &mut |_| Ok(()),
    )
    .unwrap();
    assert_eq!(s.source_text(), "* item 1\n  * item 2\n    * x");
}

const REFUSED_INDENT: &str = "* item 1\n  * item 2\n  * ";

/// An empty item whose Indent was refused, caret at its end.
fn after_refused_indent() -> EditorSession {
    let mut s = EditorSession::open(REFUSED_INDENT);
    let end = s.display_text().len();
    s.select(s.revision(), range(end, end)).unwrap();
    let revision = s.revision();
    let refused = s.block_command(revision, range(end, end), BlockCommand::Indent, &mut |_| {
        panic!("a refused indent accepts nothing")
    });
    assert!(matches!(refused, Err(EditorError::UnrepresentableFormat)));
    assert_eq!(s.source_text(), REFUSED_INDENT);
    s
}

#[test]
fn composition_after_a_refused_indent_writes_the_text_once_at_the_written_depth() {
    let mut s = after_refused_indent();
    let end = s.display_text().len();
    let revision = s.revision();
    s.compose(revision, range(end, end), "にほん").unwrap();
    s.compose(revision, range(end, end), "日本").unwrap();
    assert_eq!(
        s.source_text(),
        REFUSED_INDENT,
        "marked text is provisional"
    );
    let change = s
        .commit_composition(revision, Some("日本語"), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(change.inserted, "日本語");
    assert_eq!(s.source_text(), "* item 1\n  * item 2\n  * 日本語");
    let end = s.display_text().len();
    assert_eq!(s.selection(), range(end, end));
    s.undo(s.revision(), &mut |_| Ok(())).unwrap();
    assert_eq!(s.source_text(), REFUSED_INDENT);
}

#[test]
fn os_replacement_after_a_refused_indent_writes_the_text_once_and_undoes_cleanly() {
    let mut s = after_refused_indent();
    let end = s.display_text().len();
    s.replace_os(s.revision(), range(end, end), "teh", &[], &mut |_| Ok(()))
        .unwrap();
    assert_eq!(s.source_text(), "* item 1\n  * item 2\n  * teh");
    let (start, end) = (end, s.display_text().len());
    s.replace_os(s.revision(), range(start, end), "the", &[], &mut |_| Ok(()))
        .unwrap();
    assert_eq!(s.source_text(), "* item 1\n  * item 2\n  * the");
    let end = s.display_text().len();
    assert_eq!(s.selection(), range(end, end));
    s.undo(s.revision(), &mut |_| Ok(())).unwrap();
    s.undo(s.revision(), &mut |_| Ok(())).unwrap();
    assert_eq!(s.source_text(), REFUSED_INDENT);
}
