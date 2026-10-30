use super::*;

#[test]
fn enter_splits_a_bullet_item_with_exact_history_and_unrelated_neighbors() {
    let raw = "* __ab__\r\n\r\n+ neighbor  \r\n";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new("ab\r\n\r\nneighbor  \r\n");
    s.select(s.revision(), range(1, 1)).unwrap();
    let mut accepts = 0;
    view.apply(
        s.paragraph_key(s.revision(), range(1, 1), ParagraphKey::Enter, &mut |_| {
            accepts += 1;
            Ok(())
        })
        .unwrap()
        .unwrap(),
    );
    assert_eq!(accepts, 1);
    assert_eq!(s.source_text(), "* __a__\n* __b__\r\n\r\n+ neighbor  \r\n");
    assert_eq!(view.text, "a\nb\r\n\r\nneighbor  \r\n");
    assert_eq!(s.selection(), range(2, 2));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.selection(), range(1, 1));
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "* __a__\n* __b__\r\n\r\n+ neighbor  \r\n");
    assert_eq!(s.selection(), range(2, 2));
}

#[test]
fn task_enter_keeps_the_original_state_and_starts_an_unchecked_item() {
    for (selected, expected, shown, caret) in [
        (
            range(0, 0),
            "- [ ] \n- [X] done\r\n\r\n+ keep",
            "\ndone\r\n\r\nkeep",
            1,
        ),
        (
            range(2, 2),
            "- [X] do\n- [ ] ne\r\n\r\n+ keep",
            "do\nne\r\n\r\nkeep",
            3,
        ),
        (
            range(4, 4),
            "- [X] done\n- [ ] \r\n\r\n+ keep",
            "done\n\r\n\r\nkeep",
            5,
        ),
        (
            range(0, 4),
            "- [ ] \n- [X] \r\n\r\n+ keep",
            "\n\r\n\r\nkeep",
            1,
        ),
    ] {
        let raw = "- [X] done\r\n\r\n+ keep";
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new("done\r\n\r\nkeep");
        s.select(s.revision(), selected).unwrap();
        view.apply(
            s.paragraph_key(s.revision(), selected, ParagraphKey::Enter, &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(s.source_text(), expected, "{selected:?}");
        assert_eq!(view.text, shown);
        assert_eq!(s.selection(), range(caret, caret));
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), selected);
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
    }
}

#[test]
fn empty_item_enter_exits_without_changing_neighboring_items_or_endings() {
    for (raw, shown, selected, expected, display) in [
        ("* ", "", range(0, 0), "", ""),
        ("5) ", "", range(0, 0), "", ""),
        ("- [x] ", "", range(0, 0), "", ""),
        (
            "* a\r\n* \r\n* b",
            "a\r\n\r\nb",
            range(3, 3),
            "* a\r\n\r\n<!-- -->\n* b",
            "a\r\n\r\nb",
        ),
        ("> - [ ] ", "", range(0, 0), "> ", ""),
    ] {
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(shown);
        s.select(s.revision(), selected).unwrap();
        view.apply(
            s.paragraph_key(s.revision(), selected, ParagraphKey::Enter, &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(s.source_text(), expected, "{raw:?}");
        assert_eq!(view.text, display);
        assert_eq!(s.selection(), selected);
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
    }
}

#[test]
fn ordered_enter_renumbers_only_its_own_list_in_the_same_history_action() {
    for (raw, expected, shown) in [
        (
            "5) a\n1) b\n1) c\n\n9. untouched\n1. same",
            "5) a\n6) \n7) b\n8) c\n\n9. untouched\n1. same",
            "a\n\nb\nc\n\nuntouched\nsame",
        ),
        ("9. a\n1. b", "9. a\n10. \n11. b", "a\n\nb"),
    ] {
        let mut s = EditorSession::open(raw);
        let original = s.display_text();
        let mut view = ReferenceView::new(&original);
        s.select(s.revision(), range(1, 1)).unwrap();
        let mut accepted = 0;
        view.apply(
            s.paragraph_key(s.revision(), range(1, 1), ParagraphKey::Enter, &mut |_| {
                accepted += 1;
                Ok(())
            })
            .unwrap()
            .unwrap(),
        );
        assert_eq!(accepted, 1);
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, shown);
        assert_eq!(s.selection(), range(2, 2));
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), range(1, 1));
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
    }
}

