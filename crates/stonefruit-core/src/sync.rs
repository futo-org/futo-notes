use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

// ── V2 Protocol Types ──────────────────────────────────────────────────

/// V2 sync request — filename-based, no UUIDs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncRequest {
    pub device_id: String,
    pub inventory: Vec<InventoryItem>,
    pub changed: Vec<ChangedNote>,
    pub new: Vec<NewNote>,
    pub deleted: Vec<String>,
}

/// A file the client currently has (filename + hash).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InventoryItem {
    pub filename: String,
    pub hash: String,
}

/// A file the client modified since last sync.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangedNote {
    pub filename: String,
    pub content: String,
    pub hash: String,
    #[serde(default)]
    pub modified_at: i64,
}

/// A file the client created since last sync.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewNote {
    pub filename: String,
    pub content: String,
    pub hash: String,
    #[serde(default)]
    pub modified_at: i64,
}

/// V2 sync response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResponse {
    pub update: Vec<UpdateNote>,
    pub delete: Vec<String>,
    pub conflicts: Vec<ConflictNote>,
    pub version: u64,
    /// Server-authoritative modified_at for all known files.
    /// Clients use this to correct local file mtimes without re-downloading content.
    #[serde(default)]
    pub timestamps: HashMap<String, i64>,
}

/// A note the client should write/overwrite.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateNote {
    pub filename: String,
    pub content: String,
    pub hash: String,
    pub modified_at: i64,
}

/// A conflict copy the client should write.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConflictNote {
    pub filename: String,
    pub content: String,
}

/// V2 quick-check request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncCheckRequest {
    pub version: u64,
}

/// V2 quick-check response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncCheckResponse {
    pub status: SyncCheckStatus,
    pub version: u64,
}

/// Result of a sync quick-check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncCheckStatus {
    UpToDate,
    ChangesAvailable,
}

// ── V2 Helpers ─────────────────────────────────────────────────────────

/// Generate a conflict copy filename.
///
/// For markdown notes this yields `"note (conflict 2026-03-28).md"`.
/// If that name is already taken, appends a counter:
/// `"note (conflict 2026-03-28 2).md"`.
///
/// Non-markdown files preserve their original extension.
pub fn conflict_filename(original: &str, date: &str, existing: &HashSet<String>) -> String {
    let (base, ext) = split_conflict_name_parts(original);
    let candidate = format!("{base} (conflict {date}){ext}");
    if !existing.contains(&candidate) {
        return candidate;
    }
    let mut counter = 2;
    loop {
        let candidate = format!("{base} (conflict {date} {counter}){ext}");
        if !existing.contains(&candidate) {
            return candidate;
        }
        counter += 1;
    }
}

fn split_conflict_name_parts(original: &str) -> (&str, &str) {
    if let Some(base) = original.strip_suffix(".md") {
        return (base, ".md");
    }

    if let Some((base, _ext)) = original.rsplit_once('.') {
        if !base.is_empty() {
            return (base, &original[base.len()..]);
        }
    }

    (original, ".md")
}

/// Resolve a filename collision against an in-memory set of existing filenames.
/// Returns `wanted` unchanged if no collision. Otherwise appends ` (2)`, ` (3)`, etc.
pub fn resolve_filename_collision(existing: &HashSet<String>, wanted: &str) -> String {
    if !existing.contains(wanted) {
        return wanted.to_string();
    }
    let base = wanted.strip_suffix(".md").unwrap_or(wanted);
    let ext = if wanted.ends_with(".md") { ".md" } else { "" };
    let mut counter = 2;
    loop {
        let candidate = format!("{base} ({counter}){ext}");
        if !existing.contains(&candidate) {
            return candidate;
        }
        counter += 1;
    }
}

// ── Sync Direction Logic ───────────────────────────────────────────────

