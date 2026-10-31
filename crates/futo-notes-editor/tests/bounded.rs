use futo_notes_editor::*;

#[test]
fn retained_fence_literal_key_returns_local_identity_without_region_work() {
    for lines in [1_000, 20_000] {
        for line in [0, lines - 1] {
            let source = format!(
                "```Rust\n{}```\n\n__tail__",
                "alpha beta gamma\n".repeat(lines)
            );
            let session = EditorSession::open(&source);
            let mut bounded = session
                .into_bounded(Revision(0), SessionToken(7), DisplayOffset(0))
                .unwrap();
            assert!(
                bounded.preparation_work().metadata_items > lines,
                "entry reports proportional retained-row inspection"
            );
            let at = line * "alpha beta gamma\n".len() + 1;
            let change = bounded
                .insert_literal(bounded.cursor(), DisplayOffset(at), "x", &mut |_| Ok(()))
                .unwrap();
            // Fixed limits of this finite scalar/opaque-code capability. These
            // do not change any existing full projection or work budget.
            assert_eq!(change.work.parsed_source_bytes, 0);
            assert_eq!(change.work.inspected_source_bytes, 0);
            assert!(
                change.work.copied_bytes <= 272,
                "{lines}: {:?}",
                change.work
            );
            assert!(
                change.work.metadata_items <= 32,
                "{lines}: {:?}",
                change.work
            );
            assert!(
                change.work.returned_text_bytes <= 8,
                "{lines}: {:?}",
                change.work
            );
            assert_eq!(change.work.returned_records, 2);
            assert_eq!(change.projection.text, "x");
            assert_eq!(
                change.projection.identity,
                CodeIdentity {
                    source: SourceRange {
                        start: SourceOffset(8 + at),
                        end: SourceOffset(9 + at)
                    },
                    display: range(at, at + 1),
                }
            );
            let body = format!(
                "{}axlpha beta gamma\n{}",
                "alpha beta gamma\n".repeat(line),
                "alpha beta gamma\n".repeat(lines - line - 1)
            );
            let expected = format!("```Rust\n{body}```\n\n__tail__");
            assert_eq!(bounded.source_text(), expected);
            assert_eq!(bounded.display_text(), format!("{body}\ntail"));
            let (mut full, _) = bounded.materialize();
            let fresh = EditorSession::open(&expected);
            let mut projected = full
                .project(full.revision(), range(0, full.display_text().len()))
                .unwrap();
            projected.revision = Revision(0);
            assert_eq!(
                projected,
                fresh
                    .project(Revision(0), range(0, fresh.display_text().len()))
                    .unwrap()
            );
            full.undo(full.revision(), &mut |_| Ok(()))
                .unwrap()
                .unwrap();
            assert_eq!(full.source_text(), source);
        }
    }
}

fn range(start: usize, end: usize) -> DisplayRange {
    DisplayRange {
        start: DisplayOffset(start),
        end: DisplayOffset(end),
    }
}

#[test]
fn rejected_transfer_returns_the_same_live_composition_and_history_owner() {
    let mut session = EditorSession::open("```Rust\nab\n```\n");
    session
        .replace(Revision(0), range(0, 0), "x", &mut |_| Ok(()))
        .unwrap();
    session
        .compose(session.revision(), range(1, 1), "か")
        .unwrap();
    let failure = session
        .into_bounded(Revision(1), SessionToken(8), DisplayOffset(0))
        .err()
        .expect("active composition must refuse transfer");
    assert_eq!(
        failure.error,
        BoundedError::Editor(EditorError::CompositionActive)
    );
    let mut session = failure.session;
    assert_eq!(session.composition().unwrap().text, "か");
    assert_eq!(session.source_text(), "```Rust\nxab\n```\n");
    session.cancel_composition(Revision(1)).unwrap();
    session.undo(Revision(1), &mut |_| Ok(())).unwrap().unwrap();
    assert_eq!(session.source_text(), "```Rust\nab\n```\n");
}

