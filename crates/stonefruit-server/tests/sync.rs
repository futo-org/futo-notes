use std::collections::{HashMap, HashSet};
use tempfile::TempDir;

use stonefruit_core::hash::hash_sha256;
use stonefruit_core::sync::*;
use stonefruit_server::db;
use stonefruit_server::sync_engine::process_sync;

/// Create a test environment with in-memory DB and temp notes dir.
fn test_env() -> (rusqlite::Connection, TempDir) {
    let tmp = TempDir::new().unwrap();
    let notes_dir = tmp.path().join("notes");
    std::fs::create_dir_all(&notes_dir).unwrap();
    let conn = db::open_memory_db().unwrap();
    (conn, tmp)
}

fn notes_dir(tmp: &TempDir) -> std::path::PathBuf {
    tmp.path().join("notes")
}

fn make_request(device_id: &str) -> SyncRequest {
    SyncRequest {
        device_id: device_id.to_string(),
        inventory: Some(vec![]),
        changed: vec![],
        new: vec![],
        deleted: vec![],
        last_version: None,
        deleted_baselines: HashMap::new(),
    }
}

/// Push an item into the request's inventory (which is always Some in tests).
fn push_inventory(req: &mut SyncRequest, filename: &str, hash: &str) {
    req.inventory.as_mut().unwrap().push(InventoryItem {
        filename: filename.into(),
        hash: hash.into(),
    });
}

fn read_file(tmp: &TempDir, filename: &str) -> Option<String> {
    std::fs::read_to_string(notes_dir(tmp).join(filename)).ok()
}

fn write_server_file(tmp: &TempDir, filename: &str, content: &str) {
    std::fs::write(notes_dir(tmp).join(filename), content).unwrap();
}

fn file_exists(tmp: &TempDir, filename: &str) -> bool {
    notes_dir(tmp).join(filename).exists()
}

/// Seed a note directly into the server's DB + disk (simulating prior sync).
fn seed_note(conn: &rusqlite::Connection, tmp: &TempDir, filename: &str, content: &str) {
    let hash = hash_sha256(content);
    write_server_file(tmp, filename, content);
    conn.execute(
        "INSERT INTO note_meta (filename, content_hash, modified_at, is_blob) VALUES (?1, ?2, ?3, 0)",
        rusqlite::params![filename, hash, 1000],
    ).unwrap();
}

// ── Test cases ─────────────────────────────────────────────────────────

