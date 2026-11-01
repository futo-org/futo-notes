use super::*;
use futo_notes_editor::{
    Affinity, BoundedFrame, BoundedProgress, EditorSession, PortableError, PortableSession,
    SessionToken,
};

#[test]
fn bounded_page_and_real_source_worker_accept_far_inverse_once_without_shared_frames() {
    let root = TestRoot::new();
    let store = store(&root);
    let body = "ab\n".repeat(4096);
    let source = format!("```Rust\n{body}```\n\n{}", "middle\n\n".repeat(64));
    store.create("", "plain", &source).unwrap();
    let host = store
        .open_editor("plain")
        .unwrap()
        .into_portable_host(SessionToken(91))
        .unwrap();
    let mut page = PortableSession::from_snapshot(host.snapshot()).unwrap();
    let mut display = EditorSession::open(&source).display_text();
    let entry = page.begin_bounded_entry(DisplayOffset(0)).unwrap();
    assert_eq!(
        page.select_with_affinity(Revision(0), range(0, 0), Affinity::Forward),
        Err(PortableError::Busy)
    );
    let mut host = host.begin_bounded_entry(entry).ok().unwrap();
    let mut page = page.complete_bounded_entry(host.ready()).unwrap();
    let remove = page.remove_fence_closer(page.cursor().unwrap()).unwrap();
    let ack = host.handle(remove.clone());
    assert!(ack.error.is_none(), "{ack:?}");
    assert_eq!(ack.work.parsed_source_bytes, 0);
    assert_eq!(page.status().displayed, Revision(0));
    assert_eq!(page.status().accepted, Revision(0));
    assert_eq!(page.status().durable, Revision(0));
    assert_eq!(host.recovery_status().accepted, Revision(1));
    assert_eq!(host.recovery_status().durable, Revision(0));
    assert!(host.recovery_status().flush_deadline.is_some());
    let refusal = page.into_full().err().expect("withheld successful Append keeps the mode handoff blocked even when page watermarks are equal");
    assert_eq!(refusal.error, PortableError::Busy);
    let mut page = *refusal.session;
    assert!(page.status().waiting);
    assert!(page.draft_text().contains("ab\n\n\nmiddle"));
    let raw_callback = "x";
    assert_eq!(
        page.select_bounded(
            futo_notes_editor::BoundedCursor {
                token: SessionToken(91),
                incarnation: 1,
                revision: Revision(1),
                generation: 1
            },
            range(0, 0),
            Affinity::Forward
        ),
        Err(PortableError::Busy)
    );
    let frame = page.acknowledge(ack.clone()).unwrap().unwrap();
    let BoundedFrame::Progress(BoundedProgress::Change(frame)) = frame else {
        panic!("closer frame")
    };
    let continuation = frame.continuation.unwrap();
    display.replace_range(frame.range.start.0..frame.range.end.0, &frame.inserted);
    assert!(page.acknowledge(ack).unwrap().is_none());
    let at = display.rfind("middle").unwrap() + 2;
    let selected = page
        .select_bounded(page.cursor().unwrap(), range(at, at), Affinity::Backward)
        .unwrap();
    let BoundedProgress::Change(selected) = selected else {
        panic!("far pending unit")
    };
    let pending = page
        .insert_literal(
            page.cursor().unwrap(),
            selected.selection.start,
            raw_callback,
        )
        .unwrap();
    assert_eq!(
        page.continue_projection(continuation),
        Err(PortableError::Busy)
    );
    let accepted = host.handle(pending.clone());
    assert_eq!(accepted.work.parsed_source_bytes, 0);
    assert!(accepted.work.copied_bytes < 1024);
    assert_eq!(host.handle(pending).accepted, accepted.accepted);
    let candidate = page.draft_text();
    assert_eq!(host.source_text(), candidate);
    // Successful Append reply is lost. Resume flushes and releases its retained
    // candidate exactly once without replaying page selection/history.
    let resume = page.resume().unwrap();
    let frame = page.acknowledge(host.handle(resume)).unwrap().unwrap();
    assert!(matches!(frame, BoundedFrame::Literal(_)));
    assert!(page.acknowledge(accepted).unwrap().is_none());
    let undo = page.undo_bounded(page.cursor().unwrap()).unwrap().unwrap();
    assert!(page.acknowledge(host.handle(undo)).unwrap().is_some());
    assert_eq!(
        host.source_text(),
        format!("```Rust\n{body}\n\n{}", "middle\n\n".repeat(64))
    );
    let undo_closer = page.undo_bounded(page.cursor().unwrap()).unwrap().unwrap();
    assert!(page
        .acknowledge(host.handle(undo_closer))
        .unwrap()
        .is_some());
    assert_eq!(host.source_text(), source);
    let cursor_before_flush = page.cursor().unwrap();
    let deadline_before_flush = host.recovery_status().flush_deadline;
    assert!(deadline_before_flush.is_some());
    let refusal = page
        .into_full()
        .err()
        .expect("page materialization must wait for the accepted-prefix Flush barrier");
    assert_eq!(refusal.error, PortableError::Busy);
    let mut page = *refusal.session;
    assert_eq!(page.cursor().unwrap(), cursor_before_flush);
    assert_eq!(host.recovery_status().flush_deadline, deadline_before_flush);
    let flush = page.flush().unwrap();
    let old_ack = host.handle(flush);
    page.acknowledge(old_ack.clone()).unwrap();
    let (mut page, _) = page.into_full().unwrap();
    let host = host.into_full().ok().unwrap();
    let entry = page.begin_bounded_entry(DisplayOffset(0)).unwrap();
    let mut host = host.begin_bounded_entry(entry).ok().unwrap();
    let mut page = page.complete_bounded_entry(host.ready()).unwrap();
    let next = page
        .insert_literal(page.cursor().unwrap(), DisplayOffset(0), "q")
        .unwrap();
    let mut stale = old_ack;
    stale.sequence = next.sequence;
    assert!(
        page.acknowledge(stale).unwrap().is_none(),
        "old mode cannot release a same-source-revision frame"
    );
    assert!(page.status().waiting);
    assert!(page.acknowledge(host.handle(next)).unwrap().is_some());
    assert_eq!(host.source_text(), page.draft_text());
}

