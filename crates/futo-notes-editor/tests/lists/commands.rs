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
            "- [X] a\n- [ ] b\n\n+ keep",
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
fn list_retarget_does_not_renumber_either_neighbor_when_ordered_delimiters_conflict() {
    let raw = "9. before\n\n* a\n* b\n\n7) after";
    let shown = "before\n\na\nb\n\nafter";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new(shown);
    let numbers = |s: &EditorSession| {
        s.project(s.revision(), range(0, s.display_text().len()))
            .unwrap()
            .blocks
            .into_iter()
            .filter_map(|block| block.list.filter(|list| list.first).map(|list| list.number))
            .collect::<Vec<_>>()
    };
    assert_eq!(numbers(&s), vec![Some(9), None, None, Some(7)]);
    s.select(s.revision(), range(8, 8)).unwrap();
    let mut accepted = 0;
    view.apply(
        s.block_command(
            s.revision(),
            range(8, 8),
            BlockCommand::OrderedList,
            &mut |_| {
                accepted += 1;
                Ok(())
            },
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(accepted, 1);
    assert_eq!(numbers(&s), vec![Some(9), Some(1), Some(2), Some(7)]);
    assert_eq!(
        s.source_text(),
        "9. before\n\n<!-- -->\n1. a\n2. b\n\n7) after"
    );
    assert_eq!(view.text, shown);
    assert_eq!(s.selection(), range(8, 8));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
}

#[test]
fn list_commands_retire_heading_syntax_while_preserving_inline_body_and_neighbors() {
    for (raw, shown) in [
        ("## __a__ ##\r\n\r\n+ keep", "a\r\n\r\nkeep"),
        ("__a__\r\n===\r\n\r\n+ keep", "a\r\n\r\nkeep"),
    ] {
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
fn indent_nests_only_the_selected_item_and_preserves_exact_foreign_spelling() {
    let raw = "* parent\r\n* __child__\r\n* neighbor  ";
    let expected = "* parent\r\n  * __child__\r\n* neighbor  ";
    let shown = "parent\r\nchild\r\nneighbor  ";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new(shown);
    let selected = range(8, 13);
    s.select_with_affinity(s.revision(), selected, Affinity::Backward)
        .unwrap();
    let mut accepted = 0;
    let change = s
        .block_command(s.revision(), selected, BlockCommand::Indent, &mut |_| {
            accepted += 1;
            Ok(())
        })
        .unwrap()
        .expect("the second list item can nest under its preceding sibling");
    view.apply(change);
    assert_eq!(accepted, 1);
    assert_eq!(s.source_text(), expected);
    assert_eq!(view.text, shown);
    assert_eq!(s.selection(), selected);
    assert_eq!(s.affinity(), Affinity::Backward);
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(view.text, shown);
    assert_eq!(s.selection(), selected);
    assert_eq!(s.affinity(), Affinity::Backward);
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), expected);
    assert_eq!(view.text, shown);
    assert_eq!(s.selection(), selected);
}

#[test]
fn outdent_lifts_one_container_level_and_preserves_descendants() {
    let raw = "- parent\n  - __child__\n    - grandchild";
    let expected = "- parent\n- __child__\n  - grandchild";
    let shown = "parent\nchild\ngrandchild";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new(shown);
    let selected = range(7, 12);
    s.select(s.revision(), selected).unwrap();
    view.apply(
        s.block_command(s.revision(), selected, BlockCommand::Outdent, &mut |_| {
            Ok(())
        })
        .unwrap()
        .expect("a nested list item can lift one level"),
    );
    assert_eq!(s.source_text(), expected);
    assert_eq!(view.text, shown);
    assert_eq!(s.selection(), selected);
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.selection(), selected);
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), expected);
}

#[test]
fn indent_moves_all_selected_siblings_as_one_exact_action() {
    let raw = "* parent\n* one\n* two\n* keep";
    let expected = "* parent\n  * one\n  * two\n* keep";
    let shown = "parent\none\ntwo\nkeep";
    let selected = range(7, 14);
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new(shown);
    s.select(s.revision(), selected).unwrap();
    view.apply(
        s.block_command(
            s.revision(),
            selected,
            BlockCommand::Indent,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), expected);
    assert_eq!(view.text, shown);
    assert_eq!(s.selection(), selected);
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.selection(), selected);
}
