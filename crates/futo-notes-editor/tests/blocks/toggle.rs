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
        ("# title\n", 1, range(0, 6), "title\n"),
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
#[test]
fn select_all_quote_changes_eligible_rows_in_a_mixed_note() {
    let opening = "# title\n\n**bold**\n\n- one\n- two\n\n```rs\nraw\n```\n\n| a | b |\n| - | - |\n| c | d |\n";
    let mut s = EditorSession::open(opening);
    let shown = s.display_text();
    let selected = range(0, shown.len());
    s.select(s.revision(), selected).unwrap();
    let mut accepted = 0;
    s.block_command(s.revision(), selected, BlockCommand::Quote, &mut |_| {
        accepted += 1;
        Ok(())
    })
    .unwrap()
    .unwrap();
    assert_eq!(accepted, 1);
    assert!(s.source_text().starts_with("> title\n"));
    assert!(s.source_text().contains("> **bold**"));
    assert!(s.source_text().contains("> one\n> two"));
    assert!(s.source_text().contains("```rs\nraw\n```"));
    assert!(s.source_text().contains("> | a | b |"));
    assert!(
        s.source_text().ends_with("| c | d |\n"),
        "{:?}",
        s.source_text()
    );
    assert!(s.selection().end.0 <= s.display_text().len());
    s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(s.source_text(), opening);
    assert_eq!(s.selection(), selected);
}
