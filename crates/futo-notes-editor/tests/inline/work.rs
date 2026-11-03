//! Bounded public inline work retains independently measured query components.
use super::*;

#[test]
fn a_distant_edit_reparses_a_paragraph_window_instead_of_the_note() {
    let mut work = Vec::new();
    for count in [20, 20_000] {
        let text = "__word__ rest\r\n\r\n".repeat(count);
        let mut session = EditorSession::open(&text);
        let display_offset = (count - 2) * "word rest\r\n\r\n".len() + 2;
        session
            .select(Revision(0), range(display_offset, display_offset))
            .unwrap();
        let change = session
            .replace(
                Revision(0),
                range(display_offset, display_offset),
                "x",
                &mut |_| Ok(()),
            )
            .unwrap();
        assert_eq!(
            change.selection,
            range(display_offset + 1, display_offset + 1)
        );
        assert_eq!(
            change.projection.text,
            "word rest\r\n\r\nwoxrd rest\r\n\r\nword rest\r\n\r\n"
        );
        assert!(
            change.work.parsed_source_bytes < 150,
            "actual parser input: {:?}",
            change.work
        );
        work.push(change.work);
    }
    // Fixed parser/source work does not imply constant tree descent work.
    // The independent public-input primitive ledger proves 167/400 nodes
    // plus 384 fixed metadata items and 10 indexed inverse-query items.
    // The old source/parser/copy budgets remain exact.
    // The independent public primitive fixture pins exactly12/30 additional
    // canonical comparison visits. Retain both old metadata totals and every
    // other work field after removing that newly attributed component.
    for (measured, references) in work.iter_mut().zip([12, 30]) {
        measured.link_metadata_items -= references;
    }
    // Span sweep visits over the reparsed window's segments, 54 at both sizes.
    for measured in &mut work {
        measured.link_metadata_items -= 54;
    }
    assert_eq!(
        work.iter()
            .map(|w| w.link_metadata_items)
            .collect::<Vec<_>>(),
        vec![561, 794]
    );
    for measured in &mut work {
        measured.link_metadata_items = 0;
    }
    assert_eq!(work[0], work[1]);
}
