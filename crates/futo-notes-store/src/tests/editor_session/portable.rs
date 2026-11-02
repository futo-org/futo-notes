use super::*;
use futo_notes_editor::{PortableSession, SessionToken};

#[test]
fn portable_composition_refuses_relink_offer_and_commits_under_retargeted_identity() {
    use futo_notes_editor::{DisplayUtf16Offset, DisplayUtf16Range};
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "[[old]]").unwrap();
    let mut host = store
        .open_editor("old")
        .unwrap()
        .into_portable_host(SessionToken(132))
        .unwrap();
    let mut page = PortableSession::from_snapshot(host.snapshot()).unwrap();
    page.compose_utf16(
        Revision(0),
        DisplayUtf16Range {
            start: DisplayUtf16Offset(7),
            end: DisplayUtf16Offset(7),
        },
        &"にほん".encode_utf16().collect::<Vec<_>>(),
    )
    .unwrap();
    store.rename("old", "long name").unwrap();
    let poll = page.flush().unwrap();
    page.acknowledge(host.handle(poll)).unwrap();
    assert!(page.apply_relink_offer().unwrap().is_none());
    assert_eq!(page.composition().unwrap().text, "にほん");
    let request = page
        .commit_composition_utf16(
            Revision(0),
            Some(&"日本".encode_utf16().collect::<Vec<_>>()),
        )
        .unwrap()
        .unwrap();
    let change = page.acknowledge(host.handle(request)).unwrap().unwrap();
    let mut view = "[[old]]".to_owned();
    view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
    assert_eq!(view, "[[old]]日本");
    assert_eq!(page.draft_text(), "[[old]]日本");
    assert_eq!(host.id(), "long name");
    host.checkpoint().unwrap();
    assert_eq!(store.read("long name").unwrap(), "[[old]]日本");
    assert_eq!(store.read_existing("old").unwrap(), None);
}

#[test]
fn portable_own_relink_is_one_appended_undo_step_before_display() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "[[old]]").unwrap();
    let mut host = store
        .open_editor("old")
        .unwrap()
        .into_portable_host(SessionToken(131))
        .unwrap();
    let mut page = PortableSession::from_snapshot(host.snapshot()).unwrap();
    let mut view = "[[old]]".to_owned();
    let input = page.replace(Revision(0), range(7, 7), "!").unwrap();
    let change = page.acknowledge(host.handle(input)).unwrap().unwrap();
    view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
    host.checkpoint().unwrap();
    store.rename("old", "long name").unwrap();
    assert_eq!(host.id(), "long name");
    let poll = page.flush().unwrap();
    let offer_ack = host.handle(poll);
    assert!(offer_ack.relink.is_some());
    assert!(page.acknowledge(offer_ack.clone()).unwrap().is_none());
    let relink = page.apply_relink_offer().unwrap().unwrap();
    assert_eq!(view, "[[old]]!");
    assert_eq!(page.draft_text(), "[[long name]]!");
    let accepted = host.handle(relink.clone());
    assert_eq!(host.handle(relink), accepted);
    let change = page.acknowledge(accepted.clone()).unwrap().unwrap();
    view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
    assert_eq!(view, "[[long name]]!");
    assert!(page.acknowledge(accepted).unwrap().is_none());
    assert!(page.acknowledge(offer_ack).unwrap().is_none());
    let undo = page.undo(Revision(2)).unwrap().unwrap();
    let change = page.acknowledge(host.handle(undo)).unwrap().unwrap();
    view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
    assert_eq!(view, "[[old]]!");
    assert_eq!(page.draft_text(), "[[old]]!");
    let redo = page.redo(Revision(3)).unwrap().unwrap();
    let change = page.acknowledge(host.handle(redo)).unwrap().unwrap();
    view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
    assert_eq!(view, "[[long name]]!");
    host.checkpoint().unwrap();
    assert_eq!(store.read("long name").unwrap(), "[[long name]]!");
}

#[test]
fn portable_relink_never_advances_the_worker_past_unacknowledged_page_source() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "old", "[[old]]").unwrap();
    let mut host = store
        .open_editor("old")
        .unwrap()
        .into_portable_host(SessionToken(130))
        .unwrap();
    let mut page = PortableSession::from_snapshot(host.snapshot()).unwrap();
    let pending = page.replace(Revision(0), range(7, 7), "!").unwrap();
    store.rename("old", "long name").unwrap();
    let ack = host.handle(pending);
    assert!(ack.error.is_none(), "{ack:?}");
    let change = page.acknowledge(ack).unwrap().unwrap();
    assert_eq!(change.inserted, "!");
    assert_eq!(page.draft_text(), "[[old]]!");
    drop(host);
    let mut current = store.open_editor("long name").unwrap();
    assert_eq!(current.source_text(), "[[old]]!");
    current.checkpoint().unwrap();
    assert_eq!(store.read("long name").unwrap(), "[[old]]!");
    assert_eq!(store.read_existing("old").unwrap(), None);
}

