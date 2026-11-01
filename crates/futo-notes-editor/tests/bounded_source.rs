use futo_notes_editor::*;
use std::{sync::Arc, time::Duration};
struct Clock(u64);
impl HistoryClock for Clock {
    fn now(&self) -> Duration {
        Duration::from_secs(self.0)
    }
}

#[test]
fn far_page_input_and_inverse_do_not_replay_the_workers_presentation() {
    let paragraph = "__😀__ &acE; [x](u) plain\n\n";
    let body = "ab\n".repeat(4096);
    let source = format!("```Rust\n{body}```\n\n{}", paragraph.repeat(64));
    let mut native_worker = EditorSession::open_with_clock(&source, Arc::new(Clock(900)));
    native_worker
        .replace(Revision(0), DisplayRange::default(), "q", &mut |_| Ok(()))
        .unwrap();
    native_worker
        .undo(Revision(1), &mut |_| Ok(()))
        .unwrap()
        .unwrap();
    let mut worker = native_worker
        .into_bounded(Revision(2), SessionToken(71), DisplayOffset(0))
        .unwrap()
        .into_source_worker();
    let mut page = EditorSession::restore_with_clock(&source, Revision(2), Arc::new(Clock(0)))
        .into_bounded(Revision(2), SessionToken(71), DisplayOffset(0))
        .unwrap();
    let mut edit = None;
    page.remove_fence_closer(page.cursor(), &mut |record| {
        edit = Some(record.clone());
        Ok(())
    })
    .unwrap();
    let work = worker
        .replay_bounded_source(
            worker.source_authority(),
            &edit.take().unwrap(),
            &page.last_source_operation().unwrap(),
            &mut |_| Ok(()),
        )
        .unwrap();
    assert!(
        work.parsed_source_bytes <= 256,
        "worker reparsed {} bytes for bounded closer removal",
        work.parsed_source_bytes
    );
    let at = page.display_text().rfind("plain").unwrap() + 2;
    let selected = page
        .select_bounded(
            page.cursor(),
            DisplayRange {
                start: DisplayOffset(at),
                end: DisplayOffset(at),
            },
            Affinity::Backward,
        )
        .unwrap();
    let BoundedProgress::Change(selected) = selected else {
        panic!("far unit must be certified")
    };
    page.insert_literal(
        page.cursor(),
        selected.selection.start,
        "x",
        &mut |record| {
            edit = Some(record.clone());
            Ok(())
        },
    )
    .unwrap();
    let work = worker
        .replay_bounded_source(
            worker.source_authority(),
            &edit.take().unwrap(),
            &page.last_source_operation().unwrap(),
            &mut |_| Ok(()),
        )
        .unwrap();
    assert_eq!(work.parsed_source_bytes, 0);
    assert!(work.copied_bytes < 1024);
    page.undo_bounded(page.cursor(), &mut |record| {
        edit = Some(record.clone());
        Ok(())
    })
    .unwrap()
    .unwrap();
    let work = worker
        .replay_bounded_source(
            worker.source_authority(),
            &edit.take().unwrap(),
            &page.last_source_operation().unwrap(),
            &mut |_| Ok(()),
        )
        .unwrap();
    assert_eq!(work.parsed_source_bytes, 0);
    assert!(work.copied_bytes < 1024);
    assert_eq!(
        worker.source_text(),
        format!("```Rust\n{body}\n\n{}", paragraph.repeat(64))
    );
    page.undo_bounded(page.cursor(), &mut |record| {
        edit = Some(record.clone());
        Ok(())
    })
    .unwrap()
    .unwrap();
    assert_eq!(
        page.last_source_operation(),
        Some(BoundedSourceOperation::RestoreCloser)
    );
    worker
        .replay_bounded_source(
            worker.source_authority(),
            &edit.take().unwrap(),
            &page.last_source_operation().unwrap(),
            &mut |_| Ok(()),
        )
        .unwrap();
    assert_eq!(worker.source_text(), source);
    page.redo_bounded(page.cursor(), &mut |record| {
        edit = Some(record.clone());
        Ok(())
    })
    .unwrap()
    .unwrap();
    worker
        .replay_bounded_source(
            worker.source_authority(),
            &edit.take().unwrap(),
            &page.last_source_operation().unwrap(),
            &mut |_| Ok(()),
        )
        .unwrap();
    page.redo_bounded(page.cursor(), &mut |record| {
        edit = Some(record.clone());
        Ok(())
    })
    .unwrap()
    .unwrap();
    let inverse = edit.take().unwrap();
    let operation = page.last_source_operation().unwrap();
    let before = worker.source_text();
    let stale = BoundedSourceAuthority {
        incarnation: worker.source_authority().incarnation + 1,
        ..worker.source_authority()
    };
    assert_eq!(
        worker.replay_bounded_source(stale, &inverse, &operation, &mut |_| panic!(
            "stale authority appended"
        )),
        Err(BoundedError::StaleCursor)
    );
    assert_eq!(worker.source_text(), before);
    worker
        .replay_bounded_source(worker.source_authority(), &inverse, &operation, &mut |_| {
            Ok(())
        })
        .unwrap();
    assert_eq!(worker.source_text(), page.source_text());
    let (mut full_worker, work) = worker.materialize_source();
    assert!(work.retired_history_records > 0);
    assert!(full_worker
        .undo(full_worker.revision(), &mut |_| panic!(
            "worker cannot publish page Undo"
        ))
        .unwrap()
        .is_none());
    assert!(full_worker
        .redo(full_worker.revision(), &mut |_| panic!(
            "worker cannot revive native Redo"
        ))
        .unwrap()
        .is_none());
}