#[test]
fn new_note_roundtrip() {
    let (conn, tmp) = test_env();
    let content = "# Hello World";
    let hash = hash_sha256(content);

    let mut req = make_request("device-a");
    push_inventory(&mut req, "hello.md", &hash);
    req.new.push(NewNote {
        filename: "hello.md".into(),
        content: content.into(),
        hash: hash.clone(),
        modified_at: 1000,
    });

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();
    assert!(resp.update.is_empty());
    assert!(resp.delete.is_empty());
    assert!(resp.conflicts.is_empty());
    assert!(resp.version > 0);

    // Verify file on disk
    assert_eq!(read_file(&tmp, "hello.md").unwrap(), content);

    // Verify in DB
    let stored_hash: String = conn
        .query_row(
            "SELECT content_hash FROM note_meta WHERE filename = 'hello.md'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stored_hash, hash);
}

#[test]
fn server_to_client() {
    let (conn, tmp) = test_env();
    let content = "# Server Note";
    seed_note(&conn, &tmp, "server.md", content);

    // Client syncs with empty inventory
    let req = make_request("device-b");
    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();

    assert_eq!(resp.update.len(), 1);
    assert_eq!(resp.update[0].filename, "server.md");
    assert_eq!(resp.update[0].content, content);
    assert_eq!(resp.update[0].hash, hash_sha256(content));
}

#[test]
fn client_changed() {
    let (conn, tmp) = test_env();
    let original = "# Original";
    let original_hash = hash_sha256(original);
    seed_note(&conn, &tmp, "note.md", original);

    let edited = "# Edited by client";
    let edited_hash = hash_sha256(edited);

    let mut req = make_request("device-a");
    push_inventory(&mut req, "note.md", &edited_hash);
    req.changed.push(ChangedNote {
        filename: "note.md".into(),
        content: edited.into(),
        hash: edited_hash.clone(),
        modified_at: 1000,
        baseline_hash: Some(original_hash.clone()),
    });

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();
    assert!(resp.update.is_empty(), "no updates should be sent back");
    assert!(resp.conflicts.is_empty());

    // File on disk should be updated
    assert_eq!(read_file(&tmp, "note.md").unwrap(), edited);
}

#[test]
fn server_changed() {
    let (conn, tmp) = test_env();
    let original = "# Original";
    let original_hash = hash_sha256(original);
    seed_note(&conn, &tmp, "note.md", original);

    // Server content was modified externally
    let server_edited = "# Edited on server";
    let server_hash = hash_sha256(server_edited);
    write_server_file(&tmp, "note.md", server_edited);
    conn.execute(
        "UPDATE note_meta SET content_hash = ?1 WHERE filename = 'note.md'",
        [&server_hash],
    )
    .unwrap();

    // Client still has original — sends it as "changed" with baseline = original
    let mut req = make_request("device-a");
    push_inventory(&mut req, "note.md", &original_hash);
    req.changed.push(ChangedNote {
        filename: "note.md".into(),
        content: original.into(),
        hash: original_hash.clone(),
        modified_at: 1000,
        baseline_hash: Some(original_hash),
    });

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();
    // baseline_hash == client_hash means client didn't really change.
    // Server hash differs from baseline → ServerChanged.
    // Server should send the updated version to client.
    assert_eq!(resp.update.len(), 1);
    assert_eq!(resp.update[0].filename, "note.md");
    assert_eq!(resp.update[0].content, server_edited);
}

#[test]
fn external_edit_with_inventory_only_gets_server_update() {
    let (conn, tmp) = test_env();
    let original = "# Original";
    let original_hash = hash_sha256(original);
    seed_note(&conn, &tmp, "note.md", original);

    let server_edited = "# Edited on server";
    let server_hash = hash_sha256(server_edited);
    write_server_file(&tmp, "note.md", server_edited);
    conn.execute(
        "UPDATE note_meta SET content_hash = ?1 WHERE filename = 'note.md'",
        [&server_hash],
    )
    .unwrap();

    // Client has stale hash in inventory — server wins via hash mismatch
    let mut req = make_request("device-a");
    push_inventory(&mut req, "note.md", &original_hash);

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();
    assert_eq!(resp.update.len(), 1);
    assert_eq!(resp.update[0].filename, "note.md");
    assert_eq!(resp.update[0].content, server_edited);
}

#[test]
fn concurrent_edit_conflict() {
    let (conn, tmp) = test_env();
    let original = "# Original";
    let original_hash = hash_sha256(original);
    seed_note(&conn, &tmp, "note.md", original);

    // Server was edited
    let server_version = "# Server edit";
    let server_hash = hash_sha256(server_version);
    write_server_file(&tmp, "note.md", server_version);
    conn.execute(
        "UPDATE note_meta SET content_hash = ?1 WHERE filename = 'note.md'",
        [&server_hash],
    )
    .unwrap();

    // Client also edited
    let client_version = "# Client edit";
    let client_hash = hash_sha256(client_version);

    let mut req = make_request("device-a");
    push_inventory(&mut req, "note.md", &client_hash);
    req.changed.push(ChangedNote {
        filename: "note.md".into(),
        content: client_version.into(),
        hash: client_hash,
        modified_at: 1000,
        baseline_hash: Some(original_hash.clone()),
    });

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();

    // Should have a conflict copy
    assert_eq!(resp.conflicts.len(), 1);
    assert!(resp.conflicts[0].filename.contains("conflict"));
    assert_eq!(resp.conflicts[0].content, client_version);

    // Should also send server version to client
    assert!(resp
        .update
        .iter()
        .any(|u| u.filename == "note.md" && u.content == server_version));

    // Conflict copy file should exist on disk
    assert!(file_exists(&tmp, &resp.conflicts[0].filename));
}

#[test]
fn converged_both_changed() {
    let (conn, tmp) = test_env();
    let original = "# Original";
    let original_hash = hash_sha256(original);
    seed_note(&conn, &tmp, "note.md", original);

    // Both sides independently edited to the same content
    let converged = "# Same content";
    let converged_hash = hash_sha256(converged);
    write_server_file(&tmp, "note.md", converged);
    conn.execute(
        "UPDATE note_meta SET content_hash = ?1 WHERE filename = 'note.md'",
        [&converged_hash],
    )
    .unwrap();

    let mut req = make_request("device-a");
    push_inventory(&mut req, "note.md", &converged_hash);
    req.changed.push(ChangedNote {
        filename: "note.md".into(),
        content: converged.into(),
        hash: converged_hash,
        modified_at: 1000,
        baseline_hash: Some(original_hash.clone()),
    });

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();
    assert!(resp.conflicts.is_empty(), "no conflict when converged");
    // No update needed either — both have the same content
    assert!(
        resp.update.is_empty() || resp.update.iter().all(|u| u.filename != "note.md"),
        "no update for converged note"
    );
}

#[test]
fn delete_propagation() {
    let (conn, tmp) = test_env();
    let content = "# To Delete";
    let hash = hash_sha256(content);
    seed_note(&conn, &tmp, "deleteme.md", content);

    let mut req = make_request("device-a");
    req.deleted.push("deleteme.md".into());
    req.deleted_baselines
        .insert("deleteme.md".into(), hash.clone());

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();
    assert!(resp.update.is_empty());
    assert!(resp.conflicts.is_empty());

    // File should be gone
    assert!(!file_exists(&tmp, "deleteme.md"));

    // Tombstone should exist
    let tombstone_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM tombstones WHERE filename = 'deleteme.md'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(tombstone_exists);
}

#[test]
fn server_tombstone_propagation() {
    let (conn, tmp) = test_env();

    // Server has tombstone, client still has the file in inventory
    conn.execute(
        "INSERT INTO tombstones (filename, deleted_at) VALUES ('deleted.md', 1000)",
        [],
    )
    .unwrap();

    let mut req = make_request("device-b");
    push_inventory(&mut req, "deleted.md", "somehash");

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();
    assert!(resp.delete.contains(&"deleted.md".to_string()));
}

#[test]
fn delete_vs_edit() {
    let (conn, tmp) = test_env();
    let original = "# Original";
    let original_hash = hash_sha256(original);
    seed_note(&conn, &tmp, "note.md", original);

    // Server was edited (by another device)
    let server_edited = "# Server edited this";
    let server_hash = hash_sha256(server_edited);
    write_server_file(&tmp, "note.md", server_edited);
    conn.execute(
        "UPDATE note_meta SET content_hash = ?1 WHERE filename = 'note.md'",
        [&server_hash],
    )
    .unwrap();

    // Client deletes — baseline is what the client last synced (original)
    let mut req = make_request("device-a");
    req.deleted.push("note.md".into());
    req.deleted_baselines
        .insert("note.md".into(), original_hash.clone());

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();

    // Server should keep its version and send it to client
    assert!(resp
        .update
        .iter()
        .any(|u| u.filename == "note.md" && u.content == server_edited));

    // File should still exist on server
    assert!(file_exists(&tmp, "note.md"));
}

#[test]
fn rename_as_delete_create() {
    let (conn, tmp) = test_env();
    let content = "# My Note";
    let hash = hash_sha256(content);
    seed_note(&conn, &tmp, "old-name.md", content);

    // Client sends delete(old) + new(new) with same hash
    let mut req = make_request("device-a");
    req.deleted.push("old-name.md".into());
    req.deleted_baselines
        .insert("old-name.md".into(), hash.clone());
    req.new.push(NewNote {
        filename: "new-name.md".into(),
        content: content.into(),
        hash: hash.clone(),
        modified_at: 1000,
    });

    let _resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();

    // Old file should be gone, new file should exist
    assert!(!file_exists(&tmp, "old-name.md"));
    assert!(file_exists(&tmp, "new-name.md"));
    assert_eq!(read_file(&tmp, "new-name.md").unwrap(), content);

    // Tombstone for old-name.md should exist
    let tombstone: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM tombstones WHERE filename = 'old-name.md'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(tombstone);

    // note_meta for new-name.md should exist
    let new_exists: bool = conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM note_meta WHERE filename = 'new-name.md'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(new_exists);
}

#[test]
fn multi_device_propagation() {
    let (conn, tmp) = test_env();

    // Device A creates a note
    let content_a = "# Note from A";
    let hash_a = hash_sha256(content_a);
    let mut req_a = make_request("device-a");
    push_inventory(&mut req_a, "from-a.md", &hash_a);
    req_a.new.push(NewNote {
        filename: "from-a.md".into(),
        content: content_a.into(),
        hash: hash_a.clone(),
        modified_at: 1000,
    });
    let resp_a = process_sync(&conn, &notes_dir(&tmp), &req_a).unwrap();
    assert!(resp_a.update.is_empty());

    // Device B syncs — should get the note
    let req_b = make_request("device-b");
    let resp_b = process_sync(&conn, &notes_dir(&tmp), &req_b).unwrap();
    assert_eq!(resp_b.update.len(), 1);
    assert_eq!(resp_b.update[0].filename, "from-a.md");
    assert_eq!(resp_b.update[0].content, content_a);

    // Now device A renames (delete + create)
    let mut req_a2 = make_request("device-a");
    push_inventory(&mut req_a2, "renamed-a.md", &hash_a);
    req_a2.deleted.push("from-a.md".into());
    req_a2
        .deleted_baselines
        .insert("from-a.md".into(), hash_a.clone());
    req_a2.new.push(NewNote {
        filename: "renamed-a.md".into(),
        content: content_a.into(),
        hash: hash_a.clone(),
        modified_at: 1000,
    });
    let _resp_a2 = process_sync(&conn, &notes_dir(&tmp), &req_a2).unwrap();

    // Device B syncs again — should see deletion of old + new file
    let mut req_b2 = make_request("device-b");
    push_inventory(&mut req_b2, "from-a.md", &hash_a);
    let resp_b2 = process_sync(&conn, &notes_dir(&tmp), &req_b2).unwrap();

    // B should be told to delete from-a.md (tombstoned)
    assert!(resp_b2.delete.contains(&"from-a.md".to_string()));
    // B should get renamed-a.md
    assert!(resp_b2.update.iter().any(|u| u.filename == "renamed-a.md"));
}

#[test]
fn rename_vs_rename_keeps_the_first_server_name() {
    let (conn, tmp) = test_env();
    let content = "# Shared note";
    let hash = hash_sha256(content);
    seed_note(&conn, &tmp, "old-name.md", content);

    let mut req_a = make_request("device-a");
    push_inventory(&mut req_a, "server-name.md", &hash);
    req_a.deleted.push("old-name.md".into());
    req_a
        .deleted_baselines
        .insert("old-name.md".into(), hash.clone());
    req_a.new.push(NewNote {
        filename: "server-name.md".into(),
        content: content.into(),
        hash: hash.clone(),
        modified_at: 1000,
    });
    let resp_a = process_sync(&conn, &notes_dir(&tmp), &req_a).unwrap();
    assert!(resp_a.conflicts.is_empty());
    assert!(file_exists(&tmp, "server-name.md"));
    assert!(!file_exists(&tmp, "old-name.md"));

    let mut req_b = make_request("device-b");
    push_inventory(&mut req_b, "client-name.md", &hash);
    req_b.deleted.push("old-name.md".into());
    req_b
        .deleted_baselines
        .insert("old-name.md".into(), hash.clone());
    req_b.new.push(NewNote {
        filename: "client-name.md".into(),
        content: content.into(),
        hash: hash.clone(),
        modified_at: 1000,
    });
    let resp_b = process_sync(&conn, &notes_dir(&tmp), &req_b).unwrap();

    assert!(
        !file_exists(&tmp, "client-name.md"),
        "the losing rename should not create a second active note"
    );
    assert!(
        file_exists(&tmp, "server-name.md"),
        "the first accepted server rename should remain canonical"
    );
    assert!(
        resp_b.update.iter().any(|u| u.filename == "server-name.md"),
        "the second client should be driven back to the canonical filename"
    );

    let note_meta_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM note_meta", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        note_meta_count, 1,
        "rename-vs-rename should not fork the note"
    );
}

