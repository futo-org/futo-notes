use super::*;
use futo_notes_editor::{PortableSession, SessionToken};

/// An assertion may unwind before the successful end of the test body. Release
/// the held gate before `thread::scope` joins its worker on either path.
struct ReleaseGateOnDrop(mpsc::Sender<()>);

impl Drop for ReleaseGateOnDrop {
    fn drop(&mut self) {
        // The worker may itself have failed; a destructor must not double-panic.
        let _ = self.0.send(());
    }
}

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
    let poll = page.resume().unwrap();
    page.acknowledge(host.handle(poll)).unwrap();
    assert!(page.apply_relink_offer().unwrap().is_none());
    assert_eq!(page.composition().unwrap().text, "にほん");
    let applied = page
        .commit_composition_utf16(
            Revision(0),
            Some(&"日本".encode_utf16().collect::<Vec<_>>()),
        )
        .unwrap()
        .unwrap();
    let change = applied.change;
    page.acknowledge(host.handle(applied.request)).unwrap();
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
fn portable_own_relink_is_one_appended_undo_step() {
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
    let change = input.change;
    view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
    page.acknowledge(host.handle(input.request)).unwrap();
    host.checkpoint().unwrap();
    store.rename("old", "long name").unwrap();
    assert_eq!(host.id(), "long name");
    let poll = page.resume().unwrap();
    let offer_ack = host.handle(poll);
    assert!(offer_ack.relink.is_some());
    assert!(page.acknowledge(offer_ack.clone()).unwrap().is_empty());
    let relink = page.apply_relink_offer().unwrap().unwrap();
    let change = relink.change;
    view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
    assert_eq!(view, "[[long name]]!");
    assert_eq!(page.draft_text(), "[[long name]]!");
    let accepted = host.handle(relink.request.clone());
    assert_eq!(host.handle(relink.request), accepted);
    assert!(page.acknowledge(accepted.clone()).unwrap().is_empty());
    assert!(page.acknowledge(accepted).unwrap().is_empty());
    assert!(page.acknowledge(offer_ack).unwrap().is_empty());
    let undo = page.undo(Revision(2)).unwrap().unwrap();
    let change = undo.change;
    page.acknowledge(host.handle(undo.request)).unwrap();
    view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
    assert_eq!(view, "[[old]]!");
    assert_eq!(page.draft_text(), "[[old]]!");
    let redo = page.redo(Revision(3)).unwrap().unwrap();
    let change = redo.change;
    page.acknowledge(host.handle(redo.request)).unwrap();
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
    assert_eq!(pending.change.inserted, "!");
    let ack = host.handle(pending.request);
    assert!(ack.error.is_none(), "{ack:?}");
    assert!(page.acknowledge(ack).unwrap().is_empty());
    assert_eq!(page.draft_text(), "[[old]]!");
    host.checkpoint().unwrap();
    assert_eq!(store.read("long name").unwrap(), "[[old]]!");
    assert_eq!(store.read_existing("old").unwrap(), None);
}

#[test]
fn worker_append_ack_is_distinct_from_page_completion() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let mut host = store
        .open_editor("plain")
        .unwrap()
        .into_portable_host(SessionToken(41))
        .unwrap();
    let mut page = PortableSession::open(SessionToken(41), "plain", Revision(0));
    let request = page.replace(Revision(0), range(5, 5), "!").unwrap().request;
    assert_eq!(page.status().accepted, Revision(0));
    let ack = host.handle(request.clone());
    assert_eq!(ack.accepted, Revision(1));
    assert_eq!(host.handle(request.clone()), ack);
    page.acknowledge(ack).unwrap();
    assert_eq!(page.status().accepted, Revision(1));
    let mut wrong = request;
    wrong.token = SessionToken(42);
    assert_eq!(
        host.handle(wrong).error.map(|error| error.kind),
        Some(futo_notes_editor::HostErrorKind::StaleToken)
    );
    assert_eq!(store.read("plain").unwrap(), "plain");
    host.checkpoint().unwrap();
    assert_eq!(store.read("plain").unwrap(), "plain!");
}