#[test]
fn ordered_task_split_maps_later_item_digit_growth_and_supplied_caret() {
    let raw = "9) a\n1) [X] done\n1) tail\n\n+ keep";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new("a\ndone\ntail\n\nkeep");
    s.select(s.revision(), range(0, 0)).unwrap();
    view.apply(
        s.paragraph_key(s.revision(), range(4, 4), ParagraphKey::Enter, &mut |_| {
            Ok(())
        })
        .unwrap()
        .unwrap(),
    );
    assert_eq!(
        s.source_text(),
        "9) a\n10) [X] do\n11) [ ] ne\n12) tail\n\n+ keep"
    );
    assert_eq!(view.text, "a\ndo\nne\ntail\n\nkeep");
    assert_eq!(s.selection(), range(5, 5));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.selection(), range(0, 0));
}

#[test]
fn enter_at_a_list_start_leaves_a_line_above_and_continuation_enter_splits_the_item() {
    for (raw, selected, expected, shown, caret) in [
        ("* ab", range(0, 0), "\n* ab", "\nab", 1),
        (
            "5) ab\n1) keep",
            range(0, 0),
            "\n5) ab\n1) keep",
            "\nab\nkeep",
            1,
        ),
        (
            "- first\n  second",
            range(8, 8),
            "- first\n  se\n- cond",
            "first\nse\ncond",
            9,
        ),
        (
            "9) a\n1) [X] first\n   second",
            range(10, 10),
            "9) a\n10) [X] first\n   se\n11) [ ] cond",
            "a\nfirst\nse\ncond",
            11,
        ),
    ] {
        let mut s = EditorSession::open(raw);
        let opening = s.display_text();
        let mut view = ReferenceView::new(&opening);
        s.select(s.revision(), selected).unwrap();
        view.apply(
            s.paragraph_key(s.revision(), selected, ParagraphKey::Enter, &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(s.source_text(), expected, "{raw:?}");
        assert_eq!(view.text, shown);
        assert_eq!(s.selection(), range(caret, caret));
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), selected);
    }
}

#[test]
fn list_backspace_lifts_the_first_item_and_selected_enter_is_one_action() {
    for (raw, selected, key, expected, shown, caret) in [
        (
            "* ab\n* cd",
            range(0, 0),
            ParagraphKey::Backspace,
            "ab\n* cd",
            "ab\ncd",
            0,
        ),
        (
            "* ab\n* cd",
            range(1, 4),
            ParagraphKey::Enter,
            "* a\n* d",
            "a\nd",
            2,
        ),
        (
            "5) ab\n1) cd\n1) tail",
            range(1, 4),
            ParagraphKey::Enter,
            "5) a\n6) d\n7) tail",
            "a\nd\ntail",
            2,
        ),
        (
            "- [X] 🦊done",
            range(0, 0),
            ParagraphKey::Delete,
            "- [X] done",
            "done",
            0,
        ),
    ] {
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(&s.display_text());
        s.select(s.revision(), selected).unwrap();
        let mut accepted = 0;
        view.apply(
            s.paragraph_key(s.revision(), selected, key, &mut |_| {
                accepted += 1;
                Ok(())
            })
            .unwrap()
            .unwrap(),
        );
        assert_eq!(accepted, 1);
        assert_eq!(s.source_text(), expected, "{raw:?}");
        assert_eq!(view.text, shown);
        assert_eq!(s.selection(), range(caret, caret));
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), selected);
    }
}

