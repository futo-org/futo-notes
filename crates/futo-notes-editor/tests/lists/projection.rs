use super::*;

/// Chaos lane-1-07: the line Enter leaves a last item for (after the blank line it writes) is
/// a plain line, so a renderer draws its caret at the margin, not at the item's text indent.
/// A line straight under an item still continues it: text typed there is lazy.
#[test]
fn a_line_after_a_blank_line_at_the_end_of_a_list_is_not_in_the_list() {
    // (note, a display offset on a line after the blank line)
    for (raw, at) in [
        ("- [ ] eggs\n- [ ] lemons (3)\n\n\n", 17),
        ("1. a\n\n\n\n", 3),
        ("1. a\n\n\n\n", 4),
    ] {
        let s = EditorSession::open(raw);
        let line = s.project(s.revision(), range(at, at)).unwrap();
        assert!(
            line.blocks.iter().all(|b| b.list.is_none()),
            "{raw:?} at {at}: {:?}",
            line.blocks
        );
    }
    let s = EditorSession::open("- a\n\n");
    let lazy = s.project(s.revision(), range(2, 2)).unwrap();
    assert!(
        lazy.blocks.iter().any(|b| b.list.is_some()),
        "{:?}",
        lazy.blocks
    );
}

#[test]
fn opening_supported_list_spellings_hides_markers_and_retains_lazy_numbers() {
    let raw =
        "* **a**\r\n+ b\r\n- [X] done\r\n\r\n5) first\r\n1) second\r\n\r\n9. [ ] todo\r\n1. last";
    let shown = "a\r\nb\r\ndone\r\n\r\nfirst\r\nsecond\r\n\r\ntodo\r\nlast";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new(shown);
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.display_text(), shown);
    view.apply(
        s.replace(s.revision(), range(1, 1), "!", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(
        s.source_text(),
        "* **a!**\r\n+ b\r\n- [X] done\r\n\r\n5) first\r\n1) second\r\n\r\n9. [ ] todo\r\n1. last"
    );
    assert_eq!(
        view.text,
        "a!\r\nb\r\ndone\r\n\r\nfirst\r\nsecond\r\n\r\ntodo\r\nlast"
    );
    assert_eq!(s.selection(), range(2, 2));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(view.text, shown);
}

#[test]
fn list_projection_supplies_interpreted_ordinals_and_task_state_without_rewriting() {
    let raw = "5) [X] first\n1) second\n\n+ final";
    let s = EditorSession::open(raw);
    let projected = s
        .project(s.revision(), range(0, s.display_text().len()))
        .unwrap();
    let blocks = serde_json::to_value(projected.blocks).unwrap();
    assert_eq!(
        blocks[0]["list"],
        serde_json::json!({"depth":1,"number":5,"checked":true,"first":true})
    );
    assert_eq!(
        blocks[1]["list"],
        serde_json::json!({"depth":1,"number":6,"checked":null,"first":true})
    );
    assert_eq!(
        blocks[3]["list"],
        serde_json::json!({"depth":1,"number":null,"checked":null,"first":true})
    );
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.display_text(), "first\nsecond\n\nfinal");
}

#[test]
fn indented_loose_lists_keep_one_owner_across_continuation_and_blank_lines() {
    let raw = "  5) first\n     tail\n\n  1) next\n\n+ keep";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new("first\ntail\n\nnext\n\nkeep");
    assert_eq!(s.display_text(), view.text);
    let projection = s.project(s.revision(), range(0, view.text.len())).unwrap();
    let blocks = serde_json::to_value(projection.blocks).unwrap();
    assert_eq!(
        blocks[1]["list"],
        serde_json::json!({"depth":1,"number":5,"checked":null,"first":false})
    );
    assert_eq!(blocks[3]["list"]["number"], 6);
    view.apply(
        s.paragraph_key(s.revision(), range(5, 5), ParagraphKey::Enter, &mut |_| {
            Ok(())
        })
        .unwrap()
        .unwrap(),
    );
    assert_eq!(
        s.source_text(),
        "  5) first\n  6) \n     tail\n\n  7) next\n\n+ keep"
    );
    assert_eq!(view.text, "first\n\ntail\n\nnext\n\nkeep");
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
}

#[test]
fn a_long_lazy_list_keeps_distant_marker_bytes_and_continuation_semantics() {
    let raw = (0..4096)
        .map(|n| format!("1) line{n}"))
        .collect::<Vec<_>>()
        .join("\n");
    let shown = (0..4096)
        .map(|n| format!("line{n}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut s = EditorSession::open(&raw);
    let mut view = ReferenceView::new(&shown);
    assert_eq!(s.display_text(), shown);
    let at = shown.find("line2048").unwrap() + "line2048".len();
    view.apply(
        s.replace(s.revision(), range(at, at), "!", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(s.source_text(), raw.replacen("line2048", "line2048!", 1));
    assert_eq!(view.text, shown.replacen("line2048", "line2048!", 1));
    let tail = view.text.find("line4095").unwrap();
    let projection = s
        .project(s.revision(), range(tail, view.text.len()))
        .unwrap();
    assert_eq!(
        projection.blocks[0].list.as_ref().unwrap().number,
        Some(4096)
    );
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
}

#[test]
fn tab_expanded_content_columns_hide_the_complete_owned_continuation_prefix() {
    let raw = "-\tparent\n    tail\n-\tchild";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new("parent\ntail\nchild");
    assert_eq!(s.display_text(), view.text);
    s.select(s.revision(), range(8, 8)).unwrap();
    view.apply(
        s.replace_action(
            s.revision(),
            range(8, 8),
            "!",
            InputAction::Isolated,
            &mut |_| Ok(()),
        )
        .unwrap(),
    );
    assert_eq!(s.source_text(), "-\tparent\n    t!ail\n-\tchild");
    assert_eq!(view.text, "parent\nt!ail\nchild");
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
}

#[test]
fn nested_navigation_stops_at_visible_graphemes_and_unavailable_tab_leaves_source_history_untouched(
) {
    let raw = "> - 🦊a\r\n>   - e\u{301}b";
    let mut s = EditorSession::open(raw);
    assert_eq!(s.display_text(), "🦊a\r\ne\u{301}b");
    for at in [4, 5, 7, 10, 11, 11] {
        let change = s.move_caret(Revision(0), CaretDirection::Forward).unwrap();
        assert_eq!(change.selection, range(at, at));
        assert_eq!(change.revision, Revision(0));
    }
    // The nested item has no sibling to nest under, so Tab (Indent) is a no-op.
    assert!(s
        .paragraph_key(
            Revision(0),
            range(10, 11),
            ParagraphKey::Tab,
            &mut |_| panic!("unavailable Tab accepted")
        )
        .unwrap()
        .is_none());
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.revision(), Revision(0));
    assert!(s
        .undo(Revision(0), &mut |_| panic!("selection wrote history"))
        .unwrap()
        .is_none());
}
