use crate::*;

#[test]
fn shared_frame_plan_counts_actual_row_and_emitted_prefix_work_without_ancestor_reparses() {
    for depth in [3, 32] {
        let mut measurements = Vec::new();
        for count in [64, 512] {
            let head = "- ".repeat(depth);
            let tail = (0..count).map(|i| format!("\n- p{i}")).collect::<String>();
            let raw = format!("{head}> &acE;{tail}");
            let before = format!("\u{223e}\u{0333}{tail}").replace("\n- ", "\n");
            let expected = format!(
                "{}+ \n{}&acE;{tail}",
                "- ".repeat(depth - 1),
                " ".repeat(2 * depth)
            );
            let shown = format!("\n{before}");
            let mut s = EditorSession::open(&raw);
            assert_eq!(s.display_text(), before);
            let selected = DisplayRange {
                start: DisplayOffset(3),
                end: DisplayOffset(3),
            };
            s.select_with_affinity(s.revision(), selected, Affinity::Backward)
                .unwrap();
            crate::inline::CONTAINER_METADATA_VISITS.with(|c| c.set(0));
            let mut accepted = 0;
            let change = s
                .block_command(s.revision(), selected, BlockCommand::Outdent, &mut |_| {
                    accepted += 1;
                    Ok(())
                })
                .unwrap()
                .unwrap();
            let visits = crate::inline::CONTAINER_METADATA_VISITS.with(|c| c.get());
            let mut display = before.clone();
            display.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
            assert_eq!(accepted, 1);
            assert_eq!(s.source_text(), expected);
            assert_eq!(display, shown);
            assert_eq!(s.selection().start, DisplayOffset(4));
            assert!(change.work.parsed_source_bytes > raw.len());
            assert!(change.work.materialized_source_bytes > expected.len());
            measurements.push((
                raw.len(),
                visits,
                change.work.parsed_source_bytes,
                change.work.materialized_source_bytes,
            ));
            s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
            assert_eq!(s.source_text(), raw);
            assert_eq!(s.selection(), selected);
            s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
            assert_eq!(s.source_text(), expected);
        }
        let (small, a, p, c) = measurements[0];
        let (large, b, q, d) = measurements[1];
        assert!(large < 9 * small);
        assert!(
            b < 12 * a,
            "metadata {a}->{b}, input {small}->{large}, depth{depth}"
        );
        assert!(q < 12 * p, "parser {p}->{q}, depth{depth}");
        assert!(d < 12 * c, "copies {c}->{d}, depth{depth}");
    }
}
