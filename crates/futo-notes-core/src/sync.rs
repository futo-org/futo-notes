use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use unicode_normalization::UnicodeNormalization;

// ── Path-collision detection (case- and normalization-insensitive) ───────

/// Canonical key for detecting when two filenames refer to the SAME on-disk
/// entry on a case-insensitive, Unicode-normalization-insensitive filesystem
/// (default APFS on macOS/iOS, NTFS on Windows). Two filenames collide iff
/// their `collision_key`s are equal.
///
/// The key folds away the two collapses that lose notes on a fresh pull
/// (F4 / F5): `welcome.md` vs `Welcome.md` (case) and an NFC vs NFD spelling
/// of the same accented name (e.g. `café.md` composed vs decomposed). We
/// normalize to NFC first, then ASCII-and-Unicode-lowercase. NFC (not NFD) is
/// chosen so the key is stable regardless of which form the server object or
/// the local file happens to carry.
pub fn collision_key(filename: &str) -> String {
    filename.nfc().collect::<String>().to_lowercase()
}

/// True when `a` and `b` would resolve to the same directory entry on a
/// case/normalization-insensitive filesystem but are NOT byte-identical — i.e.
/// a pure case-only or NFC-vs-NFD difference. Used to route a rename through a
/// temp hop (F3) so the kernel actually rewrites the stored bytes instead of
/// no-op'ing.
pub fn collides_but_differs(a: &str, b: &str) -> bool {
    a != b && collision_key(a) == collision_key(b)
}

/// Conflict-copy filename for a path-collision loser, derived PURELY from the
/// loser's stable, globally-unique `object_id` — `base (conflict <oid8>).ext`,
/// where `<oid8>` is the first 8 hex chars of the object_id.
///
/// Unlike [`conflict_filename`] (which appends a per-client date + namespace
/// counter, so two clients independently resolving the same collision can mint
/// DIFFERENT names and each push a duplicate object), this name is a pure
/// function of `(canonical_name, object_id)`: every client computes the
/// identical name for the identical loser object, so the whole fleet converges
/// to exactly `{canonical, base (conflict <oid8>).ext}` and the loser
/// round-trips on its own preserved object_id. `<oid8>` is independent of any
/// per-cycle name set, so it never differs between a client that resolved last
/// cycle and one resolving this cycle.
pub fn collision_conflict_filename(canonical_name: &str, loser_object_id: &str) -> String {
    let (base, ext) = split_conflict_name_parts(canonical_name);
    let short = object_id_short(loser_object_id);
    format!("{base} (conflict {short}){ext}")
}

/// First 8 chars of an object id, lowercased and restricted to a safe filename
/// charset. Object ids are server-assigned and globally unique, so an 8-char
/// prefix is effectively collision-free among the handful of objects that can
/// share one canonical name within a vault. The value is a pure function of
/// the object id alone — never of any per-cycle / per-client state — so all
/// clients agree on it (mitigates the cross-client divergence objection).
fn object_id_short(object_id: &str) -> String {
    let cleaned: String = object_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect();
    if cleaned.is_empty() {
        "object".to_string()
    } else {
        cleaned
    }
}

// ── V2 Protocol Types ──────────────────────────────────────────────────

/// V2 sync request — filename-based, no UUIDs.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncRequest {
    pub device_id: String,
    /// Full inventory. `None` = dirty-only upload (no full vault walk).
    #[serde(default)]
    pub inventory: Option<Vec<InventoryItem>>,
    pub changed: Vec<ChangedNote>,
    pub new: Vec<NewNote>,
    pub deleted: Vec<String>,
    /// Client's last-known server version, for changelog-based download.
    #[serde(default)]
    pub last_version: Option<u64>,
    /// Baseline hashes for deleted files (filename → last-synced hash).
    /// Used for delete-vs-edit conflict detection after device_snapshots removal.
    #[serde(default)]
    pub deleted_baselines: HashMap<String, String>,
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
    /// Hash from last successful sync (`fileHashes[filename]`).
    /// Used as the third input to `determine_sync_direction` instead of device_snapshots.
    #[serde(default)]
    pub baseline_hash: Option<String>,
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
    /// Oldest version retained in the server's version_log.
    /// Clients behind this version must fall back to full sync.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oldest_retained_version: Option<u64>,
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
    let (base, ext) = if let Some(base) = original.strip_suffix(".md") {
        (base, ".md")
    } else if let Some((base, _ext)) = original.rsplit_once('.') {
        if base.is_empty() {
            (original, ".md")
        } else {
            (base, &original[base.len()..])
        }
    } else {
        (original, ".md")
    };

    (strip_trailing_conflict_suffixes(base), ext)
}