#[test]
fn worker_append_ack_is_distinct_from_page_completion_and_durable_flush() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let mut host = store
        .open_editor("plain")
        .unwrap()
        .into_portable_host(SessionToken(41))
        .unwrap();
    let mut page = PortableSession::open(SessionToken(41), "plain", Revision(0), Revision(0));
    let request = page.replace(Revision(0), range(5, 5), "!").unwrap();
    assert_eq!(page.status().accepted, Revision(0));
    let ack = host.handle(request.clone());
    assert_eq!(ack.accepted, Revision(1));
    assert_eq!(ack.durable, Revision(0));
    assert_eq!(host.handle(request.clone()), ack);
    assert_eq!(page.acknowledge(ack).unwrap().unwrap().inserted, "!");
    let flush = page.flush().unwrap();
    let durable = host.handle(flush);
    page.acknowledge(durable).unwrap();
    assert_eq!(page.status().durable, Revision(1));
    let mut wrong = request;
    wrong.token = SessionToken(42);
    assert!(host.handle(wrong).error.is_some());
    drop(host);
    assert_eq!(store.open_editor("plain").unwrap().source_text(), "plain!");
    assert_eq!(store.read("plain").unwrap(), "plain");
}

#[test]
fn page_and_worker_exchange_small_edits_without_running_storage_on_the_page_thread() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "a\r\n").unwrap();
    std::thread::scope(|scope| {
        let (send, receive) = std::sync::mpsc::channel();
        let (reply, replies) = std::sync::mpsc::channel();
        let worker_store = &store;
        scope.spawn(move || {
            let mut host = worker_store
                .open_editor("plain")
                .unwrap()
                .into_portable_host(SessionToken(50))
                .unwrap();
            for request in receive {
                reply.send(host.handle(request)).unwrap();
            }
        });
        let mut page = PortableSession::open(SessionToken(50), "a\r\n", Revision(0), Revision(0));
        let request = page.replace(Revision(0), range(1, 1), "🎉").unwrap();
        let futo_notes_editor::HostOperation::Append(edit) = &request.operation else {
            panic!()
        };
        assert_eq!(edit.inserted, "🎉");
        assert_eq!(edit.removed, "");
        let mut view = "a\r\n".to_owned();
        send.send(request).unwrap();
        assert_eq!(view, "a\r\n");
        let change = page.acknowledge(replies.recv().unwrap()).unwrap().unwrap();
        view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
        assert_eq!(view, "a🎉\r\n");
        send.send(page.undo(Revision(1)).unwrap().unwrap()).unwrap();
        let change = page.acknowledge(replies.recv().unwrap()).unwrap().unwrap();
        view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
        assert_eq!(view, "a\r\n");
        send.send(page.redo(Revision(2)).unwrap().unwrap()).unwrap();
        let change = page.acknowledge(replies.recv().unwrap()).unwrap().unwrap();
        view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
        assert_eq!(view, "a🎉\r\n");
        send.send(page.flush().unwrap()).unwrap();
        page.acknowledge(replies.recv().unwrap()).unwrap();
        assert_eq!(page.status().durable, Revision(3));
        drop(send);
    });
    assert_eq!(store.open_editor("plain").unwrap().source_text(), "a🎉\r\n");
}

#[test]
fn interruptions_lose_only_an_unhanded_active_edit_and_never_a_displayed_backlog() {
    for phase in ["before handoff", "after handoff", "after acknowledgement"] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "plain", "plain").unwrap();
        let mut host = store
            .open_editor("plain")
            .unwrap()
            .into_portable_host(SessionToken(60))
            .unwrap();
        let mut page = PortableSession::open(SessionToken(60), "plain", Revision(0), Revision(0));
        let first = page.replace(Revision(0), range(5, 5), "!").unwrap();
        page.acknowledge(host.handle(first)).unwrap().unwrap();
        let active = page.replace(Revision(1), range(6, 6), "?").unwrap();
        if phase != "before handoff" {
            let ack = host.handle(active);
            if phase == "after acknowledgement" {
                page.acknowledge(ack).unwrap().unwrap();
            }
        }
        drop(page);
        drop(host);
        let recovered = store.open_editor("plain").unwrap();
        let expected = if phase == "before handoff" {
            "plain!"
        } else {
            "plain!?"
        };
        assert_eq!(recovered.source_text(), expected, "{phase}");
    }
}

