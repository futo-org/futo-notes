//! Golden-vault integration tests — the sync engine's executable specification.
//!
//! Each test simulates the full multi-device sync lifecycle using a
//! `SimulatedClient` that mirrors the real client's V2SyncState
//! (device_id, file_hashes, last_server_version, local files).
//!
//! These tests exercise the **sequencing** that single-device tests
//! in `sync.rs` cannot: Device A acts → syncs → Device B syncs →
//! verify both devices converge.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tempfile::TempDir;

use stonefruit_core::hash::hash_sha256;
use stonefruit_core::sync::*;
use stonefruit_server::db;
use stonefruit_server::sync_engine::process_sync;

// ── SimulatedClient ────────────────────────────────────────────────────

/// A simulated V2 client that tracks its local state the same way the
/// real Tauri client does: a vault directory + file_hashes map + version.
struct SimulatedClient {
    device_id: String,
    vault_dir: PathBuf,
    file_hashes: HashMap<String, String>,
    last_server_version: u64,
}

impl SimulatedClient {
    fn new(device_id: &str, vault_dir: PathBuf) -> Self {
        std::fs::create_dir_all(&vault_dir).unwrap();
        Self {
            device_id: device_id.to_string(),
            vault_dir,
            file_hashes: HashMap::new(),
            last_server_version: 0,
        }
    }

    /// Write a file to the client's local vault.
    fn write_local(&self, filename: &str, content: &str) {
        std::fs::write(self.vault_dir.join(filename), content).unwrap();
    }

    /// Read a file from the client's local vault.
    fn read_local(&self, filename: &str) -> Option<String> {
        std::fs::read_to_string(self.vault_dir.join(filename)).ok()
    }

    /// Delete a file from the client's local vault.
    fn delete_local(&self, filename: &str) {
        let _ = std::fs::remove_file(self.vault_dir.join(filename));
    }

    /// Check if a file exists in the client's local vault.
    fn file_exists(&self, filename: &str) -> bool {
        self.vault_dir.join(filename).exists()
    }

