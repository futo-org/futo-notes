use futo_notes_editor::{DisplayOffset, DisplayRange, EditorSession, Revision};

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

/// Hosts that lay out one line per row take its display extent from the engine.
#[test]
fn tables_report_each_row_line_and_the_delimiter_in_display_coordinates() {
    let session = EditorSession::open("| **a** | b\\|c |\n|:--|--:|\n| x |\n\npara\n");
    let table = session
        .inspect_table(Revision(0), range(0, 0))
        .unwrap()
        .unwrap();
    let display = session.display_text();
    let lines: Vec<&str> = table
        .row_lines
        .iter()
        .map(|line| &display[line.start.0..line.end.0])
        .collect();
    assert_eq!(lines, vec!["| a | b|c |", "| x |"]);
    let delimiter = table.delimiter_line.unwrap();
    assert_eq!(&display[delimiter.start.0..delimiter.end.0], "|:--|--:|");
}
