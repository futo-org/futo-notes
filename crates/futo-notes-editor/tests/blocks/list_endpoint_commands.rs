use super::*;

#[test]
fn heading_at_a_list_item_boundary_keeps_the_original_formatting_ownership() {
    for command in [BlockCommand::Heading(1), BlockCommand::ToggleHeading(1)] {
        for end in [1, 2] {
            let raw = "1. a\n2. b";
            let mut s = EditorSession::open(raw);
            let mut v = ReferenceView::new("a\nb");
            let selected = range(0, end);
            s.select(s.revision(), selected).unwrap();
            v.apply(
                s.block_command(s.revision(), selected, command, &mut |_| Ok(()))
                    .unwrap()
                    .unwrap(),
            );
            let (expected, display) = if end == 1 {
                ("# a\n\n2. b", "a\n\nb")
            } else {
                ("# a\n# b", "a\nb")
            };
            assert_eq!(s.source_text(), expected, "{command:?}, end={end}");
            assert_eq!(v.text, display);
            assert_eq!(s.selection(), selected);
            v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(s.source_text(), raw);
            assert_eq!(s.selection(), selected);
            v.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(s.source_text(), expected);
        }
    }
}

#[test]
fn lifted_list_endpoint_keeps_its_command_with_unicode_quotes_and_inline_formats() {
    for (raw, display, command, expected) in [
        ("1. a\n2. b", "a\nb", BlockCommand::Quote, "> a\n> b"),
        (
            "> 1. a\n> 2. b",
            "a\nb",
            BlockCommand::Heading(2),
            "> ## a\n> ## b",
        ),
        (
            "- [x] a\n- [ ] b",
            "a\nb",
            BlockCommand::Heading(3),
            "### a\n### b",
        ),
        (
            "1. **a**\n2. *b*",
            "a\nb",
            BlockCommand::Heading(1),
            "# **a**\n# *b*",
        ),
        (
            "1. a\n2. 👩‍🚀x",
            "a\n👩‍🚀x",
            BlockCommand::Heading(1),
            "# a\n# 👩‍🚀x",
        ),
        (
            "1. a\r\n2. b",
            "a\r\nb",
            BlockCommand::Heading(1),
            "# a\r\n# b",
        ),
        (
            "- a\n- \n  b",
            "a\n\nb",
            BlockCommand::Heading(1),
            "# a\n# \nb",
        ),
        (
            "- a\r\n- \r\n  b",
            "a\r\n\r\nb",
            BlockCommand::Heading(1),
            "# a\r\n# \r\nb",
        ),
        (
            "1. a\n2. `` b``",
            "a\n b",
            BlockCommand::Heading(1),
            "# a\n# `` b``",
        ),
    ] {
        let mut s = EditorSession::open(raw);
        let mut v = ReferenceView::new(display);
        let selected = range(0, display.find('\n').unwrap() + 1);
        s.select_with_affinity(s.revision(), selected, Affinity::Backward)
            .unwrap();
        let mut accepted = 0;
        v.apply(
            s.block_command(s.revision(), selected, command, &mut |_| {
                accepted += 1;
                Ok(())
            })
            .unwrap_or_else(|error| panic!("{raw:?}: {error:?}"))
            .unwrap(),
        );
        assert_eq!(accepted, 1, "{raw:?}");
        assert_eq!(s.source_text(), expected, "{raw:?}");
        assert_eq!(v.text, display, "{raw:?}");
        assert_eq!(s.selection(), selected, "{raw:?}");
        assert_eq!(s.affinity(), Affinity::Backward);
        v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), selected);
        assert_eq!(s.affinity(), Affinity::Backward);
        v.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
        assert_eq!(s.source_text(), expected);
    }
}

