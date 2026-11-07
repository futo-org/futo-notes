use futo_notes_editor::{
    DisplayRange, DisplayReplacement, EditorError, EditorSession, ParagraphKey, Revision,
    SourceEdit,
};

#[test]
fn clearing_an_outer_pipeless_header_cell_keeps_the_table_and_its_neighbor() {
    let source = "Item | Owner\n:--- | ---";
    let mut session = EditorSession::open(source);
    let table = session
        .inspect_table(Revision(0), DisplayRange::default())
        .unwrap()
        .unwrap();
    let selected = table.rows[0][0].content;
    session.select(Revision(0), selected).unwrap();
    session
        .paragraph_key(Revision(0), selected, ParagraphKey::Backspace, &mut |_| {
            Ok(())
        })
        .unwrap()
        .unwrap();
    let cleared = session
        .inspect_table(session.revision(), session.selection())
        .unwrap()
        .expect("clearing a cell must retain the table");
    assert_eq!(cleared.columns, 2);
    assert_eq!(cleared.rows[0].len(), 2);
    assert_eq!(
        cleared.focus.map(|focus| (focus.row, focus.column)),
        Some((0, 0))
    );
    assert_eq!(
        cleared.rows[0][0].content.start,
        cleared.rows[0][0].content.end
    );
    let neighbor = cleared.rows[0][1].content;
    assert_eq!(
        &session.display_text()[neighbor.start.0..neighbor.end.0],
        "Owner"
    );
    session
        .undo(session.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text(), source);
    assert_eq!(session.selection(), selected);
}

#[test]
fn clearing_edge_cells_keeps_their_caret_formats_and_exact_history_in_every_input_path() {
    type Clear = fn(
        &mut EditorSession,
        DisplayRange,
        &mut dyn FnMut(&SourceEdit) -> Result<(), String>,
    ) -> Result<(), EditorError>;
    let paths: &[(&str, Clear)] = &[
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
    let cases = [
        (
            "Item | **Owner**\n:--- | ---",
            0,
            0,
            "| | **Owner**\n:--- | ---",
        ),
        (
            "**Owner** | *Item*\r\n:--- | ---\r\n",
            0,
            1,
            "**Owner** | |\r\n:--- | ---\r\n",
        ),
        (
            "| Item | Owner |\n| --- | --- |\n| Draft",
            1,
            0,
            "| Item | Owner |\n| --- | --- |\n| |",
        ),
        (
            "| Item | Owner |\n| --- | --- |\n`Draft`",
            1,
            0,
            "| Item | Owner |\n| --- | --- |\n||",
        ),
        (
            "| Item | Owner |\n| --- | --- |\nDraft | **Sam**",
            1,
            0,
            "| Item | Owner |\n| --- | --- |\n| | **Sam**",
        ),
    ];
    for &(source, row, column, expected) in &cases {
        for &(name, clear) in paths {
            let mut s = EditorSession::open(source);
            let before = s
                .inspect_table(s.revision(), DisplayRange::default())
                .unwrap()
                .unwrap();
            let selected = before.rows[row][column].content;
            s.select(s.revision(), selected).unwrap();
            let formats = s
                .project(s.revision(), selected)
                .unwrap()
                .runs
                .into_iter()
                .find(|run| {
                    run.range.start.0 <= selected.start.0 && selected.start.0 < run.range.end.0
                })
                .map_or_else(Vec::new, |run| run.formats);
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
            assert_eq!(s.active_formats(), formats, "{name}: {source}");
            let empty = s.selection();
            s.replace(s.revision(), empty, "X", &mut |_| Ok(()))
                .unwrap();
            let typed = s
                .inspect_table(s.revision(), s.selection())
                .unwrap()
                .unwrap();
            let content = typed.rows[row][column].content;
            assert_eq!(
                &s.display_text()[content.start.0..content.end.0],
                "X",
                "{name}: {source}"
            );
            assert_eq!(s.active_formats(), formats);
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

#[test]
fn refused_edge_cell_clear_preserves_source_selection_and_history() {
    let source = "Item | Owner\n:--- | ---";
    let mut s = EditorSession::open(source);
    let selected = s
        .inspect_table(s.revision(), DisplayRange::default())
        .unwrap()
        .unwrap()
        .rows[0][0]
        .content;
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
fn a_compound_clear_keeps_duplicate_entities_and_the_other_cells_link_identity() {
    let source =
        "**S&#97;m** | [*Sam*](<https://example.test/owner>)\n:--- | ---\nKeep | S&#97;m\n";
    let mut s = EditorSession::open(source);
    let table = s
        .inspect_table(s.revision(), DisplayRange::default())
        .unwrap()
        .unwrap();
    let selected = table.rows[0][0].content;
    let end = table.rows[1][1].content.end;
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
        "| | [*Sam*](<https://example.test/owner>)\n:--- | ---\nKeep | S&#97;m!\n"
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
    assert_eq!(projection.text, "Sam");
    assert_eq!(projection.links.len(), 1);
    assert_eq!(
        projection.links[0].destination,
        "https://example.test/owner"
    );
    assert_eq!(
        projection.runs[0].formats,
        vec![futo_notes_editor::InlineFormat::Italic]
    );
    s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(s.source_text(), source);
    assert_eq!(s.selection(), selected);
}
