//! A key in a middle row of a giant table costs the same counted work at
//! 2,000 rows as at 100, even with emphasis literals (`_` in handles)
//! elsewhere in the table.
use futo_notes_editor::{DisplayOffset, DisplayRange, EditWork, EditorSession, ParagraphKey};

fn caret(at: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(at),
        end: DisplayOffset(at),
    }
}

/// A table of URL cells, the shape of the slow corpus note (06a6e2), with an
/// unpaired leading-`_` handle and, away from the middle, `_` handles that
/// pair across 14 rows.
fn table(rows: usize) -> String {
    let mut source = String::from("| Name | Site | Twitter |\n| --- | --- | --- |\n");
    for i in 0..rows {
        let handle = match (i, i % 500) {
            (7, _) | (_, 203) => format!("_duck{i}"),
            (_, 217) => format!("duck{i}_"),
            _ => format!("duck{i}"),
        };
        source += &format!(
            "| duck eggs {i} | https://duck{i}.example.com/notes/{i} | https://twitter.com/{handle} |\n"
        );
    }
    source
}

fn total(work: &EditWork) -> usize {
    work.materialized_source_bytes + work.parsed_source_bytes + work.link_metadata_items
}

/// The session's whole projection equals a fresh open of its source.
fn assert_fresh(session: &EditorSession, what: &str) {
    let fresh = EditorSession::open(&session.source_text());
    let whole = |s: &EditorSession| {
        let end = DisplayOffset(s.display_text().len());
        let range = DisplayRange {
            start: DisplayOffset(0),
            end,
        };
        s.project(s.revision(), range).unwrap()
    };
    let (mine, theirs) = (whole(session), whole(&fresh));
    assert_eq!(mine.text, theirs.text, "{what}: display");
    assert_eq!(mine.runs, theirs.runs, "{what}: formats");
    assert_eq!(mine.links, theirs.links, "{what}: links");
    assert_eq!(mine.blocks, theirs.blocks, "{what}: blocks");
    assert_eq!(
        mine.correspondence, theirs.correspondence,
        "{what}: correspondence"
    );
}

/// Type `x` and Backspace it at the end of the middle row's name, then Enter
/// at the end of that row's line.
fn keys(rows: usize) -> [EditWork; 3] {
    let source = table(rows);
    let needle = format!("duck eggs {}", rows / 2);
    let mut session = EditorSession::open(&source);
    let at = session.display_text().find(&format!("{needle} ")).unwrap() + needle.len();
    let typed = session
        .replace(session.revision(), caret(at), "x", &mut |_| Ok(()))
        .unwrap()
        .work;
    assert_eq!(
        session.source_text(),
        source.replacen(&format!("{needle} |"), &format!("{needle}x |"), 1)
    );
    let deleted = session
        .paragraph_key(
            session.revision(),
            caret(at + 1),
            ParagraphKey::Backspace,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap()
        .work;
    assert_eq!(session.source_text(), source);
    let line_end = at + session.display_text()[at..].find('\n').unwrap();
    let entered = session
        .paragraph_key(
            session.revision(),
            caret(line_end),
            ParagraphKey::Enter,
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap()
        .work;
    assert_ne!(session.source_text(), source);
    assert_fresh(&session, "after Enter");
    [typed, deleted, entered]
}

#[test]
fn keys_in_a_middle_table_row_do_not_scale_with_the_table() {
    let small = keys(100).map(|work| total(&work));
    assert!(small.iter().all(|work| *work < 64 * 1024), "{small:?}");
    let large = keys(2_000).map(|work| total(&work));
    for (key, (large, small)) in ["type", "backspace", "enter"]
        .iter()
        .zip(large.iter().zip(small))
    {
        assert!(
            *large <= small * 3 / 2 + 1024,
            "{key}: {small} at 100 rows, {large} at 2,000"
        );
    }
}

// Single-character rows need 2,000 rows to exceed the ordinary partition
// threshold. Compare 2,000 and 20,000 so both sides measure bounded neighbor
// work, rather than a whole tiny row against a split paragraph's neighbors.
#[test]
fn clearing_a_one_character_cell_is_bounded_to_the_row() {
    let cases = [("protected", "| x | y |\n", 2)];
    let work = |rows: usize, body: &str, column: usize| {
        let header = "| a | b |\n| --- | --- |\n";
        let source = format!("{header}{}", body.repeat(rows));
        let mut s = EditorSession::open(&source);
        let at = header.len() + body.len() * (rows / 2) + column;
        let selected = DisplayRange {
            start: futo_notes_editor::DisplayOffset(at),
            end: futo_notes_editor::DisplayOffset(at + 1),
        };
        s.select(s.revision(), selected).unwrap();
        let change = s
            .paragraph_key(s.revision(), selected, ParagraphKey::Backspace, &mut |_| {
                Ok(())
            })
            .unwrap()
            .unwrap();
        let table = s
            .inspect_table(s.revision(), s.selection())
            .unwrap()
            .unwrap();
        assert!(table.focus.is_some());
        change.work.materialized_source_bytes
            + change.work.parsed_source_bytes
            + change.work.link_metadata_items
    };
    let counts: Vec<_> = cases
        .into_iter()
        .map(|(name, body, at)| (name, work(2_000, body, at), work(20_000, body, at)))
        .collect();
    assert!(
        counts
            .iter()
            .all(|(_, small, large)| *large <= small * 3 / 2 + 1024),
        "{counts:?}"
    );
}

#[test]
fn clearing_a_plain_line_never_scans_a_long_non_table_prefix() {
    let work = |rows: usize, body: &str| {
        let prefix = "ordinary text\n";
        let source = format!("{prefix}{}", body.repeat(rows));
        let at = prefix.len() + body.len() * (rows / 2);
        let mut s = EditorSession::open(&source);
        let selected = DisplayRange {
            start: futo_notes_editor::DisplayOffset(at),
            end: futo_notes_editor::DisplayOffset(at + 1),
        };
        s.select(s.revision(), selected).unwrap();
        let change = s
            .paragraph_key(s.revision(), selected, ParagraphKey::Backspace, &mut |_| {
                Ok(())
            })
            .unwrap()
            .unwrap();
        let mut expected = source;
        expected.remove(at);
        assert_eq!(s.source_text(), expected);
        change.work.materialized_source_bytes
            + change.work.parsed_source_bytes
            + change.work.link_metadata_items
    };
    for body in ["x | y\n", "x\n"] {
        let (small, large) = (work(2_000, body), work(20_000, body));
        assert!(
            large <= small * 3 / 2 + 1024,
            "{body:?}: {small} -> {large}"
        );
    }
}