/// Strip any trailing run of ` (conflict <token>)` groups from a base name so
/// re-conflicting an already-parked copy REPLACES its suffix instead of
/// stacking a new one on top.
///
/// Without this, `foo (conflict A).md` re-conflicts to
/// `foo (conflict A) (conflict B).md`, then `… (conflict C).md`, and so on:
/// copies breed copies and a single note explodes into hundreds of
/// ever-deeper files (the July 2026 combinatorial blow-up — 1081 objects of
/// one note, names 8 suffixes deep, each round POSTing a new object under a
/// deeper name). Peeling the run makes the name a pure function of the true
/// base + the current loser, so the fleet converges to a bounded, flat set.
///
/// Idempotent: applying it to an already-stripped base is a no-op. A group is
/// only peeled when its parenthesized token matches a suffix this code
/// generates (date/date-counter, object-id short token, or the degenerate
/// `object` fallback), so a user title like `notes (conflict resolution)` is
/// preserved when it is itself conflict-copied.
fn strip_trailing_conflict_suffixes(mut base: &str) -> &str {
    const OPEN: &str = " (conflict ";
    loop {
        let trimmed = base.trim_end_matches(' ');
        let Some(without_close) = trimmed.strip_suffix(')') else {
            return base;
        };
        let Some(open_at) = without_close.rfind(OPEN) else {
            return base;
        };
        let inner = &trimmed[open_at + OPEN.len()..trimmed.len() - 1];
        if !is_generated_conflict_token(inner) {
            return base;
        }
        base = &trimmed[..open_at];
    }
}

fn is_generated_conflict_token(token: &str) -> bool {
    is_date_conflict_token(token) || is_object_conflict_token(token)
}

fn is_date_conflict_token(token: &str) -> bool {
    let Some(date) = token.get(..10) else {
        return false;
    };
    let bytes = date.as_bytes();
    let date_shape = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit);
    if !date_shape {
        return false;
    }
    match token.get(10..) {
        Some("") => true,
        Some(rest) if rest.starts_with(' ') => {
            let counter = &rest[1..];
            !counter.is_empty() && counter.as_bytes().iter().all(u8::is_ascii_digit)
        }
        _ => false,
    }
}