#[test]
fn restoring_a_closer_refuses_dirty_suffix_meaning_before_acceptance() {
    let source = "```Rust\nab\n```\n\nmiddle\n\ntail\n";
    let mut worker = EditorSession::open(source)
        .into_bounded(Revision(0), SessionToken(72), DisplayOffset(0))
        .unwrap()
        .into_source_worker();
    let mut edit = SourceEdit {
        previous_revision: Revision(0),
        revision: Revision(1),
        range: SourceRange {
            start: SourceOffset(11),
            end: SourceOffset(14),
        },
        removed: "```".into(),
        inserted: String::new(),
    };
    worker
        .replay_bounded_source(
            worker.source_authority(),
            &edit,
            &BoundedSourceOperation::RemoveCloser,
            &mut |_| Ok(()),
        )
        .unwrap();
    for (at, inserted) in [(13, "#"), (14, " ")] {
        edit = SourceEdit {
            previous_revision: edit.revision,
            revision: Revision(edit.revision.0 + 1),
            range: SourceRange {
                start: SourceOffset(at),
                end: SourceOffset(at),
            },
            removed: String::new(),
            inserted: inserted.into(),
        };
        worker
            .replay_bounded_source(
                worker.source_authority(),
                &edit,
                &BoundedSourceOperation::Literal { unit: Some(0) },
                &mut |_| Ok(()),
            )
            .unwrap();
    }
    let restore = SourceEdit {
        previous_revision: Revision(3),
        revision: Revision(4),
        range: SourceRange {
            start: SourceOffset(11),
            end: SourceOffset(11),
        },
        removed: String::new(),
        inserted: "```".into(),
    };
    let mut appends = 0;
    let result = worker.replay_bounded_source(
        worker.source_authority(),
        &restore,
        &BoundedSourceOperation::RestoreCloser,
        &mut |_| {
            appends += 1;
            Ok(())
        },
    );
    assert_eq!(result, Err(BoundedError::Unsupported));
    assert_eq!(appends, 0);
    assert_eq!(worker.source_text(), "```Rust\nab\n\n\n# middle\n\ntail\n");
}
