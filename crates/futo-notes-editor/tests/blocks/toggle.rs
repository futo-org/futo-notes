use super::*;

#[test]
fn quote_command_on_a_quoted_line_takes_the_quote_off_it() {
    for (opening, caret, expected, again) in [
        (
            "> Title\r\n\r\nend",
            range(0, 0),
            "Title\r\n\r\nend",
            "> Title\r\n\r\nend",
        ),
        (
            "a\n\n> one\n>\n> two\n\nz",
            range(3, 9),
            "a\n\none\n\ntwo\n\nz",
            "a\n\n> one\n>\n> two\n\nz",
        ),
        ("> > deep", range(0, 0), "> deep", "> > deep"),
    ] {
        let mut s = EditorSession::open(opening);
        s.select(s.revision(), caret).unwrap();
        s.block_command(s.revision(), caret, BlockCommand::Quote, &mut |_| Ok(()))
            .unwrap()
            .unwrap_or_else(|| panic!("{opening:?}: the command did nothing"));
        assert_eq!(s.source_text(), expected, "{opening:?}");
        s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
        assert_eq!(s.source_text(), opening);
        let _ = again;
    }
}

#[test]
fn android_heading_toolbar_toggles_only_a_common_current_level() {
    for (opening, level, selected, expected) in [
        ("# title", 1, range(0, 5), "title"),
        ("> ## one\n> ## two", 2, range(0, 7), "> one\n> two"),
        ("## one\n\n### two", 2, range(0, 8), "## one\n## \n## two"),
        ("title", 3, range(0, 5), "### title"),
    ] {
        let mut s = EditorSession::open(opening);
        s.select(s.revision(), selected).unwrap();
        s.block_command(
            s.revision(),
            selected,
            BlockCommand::ToggleHeading(level),
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(s.source_text(), expected, "{opening:?}");
        s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
        assert_eq!(s.source_text(), opening);
        assert_eq!(s.selection(), selected);
    }
}
