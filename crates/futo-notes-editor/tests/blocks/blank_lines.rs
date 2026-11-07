use super::*;

/// Select the whole display, run `command`, and return the resulting source
/// plus the toolbar state seen before the tap. Undo must restore the exact
/// opening bytes and selection.
fn run(opening: &str, command: BlockCommand) -> (String, ToolbarState) {
    let mut s = EditorSession::open(opening);
    let all = range(0, s.display_text().len());
    s.select(s.revision(), all).unwrap();
    let before = s.toolbar_state();
    let changed = s
        .block_command(s.revision(), all, command, &mut |_| Ok(()))
        .unwrap();
    let after = s.source_text();
    if changed.is_some() {
        s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    }
    assert_eq!(
        s.source_text(),
        opening,
        "{opening:?}: undo must restore bytes"
    );
    assert_eq!(
        s.selection(),
        all,
        "{opening:?}: undo must restore selection"
    );
    (after, before)
}

/// Blank lines in a selection are neither touched nor converted, by the
/// heading toggle or by the toolbar state that decides its direction.
#[test]
fn heading_toggle_sets_blank_lines_aside() {
    // (opening, level, source after one tap, heading the toolbar lights before)
    for (opening, level, expected, lit) in [
        ("# a\n\n# b\n", 1, "a\n\nb\n", Some(1)),
        ("## a\n\n## b\n", 2, "a\n\nb\n", Some(2)),
        ("### a\n\n### b\n", 3, "a\n\nb\n", Some(3)),
        ("# a\n\n\n# b", 1, "a\n\n\nb", Some(1)),
        ("a\n\nb\n", 1, "# a\n\n# b\n", Some(0)),
        ("a\n\nb\n", 3, "### a\n\n### b\n", Some(0)),
        ("a\n  \nb", 1, "# a\n  \n# b", Some(0)),
        // Mixed selections: some heading, some text, plus blank lines.
        ("# a\n\nb\n\n# c\n", 1, "# a\n\n# b\n\n# c\n", None),
        ("## a\n\n# b", 1, "# a\n\n# b", None),
        // CRLF keeps every line ending exact.
        ("# a\r\n\r\n# b\r\n", 1, "a\r\n\r\nb\r\n", Some(1)),
        ("a\r\n\r\nb\r\n", 2, "## a\r\n\r\n## b\r\n", Some(0)),
        // Quotes containing blank lines.
        ("> # a\n>\n> # b\n", 1, "> a\n>\n> b\n", Some(1)),
        ("> a\n>\n> b\n", 1, "> # a\n>\n> # b\n", Some(0)),
    ] {
        let (after, before) = run(opening, BlockCommand::ToggleHeading(level));
        assert_eq!(after, expected, "{opening:?} H{level}");
        assert_eq!(before.heading, lit, "{opening:?}: lit heading");
        assert_eq!(before.mixed, lit.is_none(), "{opening:?}: mixed");
    }
}

/// An explicit level or Text over blank lines also leaves them alone.
#[test]
fn explicit_heading_commands_skip_blank_lines() {
    for (opening, command, expected) in [
        ("a\n\nb\n", BlockCommand::Heading(2), "## a\n\n## b\n"),
        ("# a\n\n# b\n", BlockCommand::Heading(0), "a\n\nb\n"),
        ("# a\n\nb\n", BlockCommand::Heading(1), "# a\n\n# b\n"),
    ] {
        let (after, _) = run(opening, command);
        assert_eq!(after, expected, "{opening:?} {command:?}");
    }
}

/// A caret on a blank line is that line's own touched line: it still formats.
#[test]
fn heading_toggle_on_a_lone_blank_line_formats_it() {
    let mut s = EditorSession::open("a\n\nb");
    let caret = range(2, 2);
    s.select(s.revision(), caret).unwrap();
    s.block_command(
        s.revision(),
        caret,
        BlockCommand::ToggleHeading(1),
        &mut |_| Ok(()),
    )
    .unwrap()
    .unwrap();
    assert_eq!(s.source_text(), "a\n# \nb");
}

/// The Quote button lights for a selection whose content lines are all
/// quoted, whatever blank lines sit between them, and its tap then takes the
/// level off exactly as the lit state promises.
#[test]
fn quote_state_and_toggle_set_blank_lines_aside() {
    for (opening, expected) in [
        ("> a\n>\n> b\n", "a\n\nb\n"),
        ("> a\n\n> b\n", "a\n\nb\n"),
        ("> a\r\n>\r\n> b\r\n", "a\r\n\r\nb\r\n"),
    ] {
        let (after, before) = run(opening, BlockCommand::Quote);
        assert!(before.quote, "{opening:?}: Quote lit");
        assert_eq!(after, expected, "{opening:?}");
    }
}

