//! Actual Store append failures around a canonical affected-URI relink offer.
use super::*;
use futo_notes_editor::{
    Affinity, HostRequest, InlineFormat, PortableSession, SessionToken, ViewChange,
};

fn accepted(
    page: &mut PortableSession,
    host: &mut crate::StoreEditorHost<'_>,
    request: HostRequest,
    shown: &mut String,
) -> ViewChange {
    let before = page.status();
    let accepted = host.handle(request.clone());
    assert!(accepted.error.is_none(), "{accepted:?}");
    assert_eq!(host.handle(request), accepted);
    assert_eq!(page.status().accepted, before.accepted);
    assert_eq!(page.status().displayed, before.displayed);
    let change = page.acknowledge(accepted.clone()).unwrap().unwrap();
    shown.replace_range(change.range.start.0..change.range.end.0, &change.inserted);
    assert!(page.acknowledge(accepted).unwrap().is_none());
    change
}
fn failed_then_retry(
    page: &mut PortableSession,
    host: &mut crate::StoreEditorHost<'_>,
    request: HostRequest,
    shown: &mut String,
    disk: &Arc<Mutex<storage::Disk>>,
    fault: storage::Fault,
) {
    let before = page.status();
    let protected = host.snapshot();
    let displayed = shown.clone();
    let pending_draft = page.draft_text();
    disk.lock().unwrap().fault = Some(fault);
    let failed = host.handle(request);
    assert!(failed.error.is_some());
    assert_eq!(failed.accepted, before.accepted);
    assert!(page.acknowledge(failed.clone()).unwrap().is_none());
    assert_eq!(page.status().accepted, before.accepted);
    assert_eq!(page.status().displayed, before.displayed);
    assert_eq!(page.draft_text(), pending_draft);
    assert_eq!(*shown, displayed);
    assert!(page
        .project(before.accepted, range(0, displayed.len()))
        .is_err());
    assert_eq!(host.snapshot().source, protected.source);
    assert_eq!(host.snapshot().revision, protected.revision);
    disk.lock().unwrap().fault = None;
    let resume = page.resume().unwrap();
    assert!(page.acknowledge(host.handle(resume)).unwrap().is_none());
    let retry = page.retry_pending().unwrap();
    accepted(page, host, retry, shown);
    assert!(page.acknowledge(failed).unwrap().is_none());
}

