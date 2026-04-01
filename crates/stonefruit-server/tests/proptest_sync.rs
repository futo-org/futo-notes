//! Property-based sync tests using proptest.
//!
//! These test properties that must hold regardless of the specific
//! operations: convergence, idempotency, and invariant stability.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tempfile::TempDir;

use proptest::prelude::*;

use stonefruit_core::hash::hash_sha256;
use stonefruit_core::invariants::{self, NoteRecord};
use stonefruit_core::sync::*;
use stonefruit_server::db;
use stonefruit_server::sync_engine::process_sync;

// ── Helpers ────────────────────────────────────────────────────────────

struct TestEnv {
    conn: rusqlite::Connection,
    tmp: TempDir,
}

impl TestEnv {
    fn new() -> Self {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join("notes")).unwrap();
        let conn = db::open_memory_db().unwrap();
        Self { conn, tmp }
    }

    fn notes_dir(&self) -> PathBuf {
        self.tmp.path().join("notes")
    }
}

/// Minimal simulated client for property tests.
struct Client {
    device_id: String,
    vault_dir: PathBuf,
    file_hashes: HashMap<String, String>,
}

impl Client {
    fn new(device_id: &str, base: &Path) -> Self {
        let vault_dir = base.join(format!("vault-{device_id}"));
        std::fs::create_dir_all(&vault_dir).unwrap();
        Self {
            device_id: device_id.to_string(),
            vault_dir,
            file_hashes: HashMap::new(),
        }
    }

    fn write(&self, filename: &str, content: &str) {
        std::fs::write(self.vault_dir.join(filename), content).unwrap();
    }

    #[allow(dead_code)]
    fn read(&self, filename: &str) -> Option<String> {
        std::fs::read_to_string(self.vault_dir.join(filename)).ok()
    }

    fn delete(&self, filename: &str) {
        let _ = std::fs::remove_file(self.vault_dir.join(filename));
    }

    fn list_md(&self) -> HashMap<String, String> {
        std::fs::read_dir(&self.vault_dir)
            .unwrap()
            .filter_map(|e| {
                let e = e.ok()?;
                let name = e.file_name().to_str()?.to_string();
                if name.ends_with(".md") {
                    let content = std::fs::read_to_string(e.path()).ok()?;
                    Some((name, content))
                } else {
                    None
                }
            })
            .collect()
    }

    fn prepare_and_sync(&mut self, conn: &rusqlite::Connection, notes_dir: &Path) -> SyncResponse {
        let current = self.list_md();
        let mut req = SyncRequest {
            device_id: self.device_id.clone(),
            inventory: Vec::new(),
            changed: Vec::new(),
            new: Vec::new(),
            deleted: Vec::new(),
        };

        for (filename, content) in &current {
            let hash = hash_sha256(content);
            req.inventory.push(InventoryItem {
                filename: filename.clone(),
                hash: hash.clone(),
            });
            match self.file_hashes.get(filename) {
                Some(old) if old != &hash => {
                    req.changed.push(ChangedNote {
                        filename: filename.clone(),
                        content: content.clone(),
                        hash,
                        modified_at: 0,
                    });
                }
                None => {
                    req.new.push(NewNote {
                        filename: filename.clone(),
                        content: content.clone(),
                        hash,
                        modified_at: 0,
                    });
                }
                _ => {}
            }
        }
        for filename in self.file_hashes.keys() {
            if !current.contains_key(filename) {
                req.deleted.push(filename.clone());
            }
        }

        let resp = process_sync(conn, notes_dir, &req).unwrap();

        // Apply response
        for update in &resp.update {
            if !update.content.is_empty() {
                self.write(&update.filename, &update.content);
            }
            self.file_hashes
                .insert(update.filename.clone(), update.hash.clone());
        }
        for filename in &resp.delete {
            self.delete(filename);
            self.file_hashes.remove(filename);
        }
        for conflict in &resp.conflicts {
            self.write(&conflict.filename, &conflict.content);
            let hash = hash_sha256(&conflict.content);
            self.file_hashes.insert(conflict.filename.clone(), hash);
        }
        // Re-snapshot local state
        let final_state = self.list_md();
        for (filename, content) in &final_state {
            self.file_hashes
                .insert(filename.clone(), hash_sha256(content));
        }
        // Remove hashes for files that no longer exist
        self.file_hashes.retain(|f, _| final_state.contains_key(f));

        resp
    }
}

