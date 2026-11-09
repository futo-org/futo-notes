use super::*;

#[test]
fn retiring_an_empty_block_keeps_continued_typing_outside_the_previous_list() {
    for (raw, command) in [
        ("- a\n# ", BlockCommand::Heading(0)),
        ("- a\n# ", BlockCommand::ToggleHeading(1)),
        ("- a\n> ", BlockCommand::Quote),
    ] {
        let mut s = EditorSession::open(raw);
        let mut v = ReferenceView::new("a\n");
        let caret = range(2, 2);
        s.select_with_affinity(s.revision(), caret, Affinity::Backward)
            .unwrap();
        let mut accepted = 0;
        v.apply(
            s.block_command(s.revision(), caret, command, &mut |_| {
                accepted += 1;
                Ok(())
            })
            .unwrap()
            .unwrap(),
        );
        assert_eq!(accepted, 1);
        let retired = s.source_text();
        let retired_selection = s.selection();
        assert_eq!(s.affinity(), Affinity::Backward);
        assert!(s.toolbar_state().list.is_none(), "{raw:?} {command:?}");
        v.apply(
            s.replace(s.revision(), s.selection(), "b", &mut |_| Ok(()))
                .unwrap(),
        );
        assert!(
            s.toolbar_state().list.is_none(),
            "{raw:?} {command:?}: {:?}",
            s.source_text()
        );
        assert_eq!(s.source_text(), "- a\n\nb");
        assert_eq!(v.text, "a\n\nb");
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), retired);
        assert_eq!(s.selection(), retired_selection);
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), caret);
    }
}

#[test]
fn the_normal_empty_list_exit_separates_the_following_paragraph() {
    let mut s = EditorSession::open("- a\n- ");
    let mut v = ReferenceView::new("a\n");
    s.select(s.revision(), range(2, 2)).unwrap();
    v.apply(
        s.paragraph_key(
            s.revision(),
            s.selection(),
            ParagraphKey::Enter,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert!(s.toolbar_state().list.is_none());
    v.apply(
        s.replace(s.revision(), s.selection(), "b", &mut |_| Ok(()))
            .unwrap(),
    );
    assert_eq!(s.source_text(), "- a\n\nb");
    assert_eq!(v.text, "a\n\nb");
    assert!(s.toolbar_state().list.is_none());
}

#[test]
fn text_retirement_preserves_paragraph_ownership_and_existing_boundaries() {
    for (raw, before, selected, expected, after, caret, list) in [
        ("- a\n# b", "a\nb", 3, "- a\n\nb", "a\n\nb", 4, false),
        (
            "> - a\n> # b",
            "a\nb",
            3,
            "> - a\n>\n> b",
            "a\n\nb",
            4,
            false,
        ),
        (
            "> - a\n> # ",
            "a\n",
            2,
            "> - a\n> <!-- -->\n> ",
            "a\n",
            2,
            false,
        ),
        (
            "- a\r\n# ",
            "a\r\n",
            3,
            "- a\r\n\r\n",
            "a\r\n\r\n",
            5,
            false,
        ),
        ("- a\n\n# b", "a\n\nb", 4, "- a\n\nb", "a\n\nb", 4, false),
        ("- a\n> # b", "a\nb", 3, "- a\n> b", "a\nb", 3, false),
        ("- # a\n# b", "a\nb", 3, "- # a\nb", "a\nb", 3, false),
        ("# a\n# b", "a\nb", 3, "# a\nb", "a\nb", 3, false),
    ] {
        let mut s = EditorSession::open(raw);
        assert_eq!(s.display_text(), before, "{raw:?}");
        let mut v = ReferenceView::new(before);
        let selected = range(selected, selected);
        s.select(s.revision(), selected).unwrap();
        v.apply(
            s.block_command(
                s.revision(),
                selected,
                BlockCommand::Heading(0),
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap(),
        );
        assert_eq!(s.source_text(), expected, "{raw:?}");
        assert_eq!(v.text, after, "{raw:?}");
        assert_eq!(s.selection(), range(caret, caret), "{raw:?}");
        assert_eq!(s.toolbar_state().list.is_some(), list, "{raw:?}");
        v.apply(
            s.replace(s.revision(), s.selection(), "c", &mut |_| Ok(()))
                .unwrap(),
        );
        assert_eq!(s.source_text(), format!("{expected}c"), "{raw:?}");
        assert_eq!(v.text, format!("{after}c"), "{raw:?}");
        assert!(s.toolbar_state().list.is_none(), "{raw:?}");
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), selected);
    }
}

#[test]
fn a_retired_heading_range_maps_through_its_new_list_separator() {
    let raw = "- a\n# **bc**";
    let mut s = EditorSession::open(raw);
    let mut v = ReferenceView::new("a\nbc");
    let selected = range(2, 3);
    s.select_with_affinity(s.revision(), selected, Affinity::Backward)
        .unwrap();
    v.apply(
        s.block_command(
            s.revision(),
            selected,
            BlockCommand::Heading(0),
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap(),
    );
    assert_eq!(s.source_text(), "- a\n\n**bc**");
    assert_eq!(v.text, "a\n\nbc");
    assert_eq!(s.selection(), range(3, 4));
    assert_eq!(s.affinity(), Affinity::Backward);
    v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.selection(), selected);
}
