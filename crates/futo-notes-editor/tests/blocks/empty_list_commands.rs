use super::*;

#[test]
fn an_empty_list_item_accepts_its_final_heading_or_quote_in_one_action() {
    for (raw, display, caret, heading, quote) in [
        ("- a\n- ", "a\n", 2, "- a\n# ", Some("- a\n> ")),
        ("1. a\n2. ", "a\n", 2, "1. a\n# ", Some("1. a\n> ")),
        (
            "- [x] a\n- [ ] ",
            "a\n",
            2,
            "- [x] a\n# ",
            Some("- [x] a\n> "),
        ),
        (
            "- a\n  - b\n  - ",
            "a\nb\n",
            4,
            "- a\n  - b\n# ",
            Some("- a\n  - b\n> "),
        ),
        ("> - a\n> - ", "a\n", 2, "> - a\n> # ", None),
        ("- ", "", 0, "# ", Some("> ")),
        ("- a\n- \n", "a\n\n", 2, "- a\n# \n", Some("- a\n> \n")),
        ("- \n- b", "\nb", 0, "# \n- b", Some("> \n- b")),
        (
            "- a\n- \n  b",
            "a\n\nb",
            2,
            "- a\n# \nb",
            Some("- a\n> \nb"),
        ),
        ("- 👩‍🚀\r\n- ", "👩‍🚀\r\n", 13, "- 👩‍🚀\r\n# ", Some("- 👩‍🚀\r\n> ")),
    ] {
        for command in [
            BlockCommand::Heading(1),
            BlockCommand::ToggleHeading(1),
            BlockCommand::Quote,
        ] {
            let expected = if command == BlockCommand::Quote {
                let Some(quote) = quote else {
                    continue;
                };
                quote
            } else {
                heading
            };
            let mut s = EditorSession::open(raw);
            assert_eq!(s.display_text(), display);
            let mut v = ReferenceView::new(display);
            let selected = range(caret, caret);
            s.select_with_affinity(s.revision(), selected, Affinity::Backward)
                .unwrap();
            let mut accepted = 0;
            let change = s
                .block_command(s.revision(), selected, command, &mut |_| {
                    accepted += 1;
                    Ok(())
                })
                .unwrap_or_else(|error| panic!("{raw:?} {command:?}: {error:?}"))
                .unwrap();
            assert_eq!(accepted, 1);
            assert_eq!(s.source_text(), expected, "{raw:?} {command:?}");
            v.apply(change);
            assert_eq!(v.text, s.display_text());
            assert_eq!(s.selection(), selected);
            assert_eq!(s.affinity(), Affinity::Backward);
            let state = s.toolbar_state();
            assert!(state.list.is_none(), "{raw:?} {command:?}: {state:?}");
            if command == BlockCommand::Quote {
                assert!(state.quote);
            } else {
                assert_eq!(state.heading, Some(1));
            }
            v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(s.source_text(), raw);
            assert_eq!(v.text, display);
            assert_eq!(s.selection(), selected);
            v.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(s.source_text(), expected);
            let before_typing = s.display_text();
            v.apply(
                s.replace(s.revision(), s.selection(), "x", &mut |_| Ok(()))
                    .unwrap(),
            );
            let typed_display = if raw == "- a\n- \n  b" && command == BlockCommand::Quote {
                "a\nx\n\nb".to_owned()
            } else {
                format!("{}x{}", &before_typing[..caret], &before_typing[caret..])
            };
            assert_eq!(v.text, typed_display);
            v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(s.source_text(), expected);
        }
    }
}

#[test]
fn code_wrap_on_the_same_empty_list_caret_is_one_direct_final_shape() {
    let raw = "- a\n- ";
    let mut s = EditorSession::open(raw);
    s.select(s.revision(), range(2, 2)).unwrap();
    let mut accepted = 0;
    s.block_command(
        s.revision(),
        s.selection(),
        BlockCommand::WrapCodeBlock,
        &mut |_| {
            accepted += 1;
            Ok(())
        },
    )
    .unwrap()
    .unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(s.source_text(), "- a\n```\n\n```");
    assert!(s.toolbar_state().code);
    s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.selection(), range(2, 2));
}

#[test]
fn a_wider_list_selection_formats_its_empty_item_without_a_text_intermediate() {
    for (raw, display, heading, quote) in [
        ("- a\n- ", "a\n", "# a\n# ", "> a\n> "),
        ("- **a**\n- ", "a\n", "# **a**\n# ", "> **a**\n> "),
        ("- \n- ", "\n", "# \n# ", "> \n> "),
        ("> - a\n> - ", "a\n", "> # a\n> # ", "> a\n> "),
    ] {
        for command in [BlockCommand::Heading(1), BlockCommand::Quote] {
            if raw.starts_with('>') && command == BlockCommand::Quote {
                continue;
            }
            let mut s = EditorSession::open(raw);
            let mut v = ReferenceView::new(display);
            let selected = range(0, display.len());
            s.select(s.revision(), selected).unwrap();
            let mut accepted = 0;
            v.apply(
                s.block_command(s.revision(), selected, command, &mut |_| {
                    accepted += 1;
                    Ok(())
                })
                .unwrap_or_else(|error| panic!("{raw:?} {command:?}: {error:?}"))
                .unwrap(),
            );
            assert_eq!(accepted, 1);
            assert_eq!(
                s.source_text(),
                if command == BlockCommand::Quote {
                    quote
                } else {
                    heading
                }
            );
            assert_eq!(v.text, display);
            assert_eq!(s.selection(), selected);
            v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(s.source_text(), raw);
            assert_eq!(s.selection(), selected);
        }
    }
}

#[test]
fn heading_or_quote_over_an_empty_item_leaves_the_next_item_alone() {
    let raw = "- a\n- \n- c";
    for (command, expected) in [
        (BlockCommand::Heading(2), "## a\n## \n- c"),
        (BlockCommand::Quote, "> a\n> \n- c"),
    ] {
        let mut s = EditorSession::open(raw);
        let selected = range(0, 2);
        s.select(s.revision(), selected).unwrap();
        s.block_command(s.revision(), selected, command, &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(s.source_text(), expected, "{command:?}");
        assert_eq!(s.selection(), selected, "{command:?}");
        s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
        assert_eq!(s.source_text(), raw, "{command:?}");
        assert_eq!(s.selection(), selected, "{command:?}");
    }
}
