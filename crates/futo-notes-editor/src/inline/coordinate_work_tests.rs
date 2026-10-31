//! Primitive indexed-node ledger reached only through public session actions.
use std::cell::{Cell, RefCell};
thread_local! {
    static BARE_VISITS: Cell<usize> = const { Cell::new(0) };
    static BARE_QUERIES: RefCell<Vec<(usize, usize, usize)>> = const { RefCell::new(Vec::new()) };
    static BOUNDS: Cell<(usize, usize)> = const { Cell::new((0, 0)) };
    static CAPTURE_BOUNDS: RefCell<Vec<(usize, usize)>> = const { RefCell::new(Vec::new()) };
    static VISITS: Cell<usize> = const { Cell::new(0) };
    static QUERIES: RefCell<Vec<(&'static str, usize, usize)>> = const { RefCell::new(Vec::new()) };
}
// Actual indexed comparisons/endpoints versus the previous inclusive run cost.
// Only source-selection capture owns this work in the link metric.
pub(super) fn bounds(actual: usize, previous: usize) {
    BOUNDS.with(|n| {
        let (a, p) = n.get();
        n.set((a + actual, p + previous));
    });
}
pub(super) fn bounds_before() -> (usize, usize) {
    BOUNDS.with(Cell::get)
}
pub(super) fn capture_bounds(before: (usize, usize)) {
    let after = bounds_before();
    CAPTURE_BOUNDS.with(|v| {
        v.borrow_mut()
            .push((after.0 - before.0, after.1 - before.1))
    });
}
pub(super) fn bounds_delta() -> isize {
    CAPTURE_BOUNDS.with(|v| {
        let rows = v.borrow();
        rows.iter()
            .map(|(actual, previous)| *actual as isize - *previous as isize)
            .sum()
    })
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

pub(super) fn reset() {
    BARE_QUERIES.with(|rows| rows.borrow_mut().clear());
    CAPTURE_BOUNDS.with(|rows| rows.borrow_mut().clear());
    QUERIES.with(|rows| rows.borrow_mut().clear());
}
pub(super) fn snapshot() -> Vec<(&'static str, usize, usize)> {
    QUERIES.with(|rows| rows.borrow().clone())
}
pub(super) fn bare_snapshot() -> Vec<(usize, usize, usize)> {
    BARE_QUERIES.with(|rows| rows.borrow().clone())
}
pub(super) fn added_nodes() -> usize {
    snapshot()
        .iter()
        .filter(|(name, _, _)| !name.ends_with("source_points.rs"))
        .map(|(_, actual, _)| actual)
        .sum()
}

#[test]
fn public_link_command_reports_its_final_selection_queries() {
    use crate::{DisplayOffset, DisplayRange, EditorSession, Revision};
    let mut session = EditorSession::open("__label__ rest");
    reset();
    let change = session
        .set_link(
            Revision(0),
            DisplayRange {
                start: DisplayOffset(0),
                end: DisplayOffset(5),
            },
            "/next",
            &mut |_| Ok(()),
        )
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text(), "[__label__](</next>) rest");
    assert_eq!(session.display_text(), "label rest");
    let queries = snapshot();
    let selected: Vec<_> = queries
        .iter()
        .filter(|(name, _, _)| name.ends_with("session/links.rs"))
        .collect();
    assert_eq!(
        selected.len(),
        2,
        "work={:?}; queries={queries:?}",
        change.work
    );
    assert_eq!(selected.iter().map(|(_, _, work)| work).sum::<usize>(), 16);
    assert_eq!(change.work.link_metadata_items, 288 + 16);
    assert_eq!(change.work.materialized_source_bytes, 73);
    assert_eq!(change.work.parsed_source_bytes, 75);
    assert_eq!(change.work.inserted_bytes, 20);
    assert_eq!(change.work.link_copied_bytes, 20);
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
    for (count, expected_nodes, expected_metadata) in [(20, 167, 561), (20_000, 400, 794)] {
        let text = "__word__ rest\r\n\r\n".repeat(count);
        let mut session = EditorSession::open(&text);
        let at = (count - 2) * "word rest\r\n\r\n".len() + 2;
        let range = DisplayRange {
            start: DisplayOffset(at),
            end: DisplayOffset(at),
        };
        session.select(Revision(0), range).unwrap();
        reset();
        VISITS.with(|n| n.set(0));
        let change = session
            .replace(Revision(0), range, "x", &mut |_| Ok(()))
            .unwrap();
        let queries = QUERIES.with(|rows| rows.borrow().clone());
        // General block display observations are outside this narrow link
        // metric. Every actual link query, including line-start eligibility,
        // and direct input target query belongs to the successful input ledger.
        let added: usize = queries
            .iter()
            .filter(|(name, _, _)| !name.ends_with(".rs") || name.ends_with("session/input.rs"))
            .map(|(_, actual, _)| actual)
            .sum();
        assert_eq!(added, expected_nodes, "{queries:?}");
        assert_eq!(change.work.link_metadata_items, expected_metadata);
        assert_eq!(bounds_delta(), 10);
        assert_eq!(
            (change.work.link_metadata_items - added)
                .checked_add_signed(-bounds_delta())
                .unwrap(),
            384
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

// Primitive post-parser stack operations. This extends the existing cfg-only
// ledger; it is independent of the primitive's returned work calculation.
pub(super) fn bare_visit() {
    BARE_VISITS.with(|n| n.set(n.get() + 1));
}
pub(super) fn bare_before() -> usize {
    BARE_VISITS.with(Cell::get)
}
pub(super) fn bare_query(before: usize, hints: usize, reported: usize) {
    BARE_QUERIES.with(|q| {
        q.borrow_mut()
            .push((hints, bare_before() - before, reported))
    });
}
#[test]
fn public_link_input_charges_the_actual_post_parser_node_and_child_walk() {
    use crate::{DisplayOffset, DisplayRange, EditorSession, Revision};
    let mut session = EditorSession::open("__label__ https://x.test");
    BARE_QUERIES.with(|q| q.borrow_mut().clear());
    let change = session
        .replace(
            Revision(0),
            DisplayRange {
                start: DisplayOffset(0),
                end: DisplayOffset(1),
            },
            "B",
            &mut |_| Ok(()),
        )
        .unwrap();
    assert_eq!(session.source_text(), "__Babel__ https://x.test");
    assert_eq!(session.display_text(), "Babel https://x.test");
    let queries = BARE_QUERIES.with(|q| q.borrow().clone());
    assert!(!queries.is_empty());
    // Independently observed old work was 73/120/1/477/56. Two calls each
    // add root/node/child12 + bounds/prefix3 + emitted records2; byte budgets
    // remain exact. This pins attribution, not parser CPU or allocations.
    assert_eq!(queries, vec![(16, 12, 33), (16, 12, 33)]);
    assert_eq!(change.work.materialized_source_bytes, 73);
    assert_eq!(change.work.parsed_source_bytes, 120);
    assert_eq!(change.work.inserted_bytes, 1);
    assert_eq!(change.work.link_copied_bytes, 56);
    assert_eq!(change.work.link_metadata_items, 477 + 2 * (12 + 3 + 2));
    for (hints, actual, reported) in &queries {
        assert!(*reported >= hints + actual, "bare consumer: hint={hints}; actual stack/node/child={actual}; reported={reported}; ledger={queries:?}; work={:?}", change.work);
    }
}
