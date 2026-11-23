use futo_notes_editor::host::{self, DisplayMirror, StyleSpec};
use futo_notes_editor::*;

/// The style plan of display `window`, as a native session's `style_plan` makes it: over the
/// window widened by `table_window`.
fn planned(session: &EditorSession, window: DisplayRange) -> Vec<StyleSpec> {
    let display = session.display_text();
    let mirror = DisplayMirror::new(&display);
    let slice = session.project(session.revision(), window).unwrap();
    let widened = host::table_window(&slice);
    let slice = session.project(session.revision(), widened).unwrap();
    let mut to_utf16 = |b: usize| mirror.byte_to_utf16(b).unwrap();
    let start = to_utf16(widened.start.0);
    host::plan_styles(&slice, start, &mut to_utf16)
}

#[test]
fn tables_plan_as_whole_row_spans_with_cell_ranges_and_a_delimiter() {
    let source = "intro\n\n| 日本 | b |\n|:--|--:|\n| x | y |\n\nafter\n";
    let session = EditorSession::open(source);
    let display = session.display_text();
    let end = display.len();
    let range = DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(end),
    };
    let spans = planned(&session, range);
    let units: Vec<u16> = display.encode_utf16().collect();
    let text = |s: usize, e: usize| String::from_utf16(&units[s..e]).unwrap();
    let rows: Vec<_> = spans
        .iter()
        .filter_map(|s| match s {
            StyleSpec::TableRow {
                start,
                end,
                header,
                cells,
                columns,
                ..
            } => Some((
                text(*start, *end),
                *header,
                *columns,
                cells
                    .iter()
                    .map(|c| (text(c.start, c.end), c.alignment))
                    .collect::<Vec<_>>(),
            )),
            _ => None,
        })
        .collect();
    assert_eq!(rows.len(), 2);
    assert!(rows[0].1 && !rows[1].1);
    assert_eq!(rows[0].2, 2);
    assert_eq!(
        rows[0].3,
        vec![
            ("日本".to_string(), TableAlignment::Left),
            ("b".to_string(), TableAlignment::Right)
        ]
    );
    assert_eq!(rows[1].3[0].0, "x");
    assert_eq!(
        spans
            .iter()
            .filter(|s| matches!(s, StyleSpec::TableDelimiter { .. }))
            .count(),
        1
    );
    let tables: Vec<_> = spans
        .iter()
        .filter_map(|s| match s {
            StyleSpec::Table {
                start,
                end,
                columns,
                alignments,
            } => Some((text(*start, *end), *columns, alignments.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(
        tables,
        [(
            "| 日本 | b |\n|:--|--:|\n| x | y |".to_string(),
            2,
            vec![TableAlignment::Left, TableAlignment::Right]
        )]
    );
    let pipes: Vec<String> = spans
        .iter()
        .filter_map(|s| match s {
            StyleSpec::TableRow { pipes, row, .. } if *row == 1 => {
                Some(pipes.iter().map(|&p| text(p, p + 1)).collect())
            }
            _ => None,
        })
        .collect();
    assert_eq!(pipes, ["|||"]);
}

/// `(row text, header, table_start)` of each planned row and the delimiter count, for the
/// tables whose lines meet `window` (display bytes of `needle` through `until`).
fn table_rows(source: &str, window: Option<(&str, &str)>) -> (Vec<(String, bool, usize)>, usize) {
    let session = EditorSession::open(source);
    let display = session.display_text();
    let whole = DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(display.len()),
    };
    let window = window.map_or(whole, |(from, until)| DisplayRange {
        start: DisplayOffset(display.find(from).unwrap()),
        end: DisplayOffset(display.find(until).unwrap()),
    });
    let spans = planned(&session, window);
    let units: Vec<u16> = display.encode_utf16().collect();
    let rows = spans
        .iter()
        .filter_map(|s| match s {
            StyleSpec::TableRow {
                start,
                end,
                header,
                table_start,
                ..
            } => Some((
                String::from_utf16(&units[*start..*end]).unwrap(),
                *header,
                *table_start,
            )),
            _ => None,
        })
        .collect();
    let delimiters = spans
        .iter()
        .filter(|s| matches!(s, StyleSpec::TableDelimiter { .. }))
        .count();
    (rows, delimiters)
}

fn numbered_table() -> String {
    let mut source = String::from("intro\n\n| head | v |\n| --- | --- |\n");
    for i in 0..30 {
        source.push_str(&format!("| r{i:02} | v |\n"));
    }
    source.push_str("\nafter\n");
    source
}

/// A restyle window inside a table's body plans the rows it meets, not the whole table: a
/// keystroke in a 20,000-row table must not pay for every row. Each row's span is the same one
/// the whole plan gives it (same columns, alignments and `table_start`).
#[test]
fn a_window_in_the_body_plans_only_the_rows_it_meets() {
    let source = numbered_table();
    let (whole, _) = table_rows(&source, None);
    assert_eq!(whole.len(), 31);
    let (rows, delimiters) = table_rows(&source, Some(("r10", "r12")));
    let texts: Vec<_> = rows.iter().map(|r| r.0.as_str()).collect();
    assert_eq!(
        texts,
        ["| r10 | v |", "| r11 | v |", "| r12 | v |"],
        "rows whose line meets the window, whole"
    );
    assert_eq!(delimiters, 0);
    for row in &rows {
        assert!(!row.1);
        assert!(whole.contains(row), "{row:?} differs from the whole plan");
    }
}

/// A row's span carries its table's columns and the delimiter's alignments, so a window whose
/// projection holds the header or the delimiter plans the whole table (and the delimiter span).
#[test]
fn a_window_on_the_header_or_delimiter_plans_the_whole_table() {
    let source = numbered_table();
    let (whole, _) = table_rows(&source, None);
    for window in [("head", "head"), ("--- |", "--- |"), ("head", "r02")] {
        let (rows, delimiters) = table_rows(&source, Some(window));
        assert_eq!(rows, whole, "{window:?}");
        assert_eq!(delimiters, 1, "{window:?}");
    }
    let (rows, _) = table_rows(&source, Some(("after", "after")));
    assert!(rows.is_empty());
}

/// A `|` alone is a body row (the table runs to the last nonblank line) with no cells yet: the
/// host draws an empty grid row, not raw text inside the grid.
#[test]
fn a_lone_pipe_row_plans_as_an_empty_grid_row() {
    let source = "| a | b |\n| - | - |\n| x | y |\n|\n| z | w |\n";
    let (rows, _) = table_rows(source, None);
    let texts: Vec<_> = rows.iter().map(|r| r.0.as_str()).collect();
    assert_eq!(texts, ["| a | b |", "| x | y |", "|", "| z | w |"]);
    let session = EditorSession::open(source);
    let display = session.display_text();
    let spans = planned(
        &session,
        DisplayRange {
            start: DisplayOffset(0),
            end: DisplayOffset(display.len()),
        },
    );
    let empty: Vec<_> = spans
        .iter()
        .filter_map(|s| match s {
            StyleSpec::TableRow { cells, columns, .. } if cells.is_empty() => Some(*columns),
            _ => None,
        })
        .collect();
    assert_eq!(empty, [2]);
}