#[test]
fn failed_worker_append_retains_active_draft_repairs_and_retries_exactly_once() {
    for fault in [storage::Fault::Append, storage::Fault::ShortWrite] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "plain", "plain").unwrap();
        let disk = Arc::new(Mutex::new(storage::Disk::default()));
        let mut host = store
            .open_editor_with_recovery("plain", storage::options(&disk))
            .unwrap()
            .into_portable_host(SessionToken(70))
            .unwrap();
        let mut page = PortableSession::open(SessionToken(70), "plain", Revision(0), Revision(0));
        let first = page.replace(Revision(0), range(5, 5), "!").unwrap();
        page.acknowledge(host.handle(first)).unwrap().unwrap();
        disk.lock().unwrap().fault = Some(fault);
        let active = page.replace(Revision(1), range(6, 6), "?").unwrap();
        let failed = host.handle(active);
        assert!(failed.error.is_some());
        assert!(page.acknowledge(failed.clone()).unwrap().is_none());
        assert!(page.status().paused);
        assert_eq!(page.status().displayed, Revision(1));
        assert_eq!(page.draft_text(), "plain!?");
        disk.lock().unwrap().fault = None;
        let resume = page.resume().unwrap();
        assert!(page.acknowledge(host.handle(resume)).unwrap().is_none());
        assert_eq!(page.status().durable, Revision(1));
        let retry = page.retry_pending().unwrap();
        let accepted = host.handle(retry.clone());
        assert_eq!(host.handle(retry), accepted);
        assert_eq!(page.acknowledge(accepted).unwrap().unwrap().inserted, "?");
        assert!(page.acknowledge(failed).unwrap().is_none());
        drop(host);
        assert_eq!(
            store
                .open_editor_with_recovery("plain", storage::options(&disk))
                .unwrap()
                .source_text(),
            "plain!?"
        );
    }
}

#[test]
fn failed_worker_flush_never_claims_durable_and_resume_flushes_before_unpausing() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let disk = Arc::new(Mutex::new(storage::Disk::default()));
    let mut host = store
        .open_editor_with_recovery("plain", storage::options(&disk))
        .unwrap()
        .into_portable_host(SessionToken(80))
        .unwrap();
    let mut page = PortableSession::open(SessionToken(80), "plain", Revision(0), Revision(0));
    let request = page.replace(Revision(0), range(5, 5), "!").unwrap();
    page.acknowledge(host.handle(request)).unwrap().unwrap();
    disk.lock().unwrap().fault = Some(storage::Fault::Flush);
    let flush = page.flush().unwrap();
    let failed = host.handle(flush);
    assert!(failed.error.is_some());
    page.acknowledge(failed).unwrap();
    assert_eq!(page.status().accepted, Revision(1));
    assert_eq!(page.status().durable, Revision(0));
    assert!(page.status().paused);
    let resume = page.resume().unwrap();
    page.acknowledge(host.handle(resume)).unwrap();
    assert!(page.status().paused);
    disk.lock().unwrap().fault = None;
    let resume = page.resume().unwrap();
    page.acknowledge(host.handle(resume)).unwrap();
    assert!(!page.status().paused);
    assert_eq!(page.status().durable, Revision(1));
    assert_eq!(page.draft_text(), "plain!");
    drop(host);
    disk.lock().unwrap().power_loss();
    assert_eq!(
        store
            .open_editor_with_recovery("plain", storage::options(&disk))
            .unwrap()
            .source_text(),
        "plain!"
    );
}

#[test]
fn foreign_or_conflicting_source_records_never_append_or_apply_twice() {
    use futo_notes_editor::HostOperation;
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let mut host = store
        .open_editor("plain")
        .unwrap()
        .into_portable_host(SessionToken(90))
        .unwrap();
    let mut page = PortableSession::open(SessionToken(90), "plain", Revision(0), Revision(0));
    let request = page.replace(Revision(0), range(0, 5), "other").unwrap();
    let mut invalid = request.clone();
    let HostOperation::Append(edit) = &mut invalid.operation else {
        panic!()
    };
    edit.removed = "foreign".into();
    assert!(host.handle(invalid).error.is_some());
    let mut retry = request.clone();
    retry.sequence += 1;
    let accepted = host.handle(retry.clone());
    assert_eq!(accepted.accepted, Revision(1));
    assert!(accepted.error.is_none());
    assert!(host.handle(request).error.is_some());
    retry.sequence += 1;
    assert!(host.handle(retry).error.is_some());
    drop(host);
    assert_eq!(store.open_editor("plain").unwrap().source_text(), "other");
}

