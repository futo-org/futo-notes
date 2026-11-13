use futo_notes_editor::{
    DisplayOffset, DisplayRange, EditorError, EditorSession, Revision, TableAlignment,
    TableCommand, TableKey, TableOutcome,
};

const GRID: &str = "| a | b |\n| --- | :-: |\n| c | d |\n";

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

fn cell(session: &EditorSession, row: usize, column: usize) -> DisplayRange {
    let table = session
        .inspect_table(session.revision(), range(0, 0))
        .unwrap()
        .unwrap();
    table.rows[row][column].content
}

/// Caret at the end of a cell's content.
fn caret_in(session: &mut EditorSession, row: usize, column: usize) -> DisplayRange {
    let content = cell(session, row, column);
    let at = range(content.end.0, content.end.0);
    session.select(session.revision(), at).unwrap();
    at
}

fn key(session: &mut EditorSession, key: TableKey) -> Option<TableOutcome> {
    session
        .table_key(session.revision(), key, &mut |_| Ok(()))
        .unwrap()
}

fn command(session: &mut EditorSession, row: usize, column: usize, command: TableCommand) -> bool {
    let at = cell(session, row, column);
    session
        .table_command(session.revision(), at, command, &mut |_| Ok(()))
        .unwrap()
        .is_some()
}

fn typed(session: &mut EditorSession, at: DisplayRange, text: &str) {
    session
        .replace(session.revision(), at, text, &mut |_| Ok(()))
        .unwrap();
}

#[test]
fn tables_project_cells_and_alignment_and_only_real_tables() {
    let session = EditorSession::open("| **a** | b\\|c |\n|:--|--:|\n| x |\n\npara\n");
    let table = session
        .inspect_table(Revision(0), range(0, 0))
        .unwrap()
        .unwrap();
    assert_eq!(table.columns, 2);
    assert_eq!(
        table.alignments,
        vec![TableAlignment::Left, TableAlignment::Right]
    );
    assert_eq!(
        session.display_text(),
        "| a | b|c |\n|:--|--:|\n| x |\n\npara\n"
    );
    let texts: Vec<Vec<String>> = table
        .rows
        .iter()
        .map(|row| {
            row.iter()
                .map(|cell| {
                    session.display_text()[cell.content.start.0..cell.content.end.0].to_owned()
                })
                .collect()
        })
        .collect();
    assert_eq!(texts, vec![vec!["a", "b|c"], vec!["x"]]);
    assert_eq!(table.focus, None);
    let inside = session
        .inspect_table(Revision(0), range(3, 3))
        .unwrap()
        .unwrap();
    assert_eq!(inside.focus.map(|f| (f.row, f.column)), Some((0, 0)));
    assert!(session
        .inspect_table(Revision(0), range(33, 33))
        .unwrap()
        .is_none());
    for plain in [
        "| a | b |\nno delimiter\n",
        "```\n| a |\n| - |\n```\n",
        "> | a |\n> | - |\n",
        "- | a |\n  | - |\n",
    ] {
        let session = EditorSession::open(plain);
        assert!(
            session
                .inspect_table(Revision(0), range(2, 2))
                .unwrap()
                .is_none(),
            "{plain:?}"
        );
    }
}

#[test]
fn cell_edits_land_as_typed_and_undo_restores_exact_bytes() {
    let original = "| a | b |\n| - | - |\n| **c** | d |\n";
    let mut session = EditorSession::open(original);
    // A typed pipe lands as typed: the row gains a cell.
    let c = caret_in(&mut session, 1, 0);
    typed(&mut session, c, "|");
    assert_eq!(
        session.source_text(),
        "| a | b |\n| - | - |\n| **c|** | d |\n"
    );
    let d = caret_in(&mut session, 1, 2);
    typed(&mut session, d, "\\|");
    assert_eq!(
        session.source_text(),
        "| a | b |\n| - | - |\n| **c|** | d\\| |\n"
    );
    // A typed line break breaks the row's line.
    let b = cell(&session, 0, 1);
    typed(&mut session, b, "x\ny");
    assert_eq!(
        session.source_text(),
        "| a | x\ny |\n| - | - |\n| **c|** | d\\| |\n"
    );
    // Undo reverses the cell edits exactly.
    while session
        .undo(session.revision(), &mut |_| Ok(()))
        .unwrap()
        .is_some()
    {}
    assert_eq!(session.source_text(), original);
}

