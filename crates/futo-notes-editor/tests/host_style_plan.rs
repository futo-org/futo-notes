use futo_notes_editor::host::{self, plan_styles, DisplayMirror, ListMarker, StyleSpec};
use futo_notes_editor::*;

fn plan(source: &str) -> (String, Vec<StyleSpec>) {
    let session = EditorSession::open(source);
    let display = session.display_text();
    let slice = session
        .project(
            session.revision(),
            DisplayRange {
                start: DisplayOffset(0),
                end: DisplayOffset(display.len()),
            },
        )
        .unwrap();
    let mirror = DisplayMirror::new(&display);
    let spans = plan_styles(&slice, 0, &mut |b| mirror.byte_to_utf16(b).unwrap());
    (display, spans)
}

#[test]
fn headings_inline_formats_and_lists_are_planned_in_utf16() {
    let (display, spans) = plan("# 日本 **b**\n\n- one\n- [x] two\n\n> q\n");
    assert_eq!(display.lines().next(), Some("日本 b"));
    assert!(spans.contains(&StyleSpec::Heading {
        start: 0,
        end: 5,
        level: 1
    }));
    assert!(spans.iter().any(|s| matches!(
        s,
        StyleSpec::Inline {
            start: 3,
            end: 4,
            bold: true,
            ..
        }
    )));
    let rows: Vec<_> = spans
        .iter()
        .filter_map(|s| match s {
            StyleSpec::ListRow {
                marker,
                checked,
                first: true,
                ..
            } => Some((*marker, *checked, true)),
            _ => None,
        })
        .collect();
    assert_eq!(
        rows,
        vec![
            (ListMarker::Bullet, false, true),
            (ListMarker::Task, true, true)
        ]
    );
    assert!(spans
        .iter()
        .any(|s| matches!(s, StyleSpec::Quote { depth: 1, .. })));
}

#[test]
fn no_span_crosses_a_line() {
    let (display, spans) = plan("> a\n> b\n> c\n");
    let units: Vec<u16> = display.encode_utf16().collect();
    for s in spans {
        let (start, end) = s.range();
        let inside = &units[start..end.saturating_sub(1).max(start)];
        assert!(
            !inside.contains(&10),
            "{s:?} spans a line end in {display:?}"
        );
    }
}

#[test]
fn a_window_planned_with_its_own_offset_matches_the_whole() {
    let source = "intro 日本\n\n## Head\n\ntail **bold**\n";
    let session = EditorSession::open(source);
    let display = session.display_text();
    let mirror = DisplayMirror::new(&display);
    let from = display
        .find("## ")
        .map_or(display.find("Head").unwrap(), |i| i);
    let slice = session
        .project(
            session.revision(),
            DisplayRange {
                start: DisplayOffset(from),
                end: DisplayOffset(display.len()),
            },
        )
        .unwrap();
    let start16 = mirror.byte_to_utf16(from).unwrap();
    let windowed = plan_styles(&slice, start16, &mut |b| mirror.byte_to_utf16(b).unwrap());
    let (_, whole) = plan(source);
    for w in windowed {
        assert!(
            whole.contains(&w),
            "{w:?} missing from the whole plan {whole:?}"
        );
    }
}

#[test]
fn an_image_is_one_unbroken_span_with_the_engines_classification() {
    let (display, spans) = plan("日本 ![a b](pic 1.png) x ![](https://e.com/p.png)\n![](my.png)\n");
    let units: Vec<u16> = display.encode_utf16().collect();
    let text = |s: usize, e: usize| String::from_utf16(&units[s..e]).unwrap();
    let images: Vec<_> = spans
        .iter()
        .filter_map(|s| match s {
            StyleSpec::Image {
                start,
                end,
                destination,
                alt,
                vault,
                remote,
            } => Some((
                text(*start, *end),
                destination.clone(),
                alt.clone(),
                *vault,
                *remote,
            )),
            _ => None,
        })
        .collect();
    assert_eq!(images.len(), 2, "{spans:?}");
    // `pic 1.png` has a space, so only the angle spelling is an image; the bare one is text.
    assert_eq!(
        images[0],
        (
            "![](https://e.com/p.png)".into(),
            "https://e.com/p.png".into(),
            "".into(),
            false,
            true
        )
    );
    assert_eq!(
        images[1],
        (
            "![](my.png)".into(),
            "my.png".into(),
            "".into(),
            true,
            false
        )
    );
}

#[test]
fn an_image_atom_stays_whole_when_split_at_lines() {
    let (_, spans) = plan("a ![alt](x.png) b\nsecond\n");
    let image: Vec<_> = spans
        .iter()
        .filter(|s| matches!(s, StyleSpec::Image { .. }))
        .collect();
    assert_eq!(image.len(), 1);
    assert_eq!(image[0].range(), (2, 15));
}

#[test]
fn tables_plan_as_whole_row_spans_with_cell_ranges_and_a_delimiter() {
    let source = "intro\n\n| 日本 | b |\n|:--|--:|\n| x | y |\n\nafter\n";
    let session = EditorSession::open(source);
    let display = session.display_text();
    let mirror = DisplayMirror::new(&display);
    let end = display.len();
    let range = DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(end),
    };
    let tables = session.inspect_tables(session.revision(), range).unwrap();
    assert_eq!(tables.len(), 1);
    let spans = host::plan_tables(&tables, range, &mut |b| mirror.byte_to_utf16(b).unwrap());
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
}

/// `(row text, header, table_start)` of each planned row and the delimiter count, for the
/// tables whose lines meet `window` (display bytes of `needle` through `until`).
fn table_rows(source: &str, window: Option<(&str, &str)>) -> (Vec<(String, bool, usize)>, usize) {
    let session = EditorSession::open(source);
    let display = session.display_text();
    let mirror = DisplayMirror::new(&display);
    let whole = DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(display.len()),
    };
    let window = window.map_or(whole, |(from, until)| DisplayRange {
        start: DisplayOffset(display.find(from).unwrap()),
        end: DisplayOffset(display.find(until).unwrap()),
    });
    let tables = session.inspect_tables(session.revision(), window).unwrap();
    let spans = host::plan_tables(&tables, window, &mut |b| mirror.byte_to_utf16(b).unwrap());
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

/// The header fixes every row's column count and the delimiter its alignments, so a window that
/// meets either plans the whole table (and the delimiter span).
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
    let mirror = DisplayMirror::new(&display);
    let tables = session
        .inspect_tables(
            session.revision(),
            DisplayRange {
                start: DisplayOffset(0),
                end: DisplayOffset(display.len()),
            },
        )
        .unwrap();
    let spans = host::plan_tables(
        &tables,
        DisplayRange {
            start: DisplayOffset(0),
            end: DisplayOffset(display.len()),
        },
        &mut |b| mirror.byte_to_utf16(b).unwrap(),
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
