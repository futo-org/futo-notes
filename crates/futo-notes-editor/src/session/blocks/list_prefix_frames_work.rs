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
        eprintln!("frame depth{depth}: input {small}->{large}, metadata {a}->{b}, parser {p}->{q}, copies {c}->{d}");
        assert!(
            b * small < 2 * a * large,
            "metadata {a}->{b}, input {small}->{large}, depth{depth}"
        );
        assert!(
            q * small < 2 * p * large,
            "parser {p}->{q}, input {small}->{large}, depth{depth}"
        );
        assert!(
            d * small < 2 * c * large,
            "copies {c}->{d}, input {small}->{large}, depth{depth}"
        );
    }
}

#[test]
fn multiline_frame_paragraph_range_excludes_later_item_blocks_and_foreign_items() {
    for (raw, end) in [
        ("- > b\n  > c\n\n  tail\n- outside", 12),
        ("- > b\r\n  > c\r\n\r\n  tail\r\n- outside", 14),
        ("- > b  \n  > c\n\n  tail\n- outside", 14),
    ] {
        let s = EditorSession::open(raw);
        let (items, parsed, window, paragraph) =
            s.projection
                .list_items_and_paragraph_at(&s.source, 0, Some(4));
        assert_eq!(parsed, raw.len());
        assert_eq!(window, 0..raw.len());
        assert_eq!(paragraph, Some(4..end));
        let owner = items.iter().find(|item| item.marker.start == 0).unwrap();
        assert!(owner.item.end > end);
        let mut at = 0;
        let mut physical = Vec::new();
        while at < end {
            let row = s.projection.source_prefix_at(at).unwrap();
            assert!(!row.code);
            assert_eq!(row.quote_depth, 1);
            assert_eq!(row.list.as_ref().unwrap().item, owner.item);
            assert!(row.source.end <= end);
            physical.push(s.source.byte_slice(row.content.clone()).to_string());
            at = row.source.end;
        }
        assert_eq!(at, end);
        assert_eq!(
            physical,
            if raw.contains("b  ") {
                vec!["b  ", "c"]
            } else {
                vec!["b", "c"]
            }
        );
    }
}