#[test]
fn every_input_path_escapes_pipes_inside_a_cell() {
    use futo_notes_editor::{DisplayReplacement, ParagraphKey};
    type Path = fn(&mut EditorSession, DisplayRange);
    let paths: &[(&str, Path)] = &[
        ("replace", |s, at| {
            s.replace(s.revision(), at, "x|*y*", &mut |_| Ok(()))
                .unwrap();
        }),
        ("replace_many", |s, at| {
            let run = DisplayReplacement {
                range: at,
                inserted: "x|*y*".into(),
            };
            s.replace_many(s.revision(), &[run], &mut |_| Ok(()))
                .unwrap();
        }),
        ("composition", |s, at| {
            s.compose(s.revision(), at, "x|*y*").unwrap();
            s.commit_composition(s.revision(), None, &mut |_| Ok(()))
                .unwrap();
        }),
        ("os replacement", |s, at| {
            let word = range(at.start.0 - 1, at.end.0);
            s.replace_os(s.revision(), word, "ax|*y*", &[], &mut |_| Ok(()))
                .unwrap();
        }),
    ];
    // Nothing is escaped: every path writes the pipe as given.
    for (name, path) in paths {
        let mut session = EditorSession::open(GRID);
        let at = caret_in(&mut session, 0, 0);
        path(&mut session, at);
        assert_eq!(
            session.source_text(),
            GRID.replace("| a |", "| ax|*y* |"),
            "{name}"
        );
    }
    // Enter in a cell follows the table keys; it never splits a row.
    let enter = |session: &mut EditorSession, key| {
        let at = session.selection();
        session
            .paragraph_key(session.revision(), at, key, &mut |_| Ok(()))
            .unwrap()
            .unwrap()
    };
    let mut session = EditorSession::open(GRID);
    caret_in(&mut session, 0, 0);
    let moved = enter(&mut session, ParagraphKey::Enter);
    assert_eq!(moved.selection, cell(&session, 1, 0));
    assert_eq!(session.source_text(), GRID);
    enter(&mut session, ParagraphKey::Enter);
    assert_eq!(session.source_text(), format!("{GRID}|  |  |\n"));
    // Shift+Enter is Enter: a cell holds one line.
    caret_in(&mut session, 1, 1);
    let moved = enter(&mut session, ParagraphKey::ShiftEnter);
    assert_eq!(moved.selection, cell(&session, 2, 1));
    assert_eq!(session.source_text(), format!("{GRID}|  |  |\n"));
}

