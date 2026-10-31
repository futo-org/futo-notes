//! One class-retirement story crosses Portable and real Store append refusal.
use super::*;

#[test]
fn uri_class_retirement_retries_one_store_request_with_both_historical_roles() {
    let root = TestRoot::new();
    let store = store(&root);
    store.create("", "Old", "target").unwrap();
    store.create("", "plain", "").unwrap();
    let disk = Arc::new(Mutex::new(storage::Disk::default()));
    let mut host = store
        .open_editor_with_recovery("plain", storage::options(&disk))
        .unwrap()
        .into_portable_host(SessionToken(782))
        .unwrap();
    let mut page = PortableSession::from_snapshot(host.snapshot()).unwrap();
    let mut shown = String::new();
    let old = "https://x.test/[[Old]]/path";
    let new = "https://x.test/[[New Name]]/path";
    let request = page
        .replace(Revision(0), range(0, 0), &format!("<{old}"))
        .unwrap();
    accepted(&mut page, &mut host, request, &mut shown);
    let end = old.len() + 1;
    let request = page.replace(Revision(1), range(end, end), ">").unwrap();
    accepted(&mut page, &mut host, request, &mut shown);
    page.select_with_affinity(Revision(2), range(1, end), Affinity::Backward)
        .unwrap();
    let request = page
        .toggle_format(Revision(2), InlineFormat::Code)
        .unwrap()
        .unwrap();
    accepted(&mut page, &mut host, request, &mut shown);
    let code = format!("<`{new}`>");
    let expected = format!("<{new}>");
    let standard = futo_notes_editor::EditorSession::open(&code);
    assert_eq!(standard.display_text(), expected);
    let canonical = standard
        .project(Revision(0), range(0, expected.len()))
        .unwrap();
    assert!(canonical.links.is_empty());
    let request = page
        .replace_utf16_action(
            Revision(3),
            futo_notes_editor::DisplayUtf16Range {
                start: futo_notes_editor::DisplayUtf16Offset(end + 1),
                end: futo_notes_editor::DisplayUtf16Offset(end + 1),
            },
            &[33],
            futo_notes_editor::InputAction::Isolated,
        )
        .unwrap();
    accepted(&mut page, &mut host, request, &mut shown);
    let request = page.undo(Revision(4)).unwrap().unwrap();
    accepted(&mut page, &mut host, request, &mut shown);
    host.checkpoint().unwrap();
    assert_eq!(store.rename("Old", "New Name").unwrap().relinked, ["plain"]);
    assert_eq!(store.read("plain").unwrap(), code);
    let poll = page.flush().unwrap();
    let offer = host.handle(poll);
    assert!(offer.relink.is_some());
    assert!(page.acknowledge(offer.clone()).unwrap().is_none());
    let request = page.apply_relink_offer().unwrap().unwrap();
    assert_eq!(page.draft_text(), code);
    failed_then_retry(
        &mut page,
        &mut host,
        request,
        &mut shown,
        &disk,
        storage::Fault::ShortWrite,
    );
    assert_eq!(shown, expected);
    assert!(page.acknowledge(offer).unwrap().is_none());
    let projected = page
        .project(page.status().accepted, range(0, expected.len()))
        .unwrap();
    assert_eq!(projected.links, canonical.links);
    assert_eq!(projected.runs, canonical.runs);
    let request = page.redo(page.status().accepted).unwrap().unwrap();
    accepted(&mut page, &mut host, request, &mut shown);
    assert_eq!(page.draft_text(), format!("{code}!"));
    let request = page.undo(page.status().accepted).unwrap().unwrap();
    accepted(&mut page, &mut host, request, &mut shown);
    assert_eq!(page.draft_text(), code);
    let request = page.undo(page.status().accepted).unwrap().unwrap();
    accepted(&mut page, &mut host, request, &mut shown);
    assert_eq!(shown, expected);
    assert!(page
        .project(page.status().accepted, range(0, expected.len()))
        .unwrap()
        .links
        .is_empty());
    let fresh = futo_notes_editor::EditorSession::open(&page.draft_text());
    assert_eq!(fresh.display_text(), expected);
    assert!(fresh
        .project(Revision(0), range(0, expected.len()))
        .unwrap()
        .links
        .is_empty());
    let request = page.redo(page.status().accepted).unwrap().unwrap();
    accepted(&mut page, &mut host, request, &mut shown);
    assert_eq!(page.draft_text(), code);
    page.select_with_affinity(
        page.status().accepted,
        range(1, new.len() + 1),
        Affinity::Backward,
    )
    .unwrap();
    let request = page
        .toggle_format(page.status().accepted, InlineFormat::Code)
        .unwrap()
        .unwrap();
    accepted(&mut page, &mut host, request, &mut shown);
    let request = page
        .replace(
            page.status().accepted,
            range(expected.len(), expected.len()),
            " ",
        )
        .unwrap();
    accepted(&mut page, &mut host, request, &mut shown);
    assert_eq!(shown, format!("{expected} "));
    assert!(page
        .project(page.status().accepted, range(0, shown.len()))
        .unwrap()
        .links
        .is_empty());
    let flush = page.flush().unwrap();
    page.acknowledge(host.handle(flush)).unwrap();
    let saved = page.draft_text();
    drop(host);
    disk.lock().unwrap().power_loss();
    let mut recovered = store
        .open_editor_with_recovery("plain", storage::options(&disk))
        .unwrap();
    assert_eq!(recovered.source_text(), saved);
    assert_eq!(recovered.display_text(), shown);
    assert!(recovered
        .project(recovered.revision(), range(0, shown.len()))
        .unwrap()
        .links
        .is_empty());
    assert!(recovered.undo(recovered.revision()).unwrap().is_none());
    recovered.checkpoint().unwrap();
    assert_eq!(store.read("plain").unwrap(), saved);
}
