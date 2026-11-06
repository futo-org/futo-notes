use super::*;

fn type_chars(s: &mut EditorSession, view: &mut ReferenceView, text: &str) {
    for ch in text.chars() {
        let change = s
            .replace_action(
                s.revision(),
                s.selection(),
                &ch.to_string(),
                InputAction::Typing,
                &mut |_| Ok(()),
            )
            .unwrap_or_else(|error| panic!("{ch:?} refused in {:?}: {error:?}", s.source_text()));
        view.apply(change);
    }
}

/// The block holding the last display line: heading level, quote depth and
/// whether it is listed.
fn last_block(s: &EditorSession) -> (u8, usize, bool) {
    let end = s.display_text().len();
    let slice = s.project(s.revision(), range(0, end)).unwrap();
    let block = slice.blocks.last().unwrap();
    (block.heading, block.quote_depth, block.list.is_some())
}

#[test]
fn heading_and_quote_shortcuts_in_a_list_item_open_inside_the_item() {
    for (raw, typed, expected, display, block) in [
        ("- a", "## x", "- a\n- ## x", "a\nx", (2, 0, true)),
        ("- a", "> x", "- a\n- > x", "a\nx", (0, 1, true)),
        ("1. a", "# h", "1. a\n2. # h", "a\nh", (1, 0, true)),
        ("1. a", "## x", "1. a\n2. ## x", "a\nx", (2, 0, true)),
        // GFM has no heading after a task checkbox: the marker stays text.
        (
            "- [ ] a",
            "## Day Heading",
            "- [ ] a\n- [ ] ## Day Heading",
            "a\n## Day Heading",
            (0, 0, true),
        ),
        (
            "- [ ] a",
            "> q",
            "- [ ] a\n- [ ] > q",
            "a\n> q",
            (0, 0, true),
        ),
        // A quote takes its heading as before.
        ("> a", "## x", "> a\n> ## x", "a\nx", (2, 1, false)),
    ] {
        let mut s = EditorSession::open(raw);
        let mut view = ReferenceView::new(&s.display_text());
        let end = range(view.text.len(), view.text.len());
        s.select(s.revision(), end).unwrap();
        view.apply(
            s.paragraph_key(s.revision(), end, ParagraphKey::Enter, &mut |_| Ok(()))
                .unwrap()
                .unwrap(),
        );
        type_chars(&mut s, &mut view, typed);
        assert_eq!(s.source_text(), expected, "{raw:?} + {typed:?}");
        assert_eq!(view.text, display, "{raw:?} + {typed:?}");
        assert_eq!(last_block(&s), block, "{raw:?} + {typed:?}");
    }
}

#[test]
fn heading_shortcut_at_an_item_text_start_keeps_the_item_and_undoes_the_trigger() {
    let raw = "1. first step\n2. second step";
    let mut s = EditorSession::open(raw);
    let mut view = ReferenceView::new("first step\nsecond step");
    s.select(s.revision(), range(11, 11)).unwrap();
    type_chars(&mut s, &mut view, "## ");
    assert_eq!(s.source_text(), "1. first step\n2. ## second step");
    assert_eq!(view.text, "first step\nsecond step");
    assert_eq!(s.selection(), range(11, 11));
    assert_eq!(last_block(&s), (2, 0, true));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "1. first step\n2. ##second step");
    assert_eq!(view.text, "first step\n##second step");
    assert_eq!(s.selection(), range(13, 13));
    view.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.selection(), range(11, 11));
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    view.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "1. first step\n2. ## second step");
    // A quote marker at a nonempty item's text start quotes inside the item.
    let mut s = EditorSession::open("- a\n- b");
    let mut view = ReferenceView::new("a\nb");
    s.select(s.revision(), range(2, 2)).unwrap();
    type_chars(&mut s, &mut view, "> ");
    assert_eq!(s.source_text(), "- a\n- > b");
    assert_eq!(view.text, "a\nb");
    assert_eq!(last_block(&s), (0, 1, true));
}

#[test]
fn shortcuts_remove_styled_prefixes_and_split_multiline_inline_runs() {
    for (raw, shown, expected, display) in [
        ("__#x__", "#x", "# __x__", "x"),
        ("__#a\nb__", "#a\nb", "# __a__\n__b__", "a\nb"),
        (
            "__>a\r\nb__",
            ">a\r\nb",
            "> __a__\r\n\r\n__b__",
            "a\r\n\r\nb",
        ),
    ] {
        let mut s = EditorSession::open(raw);
        let mut v = ReferenceView::new(shown);
        s.select(s.revision(), range(1, 1)).unwrap();
        let mut accepted = 0;
        v.apply(
            s.replace(s.revision(), s.selection(), " ", &mut |_| {
                accepted += 1;
                Ok(())
            })
            .unwrap(),
        );
        assert_eq!(accepted, 1);
        assert_eq!(s.source_text(), expected, "{raw:?}");
        assert_eq!(v.text, display);
        assert_eq!(s.selection(), range(0, 0));
        assert_eq!(s.active_formats(), vec![InlineFormat::Bold]);
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(v.text, shown);
        assert_eq!(s.selection(), range(1, 1));
        v.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
    }
}

#[test]
fn heading_shortcut_preserves_visible_trailing_hashes_and_exact_trigger_undo() {
    let mut s = EditorSession::open("\\#A #\r\nneighbor");
    let mut v = ReferenceView::new("#A #\r\nneighbor");
    s.select(s.revision(), range(1, 1)).unwrap();
    let mut accepted = 0;
    v.apply(
        s.replace(s.revision(), s.selection(), " ", &mut |_| {
            accepted += 1;
            Ok(())
        })
        .unwrap(),
    );
    assert_eq!(accepted, 1);
    assert_eq!(s.source_text(), "# A \\#\r\nneighbor");
    assert_eq!(v.text, "A #\r\nneighbor");
    assert_eq!(s.selection(), range(0, 0));
    v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "\\#A #\r\nneighbor");
    assert_eq!(v.text, "#A #\r\nneighbor");
    assert_eq!(s.selection(), range(1, 1));
    v.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), "# A \\#\r\nneighbor");
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
    assert_eq!(s.source_text(), "before\r\n***\r\n\r\nafter");
    assert_eq!(s.display_text(), "before\r\n\u{fffc}\r\n\r\nafter");
}
#[test]
fn quote_shortcut_isolates_its_line_from_following_plain_text() {
    let mut s = EditorSession::open("before\r\n\r\nafter");
    s.select(s.revision(), range(8, 8)).unwrap();
    s.replace(s.revision(), s.selection(), ">", &mut |_| Ok(()))
        .unwrap();
    s.replace(s.revision(), s.selection(), " ", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(s.source_text(), "before\r\n> \r\n\r\nafter");
    s.replace(s.revision(), s.selection(), "Q", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(s.source_text(), "before\r\n> Q\r\n\r\nafter");
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
