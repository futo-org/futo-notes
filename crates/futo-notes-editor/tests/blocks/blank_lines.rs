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
    // Front matter is no heading content.
    let (after, before) = run(
        "---\ntitle: x\n---\n\n# Title",
        BlockCommand::ToggleHeading(1),
    );
    assert_eq!(before.heading, Some(1), "front matter: H1 lit");
    assert_eq!(after, "---\ntitle: x\n---\n\nTitle");
}

/// Quote's direction is decided once, on the selection as given: unquoted text
/// ending at a list line quotes, and a lifted list item never flips it.
#[test]
fn quote_over_a_selection_touching_a_list_line_applies() {
    for (opening, end) in [("> quote\n\n- item", 7), ("> a\n- a", 2)] {
        let mut s = EditorSession::open(opening);
        let selection = range(0, end);
        s.select(s.revision(), selection).unwrap();
        let lit = s.toolbar_state().quote;
        s.block_command(
            s.revision(),
            selection,
            BlockCommand::Quote,
            &mut |_| Ok(()),
        )
        .unwrap();
        let (quotes, _) = counts(&s.source_text());
        assert!(
            !lit && quotes >= counts(opening).0,
            "{opening:?}: {:?}",
            s.source_text()
        );
    }
}

/// Line-weighted quote depth and heading count per level, read from the
/// editor's own projection of `source`.
fn counts(source: &str) -> (usize, [usize; 7]) {
    let s = EditorSession::open(source);
    let text = s.display_text();
    let view = s.project(s.revision(), range(0, text.len())).unwrap();
    let (mut quotes, mut headings) = (0, [0; 7]);
    for block in &view.blocks {
        let slice = &text[block.range.start.0.min(text.len())..block.range.end.0.min(text.len())];
        let lines = slice.matches('\n').count() + 1;
        quotes += block.quote_depth * lines;
        headings[usize::from(block.heading)] += lines;
    }
    (quotes, headings)
}

fn enumeration_corpus() -> Vec<String> {
    let fragments = [
        "a",
        "# a",
        "a\n===",
        "> a",
        "> # a",
        "- a",
        "- > a",
        "- # a",
        "- > # a",
        "---",
        "```\nx\n```",
        "    code",
        "> b\nlazy",
    ];
    let separators = ["\n\n", "\n"];
    let mut notes = Vec::new();
    for first in fragments {
        notes.push(first.to_string());
        for second in fragments {
            for separator in separators {
                notes.push(format!("{first}{separator}{second}"));
            }
        }
    }
    let pairs = notes.clone();
    for (index, note) in pairs.iter().enumerate() {
        if index % 3 == 0 {
            notes.push(format!("---\nt: 1\n---\n\n{note}"));
        }
        if index % 7 == 1 {
            notes.push(format!("---\nt: 1\n---\n{note}"));
        }
        if index % 8 == 2 {
            notes.push(note.replace('\n', "\r\n"));
        }
    }
    notes.push("---\ntitle: x\n---\n\n# Title".to_string());
    notes
}

/// For every selection of every corpus note, a lit toolbar button means its
/// tap takes the format off, and an unlit one means the tap never does. A lit
/// button's tap may instead be refused with `UnrepresentableFormat`, which
/// leaves the text as it was: a quote beside a lazy continuation, or inside a
/// list item, cannot be rewritten exactly.
///
/// Two shapes are known and left out. A heading tap whose selection ends at
/// the first text of a list item lifts that item out of its list and drops its
/// heading (`---\n\n- # a` selected up to `a`). Removing an ATX heading above
/// a setext one merges the two into one setext heading (`# a\na\n===`).
#[test]
fn toolbar_lit_state_matches_what_the_tap_does() {
    let mut failures = Vec::new();
    let mut checked = 0;
    for opening in enumeration_corpus() {
        let before_counts = counts(&opening);
        let opened = EditorSession::open(&opening);
        let display = opened.display_text();
        let len = display.len();
        let view = opened.project(opened.revision(), range(0, len)).unwrap();
        let list_starts: Vec<usize> = view
            .blocks
            .iter()
            .filter(|block| block.list.is_some())
            .map(|block| block.range.start.0)
            .collect();
        for start in 0..=len {
            for end in start..=len {
                // A selection edge between a CRLF's two characters is no caret.
                if [start, end].into_iter().any(|at| {
                    display.get(..at).is_some_and(|head| head.ends_with('\r'))
                        && display[at..].starts_with('\n')
                }) {
                    continue;
                }
                let selection = range(start, end);
                let mut probe = EditorSession::open(&opening);
                if probe.select(probe.revision(), selection).is_err() {
                    continue;
                }
                let toolbar = probe.toolbar_state();
                // Hosts hand a command the selection the session holds.
                let selection = probe.selection();
                for command in [
                    BlockCommand::Quote,
                    BlockCommand::ToggleHeading(1),
                    BlockCommand::ToggleHeading(2),
                    BlockCommand::ToggleHeading(3),
                ] {
                    let (lit, level) = match command {
                        BlockCommand::ToggleHeading(level) => {
                            (toolbar.heading == Some(level), usize::from(level))
                        }
                        _ => (toolbar.quote, 0),
                    };
                    let heading = command != BlockCommand::Quote;
                    if heading && start < end && list_starts.contains(&end) {
                        continue;
                    }
                    let mut s = EditorSession::open(&opening);
                    s.select(s.revision(), selection).unwrap();
                    let result = s.block_command(s.revision(), selection, command, &mut |_| Ok(()));
                    let after = match &result {
                        Ok(Some(_)) => counts(&s.source_text()),
                        _ => before_counts,
                    };
                    let metric =
                        |c: &(usize, [usize; 7])| if level == 0 { c.0 } else { c.1[level] };
                    let (was, now) = (metric(&before_counts), metric(&after));
                    let problem = match (&result, lit) {
                        (Err(EditorError::UnrepresentableFormat), true) => None,
                        (Err(error), true) => Some(format!("lit but refused: {error:?}")),
                        (Ok(None), true) => Some("lit but a no-op".to_string()),
                        (Ok(Some(_)), true)
                            if now >= was && !(heading && opening.contains("===")) =>
                        {
                            Some("lit but kept".to_string())
                        }
                        (Ok(_), false) if now < was => Some("unlit but removed".to_string()),
                        _ => None,
                    };
                    if let Some(problem) = problem {
                        failures.push(format!("{opening:?} {start}..{end} {command:?}: {problem}"));
                    }
                    checked += 1;
                }
            }
        }
    }
    assert!(checked > 50_000, "corpus too small: {checked}");
    failures.dedup();
    assert!(
        failures.is_empty(),
        "{} of {checked} taps disagree with the toolbar, e.g.\n{}",
        failures.len(),
        failures
            .iter()
            .take(25)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}