#[test]
fn refused_or_canceled_mode_handshake_preserves_full_lost_ack_authority() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "```\nab\n```\n").unwrap();
    let mut host = store
        .open_editor("plain")
        .unwrap()
        .into_portable_host(SessionToken(92))
        .unwrap();
    let mut page = PortableSession::from_snapshot(host.snapshot()).unwrap();
    let pending = page.replace(Revision(0), range(0, 0), "x").unwrap();
    let lost = host.handle(pending.clone());
    assert!(matches!(
        page.begin_bounded_entry(DisplayOffset(0)),
        Err(PortableError::Busy)
    ));
    let retry = host.handle(pending.clone());
    assert_eq!(retry.error, lost.error);
    assert_eq!(retry.accepted, Revision(1));
    assert!(page.acknowledge(retry).unwrap().is_some());
    assert!(page.acknowledge(lost).unwrap().is_none());
    let entry = page.begin_bounded_entry(DisplayOffset(0)).unwrap();
    let host = host.begin_bounded_entry(entry).ok().unwrap();
    let mut mismatched = host.ready();
    mismatched.request.body_caret = DisplayOffset(usize::MAX);
    let failure = page.complete_bounded_entry(mismatched).err().unwrap();
    let mut page = failure.session;
    let mut host = host.cancel_bounded_entry().ok().unwrap();
    page.cancel_bounded_entry();
    let retry = host.handle(pending);
    assert_eq!(retry.accepted, Revision(1));
    assert!(
        retry.error.is_none(),
        "canceled entry restores the original successful receipt"
    );
    assert!(page.acknowledge(retry).unwrap().is_none());
    let entry = page.begin_bounded_entry(DisplayOffset(0)).unwrap();
    let host = host.begin_bounded_entry(entry).ok().unwrap();
    let mut page = page.complete_bounded_entry(host.ready()).unwrap();
    assert!(page
        .insert_literal(page.cursor().unwrap(), DisplayOffset(1), "y")
        .is_ok());
}

