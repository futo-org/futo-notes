use futo_notes_editor::{DisplayOffset, DisplayRange, EditorSession};

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

#[test]
fn inspect_tables_lists_every_table_in_a_range_in_one_call() {
    let raw = "- item\n- item\n\nintro\n\n| a | b |\n| --- | --- |\n| c | d |\n\n- tail\n\n| x |\n| - |\n| y |\n";
    let session = EditorSession::open(raw);
    let end = session.display_text().len();
    let all = session
        .inspect_tables(session.revision(), range(0, end))
        .unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!((all[0].columns, all[0].rows.len()), (2, 2));
    assert_eq!((all[1].columns, all[1].rows.len()), (1, 2));
    // Exactly what a per-block inspect_table sweep finds.
    let swept = session
        .project(session.revision(), range(0, end))
        .unwrap()
        .blocks
        .iter()
        .filter_map(|b| session.inspect_table(session.revision(), b.range).unwrap())
        .map(|t| t.display)
        .fold(Vec::new(), |mut out: Vec<DisplayRange>, d| {
            if !out.contains(&d) {
                out.push(d);
            }
            out
        });
    assert_eq!(all.iter().map(|t| t.display).collect::<Vec<_>>(), swept);
    let plain = EditorSession::open("- a\n- b\n");
    let end = plain.display_text().len();
    assert!(plain
        .inspect_tables(plain.revision(), range(0, end))
        .unwrap()
        .is_empty());
}
