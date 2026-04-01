use std::collections::HashSet;
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
        inventory: vec![],
        changed: vec![],
        new: vec![],
        deleted: vec![],
    }
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

/// Seed a device snapshot (what a device last saw for a file).
fn seed_snapshot(conn: &rusqlite::Connection, device_id: &str, filename: &str, hash: &str) {
    conn.execute(
        "INSERT INTO device_snapshots (device_id, filename, hash) VALUES (?1, ?2, ?3)",
        rusqlite::params![device_id, filename, hash],
    )
    .unwrap();
}

fn snapshot_hash(conn: &rusqlite::Connection, device_id: &str, filename: &str) -> Option<String> {
    conn.query_row(
        "SELECT hash FROM device_snapshots WHERE device_id = ?1 AND filename = ?2",
        rusqlite::params![device_id, filename],
        |row| row.get(0),
    )
    .ok()
}

// ── Test cases ─────────────────────────────────────────────────────────

#[test]
fn new_note_roundtrip() {
    let (conn, tmp) = test_env();
    let content = "# Hello World";
    let hash = hash_sha256(content);

    let mut req = make_request("device-a");
    req.inventory.push(InventoryItem {
        filename: "hello.md".into(),
        hash: hash.clone(),
    });
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
    seed_snapshot(&conn, "device-a", "note.md", &original_hash);

    let edited = "# Edited by client";
    let edited_hash = hash_sha256(edited);

    let mut req = make_request("device-a");
    req.inventory.push(InventoryItem {
        filename: "note.md".into(),
        hash: edited_hash.clone(),
    });
    req.changed.push(ChangedNote {
        filename: "note.md".into(),
        content: edited.into(),
        hash: edited_hash.clone(),
        modified_at: 1000,
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
    seed_snapshot(&conn, "device-a", "note.md", &original_hash);

    // Server content was modified externally
    let server_edited = "# Edited on server";
    let server_hash = hash_sha256(server_edited);
    write_server_file(&tmp, "note.md", server_edited);
    conn.execute(
        "UPDATE note_meta SET content_hash = ?1 WHERE filename = 'note.md'",
        [&server_hash],
    )
    .unwrap();

    // Client still has original
    let mut req = make_request("device-a");
    req.inventory.push(InventoryItem {
        filename: "note.md".into(),
        hash: original_hash.clone(),
    });
    req.changed.push(ChangedNote {
        filename: "note.md".into(),
        content: original.into(),
        hash: original_hash,
        modified_at: 1000,
    });

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();
    // Server changed, client unchanged (from server's perspective via device_snapshot)
    // Actually client sends it as "changed" but device snapshot shows original_hash
    // So determine_sync_direction(original_hash, server_hash, original_hash) = ServerChanged
    // Wait — client is sending original content with original hash, but claiming it changed.
    // Let me reconsider. The client hash is original_hash, server hash is server_hash,
    // device snapshot is original_hash. So direction = ServerChanged.
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
    seed_snapshot(&conn, "device-a", "note.md", &original_hash);

    let server_edited = "# Edited on server";
    let server_hash = hash_sha256(server_edited);
    write_server_file(&tmp, "note.md", server_edited);
    conn.execute(
        "UPDATE note_meta SET content_hash = ?1 WHERE filename = 'note.md'",
        [&server_hash],
    )
    .unwrap();

    let mut req = make_request("device-a");
    req.inventory.push(InventoryItem {
        filename: "note.md".into(),
        hash: original_hash,
    });

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
    seed_snapshot(&conn, "device-a", "note.md", &original_hash);

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
    req.inventory.push(InventoryItem {
        filename: "note.md".into(),
        hash: client_hash.clone(),
    });
    req.changed.push(ChangedNote {
        filename: "note.md".into(),
        content: client_version.into(),
        hash: client_hash,
        modified_at: 1000,
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
    seed_snapshot(&conn, "device-a", "note.md", &original_hash);

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
    req.inventory.push(InventoryItem {
        filename: "note.md".into(),
        hash: converged_hash.clone(),
    });
    req.changed.push(ChangedNote {
        filename: "note.md".into(),
        content: converged.into(),
        hash: converged_hash,
        modified_at: 1000,
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
    seed_snapshot(&conn, "device-a", "deleteme.md", &hash);

    let mut req = make_request("device-a");
    req.deleted.push("deleteme.md".into());

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
    req.inventory.push(InventoryItem {
        filename: "deleted.md".into(),
        hash: "somehash".into(),
    });

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();
    assert!(resp.delete.contains(&"deleted.md".to_string()));
}

#[test]
fn delete_vs_edit() {
    let (conn, tmp) = test_env();
    let original = "# Original";
    let original_hash = hash_sha256(original);
    seed_note(&conn, &tmp, "note.md", original);
    seed_snapshot(&conn, "device-a", "note.md", &original_hash);

    // Server was edited (by another device)
    let server_edited = "# Server edited this";
    let server_hash = hash_sha256(server_edited);
    write_server_file(&tmp, "note.md", server_edited);
    conn.execute(
        "UPDATE note_meta SET content_hash = ?1 WHERE filename = 'note.md'",
        [&server_hash],
    )
    .unwrap();

    // Client deletes
    let mut req = make_request("device-a");
    req.deleted.push("note.md".into());

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
    seed_snapshot(&conn, "device-a", "old-name.md", &hash);

    // Client sends delete(old) + new(new) with same hash
    let mut req = make_request("device-a");
    req.deleted.push("old-name.md".into());
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
    req_a.inventory.push(InventoryItem {
        filename: "from-a.md".into(),
        hash: hash_a.clone(),
    });
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
    req_a2.inventory.push(InventoryItem {
        filename: "renamed-a.md".into(),
        hash: hash_a.clone(),
    });
    req_a2.deleted.push("from-a.md".into());
    req_a2.new.push(NewNote {
        filename: "renamed-a.md".into(),
        content: content_a.into(),
        hash: hash_a.clone(),
        modified_at: 1000,
    });
    let _resp_a2 = process_sync(&conn, &notes_dir(&tmp), &req_a2).unwrap();

    // Device B syncs again — should see deletion of old + new file
    let mut req_b2 = make_request("device-b");
    req_b2.inventory.push(InventoryItem {
        filename: "from-a.md".into(),
        hash: hash_a.clone(),
    });
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
    seed_snapshot(&conn, "device-a", "old-name.md", &hash);
    seed_snapshot(&conn, "device-b", "old-name.md", &hash);

    let mut req_a = make_request("device-a");
    req_a.inventory.push(InventoryItem {
        filename: "server-name.md".into(),
        hash: hash.clone(),
    });
    req_a.deleted.push("old-name.md".into());
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
    req_b.inventory.push(InventoryItem {
        filename: "client-name.md".into(),
        hash: hash.clone(),
    });
    req_b.deleted.push("old-name.md".into());
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

    // Device syncs with NO device_snapshots (lost state) but has file in inventory
    let content = "# Existing";
    let hash = hash_sha256(content);
    let mut req = make_request("recovered-device");
    req.inventory.push(InventoryItem {
        filename: "existing.md".into(),
        hash: hash.clone(),
    });

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();

    // Since hashes match and no device snapshot, direction with empty last_sync
    // is BothChanged but convergence check passes — no conflict
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
    req.inventory.push(InventoryItem {
        filename: "existing.md".into(),
        hash: hash.clone(),
    });
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
fn device_snapshot_tracks_accepted_client_edit_hash() {
    let (conn, tmp) = test_env();
    let original = "# Original";
    let original_hash = hash_sha256(original);
    seed_note(&conn, &tmp, "note.md", original);
    seed_snapshot(&conn, "device-a", "note.md", &original_hash);

    let edited = "# Edited by client";
    let edited_hash = hash_sha256(edited);

    let mut req = make_request("device-a");
    req.inventory.push(InventoryItem {
        filename: "note.md".into(),
        hash: edited_hash.clone(),
    });
    req.changed.push(ChangedNote {
        filename: "note.md".into(),
        content: edited.into(),
        hash: edited_hash.clone(),
        modified_at: 1000,
    });

    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();
    assert!(
        resp.update.is_empty(),
        "accepted client edits should not round-trip"
    );

    let stored_hash = snapshot_hash(&conn, "device-a", "note.md")
        .expect("device snapshot should be rewritten after sync");
    assert_eq!(
        stored_hash, edited_hash,
        "device_snapshots must record the hash the device now has after an accepted edit"
    );
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
    req3.inventory.push(InventoryItem {
        filename: "new.md".into(),
        hash: hash_sha256("# New"),
    });
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
    req2.inventory.push(InventoryItem {
        filename: "note.md".into(),
        hash: server_hash,
    });
    req2.inventory.push(InventoryItem {
        filename: "note (2).md".into(),
        hash: hash_sha256(client_content),
    });
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
    seed_snapshot(&conn, "device-a", "deleted.md", &hash);

    let mut del_req = make_request("device-a");
    del_req.deleted.push("deleted.md".into());
    process_sync(&conn, &notes_dir(&tmp), &del_req).unwrap();

    // Device B still has the file in inventory (stale)
    let mut req_b = make_request("device-b");
    req_b.inventory.push(InventoryItem {
        filename: "deleted.md".into(),
        hash: hash.clone(),
    });

    let resp_b = process_sync(&conn, &notes_dir(&tmp), &req_b).unwrap();

    // B should be told to delete it
    assert!(resp_b.delete.contains(&"deleted.md".to_string()));
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
    seed_snapshot(&conn, "device-a", "note.md", &base_hash);
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
    req.inventory.push(InventoryItem {
        filename: "note.md".into(),
        hash: client_hash.clone(),
    });
    req.changed.push(ChangedNote {
        filename: "note.md".into(),
        content: client_version.into(),
        hash: client_hash,
        modified_at: 2000,
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
    seed_snapshot(&conn, "device-a", "note.md", &base_hash);
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
    req.inventory.push(InventoryItem {
        filename: "note.md".into(),
        hash: client_hash.clone(),
    });
    req.changed.push(ChangedNote {
        filename: "note.md".into(),
        content: client_version.into(),
        hash: client_hash,
        modified_at: 2000,
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
    // (simulates first sync after upgrading to Phase 1.5)
    let base = "# Title\n\nParagraph.\n";
    let base_hash = hash_sha256(base);
    seed_note(&conn, &tmp, "note.md", base);
    seed_snapshot(&conn, "device-a", "note.md", &base_hash);
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
    req.inventory.push(InventoryItem {
        filename: "note.md".into(),
        hash: client_hash.clone(),
    });
    req.changed.push(ChangedNote {
        filename: "note.md".into(),
        content: client_version.into(),
        hash: client_hash,
        modified_at: 2000,
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
    seed_snapshot(&conn, "device-a", "image.png", &base_hash);
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
    req.inventory.push(InventoryItem {
        filename: "image.png".into(),
        hash: client_hash.clone(),
    });
    req.changed.push(ChangedNote {
        filename: "image.png".into(),
        content: client_version.into(),
        hash: client_hash,
        modified_at: 2000,
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

    // Set up a note that all three devices know about
    let base = "# Shared Note\n\nIntro paragraph.\n\nMiddle section.\n\nConclusion.\n";
    let base_hash = hash_sha256(base);
    seed_note(&conn, &tmp, "shared.md", base);
    seed_snapshot(&conn, "device-a", "shared.md", &base_hash);
    seed_snapshot(&conn, "device-b", "shared.md", &base_hash);
    seed_snapshot(&conn, "device-c", "shared.md", &base_hash);
    seed_content(&conn, base);

    // Device A edits the intro — syncs first
    let a_version = "# Shared Note\n\nA's intro paragraph.\n\nMiddle section.\n\nConclusion.\n";
    let a_hash = hash_sha256(a_version);
    let mut req_a = make_request("device-a");
    req_a.inventory.push(InventoryItem {
        filename: "shared.md".into(),
        hash: a_hash.clone(),
    });
    req_a.changed.push(ChangedNote {
        filename: "shared.md".into(),
        content: a_version.into(),
        hash: a_hash,
        modified_at: 2000,
    });
    let resp_a = process_sync(&conn, &notes_dir(&tmp), &req_a).unwrap();
    assert!(resp_a.conflicts.is_empty());

    // Device B edits the conclusion — syncs second (should merge with A's edit)
    let b_version = "# Shared Note\n\nIntro paragraph.\n\nMiddle section.\n\nB's conclusion.\n";
    let b_hash = hash_sha256(b_version);
    let mut req_b = make_request("device-b");
    req_b.inventory.push(InventoryItem {
        filename: "shared.md".into(),
        hash: b_hash.clone(),
    });
    req_b.changed.push(ChangedNote {
        filename: "shared.md".into(),
        content: b_version.into(),
        hash: b_hash,
        modified_at: 2000,
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

    // Device C syncs — should get the fully merged version
    let mut req_c = make_request("device-c");
    req_c.inventory.push(InventoryItem {
        filename: "shared.md".into(),
        hash: base_hash,
    });
    let resp_c = process_sync(&conn, &notes_dir(&tmp), &req_c).unwrap();

    let c_update = resp_c.update.iter().find(|u| u.filename == "shared.md");
    assert!(
        c_update.is_some(),
        "device C should receive the merged note"
    );
    assert_eq!(c_update.unwrap().content, expected_merged);
}

#[test]
fn accepted_edit_backfills_ancestor_for_next_device_merge() {
    let (conn, tmp) = test_env();

    // Simulate an existing pre-phase-1.5 note: device snapshots know the base
    // hash, but content_store has never been backfilled.
    let base = "# Title\n\nIntro paragraph.\n\nConclusion.\n";
    let base_hash = hash_sha256(base);
    seed_note(&conn, &tmp, "note.md", base);
    seed_snapshot(&conn, "device-a", "note.md", &base_hash);
    seed_snapshot(&conn, "device-b", "note.md", &base_hash);

    // Device A edits the title. The sync engine should preserve the pre-edit
    // ancestor before overwriting the server copy so device B can still merge.
    let a_version = "# Updated Title\n\nIntro paragraph.\n\nConclusion.\n";
    let a_hash = hash_sha256(a_version);
    let mut req_a = make_request("device-a");
    req_a.inventory.push(InventoryItem {
        filename: "note.md".into(),
        hash: a_hash.clone(),
    });
    req_a.changed.push(ChangedNote {
        filename: "note.md".into(),
        content: a_version.into(),
        hash: a_hash,
        modified_at: 2000,
    });

    let resp_a = process_sync(&conn, &notes_dir(&tmp), &req_a).unwrap();
    assert!(resp_a.conflicts.is_empty());
    assert!(
        resp_a.update.is_empty(),
        "accepted edits should not be echoed back when no merge was needed"
    );
    assert_eq!(
        db::get_content(&conn, &base_hash).unwrap(),
        Some(base.to_string()),
        "the old server content should be preserved as a future merge ancestor"
    );

    // Device B edits a different section from the same pre-upgrade base.
    let b_version = "# Title\n\nEdited intro paragraph.\n\nConclusion.\n";
    let b_hash = hash_sha256(b_version);
    let mut req_b = make_request("device-b");
    req_b.inventory.push(InventoryItem {
        filename: "note.md".into(),
        hash: b_hash.clone(),
    });
    req_b.changed.push(ChangedNote {
        filename: "note.md".into(),
        content: b_version.into(),
        hash: b_hash,
        modified_at: 3000,
    });

    let resp_b = process_sync(&conn, &notes_dir(&tmp), &req_b).unwrap();

    assert!(
        resp_b.conflicts.is_empty(),
        "the preserved ancestor should let the second device merge cleanly"
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