#[test]
fn bounded_rejected_candidate_and_raw_callback_remain_distinct_through_resume() {
    use storage::{Disk, Fault};
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "```\nab\n```\n").unwrap();
    let disk = Arc::new(Mutex::new(Disk::default()));
    let mut host = store
        .open_editor_with_recovery("plain", storage::options(&disk))
        .unwrap()
        .into_portable_host(SessionToken(93))
        .unwrap();
    let mut page = PortableSession::from_snapshot(host.snapshot()).unwrap();
    let initial = page.replace(Revision(0), range(0, 0), "x").unwrap();
    page.acknowledge(host.handle(initial)).unwrap();
    let entry = page.begin_bounded_entry(DisplayOffset(0)).unwrap();
    let mut host = host.begin_bounded_entry(entry).ok().unwrap();
    let mut page = page.complete_bounded_entry(host.ready()).unwrap();
    let old_cursor = page.cursor().unwrap();
    let pending = page
        .insert_literal(old_cursor, DisplayOffset(0), "q")
        .unwrap();
    disk.lock().unwrap().fault = Some(Fault::Append);
    let failed = host.handle(pending);
    assert!(failed.error.is_some());
    assert!(page.acknowledge(failed).unwrap().is_none());
    let retained_raw = "β".encode_utf16().collect::<Vec<_>>();
    assert_eq!(
        page.insert_literal_utf16(old_cursor, DisplayOffset(0), &retained_raw),
        Err(PortableError::Paused)
    );
    assert_eq!(
        page.draft_text(),
        "```\nqxab\n```\n",
        "portable Copy Draft names the retained candidate"
    );
    assert_eq!(
        host.source_text(),
        "```\nxab\n```\n",
        "worker still owns only accepted source"
    );
    disk.lock().unwrap().fault = None;
    let resume = page.resume().unwrap();
    assert!(page.acknowledge(host.handle(resume)).unwrap().is_none());
    let retry = page.retry_pending().unwrap();
    let accepted = host.handle(retry.clone());
    assert!(accepted.error.is_none());
    assert_eq!(host.handle(retry).accepted, accepted.accepted);
    assert!(page.acknowledge(accepted.clone()).unwrap().is_some());
    assert!(page.acknowledge(accepted).unwrap().is_none());
    assert_eq!(page.draft_text(), host.source_text());
    assert_eq!(
        page.insert_literal_utf16(old_cursor, DisplayOffset(0), &retained_raw),
        Err(PortableError::Bounded(
            futo_notes_editor::BoundedError::StaleCursor
        )),
        "retention does not rebase an old callback"
    );
    assert_eq!(retained_raw, vec![0x03b2]);
    // A newly addressed callback may now use the retained text. Its Rust
    // UTF-16 read and UTF-8 conversion are part of the returned page work.
    let delivered = page
        .insert_literal_utf16(page.cursor().unwrap(), DisplayOffset(0), &retained_raw)
        .unwrap();
    let frame = page.acknowledge(host.handle(delivered)).unwrap().unwrap();
    let BoundedFrame::Literal(frame) = frame else {
        panic!("literal UTF-16 input")
    };
    assert_eq!(frame.work.input_bytes, 4);
    let current = page.cursor().unwrap();
    let flush = page.flush().unwrap();
    assert_eq!(
        page.select_bounded(current, range(0, 0), Affinity::Forward),
        Err(PortableError::Busy)
    );
    page.acknowledge(host.handle(flush)).unwrap();
}

