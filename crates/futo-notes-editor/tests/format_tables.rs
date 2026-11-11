//! Bold, Italic, Strike and Code over a table format each cell separately and
//! leave the table the same table (#361): the body walk must read every line
//! of a table as a table line, whatever the block walk makes of it (a
//! delimiter row starting `- `, a row without outer pipes).
use futo_notes_editor::{
    DisplayOffset, DisplayRange, EditorError, EditorSession, InlineFormat, Revision,
    TableDescription,
};

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

const TABLES: &[&str] = &[
    "| a | b |\n| --- | --- |\n| c | d |",
    "| a |\n| - |\n| b |",
    "a | b\n- | -\nc | d",
    "a | b\n--- | ---\nc | d",
    "a|b\n-|-\nc|d",
    "| a | b |\n| - | - |\n| c | d |",
    "| a | b |\n|:-:|--:|\n| c | d |",
    "| é | 😀 |\n| - | - |\n| x | 日 |",
    "| a | b |\r\n| - | - |\r\n| c | d |",
];
const FORMATS: [InlineFormat; 4] = [
    InlineFormat::Bold,
    InlineFormat::Italic,
    InlineFormat::Strike,
    InlineFormat::Code,
];

/// The grid as display text per cell, and the source of the delimiter line.
fn shape(s: &EditorSession) -> Vec<Vec<Vec<String>>> {
    let display = s.display_text();
    s.inspect_tables(s.revision(), range(0, display.len()))
        .unwrap()
        .iter()
        .map(|t: &TableDescription| {
            t.rows
                .iter()
                .map(|row| {
                    row.iter()
                        .map(|c| display[c.content.start.0..c.content.end.0].to_owned())
                        .collect()
                })
                .collect()
        })
        .collect()
}

/// Source lines with every marker character stripped from cells: pipes and
/// line count per line must be untouched.
fn pipes(source: &str) -> Vec<usize> {
    source.lines().map(|l| l.matches('|').count()).collect()
}

fn selections(original: &str) -> Vec<(String, DisplayRange)> {
    let s = EditorSession::open(original);
    let table = s
        .inspect_tables(s.revision(), range(0, s.display_text().len()))
        .unwrap()
        .remove(0);
    let (rows, cols) = (table.rows.len(), table.rows[0].len());
    let first = table.rows[0][0].content;
    let last = table.rows[rows - 1][cols - 1].content;
    let mut out = vec![
        ("inside one cell".to_owned(), table.rows[0][0].content),
        (
            "across cells".to_owned(),
            range(first.start.0, table.rows[0][cols - 1].content.end.0),
        ),
        ("across rows".to_owned(), range(first.start.0, last.end.0)),
        ("whole table".to_owned(), range(0, s.display_text().len())),
    ];
    let delimiter = table.delimiter_line.unwrap();
    out.push((
        "ending inside the delimiter row".to_owned(),
        range(first.start.0, delimiter.start.0 + 2),
    ));
    out.push((
        "starting inside the delimiter row".to_owned(),
        range(delimiter.end.0 - 2, last.end.0),
    ));
    out.push(("first pipe only".to_owned(), range(0, 1)));
    if cols > 1 {
        out.push((
            "last cell of a row to next row".to_owned(),
            range(
                table.rows[0][cols - 1].content.start.0,
                table.rows[1][0].content.end.0,
            ),
        ));
    }
    out
}

fn toggle(s: &mut EditorSession, format: InlineFormat) -> bool {
    let rev: Revision = s.revision();
    // A refusal is `Ok(None)` or `UnrepresentableFormat`; both leave the note as it was.
    match s.toggle_format(rev, format, &mut |_| Ok(())) {
        Ok(change) => change.is_some(),
        Err(EditorError::UnrepresentableFormat) => false,
        Err(error) => panic!("{error:?}"),
    }
}

/// Run `case`, collecting its panic message instead of stopping.
fn collect(failures: &mut Vec<String>, case: impl FnOnce() + std::panic::UnwindSafe) {
    if let Err(payload) = std::panic::catch_unwind(case) {
        failures.push(
            payload
                .downcast_ref::<String>()
                .cloned()
                .unwrap_or_else(|| "panic".to_owned()),
        );
    }
}

fn check(original: &str, failures: &mut Vec<String>) {
    for (name, selection) in selections(original) {
        for format in FORMATS {
            collect(failures, || check_one(original, &name, selection, format));
        }
    }
}