#[test]
fn empty_vault_bootstrap() {
    let (conn, tmp) = test_env();

    // Server has multiple notes
    seed_note(&conn, &tmp, "note1.md", "# Note 1");
    seed_note(&conn, &tmp, "note2.md", "# Note 2");
    seed_note(&conn, &tmp, "note3.md", "# Note 3");

    // Fresh client syncs with empty inventory
    let req = make_request("new-device");
    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();

    assert_eq!(resp.update.len(), 3);
    let filenames: HashSet<String> = resp.update.iter().map(|u| u.filename.clone()).collect();
    assert!(filenames.contains("note1.md"));
    assert!(filenames.contains("note2.md"));
    assert!(filenames.contains("note3.md"));
}

#[test]
fn lost_state_recovery() {
    let (conn, tmp) = test_env();

    // Server has notes
    seed_note(&conn, &tmp, "existing.md", "# Existing");

    // Device syncs with lost state but has file in inventory with matching hash
    let content = "# Existing";
    let hash = hash_sha256(content);
    let mut req = make_request("recovered-device");
    push_inventory(&mut req, "existing.md", &hash);

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();

    // Hashes match between inventory and server — no update or conflict needed
    assert!(resp.conflicts.is_empty());

    // Device also has a note server doesn't — it should appear as new from inventory
    // (Actually inventory-only items with no server match won't be uploaded.
    //  The client would need to include it in `new` or `changed`.)
}

#[test]
fn lost_state_reupload_same_content_does_not_duplicate_note() {
    let (conn, tmp) = test_env();
    let content = "# Existing";
    let hash = hash_sha256(content);
    seed_note(&conn, &tmp, "existing.md", content);

    // Simulate a client that kept its local file but lost app-state:
    // inventory still includes the file, and prepare_sync_payload_v2 would
    // also classify it as `new` because fileHashes is empty.
    let mut req = make_request("recovered-device");
    push_inventory(&mut req, "existing.md", &hash);
    req.new.push(NewNote {
        filename: "existing.md".into(),
        content: content.into(),
        hash: hash.clone(),
        modified_at: 1000,
    });

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();

    assert!(
        resp.conflicts.is_empty(),
        "lost-state recovery should reconcile, not create conflicts"
    );
    assert!(
        !file_exists(&tmp, "existing (2).md"),
        "re-syncing the same file after losing app-state should not create a duplicate"
    );

    let note_meta_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM note_meta", [], |row| row.get(0))
        .unwrap();
    assert_eq!(
        note_meta_count, 1,
        "server should still have exactly one canonical note"
    );
}

#[test]
fn accepted_client_edit_updates_server_state() {
    let (conn, tmp) = test_env();
    let original = "# Original";
    let original_hash = hash_sha256(original);
    seed_note(&conn, &tmp, "note.md", original);

    let edited = "# Edited by client";
    let edited_hash = hash_sha256(edited);

    let mut req = make_request("device-a");
    push_inventory(&mut req, "note.md", &edited_hash);
    req.changed.push(ChangedNote {
        filename: "note.md".into(),
        content: edited.into(),
        hash: edited_hash.clone(),
        modified_at: 1000,
        baseline_hash: Some(original_hash.clone()),
    });

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();
    assert!(
        resp.update.is_empty(),
        "accepted client edits should not round-trip"
    );

    // Verify server DB now has the edited hash
    let stored_hash: String = conn
        .query_row(
            "SELECT content_hash FROM note_meta WHERE filename = 'note.md'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        stored_hash, edited_hash,
        "note_meta must record the new hash after an accepted client edit"
    );

    // Verify file on disk was updated
    assert_eq!(read_file(&tmp, "note.md").unwrap(), "# Edited by client");
}

#[test]
fn sync_version_increments() {
    let (conn, tmp) = test_env();

    // No-op sync should not increment
    let req = make_request("device-a");
    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();
    let v0 = resp.version;

    // Creating a note should increment
    let mut req2 = make_request("device-a");
    req2.new.push(NewNote {
        filename: "new.md".into(),
        content: "# New".into(),
        hash: hash_sha256("# New"),
        modified_at: 1000,
    });
    let resp2 = process_sync(&conn, &notes_dir(&tmp), &req2).unwrap();
    assert!(resp2.version > v0);

    // Another no-op should not increment further
    let mut req3 = make_request("device-a");
    push_inventory(&mut req3, "new.md", &hash_sha256("# New"));
    let resp3 = process_sync(&conn, &notes_dir(&tmp), &req3).unwrap();
    assert_eq!(resp3.version, resp2.version);
}

#[test]
fn large_inventory() {
    let (conn, tmp) = test_env();

    // Create 100 notes on server
    for i in 0..100 {
        let filename = format!("note-{i:03}.md");
        let content = format!("# Note {i}");
        seed_note(&conn, &tmp, &filename, &content);
    }

    // Fresh client syncs
    let req = make_request("device-x");
    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();
    assert_eq!(resp.update.len(), 100);
}

#[test]
fn filename_collision() {
    let (conn, tmp) = test_env();
    let server_content = "# Server version";
    let server_hash = hash_sha256(server_content);

    // Server already has "note.md"
    seed_note(&conn, &tmp, "note.md", server_content);

    // Client creates a different "note.md"
    let client_content = "# Client version";
    let mut req = make_request("device-a");
    req.new.push(NewNote {
        filename: "note.md".into(),
        content: client_content.into(),
        hash: hash_sha256(client_content),
        modified_at: 1000,
    });

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();

    // Client's note should be saved with a collision suffix
    assert!(file_exists(&tmp, "note (2).md"));
    assert_eq!(read_file(&tmp, "note (2).md").unwrap(), client_content);

    // Server's original should be untouched
    assert_eq!(read_file(&tmp, "note.md").unwrap(), server_content);

    // The creating client must be told to reconcile to the server's final name.
    assert!(
        resp.delete.contains(&"note.md".to_string()),
        "client should drop the losing local filename after server-side collision resolution"
    );
    assert!(resp.update.iter().any(|u| {
        u.filename == "note (2).md"
            && u.content == client_content
            && u.hash == hash_sha256(client_content)
    }));
    assert!(
        resp.update.iter().any(|u| u.filename == "note.md"
            && u.content == server_content
            && u.hash == server_hash),
        "client should also receive the remote note it collided with"
    );

    // After applying that reconciliation, the next sync should be stable.
    let mut req2 = make_request("device-a");
    push_inventory(&mut req2, "note.md", &server_hash);
    push_inventory(&mut req2, "note (2).md", &hash_sha256(client_content));
    let resp2 = process_sync(&conn, &notes_dir(&tmp), &req2).unwrap();
    assert!(resp2.update.is_empty());
    assert!(resp2.conflicts.is_empty());
}

