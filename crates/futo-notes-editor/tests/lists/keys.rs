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
    assert_eq!(
        s.source_text(),
        "* __a__\r\n* __b__\r\n\r\n+ neighbor  \r\n"
    );
    assert_eq!(view.text, "a\r\nb\r\n\r\nneighbor  \r\n");
    assert_eq!(s.selection(), range(3, 3));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.selection(), range(1, 1));
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(
        s.source_text(),
        "* __a__\r\n* __b__\r\n\r\n+ neighbor  \r\n"
    );
    assert_eq!(s.selection(), range(3, 3));
}

#[test]
fn task_enter_keeps_the_original_state_and_starts_an_unchecked_item() {
    for (selected, expected, shown, caret) in [
        (
            range(0, 0),
            "- [ ] \r\n- [X] done\r\n\r\n+ keep",
            "\r\ndone\r\n\r\nkeep",
            2,
        ),
        (
            range(2, 2),
            "- [X] do\r\n- [ ] ne\r\n\r\n+ keep",
            "do\r\nne\r\n\r\nkeep",
            4,
        ),
        (
            range(4, 4),
            "- [X] done\r\n- [ ] \r\n\r\n+ keep",
            "done\r\n\r\n\r\nkeep",
            6,
        ),
        (
            range(0, 4),
            "- [ ] \r\n- [X] \r\n\r\n+ keep",
            "\r\n\r\n\r\nkeep",
            2,
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
            "* a\r\n<!-- -->\r\n\r\n* b",
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
fn enter_at_a_list_start_opens_an_item_above_and_continuation_enter_splits_the_item() {
    for (raw, selected, expected, shown, caret) in [
        ("* ab", range(0, 0), "* \n* ab", "\nab", 1),
        (
            "5) ab\n1) keep",
            range(0, 0),
            "5) \n6) ab\n1) keep",
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
    assert_eq!(fresh.source_text(), "* a\n<!-- -->\n\n* [ ] b");
    assert_eq!(reopened_view.text, "a\n\nb");
    assert_eq!(s.source_text(), "* a\n<!-- -->\n\n* b");
    assert_eq!(s.selection(), range(2, 2));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
}

#[test]
fn an_empty_marker_indented_under_a_list_item_is_an_empty_nested_item_not_a_setext_underline() {
    // As in Obsidian (Lezer): inside a list item the marker opens an item; outside
    // one (`a\n-`) it stays a setext underline.
    let s = EditorSession::open("- a\n  - ");
    let p = s.project(s.revision(), range(0, 1)).unwrap();
    assert_eq!(p.blocks[0].heading, 0);
    assert_eq!(s.display_text(), "a\n");
    let s = EditorSession::open("a\n-");
    assert_eq!(
        s.project(s.revision(), range(0, 1)).unwrap().blocks[0].heading,
        2
    );
}

#[test]
fn an_empty_nested_marker_of_every_kind_is_an_item_and_a_numbered_two_is_text() {
    for source in [
        "- a\n\t- ",
        "* a\n  *",
        "1. a\n   1. ",
        "1) a\n   1)",
        "1. a\n   - ",
        "- a\n  1. ",
        "- a\n  - [ ] ",
        "> - a\n>   - ",
        "- a\r\n  - ",
        "- a\n  - b\n    - ",
    ] {
        let s = EditorSession::open(source);
        assert!(
            s.display_text().ends_with('\n'),
            "{source:?}: {:?}",
            s.display_text()
        );
        assert_eq!(
            s.project(s.revision(), range(0, 1)).unwrap().blocks[0].heading,
            0,
            "{source:?}"
        );
    }
    // A number other than 1 cannot interrupt a paragraph, as in CommonMark.
    assert_eq!(EditorSession::open("- a\n  2. ").display_text(), "a\n2. ");
}

/// Enter on an empty nested item outdents it one level, last or not: the
/// items after it at its old level become its children and ordered lists on
/// both levels count on sequentially (decided 2026-11-02, as Google Docs).
#[test]
fn empty_nested_item_enter_outdents_and_adopts_the_items_after_it() {
    for (raw, expected) in [
        // Bullets, a middle item and a last item.
        ("- a\n  - b\n  - \n  - c\n- d\n", "- a\n  - b\n- \n  - c\n- d\n"),
        ("- a\n  - b\n  - \n- d\n", "- a\n  - b\n- \n- d\n"),
        // Ordered on both levels.
        (
            "1. a\n   1. b\n   2. \n   3. c\n2. d\n",
            "1. a\n   1. b\n2. \n   1. c\n3. d\n",
        ),
        // Mixed nesting either way.
        (
            "1. a\n   - b\n   - \n   - c\n2. d\n",
            "1. a\n   - b\n2. \n   - c\n3. d\n",
        ),
        (
            "- a\n  1. b\n  2. \n  3. c\n- d\n",
            "- a\n  1. b\n- \n  1. c\n- d\n",
        ),
        // Tasks keep their states; the empty task stays a task.
        (
            "- [ ] a\n  - [x] b\n  - [ ] \n  - [ ] c\n",
            "- [ ] a\n  - [x] b\n- [ ] \n  - [ ] c\n",
        ),
        // Three levels: only the empty item's level moves.
        (
            "- a\n  - b\n    - x\n    - \n    - y\n  - c\n",
            "- a\n  - b\n    - x\n  - \n    - y\n  - c\n",
        ),
        // Lazy numbers stay as written; the respelled item takes its number.
        (
            "1. a\n   1. b\n   1. \n   1. c\n1. d\n",
            "1. a\n   1. b\n2. \n   1. c\n1. d\n",
        ),
        // A renumbered item owning rows keeps digits that would change width.
        (
            "1. a\n   1. b\n   2. \n2. c\n3. c\n4. c\n5. c\n6. c\n7. c\n8. c\n9. c\n   1. d\n",
            "1. a\n   1. b\n2. \n3. c\n4. c\n5. c\n6. c\n7. c\n8. c\n9. c\n9. c\n   1. d\n",
        ),
        // The corpus 6ae4d2 shape: numbered steps with numbered sub-steps.
        (
            "1. Download\n2. Create\n   1. General\n      1. Name\n   2. \n   3. System\n      1. Disk\n   4. Memory\n3. Done\n",
            "1. Download\n2. Create\n   1. General\n      1. Name\n3. \n   1. System\n      1. Disk\n   2. Memory\n4. Done\n",
        ),
    ] {
        let mut s = EditorSession::open(raw);
        let empty = raw
            .lines()
            .position(|line| line.trim_end().ends_with(['-', '.', ']']))
            .unwrap();
        let display = s.display_text();
        let at: usize = display.split_inclusive('\n').take(empty).map(str::len).sum();
        let mut view = ReferenceView::new(&display);
        view.apply(
            s.paragraph_key(s.revision(), range(at, at), ParagraphKey::Enter, &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        assert_eq!(s.source_text(), expected, "{raw:?}");
        assert_eq!(view.text, s.display_text(), "{raw:?}");
        assert_eq!(s.selection(), range(at, at), "{raw:?}");
        assert_eq!(
            EditorSession::open(expected).display_text(),
            s.display_text(),
            "{raw:?}"
        );
        view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw, "{raw:?} undo");
        assert_eq!(view.text, display);
        view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected, "{raw:?} redo");
    }
}