#[test]
fn keys_navigate_extend_exit_and_break_with_exact_bytes() {
    let mut session = EditorSession::open(GRID);
    caret_in(&mut session, 0, 0);
    key(&mut session, TableKey::Tab);
    assert_eq!(session.selection(), cell(&session, 0, 1));
    key(&mut session, TableKey::Tab);
    assert_eq!(session.selection(), cell(&session, 1, 0));
    key(&mut session, TableKey::ShiftTab);
    assert_eq!(session.selection(), cell(&session, 0, 1));
    key(&mut session, TableKey::Enter);
    assert_eq!(session.selection(), cell(&session, 1, 1));
    assert_eq!(session.source_text(), GRID);
    // Enter on the last row appends a row and enters the same column.
    key(&mut session, TableKey::Enter);
    assert_eq!(session.source_text(), format!("{GRID}|  |  |\n"));
    let at = cell(&session, 2, 1);
    assert_eq!(session.selection(), range(at.start.0, at.start.0));
    // Tab from the last cell appends too, entering the first column.
    key(&mut session, TableKey::Tab);
    assert_eq!(session.source_text(), format!("{GRID}|  |  |\n|  |  |\n"));
    assert_eq!(session.selection().start, cell(&session, 3, 0).start);
    // Shift+Enter is Enter; Shift+Tab in the first cell is the host's.
    caret_in(&mut session, 1, 0);
    key(&mut session, TableKey::ShiftEnter);
    assert_eq!(session.selection(), cell(&session, 2, 0));
    assert_eq!(session.source_text(), format!("{GRID}|  |  |\n|  |  |\n"));
    caret_in(&mut session, 0, 0);
    assert!(key(&mut session, TableKey::ShiftTab).is_none());
    // Mod+Enter leaves the caret on an empty line after the table.
    let mut exit = EditorSession::open("| a |\n| - |\n| b |");
    caret_in(&mut exit, 1, 0);
    key(&mut exit, TableKey::ModEnter);
    assert_eq!(exit.source_text(), "| a |\n| - |\n| b |\n");
    assert_eq!(exit.selection().start.0, exit.display_text().len());
    // An empty line already after the table is reused, not written again.
    let mut middle = EditorSession::open("| a |\r\n| - |\r\n\r\nnext\r\n");
    caret_in(&mut middle, 0, 0);
    key(&mut middle, TableKey::ModEnter);
    assert_eq!(middle.source_text(), "| a |\r\n| - |\r\n\r\nnext\r\n");
    let line = "| a |\r\n| - |\r\n".len();
    assert_eq!(middle.selection(), range(line, line));
    // A lone `|` body row gains cells up to the one the caret enters.
    let mut lone = EditorSession::open("| a | b |\n| - | - |\n|\n");
    caret_in(&mut lone, 0, 1);
    key(&mut lone, TableKey::Tab);
    assert_eq!(lone.source_text(), "| a | b |\n| - | - |\n|  |\n");
    assert_eq!(lone.selection().start, cell(&lone, 1, 0).start);
    // Outside a table every key is the paragraph path's.
    let mut prose = EditorSession::open("plain\n");
    assert!(key(&mut prose, TableKey::Tab).is_none());
}

#[test]
fn rows_and_columns_insert_and_delete_preserving_untouched_bytes_and_alignment() {
    use TableCommand::*;
    let wide = "|a|  b  |\n|:--|--:|\n|x|y|\n|z|\n";
    let cases: &[(&str, usize, usize, TableCommand, &str)] = &[
        (
            GRID,
            1,
            0,
            InsertRowBelow,
            "| a | b |\n| --- | :-: |\n| c | d |\n|  |  |\n",
        ),
        (
            GRID,
            1,
            1,
            InsertRowAbove,
            "| a | b |\n| --- | :-: |\n|  |  |\n| c | d |\n",
        ),
        (
            GRID,
            0,
            1,
            InsertRowBelow,
            "| a | b |\n| --- | :-: |\n|  |  |\n| c | d |\n",
        ),
        (
            GRID,
            1,
            0,
            InsertColumnLeft,
            "|  | a | b |\n| --- | --- | :-: |\n|  | c | d |\n",
        ),
        (
            GRID,
            0,
            1,
            InsertColumnRight,
            "| a | b |  |\n| --- | :-: | --- |\n| c | d |  |\n",
        ),
        (
            wide,
            0,
            1,
            InsertColumnLeft,
            "|a|  |  b  |\n|:--| --- |--:|\n|x|  |y|\n|z|\n",
        ),
        (wide, 0, 1, DeleteColumn, "|a|\n|:--|\n|x|\n|z|\n"),
        (
            wide,
            1,
            0,
            InsertRowBelow,
            "|a|  b  |\n|:--|--:|\n|x|y|\n|  |  |\n|z|\n",
        ),
        (
            "| a |\n| - |\n",
            0,
            0,
            InsertRowBelow,
            "| a |\n| - |\n|  |\n",
        ),
        ("| a |\n| - |", 0, 0, InsertRowBelow, "| a |\n| - |\n|  |"),
    ];
    for (source, row, column, which, expected) in cases {
        let mut session = EditorSession::open(source);
        assert!(
            command(&mut session, *row, *column, *which),
            "{source:?} {which:?}"
        );
        assert_eq!(&session.source_text(), expected, "{source:?} {which:?}");
        // One command is one undo step.
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(&session.source_text(), source);
        assert!(session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .is_none());
    }
}