// ── Operation type for random test generation ──────────────────────────

#[derive(Debug, Clone)]
enum Op {
    Create { filename: String, content: String },
    Edit { note_idx: usize, content: String },
    Delete { note_idx: usize },
}

/// Strategy to generate a safe filename (alphanumeric + spaces, .md extension).
fn filename_strategy() -> impl Strategy<Value = String> {
    "[a-z][a-z0-9 ]{1,15}"
        .prop_map(|s| format!("{}.md", s.trim()))
        .prop_filter("non-empty stem", |s| s.len() > 3)
}

fn content_strategy() -> impl Strategy<Value = String> {
    "# [A-Z][a-z]{2,10}\n[a-z ]{5,30}"
}

fn op_strategy() -> impl Strategy<Value = Op> {
    prop_oneof![
        3 => (filename_strategy(), content_strategy()).prop_map(|(f, c)| Op::Create {
            filename: f,
            content: c,
        }),
        2 => (0..10usize, content_strategy()).prop_map(|(idx, c)| Op::Edit {
            note_idx: idx,
            content: c,
        }),
        1 => (0..10usize).prop_map(|idx| Op::Delete { note_idx: idx }),
    ]
}

/// Apply an operation to a client, using its current file list.
fn apply_op(client: &Client, op: &Op) {
    let files: Vec<String> = client.list_md().keys().cloned().collect();
    match op {
        Op::Create { filename, content } => {
            client.write(filename, content);
        }
        Op::Edit { note_idx, content } => {
            if !files.is_empty() {
                let filename = &files[*note_idx % files.len()];
                client.write(filename, content);
            }
        }
        Op::Delete { note_idx } => {
            if !files.is_empty() {
                let filename = &files[*note_idx % files.len()];
                client.delete(filename);
            }
        }
    }
}

fn collect_invariant_inputs(conn: &rusqlite::Connection) -> (Vec<NoteRecord>, HashSet<String>) {
    let mut stmt = conn
        .prepare("SELECT filename, content_hash, is_blob FROM note_meta")
        .unwrap();
    let records: Vec<NoteRecord> = stmt
        .query_map([], |row| {
            Ok(NoteRecord {
                filename: row.get(0)?,
                content_hash: row.get(1)?,
                is_blob: row.get::<_, i32>(2)? != 0,
            })
        })
        .unwrap()
        .map(|r| r.unwrap())
        .collect();

    let mut stmt = conn.prepare("SELECT filename FROM tombstones").unwrap();
    let tombstones: HashSet<String> = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();

    (records, tombstones)
}

// ── Property: Convergence ──────────────────────────────────────────────
//
// After all devices sync, every device has identical .md file content.

proptest! {
    #![proptest_config(ProptestConfig::with_cases(30))]

    #[test]
    fn convergence(
        ops_a in prop::collection::vec(op_strategy(), 1..6),
        ops_b in prop::collection::vec(op_strategy(), 1..6),
    ) {
        let env = TestEnv::new();
        let mut a = Client::new("a", env.tmp.path());
        let mut b = Client::new("b", env.tmp.path());

        // Both start synced (empty)
        a.prepare_and_sync(&env.conn, &env.notes_dir());
        b.prepare_and_sync(&env.conn, &env.notes_dir());

        // Apply random operations to each device
        for op in &ops_a {
            apply_op(&a, op);
        }
        for op in &ops_b {
            apply_op(&b, op);
        }

        // Sync both devices (A first, then B, then A again to pick up B's changes)
        a.prepare_and_sync(&env.conn, &env.notes_dir());
        b.prepare_and_sync(&env.conn, &env.notes_dir());
        a.prepare_and_sync(&env.conn, &env.notes_dir());
        // One more round to handle any conflict copies
        b.prepare_and_sync(&env.conn, &env.notes_dir());
        a.prepare_and_sync(&env.conn, &env.notes_dir());

        // Both devices should have identical file content
        let a_state = a.list_md();
        let b_state = b.list_md();

        prop_assert_eq!(
            a_state.keys().collect::<HashSet<_>>(),
            b_state.keys().collect::<HashSet<_>>(),
            "devices must have the same filenames after convergence"
        );
        for (filename, a_content) in &a_state {
            prop_assert_eq!(
                a_content,
                b_state.get(filename).unwrap(),
                "content mismatch for {}",
                filename
            );
        }
    }
}

