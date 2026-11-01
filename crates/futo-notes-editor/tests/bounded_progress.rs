use futo_notes_editor::*;
#[path = "common/bounded_view.rs"]
mod bounded_view;
use bounded_view::BoundedView;

#[test]
fn removing_an_existing_closer_starts_with_bounded_wider_semantics() {
    let paragraph = "__😀__ &acE; [x](u)\n\n";
    let source = format!("```Rust\nab\n```\n\n{}", paragraph.repeat(64));
    let session = EditorSession::open(&source);
    let mut bounded = session
        .into_bounded(Revision(0), SessionToken(20), DisplayOffset(0))
        .unwrap();
    let mut accepted = 0;
    let change = bounded
        .remove_fence_closer(bounded.cursor(), &mut |edit| {
            accepted += 1;
            assert_eq!(
                edit.range,
                SourceRange {
                    start: SourceOffset(11),
                    end: SourceOffset(14)
                }
            );
            assert_eq!(edit.removed, "```");
            assert_eq!(edit.inserted, "");
            Ok(())
        })
        .unwrap();
    assert_eq!(accepted, 1);
    assert_eq!(change.projection.text, "\n\n\n");
    assert!(change.continuation.is_some());
    assert_eq!(
        bounded.source_text(),
        format!("```Rust\nab\n\n\n{}", paragraph.repeat(64))
    );
    let mut frames = 0;
    while let Some(continuation) = bounded.continuation() {
        let frame = bounded.continue_projection(continuation).unwrap();
        if let BoundedProgress::Change(frame) = frame {
            assert!(frame.projection.text.len() <= 256);
            assert!(frame.work.copied_bytes <= 16384);
            assert!(frame.work.returned_records <= 512);
            assert_eq!(frame.work.parsed_source_bytes, 0);
        }
        frames += 1;
        assert!(frames < 100, "completion must advance a finite frontier");
    }
    assert_eq!(
        bounded.display_text(),
        format!("ab\n\n\n{}__😀__ &acE; [x](u)\n", paragraph.repeat(63))
    );
    let (mut session, _) = bounded.materialize();
    let fresh = EditorSession::open(&session.source_text());
    let range = DisplayRange {
        start: DisplayOffset(0),
        end: DisplayOffset(fresh.display_text().len()),
    };
    let mut actual = session.project(session.revision(), range).unwrap();
    actual.revision = Revision(0);
    assert_eq!(actual, fresh.project(Revision(0), range).unwrap());
    session
        .undo(session.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(session.source_text(), source);
}

#[test]
fn a_far_caret_is_certified_directly_and_progress_keeps_its_adjacent_typing_group() {
    use std::{sync::Arc, time::Duration};
    struct Clock;
    impl HistoryClock for Clock {
        fn now(&self) -> Duration {
            Duration::ZERO
        }
    }
    let paragraph = "__😀__ &acE; [x](u) plain\n\n";
    let source = format!("```Rust\nab\n```\n\n{}", paragraph.repeat(64));
    let session = EditorSession::open_with_clock(&source, Arc::new(Clock));
    let mut bounded = session
        .into_bounded(Revision(0), SessionToken(21), DisplayOffset(0))
        .unwrap();
    bounded
        .remove_fence_closer(bounded.cursor(), &mut |_| Ok(()))
        .unwrap();
    let unchanged = bounded.cursor();
    let accepted = bounded.source_text();
    assert_eq!(
        bounded
            .insert_literal(unchanged, DisplayOffset(usize::MAX), "q", &mut |_| panic!(
                "invalid far offset appended"
            ))
            .unwrap_err(),
        BoundedError::Editor(EditorError::InvalidRange)
    );
    assert_eq!(bounded.cursor(), unchanged);
    assert_eq!(bounded.source_text(), accepted);
    let first_plain = bounded.display_text().find("plain").unwrap();
    let end = first_plain + "plain\n\n".len();
    bounded
        .select_bounded(
            bounded.cursor(),
            DisplayRange {
                start: DisplayOffset(first_plain + 2),
                end: DisplayOffset(end),
            },
            Affinity::Backward,
        )
        .unwrap();
    bounded
        .select_bounded(
            bounded.cursor(),
            DisplayRange {
                start: DisplayOffset(0),
                end: DisplayOffset(0),
            },
            Affinity::Forward,
        )
        .unwrap();
    let at = bounded.display_text().rfind("plain").unwrap() + 2;
    let selected = bounded
        .select_bounded(
            bounded.cursor(),
            DisplayRange {
                start: DisplayOffset(at),
                end: DisplayOffset(at),
            },
            Affinity::Backward,
        )
        .unwrap();
    let BoundedProgress::Change(selected) = selected else {
        panic!("far pending unit needs a real semantic frame")
    };
    assert!(
        selected.work.copied_bytes < 1024,
        "one selected unit, not every preceding unit"
    );
    let stale = bounded.continuation().unwrap();
    let first = bounded
        .insert_literal(bounded.cursor(), selected.selection.start, "x", &mut |_| {
            Ok(())
        })
        .unwrap();
    assert_eq!(
        bounded.continue_projection(stale).unwrap_err(),
        BoundedError::StaleCursor
    );
    let BoundedProgress::Change(progress) = bounded
        .continue_projection(bounded.continuation().unwrap())
        .unwrap()
    else {
        panic!("first earlier unit must advance")
    };
    assert!(
        progress.selection.start.0 > first.selection.start.0,
        "earlier raw syntax moves the far caret"
    );
    bounded
        .insert_literal(bounded.cursor(), progress.selection.start, "y", &mut |_| {
            Ok(())
        })
        .unwrap();
    bounded
        .undo_bounded(bounded.cursor(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(
        bounded.source_text(),
        format!("```Rust\nab\n\n\n{}", paragraph.repeat(64))
    );
    bounded
        .redo_bounded(bounded.cursor(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    while let Some(continuation) = bounded.continuation() {
        bounded.continue_projection(continuation).unwrap();
    }
    let expected = format!(
        "```Rust\nab\n\n\n{}__😀__ &acE; [x](u) plxyain\n\n",
        paragraph.repeat(63)
    );
    assert_eq!(bounded.source_text(), expected);
    assert_eq!(
        bounded.display_text(),
        expected
            .strip_prefix("```Rust\n")
            .unwrap()
            .strip_suffix('\n')
            .unwrap()
    );
    let (mut full, _) = bounded.materialize();
    full.undo(full.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(
        full.source_text(),
        format!("```Rust\nab\n\n\n{}", paragraph.repeat(64)),
        "background completion must not split x/y typing history"
    );
    full.undo(full.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(full.source_text(), source);
    let revision = full.revision();
    let mut pending = full
        .into_bounded(revision, SessionToken(26), DisplayOffset(0))
        .unwrap();
    pending
        .remove_fence_closer(pending.cursor(), &mut |_| Ok(()))
        .unwrap();
    let at = pending.display_text().rfind("plain").unwrap() + 2;
    pending
        .select_bounded(
            pending.cursor(),
            DisplayRange {
                start: DisplayOffset(at),
                end: DisplayOffset(at),
            },
            Affinity::Backward,
        )
        .unwrap();
    let expected = pending.source_text().rfind("plain").unwrap() + 2 - "```Rust\n".len();
    let (full, _) = pending.materialize();
    assert_eq!(
        full.selection().start,
        DisplayOffset(expected),
        "materialization follows the source anchor across unvisited earlier units"
    );
    let crlf = format!("```Rust\na\r\nb\n```\n\n{paragraph}");
    let mut bounded = EditorSession::open(&crlf)
        .into_bounded(Revision(0), SessionToken(27), DisplayOffset(0))
        .unwrap();
    let cursor = bounded.cursor();
    assert_eq!(
        bounded
            .insert_literal(cursor, DisplayOffset(2), "q", &mut |_| panic!(
                "CRLF split appended"
            ))
            .unwrap_err(),
        BoundedError::Unsupported
    );
    assert_eq!(bounded.cursor(), cursor);
    assert_eq!(bounded.source_text(), crlf);
    assert_eq!(
        bounded.last_operation_work(),
        BoundedWork {
            input_bytes: 1,
            inspected_source_bytes: 2,
            ..Default::default()
        }
    );
    let mixed = format!("```Rust\nab\r```\n\n{paragraph}");
    let rejected = EditorSession::open(&mixed)
        .into_bounded(Revision(0), SessionToken(28), DisplayOffset(0))
        .err()
        .unwrap();
    assert_eq!(rejected.error, BoundedError::Unsupported);
    assert_eq!(rejected.session.source_text(), mixed);
    assert_eq!(rejected.session.revision(), Revision(0));
}

#[test]
fn pending_closer_undo_and_redo_accept_once_and_completion_adds_no_history() {
    let paragraph = "__😀__ &acE; [x](u) plain\n\n";
    let source = format!("```Rust\nab\n```\n\n{paragraph}middle\n\n{paragraph}");
    let seed = EditorSession::open(&source);
    let session = EditorSession::open(&source);
    let shown = session.display_text();
    let mut bounded = session
        .into_bounded(Revision(0), SessionToken(22), DisplayOffset(0))
        .unwrap();
    let mut view = BoundedView::new(&seed, bounded.cursor(), SourceOffset(0));
    let changed = bounded
        .remove_fence_closer(bounded.cursor(), &mut |_| Ok(()))
        .unwrap();
    view.apply_progress(&BoundedProgress::Change(changed));
    let changed = bounded
        .continue_projection(bounded.continuation().unwrap())
        .unwrap();
    view.apply_progress(&changed);
    assert_eq!(view.text, bounded.display_text());
    let stale = bounded.continuation().unwrap();
    let accepted_source = bounded.source_text();
    let accepted_display = bounded.display_text();
    let cursor = bounded.cursor();
    let mut calls = 0;
    let refused = bounded.undo_bounded(cursor, &mut |_| {
        calls += 1;
        Err("disk".into())
    });
    assert_eq!(
        calls, 1,
        "bounded history must reach its one protected acceptance"
    );
    assert!(matches!(
        refused,
        Err(BoundedError::Editor(EditorError::Persistence(_)))
    ));
    assert_eq!(bounded.cursor(), cursor);
    assert_eq!(bounded.source_text(), accepted_source);
    assert_eq!(bounded.display_text(), accepted_display);
    let changed = bounded
        .undo_bounded(cursor, &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    view.apply_progress(&changed);
    assert_eq!(bounded.source_text(), source);
    assert_eq!(
        bounded.continue_projection(stale).unwrap_err(),
        BoundedError::StaleCursor
    );
    while let Some(continuation) = bounded.continuation() {
        let changed = bounded.continue_projection(continuation).unwrap();
        view.apply_progress(&changed);
    }
    assert_eq!(bounded.display_text(), shown);
    let mut fresh = EditorSession::open(&source);
    fresh
        .select_with_affinity(fresh.revision(), view.selection, view.affinity)
        .unwrap();
    view.assert_matches(&fresh);
    let entity = view.text.find('\u{223e}').unwrap();
    let raw = source.find("&acE;").unwrap();
    assert_eq!(
        view.source_at(DisplayOffset(entity + 3), Affinity::Backward),
        SourceOffset(raw)
    );
    assert_eq!(
        view.source_at(DisplayOffset(entity + 3), Affinity::Forward),
        SourceOffset(raw + 5)
    );
    let changed = bounded
        .redo_bounded(bounded.cursor(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    view.apply_progress(&changed);
    let mut semantic_only = false;
    while let Some(continuation) = bounded.continuation() {
        let changed = bounded.continue_projection(continuation).unwrap();
        if let BoundedProgress::Change(frame) = &changed {
            semantic_only |= frame.range.start == frame.range.end
                && frame.inserted.is_empty()
                && frame.projection.text == "middle\n\n";
        }
        view.apply_progress(&changed);
    }
    assert!(
        semantic_only,
        "plain middle bytes can stay equal while source/block meaning changes"
    );
    assert_eq!(view.text, bounded.display_text());
    assert_eq!(bounded.source_text(), accepted_source);
    let mut fresh = EditorSession::open(&accepted_source);
    fresh
        .select_with_affinity(fresh.revision(), view.selection, view.affinity)
        .unwrap();
    view.assert_matches(&fresh);
    let entity = view.text.find("&acE;").unwrap();
    let raw = accepted_source.find("&acE;").unwrap();
    for affinity in [Affinity::Backward, Affinity::Forward] {
        assert_eq!(
            view.source_at(DisplayOffset(entity + 3), affinity),
            SourceOffset(raw + 3)
        );
    }
    let (mut full, _) = bounded.materialize();
    full.undo(full.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(full.source_text(), source);
    assert!(
        full.undo(full.revision(), &mut |_| Ok(()))
            .unwrap()
            .is_none(),
        "semantic completion cannot add a source-history action"
    );
}

#[test]
fn a_certified_plain_prefix_key_moves_the_live_code_bounds_and_owner_while_pending() {
    let paragraph = "__😀__ &acE; [x](u) plain\n\n";
    let source = format!("prefix\n\n```Rust\nab\n```\n\n{paragraph}middle\n\n{paragraph}");
    let mut seed = EditorSession::open(&source);
    seed.select(
        Revision(0),
        DisplayRange {
            start: DisplayOffset(8),
            end: DisplayOffset(8),
        },
    )
    .unwrap();
    let mut session = EditorSession::open(&source);
    session
        .select(
            Revision(0),
            DisplayRange {
                start: DisplayOffset(8),
                end: DisplayOffset(8),
            },
        )
        .unwrap();
    let mut bounded = session
        .into_bounded(Revision(0), SessionToken(23), DisplayOffset(8))
        .unwrap();
    let mut view = BoundedView::new(&seed, bounded.cursor(), SourceOffset(8));
    let changed = bounded
        .remove_fence_closer(bounded.cursor(), &mut |_| Ok(()))
        .unwrap();
    view.apply_progress(&BoundedProgress::Change(changed));
    let mut calls = 0;
    let changed = bounded
        .insert_prefix_literal(bounded.cursor(), DisplayOffset(1), "x", &mut |edit| {
            calls += 1;
            assert_eq!(
                edit.range,
                SourceRange {
                    start: SourceOffset(1),
                    end: SourceOffset(1)
                }
            );
            Ok(())
        })
        .unwrap();
    assert_eq!(calls, 1);
    assert_eq!(changed.projection.text, "x");
    assert!(changed.work.copied_bytes <= 272);
    view.apply_progress(&BoundedProgress::Change(changed));
    let changed = bounded
        .insert_literal(bounded.cursor(), DisplayOffset(10), "y", &mut |edit| {
            assert_eq!(
                edit.range,
                SourceRange {
                    start: SourceOffset(18),
                    end: SourceOffset(18)
                }
            );
            Ok(())
        })
        .unwrap();
    assert_eq!(changed.projection.block.owner, SourceOffset(9));
    view.apply_code(&changed);
    let changed = bounded
        .undo_bounded(bounded.cursor(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    view.apply_progress(&changed);
    let changed = bounded
        .undo_bounded(bounded.cursor(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    view.apply_progress(&changed);
    let changed = bounded
        .redo_bounded(bounded.cursor(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    view.apply_progress(&changed);
    let changed = bounded
        .redo_bounded(bounded.cursor(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    view.apply_progress(&changed);
    while let Some(continuation) = bounded.continuation() {
        let changed = bounded.continue_projection(continuation).unwrap();
        view.apply_progress(&changed);
    }
    let expected = format!("pxrefix\n\n```Rust\nayb\n\n\n{paragraph}middle\n\n{paragraph}");
    assert_eq!(bounded.source_text(), expected);
    assert_eq!(view.text, bounded.display_text());
    let (mut full, _) = bounded.materialize();
    view.assert_matches(&full);
    full.undo(full.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    full.undo(full.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    full.undo(full.revision(), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    assert_eq!(full.source_text(), source);
    let unsupported = format!("www.\n\n```Rust\nab\n```\n\n{paragraph}");
    let mut session = EditorSession::open(&unsupported);
    let body = session.display_text().find("ab").unwrap();
    session
        .select(
            Revision(0),
            DisplayRange {
                start: DisplayOffset(body),
                end: DisplayOffset(body),
            },
        )
        .unwrap();
    let mut bounded = session
        .into_bounded(Revision(0), SessionToken(25), DisplayOffset(body))
        .unwrap();
    bounded
        .remove_fence_closer(bounded.cursor(), &mut |_| Ok(()))
        .unwrap();
    let cursor = bounded.cursor();
    let accepted = bounded.source_text();
    assert_eq!(
        bounded
            .insert_prefix_literal(cursor, DisplayOffset(4), "x", &mut |_| panic!(
                "uncertified prefix appended"
            ))
            .unwrap_err(),
        BoundedError::Unsupported
    );
    assert_eq!(bounded.cursor(), cursor);
    assert_eq!(bounded.source_text(), accepted);
}

#[path = "bounded_progress/work.rs"]
mod work;