#[test]
fn tombstone_prevents_reupload() {
    let (conn, tmp) = test_env();

    // Create and then delete a note
    seed_note(&conn, &tmp, "deleted.md", "# Was here");
    let hash = hash_sha256("# Was here");

    let mut del_req = make_request("device-a");
    del_req.deleted.push("deleted.md".into());
    del_req
        .deleted_baselines
        .insert("deleted.md".into(), hash.clone());
    process_sync(&conn, &notes_dir(&tmp), &del_req).unwrap();

    // Device B still has the file in inventory (stale)
    let mut req_b = make_request("device-b");
    push_inventory(&mut req_b, "deleted.md", &hash);

    let resp_b = process_sync(&conn, &notes_dir(&tmp), &req_b).unwrap();

    // B should be told to delete it
    assert!(resp_b.delete.contains(&"deleted.md".to_string()));
}

#[test]
fn tombstone_does_not_block_reupload_as_new() {
    let (conn, tmp) = test_env();

    // Device A creates and syncs a note
    let content = "# Untitled (2)";
    let hash = hash_sha256(content);
    let mut create_req = make_request("device-a");
    create_req.new.push(NewNote {
        filename: "Untitled (2).md".into(),
        content: content.into(),
        hash: hash.clone(),
        modified_at: 1000,
    });
    push_inventory(&mut create_req, "Untitled (2).md", &hash);
    process_sync(&conn, &notes_dir(&tmp), &create_req).unwrap();

    // Device A deletes it → tombstone created
    let mut del_req = make_request("device-a");
    del_req.deleted.push("Untitled (2).md".into());
    del_req
        .deleted_baselines
        .insert("Untitled (2).md".into(), hash.clone());
    process_sync(&conn, &notes_dir(&tmp), &del_req).unwrap();
    assert!(!file_exists(&tmp, "Untitled (2).md"));

    // Device A re-uploads the same filename as new (e.g. user created another "Untitled (2)")
    let new_content = "# Fresh note";
    let new_hash = hash_sha256(new_content);
    let mut reupload_req = make_request("device-a");
    reupload_req.new.push(NewNote {
        filename: "Untitled (2).md".into(),
        content: new_content.into(),
        hash: new_hash.clone(),
        modified_at: 2000,
    });
    push_inventory(&mut reupload_req, "Untitled (2).md", &new_hash);

    let resp = process_sync(&conn, &notes_dir(&tmp), &reupload_req).unwrap();

    // Response must NOT tell client to delete the file it just uploaded
    assert!(
        !resp.delete.contains(&"Untitled (2).md".to_string()),
        "server should not send delete for a file being re-uploaded as new"
    );
    // File should exist on server
    assert!(file_exists(&tmp, "Untitled (2).md"));
    assert_eq!(read_file(&tmp, "Untitled (2).md").unwrap(), new_content);
}

// ── Three-way merge tests ─────────────────────────────────────────────

/// Seed base content into content_store so three-way merge can find it.
fn seed_content(conn: &rusqlite::Connection, content: &str) {
    let hash = hash_sha256(content);
    db::store_content(conn, &hash, content).unwrap();
}

#[test]
fn three_way_merge_clean() {
    let (conn, tmp) = test_env();

    // Base: multi-line note
    let base = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n";
    let base_hash = hash_sha256(base);
    seed_note(&conn, &tmp, "note.md", base);
    seed_content(&conn, base);

    // Server edits the title (another device synced first)
    let server_version = "# New Title\n\nFirst paragraph.\n\nSecond paragraph.\n";
    let server_hash = hash_sha256(server_version);
    write_server_file(&tmp, "note.md", server_version);
    conn.execute(
        "UPDATE note_meta SET content_hash = ?1 WHERE filename = 'note.md'",
        [&server_hash],
    )
    .unwrap();

    // Client edits the second paragraph
    let client_version = "# Title\n\nFirst paragraph.\n\nEdited second paragraph.\n";
    let client_hash = hash_sha256(client_version);

    let mut req = make_request("device-a");
    push_inventory(&mut req, "note.md", &client_hash);
    req.changed.push(ChangedNote {
        filename: "note.md".into(),
        content: client_version.into(),
        hash: client_hash,
        modified_at: 2000,
        baseline_hash: Some(base_hash.clone()),
    });

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();

    // Should merge cleanly — no conflict copy
    assert!(
        resp.conflicts.is_empty(),
        "non-overlapping edits should merge cleanly, got {} conflicts",
        resp.conflicts.len()
    );

    // Client should receive the merged version
    let merged_update = resp.update.iter().find(|u| u.filename == "note.md");
    assert!(merged_update.is_some(), "client should receive merged note");

    let merged = &merged_update.unwrap().content;
    let expected = "# New Title\n\nFirst paragraph.\n\nEdited second paragraph.\n";
    assert_eq!(merged, expected, "merged content should have both edits");

    // File on disk should be the merged version
    assert_eq!(read_file(&tmp, "note.md").unwrap(), expected);
}

#[test]
fn three_way_merge_overlapping_fallback() {
    let (conn, tmp) = test_env();

    // Base: multi-line note
    let base = "# Title\n\nParagraph one.\n";
    let base_hash = hash_sha256(base);
    seed_note(&conn, &tmp, "note.md", base);
    seed_content(&conn, base);

    // Server edits the same paragraph
    let server_version = "# Title\n\nServer rewrote paragraph one.\n";
    let server_hash = hash_sha256(server_version);
    write_server_file(&tmp, "note.md", server_version);
    conn.execute(
        "UPDATE note_meta SET content_hash = ?1 WHERE filename = 'note.md'",
        [&server_hash],
    )
    .unwrap();

    // Client also edits the same paragraph
    let client_version = "# Title\n\nClient rewrote paragraph one.\n";
    let client_hash = hash_sha256(client_version);

    let mut req = make_request("device-a");
    push_inventory(&mut req, "note.md", &client_hash);
    req.changed.push(ChangedNote {
        filename: "note.md".into(),
        content: client_version.into(),
        hash: client_hash,
        modified_at: 2000,
        baseline_hash: Some(base_hash.clone()),
    });

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();

    // Should fall back to conflict copy
    assert_eq!(
        resp.conflicts.len(),
        1,
        "overlapping edits should produce a conflict copy"
    );
    assert!(resp.conflicts[0].filename.contains("conflict"));
    assert_eq!(resp.conflicts[0].content, client_version);

    // Server version should be sent to client
    assert!(resp
        .update
        .iter()
        .any(|u| u.filename == "note.md" && u.content == server_version));
}

#[test]
fn three_way_merge_missing_base_fallback() {
    let (conn, tmp) = test_env();

    // Base note exists but base content is NOT in content_store
    // (simulates first sync after upgrading — content_store was never backfilled)
    let base = "# Title\n\nParagraph.\n";
    let base_hash = hash_sha256(base);
    seed_note(&conn, &tmp, "note.md", base);
    // Intentionally NOT calling seed_content — base is missing

    // Server edits title
    let server_version = "# New Title\n\nParagraph.\n";
    let server_hash = hash_sha256(server_version);
    write_server_file(&tmp, "note.md", server_version);
    conn.execute(
        "UPDATE note_meta SET content_hash = ?1 WHERE filename = 'note.md'",
        [&server_hash],
    )
    .unwrap();

    // Client edits paragraph
    let client_version = "# Title\n\nEdited paragraph.\n";
    let client_hash = hash_sha256(client_version);

    let mut req = make_request("device-a");
    push_inventory(&mut req, "note.md", &client_hash);
    req.changed.push(ChangedNote {
        filename: "note.md".into(),
        content: client_version.into(),
        hash: client_hash,
        modified_at: 2000,
        baseline_hash: Some(base_hash.clone()),
    });

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();

    // Should gracefully fall back to conflict copy
    assert_eq!(
        resp.conflicts.len(),
        1,
        "missing base content should fall back to conflict copy"
    );
}

