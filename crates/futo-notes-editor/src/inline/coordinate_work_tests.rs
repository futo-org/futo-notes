//! Primitive indexed-node ledger reached only through public session actions.
use std::cell::{Cell, RefCell};
thread_local! {
    static VISITS: Cell<usize> = const { Cell::new(0) };
    static QUERIES: RefCell<Vec<(&'static str, usize, usize)>> = const { RefCell::new(Vec::new()) };
}
pub(super) fn visit() {
    VISITS.with(|n| n.set(n.get() + 1));
}
pub(super) fn visits() -> usize {
    VISITS.with(Cell::get)
}
pub(super) fn query(name: &'static str, before: usize, reported: usize) {
    QUERIES.with(|rows| rows.borrow_mut().push((name, visits() - before, reported)));
}

#[test]
fn public_reference_commands_charge_actual_indexed_coordinate_queries() {
    use crate::{BlockCommand, DisplayOffset, DisplayRange, EditorSession, Revision};
    for paragraphs in [20, 200, 2000] {
        let prefix = "unrelated\n\n".repeat(paragraphs);
        let source = format!("{prefix}[id]: /target extra\n\n[one][id]");
        let mut session = EditorSession::open(&source);
        QUERIES.with(|rows| rows.borrow_mut().clear());
        let at = prefix.len() + 13;
        let change = session
            .block_command(
                Revision(0),
                DisplayRange {
                    start: DisplayOffset(at),
                    end: DisplayOffset(at),
                },
                BlockCommand::Divider,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap();
        assert_eq!(
            session.source_text(),
            format!("{prefix}\\[id]: /target\n***\n\n extra\n\n[one][id]")
        );
        let queries = QUERIES.with(|rows| rows.borrow().clone());
        assert!(!queries.is_empty());
        for (name, actual, reported) in &queries {
            assert!(*reported >= *actual,
                "{name}: actual indexed visits={actual}, reported query work={reported}; paragraphs={paragraphs}; ledger={queries:?}");
        }
        let actual: usize = queries.iter().map(|(_, actual, _)| actual).sum();
        assert!(
            change.work.link_metadata_items >= actual,
            "{:?}, {queries:?}",
            change.work
        );
    }
}

#[test]
fn public_distant_input_exposes_its_actual_query_ledger() {
    use crate::{DisplayOffset, DisplayRange, EditorSession, Revision};
    for count in [20, 20_000] {
        let text = "__word__ rest\r\n\r\n".repeat(count);
        let mut session = EditorSession::open(&text);
        let at = (count - 2) * "word rest\r\n\r\n".len() + 2;
        let range = DisplayRange {
            start: DisplayOffset(at),
            end: DisplayOffset(at),
        };
        session.select(Revision(0), range).unwrap();
        QUERIES.with(|rows| rows.borrow_mut().clear());
        VISITS.with(|n| n.set(0));
        let change = session
            .replace(Revision(0), range, "x", &mut |_| Ok(()))
            .unwrap();
        let queries = QUERIES.with(|rows| rows.borrow().clone());
        eprintln!(
            "COUNT={count}; metadata={}; allnodes={}; coordinate_queries={queries:?}",
            change.work.link_metadata_items,
            visits()
        );
        assert_eq!(change.work.materialized_source_bytes, 87);
        assert_eq!(change.work.parsed_source_bytes, 122);
        assert_eq!(change.work.inserted_bytes, 1);
        assert_eq!(change.work.link_copied_bytes, 0);
        for (_, actual, reported) in queries {
            assert!(reported >= actual);
        }
    }
}