    /// List all .md files in the client's vault.
    fn list_files(&self) -> Vec<String> {
        std::fs::read_dir(&self.vault_dir)
            .unwrap()
            .filter_map(|e| {
                let e = e.ok()?;
                let name = e.file_name().to_str()?.to_string();
                if name.ends_with(".md") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect()
    }

    /// Build a SyncRequest by comparing current files against file_hashes,
    /// exactly like the real client's `prepareSyncPayloadV2`.
    fn prepare_sync(&self) -> SyncRequest {
        let mut inventory = Vec::new();
        let mut changed = Vec::new();
        let mut new = Vec::new();
        let mut deleted = Vec::new();
        let mut deleted_baselines = HashMap::new();

        // Scan current files
        let current_files: HashMap<String, String> = self
            .list_files()
            .into_iter()
            .map(|name| {
                let content = self.read_local(&name).unwrap();
                let hash = hash_sha256(&content);
                (name, hash)
            })
            .collect();

        // Classify each file
        for (filename, hash) in &current_files {
            inventory.push(InventoryItem {
                filename: filename.clone(),
                hash: hash.clone(),
            });
            match self.file_hashes.get(filename) {
                Some(old_hash) if old_hash != hash => {
                    let content = self.read_local(filename).unwrap();
                    changed.push(ChangedNote {
                        filename: filename.clone(),
                        content,
                        hash: hash.clone(),
                        modified_at: 0,
                        baseline_hash: self.file_hashes.get(filename).cloned(),
                    });
                }
                None => {
                    let content = self.read_local(filename).unwrap();
                    new.push(NewNote {
                        filename: filename.clone(),
                        content,
                        hash: hash.clone(),
                        modified_at: 0,
                    });
                }
                _ => {} // unchanged
            }
        }

        // Detect deletions
        for filename in self.file_hashes.keys() {
            if !current_files.contains_key(filename) {
                deleted.push(filename.clone());
                if let Some(hash) = self.file_hashes.get(filename) {
                    deleted_baselines.insert(filename.clone(), hash.clone());
                }
            }
        }

        SyncRequest {
            device_id: self.device_id.clone(),
            inventory: Some(inventory),
            changed,
            new,
            deleted,
            last_version: Some(self.last_server_version),
            deleted_baselines,
        }
    }

    /// Apply a SyncResponse to local state, exactly like the real client's
    /// `applySyncDeltaV2`.
    fn apply_response(&mut self, resp: &SyncResponse) {
        // Write updates
        for update in &resp.update {
            if !update.content.is_empty() {
                self.write_local(&update.filename, &update.content);
            }
            self.file_hashes
                .insert(update.filename.clone(), update.hash.clone());
        }

        // Delete files
        for filename in &resp.delete {
            self.delete_local(filename);
            self.file_hashes.remove(filename);
        }

        // Write conflict copies
        for conflict in &resp.conflicts {
            self.write_local(&conflict.filename, &conflict.content);
            let hash = hash_sha256(&conflict.content);
            self.file_hashes.insert(conflict.filename.clone(), hash);
        }

        // Update hashes for files we sent that were accepted (no update/conflict back)
        let current_files: HashMap<String, String> = self
            .list_files()
            .into_iter()
            .map(|name| {
                let content = self.read_local(&name).unwrap();
                (name, hash_sha256(&content))
            })
            .collect();
        for (filename, hash) in &current_files {
            self.file_hashes.insert(filename.clone(), hash.clone());
        }

        self.last_server_version = resp.version;
    }

    /// Full sync cycle: prepare → send to server → apply response.
    fn sync(&mut self, conn: &rusqlite::Connection, server_notes_dir: &Path) -> SyncResponse {
        let req = self.prepare_sync();
        let resp = process_sync(conn, server_notes_dir, &req).unwrap();
        self.apply_response(&resp);
        resp
    }
}

// ── Test environment ───────────────────────────────────────────────────

struct GoldenVaultEnv {
    conn: rusqlite::Connection,
    tmp: TempDir,
}

impl GoldenVaultEnv {
    fn new() -> Self {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("notes")).unwrap();
        let conn = db::open_memory_db().unwrap();
        Self { conn, tmp }
    }

    fn notes_dir(&self) -> PathBuf {
        self.tmp.path().join("notes")
    }

    fn client(&self, device_id: &str) -> SimulatedClient {
        let vault_dir = self.tmp.path().join(format!("vault-{device_id}"));
        SimulatedClient::new(device_id, vault_dir)
    }

    fn server_file_exists(&self, filename: &str) -> bool {
        self.notes_dir().join(filename).exists()
    }

    #[allow(dead_code)]
    fn read_server_file(&self, filename: &str) -> Option<String> {
        std::fs::read_to_string(self.notes_dir().join(filename)).ok()
    }
}

// ── Golden vault tests ─────────────────────────────────────────────────

#[test]
fn gv_new_note_roundtrip() {
    let env = GoldenVaultEnv::new();
    let mut a = env.client("a");
    let mut b = env.client("b");

    // A creates a note locally
    a.write_local("grocery list.md", "# Grocery List\n- milk\n- eggs");

    // A syncs — note goes to server
    let resp_a = a.sync(&env.conn, &env.notes_dir());
    assert!(resp_a.version > 0);
    assert!(env.server_file_exists("grocery list.md"));

    // B syncs — gets the note
    let resp_b = b.sync(&env.conn, &env.notes_dir());
    assert!(b.file_exists("grocery list.md"));
    assert_eq!(
        b.read_local("grocery list.md").unwrap(),
        "# Grocery List\n- milk\n- eggs"
    );

    // Both devices now have identical files
    assert_eq!(
        a.read_local("grocery list.md"),
        b.read_local("grocery list.md")
    );
    assert_eq!(resp_b.update.len(), 1);
}

#[test]
fn gv_concurrent_edit_conflict() {
    let env = GoldenVaultEnv::new();
    let mut a = env.client("a");
    let mut b = env.client("b");

    // Both get the same initial note
    a.write_local("shared.md", "# Shared Note\nOriginal content");
    a.sync(&env.conn, &env.notes_dir());
    b.sync(&env.conn, &env.notes_dir());
    assert!(b.file_exists("shared.md"));

    // Both edit the note locally (without syncing)
    a.write_local("shared.md", "# Shared Note\nEdited by A");
    b.write_local("shared.md", "# Shared Note\nEdited by B");

    // A syncs first — server accepts A's version
    let resp_a = a.sync(&env.conn, &env.notes_dir());
    assert!(resp_a.conflicts.is_empty());

    // B syncs — conflict detected
    let resp_b = b.sync(&env.conn, &env.notes_dir());
    assert_eq!(resp_b.conflicts.len(), 1, "B should get a conflict copy");
    assert!(
        resp_b.conflicts[0].filename.contains("conflict"),
        "conflict copy should have 'conflict' in name"
    );

    // B should also get A's version as the canonical file
    assert!(resp_b
        .update
        .iter()
        .any(|u| u.filename == "shared.md" && u.content == "# Shared Note\nEdited by A"));

    // Server should have both the canonical and conflict file
    assert!(env.server_file_exists("shared.md"));
    assert!(env.server_file_exists(&resp_b.conflicts[0].filename));

    // Now A syncs again to pick up the conflict copy
    let resp_a2 = a.sync(&env.conn, &env.notes_dir());
    assert!(resp_a2
        .update
        .iter()
        .any(|u| u.filename.contains("conflict")));

    // Both devices should now have the same set of files
    let a_files: HashSet<String> = a.list_files().into_iter().collect();
    let b_files: HashSet<String> = b.list_files().into_iter().collect();
    assert_eq!(a_files, b_files, "both devices should converge");
}

#[test]
fn gv_rename_propagation() {
    let env = GoldenVaultEnv::new();
    let mut a = env.client("a");
    let mut b = env.client("b");

    // Both start with the same note
    a.write_local("old name.md", "# Content stays the same");
    a.sync(&env.conn, &env.notes_dir());
    b.sync(&env.conn, &env.notes_dir());
    assert!(b.file_exists("old name.md"));

    // A renames: delete old + create new (same content)
    a.delete_local("old name.md");
    a.write_local("new name.md", "# Content stays the same");
    a.sync(&env.conn, &env.notes_dir());

    // B syncs — should see the rename
    b.sync(&env.conn, &env.notes_dir());
    assert!(
        !b.file_exists("old name.md"),
        "old name should be gone on B"
    );
    assert!(b.file_exists("new name.md"), "new name should appear on B");
    assert_eq!(
        b.read_local("new name.md").unwrap(),
        "# Content stays the same"
    );
}

#[test]
fn gv_rename_heuristic() {
    let env = GoldenVaultEnv::new();
    let mut a = env.client("a");

    // A creates and syncs a note
    a.write_local("draft.md", "# My Draft");
    a.sync(&env.conn, &env.notes_dir());

    // A renames (delete old, create new with same content)
    a.delete_local("draft.md");
    a.write_local("final.md", "# My Draft");

    // Prepare sync manually to verify the request shape
    let req = a.prepare_sync();
    assert!(req.deleted.contains(&"draft.md".to_string()));
    assert!(req.new.iter().any(|n| n.filename == "final.md"));

    // The hashes should match (same content)
    let deleted_hash = a.file_hashes.get("draft.md").unwrap();
    let new_hash = &req
        .new
        .iter()
        .find(|n| n.filename == "final.md")
        .unwrap()
        .hash;
    assert_eq!(deleted_hash, new_hash, "rename heuristic: hashes match");

    // Complete the sync
    a.sync(&env.conn, &env.notes_dir());

    // Server should have final.md, not draft.md
    assert!(!env.server_file_exists("draft.md"));
    assert!(env.server_file_exists("final.md"));
}

#[test]
fn gv_rename_vs_rename() {
    let env = GoldenVaultEnv::new();
    let mut a = env.client("a");
    let mut b = env.client("b");

    // Both start with the same note
    a.write_local("original.md", "# Same content");
    a.sync(&env.conn, &env.notes_dir());
    b.sync(&env.conn, &env.notes_dir());

    // A renames to "alpha.md", B renames to "beta.md" — same content
    a.delete_local("original.md");
    a.write_local("alpha.md", "# Same content");

    b.delete_local("original.md");
    b.write_local("beta.md", "# Same content");

    // A syncs first — server accepts "alpha.md"
    a.sync(&env.conn, &env.notes_dir());
    assert!(env.server_file_exists("alpha.md"));
    assert!(!env.server_file_exists("original.md"));

    // B syncs — server wins, "alpha.md" is canonical
    let resp_b = b.sync(&env.conn, &env.notes_dir());
    assert!(
        resp_b.update.iter().any(|u| u.filename == "alpha.md"),
        "B should receive the server's rename"
    );

    // B should end up with alpha.md (server wins)
    assert!(b.file_exists("alpha.md"));

    // Server should have exactly one active note
    let count: i64 = env
        .conn
        .query_row("SELECT COUNT(*) FROM note_meta", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 1, "rename-vs-rename should not fork the note");
}

#[test]
fn gv_delete_propagation() {
    let env = GoldenVaultEnv::new();
    let mut a = env.client("a");
    let mut b = env.client("b");

    // Both start with the same note
    a.write_local("to-delete.md", "# Delete me");
    a.sync(&env.conn, &env.notes_dir());
    b.sync(&env.conn, &env.notes_dir());
    assert!(b.file_exists("to-delete.md"));

    // A deletes
    a.delete_local("to-delete.md");
    a.sync(&env.conn, &env.notes_dir());

    // B syncs — should remove the note
    let resp_b = b.sync(&env.conn, &env.notes_dir());
    assert!(resp_b.delete.contains(&"to-delete.md".to_string()));
    assert!(!b.file_exists("to-delete.md"));

    // Server should have tombstone
    let has_tombstone: bool = env
        .conn
        .query_row(
            "SELECT COUNT(*) > 0 FROM tombstones WHERE filename = 'to-delete.md'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(has_tombstone);
}

#[test]
fn gv_delete_vs_edit() {
    let env = GoldenVaultEnv::new();
    let mut a = env.client("a");
    let mut b = env.client("b");

    // Both start with the same note
    a.write_local("contested.md", "# Original");
    a.sync(&env.conn, &env.notes_dir());
    b.sync(&env.conn, &env.notes_dir());

    // A edits, B deletes — simultaneously
    a.write_local("contested.md", "# Important update by A");
    b.delete_local("contested.md");

    // A syncs first — edit accepted
    a.sync(&env.conn, &env.notes_dir());

    // B syncs — delete loses because server has a newer version
    let resp_b = b.sync(&env.conn, &env.notes_dir());
    assert!(
        resp_b
            .update
            .iter()
            .any(|u| u.filename == "contested.md" && u.content == "# Important update by A"),
        "B should receive A's edit (delete-vs-edit keeps edit)"
    );

    // B should have the file restored
    assert!(b.file_exists("contested.md"));
    assert_eq!(
        b.read_local("contested.md").unwrap(),
        "# Important update by A"
    );
}

#[test]
fn gv_external_edit() {
    let env = GoldenVaultEnv::new();
    let mut a = env.client("a");
    let mut b = env.client("b");

    // A creates and syncs a note
    a.write_local("note.md", "# Version 1");
    a.sync(&env.conn, &env.notes_dir());
    b.sync(&env.conn, &env.notes_dir());

    // Server file is edited directly (simulating another device or manual edit)
    let server_content = "# Version 2 (server direct edit)";
    let server_hash = hash_sha256(server_content);
    std::fs::write(env.notes_dir().join("note.md"), server_content).unwrap();
    env.conn
        .execute(
            "UPDATE note_meta SET content_hash = ?1 WHERE filename = 'note.md'",
            [&server_hash],
        )
        .unwrap();

    // A syncs — should get the updated version
    let resp_a = a.sync(&env.conn, &env.notes_dir());
    assert!(resp_a.update.iter().any(|u| u.filename == "note.md"));
    assert_eq!(a.read_local("note.md").unwrap(), server_content);

    // B syncs — also gets the update
    let resp_b = b.sync(&env.conn, &env.notes_dir());
    assert!(resp_b.update.iter().any(|u| u.filename == "note.md"));
    assert_eq!(b.read_local("note.md").unwrap(), server_content);
}

#[test]
fn gv_blob_roundtrip() {
    let env = GoldenVaultEnv::new();

    // Simulate blob upload by writing directly to server (blobs go through
    // PUT /blob/{filename} in real code, but here we test the metadata tracking)
    let blob_data = b"fake-png-data";
    let blob_hash = stonefruit_core::hash::hash_sha256_bytes(blob_data);
    std::fs::write(env.notes_dir().join("photo.png"), blob_data).unwrap();
    env.conn
        .execute(
            "INSERT INTO note_meta (filename, content_hash, modified_at, is_blob) VALUES (?1, ?2, ?3, 1)",
            rusqlite::params!["photo.png", blob_hash, 1000],
        )
        .unwrap();

    // Client A syncs — should see the blob in updates (empty content for blobs)
    let mut a = env.client("a");
    let resp_a = a.sync(&env.conn, &env.notes_dir());
    assert!(resp_a
        .update
        .iter()
        .any(|u| u.filename == "photo.png" && u.content.is_empty()));

    // Client B syncs — also sees it
    let mut b = env.client("b");
    let resp_b = b.sync(&env.conn, &env.notes_dir());
    assert!(resp_b
        .update
        .iter()
        .any(|u| u.filename == "photo.png" && u.content.is_empty()));
}

#[test]
fn gv_empty_vault_bootstrap() {
    let env = GoldenVaultEnv::new();

    // Server already has several notes
    let notes = vec![
        ("meeting notes.md", "# Meeting Notes\n- Discussed roadmap"),
        ("todo.md", "# TODO\n- [ ] Ship v2"),
        ("journal.md", "# Journal\nDay 1"),
        ("recipe.md", "# Pasta Recipe\n1. Boil water"),
        ("ideas.md", "# Ideas\n- Build a notes app"),
    ];
    for (filename, content) in &notes {
        let hash = hash_sha256(content);
        std::fs::write(env.notes_dir().join(filename), content).unwrap();
        env.conn
            .execute(
                "INSERT INTO note_meta (filename, content_hash, modified_at, is_blob) VALUES (?1, ?2, 1000, 0)",
                rusqlite::params![filename, hash],
            )
            .unwrap();
    }

    // Fresh client with empty vault
    let mut client = env.client("fresh");
    let resp = client.sync(&env.conn, &env.notes_dir());

    assert_eq!(resp.update.len(), 5);

    // All notes should now be in the client's vault
    for (filename, content) in &notes {
        assert!(client.file_exists(filename), "missing: {filename}");
        assert_eq!(client.read_local(filename).unwrap(), *content);
    }
}

#[test]
fn gv_lost_app_state_recovery() {
    let env = GoldenVaultEnv::new();
    let mut a = env.client("a");

    // A creates multiple notes and syncs
    let notes = vec![
        ("note1.md", "# Note 1"),
        ("note2.md", "# Note 2"),
        ("note3.md", "# Note 3"),
    ];
    for (filename, content) in &notes {
        a.write_local(filename, content);
    }
    a.sync(&env.conn, &env.notes_dir());

    // Simulate losing app-state: clear file_hashes and version
    a.file_hashes.clear();
    a.last_server_version = 0;

    // A syncs again — should recover without data loss or conflicts
    let resp = a.sync(&env.conn, &env.notes_dir());

    // No conflicts because content matches
    assert!(
        resp.conflicts.is_empty(),
        "lost-state recovery should not create conflicts when content matches"
    );

    // All notes should still exist
    for (filename, _) in &notes {
        assert!(a.file_exists(filename));
    }

    // Server should still have exactly 3 notes (no duplicates)
    let count: i64 = env
        .conn
        .query_row("SELECT COUNT(*) FROM note_meta", [], |row| row.get(0))
        .unwrap();
    assert_eq!(count, 3, "no duplicate notes after recovery");
}

#[test]
fn gv_large_inventory() {
    let env = GoldenVaultEnv::new();
    let mut a = env.client("a");
    let mut b = env.client("b");

    // A creates 1000 notes
    for i in 0..1000 {
        let filename = format!("note-{i:04}.md");
        let content = format!("# Note {i}\nContent for note number {i}.");
        a.write_local(&filename, &content);
    }

    // A syncs all 1000
    let resp_a = a.sync(&env.conn, &env.notes_dir());
    assert!(resp_a.version > 0);

    // B syncs — should get all 1000
    let resp_b = b.sync(&env.conn, &env.notes_dir());
    assert_eq!(resp_b.update.len(), 1000);

    let b_files = b.list_files();
    assert_eq!(b_files.len(), 1000);

    // Spot-check a few
    assert_eq!(
        b.read_local("note-0000.md").unwrap(),
        "# Note 0\nContent for note number 0."
    );
    assert_eq!(
        b.read_local("note-0999.md").unwrap(),
        "# Note 999\nContent for note number 999."
    );

    // Verify convergence: A and B have identical file sets
    let a_files: HashSet<String> = a.list_files().into_iter().collect();
    let b_files: HashSet<String> = b.list_files().into_iter().collect();
    assert_eq!(a_files, b_files);
}