/// Which side(s) changed since last sync, based on hash comparison.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SyncDirection {
    /// Client hash differs from last-sync hash, server matches last-sync.
    ClientChanged,
    /// Server hash differs from last-sync hash, client matches last-sync.
    ServerChanged,
    /// Both client and server hashes differ from last-sync hash.
    BothChanged,
    /// Neither side changed — all three hashes match.
    NeitherChanged,
}

/// How to resolve a sync conflict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConflictResolution {
    AcceptClient,
    AcceptServer,
    ConflictCopy,
    Converged,
    NoOp,
}

/// Core 4-quadrant hash comparison to determine sync direction.
///
/// Compares client and server content hashes against the hash recorded
/// at last successful sync. Works for both v1 UUID-based and v2
/// filename-based sync since it operates on raw hash strings.
pub fn determine_sync_direction(
    client_hash: &str,
    server_hash: &str,
    last_sync_hash: &str,
) -> SyncDirection {
    let client_changed = client_hash != last_sync_hash;
    let server_changed = server_hash != last_sync_hash;

    match (client_changed, server_changed) {
        (false, false) => SyncDirection::NeitherChanged,
        (true, false) => SyncDirection::ClientChanged,
        (false, true) => SyncDirection::ServerChanged,
        (true, true) => SyncDirection::BothChanged,
    }
}

/// Check if client and server converged to the same content despite both
/// changing. When true, no data transfer is needed — just update bookkeeping.
pub fn check_convergence(client_hash: &str, server_hash: &str) -> bool {
    client_hash == server_hash
}