// ── Property: Idempotency ──────────────────────────────────────────────
//
// Re-syncing when already converged is a no-op: no version bump, no
// file changes, no updates/deletes/conflicts.

proptest! {
    #![proptest_config(ProptestConfig::with_cases(30))]

    #[test]
    fn idempotency(
        ops in prop::collection::vec(op_strategy(), 1..8),
    ) {
        let env = TestEnv::new();
        let mut a = Client::new("a", env.tmp.path());

        // Apply ops and sync
        for op in &ops {
            apply_op(&a, op);
        }
        a.prepare_and_sync(&env.conn, &env.notes_dir());

        // Record state after first sync
        let state_after_first = a.list_md();
        let version_after_first: u64 = env.conn
            .query_row("SELECT CAST(value AS INTEGER) FROM sync_meta WHERE key = 'sync_version'", [], |row| row.get(0))
            .unwrap_or(0);

        // Sync again — should be a no-op
        let resp = a.prepare_and_sync(&env.conn, &env.notes_dir());
        let state_after_second = a.list_md();
        let version_after_second: u64 = env.conn
            .query_row("SELECT CAST(value AS INTEGER) FROM sync_meta WHERE key = 'sync_version'", [], |row| row.get(0))
            .unwrap_or(0);

        prop_assert!(resp.update.is_empty(), "no updates on idempotent sync");
        prop_assert!(resp.delete.is_empty(), "no deletes on idempotent sync");
        prop_assert!(resp.conflicts.is_empty(), "no conflicts on idempotent sync");
        prop_assert_eq!(version_after_second, version_after_first, "version should not change");
        prop_assert_eq!(state_after_second, state_after_first, "files should not change");
    }
}

// ── Property: Invariant Stability ──────────────────────────────────────
//
// Post-sync invariants (content-hash parity, no orphans, no duplicate
// filenames, tombstone exclusion) pass after every operation sequence.

proptest! {
    #![proptest_config(ProptestConfig::with_cases(30))]

    #[test]
    fn invariant_stability(
        ops_a in prop::collection::vec(op_strategy(), 1..8),
        ops_b in prop::collection::vec(op_strategy(), 0..4),
    ) {
        let env = TestEnv::new();
        let mut a = Client::new("a", env.tmp.path());
        let mut b = Client::new("b", env.tmp.path());

        // Apply ops and sync
        for op in &ops_a {
            apply_op(&a, op);
        }
        a.prepare_and_sync(&env.conn, &env.notes_dir());

        for op in &ops_b {
            apply_op(&b, op);
        }
        b.prepare_and_sync(&env.conn, &env.notes_dir());

        // Final sync round
        a.prepare_and_sync(&env.conn, &env.notes_dir());
        b.prepare_and_sync(&env.conn, &env.notes_dir());

        // Check invariants
        let (records, tombstones) = collect_invariant_inputs(&env.conn);
        let active: HashSet<String> = records.iter().map(|r| r.filename.clone()).collect();
        let version: u64 = env.conn
            .query_row("SELECT CAST(value AS INTEGER) FROM sync_meta WHERE key = 'sync_version'", [], |row| row.get(0))
            .unwrap_or(0);

        let violations = invariants::run_all_invariants(
            &records,
            &env.notes_dir(),
            &active,
            &tombstones,
            0,
            version,
        );

        // Filter VersionRegression (we pass 0 as before)
        let real_violations: Vec<_> = violations
            .into_iter()
            .filter(|v| !matches!(v, invariants::InvariantViolation::VersionRegression { .. }))
            .collect();

        prop_assert!(
            real_violations.is_empty(),
            "invariant violations after sync: {real_violations:?}"
        );
    }
}