#[test]
fn three_way_merge_blob_skipped() {
    let (conn, tmp) = test_env();

    // Seed a blob file (is_blob = 1)
    let base = "blob-data-v1";
    let base_hash = hash_sha256(base);
    write_server_file(&tmp, "image.png", base);
    conn.execute(
        "INSERT INTO note_meta (filename, content_hash, modified_at, is_blob) VALUES (?1, ?2, ?3, 1)",
        rusqlite::params!["image.png", base_hash, 1000],
    ).unwrap();
    seed_content(&conn, base);

    // Server changes blob
    let server_version = "blob-data-v2-server";
    let server_hash = hash_sha256(server_version);
    write_server_file(&tmp, "image.png", server_version);
    conn.execute(
        "UPDATE note_meta SET content_hash = ?1 WHERE filename = 'image.png'",
        [&server_hash],
    )
    .unwrap();

    // Client changes blob
    let client_version = "blob-data-v2-client";
    let client_hash = hash_sha256(client_version);

    let mut req = make_request("device-a");
    push_inventory(&mut req, "image.png", &client_hash);
    req.changed.push(ChangedNote {
        filename: "image.png".into(),
        content: client_version.into(),
        hash: client_hash,
        modified_at: 2000,
        baseline_hash: Some(base_hash.clone()),
    });

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();

    // Blobs should always use conflict copy, never three-way merge
    assert_eq!(
        resp.conflicts.len(),
        1,
        "blob conflicts should always produce conflict copies"
    );
    assert!(
        resp.conflicts[0].filename.ends_with(".png"),
        "blob conflict copies should preserve the original extension"
    );
}

#[test]
fn three_way_merge_multi_device() {
    let (conn, tmp) = test_env();

    // Create the base note via sync so version_log tracks the base hash
    // (prevents prune_content_store from evicting it before later merges).
    let base = "# Shared Note\n\nIntro paragraph.\n\nMiddle section.\n\nConclusion.\n";
    let base_hash = hash_sha256(base);
    let mut setup_req = make_request("device-setup");
    push_inventory(&mut setup_req, "shared.md", &base_hash);
    setup_req.new.push(NewNote {
        filename: "shared.md".into(),
        content: base.into(),
        hash: base_hash.clone(),
        modified_at: 1000,
    });
    process_sync(&conn, &notes_dir(&tmp), &setup_req).unwrap();
    seed_content(&conn, base);

    // Device A edits the intro — syncs first
    let a_version = "# Shared Note\n\nA's intro paragraph.\n\nMiddle section.\n\nConclusion.\n";
    let a_hash = hash_sha256(a_version);
    let mut req_a = make_request("device-a");
    push_inventory(&mut req_a, "shared.md", &a_hash);
    req_a.changed.push(ChangedNote {
        filename: "shared.md".into(),
        content: a_version.into(),
        hash: a_hash,
        modified_at: 2000,
        baseline_hash: Some(base_hash.clone()),
    });
    let resp_a = process_sync(&conn, &notes_dir(&tmp), &req_a).unwrap();
    assert!(resp_a.conflicts.is_empty());

    // Device B edits the conclusion — syncs second (should merge with A's edit)
    let b_version = "# Shared Note\n\nIntro paragraph.\n\nMiddle section.\n\nB's conclusion.\n";
    let b_hash = hash_sha256(b_version);
    let mut req_b = make_request("device-b");
    push_inventory(&mut req_b, "shared.md", &b_hash);
    req_b.changed.push(ChangedNote {
        filename: "shared.md".into(),
        content: b_version.into(),
        hash: b_hash,
        modified_at: 2000,
        baseline_hash: Some(base_hash.clone()),
    });
    let resp_b = process_sync(&conn, &notes_dir(&tmp), &req_b).unwrap();

    // B should get a clean merge — no conflict
    assert!(
        resp_b.conflicts.is_empty(),
        "non-overlapping edits from A and B should merge cleanly"
    );

    let expected_merged =
        "# Shared Note\n\nA's intro paragraph.\n\nMiddle section.\n\nB's conclusion.\n";
    let merged_update = resp_b.update.iter().find(|u| u.filename == "shared.md");
    assert!(merged_update.is_some());
    assert_eq!(merged_update.unwrap().content, expected_merged);

    // Device C syncs — should get the fully merged version (stale hash in inventory)
    let mut req_c = make_request("device-c");
    push_inventory(&mut req_c, "shared.md", &base_hash);
    let resp_c = process_sync(&conn, &notes_dir(&tmp), &req_c).unwrap();

    let c_update = resp_c.update.iter().find(|u| u.filename == "shared.md");
    assert!(
        c_update.is_some(),
        "device C should receive the merged note"
    );
    assert_eq!(c_update.unwrap().content, expected_merged);
}

/// Reproduces QA Scenario 4: two devices edit different paragraphs through
/// the full process_sync path (no seed_content workaround). Verifies that
/// prune_content_store does not evict ancestor content needed for merge.
#[test]
fn three_way_merge_multi_device_no_seed_content() {
    let (conn, tmp) = test_env();

    // Create the base note via sync — do NOT call seed_content after.
    // The production path must preserve ancestor content on its own.
    let base = "# Shared Note\n\nIntro paragraph.\n\nMiddle section.\n\nConclusion.\n";
    let base_hash = hash_sha256(base);
    let mut setup_req = make_request("device-setup");
    push_inventory(&mut setup_req, "shared.md", &base_hash);
    setup_req.new.push(NewNote {
        filename: "shared.md".into(),
        content: base.into(),
        hash: base_hash.clone(),
        modified_at: 1000,
    });
    process_sync(&conn, &notes_dir(&tmp), &setup_req).unwrap();
    // Intentionally NO seed_content here — rely on production code path

    // Device A edits the intro — syncs first
    let a_version = "# Shared Note\n\nA's intro paragraph.\n\nMiddle section.\n\nConclusion.\n";
    let a_hash = hash_sha256(a_version);
    let mut req_a = make_request("device-a");
    push_inventory(&mut req_a, "shared.md", &a_hash);
    req_a.changed.push(ChangedNote {
        filename: "shared.md".into(),
        content: a_version.into(),
        hash: a_hash,
        modified_at: 2000,
        baseline_hash: Some(base_hash.clone()),
    });
    let resp_a = process_sync(&conn, &notes_dir(&tmp), &req_a).unwrap();
    assert!(resp_a.conflicts.is_empty(), "device A sync should not conflict");

    // Device B edits the conclusion — syncs second (should merge with A's edit)
    let b_version = "# Shared Note\n\nIntro paragraph.\n\nMiddle section.\n\nB's conclusion.\n";
    let b_hash = hash_sha256(b_version);
    let mut req_b = make_request("device-b");
    push_inventory(&mut req_b, "shared.md", &b_hash);
    req_b.changed.push(ChangedNote {
        filename: "shared.md".into(),
        content: b_version.into(),
        hash: b_hash,
        modified_at: 2000,
        baseline_hash: Some(base_hash.clone()),
    });
    let resp_b = process_sync(&conn, &notes_dir(&tmp), &req_b).unwrap();

    assert!(
        resp_b.conflicts.is_empty(),
        "non-overlapping edits should merge cleanly without seed_content, got {} conflicts",
        resp_b.conflicts.len()
    );

    let expected_merged =
        "# Shared Note\n\nA's intro paragraph.\n\nMiddle section.\n\nB's conclusion.\n";
    let merged_update = resp_b.update.iter().find(|u| u.filename == "shared.md");
    assert!(merged_update.is_some(), "device B should receive merged note");
    assert_eq!(merged_update.unwrap().content, expected_merged);
}

