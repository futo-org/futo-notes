use crate::*;

#[test]
fn nested_selected_retarget_does_not_copy_each_prefix_for_every_ancestor() {
    for depth in [8, 64] {
        let raw = (0..depth)
            .map(|at| format!("{}- n{at}\n", "  ".repeat(at)))
            .collect::<String>();
        let expected = (0..depth)
            .map(|at| format!("{}1. n{at}\n", "   ".repeat(at)))
            .collect::<String>();
        let shown = (0..depth).map(|at| format!("n{at}\n")).collect::<String>();
        let selected = DisplayRange {
            start: DisplayOffset(0),
            end: DisplayOffset(shown.len() - 1),
        };
        let mut session = EditorSession::open(&raw);
        assert_eq!(session.display_text(), shown);
        session.select(Revision(0), selected).unwrap();
        crate::inline::CONTAINER_METADATA_VISITS.with(|visits| visits.set(0));
        crate::inline::CONTAINER_PREFIX_QUERIES.with(|queries| queries.set(0));
        let change = session
            .block_command(
                Revision(0),
                selected,
                BlockCommand::OrderedList,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap();
        let visits = crate::inline::CONTAINER_METADATA_VISITS.with(|visits| visits.get());
        let prefix_queries = crate::inline::CONTAINER_PREFIX_QUERIES.with(|queries| queries.get());
        assert!(
            prefix_queries > 0 && prefix_queries <= 3 * depth,
            "depth={depth} prefix queries={prefix_queries}"
        );
        assert!(
            visits > 0 && visits < 64 * raw.len(),
            "depth={depth} metadata={visits}"
        );
        let mut view = shown.clone();
        view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
        assert_eq!(view, shown);
        assert_eq!(session.source_text(), expected);
        assert_eq!(session.selection(), selected);
        // A conservative constant copy budget for the actual touched bytes.
        // Repeated prefix copies at every selected ancestor grow beyond it.
        assert!(
            change.work.materialized_source_bytes < 32 * raw.len(),
            "depth={depth} input={} materialized={} parsed={} metadata={visits}",
            raw.len(),
            change.work.materialized_source_bytes,
            change.work.parsed_source_bytes
        );
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(session.source_text(), raw);
    }
}

#[test]
fn alternating_quote_retarget_does_not_copy_each_prefix_for_every_container() {
    for depth in [8, 64] {
        let raw = (0..depth)
            .map(|at| format!("{}- n{at}\n", "  > ".repeat(at)))
            .collect::<String>();
        let expected = (0..depth)
            .map(|at| format!("{}1. n{at}\n", "   > ".repeat(at)))
            .collect::<String>();
        let shown = (0..depth).map(|at| format!("n{at}\n")).collect::<String>();
        let selected = DisplayRange {
            start: DisplayOffset(0),
            end: DisplayOffset(shown.len() - 1),
        };
        let mut session = EditorSession::open(&raw);
        assert_eq!(session.display_text(), shown);
        session.select(Revision(0), selected).unwrap();
        crate::inline::CONTAINER_METADATA_VISITS.with(|visits| visits.set(0));
        crate::inline::CONTAINER_PREFIX_QUERIES.with(|queries| queries.set(0));
        let change = session
            .block_command(
                Revision(0),
                selected,
                BlockCommand::OrderedList,
                &mut |_| Ok(()),
            )
            .unwrap()
            .unwrap();
        let visits = crate::inline::CONTAINER_METADATA_VISITS.with(|visits| visits.get());
        let prefix_queries = crate::inline::CONTAINER_PREFIX_QUERIES.with(|queries| queries.get());
        assert!(
            prefix_queries > 0 && prefix_queries <= 3 * depth,
            "depth={depth} prefix queries={prefix_queries}"
        );
        assert!(
            visits > 0 && visits < 64 * raw.len(),
            "depth={depth} metadata={visits}"
        );
        let mut view = shown.clone();
        view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
        assert_eq!(view, shown);
        assert_eq!(session.source_text(), expected);
        assert_eq!(session.selection(), selected);
        // A conservative constant copy budget for the actual touched bytes.
        // Repeated prefix copies at every selected ancestor grow beyond it.
        assert!(
            change.work.materialized_source_bytes < 32 * raw.len(),
            "depth={depth} input={} materialized={} parsed={} metadata={visits}",
            raw.len(),
            change.work.materialized_source_bytes,
            change.work.parsed_source_bytes
        );
        session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(session.source_text(), raw);
    }
}

#[test]
fn mixed_parent_retirement_uses_one_prefix_sweep_and_skips_unrelated_paragraphs() {
    for depth in [8, 64] {
        let touched = format!(
            "- parent\n{}",
            (0..depth)
                .map(|at| format!("{}1. n{at}\n", " ".repeat(2 + 3 * at)))
                .collect::<String>()
        );
        let promoted = format!(
            "parent\n{}",
            (0..depth)
                .map(|at| format!("{}- n{at}\n", "  ".repeat(at)))
                .collect::<String>()
        );
        let shown = format!(
            "parent\n{}",
            (0..depth).map(|at| format!("n{at}\n")).collect::<String>()
        );
        let mut measurements = Vec::new();
        for paragraphs in [1, 20_000] {
            let prefix = "foreign\n\n".repeat(paragraphs);
            let raw = format!("{prefix}{touched}");
            let expected = format!("{prefix}{promoted}");
            let display = format!("{prefix}{shown}");
            let selected = DisplayRange {
                start: DisplayOffset(prefix.len()),
                end: DisplayOffset(prefix.len() + shown.len() - 1),
            };
            let mut s = EditorSession::open(&raw);
            assert_eq!(s.display_text(), display);
            s.select_with_affinity(Revision(0), selected, Affinity::Backward)
                .unwrap();
            crate::inline::CONTAINER_METADATA_VISITS.with(|count| count.set(0));
            crate::inline::CONTAINER_PREFIX_QUERIES.with(|count| count.set(0));
            let mut accepts = 0;
            let change = s
                .block_command(Revision(0), selected, BlockCommand::BulletList, &mut |_| {
                    accepts += 1;
                    Ok(())
                })
                .unwrap()
                .unwrap();
            let visits = crate::inline::CONTAINER_METADATA_VISITS.with(|count| count.get());
            let queries = crate::inline::CONTAINER_PREFIX_QUERIES.with(|count| count.get());
            assert_eq!(accepts, 1);
            let mut view = display.clone();
            view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
            assert_eq!(view, display);
            assert_eq!(s.source_text(), expected);
            assert_eq!(s.selection(), selected);
            assert!(
                queries > 0 && queries <= 4 * (depth + 1),
                "depth={depth} queries={queries}"
            );
            assert!(
                visits > 0 && visits < 128 * touched.len(),
                "depth={depth} metadata={visits}"
            );
            assert!(
                change.work.parsed_source_bytes < 32 * touched.len(),
                "depth={depth} parsed={}",
                change.work.parsed_source_bytes
            );
            assert!(
                change.work.materialized_source_bytes < 32 * touched.len(),
                "depth={depth} materialized={}",
                change.work.materialized_source_bytes
            );
            measurements.push((
                change.work.parsed_source_bytes,
                change.work.materialized_source_bytes,
            ));
            s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
            assert_eq!(s.source_text(), raw);
            assert_eq!(s.selection(), selected);
            assert_eq!(s.affinity(), Affinity::Backward);
        }
        assert_eq!(
            measurements[0], measurements[1],
            "unrelated paragraphs entered mixed command parser/copy work"
        );
    }
}

#[test]
fn reversed_mixed_lift_overrides_do_not_repeat_ancestor_width_work() {
    for depth in [8, 64] {
        for quoted in [false, true] {
            let descendants = (0..depth)
                .map(|at| {
                    if quoted {
                        format!("   > {}- n{at}\n", "  ".repeat(at + 1))
                    } else {
                        format!("{}- n{at}\n", " ".repeat(5 + 2 * at))
                    }
                })
                .collect::<String>();
            let promoted = (0..depth)
                .map(|at| {
                    format!(
                        "{}{}{} n{at}\n",
                        if quoted { "> " } else { "" },
                        "  ".repeat(at),
                        if at == 0 && !quoted { '+' } else { '-' }
                    )
                })
                .collect::<String>();
            let touched = if quoted {
                format!("1. parent\n   > - child\n{descendants}2. following")
            } else {
                format!("1. parent\n   - child\n{descendants}2. following")
            };
            let changed = if quoted {
                format!("parent\n> child\n{promoted}- following")
            } else {
                format!("- parent\n\nchild\n{promoted}- following")
            };
            let rows = (0..depth).map(|at| format!("n{at}\n")).collect::<String>();
            let before = format!("parent\nchild\n{rows}following");
            let after = if quoted {
                before.clone()
            } else {
                format!("parent\n\nchild\n{rows}following")
            };
            assert_eq!(EditorSession::open(&changed).display_text(), after);
            let mut measurements = Vec::new();
            for paragraphs in [1, 20_000] {
                let prefix = "foreign\n\n".repeat(paragraphs);
                let raw = format!("{prefix}{touched}");
                let selected = DisplayRange {
                    start: DisplayOffset(prefix.len()),
                    end: DisplayOffset(prefix.len() + 12),
                };
                let mapped = DisplayRange {
                    start: selected.start,
                    end: DisplayOffset(selected.end.0 + usize::from(!quoted)),
                };
                let mut s = EditorSession::open(&raw);
                assert_eq!(s.display_text(), format!("{prefix}{before}"));
                s.select_with_affinity(Revision(0), selected, Affinity::Backward)
                    .unwrap();
                crate::inline::CONTAINER_METADATA_VISITS.with(|count| count.set(0));
                crate::inline::CONTAINER_PREFIX_QUERIES.with(|count| count.set(0));
                let mut accepts = 0;
                let change = s
                    .block_command(Revision(0), selected, BlockCommand::BulletList, &mut |_| {
                        accepts += 1;
                        Ok(())
                    })
                    .unwrap()
                    .unwrap();
                let visits = crate::inline::CONTAINER_METADATA_VISITS.with(|count| count.get());
                let queries = crate::inline::CONTAINER_PREFIX_QUERIES.with(|count| count.get());
                assert_eq!(accepts, 1);
                let mut view = format!("{prefix}{before}");
                view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
                assert_eq!(view, format!("{prefix}{after}"));
                assert_eq!(s.source_text(), format!("{prefix}{changed}"));
                assert_eq!(s.selection(), mapped);
                assert!(
                    queries > 0 && queries <= 4 * depth + 8,
                    "depth={depth} queries={queries}"
                );
                assert!(
                    visits > 0 && visits < 128 * touched.len(),
                    "depth={depth} metadata={visits}"
                );
                assert!(
                    change.work.parsed_source_bytes < 32 * touched.len(),
                    "depth={depth} parsed={}",
                    change.work.parsed_source_bytes
                );
                assert!(
                    change.work.materialized_source_bytes < 32 * touched.len(),
                    "depth={depth} materialized={}",
                    change.work.materialized_source_bytes
                );
                measurements.push((
                    change.work.parsed_source_bytes,
                    change.work.materialized_source_bytes,
                ));
                s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
                assert_eq!(s.source_text(), raw);
                assert_eq!(s.selection(), selected);
                assert_eq!(s.affinity(), Affinity::Backward);
            }
            assert_eq!(
                measurements[0], measurements[1],
                "unrelated paragraphs entered reversed mixed parser/copy work"
            );
        }
    }
}

#[test]
fn flat_mixed_owner_forests_do_not_repeat_full_owner_or_item_scans() {
    let mut measured = Vec::new();
    for count in [64, 512] {
        let raw = (0..count)
            .map(|at| format!("1. p{at}\n   - c{at}"))
            .collect::<Vec<_>>()
            .join("\n");
        let expected = (0..count)
            .map(|at| format!("- p{at}\n\nc{at}"))
            .collect::<Vec<_>>()
            .join("\n");
        let before = (0..count)
            .map(|at| format!("p{at}\nc{at}"))
            .collect::<Vec<_>>()
            .join("\n");
        let shown = (0..count)
            .map(|at| format!("p{at}\n\nc{at}"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(EditorSession::open(&expected).display_text(), shown);
        let mut s = EditorSession::open(&raw);
        assert_eq!(s.display_text(), before);
        let selected = DisplayRange {
            start: DisplayOffset(0),
            end: DisplayOffset(before.len()),
        };
        s.select_with_affinity(Revision(0), selected, Affinity::Backward)
            .unwrap();
        crate::inline::CONTAINER_METADATA_VISITS.with(|counter| counter.set(0));
        crate::inline::CONTAINER_PREFIX_QUERIES.with(|counter| counter.set(0));
        crate::inline::CONTAINER_STYLE_OWNER_SCANS.with(|counter| counter.set(0));
        crate::inline::CONTAINER_LIFT_ITEM_SCANS.with(|counter| counter.set(0));
        crate::inline::CONTAINER_BLOCK_QUERY_VISITS.with(|counter| counter.set(0));
        crate::inline::CONTAINER_CORRESPONDENCE_SCANS.with(|counter| counter.set(0));
        let mut accepts = 0;
        let change = s
            .block_command(Revision(0), selected, BlockCommand::BulletList, &mut |_| {
                accepts += 1;
                Ok(())
            })
            .unwrap()
            .unwrap();
        let visits = crate::inline::CONTAINER_METADATA_VISITS.with(|counter| counter.get());
        let queries = crate::inline::CONTAINER_PREFIX_QUERIES.with(|counter| counter.get());
        assert_eq!(accepts, 1);
        let mut view = before.clone();
        view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
        assert_eq!(view, shown);
        assert_eq!(s.source_text(), expected);
        assert_eq!(s.selection().start, selected.start);
        assert_eq!(s.selection().end, DisplayOffset(shown.len()));
        assert!(
            queries > 0 && queries <= 8 * count + 8,
            "count={count} queries={queries}"
        );
        assert!(
            change.work.parsed_source_bytes < 32 * raw.len(),
            "count={count} parsed={}",
            change.work.parsed_source_bytes
        );
        assert!(
            change.work.materialized_source_bytes < 32 * raw.len(),
            "count={count} materialized={}",
            change.work.materialized_source_bytes
        );
        let owner_scans = crate::inline::CONTAINER_STYLE_OWNER_SCANS.with(|counter| counter.get());
        let item_scans = crate::inline::CONTAINER_LIFT_ITEM_SCANS.with(|counter| counter.get());
        let block_visits =
            crate::inline::CONTAINER_BLOCK_QUERY_VISITS.with(|counter| counter.get());
        let correspondence =
            crate::inline::CONTAINER_CORRESPONDENCE_SCANS.with(|counter| counter.get());
        measured.push((
            raw.len(),
            visits,
            owner_scans,
            item_scans,
            block_visits,
            correspondence,
        ));
        s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), selected);
        assert_eq!(s.affinity(), Affinity::Backward);
    }
    let (small_bytes, small_visits, small_owners, small_items, small_blocks, small_correspondence) =
        measured[0];
    let (large_bytes, large_visits, large_owners, large_items, large_blocks, large_correspondence) =
        measured[1];
    assert!(
        small_visits > 0 && large_owners <= 4 * 512 + 8 && large_items <= 8 * 512 + 8
            && (large_visits as u128) * (small_bytes as u128)
                < 2 * (small_visits as u128) * (large_bytes as u128),
        "flat forest input={small_bytes}..{large_bytes} metadata={small_visits}..{large_visits} owner_scans={small_owners}..{large_owners} item_scans={small_items}..{large_items} block_visits={small_blocks}..{large_blocks} correspondence={small_correspondence}..{large_correspondence}"
    );
}