/// Gaps between list items, fences, front matter and trailing blank lines
/// are blank lines too: a heading lands on the content around them.
#[test]
fn heading_skips_blank_lines_between_other_blocks() {
    for (opening, expected) in [
        ("- a\n\n- b\n", "# a\n\n# b\n"),
        ("a\n\n- b\n\nc", "# a\n\n# b\n\n# c"),
        ("```\na\n\nb\n```\n\nc", "```\na\n\nb\n```\n\n# c"),
        (
            "---\nt: 1\n\nx: 2\n---\n\nc",
            "---\nt: 1\n\nx: 2\n---\n\n# c",
        ),
        ("a\n\n\n", "# a\n\n\n"),
        ("> a\n\n> b\n", "> # a\n\n> # b\n"),
    ] {
        let (after, _) = run(opening, BlockCommand::Heading(1));
        assert_eq!(after, expected, "{opening:?}");
    }
}

/// The toolbar's lit state and the tap decide "already formatted" by one rule.
/// These rows were unlit while the tap removed the format. Code and divider
/// lines never take a quote, so they do not stop quoted prose from toggling off.
#[test]
fn toolbar_state_and_tap_agree_on_blank_separated_blocks() {
    for (opening, expected) in [
        ("> a\n\n---", "a\n\n---"),
        ("> a\n\n```\nx\n```", "a\n\n```\nx\n```"),
        ("> a\n\n    code", "a\n\n    code"),
        ("---\n\n> a", "---\n\na"),
    ] {
        let (after, before) = run(opening, BlockCommand::Quote);
        assert!(before.quote, "{opening:?}: Quote lit");
        assert_eq!(after, expected, "{opening:?}");
    }
    // A heading under a different quote depth is still that heading level.
    let (after, before) = run("# a\n\n> # b", BlockCommand::ToggleHeading(1));
    assert_eq!(before.heading, Some(1), "H1 lit");
    assert!(before.mixed, "the block kinds still differ");
    assert_eq!(after, "a\n\n> b");
}

/// Count the quote markers and the headings of one level in `source`, the
/// way a reader of the Markdown does, outside fences.
fn markers(source: &str, level: u8) -> (usize, usize) {
    let (mut quotes, mut headings, mut fenced) = (0, 0, false);
    for line in source.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        let mut rest = line;
        while let Some(inner) = rest.trim_start_matches(' ').strip_prefix('>') {
            quotes += 1;
            rest = inner;
        }
        let rest = rest.trim_start_matches(' ');
        let hashes = rest.bytes().take_while(|byte| *byte == b'#').count();
        if hashes == usize::from(level) && matches!(rest.as_bytes().get(hashes), None | Some(b' '))
        {
            headings += 1;
        }
    }
    (quotes, headings)
}

/// For every selection of every corpus note, a lit toolbar button means its
/// tap takes the format off, and an unlit one means the tap never does.
#[test]
fn toolbar_lit_state_matches_what_the_tap_does() {
    let corpus = [
        "a\n\nb",
        "# a\n\n# b",
        "# a\n\n> # b",
        "> # a\n>\n> # b\n\n## c",
        "> a\n\n---",
        "---\n\n> a",
        "> a\n\n```\nx\n```",
        "> a\n\n    code",
        "# a\n\n---\n\n# b",
        "## a\n```\nx\n```\n## b",
        "> a\n> > # b\n\n> c",
        "- a\n\n- b\n\n> c",
        "> a\n>\n> b\n\n    code\n\n> d",
        "# a\r\n\r\n> # b\r\n\r\n---\r\n",
        "> a\r\n\r\nb\r\n",
        "### a\n\n\n> b\n\n###### c",
        "\n\n# a\n\n",
        "> a\n\n> - b",
    ];
    let mut checked = 0;
    for opening in corpus {
        let len = EditorSession::open(opening).display_text().len();
        for start in 0..=len {
            for end in start..=len {
                let selection = range(start, end);
                for command in [
                    BlockCommand::Quote,
                    BlockCommand::ToggleHeading(1),
                    BlockCommand::ToggleHeading(2),
                    BlockCommand::ToggleHeading(3),
                ] {
                    let mut s = EditorSession::open(opening);
                    if s.select(s.revision(), selection).is_err() {
                        continue;
                    }
                    let before = s.toolbar_state();
                    let Ok(changed) =
                        s.block_command(s.revision(), selection, command, &mut |_| Ok(()))
                    else {
                        continue;
                    };
                    let after = s.source_text();
                    let (level, lit) = match command {
                        BlockCommand::ToggleHeading(level) => {
                            (level, before.heading == Some(level))
                        }
                        _ => (1, before.quote),
                    };
                    let (quotes_before, headings_before) = markers(opening, level);
                    let (quotes_after, headings_after) = markers(&after, level);
                    let (was, now) = if command == BlockCommand::Quote {
                        (quotes_before, quotes_after)
                    } else {
                        (headings_before, headings_after)
                    };
                    let what = format!("{opening:?} {start}..{end} {command:?} lit={lit}");
                    if lit {
                        assert!(
                            changed.is_some() && now < was,
                            "{what}: lit, tap must remove"
                        );
                    } else {
                        assert!(now >= was, "{what}: unlit, tap must not remove");
                    }
                    checked += 1;
                }
            }
        }
    }
    assert!(checked > 1000, "corpus too small: {checked}");
}