#[test]
fn affected_uri_relink_offer_and_both_history_directions_retry_real_store_appends() {
    for fault in [storage::Fault::Append, storage::Fault::ShortWrite] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "Old", "target").unwrap();
        store.create("", "plain", "").unwrap();
        let disk = Arc::new(Mutex::new(storage::Disk::default()));
        let mut host = store
            .open_editor_with_recovery("plain", storage::options(&disk))
            .unwrap()
            .into_portable_host(SessionToken(780))
            .unwrap();
        let mut page = PortableSession::from_snapshot(host.snapshot()).unwrap();
        let mut shown = String::new();
        let request = page
            .replace(Revision(0), range(0, 0), "<https://x.test/[[Old]]/path")
            .unwrap();
        accepted(&mut page, &mut host, request, &mut shown);
        let request = page.replace(Revision(1), range(28, 28), ">").unwrap();
        accepted(&mut page, &mut host, request, &mut shown);
        page.select_with_affinity(Revision(2), range(16, 23), Affinity::Backward)
            .unwrap();
        let request = page
            .toggle_format(Revision(2), InlineFormat::Code)
            .unwrap()
            .unwrap();
        accepted(&mut page, &mut host, request, &mut shown);
        let old = r"<https\://x.test/`[[Old]]`/path>";
        let new = r"<https\://x.test/`[[New]]`/path>";
        assert_eq!(page.draft_text(), old);
        let before = page.project(Revision(3), range(0, 29)).unwrap();
        assert!(before.links.is_empty());
        host.checkpoint().unwrap();
        let mutation = store.rename("Old", "New").unwrap();
        assert_eq!(mutation.relinked, ["plain"]);
        assert_eq!(store.read("plain").unwrap(), new);
        assert_eq!(page.status().accepted, Revision(3));
        assert_eq!(page.project(Revision(3), range(0, 29)).unwrap(), before);
        let poll = page.flush().unwrap();
        let offer = host.handle(poll);
        assert!(offer.relink.is_some());
        assert!(page.acknowledge(offer.clone()).unwrap().is_none());
        let request = page.apply_relink_offer().unwrap().unwrap();
        assert_eq!(page.draft_text(), new);
        assert_eq!(shown, "<https://x.test/[[Old]]/path>");
        failed_then_retry(&mut page, &mut host, request, &mut shown, &disk, fault);
        assert_eq!(page.status().accepted, Revision(4));
        assert_eq!(shown, "<https://x.test/[[New]]/path>");
        assert_eq!(page.draft_text(), new);
        assert!(page.acknowledge(offer).unwrap().is_none());
        let mapped = page.project(Revision(4), range(0, 29)).unwrap();
        assert!(mapped.links.is_empty());
        assert_eq!(
            mapped
                .runs
                .iter()
                .filter(|run| run.formats.contains(&InlineFormat::Code))
                .map(|run| run.range)
                .collect::<Vec<_>>(),
            vec![range(16, 23)]
        );
        let undo = page.undo(Revision(4)).unwrap().unwrap();
        failed_then_retry(&mut page, &mut host, undo, &mut shown, &disk, fault);
        assert_eq!(shown, "<https://x.test/[[New]]/path>");
        assert!(page
            .project(Revision(5), range(0, 29))
            .unwrap()
            .links
            .is_empty());
        let redo = page.redo(Revision(5)).unwrap().unwrap();
        failed_then_retry(&mut page, &mut host, redo, &mut shown, &disk, fault);
        assert_eq!(page.draft_text(), new);
        let restored = page.project(Revision(6), range(0, 29)).unwrap();
        assert_eq!(restored.links, mapped.links);
        assert_eq!(restored.runs, mapped.runs);
        page.select_with_affinity(Revision(6), range(16, 23), Affinity::Backward)
            .unwrap();
        let request = page
            .toggle_format(Revision(6), InlineFormat::Code)
            .unwrap()
            .unwrap();
        accepted(&mut page, &mut host, request, &mut shown);
        page.select_with_affinity(Revision(7), range(29, 29), Affinity::Forward)
            .unwrap();
        let request = page.replace(Revision(7), range(29, 29), " ").unwrap();
        accepted(&mut page, &mut host, request, &mut shown);
        assert_eq!(shown, "<https://x.test/[[New]]/path> ");
        let linked = page.project(Revision(8), range(0, 30)).unwrap();
        assert_eq!(linked.links.len(), 1);
        assert_eq!(linked.links[0].destination, "https://x.test/[[New]]/path");
        let flush = page.flush().unwrap();
        page.acknowledge(host.handle(flush)).unwrap();
        let saved = page.draft_text();
        drop(host);
        let mut recovered = store
            .open_editor_with_recovery("plain", storage::options(&disk))
            .unwrap();
        assert_eq!(recovered.source_text(), saved);
        assert_eq!(recovered.display_text(), shown);
        assert_eq!(
            recovered
                .inspect_link(recovered.revision(), range(1, 2))
                .unwrap()
                .unwrap()
                .destination,
            "https://x.test/[[New]]/path"
        );
        assert!(recovered.undo(recovered.revision()).unwrap().is_none());
        recovered.checkpoint().unwrap();
        assert_eq!(store.read("plain").unwrap(), saved);
    }
}

