use super::*;

#[test]
fn list_commands_keep_the_enclosing_quote() {
    for (command, marker) in [
        (BlockCommand::BulletList, "- "),
        (BlockCommand::OrderedList, "1. "),
        (BlockCommand::TaskList, "- [ ] "),
    ] {
        for (raw, shown, at, expected) in [
            ("> quoted", "quoted", 0, format!("> {marker}quoted")),
            (
                "> quoted\n> ",
                "quoted\n",
                7,
                if command == BlockCommand::TaskList {
                    format!("> quoted\n> {marker}")
                } else {
                    format!("> quoted\n>\n> {marker}")
                },
            ),
        ] {
            let mut s = EditorSession::open(raw);
            assert_eq!(s.display_text(), shown);
            s.select(s.revision(), range(at, at)).unwrap();
            s.block_command(s.revision(), range(at, at), command, &mut |_| Ok(()))
                .unwrap()
                .unwrap();
            assert_eq!(s.source_text(), expected);
            s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
            assert_eq!(s.source_text(), raw);
        }
    }
}

#[test]
fn indent_nests_only_the_selected_item_and_preserves_exact_foreign_spelling() {
    let raw = "* parent\r\n* __child__\r\n* neighbor  ";
    let expected = "* parent\r\n\t* __child__\r\n* neighbor  ";
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
fn indent_and_outdent_nest_a_quoted_list_item_inside_its_quote() {
    for (raw, expected) in [("> - a\n> - b", "> - a\n> \t- b")] {
        let selected = range(2, 3);
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new("a\nb");
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
        assert_eq!(view.text, "a\nb");
        assert_eq!(s.selection(), selected);
        view.apply(
            s.block_command(s.revision(), selected, BlockCommand::Outdent, &mut |_| {
                Ok(())
            })
            .unwrap()
            .unwrap(),
        );
        assert_eq!(s.source_text(), raw);
        assert_eq!(view.text, "a\nb");
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
    }
}

#[test]
fn a_first_list_sibling_inside_a_quote_cannot_indent_its_outer_quote() {
    let mut s = EditorSession::open("> - a\n> - b");
    let initial = s.source_text();
    assert!(s
        .block_command(
            s.revision(),
            range(0, 0),
            BlockCommand::Indent,
            &mut |_| panic!("no sink target")
        )
        .unwrap()
        .is_none());
    assert_eq!(s.source_text(), initial);
    assert_eq!(s.revision(), Revision(0));
}

#[test]
fn outdent_does_nothing_to_a_top_level_item_and_leaves_no_undo_step() {
    let mut s = EditorSession::open("* a\n* b");
    assert!(!s.toolbar_state().can_outdent);
    assert!(s
        .block_command(
            s.revision(),
            range(0, 1),
            BlockCommand::Outdent,
            &mut |_| panic!("accepted")
        )
        .unwrap()
        .is_none());
    assert_eq!(s.source_text(), "* a\n* b");
    assert!(!s.toolbar_state().can_undo);
}

#[test]
fn outdent_retargets_the_lifted_item_to_its_parent_list_kind_and_content_width() {
    for (source, expected) in [
        ("- a\n  1) b", "- a\n- b"),
        ("9) a\n   - b\n     - c", "9) a\n10) b\n    - c"),
    ] {
        let mut s = EditorSession::open(source);
        let mut view = ReferenceView::new(if source.ends_with('c') {
            "a\nb\nc"
        } else {
            "a\nb"
        });
        s.select(s.revision(), range(2, 3)).unwrap();
        view.apply(
            s.block_command(
                s.revision(),
                range(2, 3),
                BlockCommand::Outdent,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
        );
        assert_eq!(s.source_text(), expected);
        assert_eq!(s.display_text(), view.text);
        let p = s.project(s.revision(), range(2, 3)).unwrap();
        assert_eq!(
            p.blocks
                .iter()
                .find_map(|block| block.list.as_ref())
                .unwrap()
                .depth,
            1
        );
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), source);
    }
}
#[test]
fn same_line_nested_list_parents_are_refused_unchanged() {
    // Two items opening on one physical line have no canonical respelling
    // that keeps the empty parent (DECISIONS #20): refused before acceptance.
    for (raw, selected, command) in [(
        "- - child\n  - sibling\n- following",
        range(0, 5),
        BlockCommand::Heading(0),
    )] {
        let mut s = EditorSession::open(raw);
        s.select(s.revision(), selected).unwrap();
        assert!(matches!(
            s.block_command(s.revision(), selected, command, &mut |_| panic!("accepted")),
            Err(EditorError::UnrepresentableFormat)
        ));
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), selected);
    }
}

#[test]
fn indent_joins_the_preceding_items_existing_compatible_child_list() {
    for (source, shown, selected, expected) in [
        (
            "- parent\n  + existing\n- child",
            "parent\nexisting\nchild",
            range(16, 21),
            "- parent\n  + existing\n  + child",
        ),
        (
            "1) parent\n\n   4) existing\n2) child",
            "parent\n\nexisting\nchild",
            range(17, 22),
            "1) parent\n\n   4) existing\n   5) child",
        ),
    ] {
        let mut s = EditorSession::open(source);
        let mut view = ReferenceView::new(shown);
        assert_eq!(s.display_text(), shown, "{source:?}");
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
        assert_eq!(s.source_text(), source);
    }
}

#[test]
fn non_one_ordered_text_without_a_separator_remains_a_parent_paragraph() {
    let source = "1) parent\n   4) existing\n2) child";
    let shown = "parent\n4) existing\nchild";
    let mut s = EditorSession::open(source);
    let mut view = ReferenceView::new(shown);
    assert_eq!(s.display_text(), shown);
    s.select(s.revision(), range(19, 24)).unwrap();
    view.apply(
        s.block_command(
            s.revision(),
            range(19, 24),
            BlockCommand::Indent,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "1) parent\n   4) existing\n\t1) child");
    assert_eq!(view.text, shown);
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), source);
}

#[test]
fn retargeting_an_outer_list_preserves_the_owned_nested_list_depth() {
    let source = "- a\n  - b";
    let mut s = EditorSession::open(source);
    let mut view = ReferenceView::new("a\nb");
    s.select(s.revision(), range(0, 1)).unwrap();
    view.apply(
        s.block_command(
            s.revision(),
            range(0, 1),
            BlockCommand::OrderedList,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "1. a\n   - b");
    assert_eq!(view.text, "a\nb");
    assert_eq!(s.selection(), range(0, 1));
    let child = s.project(s.revision(), range(2, 3)).unwrap();
    assert_eq!(
        child
            .blocks
            .iter()
            .find_map(|block| block.list.as_ref())
            .unwrap()
            .depth,
        2
    );
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), source);
}
