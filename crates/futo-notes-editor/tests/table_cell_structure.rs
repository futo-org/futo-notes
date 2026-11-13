use futo_notes_editor::{
    DisplayOffset, DisplayRange, DisplayReplacement, EditorError, EditorSession, ParagraphKey,
    Revision, SourceEdit,
};

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

type Clear = fn(
    &mut EditorSession,
    DisplayRange,
    &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
) -> Result<(), EditorError>;

/// Every input path that can clear a selected cell.
const PATHS: &[(&str, Clear)] = &[
    ("backspace", |s, at, accept| {
        s.paragraph_key(s.revision(), at, ParagraphKey::Backspace, accept)
            .map(|_| ())
    }),
    ("delete", |s, at, accept| {
        s.paragraph_key(s.revision(), at, ParagraphKey::Delete, accept)
            .map(|_| ())
    }),
    ("replace", |s, at, accept| {
        s.replace(s.revision(), at, "", accept).map(|_| ())
    }),
    ("compound", |s, at, accept| {
        s.replace_many(
            s.revision(),
            &[DisplayReplacement {
                range: at,
                inserted: String::new(),
            }],
            accept,
        )
        .map(|_| ())
    }),
    ("composition", |s, at, accept| {
        s.compose(s.revision(), at, "")?;
        s.commit_composition(s.revision(), None, accept).map(|_| ())
    }),
    ("os replacement", |s, at, accept| {
        s.replace_os(s.revision(), at, "", &[], accept).map(|_| ())
    }),
];

fn cell(s: &EditorSession, row: usize, column: usize) -> DisplayRange {
    s.inspect_table(s.revision(), DisplayRange::default())
        .unwrap()
        .unwrap()
        .rows[row][column]
        .content
}

#[test]
fn clearing_a_cell_keeps_its_table_focus_and_exact_history_in_every_input_path() {
    let cases = [
        (
            "| Item | **Owner** |\n|:--- | --- |",
            0,
            1,
            "| Item |  |\n|:--- | --- |",
        ),
        (
            "| **Owner** | *Item* |\r\n|:--- | --- |\r\n",
            0,
            1,
            "| **Owner** |  |\r\n|:--- | --- |\r\n",
        ),
        (
            "| Item | Owner |\n| --- | --- |\n| Draft | **Sam**",
            1,
            0,
            "| Item | Owner |\n| --- | --- |\n|  | **Sam**",
        ),
    ];
    for &(source, row, column, expected) in &cases {
        for &(name, clear) in PATHS {
            let mut s = EditorSession::open(source);
            let selected = cell(&s, row, column);
            s.select(s.revision(), selected).unwrap();
            let mut accepted = 0;
            clear(&mut s, selected, &mut |_| {
                accepted += 1;
                Ok(())
            })
            .unwrap_or_else(|error| panic!("{name}: {source}: {error:?}"));
            assert_eq!(accepted, 1, "{name}: {source}");
            assert_eq!(s.source_text(), expected, "{name}: {source}");
            let cleared = s
                .inspect_table(s.revision(), s.selection())
                .unwrap()
                .unwrap();
            assert_eq!(
                cleared.focus.map(|focus| (focus.row, focus.column)),
                Some((row, column)),
                "{name}: {source}"
            );
            assert_eq!(s.selection().start, s.selection().end);
            let empty = s.selection();
            s.replace(s.revision(), empty, "X", &mut |_| Ok(()))
                .unwrap();
            let content = cell(&s, row, column);
            assert_eq!(
                &s.display_text()[content.start.0..content.end.0],
                "X",
                "{name}: {source}"
            );
            s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
            assert_eq!(s.source_text(), expected);
            assert_eq!(s.selection(), empty);
            s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
            assert_eq!(s.source_text(), source);
            assert_eq!(s.selection(), selected);
            s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
            assert_eq!(s.source_text(), expected);
            assert_eq!(s.selection(), empty);
            let reopened = EditorSession::open(&s.source_text());
            let table = reopened
                .inspect_table(reopened.revision(), empty)
                .unwrap()
                .unwrap();
            assert_eq!(
                table.focus.map(|focus| (focus.row, focus.column)),
                Some((row, column))
            );
        }
    }
}

/// Clearing a whole formatted cell, then typing, writes the typed text in the
/// cell's formats.
#[test]
fn clearing_a_formatted_cell_keeps_its_caret_formats() {
    let source = "| Item | **Owner** |\n|:--- | --- |";
    for &(name, clear) in PATHS {
        let mut s = EditorSession::open(source);
        let selected = cell(&s, 0, 1);
        s.select(s.revision(), selected).unwrap();
        let formats = s.active_formats();
        assert_eq!(formats, vec![futo_notes_editor::InlineFormat::Bold]);
        clear(&mut s, selected, &mut |_| Ok(())).unwrap();
        assert_eq!(s.active_formats(), formats, "{name}");
    }
}

#[test]
fn refused_cell_clear_preserves_source_selection_and_history() {
    let source = "| Item | Owner |\n|:--- | --- |";
    let mut s = EditorSession::open(source);
    let selected = cell(&s, 0, 0);
    s.select(s.revision(), selected).unwrap();
    let error = s
        .replace(s.revision(), selected, "", &mut |_| {
            Err("disk unavailable".into())
        })
        .unwrap_err();
    assert_eq!(error, EditorError::Persistence("disk unavailable".into()));
    assert_eq!(s.source_text(), source);
    assert_eq!(s.selection(), selected);
    assert_eq!(s.revision(), Revision(0));
    assert!(s.undo(s.revision(), &mut |_| Ok(())).unwrap().is_none());
}