#[test]
fn accepted_edit_backfills_ancestor_for_next_device_merge() {
    let (conn, tmp) = test_env();

    // Create the base note via sync so version_log tracks the base hash
    // (prevents prune_content_store from evicting it before later merges).
    let base = "# Title\n\nIntro paragraph.\n\nConclusion.\n";
    let base_hash = hash_sha256(base);
    let mut setup_req = make_request("device-setup");
    push_inventory(&mut setup_req, "note.md", &base_hash);
    setup_req.new.push(NewNote {
        filename: "note.md".into(),
        content: base.into(),
        hash: base_hash.clone(),
        modified_at: 1000,
    });
    process_sync(&conn, &notes_dir(&tmp), &setup_req).unwrap();
    seed_content(&conn, base);

    // Device A edits the title — accepted as ClientChanged.
    let a_version = "# Updated Title\n\nIntro paragraph.\n\nConclusion.\n";
    let a_hash = hash_sha256(a_version);
    let mut req_a = make_request("device-a");
    push_inventory(&mut req_a, "note.md", &a_hash);
    req_a.changed.push(ChangedNote {
        filename: "note.md".into(),
        content: a_version.into(),
        hash: a_hash,
        modified_at: 2000,
        baseline_hash: Some(base_hash.clone()),
    });

    let resp_a = process_sync(&conn, &notes_dir(&tmp), &req_a).unwrap();
    assert!(resp_a.conflicts.is_empty());
    assert!(
        resp_a.update.is_empty(),
        "accepted edits should not be echoed back when no merge was needed"
    );

    // Device B edits a different section from the same base.
    // B sends baseline_hash = base_hash, which is still in content_store
    // (referenced by version_log from B's note creation or the initial seed).
    let b_version = "# Title\n\nEdited intro paragraph.\n\nConclusion.\n";
    let b_hash = hash_sha256(b_version);
    let mut req_b = make_request("device-b");
    push_inventory(&mut req_b, "note.md", &b_hash);
    req_b.changed.push(ChangedNote {
        filename: "note.md".into(),
        content: b_version.into(),
        hash: b_hash,
        modified_at: 3000,
        baseline_hash: Some(base_hash.clone()),
    });

    let resp_b = process_sync(&conn, &notes_dir(&tmp), &req_b).unwrap();

    assert!(
        resp_b.conflicts.is_empty(),
        "non-overlapping edits should merge cleanly when base is in content_store"
    );
    let merged = resp_b
        .update
        .iter()
        .find(|u| u.filename == "note.md")
        .expect("merged note should be returned to the second device");
    assert_eq!(
        merged.content,
        "# Updated Title\n\nEdited intro paragraph.\n\nConclusion.\n"
    );
}

// ── Version changelog tests ──────────────────────────────────────────

#[test]
fn version_log_row_per_file() {
    let (conn, tmp) = test_env();

    // Upload 3 new files in one sync
    let mut req = make_request("device-a");
    for name in &["alpha.md", "beta.md", "gamma.md"] {
        let content = format!("# {name}");
        let hash = hash_sha256(&content);
        push_inventory(&mut req, name, &hash);
        req.new.push(NewNote {
            filename: name.to_string(),
            content,
            hash,
            modified_at: 1000,
        });
    }

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();
    let version = resp.version;
    assert!(version > 0, "mutating sync should bump version");

    // Query the changelog for exactly this version
    let changelog = db::query_changelog(&conn, version - 1, version).unwrap();
    assert_eq!(
        changelog.len(),
        3,
        "3 new files should produce 3 version_log rows"
    );
    for name in &["alpha.md", "beta.md", "gamma.md"] {
        let (action, hash) = changelog.get(*name).expect("file should be in changelog");
        assert_eq!(action, "upsert");
        assert!(hash.is_some(), "upsert entries should have a hash");
    }
}

#[test]
fn version_log_noop_sync_no_rows() {
    let (conn, tmp) = test_env();
    seed_note(&conn, &tmp, "existing.md", "# Hello");

    let version_before = db::get_sync_version(&conn).unwrap();

    // Client sends inventory that matches server exactly — no mutations
    let mut req = make_request("device-a");
    push_inventory(&mut req, "existing.md", &hash_sha256("# Hello"));

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();
    assert_eq!(
        resp.version, version_before,
        "no-op sync should not bump version"
    );

    // version_log should have no rows at all (seed_note bypasses sync engine)
    let row_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM version_log", [], |row| row.get(0))
        .unwrap();
    assert_eq!(row_count, 0, "no-op sync should write zero version_log rows");
}

#[test]
fn version_log_aggregation_collapses_edits() {
    let (conn, tmp) = test_env();

    // v1: create the file
    let content_v1 = "# Version 1";
    let hash_v1 = hash_sha256(content_v1);
    let mut req1 = make_request("device-a");
    push_inventory(&mut req1, "note.md", &hash_v1);
    req1.new.push(NewNote {
        filename: "note.md".into(),
        content: content_v1.into(),
        hash: hash_v1.clone(),
        modified_at: 1000,
    });
    let resp1 = process_sync(&conn, &notes_dir(&tmp), &req1).unwrap();
    let v1 = resp1.version;

    // v2: edit the same file
    let content_v2 = "# Version 2";
    let hash_v2 = hash_sha256(content_v2);
    let mut req2 = make_request("device-a");
    push_inventory(&mut req2, "note.md", &hash_v2);
    req2.changed.push(ChangedNote {
        filename: "note.md".into(),
        content: content_v2.into(),
        hash: hash_v2.clone(),
        modified_at: 2000,
        baseline_hash: Some(hash_v1.clone()),
    });
    let resp2 = process_sync(&conn, &notes_dir(&tmp), &req2).unwrap();
    let v2 = resp2.version;
    assert!(v2 > v1, "edit should bump version");

    // A client at v0 querying changelog through v2 should see only the v2 version
    let changelog = db::query_changelog(&conn, 0, v2).unwrap();
    assert_eq!(changelog.len(), 1, "same file edited twice should collapse to one entry");
    let (action, hash) = changelog.get("note.md").unwrap();
    assert_eq!(action, "upsert");
    assert_eq!(hash.as_deref(), Some(hash_v2.as_str()), "collapsed entry should have the latest hash");
}

#[test]
fn version_log_create_delete_cancels() {
    let (conn, tmp) = test_env();

    // v1: create a file
    let content = "# Ephemeral";
    let hash = hash_sha256(content);
    let mut req1 = make_request("device-a");
    push_inventory(&mut req1, "ephemeral.md", &hash);
    req1.new.push(NewNote {
        filename: "ephemeral.md".into(),
        content: content.into(),
        hash: hash.clone(),
        modified_at: 1000,
    });
    let resp1 = process_sync(&conn, &notes_dir(&tmp), &req1).unwrap();
    let v1 = resp1.version;

    // v2: delete the same file
    let mut req2 = make_request("device-a");
    req2.deleted.push("ephemeral.md".into());
    req2.deleted_baselines
        .insert("ephemeral.md".into(), hash.clone());
    let resp2 = process_sync(&conn, &notes_dir(&tmp), &req2).unwrap();
    let v2 = resp2.version;
    assert!(v2 > v1);

    // Changelog from v0 → v2: last action wins (delete)
    let changelog = db::query_changelog(&conn, 0, v2).unwrap();
    let (action, _) = changelog.get("ephemeral.md")
        .expect("file should appear in changelog even if net effect is delete");
    assert_eq!(action, "delete", "create-then-delete should show final action as 'delete'");
}