fn is_object_conflict_token(token: &str) -> bool {
    token == "object"
        || (token.len() == 8 && token.as_bytes().iter().all(u8::is_ascii_hexdigit))
        || (token.len() == 8
            && token.as_bytes().iter().all(u8::is_ascii_alphanumeric)
            && token.as_bytes().iter().any(u8::is_ascii_digit))
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
            inventory: Some(vec![InventoryItem {
                filename: "note.md".into(),
                hash: "abc123".into(),
            }]),
            changed: vec![ChangedNote {
                filename: "edited.md".into(),
                content: "# Edited".into(),
                hash: "def456".into(),
                modified_at: 1700000000000,
                baseline_hash: Some("old_hash".into()),
            }],
            new: vec![NewNote {
                filename: "new.md".into(),
                content: "# New".into(),
                hash: "ghi789".into(),
                modified_at: 1700000000000,
            }],
            deleted: vec!["old.md".into()],
            last_version: Some(41),
            deleted_baselines: HashMap::from([("old.md".into(), "old_hash".into())]),
        };
        let json = serde_json::to_string(&req).unwrap();
        let parsed: SyncRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.device_id, "dev-1");
        let inv = parsed.inventory.as_ref().unwrap();
        assert_eq!(inv.len(), 1);
        assert_eq!(inv[0].filename, "note.md");
        assert_eq!(parsed.changed.len(), 1);
        assert_eq!(parsed.changed[0].content, "# Edited");
        assert_eq!(parsed.changed[0].baseline_hash, Some("old_hash".into()));
        assert_eq!(parsed.new.len(), 1);
        assert_eq!(parsed.deleted, vec!["old.md"]);
        assert_eq!(parsed.last_version, Some(41));
        assert_eq!(parsed.deleted_baselines.get("old.md").unwrap(), "old_hash");
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
            oldest_retained_version: Some(10),
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
            inventory: Some(vec![]),
            changed: vec![],
            new: vec![],
            deleted: vec![],
            last_version: None,
            deleted_baselines: HashMap::new(),
        };
        let json = serde_json::to_string(&req).unwrap();
        let parsed: SyncRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.device_id, "d");
        assert!(parsed.inventory.unwrap().is_empty());
    }

    #[test]
    fn sync_request_without_optional_fields() {
        // Simulates an old-style request missing the new fields
        let json = r#"{"device_id":"d","inventory":[],"changed":[],"new":[],"deleted":[]}"#;
        let parsed: SyncRequest = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.device_id, "d");
        assert!(parsed.inventory.unwrap().is_empty());
        assert_eq!(parsed.last_version, None);
        assert!(parsed.deleted_baselines.is_empty());
    }

    #[test]
    fn sync_request_without_inventory() {
        // Dirty-only upload — no inventory field at all
        let json = r#"{"device_id":"d","changed":[],"new":[],"deleted":[],"last_version":42}"#;
        let parsed: SyncRequest = serde_json::from_str(json).unwrap();
        assert!(parsed.inventory.is_none());
        assert_eq!(parsed.last_version, Some(42));
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

    // ── idempotent conflict naming (July 2026 combinatorial blow-up) ────
    //
    // Re-conflicting an already-parked copy must REPLACE the trailing
    // (conflict …) run, not stack a deeper one — otherwise copies breed
    // copies and one note explodes into hundreds of ever-deeper files.

    #[test]
    fn conflict_filename_does_not_stack_on_a_parked_copy() {
        let existing = HashSet::new();
        // Date-based path (push 409 conflict copy).
        assert_eq!(
            conflict_filename("note (conflict 2026-03-28).md", "2026-03-29", &existing),
            "note (conflict 2026-03-29).md"
        );
    }

    #[test]
    fn collision_conflict_filename_does_not_stack_on_a_parked_copy() {
        // oid-based path (pull collision resolver) — the exact shape seen in
        // the blow-up: `foo (conflict 019f3d55).md` re-conflicting must not
        // become `foo (conflict 019f3d55) (conflict 019f3d9d).md`.
        assert_eq!(
            collision_conflict_filename("futo notes top priorities (conflict 019f3d55).md", "019f3d9d-aaaa"),
            "futo notes top priorities (conflict 019f3d9d).md"
        );
    }

    #[test]
    fn collision_conflict_filename_peels_deep_stacks_flat() {
        // A name already 3 suffixes deep collapses to a single suffix.
        assert_eq!(
            collision_conflict_filename(
                "foo (conflict deadbeef) (conflict cafebabe) (conflict facefeed).md",
                "019f3d9d",
            ),
            "foo (conflict 019f3d9d).md"
        );
    }

    #[test]
    fn conflict_naming_is_idempotent_across_rounds() {
        // Applying the collision namer to its own output with the SAME loser
        // object_id is a fixed point — the loop can't deepen the name.
        let once = collision_conflict_filename("foo.md", "019f3d9d");
        let twice = collision_conflict_filename(&once, "019f3d9d");
        assert_eq!(once, twice, "re-parking the same loser must be a fixed point");
        assert_eq!(twice, "foo (conflict 019f3d9d).md");
    }

    #[test]
    fn conflict_naming_preserves_extension_when_stripping_stack() {
        assert_eq!(
            collision_conflict_filename("image (conflict deadbeef).png", "019f3d9d"),
            "image (conflict 019f3d9d).png"
        );
    }

    #[test]
    fn conflict_naming_preserves_user_title_that_mentions_conflict() {
        let existing = HashSet::new();
        assert_eq!(
            conflict_filename("plan (conflict resolution).md", "2026-03-29", &existing),
            "plan (conflict resolution) (conflict 2026-03-29).md"
        );
        assert_eq!(
            collision_conflict_filename("plan (conflict resolution).md", "019f3d9d"),
            "plan (conflict resolution) (conflict 019f3d9d).md"
        );
    }

    #[test]
    fn conflict_naming_peels_date_counter_suffix() {
        let existing = HashSet::new();
        assert_eq!(
            conflict_filename("note (conflict 2026-03-28 2).md", "2026-03-29", &existing),
            "note (conflict 2026-03-29).md"
        );
    }

    #[test]
    fn conflict_naming_leaves_user_title_with_nested_parens_untouched() {
        // A parenthesized token containing parens is not our format — don't
        // peel it (avoids mangling an unrelated user title).
        assert_eq!(
            collision_conflict_filename("plan (conflict (draft)).md", "019f3d9d"),
            "plan (conflict (draft)) (conflict 019f3d9d).md"
        );
    }

    // ── collision_key / collides_but_differs (F3/F4/F5) ────────────────

    #[test]
    fn collision_key_folds_case() {
        assert_eq!(collision_key("welcome.md"), collision_key("Welcome.md"));
        assert_eq!(collision_key("README"), collision_key("readme"));
        assert_ne!(collision_key("note-a.md"), collision_key("note-b.md"));
    }

    #[test]
    fn collision_key_folds_nfc_nfd() {
        // "café" composed (U+00E9) vs decomposed (e + U+0301) must map equal.
        let nfc = "caf\u{00E9}.md";
        let nfd = "cafe\u{0301}.md";
        assert_ne!(nfc, nfd, "inputs must be byte-distinct for the test to matter");
        assert_eq!(collision_key(nfc), collision_key(nfd));
    }

    #[test]
    fn collides_but_differs_detects_case_and_norm_only() {
        assert!(collides_but_differs("note", "Note"));
        assert!(collides_but_differs("caf\u{00E9}", "cafe\u{0301}"));
        // Byte-identical → not a "differs" case.
        assert!(!collides_but_differs("Note", "Note"));
        // Genuinely different names don't collide.
        assert!(!collides_but_differs("note", "other"));
    }

    // ── collision_conflict_filename (F4/F5) — pure function of object_id ─

    #[test]
    fn collision_conflict_filename_is_pure_function_of_object_id() {
        let a = collision_conflict_filename("welcome.md", "abcdef0123456789-objectid");
        let b = collision_conflict_filename("welcome.md", "abcdef0123456789-objectid");
        assert_eq!(a, b, "same inputs must always yield the same name");
        assert_eq!(a, "welcome (conflict abcdef01).md");
    }

    #[test]
    fn collision_conflict_filename_independent_of_namespace_set() {
        // Contrast with conflict_filename, which depends on the `existing` set.
        // This helper takes no name set at all, so two clients with different
        // local state compute the identical loser name (OBJ-2 convergence).
        let from_client_x = collision_conflict_filename("note.md", "OID-1234abcd-zz");
        let from_client_y = collision_conflict_filename("note.md", "OID-1234abcd-zz");
        assert_eq!(from_client_x, from_client_y);
        assert_eq!(from_client_x, "note (conflict OID1234a).md");
    }

    #[test]
    fn collision_conflict_filename_preserves_extension() {
        assert_eq!(
            collision_conflict_filename("image.png", "deadbeefcafe"),
            "image (conflict deadbeef).png"
        );
        // Bare name (no extension) defaults to .md, matching conflict_filename.
        assert_eq!(
            collision_conflict_filename("readme", "0011223344"),
            "readme (conflict 00112233).md"
        );
    }

    #[test]
    fn collision_conflict_filename_handles_degenerate_object_id() {
        // An object id with no alphanumerics falls back to a literal so the
        // name stays valid and deterministic.
        assert_eq!(
            collision_conflict_filename("note.md", "----"),
            "note (conflict object).md"
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
