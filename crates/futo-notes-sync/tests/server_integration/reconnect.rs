//! Disconnect then reconnect must not spam conflict copies.

use super::*;

// ── Disconnect → reconnect conflict-spam regressions ─────────────────────
//
// July 2026 incident: a device that disconnected (deleting `.e2ee-state.json`)
// and reconnected days later ran the empty-map reconcile with no ancestry, so
// F6 parked a `name (conflict <oid8>).md` copy of every note that had drifted
// meanwhile — even when the device's local file was bit-for-bit what it last
// synced (never edited on that device). Disconnect now demotes the state to
// `.e2ee-ancestry.json`, and the reconcile uses it to fast-forward instead.

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn reconnect_after_remote_drift_fast_forwards_instead_of_parking() {
    if common::skip_if_no_server("reconnect_after_remote_drift_fast_forwards_instead_of_parking") {
        return;
    }
    let server = common::server_url().unwrap();

    // A creates + pushes v1, then disconnects (what the shells' disconnect
    // and the desktop's e2ee_disconnect do to the persisted state).
    let (a, va) = fresh_client(&server).await;
    let file = format!("{}.md", common::unique("drift-clean"));
    std::fs::write(va.join(&file), "v1 from A\n").unwrap();
    let (_c, _a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A push v1");
    futo_notes_sync::demote_state_to_ancestry(&va).expect("disconnect A");

    // B edits the note to v2 while A is disconnected.
    let (b, vb) = fresh_client(&server).await;
    let b = pull(&b, &vb).await;
    std::fs::write(vb.join(&file), "v2 from B\n").unwrap();
    let (_c, _b) = futo_notes_sync::run_push(&b, &vb, &no_progress, &no_pre_write)
        .await
        .expect("B push v2");

    // A reconnects (fresh login, no live state) and syncs.
    let (a2, _info) = futo_notes_sync::connect(&va, &server, common::TEST_PASSWORD)
        .await
        .expect("A reconnect");
    assert!(
        a2.object_map.is_empty(),
        "reconnect after disconnect starts with an empty map"
    );
    let (_summary, _a3) = futo_notes_sync::run_sync(&a2, &va, &no_progress, &no_pre_write)
        .await
        .expect("A reconcile sync");

    assert_eq!(
        std::fs::read_to_string(va.join(&file)).unwrap(),
        "v2 from B\n",
        "a stale-but-clean local file must fast-forward to the remote content"
    );
    assert_eq!(
        conflict_copies_of(&va, &file),
        Vec::<String>::new(),
        "a file this device never edited must NOT be parked as a conflict copy \
         just because it drifted while disconnected"
    );

    common::cleanup(&va);
    common::cleanup(&vb);
}

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn reconnect_after_local_edit_updates_same_object_instead_of_parking() {
    if common::skip_if_no_server(
        "reconnect_after_local_edit_updates_same_object_instead_of_parking",
    ) {
        return;
    }
    let server = common::server_url().unwrap();

    // A creates + pushes v1, disconnects, then edits the note LOCALLY while
    // disconnected (remote untouched).
    let (a, va) = fresh_client(&server).await;
    let file = format!("{}.md", common::unique("drift-edited"));
    std::fs::write(va.join(&file), "v1 from A\n").unwrap();
    let (_c, a1) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A push v1");
    let object_id = a1
        .object_map
        .get(&file)
        .expect("mapped after push")
        .object_id
        .clone();
    futo_notes_sync::demote_state_to_ancestry(&va).expect("disconnect A");
    std::fs::write(va.join(&file), "v2 edited offline on A\n").unwrap();

    // A reconnects and syncs: the local edit must survive and reach the
    // server as an UPDATE to the same object — no conflict copy, no
    // duplicate object.
    let (a2, _info) = futo_notes_sync::connect(&va, &server, common::TEST_PASSWORD)
        .await
        .expect("A reconnect");
    let (_summary, a3) = futo_notes_sync::run_sync(&a2, &va, &no_progress, &no_pre_write)
        .await
        .expect("A reconcile sync");

    assert_eq!(
        std::fs::read_to_string(va.join(&file)).unwrap(),
        "v2 edited offline on A\n",
        "an edit made while disconnected must survive the reconnect"
    );
    assert_eq!(
        conflict_copies_of(&va, &file),
        Vec::<String>::new(),
        "an offline edit against an unchanged remote is not a conflict"
    );
    assert_eq!(
        a3.object_map.get(&file).expect("still mapped").object_id,
        object_id,
        "the offline edit must update the SAME server object, not mint a duplicate"
    );

    // A fresh client sees the edited content — the update really pushed.
    let (c, vc) = fresh_client(&server).await;
    let _c = pull(&c, &vc).await;
    assert_eq!(
        std::fs::read_to_string(vc.join(&file)).unwrap(),
        "v2 edited offline on A\n",
        "peers receive the offline edit after the reconnect sync"
    );

    common::cleanup(&va);
    common::cleanup(&vc);
}

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn reconnect_after_remote_rename_deletes_stale_old_path_no_duplicate() {
    if common::skip_if_no_server(
        "reconnect_after_remote_rename_deletes_stale_old_path_no_duplicate",
    ) {
        return;
    }
    let server = common::server_url().unwrap();

    // A creates + pushes a note at the root, then disconnects and keeps that
    // old local path on disk.
    let (a, va) = fresh_client(&server).await;
    let stem = common::unique("drift-renamed");
    let root_file = format!("{stem}.md");
    let moved_file = format!("Folder/{stem}.md");
    std::fs::write(va.join(&root_file), "v1 before rename\n").unwrap();
    let (_c, a1) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A push v1");
    let object_id = a1
        .object_map
        .get(&root_file)
        .expect("mapped after push")
        .object_id
        .clone();
    futo_notes_sync::demote_state_to_ancestry(&va).expect("disconnect A");

    // B renames the same object while A is disconnected.
    let (b, vb) = fresh_client(&server).await;
    let b = pull(&b, &vb).await;
    std::fs::remove_file(vb.join(&root_file)).unwrap();
    std::fs::create_dir_all(vb.join("Folder")).unwrap();
    std::fs::write(vb.join(&moved_file), "v1 before rename\n").unwrap();
    let (_c, _b) = futo_notes_sync::run_push(&b, &vb, &no_progress, &no_pre_write)
        .await
        .expect("B push rename");

    // A reconnects with an empty live map. The reconcile must use ancestry by
    // object_id to recognize that its stale root path is the pre-rename copy,
    // delete it locally, and map the moved filename to the SAME object. If the
    // old path survives, the push phase posts it as a duplicate new object.
    let (a2, _info) = futo_notes_sync::connect(&va, &server, common::TEST_PASSWORD)
        .await
        .expect("A reconnect");
    assert!(
        a2.object_map.is_empty(),
        "reconnect after disconnect starts empty"
    );
    let (_summary, a3) = futo_notes_sync::run_sync(&a2, &va, &no_progress, &no_pre_write)
        .await
        .expect("A reconcile sync");

    assert!(
        !va.join(&root_file).exists(),
        "stale pre-rename path must be deleted"
    );
    assert_eq!(
        std::fs::read_to_string(va.join(&moved_file)).unwrap(),
        "v1 before rename\n",
        "A must adopt the peer's renamed path"
    );
    assert!(!a3.object_map.contains_key(&root_file));
    assert_eq!(
        a3.object_map
            .get(&moved_file)
            .expect("moved path mapped")
            .object_id,
        object_id,
        "remote rename must keep tracking the same server object"
    );

    // A fresh peer should see only the moved path, not a duplicate re-upload of
    // A's stale root path.
    let (c, vc) = fresh_client(&server).await;
    let _c = pull(&c, &vc).await;
    assert!(
        vc.join(&moved_file).exists(),
        "fresh peer should receive moved note"
    );
    assert!(
        !vc.join(&root_file).exists(),
        "stale root path must not be re-uploaded as a duplicate object"
    );

    common::cleanup(&va);
    common::cleanup(&vb);
    common::cleanup(&vc);
}
