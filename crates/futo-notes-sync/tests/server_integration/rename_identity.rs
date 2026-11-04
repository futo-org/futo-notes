//! In-app renames keep their sync object identity (issue #214): the store's
//! journaled move, not a name or hash guess, carries the object.

use super::*;

/// An in-app title change carries identity even when a peer edited the old
/// name while the renaming client was offline (issue #214).
#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn offline_title_rename_keeps_identity_and_concurrent_peer_edit() {
    let server = common::server_url().expect("FUTO_TEST_SERVER must be configured");
    let old_id = common::unique("title-rename-old");
    let new_id = common::unique("title-rename-new");
    let old_file = format!("{old_id}.md");
    let new_file = format!("{new_id}.md");

    let (a, va) = fresh_client(&server).await;
    let store_a = futo_notes_store::LocalNoteStore::new(va.clone());
    store_a
        .create("", &old_id, "Origin")
        .expect("create baseline");
    let (_, a) = futo_notes_sync::run_sync(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A sync baseline");
    let original_object_id = a.object_map[&old_file].object_id.clone();

    let (b, vb) = fresh_client(&server).await;
    let (_, b) = futo_notes_sync::run_sync(&b, &vb, &no_progress, &no_pre_write)
        .await
        .expect("B sync baseline");
    let store_b = futo_notes_store::LocalNoteStore::new(vb.clone());
    let mutation = store_b.rename(&old_id, &new_id).expect("B rename offline");
    assert_eq!(mutation.final_id.as_deref(), Some(new_id.as_str()));
    assert!(mutation
        .renamed
        .iter()
        .any(|pair| pair.from == old_id && pair.to == new_id));

    store_a
        .write(&old_id, "Local typing Origin", None)
        .expect("A peer edit");
    let (_, a) = futo_notes_sync::run_sync(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A sync peer edit");
    let (b_summary, b) = futo_notes_sync::run_sync(&b, &vb, &no_progress, &no_pre_write)
        .await
        .expect("B sync offline rename");
    let (a_summary, a) = futo_notes_sync::run_sync(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A receive rename");
    eprintln!("B offline-rename cycle: {b_summary:?}\nA receive cycle: {a_summary:?}");
    let reports_rename = |summary: &futo_notes_sync::SyncSummary| {
        summary
            .renamed
            .iter()
            .any(|pair| pair.from_id == old_id && pair.to_id == new_id)
    };
    // Capture the actual public cycle results, including both maps and bytes,
    // so the first failure distinguishes identity loss from projection loss.
    for (label, root, state, summary) in [("A", &va, &a, &a_summary), ("B", &vb, &b, &b_summary)] {
        let new_body = std::fs::read_to_string(root.join(&new_file));
        assert!(
            !root.join(&old_file).exists()
                && !state.object_map.contains_key(&old_file)
                && state.object_map.get(&new_file).is_some_and(|entry| entry.object_id == original_object_id)
                && matches!(new_body.as_deref(), Ok("Local typing Origin"))
                && reports_rename(summary)
                && summary.failures.is_empty(),
            "{label}: expected one original object at the renamed path with the peer edit and explicit rename; original={original_object_id}, old={:?}, new={:?}, body={new_body:?}, summary={summary:?}",
            state.object_map.get(&old_file), state.object_map.get(&new_file),
        );
    }
    common::cleanup(&va);
    common::cleanup(&vb);
}

/// Two clients synced on one note; returns (A, A's vault, B, B's vault, the
/// note's server object id).
async fn synced_pair(
    server: &str,
    id: &str,
    body: &str,
) -> (ConnectedState, PathBuf, ConnectedState, PathBuf, String) {
    let (a, va) = fresh_client(server).await;
    futo_notes_store::LocalNoteStore::new(va.clone())
        .create("", id, body)
        .expect("create baseline");
    let (_, a) = futo_notes_sync::run_sync(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A sync baseline");
    let object_id = a.object_map[&format!("{id}.md")].object_id.clone();
    let (b, vb) = fresh_client(server).await;
    let (_, b) = futo_notes_sync::run_sync(&b, &vb, &no_progress, &no_pre_write)
        .await
        .expect("B sync baseline");
    (a, va, b, vb, object_id)
}

fn reports(summary: &futo_notes_sync::SyncSummary, from: &str, to: &str) -> bool {
    summary
        .renamed
        .iter()
        .any(|pair| pair.from_id == from && pair.to_id == to)
}

/// Renaming twice and editing in between, offline, still arrives as the one
/// original object at the last name with the last body (issue #214).
#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn repeated_offline_renames_with_an_edit_arrive_as_one_object() {
    let server = common::server_url().expect("FUTO_TEST_SERVER must be configured");
    let first = common::unique("chain-first");
    let middle = common::unique("chain-middle");
    let last = common::unique("chain-last");
    let (a, va, b, vb, object_id) = synced_pair(&server, &first, "Origin").await;

    let store_b = futo_notes_store::LocalNoteStore::new(vb.clone());
    store_b.rename(&first, &middle).expect("first rename");
    store_b
        .write(&middle, "Edited between renames", None)
        .expect("edit");
    store_b.rename(&middle, &last).expect("second rename");
    let (b_summary, b) = futo_notes_sync::run_sync(&b, &vb, &no_progress, &no_pre_write)
        .await
        .expect("B sync");
    let (a_summary, a) = futo_notes_sync::run_sync(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A sync");

    for (label, root, state, summary) in [("A", &va, &a, &a_summary), ("B", &vb, &b, &b_summary)] {
        let names: Vec<_> = state
            .object_map
            .keys()
            .filter(|name| name.contains("chain-"))
            .collect();
        assert_eq!(names, [&format!("{last}.md")], "{label}: one mapped name");
        assert_eq!(
            state.object_map[&format!("{last}.md")].object_id,
            object_id,
            "{label}"
        );
        assert_eq!(
            std::fs::read_to_string(root.join(format!("{last}.md"))).unwrap(),
            "Edited between renames",
            "{label}"
        );
        assert!(
            !root.join(format!("{first}.md")).exists()
                && !root.join(format!("{middle}.md")).exists()
        );
        assert!(reports(summary, &first, &last), "{label}: {summary:?}");
        assert!(summary.failures.is_empty(), "{label}: {summary:?}");
    }
    common::cleanup(&va);
    common::cleanup(&vb);
}

/// Identity follows the journaled move, never equal bodies: renaming one of
/// two identical notes leaves the other untouched.
#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn renaming_one_of_two_equal_notes_moves_only_that_object() {
    let server = common::server_url().expect("FUTO_TEST_SERVER must be configured");
    let left = common::unique("twin-left");
    let right = common::unique("twin-right");
    let moved = common::unique("twin-moved");
    let (a, va) = fresh_client(&server).await;
    let store_a = futo_notes_store::LocalNoteStore::new(va.clone());
    store_a.create("", &left, "Same").expect("left");
    store_a.create("", &right, "Same").expect("right");
    let (_, a) = futo_notes_sync::run_sync(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A baseline");
    let left_id = a.object_map[&format!("{left}.md")].object_id.clone();
    let right_id = a.object_map[&format!("{right}.md")].object_id.clone();
    let (b, vb) = fresh_client(&server).await;
    let (_, b) = futo_notes_sync::run_sync(&b, &vb, &no_progress, &no_pre_write)
        .await
        .expect("B baseline");

    futo_notes_store::LocalNoteStore::new(vb.clone())
        .rename(&right, &moved)
        .expect("rename right");
    let (_, b) = futo_notes_sync::run_sync(&b, &vb, &no_progress, &no_pre_write)
        .await
        .expect("B sync");
    let (a_summary, a) = futo_notes_sync::run_sync(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A sync");

    for state in [&a, &b] {
        assert_eq!(state.object_map[&format!("{left}.md")].object_id, left_id);
        assert_eq!(state.object_map[&format!("{moved}.md")].object_id, right_id);
        assert!(!state.object_map.contains_key(&format!("{right}.md")));
    }
    assert!(reports(&a_summary, &right, &moved), "{a_summary:?}");
    common::cleanup(&va);
    common::cleanup(&vb);
}