#[test]
fn body_rows_delete_in_the_middle_and_at_an_unterminated_end() {
    use TableCommand::*;
    let three = "| h |\n| - |\n| a |\n| b |\n| c |\n";
    let mut session = EditorSession::open(three);
    assert!(command(&mut session, 2, 0, DeleteRow));
    assert_eq!(session.source_text(), "| h |\n| - |\n| a |\n| c |\n");
    assert!(command(&mut session, 2, 0, DeleteRow));
    assert_eq!(session.source_text(), "| h |\n| - |\n| a |\n");
    let mut tail = EditorSession::open("| h |\n| - |\n| a |\n| b |\n| c |");
    assert!(command(&mut tail, 3, 0, DeleteRow));
    assert_eq!(tail.source_text(), "| h |\n| - |\n| a |\n| b |");
}

#[test]
fn controls_disable_header_deletion_last_row_and_last_column() {
    let session = EditorSession::open("| h |\n| - |\n| a |\n");
    let header = session
        .inspect_table(Revision(0), range(2, 2))
        .unwrap()
        .unwrap();
    let body = session
        .inspect_table(Revision(0), range(16, 16))
        .unwrap()
        .unwrap();
    let (h, b) = (header.controls.unwrap(), body.controls.unwrap());
    assert!(!h.insert_row_above && !h.delete_row && !h.delete_column);
    assert!(h.insert_row_below && h.insert_column_left && h.insert_column_right);
    assert!(!b.delete_row && b.insert_row_above);
    let mut session = EditorSession::open("| h |\n| - |\n| a |\n");
    for (row, which) in [
        (0, TableCommand::DeleteRow),
        (1, TableCommand::DeleteRow),
        (1, TableCommand::DeleteColumn),
        (0, TableCommand::InsertRowAbove),
    ] {
        assert!(!command(&mut session, row, 0, which));
    }
    assert_eq!(session.revision(), Revision(0));
}