#[test]
fn continuous_page_handoffs_do_not_postpone_the_workers_oldest_flush_deadline() {
    use std::sync::atomic::{AtomicU64, Ordering};
    struct Clock(AtomicU64);
    impl RecoveryClock for Clock {
        fn now(&self) -> std::time::Duration {
            std::time::Duration::from_millis(self.0.load(Ordering::SeqCst))
        }
    }
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let clock = Arc::new(Clock(AtomicU64::new(10)));
    let options = RecoveryOptions {
        clock: clock.clone(),
        ..RecoveryOptions::default()
    };
    let mut host = store
        .open_editor_with_recovery("plain", options)
        .unwrap()
        .into_portable_host(SessionToken(100))
        .unwrap();
    let mut page = PortableSession::from_snapshot(host.snapshot()).unwrap();
    let first = page.replace(Revision(0), range(5, 5), "!").unwrap();
    page.acknowledge(host.handle(first)).unwrap().unwrap();
    assert_eq!(
        host.recovery_flush_delay(),
        Some(std::time::Duration::from_millis(100))
    );
    clock.0.store(99, Ordering::SeqCst);
    let second = page.replace(Revision(1), range(6, 6), "?").unwrap();
    page.acknowledge(host.handle(second)).unwrap().unwrap();
    assert_eq!(
        host.recovery_flush_delay(),
        Some(std::time::Duration::from_millis(11))
    );
    clock.0.store(150, Ordering::SeqCst);
    assert_eq!(host.recovery_flush_delay(), Some(std::time::Duration::ZERO));
    assert_eq!(page.status().durable, Revision(0));
    let request = page.flush().unwrap();
    page.acknowledge(host.handle(request)).unwrap();
    assert_eq!(page.status().durable, Revision(2));
    assert_eq!(host.recovery_flush_delay(), None);
}

#[test]
fn healthy_worker_resume_flushes_an_edit_whose_append_reply_was_lost() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let mut host = store
        .open_editor("plain")
        .unwrap()
        .into_portable_host(SessionToken(110))
        .unwrap();
    let mut page = PortableSession::from_snapshot(host.snapshot()).unwrap();
    let request = page.replace(Revision(0), range(5, 5), "!").unwrap();
    let lost_reply = host.handle(request);
    assert_eq!(lost_reply.durable, Revision(0));
    let resume = page.resume().unwrap();
    assert_eq!(
        page.acknowledge(host.handle(resume))
            .unwrap()
            .unwrap()
            .inserted,
        "!"
    );
    assert_eq!(page.status().durable, Revision(1));
    assert!(page.acknowledge(lost_reply).unwrap().is_none());
}

#[test]
fn worker_retains_typed_recovery_review_and_page_pause_across_attach_and_resume() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let disk = Arc::new(Mutex::new(storage::Disk::default()));
    {
        let mut editor = store
            .open_editor_with_recovery("plain", storage::options(&disk))
            .unwrap();
        editor.replace(Revision(0), range(5, 5), "!").unwrap();
    }
    disk.lock().unwrap().accepted.values_mut().next().unwrap()[0] = b'!';
    let before = disk.lock().unwrap().accepted.clone();
    let mut host = store
        .open_editor_with_recovery("plain", storage::options(&disk))
        .unwrap()
        .into_portable_host(SessionToken(120))
        .unwrap();
    assert_eq!(
        host.recovery_issue().as_ref(),
        Some(&RecoveryIssue {
            kind: RecoveryIssueKind::CorruptRecord,
            record: 0
        })
    );
    let mut page = PortableSession::from_snapshot(host.snapshot()).unwrap();
    assert_eq!(page.draft_text(), "plain");
    assert!(page.status().paused);
    let request = page.resume().unwrap();
    let ack = host.handle(request);
    assert!(ack.error.is_some());
    page.acknowledge(ack).unwrap();
    assert!(page.status().paused);
    assert_eq!(page.status().durable, Revision(0));
    assert_eq!(disk.lock().unwrap().accepted, before);
}