#[test]
fn eligible_typed_origin_relink_and_history_retry_real_store_appends_before_closer() {
    for fault in [storage::Fault::Append, storage::Fault::ShortWrite] {
        let root = TestRoot::new();
        let store = store(&root);
        store.create("", "Old", "target").unwrap();
        store.create("", "plain", "").unwrap();
        let disk = Arc::new(Mutex::new(storage::Disk::default()));
        let mut host = store
            .open_editor_with_recovery("plain", storage::options(&disk))
            .unwrap()
            .into_portable_host(SessionToken(781))
            .unwrap();
        let mut page = PortableSession::from_snapshot(host.snapshot()).unwrap();
        let mut shown = String::new();
        let old = "<www.x.test/[[Old]]/path";
        let new = "<www.x.test/[[New]]/path";
        let request = page.replace(Revision(0), range(0, 0), old).unwrap();
        accepted(&mut page, &mut host, request, &mut shown);
        assert_eq!(shown, old);
        assert_eq!(page.draft_text(), old);
        let before = page.project(Revision(1), range(0, 24)).unwrap();
        assert!(before.links.is_empty());
        host.checkpoint().unwrap();
        assert_eq!(store.rename("Old", "New").unwrap().relinked, ["plain"]);
        assert_eq!(store.read("plain").unwrap(), new);
        assert_eq!(page.project(Revision(1), range(0, 24)).unwrap(), before);
        let poll = page.flush().unwrap();
        let offer = host.handle(poll);
        assert!(offer.relink.is_some());
        assert!(page.acknowledge(offer).unwrap().is_none());
        let request = page.apply_relink_offer().unwrap().unwrap();
        assert_eq!(page.draft_text(), new);
        assert_eq!(shown, old);
        failed_then_retry(&mut page, &mut host, request, &mut shown, &disk, fault);
        assert_eq!(shown, new);
        assert!(page
            .project(Revision(2), range(0, 24))
            .unwrap()
            .links
            .is_empty());
        let request = page.undo(Revision(2)).unwrap().unwrap();
        failed_then_retry(&mut page, &mut host, request, &mut shown, &disk, fault);
        assert_eq!(shown, "");
        assert_eq!(page.draft_text(), "");
        let request = page.redo(Revision(3)).unwrap().unwrap();
        failed_then_retry(&mut page, &mut host, request, &mut shown, &disk, fault);
        assert_eq!(shown, new);
        assert_eq!(page.draft_text(), new);
        assert!(page
            .project(Revision(4), range(0, 24))
            .unwrap()
            .links
            .is_empty());
        let request = page.replace(Revision(4), range(24, 24), ">").unwrap();
        accepted(&mut page, &mut host, request, &mut shown);
        assert_eq!(shown, "<www.x.test/[[New]]/path>");
        assert!(page
            .project(Revision(5), range(0, 25))
            .unwrap()
            .links
            .is_empty());
        let request = page.replace(Revision(5), range(25, 25), " ").unwrap();
        accepted(&mut page, &mut host, request, &mut shown);
        assert_eq!(shown, "<www.x.test/[[New]]/path> ");
        let active = page.project(Revision(6), range(0, 26)).unwrap();
        assert_eq!(active.links.len(), 1);
        assert_eq!(
            active.links[0].destination,
            "http://www.x.test/[[New]]/path"
        );
        let flush = page.flush().unwrap();
        page.acknowledge(host.handle(flush)).unwrap();
        let saved = page.draft_text();
        drop(host);
        let mut reopened = store
            .open_editor_with_recovery("plain", storage::options(&disk))
            .unwrap();
        assert_eq!(reopened.source_text(), saved);
        assert_eq!(reopened.display_text(), shown);
        assert_eq!(
            reopened
                .inspect_link(reopened.revision(), range(1, 2))
                .unwrap()
                .unwrap()
                .destination,
            "http://www.x.test/[[New]]/path"
        );
        assert!(reopened.undo(reopened.revision()).unwrap().is_none());
        reopened.checkpoint().unwrap();
        assert_eq!(store.read("plain").unwrap(), saved);
    }
}
