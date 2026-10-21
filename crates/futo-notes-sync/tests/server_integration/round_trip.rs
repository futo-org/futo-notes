//! Object round-trip, conflict merge, delete, move, offline batches and large notes.

use super::*;

// ── Object round-trip + cursor ───────────────────────────────────────────

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn single_note_round_trip_and_cursor_advance() {
    if common::skip_if_no_server("single_note_round_trip_and_cursor_advance") {
        return;
    }
    let server = common::server_url().unwrap();
    let (a, va) = fresh_client(&server).await;
    let before = a.max_version;

    let file = format!("{}.md", common::unique("rt"));
    std::fs::write(va.join(&file), "round trip body\n").unwrap();
    let (counts, a2) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("push");
    assert_eq!(counts.uploaded, 1);
    assert!(a2.max_version > before, "cursor must advance after a push");

    let (b, vb) = fresh_client(&server).await;
    let _b2 = pull(&b, &vb).await;
    assert_eq!(
        std::fs::read_to_string(vb.join(&file)).unwrap(),
        "round trip body\n"
    );
    common::cleanup(&va);
    common::cleanup(&vb);
}

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn update_propagates() {
    if common::skip_if_no_server("update_propagates") {
        return;
    }
    let server = common::server_url().unwrap();
    let (a, va) = fresh_client(&server).await;
    let file = format!("{}.md", common::unique("upd"));
    std::fs::write(va.join(&file), "v1\n").unwrap();
    let (_c, a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("push v1");

    let (b, vb) = fresh_client(&server).await;
    let b = pull(&b, &vb).await;
    assert_eq!(std::fs::read_to_string(vb.join(&file)).unwrap(), "v1\n");

    std::fs::write(va.join(&file), "v2 updated\n").unwrap();
    let (c, _a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("push v2");
    assert_eq!(c.uploaded, 1, "an update is one upload (PUT)");

    let _b2 = pull(&b, &vb).await;
    assert_eq!(
        std::fs::read_to_string(vb.join(&file)).unwrap(),
        "v2 updated\n"
    );
    common::cleanup(&va);
    common::cleanup(&vb);
}

// ── Conflict → 3-way merge ───────────────────────────────────────────────

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn concurrent_edit_conflict_resolves() {
    if common::skip_if_no_server("concurrent_edit_conflict_resolves") {
        return;
    }
    let server = common::server_url().unwrap();
    let file = format!("{}.md", common::unique("conf"));

    // A creates the note; B pulls it (recording the common ancestor).
    let (a, va) = fresh_client(&server).await;
    std::fs::write(va.join(&file), "L1\nL2\nL3\n").unwrap();
    let (_c, a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A push base");
    let (b, vb) = fresh_client(&server).await;
    let b = pull(&b, &vb).await;
    assert!(vb.join(&file).exists());

    // A edits line 1 and pushes.
    std::fs::write(va.join(&file), "A1\nL2\nL3\n").unwrap();
    let (_c, _a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("A push edit");

    // B edits line 3 against the stale base → PUT 409 → 3-way merge.
    std::fs::write(vb.join(&file), "L1\nL2\nB3\n").unwrap();
    let (_c, _b) = futo_notes_sync::run_push(&b, &vb, &no_progress, &no_pre_write)
        .await
        .expect("B push (conflict)");

    // A clean (non-overlapping) merge keeps BOTH edits in the file; a dirty
    // merge parks B's edit in a `(conflict …)` copy. Accept either.
    let merged = std::fs::read_to_string(vb.join(&file)).unwrap_or_default();
    let both_in_main = merged.contains("A1") && merged.contains("B3");
    let conflict_copy_has_b3 = std::fs::read_dir(&vb)
        .unwrap()
        .filter_map(|e| e.ok())
        .any(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            n.contains("conflict")
                && std::fs::read_to_string(e.path())
                    .map(|c| c.contains("B3"))
                    .unwrap_or(false)
        });
    assert!(
        both_in_main || conflict_copy_has_b3,
        "conflict not resolved without data loss; merged file = {merged:?}"
    );
    common::cleanup(&va);
    common::cleanup(&vb);
}

// ── Delete + tombstone ───────────────────────────────────────────────────

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn delete_propagates_as_tombstone() {
    if common::skip_if_no_server("delete_propagates_as_tombstone") {
        return;
    }
    let server = common::server_url().unwrap();
    let file = format!("{}.md", common::unique("del"));

    let (a, va) = fresh_client(&server).await;
    std::fs::write(va.join(&file), "to be deleted\n").unwrap();
    let (_c, a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("push");

    let (b, vb) = fresh_client(&server).await;
    let b = pull(&b, &vb).await;
    assert!(vb.join(&file).exists());

    std::fs::remove_file(va.join(&file)).unwrap();
    let (c, _a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("push delete");
    assert_eq!(c.deleted, 1);

    let _b2 = pull(&b, &vb).await;
    assert!(
        !vb.join(&file).exists(),
        "tombstone should have removed the file on B"
    );
    common::cleanup(&va);
    common::cleanup(&vb);
}

// ── Rename / move (single PUT reusing object_id) ─────────────────────────

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn move_to_folder_propagates() {
    if common::skip_if_no_server("move_to_folder_propagates") {
        return;
    }
    let server = common::server_url().unwrap();
    let stem = common::unique("mv");
    let root_file = format!("{stem}.md");
    let moved_rel = format!("Folder/{stem}.md"); // same basename → rename pairing

    let (a, va) = fresh_client(&server).await;
    std::fs::write(va.join(&root_file), "movable\n").unwrap();
    let (_c, a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("push");

    std::fs::remove_file(va.join(&root_file)).unwrap();
    std::fs::create_dir_all(va.join("Folder")).unwrap();
    std::fs::write(va.join(&moved_rel), "movable\n").unwrap();
    let (_c, _a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("push move");

    let (b, vb) = fresh_client(&server).await;
    let _b2 = pull(&b, &vb).await;
    assert!(vb.join(&moved_rel).exists(), "moved note missing on B");
    assert!(
        !vb.join(&root_file).exists(),
        "old path should not exist on B"
    );
    common::cleanup(&va);
    common::cleanup(&vb);
}

// ── Offline accumulation + large note ────────────────────────────────────

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn offline_accumulation_batch() {
    if common::skip_if_no_server("offline_accumulation_batch") {
        return;
    }
    let server = common::server_url().unwrap();
    let (a, va) = fresh_client(&server).await;
    let stem = common::unique("batch");
    for i in 0..5 {
        std::fs::write(va.join(format!("{stem}-{i}.md")), format!("note {i}\n")).unwrap();
    }
    let (c, _a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("push batch");
    assert_eq!(c.uploaded, 5);

    let (b, vb) = fresh_client(&server).await;
    let _b2 = pull(&b, &vb).await;
    for i in 0..5 {
        assert!(
            vb.join(format!("{stem}-{i}.md")).exists(),
            "note {i} missing on B"
        );
    }
    common::cleanup(&va);
    common::cleanup(&vb);
}

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER with batch download v1"]
async fn f_batch_download_first_sync() {
    if common::skip_if_no_server("f_batch_download_first_sync") {
        return;
    }
    let server = common::server_url().unwrap();
    let (a, va) = fresh_client(&server).await;
    let stem = common::unique("batch-download");
    let expected = (0..6)
        .map(|index| {
            let name = format!("{stem}-{index}.md");
            let content = format!("download batch note {index}\n");
            std::fs::write(va.join(&name), &content).unwrap();
            (name, content)
        })
        .collect::<Vec<_>>();
    let (pushed, _a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("seed batch download");
    assert_eq!(pushed.uploaded, expected.len() as u32);

    let (b, vb) = fresh_client(&server).await;
    let (pulled, _b) = futo_notes_sync::run_pull(&b, &vb, 0, &no_progress, &no_pre_write)
        .await
        .expect("batch first pull");
    assert!(pulled.failures.is_empty());
    for (name, content) in expected {
        assert_eq!(std::fs::read_to_string(vb.join(name)).unwrap(), content);
    }

    common::cleanup(&va);
    common::cleanup(&vb);
}

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER with batch upload v1"]
async fn f_batch_upload_first_push() {
    if common::skip_if_no_server("f_batch_upload_first_push") {
        return;
    }
    let server = common::server_url().unwrap();
    let (state, vault) = fresh_client(&server).await;
    let stem = common::unique("batch-upload");
    for index in 0..6 {
        std::fs::write(
            vault.join(format!("{stem}-{index}.md")),
            format!("upload batch note {index}\n"),
        )
        .unwrap();
    }

    let (summary, next) = futo_notes_sync::run_push(&state, &vault, &no_progress, &no_pre_write)
        .await
        .expect("batch first push");

    assert_eq!(summary.uploaded, 6);
    assert!(summary.failures.is_empty());
    assert_eq!(
        next.object_map
            .keys()
            .filter(|name| name.starts_with(&stem))
            .count(),
        6
    );
    common::cleanup(&vault);
}

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER with batch upload v1"]
async fn f_batch_create_replays_through_classic_fallback() {
    if common::skip_if_no_server("f_batch_create_replays_through_classic_fallback") {
        return;
    }
    let server = common::server_url().unwrap();
    let token = dev_login(&server).await;
    delete_all_collections_raw(&server, &token).await;
    let collection = create_collection_raw(&server, &token).await;
    let mutation_id = uuid::Uuid::now_v7().to_string();
    let ciphertext = b"first opaque ciphertext";
    let mut frame = Vec::new();
    frame.push(0);
    frame.extend_from_slice(&(mutation_id.len() as u16).to_be_bytes());
    frame.extend_from_slice(mutation_id.as_bytes());
    frame.extend_from_slice(&0_u32.to_be_bytes());
    frame.extend_from_slice(&(ciphertext.len() as u32).to_be_bytes());
    frame.extend_from_slice(ciphertext);
    let http = reqwest::Client::new();

    let batch = http
        .post(format!(
            "{server}/api/collections/{collection}/blob-objects/batch"
        ))
        .bearer_auth(&token)
        .header("content-type", "application/octet-stream")
        .body(frame)
        .send()
        .await
        .expect("batch create");
    assert_eq!(batch.status(), 200);
    let batch_body: serde_json::Value = batch.json().await.expect("batch response");
    assert_eq!(batch_body["results"][0]["status"], "created");

    let classic = http
        .post(format!(
            "{server}/api/collections/{collection}/blob-objects"
        ))
        .bearer_auth(&token)
        .header("content-type", "application/octet-stream")
        .header("mutation-id", &mutation_id)
        .body("different retry bytes")
        .send()
        .await
        .expect("classic replay");
    assert_eq!(classic.status(), 201);
    let classic_body: serde_json::Value = classic.json().await.expect("classic response");
    assert_eq!(classic_body["replayed"], true);
    let object_id = classic_body["object"]["id"]
        .as_str()
        .expect("server object id")
        .to_owned();

    let listed = http
        .get(format!(
            "{server}/api/collections/{collection}/objects?sinceVersion=0"
        ))
        .bearer_auth(&token)
        .send()
        .await
        .expect("list objects");
    let listed_body: serde_json::Value = listed.json().await.expect("objects response");
    assert_eq!(
        listed_body["objects"]
            .as_array()
            .expect("objects")
            .iter()
            .filter(|object| object["id"] == object_id)
            .count(),
        1
    );
    delete_all_collections_raw(&server, &token).await;
}

#[tokio::test]
#[ignore = "requires a running FUTO_TEST_SERVER"]
async fn large_note_round_trip() {
    if common::skip_if_no_server("large_note_round_trip") {
        return;
    }
    let server = common::server_url().unwrap();
    let (a, va) = fresh_client(&server).await;
    let file = format!("{}.md", common::unique("large"));
    let big = "x".repeat(256 * 1024);
    std::fs::write(va.join(&file), &big).unwrap();
    let (c, _a) = futo_notes_sync::run_push(&a, &va, &no_progress, &no_pre_write)
        .await
        .expect("push large");
    assert_eq!(c.uploaded, 1);

    let (b, vb) = fresh_client(&server).await;
    let _b2 = pull(&b, &vb).await;
    assert_eq!(
        std::fs::read_to_string(vb.join(&file)).unwrap().len(),
        big.len()
    );
    common::cleanup(&va);
    common::cleanup(&vb);
}
