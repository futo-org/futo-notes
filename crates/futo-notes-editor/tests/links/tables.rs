//! A link command never damages a table: a selection inside one cell links it
//! there, a selection across cells links each cell it touches (the way the
//! inline format toggles treat it), and a range outside every cell links
//! nothing. Display offsets include the pipes and the delimiter row.
use super::*;

const URL: &str = "https://x.y";
const ONE: &str = "| a |\n| - |\n| b |";
const TWO: &str = "| a | b |\n| - | - |\n| c | d |\n";
const NOTE: &str = "intro\n\n| a |\n| - |\n| b |\n\nafter\n";

fn link(source: &str, at: (usize, usize)) -> (EditorSession, bool) {
    let mut session = EditorSession::open(source);
    let at = range(at.0, at.1);
    session.select(Revision(0), at).unwrap();
    let changed = session
        .set_link(Revision(0), at, URL, &mut |_| Ok(()))
        .unwrap()
        .is_some();
    (session, changed)
}

/// The cells' display text, row by row, and how many tables the note has.
fn shape(session: &EditorSession) -> (Vec<Vec<String>>, usize) {
    let display = session.display_text();
    let tables = session
        .inspect_tables(session.revision(), range(0, display.len()))
        .unwrap();
    let cells = tables
        .iter()
        .flat_map(|table| &table.rows)
        .map(|row| {
            row.iter()
                .map(|cell| display[cell.content.start.0..cell.content.end.0].to_owned())
                .collect()
        })
        .collect();
    (cells, tables.len())
}

/// The command is accepted, leaves the table's rows and cells and the display
/// text as they were, and Undo restores the source.
fn assert_links(source: &str, at: (usize, usize), expected: &str) {
    let before = EditorSession::open(source);
    let (mut session, changed) = link(source, at);
    assert!(changed, "{source:?} {at:?}");
    assert_eq!(session.source_text(), expected, "{source:?} {at:?}");
    assert_eq!(shape(&session), shape(&before), "{source:?} {at:?}");
    assert_eq!(session.display_text(), before.display_text());
    session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(session.source_text(), source);
}

/// The command changes nothing: no source change, no history.
fn assert_refused(source: &str, at: (usize, usize)) {
    let (session, changed) = link(source, at);
    assert!(!changed, "{source:?} {at:?}");
    assert_eq!(session.source_text(), source, "{source:?} {at:?}");
    assert_eq!(session.revision(), Revision(0));
}

#[test]
fn a_link_inside_one_cell_stays_in_the_cell() {
    assert_links(ONE, (2, 3), "| [a](<https://x.y>) |\n| - |\n| b |");
    assert_links(
        TWO,
        (6, 7),
        "| a | [b](<https://x.y>) |\n| - | - |\n| c | d |\n",
    );
}

#[test]
fn a_link_at_a_caret_in_a_cell_inserts_the_destination_there() {
    let (session, changed) = link(ONE, (3, 3));
    assert!(changed);
    assert_eq!(
        session.source_text(),
        "| a[https://x.y](<https://x.y>) |\n| - |\n| b |"
    );
    assert_eq!(
        shape(&session),
        (vec![vec!["ahttps://x.y".into()], vec!["b".into()]], 1)
    );
}

#[test]
fn a_link_over_the_whole_table_links_each_cell() {
    assert_links(
        ONE,
        (0, 17),
        "| [a](<https://x.y>) |\n| - |\n| [b](<https://x.y>) |",
    );
    assert_links(
        TWO,
        (0, 29),
        "| [a](<https://x.y>) | [b](<https://x.y>) |\n| - | - |\n\
         | [c](<https://x.y>) | [d](<https://x.y>) |\n",
    );
}

#[test]
fn a_link_across_cells_of_a_row_or_across_rows_links_each_cell() {
    assert_links(
        TWO,
        (2, 7),
        "| [a](<https://x.y>) | [b](<https://x.y>) |\n| - | - |\n| c | d |\n",
    );
    assert_links(
        ONE,
        (2, 15),
        "| [a](<https://x.y>) |\n| - |\n| [b](<https://x.y>) |",
    );
    // Ending in the delimiter row reaches only the cell it starts in.
    assert_links(ONE, (2, 8), "| [a](<https://x.y>) |\n| - |\n| b |");
}

#[test]
fn a_link_from_a_paragraph_into_a_cell_or_back_leaves_the_table_intact() {
    assert_links(
        NOTE,
        (2, 10),
        "in[tro](<https://x.y>)\n\n| [a](<https://x.y>) |\n| - |\n| b |\n\nafter\n",
    );
    assert_links(
        NOTE,
        (21, 29),
        "intro\n\n| a |\n| - |\n| [b](<https://x.y>) |\n\n[aft](<https://x.y>)er\n",
    );
    assert_links(
        NOTE,
        (0, 31),
        "[intro](<https://x.y>)\n\n| [a](<https://x.y>) |\n| - |\n| [b](<https://x.y>) |\n\n\
         [after](<https://x.y>)\n",
    );
}

#[test]
fn a_link_over_pipes_the_delimiter_row_or_outside_a_cell_changes_nothing() {
    for at in [(0, 1), (8, 9), (0, 0), (8, 8), (5, 5), (6, 11)] {
        assert_refused(ONE, at);
    }
}

#[test]
fn a_destination_with_a_pipe_never_adds_a_cell() {
    let mut session = EditorSession::open(ONE);
    session.select(Revision(0), range(2, 3)).unwrap();
    let changed = session
        .set_link(Revision(0), range(2, 3), "https://x.y/a|b", &mut |_| Ok(()))
        .unwrap();
    assert!(changed.is_none());
    assert_eq!(session.source_text(), ONE);
    let mut session = EditorSession::open(ONE);
    session.select(Revision(0), range(2, 15)).unwrap();
    let changed = session
        .set_link(
            Revision(0),
            range(2, 15),
            "https://x.y/a|b",
            &mut |_| Ok(()),
        )
        .unwrap();
    assert!(changed.is_none());
    assert_eq!(session.source_text(), ONE);
}

#[test]
fn unlinking_across_cells_removes_each_cell_link() {
    let (mut session, _) = link(ONE, (0, 17));
    let linked = session.source_text();
    let at = range(0, session.display_text().len());
    session.select(session.revision(), at).unwrap();
    session
        .set_link(session.revision(), at, "", &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text(), ONE, "from {linked:?}");
}

#[test]
fn a_label_edit_across_cells_changes_nothing() {
    let mut session = EditorSession::open(ONE);
    session.select(Revision(0), range(2, 15)).unwrap();
    let changed = session
        .edit_link(Revision(0), range(2, 15), "zz", URL, &mut |_| Ok(()))
        .unwrap();
    assert!(changed.is_none());
    assert_eq!(session.source_text(), ONE);
}