#[test]
fn page_and_worker_exchange_small_edits_without_running_store_work_on_the_page_thread() {
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
            host.checkpoint().unwrap();
        });
        let mut page = PortableSession::open(SessionToken(50), "a\r\n", Revision(0));
        let applied = page.replace(Revision(0), range(1, 1), "🎉").unwrap();
        let request = applied.request;
        let futo_notes_editor::HostOperation::Append(edit) = &request.operation else {
            panic!()
        };
        assert_eq!(edit.inserted, "🎉");
        assert_eq!(edit.removed, "");
        let mut view = "a\r\n".to_owned();
        let change = applied.change;
        view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
        assert_eq!(
            view, "a🎉\r\n",
            "the page shows the edit before the worker replies"
        );
        send.send(request).unwrap();
        page.acknowledge(replies.recv().unwrap()).unwrap();
        let undo = page.undo(Revision(1)).unwrap().unwrap();
        let change = undo.change;
        view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
        assert_eq!(view, "a\r\n");
        send.send(undo.request).unwrap();
        page.acknowledge(replies.recv().unwrap()).unwrap();
        let redo = page.redo(Revision(2)).unwrap().unwrap();
        let change = redo.change;
        view.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
        assert_eq!(view, "a🎉\r\n");
        send.send(redo.request).unwrap();
        page.acknowledge(replies.recv().unwrap()).unwrap();
        drop(send);
    });
    assert_eq!(store.read("plain").unwrap(), "a🎉\r\n");
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
    let mut page = PortableSession::open(SessionToken(90), "plain", Revision(0));
    let request = page
        .replace(Revision(0), range(0, 5), "other")
        .unwrap()
        .request;
    let mut invalid = request.clone();
    let HostOperation::Append(edit) = &mut invalid.operation else {
        panic!()
    };
    edit.removed = "foreign".into();
    assert!(host.handle(invalid).error.is_some());
    // A refused edit still consumes its sequence number.
    let mut retry = request.clone();
    retry.sequence += 1;
    let accepted = host.handle(retry.clone());
    assert_eq!(accepted.accepted, Revision(1));
    assert!(accepted.error.is_none());
    assert_eq!(
        host.handle(request).error.map(|error| error.kind),
        Some(futo_notes_editor::HostErrorKind::Rejected),
        "an old sequence is out of order"
    );
    retry.sequence += 1;
    assert!(
        host.handle(retry).error.is_some(),
        "a replayed edit is refused"
    );
    host.checkpoint().unwrap();
    assert_eq!(store.read("plain").unwrap(), "other");
}

#[test]
fn worker_resume_reports_an_edit_whose_append_reply_was_lost() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let mut host = store
        .open_editor("plain")
        .unwrap()
        .into_portable_host(SessionToken(110))
        .unwrap();
    let mut page = PortableSession::from_snapshot(host.snapshot()).unwrap();
    let request = page.replace(Revision(0), range(5, 5), "!").unwrap().request;
    let lost_reply = host.handle(request);
    let resume = page.resume().unwrap();
    assert!(page.acknowledge(host.handle(resume)).unwrap().is_empty());
    assert_eq!(page.status().accepted, Revision(1));
    assert_eq!(page.status().outstanding, 0);
    assert!(page.acknowledge(lost_reply).unwrap().is_empty());
}

fn host_for<'a>(
    store: &'a LocalNoteStore,
    id: &str,
    token: u64,
) -> (crate::StoreEditorHost<'a>, PortableSession) {
    let host = store
        .open_editor(id)
        .unwrap()
        .into_portable_host(SessionToken(token))
        .unwrap();
    let page = PortableSession::from_snapshot(host.snapshot()).unwrap();
    (host, page)
}

#[test]
fn worker_rejects_gapped_and_out_of_order_sequences_and_treats_a_repeat_as_idempotent() {
    use futo_notes_editor::HostErrorKind;
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "").unwrap();
    let (mut host, mut page) = host_for(&store, "plain", 150);
    let one = page.replace(Revision(0), range(0, 0), "a").unwrap().request;
    let two = page.replace(Revision(1), range(1, 1), "b").unwrap().request;
    let three = page.replace(Revision(2), range(2, 2), "c").unwrap().request;
    // Request 1 never reached the worker: 2 is a gap and changes nothing.
    let gap = host.handle(two.clone());
    assert_eq!(
        gap.error.map(|error| error.kind),
        Some(HostErrorKind::Rejected)
    );
    assert_eq!(host.snapshot().source, "");
    let first = host.handle(one.clone());
    assert!(first.error.is_none(), "{first:?}");
    // A repeat of the last request replies the same and does not replay it.
    assert_eq!(host.handle(one.clone()), first);
    assert_eq!(host.snapshot().source, "a");
    // Skipping ahead is a gap, and so is going back.
    assert!(host.handle(three.clone()).error.is_some());
    let second = host.handle(two.clone());
    assert!(second.error.is_none(), "{second:?}");
    assert!(host.handle(one).error.is_some());
    assert_eq!(host.snapshot().source, "ab");
    assert!(host.handle(three).error.is_none());
    assert_eq!(host.snapshot().source, "abc");
}

