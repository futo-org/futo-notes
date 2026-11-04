use super::*;

#[test]
fn android_heading_backspace_joins_the_previous_line_before_demoting() {
    for (opening, at, expected, caret) in [
        ("\n# title", 1, "# title", 0),
        ("above\n\n## title", 7, "above\n## title", 6),
        ("above\r\n## title", 7, "abovetitle", 5),
        ("# title", 0, "title", 0),
        ("- item\n\n## title", 6, "- item\n## title", 5),
        ("> above\n> # title", 6, "> abovetitle", 5),
    ] {
        let mut s = EditorSession::open(opening);
        let selected = range(at, at);
        s.select(s.revision(), selected).unwrap();
        s.paragraph_key(
            s.revision(),
            selected,
            ParagraphKey::BackspaceJoiningHeading,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(s.source_text(), expected, "{opening:?}");
        assert_eq!(s.selection(), range(caret, caret), "{opening:?}");
        s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
        assert_eq!(s.source_text(), opening);
        assert_eq!(s.selection(), selected);
    }
}

#[test]
fn android_heading_join_keeps_existing_structural_neighbor_rules() {
    for (opening, expected) in [
        ("- item\n# title", Some("- itemtitle")),
        ("> quote\n\n# title", Some("> quote\n# title")),
        ("```\ncode\n```\n# title", None),
        (
            "| a | b |\n| - | - |\n| c | d |\n\n# title",
            Some("| a | b |\n| - | - |\n| c | d |\n# title"),
        ),
        ("> # one\n>\n> ## title", Some("> # one\n> ## title")),
    ] {
        let mut s = EditorSession::open(opening);
        let shown = s.display_text();
        let at = shown.rfind("title").unwrap();
        let selected = range(at, at);
        s.select(s.revision(), selected).unwrap();
        let mut accepted = 0;
        let result = s.paragraph_key(
            s.revision(),
            selected,
            ParagraphKey::BackspaceJoiningHeading,
            &mut |_| {
                accepted += 1;
                Ok(())
            },
        );
        if let Some(expected) = expected {
            result
                .unwrap_or_else(|e| panic!("{opening:?}: {e:?}"))
                .unwrap();
            assert_eq!(accepted, 1);
            assert_eq!(s.source_text(), expected);
            assert_eq!(
                EditorSession::open(&s.source_text()).display_text(),
                s.display_text()
            );
            s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
        } else {
            assert!(matches!(result, Err(EditorError::UnrepresentableFormat)));
            assert_eq!(accepted, 0);
            assert_eq!(s.revision(), Revision(0));
        }
        assert_eq!(s.source_text(), opening);
        assert_eq!(s.selection(), selected);
    }
}