fn check_one(original: &str, name: &str, selection: DisplayRange, format: InlineFormat) {
    let ctx = format!("{original:?} {name} {selection:?} {format:?}");
    let mut s = EditorSession::open(original);
    let (display, grid) = (s.display_text().to_owned(), shape(&s));
    s.select(s.revision(), selection).unwrap();
    if !toggle(&mut s, format) {
        return;
    }
    let on = s.source_text();
    assert_ne!(on, original, "{ctx}: accepted but wrote nothing");
    assert_eq!(s.display_text(), display, "{ctx}: display changed");
    assert_eq!(shape(&s), grid, "{ctx}: grid changed: {on:?}");
    assert_eq!(pipes(&on), pipes(original), "{ctx}: pipes moved: {on:?}");
    // Reopened from the written source it is the same table too.
    let again = EditorSession::open(&on);
    assert_eq!(
        again.display_text(),
        display,
        "{ctx}: reopen display {on:?}"
    );
    assert_eq!(shape(&again), grid, "{ctx}: reopen grid {on:?}");
    // The delimiter row is never touched.
    assert_eq!(
        on.lines().nth(1),
        original.lines().nth(1),
        "{ctx}: delimiter {on:?}"
    );
    // Off restores the source.
    assert!(toggle(&mut s, format), "{ctx}: off refused");
    assert_eq!(s.source_text(), original, "{ctx}: off");
}

