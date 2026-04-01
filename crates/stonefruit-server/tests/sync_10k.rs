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

/// Seed a note directly into the server's DB + disk (simulating prior sync).
fn seed_note(conn: &rusqlite::Connection, tmp: &TempDir, filename: &str, content: &str) {
    let hash = hash_sha256(content);
    std::fs::write(notes_dir(tmp).join(filename), content).unwrap();
    conn.execute(
        "INSERT INTO note_meta (filename, content_hash, modified_at, is_blob) VALUES (?1, ?2, ?3, 0)",
        rusqlite::params![filename, hash, 1000],
    ).unwrap();
}

// ── 10k-note tests ──────────────────────────────────────────────────────

const NOTE_COUNT: usize = 10_000;

#[test]
fn fresh_client_sync_10k_notes() {
    let (conn, tmp) = test_env();

    // Populate 10k notes on the server
    for i in 0..NOTE_COUNT {
        let filename = format!("note-{i:05}.md");
        let content = format!("# Note {i}\n\nContent for note number {i}.");
        seed_note(&conn, &tmp, &filename, &content);
    }

    // Fresh client syncs with empty inventory
    let req = make_request("device-fresh");
    let resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();

    // All 10k notes should appear in the response
    assert_eq!(
        resp.update.len(),
        NOTE_COUNT,
        "expected all {NOTE_COUNT} notes in response.update"
    );
    assert!(resp.delete.is_empty());
    assert!(resp.conflicts.is_empty());
    // Version is 0 for a read-only sync (no server-side mutations);
    // this is correct — version only increments on writes.

    // Verify every note is present with correct content
    let update_filenames: HashSet<String> =
        resp.update.iter().map(|u| u.filename.clone()).collect();
    for i in 0..NOTE_COUNT {
        let filename = format!("note-{i:05}.md");
        assert!(
            update_filenames.contains(&filename),
            "missing note: {filename}"
        );
    }

    // Spot-check content and hashes
    let first = resp
        .update
        .iter()
        .find(|u| u.filename == "note-00000.md")
        .unwrap();
    let expected_content = "# Note 0\n\nContent for note number 0.";
    assert_eq!(first.content, expected_content);
    assert_eq!(first.hash, hash_sha256(expected_content));

    let last = resp
        .update
        .iter()
        .find(|u| u.filename == "note-09999.md")
        .unwrap();
    let expected_last = "# Note 9999\n\nContent for note number 9999.";
    assert_eq!(last.content, expected_last);
    assert_eq!(last.hash, hash_sha256(expected_last));

    // Timestamps should be populated for all notes
    assert_eq!(
        resp.timestamps.len(),
        NOTE_COUNT,
        "expected timestamps for all {NOTE_COUNT} notes"
    );
}

#[test]
fn second_sync_after_10k_notes_is_noop() {
    let (conn, tmp) = test_env();

    // Populate 10k notes
    for i in 0..NOTE_COUNT {
        let filename = format!("note-{i:05}.md");
        let content = format!("# Note {i}\n\nContent for note number {i}.");
        seed_note(&conn, &tmp, &filename, &content);
    }

    // First sync — fresh client gets everything
    let req = make_request("device-a");
    let resp1 = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();
    assert_eq!(resp1.update.len(), NOTE_COUNT);

    // Second sync — client now has all notes in inventory
    let mut req2 = make_request("device-a");
    for update in &resp1.update {
        req2.inventory.push(InventoryItem {
            filename: update.filename.clone(),
            hash: update.hash.clone(),
        });
    }

    let resp2 = process_sync(&conn, &notes_dir(&tmp), &req2).unwrap();

    // Nothing should change
    assert!(
        resp2.update.is_empty(),
        "second sync should send no updates, got {}",
        resp2.update.len()
    );
    assert!(resp2.delete.is_empty());
    assert!(resp2.conflicts.is_empty());
}

#[test]
fn partial_inventory_sync_10k_notes() {
    let (conn, tmp) = test_env();

    // Populate 10k notes
    for i in 0..NOTE_COUNT {
        let filename = format!("note-{i:05}.md");
        let content = format!("# Note {i}\n\nContent for note number {i}.");
        seed_note(&conn, &tmp, &filename, &content);
    }

    // Client already has the first 5000 notes
    let req = make_request("device-partial");

    // First do a full sync to establish device snapshots
    let full_resp = process_sync(&conn, &notes_dir(&tmp), &req).unwrap();
    assert_eq!(full_resp.update.len(), NOTE_COUNT);

    // Now simulate a client that only has the first half
    let mut req2 = make_request("device-partial");
    for update in full_resp.update.iter().take(NOTE_COUNT / 2) {
        req2.inventory.push(InventoryItem {
            filename: update.filename.clone(),
            hash: update.hash.clone(),
        });
    }

    let resp = process_sync(&conn, &notes_dir(&tmp), &req2).unwrap();

    // Should get back the other 5000 notes the client doesn't have
    assert_eq!(
        resp.update.len(),
        NOTE_COUNT / 2,
        "expected {expected} updates for missing notes, got {actual}",
        expected = NOTE_COUNT / 2,
        actual = resp.update.len()
    );

    // Verify the returned notes are the ones the client was missing
    let update_filenames: HashSet<String> =
        resp.update.iter().map(|u| u.filename.clone()).collect();
    for update in full_resp.update.iter().skip(NOTE_COUNT / 2) {
        assert!(
            update_filenames.contains(&update.filename),
            "missing note in partial sync: {}",
            update.filename
        );
    }
}
