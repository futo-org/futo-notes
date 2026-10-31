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

#[test]
fn shared_physical_quote_heads_do_not_reprotect_the_same_large_body() {
    let mut measurements = Vec::new();
    for (depth, body_bytes) in [(8, 4096), (64, 32768)] {
        let body = "x".repeat(body_bytes);
        let raw = format!("{}{body}", "- > ".repeat(depth));
        let expected = format!("\n{}{body}", "> ".repeat(depth));
        let shown = format!("\n{body}");
        let reopened = EditorSession::open(&expected);
        assert_eq!(reopened.source_text(), expected);
        assert_eq!(reopened.display_text(), shown);
        let output = reopened
            .project(
                Revision(0),
                DisplayRange {
                    start: DisplayOffset(0),
                    end: DisplayOffset(shown.len()),
                },
            )
            .unwrap();
        assert!(output.blocks.iter().all(|block| block.list.is_none()));
        assert!(output
            .blocks
            .iter()
            .any(|block| block.quote_depth == depth && block.range.start.0 == 1));
        let mut session = EditorSession::open(&raw);
        assert_eq!(session.source_text(), raw);
        assert_eq!(session.display_text(), body);
        let selected = DisplayRange {
            start: DisplayOffset(0),
            end: DisplayOffset(0),
        };
        let prefix = session.projection.source_prefix_at(0).unwrap();
        assert_eq!(prefix.content, 4 * depth..raw.len());
        assert_eq!(prefix.quote_depth, depth);
        let innermost = prefix.list.as_ref().unwrap();
        assert_eq!(innermost.depth, depth);
        assert_eq!(innermost.quote_depth, depth - 1);
        let (items, _, _) = session
            .projection
            .list_items_at(&session.source, innermost.marker.start);
        assert_eq!(items.len(), depth);
        for (index, item) in items.iter().enumerate() {
            assert_eq!(item.depth, index + 1);
            assert_eq!(item.quote_depth, index);
            assert_eq!(item.marker, 4 * index..4 * index + 1);
            assert_eq!(session.source.byte_to_line(item.marker.start), 0);
            assert_eq!(item.item.end, raw.len());
        }
        // More than two quote groups and a final inner quote decline the
        // special header transaction; single physical bodies decline Text frames.
        assert!(items.len() > 2 && prefix.quote_depth > 1);
        session
            .select_with_affinity(Revision(0), selected, Affinity::Backward)
            .unwrap();
        crate::inline::CONTAINER_METADATA_VISITS.with(|count| count.set(0));
        crate::inline::CONTAINER_PREFIX_QUERIES.with(|count| count.set(0));
        super::trace::reset();
        let mut accepts = 0;
        let change = session
            .block_command(Revision(0), selected, BlockCommand::Heading(0), &mut |_| {
                accepts += 1;
                Ok(())
            })
            .unwrap()
            .unwrap();
        let metadata = crate::inline::CONTAINER_METADATA_VISITS.with(|count| count.get());
        let queries = crate::inline::CONTAINER_PREFIX_QUERIES.with(|count| count.get());
        eprintln!(
            "shared-head depth={depth} primitive ledger: {:?}",
            super::trace::get()
        );
        let work = change.work;
        assert_eq!(accepts, 1);
        let mut view = body.clone();
        view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
        assert_eq!(session.source_text(), expected);
        assert_eq!(view, shown);
        assert_eq!(
            session.selection(),
            DisplayRange {
                start: DisplayOffset(1),
                end: DisplayOffset(1)
            }
        );
        let undo = session
            .undo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        view.replace_range(undo.range.start.0..undo.range.end.0, &undo.inserted);
        assert_eq!(view, body);
        assert_eq!(session.source_text(), raw);
        assert_eq!(session.selection(), selected);
        assert_eq!(session.affinity(), Affinity::Backward);
        let redo = session
            .redo(session.revision(), &mut |_| Ok(()))
            .unwrap()
            .unwrap();
        view.replace_range(redo.range.start.0..redo.range.end.0, &redo.inserted);
        assert_eq!(session.source_text(), expected);
        assert_eq!(view, shown);
        measurements.push((
            depth,
            raw.len(),
            work.parsed_source_bytes,
            work.materialized_source_bytes,
            metadata,
            queries,
        ));
    }
    // Functional and history checks for BOTH sizes precede the measured budgets.
    eprintln!("shared-head actual (groups,input,parsed,copied,metadata,queries): {measurements:?}");
    for (depth, input, parsed, copied, metadata, queries) in measurements {
        assert!(
            parsed < 32 * input,
            "depth={depth} parsed={parsed}, input={input}"
        );
        assert!(
            copied < 32 * input,
            "depth={depth} copied={copied}, input={input}"
        );
        assert!(
            metadata < 128 * input,
            "depth={depth} metadata={metadata}, input={input}"
        );
        assert!(queries <= 4 * depth, "depth={depth} queries={queries}");
    }
}