/// Detect a rename: if a deleted note's content hash matches a newly created
/// note's content hash, the "delete + create" is likely a rename.
pub fn is_rename_match(deleted_hash: &str, created_hash: &str) -> bool {
    !deleted_hash.is_empty() && deleted_hash == created_hash
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    const HASH_A: &str = "aaaa";
    const HASH_B: &str = "bbbb";
    const HASH_C: &str = "cccc";

    // ── determine_sync_direction ────────────────────────────────────

    #[test]
    fn neither_changed() {
        assert_eq!(
            determine_sync_direction(HASH_A, HASH_A, HASH_A),
            SyncDirection::NeitherChanged
        );
    }

    #[test]
    fn client_changed() {
        assert_eq!(
            determine_sync_direction(HASH_B, HASH_A, HASH_A),
            SyncDirection::ClientChanged
        );
    }

    #[test]
    fn server_changed() {
        assert_eq!(
            determine_sync_direction(HASH_A, HASH_B, HASH_A),
            SyncDirection::ServerChanged
        );
    }

    #[test]
    fn both_changed_different() {
        assert_eq!(
            determine_sync_direction(HASH_B, HASH_C, HASH_A),
            SyncDirection::BothChanged
        );
    }

    #[test]
    fn both_changed_same_content() {
        // Both differ from last_sync but match each other — still BothChanged
        // (convergence is checked separately)
        assert_eq!(
            determine_sync_direction(HASH_B, HASH_B, HASH_A),
            SyncDirection::BothChanged
        );
    }

    // ── check_convergence ───────────────────────────────────────────

    #[test]
    fn convergence_detected() {
        assert!(check_convergence(HASH_A, HASH_A));
    }

    #[test]
    fn no_convergence() {
        assert!(!check_convergence(HASH_A, HASH_B));
    }

    // ── is_rename_match ─────────────────────────────────────────────

    #[test]
    fn rename_match_same_hash() {
        assert!(is_rename_match(HASH_A, HASH_A));
    }

    #[test]
    fn rename_no_match_different() {
        assert!(!is_rename_match(HASH_A, HASH_B));
    }

    #[test]
    fn rename_no_match_empty() {
        assert!(!is_rename_match("", ""));
        assert!(!is_rename_match("", HASH_A));
    }

    // ── Adversarial: empty string hashes ───────────────────────────────

    #[test]
    fn direction_all_empty_strings() {
        // All empty hashes — none changed
        assert_eq!(
            determine_sync_direction("", "", ""),
            SyncDirection::NeitherChanged
        );
    }

    #[test]
    fn direction_client_empty_server_has_value() {
        assert_eq!(
            determine_sync_direction("", HASH_A, ""),
            SyncDirection::ServerChanged
        );
    }

    #[test]
    fn direction_server_empty_client_has_value() {
        assert_eq!(
            determine_sync_direction(HASH_A, "", ""),
            SyncDirection::ClientChanged
        );
    }

    #[test]
    fn direction_last_sync_empty_both_have_values() {
        assert_eq!(
            determine_sync_direction(HASH_A, HASH_B, ""),
            SyncDirection::BothChanged
        );
    }

    #[test]
    fn direction_last_sync_empty_both_same() {
        assert_eq!(
            determine_sync_direction(HASH_A, HASH_A, ""),
            SyncDirection::BothChanged
        );
    }

    // ── Adversarial: all permutations of 3 distinct hashes ─────────────

    #[test]
    fn direction_exhaustive_permutations() {
        let hashes = [HASH_A, HASH_B, HASH_C];

        // All possible (client, server, last_sync) triples from 3 values
        for &client in &hashes {
            for &server in &hashes {
                for &last_sync in &hashes {
                    let result = determine_sync_direction(client, server, last_sync);
                    let client_changed = client != last_sync;
                    let server_changed = server != last_sync;
                    let expected = match (client_changed, server_changed) {
                        (false, false) => SyncDirection::NeitherChanged,
                        (true, false) => SyncDirection::ClientChanged,
                        (false, true) => SyncDirection::ServerChanged,
                        (true, true) => SyncDirection::BothChanged,
                    };
                    assert_eq!(
                        result, expected,
                        "direction({client}, {server}, {last_sync})"
                    );
                }
            }
        }
    }

    // ── Adversarial: convergence edge cases ────────────────────────────

    #[test]
    fn convergence_empty_strings() {
        assert!(check_convergence("", ""));
    }

    #[test]
    fn convergence_one_empty() {
        assert!(!check_convergence("", HASH_A));
        assert!(!check_convergence(HASH_A, ""));
    }

    #[test]
    fn convergence_whitespace_matters() {
        assert!(!check_convergence("abc", "abc "));
        assert!(!check_convergence(" abc", "abc"));
    }

    #[test]
    fn convergence_case_sensitive() {
        assert!(!check_convergence("AAAA", "aaaa"));
    }

    // ── Adversarial: rename match edge cases ───────────────────────────

    #[test]
    fn rename_match_whitespace_only() {
        // Non-empty whitespace strings that match
        assert!(is_rename_match(" ", " "));
    }

    #[test]
    fn rename_match_one_empty_one_not() {
        assert!(!is_rename_match("", HASH_A));
        assert!(!is_rename_match(HASH_A, ""));
    }

    #[test]
    fn rename_match_very_long_hashes() {
        let long = "a".repeat(1000);
        assert!(is_rename_match(&long, &long));
        let long2 = "b".repeat(1000);
        assert!(!is_rename_match(&long, &long2));
    }

    // ── Adversarial: direction with realistic SHA-256 hashes ───────────

    #[test]
    fn direction_with_real_hashes() {
        use crate::hash::hash_sha256;
        let h1 = hash_sha256("content v1");
        let h2 = hash_sha256("content v2");
        let h3 = hash_sha256("content v3");

        assert_eq!(
            determine_sync_direction(&h1, &h1, &h1),
            SyncDirection::NeitherChanged
        );
        assert_eq!(
            determine_sync_direction(&h2, &h1, &h1),
            SyncDirection::ClientChanged
        );
        assert_eq!(
            determine_sync_direction(&h1, &h2, &h1),
            SyncDirection::ServerChanged
        );
        assert_eq!(
            determine_sync_direction(&h2, &h3, &h1),
            SyncDirection::BothChanged
        );
    }

    // ── Adversarial: symmetry property ─────────────────────────────────

    #[test]
    fn direction_not_symmetric() {
        // Swapping client and server with same last_sync should swap direction
        let d1 = determine_sync_direction(HASH_B, HASH_A, HASH_A);
        let d2 = determine_sync_direction(HASH_A, HASH_B, HASH_A);
        assert_eq!(d1, SyncDirection::ClientChanged);
        assert_eq!(d2, SyncDirection::ServerChanged);
    }

    // ── V2 protocol type serde round-trips ────────────────────────────

    #[test]
    fn sync_request_serde_roundtrip() {
        let req = SyncRequest {
            device_id: "dev-1".into(),
            inventory: vec![InventoryItem {
                filename: "note.md".into(),
                hash: "abc123".into(),
            }],
            changed: vec![ChangedNote {
                filename: "edited.md".into(),
                content: "# Edited".into(),
                hash: "def456".into(),
                modified_at: 1700000000000,
            }],
            new: vec![NewNote {
                filename: "new.md".into(),
                content: "# New".into(),
                hash: "ghi789".into(),
                modified_at: 1700000000000,
            }],
            deleted: vec!["old.md".into()],
        };
        let json = serde_json::to_string(&req).unwrap();
        let parsed: SyncRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.device_id, "dev-1");
        assert_eq!(parsed.inventory.len(), 1);
        assert_eq!(parsed.inventory[0].filename, "note.md");
        assert_eq!(parsed.changed.len(), 1);
        assert_eq!(parsed.changed[0].content, "# Edited");
        assert_eq!(parsed.new.len(), 1);
        assert_eq!(parsed.deleted, vec!["old.md"]);
    }

    #[test]
    fn sync_response_serde_roundtrip() {
        let resp = SyncResponse {
            update: vec![UpdateNote {
                filename: "from-server.md".into(),
                content: "# Server note".into(),
                hash: "s123".into(),
                modified_at: 1700000000000,
            }],
            delete: vec!["removed.md".into()],
            conflicts: vec![ConflictNote {
                filename: "note (conflict 2026-03-28).md".into(),
                content: "# Conflict version".into(),
            }],
            version: 42,
            timestamps: HashMap::new(),
        };
        let json = serde_json::to_string(&resp).unwrap();
        let parsed: SyncResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.update.len(), 1);
        assert_eq!(parsed.update[0].filename, "from-server.md");
        assert_eq!(parsed.delete, vec!["removed.md"]);
        assert_eq!(parsed.conflicts.len(), 1);
        assert_eq!(parsed.version, 42);
    }

    #[test]
    fn sync_check_serde_roundtrip() {
        let req = SyncCheckRequest { version: 10 };
        let json = serde_json::to_string(&req).unwrap();
        let parsed: SyncCheckRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.version, 10);

        let resp = SyncCheckResponse {
            status: SyncCheckStatus::ChangesAvailable,
            version: 11,
        };
        let json = serde_json::to_string(&resp).unwrap();
        let parsed: SyncCheckResponse = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.status, SyncCheckStatus::ChangesAvailable);
        assert_eq!(parsed.version, 11);
    }

    #[test]
    fn sync_check_status_json_format() {
        // Verify snake_case serialization
        let json = serde_json::to_string(&SyncCheckStatus::UpToDate).unwrap();
        assert_eq!(json, "\"up_to_date\"");
        let json = serde_json::to_string(&SyncCheckStatus::ChangesAvailable).unwrap();
        assert_eq!(json, "\"changes_available\"");
    }

    #[test]
    fn empty_sync_request() {
        let req = SyncRequest {
            device_id: "d".into(),
            inventory: vec![],
            changed: vec![],
            new: vec![],
            deleted: vec![],
        };
        let json = serde_json::to_string(&req).unwrap();
        let parsed: SyncRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.device_id, "d");
        assert!(parsed.inventory.is_empty());
    }

    // ── conflict_filename ──────────────────────────────────────────────

    #[test]
    fn conflict_filename_basic() {
        let existing = HashSet::new();
        assert_eq!(
            conflict_filename("note.md", "2026-03-28", &existing),
            "note (conflict 2026-03-28).md"
        );
    }

    #[test]
    fn conflict_filename_with_collision() {
        let mut existing = HashSet::new();
        existing.insert("note (conflict 2026-03-28).md".to_string());
        assert_eq!(
            conflict_filename("note.md", "2026-03-28", &existing),
            "note (conflict 2026-03-28 2).md"
        );
    }

    #[test]
    fn conflict_filename_multiple_collisions() {
        let mut existing = HashSet::new();
        existing.insert("note (conflict 2026-03-28).md".to_string());
        existing.insert("note (conflict 2026-03-28 2).md".to_string());
        existing.insert("note (conflict 2026-03-28 3).md".to_string());
        assert_eq!(
            conflict_filename("note.md", "2026-03-28", &existing),
            "note (conflict 2026-03-28 4).md"
        );
    }

    #[test]
    fn conflict_filename_no_extension() {
        let existing = HashSet::new();
        assert_eq!(
            conflict_filename("note", "2026-03-28", &existing),
            "note (conflict 2026-03-28).md"
        );
    }

    #[test]
    fn conflict_filename_preserves_non_md_extension() {
        let existing = HashSet::new();
        assert_eq!(
            conflict_filename("image.png", "2026-03-28", &existing),
            "image (conflict 2026-03-28).png"
        );
    }

    // ── resolve_filename_collision ─────────────────────────────────────

    #[test]
    fn collision_no_conflict() {
        let existing = HashSet::new();
        assert_eq!(resolve_filename_collision(&existing, "note.md"), "note.md");
    }

    #[test]
    fn collision_basic() {
        let mut existing = HashSet::new();
        existing.insert("note.md".to_string());
        assert_eq!(
            resolve_filename_collision(&existing, "note.md"),
            "note (2).md"
        );
    }

    #[test]
    fn collision_multiple() {
        let mut existing = HashSet::new();
        existing.insert("note.md".to_string());
        existing.insert("note (2).md".to_string());
        existing.insert("note (3).md".to_string());
        assert_eq!(
            resolve_filename_collision(&existing, "note.md"),
            "note (4).md"
        );
    }

    #[test]
    fn collision_no_extension() {
        let mut existing = HashSet::new();
        existing.insert("readme".to_string());
        assert_eq!(
            resolve_filename_collision(&existing, "readme"),
            "readme (2)"
        );
    }

    #[test]
    fn collision_preserves_md_extension() {
        let mut existing = HashSet::new();
        existing.insert("grocery list.md".to_string());
        assert_eq!(
            resolve_filename_collision(&existing, "grocery list.md"),
            "grocery list (2).md"
        );
    }

    proptest! {
        #[test]
        fn direction_matches_change_flags_for_arbitrary_hashes(
            client in any::<String>(),
            server in any::<String>(),
            last_sync in any::<String>(),
        ) {
            let actual = determine_sync_direction(&client, &server, &last_sync);
            let expected = match (client != last_sync, server != last_sync) {
                (false, false) => SyncDirection::NeitherChanged,
                (true, false) => SyncDirection::ClientChanged,
                (false, true) => SyncDirection::ServerChanged,
                (true, true) => SyncDirection::BothChanged,
            };

            prop_assert_eq!(actual, expected);
        }

        #[test]
        fn collision_resolution_never_reuses_an_existing_filename(
            base in proptest::string::string_regex("[a-z]{1,8}").unwrap(),
            suffixes in proptest::collection::btree_set(2u16..12u16, 0..6),
        ) {
            let wanted = format!("{base}.md");
            let mut existing = HashSet::new();
            existing.insert(wanted.clone());
            for suffix in suffixes {
                existing.insert(format!("{base} ({suffix}).md"));
            }

            let resolved = resolve_filename_collision(&existing, &wanted);

            prop_assert!(resolved.ends_with(".md"));
            prop_assert!(!existing.contains(&resolved));
        }
    }
}