#[test]
fn toggles_over_a_table_format_each_cell_and_keep_the_table() {
    let mut failures = Vec::new();
    for table in TABLES {
        check(table, &mut failures);
    }
    assert!(
        failures.is_empty(),
        "{} failures:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

fn from_before(original: &str, selection_start: usize, format: InlineFormat) {
    let s = EditorSession::open(original);
    let grid = shape(&s);
    let end = s
        .inspect_tables(s.revision(), range(0, s.display_text().len()))
        .unwrap()
        .remove(0)
        .rows[0][0]
        .content
        .end
        .0;
    let ctx = format!("{original:?} {format:?}");
    let mut s = EditorSession::open(original);
    let display = s.display_text().to_owned();
    s.select(s.revision(), range(selection_start, end)).unwrap();
    if !toggle(&mut s, format) {
        return;
    }
    let on = s.source_text();
    assert_eq!(s.display_text(), display, "{ctx}: display {on:?}");
    assert_eq!(shape(&s), grid, "{ctx}: grid {on:?}");
    assert_eq!(pipes(&on), pipes(original), "{ctx}: pipes {on:?}");
    assert_eq!(
        on.lines().last(),
        original.lines().last(),
        "{ctx}: last row {on:?}"
    );
}

#[test]
fn toggles_from_text_before_a_table_into_it() {
    let mut failures = Vec::new();
    for table in TABLES {
        for prefix in ["intro text\n\n", "intro text\n"] {
            let original = format!("{prefix}{table}");
            for format in FORMATS {
                collect(&mut failures, || from_before(&original, 2, format));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} failures:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn issue_repro_pipeless_table_select_all_bold() {
    let mut s = EditorSession::open("a | b\n- | -\nc | d");
    s.select(s.revision(), range(0, s.display_text().len()))
        .unwrap();
    assert!(toggle(&mut s, InlineFormat::Bold));
    assert_eq!(s.source_text(), "**a** | **b**\n- | -\n**c** | **d**");
}

#[test]
fn issue_repro_piped_table_selection_into_the_delimiter_row() {
    let mut s = EditorSession::open("| a |\n| - |\n| b |");
    s.select(s.revision(), range(2, 8)).unwrap();
    assert!(toggle(&mut s, InlineFormat::Bold));
    assert_eq!(s.source_text(), "| **a** |\n| - |\n| b |");
}

#[test]
fn issue_repro_pipe_only_selection_writes_nothing() {
    let mut s = EditorSession::open("| a |\n| - |\n| b |");
    s.select(s.revision(), range(0, 1)).unwrap();
    assert!(!toggle(&mut s, InlineFormat::Bold));
    assert_eq!(s.source_text(), "| a |\n| - |\n| b |");
}

fn link(original: &str, selection: DisplayRange) -> (Option<()>, String) {
    let mut s = EditorSession::open(original);
    s.select(s.revision(), selection).unwrap();
    let done = s
        .set_link(s.revision(), selection, "/u", &mut |_| Ok(()))
        .ok()
        .flatten()
        .map(|_| ());
    (done, s.source_text())
}

#[test]
fn set_link_inside_one_cell_of_a_pipeless_table() {
    let (done, on) = link("a | b\n- | -\nc | d", range(10, 11));
    assert!(done.is_some());
    assert_eq!(on, "a | b\n- | -\n[c](</u>) | d");
}

#[test]
fn set_link_from_a_pipeless_row_into_the_next_row_links_each_cell() {
    // Both `b` and `c` are rows of the table: one link per cell, never `[b\nc](/u)`.
    let (done, on) = link("| a |\n| - |\nb\nc\n", range(12, 15));
    assert!(done.is_some());
    assert_eq!(on, "| a |\n| - |\n[b](</u>)\n[c](</u>)\n");
}

#[test]
fn toggles_starting_at_a_pipeless_data_row_and_with_text_after() {
    for original in [
        "| a |\n| - |\nb\nc\n",
        "a | b\n- | -\nc\nd | e",
        "a | b\n- | -\nc | d\n\nafter | text",
        "x | y\n\na | b\n- | -\nc",
    ] {
        let s = EditorSession::open(original);
        let (grid, display) = (shape(&s), s.display_text().to_owned());
        for format in FORMATS {
            for start in 0..display.len() {
                for end in (start + 1)..=display.len() {
                    if !display.is_char_boundary(start) || !display.is_char_boundary(end) {
                        continue;
                    }
                    let mut s = EditorSession::open(original);
                    s.select(s.revision(), range(start, end)).unwrap();
                    if !toggle(&mut s, format) {
                        continue;
                    }
                    let on = s.source_text();
                    let again = EditorSession::open(&on);
                    assert_eq!(
                        again.display_text(),
                        display,
                        "{original:?} {start}..{end} {format:?}: {on:?}"
                    );
                    assert_eq!(
                        shape(&again),
                        grid,
                        "{original:?} {start}..{end} {format:?}: {on:?}"
                    );
                    assert_eq!(
                        pipes(&on),
                        pipes(original),
                        "{original:?} {start}..{end} {format:?}: {on:?}"
                    );
                }
            }
        }
    }
}

/// A format run that spans a cell pipe, taken off cell by cell, never leaves
/// markers around a lone pipe: the table keeps its grid or the toggle refuses.
#[test]
fn taking_off_a_run_that_spans_a_pipe_never_wraps_the_pipe() {
    for (original, start, end) in [
        ("a | b\n- | -\n*c | d*", 10, 15),
        ("a | b\n--- | ---\n*c | d*", 14, 19),
        ("| a | b |\n| - | - |\n| *c | d* |", 24, 29),
        ("| a | b |\n|---|---|\n| *c | d* |", 24, 29),
        ("a|b\n-|-\n*c|d*", 8, 11),
    ] {
        {
            let format = InlineFormat::Italic;
            let mut s = EditorSession::open(original);
            let (display, grid) = (s.display_text().to_owned(), shape(&s));
            s.select(s.revision(), range(start, end)).unwrap();
            toggle(&mut s, format);
            let on = s.source_text();
            assert!(!on.contains("*|*"), "{original:?}: {on:?}");
            assert_eq!(s.display_text(), display, "{original:?}: {on:?}");
            assert_eq!(
                shape(&EditorSession::open(&on)),
                grid,
                "{original:?}: {on:?}"
            );
        }
    }
}

fn big_table(rows: usize) -> String {
    let mut source = String::from("a | b\n- | -\n");
    for i in 0..rows {
        source.push_str(&format!("c{i} | d{i}\n"));
    }
    source
}

#[test]
fn a_modest_table_formats_whole_and_a_huge_one_is_refused_fast() {
    let select_all = |rows| {
        let mut s = EditorSession::open(&big_table(rows));
        let all = range(0, s.display_text().len());
        s.select(s.revision(), all).unwrap();
        let rev = s.revision();
        let result = s.toggle_format(rev, InlineFormat::Bold, &mut |_| Ok(()));
        (s, result)
    };
    let (s, result) = select_all(40);
    let change = result.unwrap().unwrap();
    assert_eq!(s.source_text().matches("**").count(), 2 * 82);
    // The staged toggle spends well inside its work budget.
    assert!(
        change.work.link_metadata_items < 8_000_000,
        "{:?}",
        change.work
    );
    // A table far past the budget is refused rather than frozen on: nothing
    // is written and nothing is recorded.
    let (s, result) = select_all(2_000);
    assert!(
        matches!(result, Err(EditorError::UnrepresentableFormat)),
        "{result:?}"
    );
    assert_eq!(s.source_text(), big_table(2_000));
    assert_eq!(s.revision(), Revision(0));
}