#[test]
fn joining_ordered_items_renumbers_only_that_list_and_undoes_the_join_together() {
    for (at, key) in [(3, ParagraphKey::Backspace), (2, ParagraphKey::Delete)] {
        let raw = "5) ab\n1) cd\n1) tail\n\n9. keep\n1. exact";
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new("ab\ncd\ntail\n\nkeep\nexact");
        s.select(s.revision(), range(at, at)).unwrap();
        let mut accepted = 0;
        view.apply(
            s.paragraph_key(s.revision(), range(at, at), key, &mut |_| {
                accepted += 1;
                Ok(())
            })
            .unwrap()
            .unwrap(),
        );
        assert_eq!(accepted, 1);
        assert_eq!(s.source_text(), "5) abcd\n6) tail\n\n9. keep\n1. exact");
        assert_eq!(view.text, "abcd\ntail\n\nkeep\nexact");
        assert_eq!(s.selection(), range(2, 2));
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), range(at, at));
    }
}

#[test]
fn maximum_supported_ordered_markers_continue_with_valid_lazy_physical_numbers() {
    let raw = "999999999. a\n1. b";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new("a\nb");
    view.apply(
        s.replace(s.revision(), range(1, 1), "!", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(s.source_text(), "999999999. a!\n1. b");
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    view.apply(
        s.paragraph_key(s.revision(), range(1, 1), ParagraphKey::Enter, &mut |_| {
            Ok(())
        })
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "999999999. a\n1. \n1. b");
    assert_eq!(view.text, "a\n\nb");
    let numbers: Vec<_> = s
        .project(s.revision(), range(0, view.text.len()))
        .unwrap()
        .blocks
        .into_iter()
        .filter_map(|block| block.list.filter(|list| list.first).map(|list| list.number))
        .collect();
    assert_eq!(
        numbers,
        vec![Some(999999999), Some(1000000000), Some(1000000001)]
    );
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    let mut converted = EditorSession::open("999999999.body");
    converted
        .replace(converted.revision(), range(10, 10), " ", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(converted.source_text(), "999999999. body");
    assert_eq!(converted.display_text(), "body");
    converted
        .undo(converted.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(converted.source_text(), "999999999.body");
    let mut literal = EditorSession::open("1000000000.body");
    literal
        .replace(literal.revision(), range(11, 11), " ", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(literal.source_text(), "1000000000. body");
    assert_eq!(literal.display_text(), "1000000000. body");
    assert!(literal
        .project(literal.revision(), range(0, 16))
        .unwrap()
        .blocks[0]
        .list
        .is_none());
}

#[test]
fn middle_empty_exit_keeps_the_two_lists_independent_after_fresh_open() {
    let raw = "* a\n* \n* b";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new("a\n\nb");
    view.apply(
        s.paragraph_key(s.revision(), range(2, 2), ParagraphKey::Enter, &mut |_| {
            Ok(())
        })
        .unwrap()
        .unwrap(),
    );
    assert_eq!(view.text, "a\n\nb");
    let mut fresh = EditorSession::open(&s.source_text());
    let mut reopened_view = ReferenceView::new("a\n\nb");
    reopened_view.apply(
        fresh
            .block_command(
                fresh.revision(),
                range(3, 3),
                BlockCommand::TaskList,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
    );
    assert_eq!(fresh.source_text(), "* a\n\n<!-- -->\n- [ ] b");
    assert_eq!(reopened_view.text, "a\n\nb");
    assert_eq!(s.source_text(), "* a\n\n<!-- -->\n* b");
    assert_eq!(s.selection(), range(2, 2));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
}

#[test]
fn nested_backspace_retires_the_item_into_the_immediate_preceding_container() {
    for (raw, shown, caret, expected) in [
        ("- a\n  - b", "a\nb", 2, "- a\n  b"),
        ("- a\n  - b\n  - c", "a\nb\nc", 2, "- a\n  b\n  - c"),
        ("- a\n  - x\n  - b", "a\nx\nb", 4, "- a\n  - x\n    b"),
    ] {
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(shown);
        s.select(s.revision(), range(caret, caret)).unwrap();
        view.apply(
            s.paragraph_key(
                s.revision(),
                range(caret, caret),
                ParagraphKey::Backspace,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
        );
        assert_eq!(s.source_text(), expected);
        assert_eq!(view.text, shown);
        assert_eq!(s.selection(), range(caret, caret));
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), range(caret, caret));
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
    }
}