#[test]
fn version_log_changelog_only_download() {
    let (conn, tmp) = test_env();

    // v1: create alpha.md
    let alpha_content = "# Alpha";
    let alpha_hash = hash_sha256(alpha_content);
    let mut req1 = make_request("device-a");
    push_inventory(&mut req1, "alpha.md", &alpha_hash);
    req1.new.push(NewNote {
        filename: "alpha.md".into(),
        content: alpha_content.into(),
        hash: alpha_hash.clone(),
        modified_at: 1000,
    });
    let resp1 = process_sync(&conn, &notes_dir(&tmp), &req1).unwrap();
    let v1 = resp1.version;

    // v2: create beta.md
    let beta_content = "# Beta";
    let beta_hash = hash_sha256(beta_content);
    let mut req2 = make_request("device-a");
    push_inventory(&mut req2, "alpha.md", &alpha_hash);
    push_inventory(&mut req2, "beta.md", &beta_hash);
    req2.new.push(NewNote {
        filename: "beta.md".into(),
        content: beta_content.into(),
        hash: beta_hash.clone(),
        modified_at: 2000,
    });
    let resp2 = process_sync(&conn, &notes_dir(&tmp), &req2).unwrap();
    let v2 = resp2.version;
    assert!(v2 > v1);

    // Client B at v1, sends inventory: None (changelog path), last_version: Some(v1)
    let mut req_b = SyncRequest {
        device_id: "device-b".into(),
        inventory: None,
        changed: vec![],
        new: vec![],
        deleted: vec![],
        last_version: Some(v1),
        deleted_baselines: HashMap::new(),
    };

    let resp_b = process_sync(&conn, &notes_dir(&tmp), &req_b).unwrap();

    // Client B should receive only beta.md (the changelog delta), not alpha.md
    assert_eq!(
        resp_b.update.len(),
        1,
        "changelog-only path should deliver only the delta"
    );
    assert_eq!(resp_b.update[0].filename, "beta.md");
    assert_eq!(resp_b.update[0].content, beta_content);
    assert_eq!(resp_b.version, v2);
}

#[test]
fn version_log_beyond_retention() {
    let (conn, tmp) = test_env();

    // v1: create a file to get version 1
    let content = "# Note";
    let hash = hash_sha256(content);
    let mut req1 = make_request("device-a");
    push_inventory(&mut req1, "note.md", &hash);
    req1.new.push(NewNote {
        filename: "note.md".into(),
        content: content.into(),
        hash: hash.clone(),
        modified_at: 1000,
    });
    let resp1 = process_sync(&conn, &notes_dir(&tmp), &req1).unwrap();
    let v1 = resp1.version;

    // v2: edit to get version 2
    let content2 = "# Note v2";
    let hash2 = hash_sha256(content2);
    let mut req2 = make_request("device-a");
    push_inventory(&mut req2, "note.md", &hash2);
    req2.changed.push(ChangedNote {
        filename: "note.md".into(),
        content: content2.into(),
        hash: hash2.clone(),
        modified_at: 2000,
        baseline_hash: Some(hash.clone()),
    });
    let resp2 = process_sync(&conn, &notes_dir(&tmp), &req2).unwrap();
    let v2 = resp2.version;

    // Compact version_log: remove entries < v2 (keeps only v2)
    let pruned = db::compact_version_log(&conn, v2).unwrap();
    assert!(pruned > 0, "should have pruned at least one version_log entry");

    // Client at v0 uses changelog path — server should report oldest_retained_version
    let req_old = SyncRequest {
        device_id: "device-old".into(),
        inventory: None,
        changed: vec![],
        new: vec![],
        deleted: vec![],
        last_version: Some(0),
        deleted_baselines: HashMap::new(),
    };
    let resp_old = process_sync(&conn, &notes_dir(&tmp), &req_old).unwrap();

    assert!(
        resp_old.oldest_retained_version.is_some(),
        "response should include oldest_retained_version after compaction"
    );
    assert_eq!(
        resp_old.oldest_retained_version.unwrap(),
        v2,
        "oldest retained version should be v2 after compacting entries < v2"
    );
}

// ── Client-sent baseline hash tests ──────────────────────────────────

#[test]
fn baseline_hash_conflict_detection() {
    let (conn, tmp) = test_env();
    let original = "# Original";
    let original_hash = hash_sha256(original);
    seed_note(&conn, &tmp, "note.md", original);

    // Server was edited by another device
    let server_edited = "# Server edit";
    let server_hash = hash_sha256(server_edited);
    write_server_file(&tmp, "note.md", server_edited);
    conn.execute(
        "UPDATE note_meta SET content_hash = ?1 WHERE filename = 'note.md'",
        [&server_hash],
    )
    .unwrap();

    // Client also edited (different from server), sends baseline_hash = original
    let client_edited = "# Client edit";
    let client_hash = hash_sha256(client_edited);

    let mut req = make_request("device-a");
    push_inventory(&mut req, "note.md", &client_hash);
    req.changed.push(ChangedNote {
        filename: "note.md".into(),
        content: client_edited.into(),
        hash: client_hash,
        modified_at: 2000,
        baseline_hash: Some(original_hash.clone()),
    });

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();

    // baseline_hash != server_hash AND baseline_hash != client_hash → BothChanged → conflict
    assert_eq!(
        resp.conflicts.len(),
        1,
        "baseline_hash mismatch on both sides should produce a conflict"
    );
    assert!(resp.conflicts[0].filename.contains("conflict"));
    assert_eq!(resp.conflicts[0].content, client_edited);

    // Server version should be sent to client
    assert!(resp
        .update
        .iter()
        .any(|u| u.filename == "note.md" && u.content == server_edited));
}

#[test]
fn baseline_hash_three_way_merge() {
    let (conn, tmp) = test_env();

    // Base content stored in content_store
    let base = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n";
    let base_hash = hash_sha256(base);
    seed_note(&conn, &tmp, "note.md", base);
    seed_content(&conn, base);

    // Server edits the title
    let server_version = "# New Title\n\nFirst paragraph.\n\nSecond paragraph.\n";
    let server_hash = hash_sha256(server_version);
    write_server_file(&tmp, "note.md", server_version);
    conn.execute(
        "UPDATE note_meta SET content_hash = ?1 WHERE filename = 'note.md'",
        [&server_hash],
    )
    .unwrap();

    // Client edits second paragraph, sends baseline_hash = base_hash
    let client_version = "# Title\n\nFirst paragraph.\n\nClient second paragraph.\n";
    let client_hash = hash_sha256(client_version);

    let mut req = make_request("device-a");
    push_inventory(&mut req, "note.md", &client_hash);
    req.changed.push(ChangedNote {
        filename: "note.md".into(),
        content: client_version.into(),
        hash: client_hash,
        modified_at: 2000,
        baseline_hash: Some(base_hash.clone()),
    });

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();

    // Should merge cleanly using the ancestor from content_store
    assert!(
        resp.conflicts.is_empty(),
        "non-overlapping edits should merge cleanly via baseline_hash ancestor lookup"
    );

    let merged = resp
        .update
        .iter()
        .find(|u| u.filename == "note.md")
        .expect("merged note should be returned");
    let expected = "# New Title\n\nFirst paragraph.\n\nClient second paragraph.\n";
    assert_eq!(merged.content, expected);
    assert_eq!(read_file(&tmp, "note.md").unwrap(), expected);
}

#[test]
fn baseline_hash_missing_treated_as_new() {
    let (conn, tmp) = test_env();

    // Client sends a changed note for a file the server doesn't know about,
    // with baseline_hash: None
    let content = "# Brand New";
    let hash = hash_sha256(content);

    let mut req = make_request("device-a");
    push_inventory(&mut req, "unknown.md", &hash);
    req.changed.push(ChangedNote {
        filename: "unknown.md".into(),
        content: content.into(),
        hash: hash.clone(),
        modified_at: 1000,
        baseline_hash: None,
    });

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();

    // Should be treated as new — no conflict
    assert!(resp.conflicts.is_empty(), "unknown file should be treated as new, not conflict");
    assert!(file_exists(&tmp, "unknown.md"), "file should be created on server");
    assert_eq!(read_file(&tmp, "unknown.md").unwrap(), content);
}