#[test]
fn cell_paste_flattens_lines_keeps_edge_spaces_and_stays_in_one_cell() {
    let mut session = EditorSession::open("| r1a | b |\n| - | - |\n");
    let at = caret_in(&mut session, 0, 0);
    let paste = |session: &mut EditorSession, at: DisplayRange, text: &str| {
        session
            .paste_markdown(session.revision(), at, text, &mut |_| Ok(()))
            .unwrap()
    };
    paste(&mut session, at, " world").unwrap();
    assert_eq!(session.source_text(), "| r1a world | b |\n| - | - |\n");
    let at = caret_in(&mut session, 0, 1);
    paste(&mut session, at, "\n\none\n  two | three\r\nfour\n").unwrap();
    assert_eq!(
        session.source_text(),
        "| r1a world | bone two \\| three four |\n| - | - |\n"
    );
    let at = cell(&session, 0, 0);
    paste(&mut session, at, " # h").unwrap();
    assert_eq!(
        session.source_text(),
        "|  # h | bone two \\| three four |\n| - | - |\n"
    );
    // One paste is one history action; a refused acceptance changes nothing.
    let before = session.source_text();
    let at = cell(&session, 0, 1);
    let refused = session.paste_markdown(session.revision(), at, "x", &mut |_| Err("no".into()));
    assert!(refused.is_err());
    assert_eq!(session.source_text(), before);
    let across = range(cell(&session, 0, 0).start.0, cell(&session, 0, 1).end.0);
    assert!(session
        .paste_markdown(session.revision(), across, "x", &mut |_| Ok(()))
        .is_err());
    session
        .undo(session.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(
        session.source_text(),
        "| r1a world | bone two \\| three four |\n| - | - |\n"
    );
}

#[test]
fn cell_edit_work_follows_the_table_not_the_note() {
    let mut source = String::new();
    for index in 0..1500 {
        source.push_str(&format!("paragraph {index} with some words in it\n\n"));
    }
    let table = "| a | b | c |\n| - | - | - |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n";
    source.push_str(table);
    source.push_str("\ntail\n");
    let mut session = EditorSession::open(&source);
    let start = source.find("| 4").unwrap();
    let at = range(start + 2, start + 3);
    session.select(Revision(0), at).unwrap();
    let change = session
        .replace(Revision(0), at, "x|", &mut |_| Ok(()))
        .unwrap();
    assert!(
        change.work.parsed_source_bytes < 8 * table.len(),
        "parsed {} of {}",
        change.work.parsed_source_bytes,
        source.len()
    );
    assert!(source.len() > 50_000);
}

#[test]
fn portable_table_steps_wait_for_acceptance_but_selection_moves_do_not() {
    use futo_notes_editor::{PortableSession, PortableTableStep, SessionToken};
    let mut page = PortableSession::open(SessionToken(7), GRID, Revision(0));
    let a = page
        .inspect_table(Revision(0), range(0, 0))
        .unwrap()
        .unwrap()
        .rows[0][0]
        .content;
    page.select_with_affinity(Revision(0), a, futo_notes_editor::Affinity::Forward)
        .unwrap();
    let Some(PortableTableStep::Selected(_)) = page.table_key(Revision(0), TableKey::Tab).unwrap()
    else {
        panic!("Tab selects the next cell");
    };
    // A typed pipe lands as typed: the body row gains a cell.
    page.replace(Revision(0), range(30, 31), "x|").unwrap();
    assert_eq!(page.draft_text(), "| a | b |\n| --- | :-: |\n| c | x| |\n");
    assert!(page
        .inspect_table(Revision(1), range(0, 0))
        .unwrap()
        .is_some());
}

#[test]
fn markdown_paste_inside_a_table_joins_into_the_cell_and_refuses_across_cells() {
    let mut session = EditorSession::open(GRID);
    let at = cell(&session, 0, 0);
    session
        .paste_markdown(session.revision(), at, "x\n# y", &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text().lines().next(), Some("| x # y | b |"));
    let across = range(cell(&session, 0, 0).start.0, cell(&session, 0, 1).end.0);
    assert_eq!(
        session
            .paste_markdown(session.revision(), across, "z", &mut |_| Ok(()))
            .unwrap_err(),
        EditorError::UnrepresentableFormat
    );
}

#[test]
fn utf16_variants_address_cells_in_native_units_and_reject_split_surrogates() {
    use futo_notes_editor::{DisplayUtf16Offset, DisplayUtf16Range};
    let mut session = EditorSession::open("| \u{1F600}a | b |\n| - | - |\n| c | d |\n");
    let at = cell(&session, 0, 0);
    let native = session.display_to_utf16(Revision(0), at).unwrap();
    assert_eq!(native.end.0 - native.start.0, 3);
    assert_eq!(
        session.inspect_table_utf16(Revision(0), native).unwrap(),
        session.inspect_table(Revision(0), at).unwrap()
    );
    let split = DisplayUtf16Range {
        start: DisplayUtf16Offset(native.start.0 + 1),
        end: native.end,
    };
    assert_eq!(
        session.inspect_table_utf16(Revision(0), split),
        Err(EditorError::InvalidRange)
    );
    // A typed pipe lands as typed: the body row gains a cell.
    let c = session
        .display_to_utf16(Revision(0), cell(&session, 1, 0))
        .unwrap();
    let caret = DisplayUtf16Range {
        start: c.end,
        end: c.end,
    };
    session
        .replace_utf16(Revision(0), caret, &[0x7c, 0x78], &mut |_| Ok(()))
        .unwrap();
    assert!(session.source_text().ends_with("| c|x | d |\n"));
    let at = cell(&session, 0, 0);
    let native = session.display_to_utf16(session.revision(), at).unwrap();
    session
        .table_command_utf16(
            session.revision(),
            native,
            TableCommand::InsertRowBelow,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap();
    session
        .replace_utf16(session.revision(), native, &[0x79], &mut |_| Ok(()))
        .unwrap();
    assert!(session.source_text().starts_with("| y | b |"));
}
