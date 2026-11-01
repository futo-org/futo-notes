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
            // A long list is cut into rows (#314); the plan reads its own row.
            let row = s.projection.rows.at(0).0.source_len;
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
            assert!(change.work.parsed_source_bytes > row);
            assert!(change.work.materialized_source_bytes > row);
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

#[test]
fn multiline_paragraph_frames_measure_actual_parser_copy_and_query_growth() {
    for intent in 0..3 {
        let mut measured = Vec::new();
        for count in [64, 512] {
            let bodies: Vec<_> = (0..count).map(|i| format!("b{i}")).collect();
            let raw = format!("- > {}", bodies.join("\n  > "));
            let before = bodies.join("\n");
            let expected = match intent {
                0 => format!("- \n  {}", bodies.join("\n  ")),
                1 => format!("- {}", bodies.join("\n  ")),
                _ => format!("\n> {}", bodies.join("\n> ")),
            };
            let shown = if intent == 1 {
                before.clone()
            } else {
                format!("\n{before}")
            };
            let mut s = EditorSession::open(&raw);
            assert_eq!(s.display_text(), before);
            let selected = DisplayRange {
                start: DisplayOffset(0),
                end: DisplayOffset(0),
            };
            s.select_with_affinity(Revision(0), selected, Affinity::Backward)
                .unwrap();
            // A long list is cut into rows (#314); the plan reads its own row.
            let row = s.projection.rows.at(0).0.source_len;
            crate::inline::CONTAINER_METADATA_VISITS.with(|c| c.set(0));
            let mut accepted = 0;
            let mut accept = |_: &SourceEdit| {
                accepted += 1;
                Ok(())
            };
            let change = match intent {
                0 => s.block_command(Revision(0), selected, BlockCommand::Outdent, &mut accept),
                1 => s.paragraph_key(Revision(0), selected, ParagraphKey::Backspace, &mut accept),
                _ => s.block_command(Revision(0), selected, BlockCommand::Heading(0), &mut accept),
            }
            .unwrap()
            .unwrap();
            let metadata = crate::inline::CONTAINER_METADATA_VISITS.with(|c| c.get());
            let work = change.work;
            let mut view = before.clone();
            view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
            assert_eq!(accepted, 1);
            assert_eq!(s.source_text(), expected);
            assert_eq!(view, shown);
            assert_eq!(s.selection().start, DisplayOffset(usize::from(intent != 1)));
            let undo = s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
            view.replace_range(undo.range.start.0..undo.range.end.0, &undo.inserted);
            assert_eq!(s.source_text(), raw);
            assert_eq!(view, before);
            assert_eq!(s.selection(), selected);
            assert_eq!(s.affinity(), Affinity::Backward);
            let redo = s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
            view.replace_range(redo.range.start.0..redo.range.end.0, &redo.inserted);
            assert_eq!(s.source_text(), expected);
            assert_eq!(view, shown);
            assert!(
                metadata > 0 && metadata < 128 * raw.len(),
                "intent{intent} metadata={metadata}"
            );
            assert!(
                work.parsed_source_bytes > raw.len() && work.parsed_source_bytes < 32 * raw.len()
            );
            assert!(
                work.materialized_source_bytes > expected.len()
                    && work.materialized_source_bytes < 32 * raw.len()
            );
            measured.push((
                raw.len(),
                metadata,
                work.parsed_source_bytes,
                work.materialized_source_bytes,
            ));
        }
        let (small, a, p, c) = measured[0];
        let (large, b, q, d) = measured[1];
        assert!(
            b * small < 2 * a * large,
            "intent{intent} metadata={a}->{b}, input={small}->{large}"
        );
        assert!(
            q * small < 2 * p * large,
            "intent{intent} parser={p}->{q}, input={small}->{large}"
        );
        assert!(
            d * small < 2 * c * large,
            "intent{intent} copies={c}->{d}, input={small}->{large}"
        );
    }
}

#[test]
fn multiline_paragraph_frame_does_not_parse_or_copy_unrelated_twenty_thousand_rows() {
    let mut measured = Vec::new();
    for paragraphs in [1, 20_000] {
        let prefix = "foreign\n\n".repeat(paragraphs);
        let raw = format!("{prefix}- > b0\n  > b1\n  > b2\n  > b3\n  > b4\n  > b5\n  > b6\n  > b7");
        let expected = format!("{prefix}- \n  b0\n  b1\n  b2\n  b3\n  b4\n  b5\n  b6\n  b7");
        let before = format!("{prefix}b0\nb1\nb2\nb3\nb4\nb5\nb6\nb7");
        let shown = format!("{prefix}\nb0\nb1\nb2\nb3\nb4\nb5\nb6\nb7");
        let mut s = EditorSession::open(&raw);
        assert_eq!(s.display_text(), before);
        let selected = DisplayRange {
            start: DisplayOffset(prefix.len()),
            end: DisplayOffset(prefix.len()),
        };
        s.select_with_affinity(Revision(0), selected, Affinity::Backward)
            .unwrap();
        crate::inline::CONTAINER_METADATA_VISITS.with(|c| c.set(0));
        let change = s
            .block_command(
                Revision(0),
                selected,
                BlockCommand::Outdent,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap();
        let metadata = crate::inline::CONTAINER_METADATA_VISITS.with(|c| c.get());
        let work = change.work;
        let mut view = before.clone();
        view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
        assert_eq!(s.source_text(), expected);
        assert_eq!(view, shown);
        assert_eq!(s.selection().start, DisplayOffset(prefix.len() + 1));
        s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), selected);
        assert_eq!(s.affinity(), Affinity::Backward);
        assert!(
            metadata > 0 && metadata < 4096,
            "paragraphs{paragraphs} metadata={metadata}"
        );
        assert!(work.parsed_source_bytes > 0 && work.parsed_source_bytes < 4096);
        assert!(work.materialized_source_bytes > 0 && work.materialized_source_bytes < 4096);
        measured.push((work.parsed_source_bytes, work.materialized_source_bytes));
    }
    assert_eq!(measured[0], measured[1]);
}