#[test]
fn explicit_blocks_format_selected_list_parent_and_child() {
    // Explicit block commands own every touched visible line. Text's separate
    // selected-ancestor policy deliberately retains listed descendants.
    for (raw, display, heading, quote) in [
        ("- a\n  - b", "a\nb", "# a\n# b", Some("> a\n> b")),
        ("- [ ] a\n  - [x] b", "a\nb", "# a\n# b", Some("> a\n> b")),
        (
            "7) a\r\n   1. b",
            "a\r\nb",
            "# a\r\n# b",
            Some("> a\r\n> b"),
        ),
        ("> - a\n>   - b", "a\nb", "> # a\n> # b", None),
    ] {
        for command in [
            BlockCommand::Heading(1),
            BlockCommand::ToggleHeading(1),
            BlockCommand::Quote,
        ] {
            if command == BlockCommand::Quote && quote.is_none() {
                continue;
            }
            let mut s = EditorSession::open(raw);
            assert_eq!(s.display_text(), display);
            let selected = range(0, display.len());
            s.select_with_affinity(s.revision(), selected, Affinity::Backward)
                .unwrap();
            let mut v = ReferenceView::new(display);
            let mut accepted = 0;
            let change = s
                .block_command(s.revision(), selected, command, &mut |_| {
                    accepted += 1;
                    Ok(())
                })
                .unwrap_or_else(|error| panic!("{raw:?} {command:?}: {error:?}"))
                .expect("both selected list items become requested blocks");
            v.apply(change);
            assert_eq!(accepted, 1);
            let expected = if command == BlockCommand::Quote {
                quote.unwrap()
            } else {
                heading
            };
            assert_eq!(s.source_text(), expected);
            assert_eq!(v.text, display);
            assert_eq!(s.selection(), selected);
            assert_eq!(s.affinity(), Affinity::Backward);
            assert!(s.toolbar_state().list.is_none());
            v.apply(s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(s.source_text(), raw);
            assert_eq!(s.selection(), selected);
            v.apply(s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap());
            assert_eq!(s.source_text(), expected);
        }
    }
}

#[test]
fn explicit_list_blocks_keep_unselected_descendants_and_opening_endpoints() {
    let raw = "- a\n  - b\n    - c";
    for (end, heading, quote) in [
        (1, "# a\n- b\n  - c", "> a\n- b\n  - c"),
        (2, "# a\n# b\n- c", "> a\n> b\n- c"),
        (3, "# a\n# b\n- c", "> a\n> b\n- c"),
    ] {
        for command in [BlockCommand::Heading(1), BlockCommand::Quote] {
            let mut s = EditorSession::open(raw);
            let selected = range(0, end);
            s.select(s.revision(), selected).unwrap();
            let mut accepted = 0;
            s.block_command(s.revision(), selected, command, &mut |_| {
                accepted += 1;
                Ok(())
            })
            .unwrap_or_else(|error| panic!("end={end} {command:?}: {error:?}"))
            .unwrap();
            assert_eq!(accepted, 1);
            assert_eq!(
                s.source_text(),
                if command == BlockCommand::Quote {
                    quote
                } else {
                    heading
                }
            );
            assert_eq!(s.display_text(), "a\nb\nc");
            assert_eq!(s.selection(), selected);
            s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
            assert_eq!(s.source_text(), raw);
            assert_eq!(s.selection(), selected);
        }
    }
}

#[test]
fn explicit_list_blocks_preserve_nested_quote_retirement_refusal() {
    let raw = "- parent\n  > - child\n  >   - grandchild\n  > - sibling\n- following";
    for command in [BlockCommand::Heading(1), BlockCommand::Quote] {
        let mut s = EditorSession::open(raw);
        let selected = range(7, 12);
        s.select(s.revision(), selected).unwrap();
        assert!(matches!(
            s.block_command(s.revision(), selected, command, &mut |_| panic!(
                "cross-container retirement accepted"
            )),
            Err(EditorError::UnrepresentableFormat)
        ));
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), selected);
        assert_eq!(s.revision(), Revision(0));
    }
}