#[test]
fn baseline_hash_stale_delete_rejected() {
    let (conn, tmp) = test_env();
    let original = "# Original";
    let original_hash = hash_sha256(original);
    seed_note(&conn, &tmp, "note.md", original);

    // Server was edited (another device advanced the content)
    let server_edited = "# Server advanced";
    let server_hash = hash_sha256(server_edited);
    write_server_file(&tmp, "note.md", server_edited);
    conn.execute(
        "UPDATE note_meta SET content_hash = ?1 WHERE filename = 'note.md'",
        [&server_hash],
    )
    .unwrap();

    // Client tries to delete with stale baseline (original_hash != server_hash)
    let mut req = make_request("device-a");
    req.deleted.push("note.md".into());
    req.deleted_baselines
        .insert("note.md".into(), original_hash.clone());

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();

    // Delete should be rejected — server version should be sent to client
    assert!(
        file_exists(&tmp, "note.md"),
        "file should still exist on server after rejected stale delete"
    );
    assert!(
        resp.update
            .iter()
            .any(|u| u.filename == "note.md" && u.content == server_edited),
        "server should return its current version when delete baseline is stale"
    );
}

// ── Mixed-direction tests ────────────────────────────────────────────

#[test]
fn mixed_upload_and_download() {
    let (conn, tmp) = test_env();

    // Setup: create alpha.md on server at v1
    let alpha_content = "# Alpha from server";
    let alpha_hash = hash_sha256(alpha_content);
    let mut setup = make_request("device-setup");
    push_inventory(&mut setup, "alpha.md", &alpha_hash);
    setup.new.push(NewNote {
        filename: "alpha.md".into(),
        content: alpha_content.into(),
        hash: alpha_hash.clone(),
        modified_at: 1000,
    });
    let resp_setup = process_sync(&conn, &notes_dir(&tmp), &setup).unwrap();
    let v1 = resp_setup.version;

    // v2: server-side edit to alpha.md (simulated by another device)
    let alpha_v2 = "# Alpha updated";
    let alpha_v2_hash = hash_sha256(alpha_v2);
    let mut edit_req = make_request("device-other");
    push_inventory(&mut edit_req, "alpha.md", &alpha_v2_hash);
    edit_req.changed.push(ChangedNote {
        filename: "alpha.md".into(),
        content: alpha_v2.into(),
        hash: alpha_v2_hash.clone(),
        modified_at: 2000,
        baseline_hash: Some(alpha_hash.clone()),
    });
    let resp_edit = process_sync(&conn, &notes_dir(&tmp), &edit_req).unwrap();
    let v2 = resp_edit.version;
    assert!(v2 > v1);

    // Client B at v1: uploads dirty beta.md + downloads changelog delta
    let beta_content = "# Beta from client B";
    let beta_hash = hash_sha256(beta_content);
    let mut req_b = SyncRequest {
        device_id: "device-b".into(),
        inventory: None,
        changed: vec![ChangedNote {
            filename: "beta.md".into(),
            content: beta_content.into(),
            hash: beta_hash.clone(),
            modified_at: 3000,
            baseline_hash: None,
        }],
        new: vec![],
        deleted: vec![],
        last_version: Some(v1),
        deleted_baselines: HashMap::new(),
    };

    let resp_b = process_sync(&conn, &notes_dir(&tmp), &req_b).unwrap();

    // beta.md should be accepted as new (server didn't have it)
    assert!(file_exists(&tmp, "beta.md"), "uploaded beta.md should exist on server");
    assert_eq!(read_file(&tmp, "beta.md").unwrap(), beta_content);

    // alpha.md should be downloaded via changelog (changed at v2, client was at v1)
    assert!(
        resp_b.update.iter().any(|u| u.filename == "alpha.md" && u.content == alpha_v2),
        "changelog-derived alpha.md should be delivered to client"
    );
}

#[test]
fn mixed_no_double_delivery() {
    let (conn, tmp) = test_env();

    // Setup: create note.md at v1
    let original = "# Original";
    let original_hash = hash_sha256(original);
    let mut setup = make_request("device-a");
    push_inventory(&mut setup, "note.md", &original_hash);
    setup.new.push(NewNote {
        filename: "note.md".into(),
        content: original.into(),
        hash: original_hash.clone(),
        modified_at: 1000,
    });
    let resp_setup = process_sync(&conn, &notes_dir(&tmp), &setup).unwrap();
    let v1 = resp_setup.version;

    // Client B uploads a new version of note.md with changelog path
    let edited = "# Edited by B";
    let edited_hash = hash_sha256(edited);
    let req_b = SyncRequest {
        device_id: "device-b".into(),
        inventory: None,
        changed: vec![ChangedNote {
            filename: "note.md".into(),
            content: edited.into(),
            hash: edited_hash.clone(),
            modified_at: 2000,
            baseline_hash: Some(original_hash.clone()),
        }],
        new: vec![],
        deleted: vec![],
        last_version: Some(v1),
        deleted_baselines: HashMap::new(),
    };

    let resp_b = process_sync(&conn, &notes_dir(&tmp), &req_b).unwrap();

    // note.md was in the upload set — it should NOT appear in the download set
    let note_updates: Vec<_> = resp_b
        .update
        .iter()
        .filter(|u| u.filename == "note.md")
        .collect();
    assert!(
        note_updates.is_empty(),
        "file in upload set should be excluded from changelog download; got {} update(s)",
        note_updates.len()
    );

    // Verify the upload was accepted
    assert_eq!(read_file(&tmp, "note.md").unwrap(), "# Edited by B");
}

// ── Content store pruning test ───────────────────────────────────────

#[test]
fn content_store_pruned_against_note_meta_and_version_log() {
    let (conn, tmp) = test_env();

    // Create a note via sync so its hash goes into version_log and note_meta
    let content_a = "# Keep me (note_meta)";
    let hash_a = hash_sha256(content_a);
    let mut req1 = make_request("device-a");
    push_inventory(&mut req1, "keep.md", &hash_a);
    req1.new.push(NewNote {
        filename: "keep.md".into(),
        content: content_a.into(),
        hash: hash_a.clone(),
        modified_at: 1000,
    });
    let resp1 = process_sync(&conn, &notes_dir(&tmp), &req1).unwrap();
    let v1 = resp1.version;

    // Edit the note so the old hash is only in version_log (not note_meta)
    let content_b = "# Keep me (version_log only)";
    let hash_b = hash_sha256(content_b);
    let mut req2 = make_request("device-a");
    push_inventory(&mut req2, "keep.md", &hash_b);
    req2.changed.push(ChangedNote {
        filename: "keep.md".into(),
        content: content_b.into(),
        hash: hash_b.clone(),
        modified_at: 2000,
        baseline_hash: Some(hash_a.clone()),
    });
    let resp2 = process_sync(&conn, &notes_dir(&tmp), &req2).unwrap();

    // Manually insert an unreferenced hash into content_store
    let orphan_content = "# I should be pruned";
    let orphan_hash = hash_sha256(orphan_content);
    db::store_content(&conn, &orphan_hash, orphan_content).unwrap();

    // Verify the orphan is there before the next sync triggers pruning
    assert!(
        db::get_content(&conn, &orphan_hash).unwrap().is_some(),
        "orphan content should exist before pruning"
    );

    // Trigger another sync to run prune_content_store
    let mut req3 = make_request("device-a");
    push_inventory(&mut req3, "keep.md", &hash_b);
    let _ = process_sync(&conn, &notes_dir(&tmp), &req3).unwrap();

    // hash_b is in note_meta → should be kept
    assert!(
        db::get_content(&conn, &hash_b).unwrap().is_some(),
        "content referenced by note_meta should NOT be pruned"
    );

    // hash_a is in version_log (from v1 creation) → should be kept
    assert!(
        db::get_content(&conn, &hash_a).unwrap().is_some(),
        "content referenced by version_log should NOT be pruned"
    );

    // orphan_hash is in neither note_meta nor version_log → should be pruned
    assert!(
        db::get_content(&conn, &orphan_hash).unwrap().is_none(),
        "unreferenced content should be pruned from content_store"
    );
}