#[test]
fn materializing_the_same_owner_keeps_pending_angle_and_equal_length_entity_atoms() {
    let mut session = EditorSession::open("```Rust\nab\n```\n\n&acE; __😀__\n\n");
    let at = session.display_text().len();
    session
        .replace(
            session.revision(),
            range(at, at),
            "<https://x.test",
            &mut |_| Ok(()),
        )
        .unwrap();
    let at = session.display_text().len();
    session
        .replace(session.revision(), range(at, at), ">", &mut |_| Ok(()))
        .unwrap();
    let old_source = session.source_text();
    let old_display = session.display_text();
    let before = session
        .project(session.revision(), range(0, old_display.len()))
        .unwrap();
    assert!(
        before.links.is_empty(),
        "actual typed pending-angle premise"
    );
    let at_entity = old_display.find('\u{223e}').unwrap();
    let atom_before = session
        .source_at(
            session.revision(),
            DisplayOffset(at_entity + 3),
            Affinity::Forward,
        )
        .unwrap();
    let revision = session.revision();
    let mut bounded = session
        .into_bounded(revision, SessionToken(9), DisplayOffset(0))
        .unwrap();
    let changed = bounded
        .insert_literal(bounded.cursor(), DisplayOffset(1), "x", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(changed.projection.block.language.as_deref(), Some("Rust"));
    let (mut session, materializing_work) = bounded.materialize();
    assert!(materializing_work.parsed_source_bytes > 0);
    assert_eq!(session.source_text(), old_source.replacen("ab", "axb", 1));
    assert_eq!(session.display_text(), old_display.replacen("ab", "axb", 1));
    let after = session
        .project(session.revision(), range(0, session.display_text().len()))
        .unwrap();
    assert!(
        after.links.is_empty(),
        "materialization cannot reopen typed provenance"
    );
    assert_eq!(
        session
            .source_at(
                session.revision(),
                DisplayOffset(at_entity + 4),
                Affinity::Forward
            )
            .unwrap(),
        SourceOffset(atom_before.0 + 1)
    );
    session
        .undo(session.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text(), old_source);
    assert!(session
        .project(session.revision(), range(0, old_display.len()))
        .unwrap()
        .links
        .is_empty());
}

#[test]
fn repeated_keys_keep_exact_source_and_original_grouping_after_one_materialization() {
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    };
    use std::time::Duration;
    #[derive(Default)]
    struct Clock(AtomicU64);
    impl HistoryClock for Clock {
        fn now(&self) -> Duration {
            Duration::from_millis(self.0.load(Ordering::Relaxed))
        }
    }
    let clock = Arc::new(Clock::default());
    let mut session = EditorSession::open_with_clock("```Rust\nab\n```\n", clock.clone());
    session.select(Revision(0), range(1, 1)).unwrap();
    session
        .replace(Revision(0), range(1, 1), "x", &mut |_| Ok(()))
        .unwrap();
    let mut bounded = session
        .into_bounded(Revision(1), SessionToken(10), DisplayOffset(1))
        .unwrap();
    let old = bounded.cursor();
    bounded
        .insert_literal(old, DisplayOffset(2), "😀", &mut |_| Ok(()))
        .unwrap();
    clock.0.store(500, Ordering::Relaxed);
    let change = bounded
        .insert_literal(bounded.cursor(), DisplayOffset(6), "日", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(change.selection, range(9, 9));
    assert_eq!(
        bounded
            .insert_literal(old, DisplayOffset(2), "z", &mut |_| panic!(
                "stale input appended"
            ))
            .unwrap_err(),
        BoundedError::StaleCursor
    );
    let current = bounded.cursor();
    assert!(matches!(
        bounded.insert_literal(current, DisplayOffset(9), "q", &mut |_| Err("disk".into())),
        Err(BoundedError::Editor(EditorError::Persistence(_)))
    ));
    assert_eq!(bounded.cursor(), current);
    let (mut session, work) = bounded.materialize();
    assert_eq!(session.source_text(), "```Rust\nax😀日b\n```\n");
    assert_eq!(session.selection(), range(9, 9));
    assert!(
        work.parsed_source_bytes < 128,
        "one materialization, not one parse per key: {work:?}"
    );
    session
        .undo(session.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text(), "```Rust\nax😀b\n```\n");
    session
        .undo(session.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text(), "```Rust\nab\n```\n");
}

#[test]
fn foreign_boundary_and_unsupported_input_refuse_before_append_and_preserve_the_owner() {
    let source = "```Rust\n😀b\n```\n";
    let session = EditorSession::open(source);
    let mut bounded = session
        .into_bounded(Revision(0), SessionToken(11), DisplayOffset(0))
        .unwrap();
    let cursor = bounded.cursor();
    assert_eq!(
        bounded
            .insert_literal(cursor, DisplayOffset(1), "x", &mut |_| panic!(
                "split UTF-8 appended"
            ))
            .unwrap_err(),
        BoundedError::Editor(EditorError::InvalidRange)
    );
    assert_eq!(
        bounded
            .insert_literal(cursor, DisplayOffset(0), "`", &mut |_| panic!(
                "unsupported delimiter appended"
            ))
            .unwrap_err(),
        BoundedError::Unsupported
    );
    assert_eq!(bounded.cursor(), cursor);
    assert_eq!(bounded.source_text(), source);
    let (mut session, _) = bounded.materialize();
    assert!(session
        .undo(Revision(0), &mut |_| panic!("refusal made history"))
        .unwrap()
        .is_none());
    session
        .replace(Revision(0), range(4, 4), "x", &mut |_| Ok(()))
        .unwrap();
    assert_eq!(session.source_text(), "```Rust\n😀xb\n```\n");
}

#[test]
fn a_cursor_from_a_materialized_mode_cannot_edit_a_later_mode_at_the_same_revision() {
    let session = EditorSession::open("```Rust\nab\n```\n");
    let bounded = session
        .into_bounded(Revision(0), SessionToken(12), DisplayOffset(0))
        .unwrap();
    let old = bounded.cursor();
    let (session, _) = bounded.materialize();
    let mut bounded = session
        .into_bounded(Revision(0), SessionToken(12), DisplayOffset(0))
        .unwrap();
    let mut calls = 0;
    let result = bounded.insert_literal(old, DisplayOffset(1), "x", &mut |_| {
        calls += 1;
        Ok(())
    });
    assert_eq!(calls, 0, "old mode cursor must reject before acceptance");
    assert_eq!(result.unwrap_err(), BoundedError::StaleCursor);
    assert_eq!(bounded.source_text(), "```Rust\nab\n```\n");
}
