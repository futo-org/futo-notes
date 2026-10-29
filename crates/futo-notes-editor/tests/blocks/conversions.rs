use super::*;

#[test]
fn shortcuts_remove_styled_prefixes_and_split_multiline_inline_runs() {
    for (raw, shown, expected, display) in [
        ("__#x__", "#x", "# __x__", "x"),
        ("__#a\nb__", "#a\nb", "# __a__\n__b__", "a\nb"),
        ("__>a\r\nb__", ">a\r\nb", "> __a__\r\n\n__b__", "a\r\n\nb"),
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
    assert_eq!(s.source_text(), "before\r\n***\n\r\nafter");
    assert_eq!(s.display_text(), "before\r\n\u{fffc}\n\r\nafter");
}
#[test]
fn quote_shortcut_isolates_its_line_from_following_plain_text() {
    let mut s = EditorSession::open("before\r\n\r\nafter");
    s.select(s.revision(), range(8, 8)).unwrap();
    s.replace(s.revision(), s.selection(), ">", &mut |_| Ok(()))
        .unwrap();
    s.replace(s.revision(), s.selection(), " ", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(s.source_text(), "before\r\n> \r\n\nafter");
    s.replace(s.revision(), s.selection(), "Q", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(s.source_text(), "before\r\n> Q\r\n\nafter");
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
