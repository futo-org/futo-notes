//! Integration test: end-to-end cycle of hashing, change classification, and invariant checks.

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use stonefruit_core::files;
use stonefruit_core::hash;
use stonefruit_core::invariants::{self, NoteRecord};
use stonefruit_core::sync;

fn temp_dir() -> PathBuf {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!("stonefruit-core-integ-{ms}-{n}"));
    fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

fn cleanup(path: &std::path::Path) {
    let _ = fs::remove_dir_all(path);
}

#[test]
fn full_sync_cycle() {
    let dir = temp_dir();

    // ── 1. Seed notes on disk ───────────────────────────────────────
    files::write_atomic_text(&dir.join("grocery list.md"), "milk eggs bread").unwrap();
    files::write_atomic_text(&dir.join("meeting notes.md"), "discussed roadmap").unwrap();
    files::write_atomic_text(&dir.join("journal.md"), "today was productive").unwrap();

    // ── 2. Hash files ───────────────────────────────────────────────
    let mut records: Vec<NoteRecord> = Vec::new();
    let mut hashes: Vec<(String, String)> = Vec::new(); // (filename, hash)

    for entry in fs::read_dir(&dir).unwrap() {
        let entry = entry.unwrap();
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(_id) = files::note_id_from_filename(&name) {
            let content = fs::read_to_string(entry.path()).unwrap();
            let content_hash = hash::hash_sha256(&content);
            records.push(NoteRecord {
                filename: name.clone(),
                content_hash: content_hash.clone(),
                is_blob: false,
            });
            hashes.push((name, content_hash));
        }
    }
    assert_eq!(records.len(), 3);

    // ── 3. Simulate "last sync" state (all hashes match) ────────────
    // All three notes are in sync — direction should be NeitherChanged
    for (filename, h) in &hashes {
        let direction = sync::determine_sync_direction(h, h, h);
        assert_eq!(
            direction,
            sync::SyncDirection::NeitherChanged,
            "expected NeitherChanged for {filename}"
        );
    }

    // ── 4. Simulate client edit to "grocery list" ───────────────────
    let grocery_old_hash = hashes
        .iter()
        .find(|(f, _)| f == "grocery list.md")
        .unwrap()
        .1
        .clone();

    files::write_atomic_text(&dir.join("grocery list.md"), "milk eggs bread butter").unwrap();
    let grocery_new_hash = hash::hash_sha256("milk eggs bread butter");

    let direction =
        sync::determine_sync_direction(&grocery_new_hash, &grocery_old_hash, &grocery_old_hash);
    assert_eq!(direction, sync::SyncDirection::ClientChanged);

    // ── 5. Simulate server edit to "meeting notes" ──────────────────
    let meeting_old_hash = hashes
        .iter()
        .find(|(f, _)| f == "meeting notes.md")
        .unwrap()
        .1
        .clone();
    let meeting_server_hash = hash::hash_sha256("discussed roadmap v2");

    let direction =
        sync::determine_sync_direction(&meeting_old_hash, &meeting_server_hash, &meeting_old_hash);
    assert_eq!(direction, sync::SyncDirection::ServerChanged);

    // ── 6. Simulate convergence on "journal" ────────────────────────
    let journal_old_hash = hashes
        .iter()
        .find(|(f, _)| f == "journal.md")
        .unwrap()
        .1
        .clone();
    let converged_hash = hash::hash_sha256("today was great");

    let direction =
        sync::determine_sync_direction(&converged_hash, &converged_hash, &journal_old_hash);
    assert_eq!(direction, sync::SyncDirection::BothChanged);
    assert!(sync::check_convergence(&converged_hash, &converged_hash));

    // ── 7. Update disk to reflect post-sync state ───────────────────
    // Apply server's meeting notes
    files::write_atomic_text(&dir.join("meeting notes.md"), "discussed roadmap v2").unwrap();
    // Apply converged journal
    files::write_atomic_text(&dir.join("journal.md"), "today was great").unwrap();

    // ── 8. Rebuild records and run invariants ───────────────────────
    let final_records: Vec<NoteRecord> = fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            files::note_id_from_filename(&name)?;
            let content = fs::read_to_string(e.path()).ok()?;
            Some(NoteRecord {
                filename: name,
                content_hash: hash::hash_sha256(&content),
                is_blob: false,
            })
        })
        .collect();

    assert_eq!(final_records.len(), 3);

    let active: HashSet<String> = final_records.iter().map(|r| r.filename.clone()).collect();
    let tombstoned: HashSet<String> = HashSet::new();

    let violations =
        invariants::run_all_invariants(&final_records, &dir, &active, &tombstoned, 1, 2);
    assert!(
        violations.is_empty(),
        "expected no invariant violations, got: {violations:?}"
    );

    cleanup(&dir);
}

#[test]
fn rename_detection_via_hash_match() {
    // A note deleted as "old-name" and created as "new-name" with same content
    // should be detected as a rename.
    let content = "this note was renamed";
    let h = hash::hash_sha256(content);

    assert!(sync::is_rename_match(&h, &h));
    // Different content should not match
    assert!(!sync::is_rename_match(&h, &hash::hash_sha256("different")));
}
