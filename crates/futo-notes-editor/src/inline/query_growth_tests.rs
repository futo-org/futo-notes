//! Public growth fixtures with independent primitive-node attribution.
use super::coordinate_work_tests::{added_nodes, reset, snapshot};
use crate::{BlockCommand, DisplayOffset, DisplayRange, EditWork, EditorSession, Revision};
fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}
fn measured(work: EditWork) -> (EditWork, usize) {
    for (name, actual, reported) in snapshot() {
        assert!(
            reported >= actual,
            "{name}: actual nodes{actual}, reported{reported}"
        );
    }
    let nodes = added_nodes();
    let mut fixed = work;
    fixed.link_metadata_items = fixed
        .link_metadata_items
        .checked_sub(nodes)
        .unwrap_or_else(|| panic!("work={work:?}; nodes={nodes}; ledger={:?}", snapshot()));
    (fixed, nodes)
}
#[test]
fn public_growth_work_separates_actual_index_visits_from_retained_local_work() {
    for growing in ["definitions", "uses", "tail"] {
        let mut results = Vec::new();
        for (index, count) in [20, 200].into_iter().enumerate() {
            let tail = match growing {
                "definitions" => (0..count)
                    .map(|i| format!("[unused{i}]: https://unused.test/{i}\n\n"))
                    .collect::<String>(),
                "uses" => "[other][focus]\n\n".repeat(count),
                _ => "distant body\n\n".repeat(count),
            };
            let source =
                format!("[teh][focus]\n\nbody\n\n{tail}[focus]: https://x.test \"Title\"\n\nend");
            let mut session = EditorSession::open(&source);
            reset();
            let label = session
                .replace(Revision(0), range(0, 3), "the", &mut |_| Ok(()))
                .unwrap();
            let label = measured(label.work);
            reset();
            let body = session
                .replace(Revision(1), range(5, 9), "BODY", &mut |_| Ok(()))
                .unwrap();
            let body = measured(body.work);
            let expected_nodes = if growing == "uses" {
                [(99, 125), (183, 206)]
            } else {
                [(91, 119), (173, 188)]
            };
            assert_eq!((label.1, body.1), expected_nodes[index]);
            results.push((label.0, body.0));
        }
        assert_eq!(results[0], results[1], "{growing}");
    }
}
#[test]
fn public_structural_growth_work_retains_the_original_fixed_work_budget() {
    for command in [BlockCommand::Heading(0), BlockCommand::Divider] {
        let mut results = Vec::new();
        for (index, count) in [20, 200, 2000].into_iter().enumerate() {
            let head = if matches!(command, BlockCommand::Divider) {
                "alpha beta"
            } else {
                "# body"
            };
            let source = format!(
                "{head}\n\nbuffer\n\n{}[keep]: /kept 'T'",
                "[other][keep]\n\n".repeat(count)
            );
            let mut session = EditorSession::open(&source);
            reset();
            let at = if matches!(command, BlockCommand::Divider) {
                6
            } else {
                2
            };
            let change = session
                .block_command(Revision(0), range(at, at), command, &mut |_| Ok(()))
                .unwrap()
                .unwrap();
            let (fixed, nodes) = measured(change.work);
            let expected_nodes = if matches!(command, BlockCommand::Divider) {
                [105, 162, 233]
            } else {
                [64, 114, 189]
            };
            assert_eq!(nodes, expected_nodes[index]);
            results.push(fixed);
        }
        for work in &results[1..] {
            assert_eq!(
                work.materialized_source_bytes,
                results[0].materialized_source_bytes
            );
            assert_eq!(work.parsed_source_bytes, results[0].parsed_source_bytes);
            assert_eq!(work.inserted_bytes, results[0].inserted_bytes);
            assert_eq!(work.link_copied_bytes, results[0].link_copied_bytes);
            assert!(
                work.link_metadata_items
                    .abs_diff(results[0].link_metadata_items)
                    <= 16
            );
        }
    }
}
#[test]
fn public_pending_growth_work_keeps_foreign_word_fields_outside_the_local_ledger() {
    let mut results = Vec::new();
    for (index, count) in [20, 200].into_iter().enumerate() {
        let mut session = EditorSession::open(&"x\n\n".repeat(count));
        for index in (0..count).rev() {
            session
                .replace(
                    session.revision(),
                    range(index * 3, index * 3 + 1),
                    "https://x.test",
                    &mut |_| Ok(()),
                )
                .unwrap();
        }
        reset();
        let change = session
            .replace(session.revision(), range(8, 8), "x", &mut |_| Ok(()))
            .unwrap();
        let (fixed, nodes) = measured(change.work);
        assert_eq!(nodes, [404, 361][index]);
        assert_eq!(fixed.link_metadata_items, 901);
        results.push(fixed);
    }
    assert_eq!(results[0], results[1]);
}