#[test]
fn an_escaped_pipe_in_a_last_cell_is_ordinary_text_not_a_separator() {
    // (source, row, column); the only source `y` is the cell's last display char.
    let cases = [
        ("| a | b |\n| --- | --- |\n| c | x \\| y", 1, 1),
        ("| a | x \\| y\n| --- | --- |", 0, 1),
        ("| a | b |\n| --- | --- |\n| c | x\\|y", 1, 1),
    ];
    for (source, row, column) in cases {
        for inserted in ["", " "] {
            let mut s = EditorSession::open(source);
            let content = cell(&s, row, column);
            let y = range(content.end.0 - 1, content.end.0);
            s.select(s.revision(), y).unwrap();
            let result = if inserted.is_empty() {
                s.paragraph_key(s.revision(), y, ParagraphKey::Backspace, &mut |_| Ok(()))
                    .map(|_| ())
            } else {
                s.replace(s.revision(), y, inserted, &mut |_| Ok(()))
                    .map(|_| ())
            };
            result.unwrap_or_else(|error| panic!("{source:?} + {inserted:?}: {error:?}"));
            let expected = source.replacen('y', inserted, 1);
            assert_eq!(s.source_text(), expected, "{source:?} + {inserted:?}");
        }
    }
}

/// An entity is literal text: `S&#97;m` shows as typed and is never decoded.
#[test]
fn a_compound_clear_keeps_literal_entities_and_the_other_cells_link_identity() {
    let source =
        "| **S&#97;m** | [*Sam*](<https://example.test/owner>) |\n|:--- | --- |\n| Keep | S&#97;m |\n";
    let mut s = EditorSession::open(source);
    let selected = cell(&s, 0, 0);
    let end = cell(&s, 1, 1).end;
    assert_eq!(
        &s.display_text()[selected.start.0..selected.end.0],
        "S&#97;m"
    );
    s.select(s.revision(), selected).unwrap();
    let mut accepted = 0;
    s.replace_many(
        s.revision(),
        &[
            DisplayReplacement {
                range: selected,
                inserted: String::new(),
            },
            DisplayReplacement {
                range: DisplayRange { start: end, end },
                inserted: "!".into(),
            },
        ],
        &mut |_| {
            accepted += 1;
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(
        s.source_text(),
        "|  | [*Sam*](<https://example.test/owner>) |\n|:--- | --- |\n| Keep | S&#97;m! |\n"
    );
    let table = s
        .inspect_table(s.revision(), s.selection())
        .unwrap()
        .unwrap();
    assert_eq!(
        table.focus.map(|focus| (focus.row, focus.column)),
        Some((1, 1))
    );
    let neighbor = table.rows[0][1].content;
    let projection = s.project(s.revision(), neighbor).unwrap();
    let links: Vec<_> = projection
        .links
        .iter()
        .filter(|link| link.range == neighbor)
        .collect();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0].destination, "https://example.test/owner");
    let run = projection
        .runs
        .iter()
        .find(|run| run.range == neighbor)
        .unwrap();
    assert_eq!(run.formats, vec![futo_notes_editor::InlineFormat::Italic]);
    s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(s.source_text(), source);
    assert_eq!(s.selection(), selected);
}

#[test]
fn a_header_is_read_after_any_line_and_tracks_edits_to_its_delimiter_row() {
    for prefix in [
        "intro\n",
        "| intro | text |\nnot a delimiter\n",
        "# intro\n",
    ] {
        let source = format!("{prefix}| Item | Owner |\n|:--- | --- |\n| x | y |\n");
        let mut s = EditorSession::open(&source);
        let at = s.display_text().find("Item").unwrap();
        let selected = range(at, at + 4);
        assert!(s.inspect_table(s.revision(), selected).unwrap().is_some());
        s.select(s.revision(), selected).unwrap();
        s.paragraph_key(s.revision(), selected, ParagraphKey::Backspace, &mut |_| {
            Ok(())
        })
        .unwrap()
        .unwrap();
        assert_eq!(
            s.source_text(),
            format!("{prefix}|  | Owner |\n|:--- | --- |\n| x | y |\n")
        );
        assert_eq!(
            s.inspect_table(s.revision(), s.selection())
                .unwrap()
                .unwrap()
                .focus
                .map(|focus| (focus.row, focus.column)),
            Some((0, 0))
        );
    }
    // Changing the delimiter row ends the table at once; Undo restores it.
    let mut s = EditorSession::open("| Item | Owner |\n|:--- | --- |\n| x | y |\n");
    let at = s.display_text().find(":---").unwrap();
    s.replace(s.revision(), range(at, at + 4), "invalid", &mut |_| Ok(()))
        .unwrap();
    assert!(s
        .inspect_table(s.revision(), DisplayRange::default())
        .unwrap()
        .is_none());
    s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    let cell = cell(&s, 1, 0);
    s.select(s.revision(), cell).unwrap();
    s.paragraph_key(s.revision(), cell, ParagraphKey::Backspace, &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(
        s.source_text(),
        "| Item | Owner |\n|:--- | --- |\n|  | y |\n"
    );
    // A line that is not a row ends the table; a pipe line after it is plain.
    let source = "| Item | Owner |\n|:--- | --- |\n| x | y |\n# stop\n| Body | Tail |\n";
    let mut s = EditorSession::open(source);
    let at = s.display_text().find("Body").unwrap();
    let body = range(at, at + 4);
    assert!(s.inspect_table(s.revision(), body).unwrap().is_none());
    s.replace(s.revision(), body, "", &mut |_| Ok(())).unwrap();
    assert_eq!(
        s.source_text(),
        "| Item | Owner |\n|:--- | --- |\n| x | y |\n# stop\n|  | Tail |\n"
    );
}