#[test]
fn an_error_ack_pauses_the_page_and_resume_converges_the_worker_to_the_page_source() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "").unwrap();
    let (mut host, mut page) = host_for(&store, "plain", 151);
    let one = page.replace(Revision(0), range(0, 0), "a").unwrap();
    let two = page.replace(Revision(1), range(1, 1), "b").unwrap();
    let three = page.replace(Revision(2), range(2, 2), "c").unwrap();
    // Request 1 is lost; the worker refuses 2 and 3 as gaps, and the page pauses.
    let refused = host.handle(two.request);
    page.acknowledge(refused).unwrap();
    assert!(page.status().paused);
    assert!(page.replace(Revision(3), range(3, 3), "d").is_err());
    assert_eq!(page.draft_text(), "abc");
    assert!(page.project(Revision(3), range(0, 3)).is_ok());
    drop((one, three));
    let resume = page.resume().unwrap();
    let reply = host.handle(resume);
    assert!(reply.error.is_none(), "{reply:?}");
    assert_eq!(reply.accepted, Revision(0));
    let resent = page.acknowledge(reply).unwrap();
    assert_eq!(resent.len(), 3);
    assert!(!page.status().paused);
    for request in resent {
        let ack = host.handle(request);
        assert!(ack.error.is_none(), "{ack:?}");
        page.acknowledge(ack).unwrap();
    }
    assert_eq!(host.snapshot().source, page.draft_text());
    assert_eq!(page.status().accepted, Revision(3));
    assert_eq!(page.status().outstanding, 0);
    assert!(page.replace(Revision(3), range(3, 3), "d").is_ok());
}

#[test]
fn input_proceeds_while_another_thread_holds_the_store_gate() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let (mut host, mut page) = host_for(&store, "plain", 152);
    let (held, held_receive) = mpsc::channel();
    let (release, release_receive) = mpsc::channel::<()>();
    std::thread::scope(|scope| {
        let _release_gate = ReleaseGateOnDrop(release);
        let store = &store;
        scope.spawn(move || {
            // Any store workflow holds the gate; hold it for the whole test body.
            let _gate = store.lock_gate().unwrap();
            held.send(()).unwrap();
            release_receive.recv().unwrap();
        });
        held_receive.recv().unwrap();
        let applied = page.replace(Revision(0), range(5, 5), "!").unwrap();
        let ack = host.handle(applied.request);
        assert!(ack.error.is_none(), "{ack:?}");
        page.acknowledge(ack).unwrap();
        let undo = page.undo(Revision(1)).unwrap().unwrap();
        assert!(host.handle(undo.request).error.is_none());
        assert_eq!(host.snapshot().source, "plain");
    });
}

#[test]
fn native_session_input_proceeds_while_another_thread_holds_the_store_gate() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "plain", "plain").unwrap();
    let mut editor = store.open_editor("plain").unwrap();
    let (held, held_receive) = mpsc::channel();
    let (release, release_receive) = mpsc::channel::<()>();
    std::thread::scope(|scope| {
        let _release_gate = ReleaseGateOnDrop(release);
        let store = &store;
        scope.spawn(move || {
            let _gate = store.lock_gate().unwrap();
            held.send(()).unwrap();
            release_receive.recv().unwrap();
        });
        held_receive.recv().unwrap();
        editor.replace(Revision(0), range(5, 5), "!").unwrap();
        editor.select_utf16(Revision(1), utf16_at(6)).unwrap();
        editor.undo(Revision(1)).unwrap();
        assert_eq!(editor.source_text(), "plain");
    });
}

fn utf16_at(offset: usize) -> futo_notes_editor::DisplayUtf16Range {
    use futo_notes_editor::DisplayUtf16Offset;
    futo_notes_editor::DisplayUtf16Range {
        start: DisplayUtf16Offset(offset),
        end: DisplayUtf16Offset(offset),
    }
}
