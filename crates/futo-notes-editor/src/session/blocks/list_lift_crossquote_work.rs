use crate::*;

#[test]
fn full_quote_lifting_uses_constant_source_passes_as_container_depth_grows() {
    for depth in [8, 64] {
        let raw = (0..depth)
            .map(|at| format!("{}- n{at}\n", "  > ".repeat(at)))
            .collect::<String>();
        let expected = (0..depth)
            .map(|at| format!("{}n{at}\n", "> ".repeat(at)))
            .collect::<String>();
        let shown = (0..depth).map(|at| format!("n{at}\n")).collect::<String>();
        let selected = DisplayRange {
            start: DisplayOffset(shown.rfind(&format!("n{}", depth - 1)).unwrap()),
            end: DisplayOffset(shown.len() - 1),
        };
        let mut s = EditorSession::open(&raw);
        assert_eq!(s.display_text(), shown);
        s.select_with_affinity(Revision(0), selected, Affinity::Backward)
            .unwrap();
        crate::inline::CONTAINER_METADATA_VISITS.with(|count| count.set(0));
        crate::inline::CONTAINER_PREFIX_QUERIES.with(|count| count.set(0));
        let mut accepts = 0;
        let change = s
            .block_command(Revision(0), selected, BlockCommand::Heading(0), &mut |_| {
                accepts += 1;
                Ok(())
            })
            .unwrap()
            .unwrap();
        let visits = crate::inline::CONTAINER_METADATA_VISITS.with(|count| count.get());
        let queries = crate::inline::CONTAINER_PREFIX_QUERIES.with(|count| count.get());
        assert_eq!(accepts, 1);
        let mut view = shown.clone();
        view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
        assert_eq!(view, shown);
        assert_eq!(s.source_text(), expected);
        assert_eq!(s.selection(), selected);
        assert!(
            queries > 0 && queries <= 4 * depth,
            "depth={depth} prefix queries={queries}"
        );
        assert!(
            visits > 0 && visits < 128 * raw.len(),
            "depth={depth} metadata={visits}"
        );
        assert!(
            change.work.parsed_source_bytes < 32 * raw.len(),
            "depth={depth} parsed={}",
            change.work.parsed_source_bytes
        );
        assert!(
            change.work.materialized_source_bytes < 32 * raw.len(),
            "depth={depth} materialized={}",
            change.work.materialized_source_bytes
        );
        s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
        assert_eq!(s.source_text(), raw);
        assert_eq!(s.selection(), selected);
        assert_eq!(s.affinity(), Affinity::Backward);
    }
}

#[test]
fn full_quote_lifting_does_not_parse_or_materialize_unrelated_paragraphs() {
    let mut measurements = Vec::new();
    for paragraphs in [1, 20_000] {
        let prefix = "foreign\n\n".repeat(paragraphs);
        let raw = format!("{prefix}- outer\n  > - middle\n  >   > - child\n\nend");
        let expected = format!("{prefix}outer\n> middle\n> > child\n\nend");
        let shown = format!("{prefix}outer\nmiddle\nchild\n\nend");
        let selected = DisplayRange {
            start: DisplayOffset(prefix.len() + 13),
            end: DisplayOffset(prefix.len() + 18),
        };
        let mut s = EditorSession::open(&raw);
        assert_eq!(s.display_text(), shown);
        s.select(Revision(0), selected).unwrap();
        crate::inline::CONTAINER_METADATA_VISITS.with(|count| count.set(0));
        let change = s
            .block_command(Revision(0), selected, BlockCommand::Heading(0), &mut |_| {
                Ok(())
            })
            .unwrap()
            .unwrap();
        let visits = crate::inline::CONTAINER_METADATA_VISITS.with(|count| count.get());
        let mut view = shown.clone();
        view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
        assert_eq!(view, shown);
        assert_eq!(s.source_text(), expected);
        assert_eq!(s.selection(), selected);
        assert!(visits > 0 && visits < 4096, "metadata={visits}");
        assert!(change.work.parsed_source_bytes < 4096);
        assert!(change.work.materialized_source_bytes < 4096);
        measurements.push((
            change.work.parsed_source_bytes,
            change.work.materialized_source_bytes,
        ));
        s.undo(s.revision(), &mut |_| Ok(())).unwrap().unwrap();
        assert_eq!(s.source_text(), raw);
    }
    assert_eq!(measurements[0], measurements[1]);
}
