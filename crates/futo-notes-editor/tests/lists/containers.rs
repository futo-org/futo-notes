use super::*;

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

#[test]
fn indent_and_outdent_choose_the_nearest_list_or_quote_container() {
    for (raw, expected) in [
        ("> - a\n> - b", "> - a\n>   - b"),
        ("- a\n  > b", "- a\n  > > b"),
    ] {
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
fn outdent_lifts_a_top_level_item_to_paragraph_text() {
    let mut s = EditorSession::open("* a\n* b");
    let mut view = ReferenceView::new("a\nb");
    view.apply(
        s.block_command(
            s.revision(),
            range(0, 1),
            BlockCommand::Outdent,
            &mut |_| Ok(()),
        )
        .unwrap()
        .expect("the outer list item lifts into a paragraph"),
    );
    assert_eq!(s.source_text(), "a\n* b");
    assert_eq!(view.text, "a\nb");
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "* a\n* b");
}

#[test]
fn quoted_tab_outdent_uses_physical_tab_stops_after_the_quote_prefix() {
    let source = "> - a\n> \t- b";
    let mut s = EditorSession::open(source);
    let mut view = ReferenceView::new("a\nb");
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
    assert_eq!(s.source_text(), "> - a\n> - b");
    assert_eq!(view.text, "a\nb");
    assert_eq!(s.selection(), range(2, 3));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), source);
}

#[test]
fn outdent_does_not_cross_a_quote_between_two_list_containers() {
    let source = "- a\n  > - b";
    let mut s = EditorSession::open(source);
    let mut view = ReferenceView::new("a\nb");
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
    assert_eq!(s.source_text(), "- a\n  > b");
    assert_eq!(view.text, "a\nb");
    assert_eq!(s.selection(), range(2, 3));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), source);
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
fn outdent_same_line_nested_syntax_preserves_the_empty_parent_item() {
    let source = "* 0. text";
    let mut s = EditorSession::open(source);
    let mut view = ReferenceView::new("text");
    assert_eq!(s.display_text(), "text");
    let selected = range(0, 4);
    s.select(s.revision(), selected).unwrap();
    view.apply(
        s.block_command(s.revision(), selected, BlockCommand::Outdent, &mut |_| {
            Ok(())
        })
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "* \n* text");
    assert_eq!(view.text, "\ntext");
    assert_eq!(s.selection(), range(1, 5));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), source);
    assert_eq!(s.selection(), selected);
}

#[test]
fn outdent_retargets_each_selected_sibling_and_maps_its_own_descendants() {
    let raw = "9) a\n   - b\n     - child\n   - c";
    let expected = "9) a\n10) b\n    - child\n11) c";
    let shown = "a\nb\nchild\nc";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new(shown);
    s.select(s.revision(), range(2, 11)).unwrap();
    view.apply(
        s.block_command(
            s.revision(),
            range(2, 11),
            BlockCommand::Outdent,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), expected);
    assert_eq!(view.text, shown);
    assert_eq!(s.selection(), range(2, 11));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
}

#[test]
fn indent_starts_a_new_ordered_child_list_at_one() {
    let raw = "9) parent\n10) child";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new("parent\nchild");
    s.select(s.revision(), range(7, 12)).unwrap();
    view.apply(
        s.block_command(
            s.revision(),
            range(7, 12),
            BlockCommand::Indent,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "9) parent\n   1) child");
    assert_eq!(view.text, "parent\nchild");
    let p = s.project(s.revision(), range(7, 12)).unwrap();
    let list = p
        .blocks
        .iter()
        .find_map(|block| block.list.as_ref())
        .unwrap();
    assert_eq!(list.depth, 2);
    assert_eq!(list.number, Some(1));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
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
    assert_eq!(s.source_text(), "1) parent\n   4) existing\n   1) child");
    assert_eq!(view.text, shown);
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), source);
}

#[test]
fn list_indent_moves_owned_code_prefixes_without_changing_authored_blank_body_spaces() {
    let source = "- before\n- parent\n  ```\n    \n  ```";
    let expected = "- before\n  - parent\n    ```\n      \n    ```";
    let shown = "before\nparent\n  ";
    let mut s = EditorSession::open(source);
    let mut view = ReferenceView::new(shown);
    assert_eq!(s.display_text(), shown);
    s.select(s.revision(), range(7, 13)).unwrap();
    view.apply(
        s.block_command(
            s.revision(),
            range(7, 13),
            BlockCommand::Indent,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), expected);
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

#[test]
fn nested_bullet_toggle_lifts_text_descendants_and_following_nested_siblings() {
    // Actual shipping toolbar/preset oracle, retaining the foreign outer marker.
    let raw = "- parent\n  - child😀\n    - grandchild\n  - sibling\n- following";
    let expected = "- parent\n\nchild😀\n+ grandchild\n+ sibling\n- following";
    let shown = "parent\nchild😀\ngrandchild\nsibling\nfollowing";
    let after = "parent\n\nchild😀\ngrandchild\nsibling\nfollowing";
    let selected = range(7, 16);
    let final_selected = range(8, 17);
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new(shown);
    assert_eq!(s.display_text(), shown);
    s.select_with_affinity(s.revision(), selected, Affinity::Backward)
        .unwrap();
    let mut accepted = 0;
    view.apply(
        s.block_command(
            s.revision(),
            selected,
            BlockCommand::BulletList,
            &mut |_| {
                accepted += 1;
                Ok(())
            },
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(accepted, 1);
    assert_eq!(s.source_text(), expected);
    assert_eq!(view.text, after);
    assert_eq!(s.selection(), final_selected);
    assert_eq!(s.affinity(), Affinity::Backward);
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(view.text, shown);
    assert_eq!(s.selection(), selected);
    assert_eq!(s.affinity(), Affinity::Backward);
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), expected);
    assert_eq!(view.text, after);
    assert_eq!(s.selection(), final_selected);
}

#[test]
fn explicit_text_preserves_a_same_line_empty_parent_when_lifting_all_lists() {
    let raw = "- - child\n  - sibling\n- following";
    let expected = "- \n\nchild\n+ sibling\n- following";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new("child\nsibling\nfollowing");
    s.select(s.revision(), range(0, 5)).unwrap();
    view.apply(
        s.block_command(
            s.revision(),
            range(0, 5),
            BlockCommand::Heading(0),
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), expected);
    assert_eq!(view.text, "\n\nchild\nsibling\nfollowing");
    assert_eq!(s.selection(), range(2, 7));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(view.text, "child\nsibling\nfollowing");
    assert_eq!(s.selection(), range(0, 5));
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), expected);
}
