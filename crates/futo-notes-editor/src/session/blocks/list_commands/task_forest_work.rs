use crate::*;

#[test]
fn flat_task_retarget_chooses_each_retained_owner_style_without_repeated_scans() {
    let mut measured = Vec::new();
    let counts = [32, 64, 512];
    for count in counts {
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
    for (index, pair) in measured.windows(2).enumerate() {
        let (a_bytes, a_visits, a_owners, a_items, a_blocks, a_correspondence) = pair[0];
        let (b_bytes, b_visits, b_owners, b_items, b_blocks, b_correspondence) = pair[1];
        let count = counts[index + 1];
        assert!(a_visits > 0 && b_owners <= 4 * count + 8 && b_items <= 8 * count + 8
            && b_blocks <= 16 * count + 32 && a_correspondence > 0
            && (b_visits as u128) * (a_bytes as u128) < 2 * (a_visits as u128) * (b_bytes as u128)
            && (b_correspondence as u128) * (a_bytes as u128) < 2 * (a_correspondence as u128) * (b_bytes as u128),
            "task forest input={a_bytes}..{b_bytes} metadata={a_visits}..{b_visits} owner_scans={a_owners}..{b_owners} item_scans={a_items}..{b_items} block_visits={a_blocks}..{b_blocks} correspondence={a_correspondence}..{b_correspondence}");
    }
}

fn assert_protected_fragment(
    raw: &str,
    expected: &str,
    shown: &str,
    selected: DisplayRange,
    command: BlockCommand,
) {
    assert_eq!(EditorSession::open(expected).display_text(), shown);
    let mut s = EditorSession::open(raw);
    let mut view = shown.to_owned();
    assert_eq!(s.display_text(), shown);
    s.select_with_affinity(Revision(0), selected, Affinity::Backward)
        .unwrap();
    assert!(matches!(
        s.block_command(Revision(0), selected, command, &mut |_| Err(
            "append rejected".into()
        )),
        Err(EditorError::Persistence(_))
    ));
    assert_eq!(s.source_text(), raw);
    assert_eq!(s.revision(), Revision(0));
    let mut accepts = 0;
    let change = s
        .block_command(Revision(0), selected, command, &mut |_| {
            accepts += 1;
            Ok(())
        })
        .unwrap()
        .unwrap();
    assert_eq!(accepts, 1);
    view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
    assert_eq!(view, shown);
    assert_eq!(s.source_text(), expected);
    assert_eq!(s.selection(), selected);
    let undo = s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    view.replace_range(undo.range.start.0..undo.range.end.0, &undo.inserted);
    assert_eq!(s.source_text(), raw);
    assert_eq!(view, shown);
    assert_eq!(s.selection(), selected);
    assert_eq!(s.affinity(), Affinity::Backward);
    let redo = s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
    view.replace_range(redo.range.start.0..redo.range.end.0, &redo.inserted);
    assert_eq!(s.source_text(), expected);
    assert_eq!(view, shown);
    assert_eq!(s.selection(), selected);
}

#[test]
fn promoted_quote_fragments_do_not_use_a_foreign_preceding_owner_style() {
    assert_protected_fragment(
        "- before\n\n1. parent\n   > - child\u{1f600}\n   >   - grandchild\n   > - sibling\n2. following",
        "- before\n\nparent\n> child\u{1f600}\n> + grandchild\n> - sibling\n- following",
        "before\n\nparent\nchild\u{1f600}\ngrandchild\nsibling\nfollowing",
        DisplayRange { start: DisplayOffset(8), end: DisplayOffset(24) },
        BlockCommand::BulletList,
    );
}

#[test]
fn retained_task_owner_keeps_one_marker_between_two_foreign_bullet_styles() {
    assert_protected_fragment(
        "- before\n\n1. p0\n   - c0\n1. p1\n   - c1\n\n+ after",
        "- before\n\n* [ ] p0\n  - [ ] c0\n* [ ] p1\n  - [ ] c1\n\n+ after",
        "before\n\np0\nc0\np1\nc1\n\nafter",
        DisplayRange {
            start: DisplayOffset(8),
            end: DisplayOffset(19),
        },
        BlockCommand::TaskList,
    );
}

#[test]
fn retained_ordered_owner_keeps_its_sequence_and_one_foreign_boundary_comment() {
    assert_protected_fragment(
        "7) before\n\n- p0\n  - c0\n- p1\n  - c1\n\n9. after",
        "7) before\n\n1. p0\n   1. c0\n2. p1\n   1. c1\n<!-- -->\n\n9. after",
        "before\n\np0\nc0\np1\nc1\n\nafter",
        DisplayRange {
            start: DisplayOffset(8),
            end: DisplayOffset(19),
        },
        BlockCommand::OrderedList,
    );
}

#[test]
fn task_child_lifting_counts_each_original_owner_fragment_without_repeated_walks() {
    let mut measured = Vec::new();
    let counts = [32, 64, 512];
    for count in counts {
        let raw = (0..count)
            .map(|at| {
                format!(
                    "- p{at}\n  - [{}] c{at}",
                    if at % 2 == 0 { "x" } else { " " }
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let expected = (0..count)
            .map(|at| format!("- [ ] p{at}\n\nc{at}"))
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
        assert!(matches!(
            s.block_command(Revision(0), selected, BlockCommand::TaskList, &mut |_| Err(
                "append rejected".into()
            )),
            Err(EditorError::Persistence(_))
        ));
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.revision(), Revision(0));
        assert_eq!(s.selection(), selected);
        crate::inline::CONTAINER_METADATA_VISITS.with(|c| c.set(0));
        crate::inline::CONTAINER_PREFIX_QUERIES.with(|c| c.set(0));
        crate::inline::CONTAINER_STYLE_OWNER_SCANS.with(|c| c.set(0));
        crate::inline::CONTAINER_LIFT_ITEM_SCANS.with(|c| c.set(0));
        crate::inline::CONTAINER_BLOCK_QUERY_VISITS.with(|c| c.set(0));
        crate::inline::CONTAINER_CORRESPONDENCE_SCANS.with(|c| c.set(0));
        let mut accepted = 0;
        let change = s
            .block_command(Revision(0), selected, BlockCommand::TaskList, &mut |_| {
                accepted += 1;
                Ok(())
            })
            .unwrap()
            .unwrap();
        let visits = crate::inline::CONTAINER_METADATA_VISITS.with(|c| c.get());
        let queries = crate::inline::CONTAINER_PREFIX_QUERIES.with(|c| c.get());
        let owners = crate::inline::CONTAINER_STYLE_OWNER_SCANS.with(|c| c.get());
        let items = crate::inline::CONTAINER_LIFT_ITEM_SCANS.with(|c| c.get());
        let blocks = crate::inline::CONTAINER_BLOCK_QUERY_VISITS.with(|c| c.get());
        let correspondence = crate::inline::CONTAINER_CORRESPONDENCE_SCANS.with(|c| c.get());
        assert_eq!(accepted, 1);
        let mut view = before.clone();
        view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
        assert_eq!(view, shown);
        assert_eq!(s.source_text(), expected);
        assert_eq!(
            s.selection(),
            DisplayRange {
                start: DisplayOffset(0),
                end: DisplayOffset(shown.len())
            }
        );
        let projected = s.project(s.revision(), s.selection()).unwrap();
        let roots = projected
            .blocks
            .into_iter()
            .filter_map(|b| b.list.filter(|l| l.first))
            .collect::<Vec<_>>();
        assert_eq!(roots.len(), count);
        assert!(roots
            .iter()
            .all(|l| l.depth == 1 && l.checked == Some(false) && l.number.is_none()));
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
            "count={count} copied={}",
            change.work.materialized_source_bytes
        );
        measured.push((raw.len(), visits, owners, items, blocks, correspondence));
        let undo = s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
        view.replace_range(undo.range.start.0..undo.range.end.0, &undo.inserted);
        assert_eq!(view, before);
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), selected);
        assert_eq!(s.affinity(), Affinity::Backward);
        let redo = s.redo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
        view.replace_range(redo.range.start.0..redo.range.end.0, &redo.inserted);
        assert_eq!(view, shown);
        assert_eq!(s.source_text(), expected);
    }
    for (index, pair) in measured.windows(2).enumerate() {
        let (a_bytes, a_visits, a_owners, a_items, a_blocks, a_correspondence) = pair[0];
        let (b_bytes, b_visits, b_owners, b_items, b_blocks, b_correspondence) = pair[1];
        let count = counts[index + 1];
        assert!(a_visits>0 && b_owners<=4*count+8 && b_items<=8*count+8 && b_blocks<=16*count+32 && a_correspondence>0
            && (b_visits as u128)*(a_bytes as u128)<2*(a_visits as u128)*(b_bytes as u128)
            && (b_correspondence as u128)*(a_bytes as u128)<2*(a_correspondence as u128)*(b_bytes as u128),
            "task lift input={a_bytes}..{b_bytes} metadata={a_visits}..{b_visits} owners={a_owners}..{b_owners} items={a_items}..{b_items} blocks={a_blocks}..{b_blocks} correspondence={a_correspondence}..{b_correspondence}");
    }
}