#[test]
fn bounded_registry_reset_materializes_a_retained_candidate_for_full_retry() {
    use storage::{Disk, Fault};
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "```\nab\n```\n").unwrap();
    let disk = Arc::new(Mutex::new(Disk::default()));
    let mut host = store
        .open_editor_with_recovery("plain", storage::options(&disk))
        .unwrap()
        .into_portable_host(SessionToken(94))
        .unwrap();
    let mut page = PortableSession::from_snapshot(host.snapshot()).unwrap();
    let initial = page.replace(Revision(0), range(0, 0), "x").unwrap();
    page.acknowledge(host.handle(initial)).unwrap();
    let entry = page.begin_bounded_entry(DisplayOffset(0)).unwrap();
    let mut host = host.begin_bounded_entry(entry).ok().unwrap();
    let mut page = page.complete_bounded_entry(host.ready()).unwrap();
    let pending = page
        .insert_literal(page.cursor().unwrap(), DisplayOffset(0), "q")
        .unwrap();
    disk.lock().unwrap().fault = Some(Fault::Create);
    assert!(store.rename("plain", "renamed").is_err());
    let rejected = host.handle(pending);
    assert!(rejected.reset_required);
    assert!(page.acknowledge(rejected).unwrap().is_none());
    assert_eq!(page.draft_text(), "```\nqxab\n```\n");
    disk.lock().unwrap().fault = None;
    let mut host = host.into_full().ok().unwrap();
    let (mut page, work) = page
        .into_full()
        .ok()
        .expect("explicit proportional handoff must retain the rejected candidate for Full retry");
    assert!(work.returned_text_bytes >= 4);
    assert_eq!(page.draft_text(), "```\nqxab\n```\n");
    let resume = page.resume().unwrap();
    assert!(page.acknowledge(host.handle(resume)).unwrap().is_none());
    let retry = page.retry_pending().unwrap();
    let accepted = host.handle(retry.clone());
    assert_eq!(host.handle(retry).accepted, accepted.accepted);
    let frame = page.acknowledge(accepted.clone()).unwrap().unwrap();
    assert_eq!(frame.range, range(0, 3));
    assert_eq!(frame.inserted, "qxab");
    assert_eq!(frame.projection.text, "qxab");
    assert!(page.acknowledge(accepted).unwrap().is_none());
    assert_eq!(host.snapshot().source, page.draft_text());
    let undo = page.undo(Revision(2)).unwrap().unwrap();
    page.acknowledge(host.handle(undo)).unwrap().unwrap();
    assert_eq!(page.draft_text(), "```\nxab\n```\n");
    // The next bounded Append succeeds, but its reply is lost before registry
    // materialization. Legacy Resume releases a full reset without retrying it.
    let entry = page.begin_bounded_entry(DisplayOffset(0)).unwrap();
    let mut host = host.begin_bounded_entry(entry).ok().unwrap();
    let mut page = page.complete_bounded_entry(host.ready()).unwrap();
    let pending = page
        .insert_literal(page.cursor().unwrap(), DisplayOffset(0), "y")
        .unwrap();
    let lost = host.handle(pending);
    assert!(lost.error.is_none());
    disk.lock().unwrap().fault = Some(Fault::Create);
    assert!(store.rename("plain", "renamed").is_err());
    let resume = page.resume().unwrap();
    let reset = host.handle(resume);
    assert!(reset.reset_required);
    assert_eq!(reset.accepted, Revision(4));
    assert!(page.acknowledge(reset).unwrap().is_none());
    disk.lock().unwrap().fault = None;
    let mut host = host.into_full().ok().unwrap();
    let (mut page, _) = page.into_full().ok().unwrap();
    let resume = page.resume().unwrap();
    let ack = host.handle(resume);
    let frame = page.acknowledge(ack.clone()).unwrap().unwrap();
    assert_eq!(frame.range, range(0, 3));
    assert_eq!(frame.inserted, "yxab");
    assert_eq!(frame.projection.text, "yxab");
    assert!(frame.projection.blocks.iter().any(|block| block.code));
    assert!(frame
        .projection
        .correspondence
        .iter()
        .any(|part| part.display.start == part.display.end));
    assert!(frame.work.link_copied_bytes >= 8);
    assert!(page.acknowledge(ack).unwrap().is_none());
    assert_eq!(host.snapshot().source, "```\nyxab\n```\n");
}
