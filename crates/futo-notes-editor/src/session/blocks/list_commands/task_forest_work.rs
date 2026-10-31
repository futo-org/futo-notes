use crate::*;

#[test]
fn flat_task_retarget_chooses_each_retained_owner_style_without_repeated_scans() {
    let mut measured = Vec::new();
    for count in [64, 512] {
        let raw = (0..count)
            .map(|at| format!("1. p{at}\n   - c{at}"))
            .collect::<Vec<_>>()
            .join("\n");
        let expected = (0..count)
            .map(|at| format!("- [ ] p{at}\n  - [ ] c{at}"))
            .collect::<Vec<_>>()
            .join("\n");
        let shown = (0..count)
            .map(|at| format!("p{at}\nc{at}"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(EditorSession::open(&expected).display_text(), shown);
        let mut s = EditorSession::open(&raw);
        assert_eq!(s.display_text(), shown);
        let selected = DisplayRange {
            start: DisplayOffset(0),
            end: DisplayOffset(shown.len()),
        };
        s.select_with_affinity(Revision(0), selected, Affinity::Backward)
            .unwrap();
        assert!(matches!(
            s.block_command(Revision(0), selected, BlockCommand::TaskList, &mut |_| Err(
                "append rejected".into()
            )),
            Err(EditorError::Persistence(_))
        ));
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.revision(), Revision(0));
        assert_eq!(s.selection(), selected);
        crate::inline::CONTAINER_METADATA_VISITS.with(|counter| counter.set(0));
        crate::inline::CONTAINER_PREFIX_QUERIES.with(|counter| counter.set(0));
        crate::inline::CONTAINER_STYLE_OWNER_SCANS.with(|counter| counter.set(0));
        crate::inline::CONTAINER_LIFT_ITEM_SCANS.with(|counter| counter.set(0));
        crate::inline::CONTAINER_BLOCK_QUERY_VISITS.with(|counter| counter.set(0));
        crate::inline::CONTAINER_CORRESPONDENCE_SCANS.with(|counter| counter.set(0));
        let mut accepts = 0;
        let change = s
            .block_command(Revision(0), selected, BlockCommand::TaskList, &mut |_| {
                accepts += 1;
                Ok(())
            })
            .unwrap()
            .unwrap();
        let visits = crate::inline::CONTAINER_METADATA_VISITS.with(|counter| counter.get());
        let queries = crate::inline::CONTAINER_PREFIX_QUERIES.with(|counter| counter.get());
        let owners = crate::inline::CONTAINER_STYLE_OWNER_SCANS.with(|counter| counter.get());
        let items = crate::inline::CONTAINER_LIFT_ITEM_SCANS.with(|counter| counter.get());
        let blocks = crate::inline::CONTAINER_BLOCK_QUERY_VISITS.with(|counter| counter.get());
        let correspondence =
            crate::inline::CONTAINER_CORRESPONDENCE_SCANS.with(|counter| counter.get());
        assert_eq!(accepts, 1);
        let mut view = shown.clone();
        view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
        assert_eq!(view, shown);
        assert_eq!(s.source_text(), expected);
        assert_eq!(s.selection(), selected);
        let items_after = s
            .project(s.revision(), selected)
            .unwrap()
            .blocks
            .into_iter()
            .filter_map(|block| block.list.filter(|list| list.first))
            .collect::<Vec<_>>();
        assert_eq!(items_after.len(), 2 * count);
        assert!(items_after
            .iter()
            .enumerate()
            .all(|(at, list)| list.number.is_none()
                && list.checked == Some(false)
                && list.depth == if at % 2 == 0 { 1 } else { 2 }));
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
        measured.push((raw.len(), visits, owners, items, blocks, correspondence));
        s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), selected);
        assert_eq!(s.affinity(), Affinity::Backward);
    }
    let (a_bytes, a_visits, a_owners, a_items, a_blocks, a_correspondence) = measured[0];
    let (b_bytes, b_visits, b_owners, b_items, b_blocks, b_correspondence) = measured[1];
    assert!(a_visits > 0 && b_owners <= 4 * 512 + 8 && b_items <= 8 * 512 + 8
        && b_blocks <= 16 * 512 + 32 && a_correspondence > 0
        && (b_visits as u128) * (a_bytes as u128) < 2 * (a_visits as u128) * (b_bytes as u128)
        && (b_correspondence as u128) * (a_bytes as u128) < 2 * (a_correspondence as u128) * (b_bytes as u128),
        "task forest input={a_bytes}..{b_bytes} metadata={a_visits}..{b_visits} owner_scans={a_owners}..{b_owners} item_scans={a_items}..{b_items} block_visits={a_blocks}..{b_blocks} correspondence={a_correspondence}..{b_correspondence}");
}
