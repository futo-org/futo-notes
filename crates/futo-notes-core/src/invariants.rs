use crate::hash;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

// ── Core types ──────────────────────────────────────────────────────────

/// Minimal note record for invariant checks. Core-owned, no UUID (V2 doesn't
/// use UUIDs — filename is the identity).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteRecord {
    pub filename: String,
    pub content_hash: String,
    pub is_blob: bool,
}

/// A specific invariant violation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum InvariantViolation {
    /// DB content_hash doesn't match file on disk.
    ContentHashMismatch {
        filename: String,
        db_hash: String,
        disk_hash: String,
    },
    /// File referenced in DB is missing from disk.
    MissingFile { filename: String },
    /// File exists on disk but not in the note set.
    OrphanedFile { filename: String },
    /// is_blob flag doesn't match the file extension.
    BlobExtensionMismatch { filename: String, is_blob: bool },
    /// Same filename appears multiple times.
    DuplicateFilename { filename: String, count: usize },
    /// A filename appears in both active and tombstoned sets.
    TombstoneOverlap { filename: String },
    /// sync_version decreased (should be monotonically non-decreasing).
    VersionRegression { before: u64, after: u64 },
}

// ── Image extension check ───────────────────────────────────────────────

// The image classifier is canonical in `crate::image` (the conformance-locked
// 10-entry set shared with `futo-notes-model` and the TS copy). This module
// used to keep an independent 13-entry copy that disagreed on
// `.tiff/.tif/.heif`; D4 unified them, so delegate.
pub use crate::image::is_image_filename;

// ── Individual invariant checks ─────────────────────────────────────────

/// Invariant 1: DB content_hash matches actual file content on disk.
pub fn check_content_hash_parity(
    notes: &[NoteRecord],
    notes_dir: &Path,
) -> Vec<InvariantViolation> {
    let mut violations = Vec::new();

    for note in notes {
        let path = notes_dir.join(&note.filename);
        if note.is_blob {
            match fs::read(&path) {
                Ok(data) => {
                    let disk_hash = hash::hash_sha256_bytes(&data);
                    if disk_hash != note.content_hash {
                        violations.push(InvariantViolation::ContentHashMismatch {
                            filename: note.filename.clone(),
                            db_hash: note.content_hash.clone(),
                            disk_hash,
                        });
                    }
                }
                Err(_) => {
                    violations.push(InvariantViolation::MissingFile {
                        filename: note.filename.clone(),
                    });
                }
            }
        } else {
            match fs::read_to_string(&path) {
                Ok(content) => {
                    let disk_hash = hash::hash_sha256(&content);
                    if disk_hash != note.content_hash {
                        violations.push(InvariantViolation::ContentHashMismatch {
                            filename: note.filename.clone(),
                            db_hash: note.content_hash.clone(),
                            disk_hash,
                        });
                    }
                }
                Err(_) => {
                    violations.push(InvariantViolation::MissingFile {
                        filename: note.filename.clone(),
                    });
                }
            }
        }
    }

    violations
}

/// Invariant 2: No orphaned files on disk.
/// Every .md and image file in notes_dir must have a corresponding record.
pub fn check_orphaned_files(notes: &[NoteRecord], notes_dir: &Path) -> Vec<InvariantViolation> {
    let db_filenames: HashSet<&str> = notes.iter().map(|n| n.filename.as_str()).collect();
    let mut violations = Vec::new();

    let entries = match fs::read_dir(notes_dir) {
        Ok(entries) => entries,
        Err(_) => return violations,
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        // Skip dotfiles (app config, sync state, etc.)
        if name.starts_with('.') {
            continue;
        }
        let is_note = name.ends_with(".md");
        let is_image = is_image_filename(&name);
        if (is_note || is_image) && !db_filenames.contains(name.as_str()) {
            violations.push(InvariantViolation::OrphanedFile { filename: name });
        }
    }

    violations
}

/// Invariant 3: is_blob flag matches file extension.
/// is_blob=true → image extension. is_blob=false → .md extension.
pub fn check_blob_extension_parity(notes: &[NoteRecord]) -> Vec<InvariantViolation> {
    let mut violations = Vec::new();

    for note in notes {
        let is_image = is_image_filename(&note.filename);
        if note.is_blob && !is_image {
            violations.push(InvariantViolation::BlobExtensionMismatch {
                filename: note.filename.clone(),
                is_blob: true,
            });
        }
        if !note.is_blob && is_image {
            violations.push(InvariantViolation::BlobExtensionMismatch {
                filename: note.filename.clone(),
                is_blob: false,
            });
        }
    }

    violations
}

/// Invariant 4: No duplicate filenames.
pub fn check_duplicate_filenames(notes: &[NoteRecord]) -> Vec<InvariantViolation> {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for note in notes {
        *counts.entry(note.filename.as_str()).or_insert(0) += 1;
    }

    counts
        .into_iter()
        .filter(|(_, count)| *count > 1)
        .map(|(filename, count)| InvariantViolation::DuplicateFilename {
            filename: filename.to_string(),
            count,
        })
        .collect()
}

/// Invariant 5: No filename appears in both active and tombstoned sets.
pub fn check_tombstone_exclusion(
    active_filenames: &HashSet<String>,
    tombstoned: &HashSet<String>,
) -> Vec<InvariantViolation> {
    active_filenames
        .intersection(tombstoned)
        .map(|f| InvariantViolation::TombstoneOverlap {
            filename: f.clone(),
        })
        .collect()
}

/// Invariant 6: sync_version is monotonically non-decreasing.
pub fn check_version_monotonic(before: u64, after: u64) -> Vec<InvariantViolation> {
    if after < before {
        vec![InvariantViolation::VersionRegression { before, after }]
    } else {
        vec![]
    }
}

/// Run all invariant checks and return combined violations.
pub fn run_all_invariants(
    notes: &[NoteRecord],
    notes_dir: &Path,
    active_filenames: &HashSet<String>,
    tombstoned: &HashSet<String>,
    version_before: u64,
    version_after: u64,
) -> Vec<InvariantViolation> {
    let mut violations = Vec::new();
    violations.extend(check_content_hash_parity(notes, notes_dir));
    violations.extend(check_orphaned_files(notes, notes_dir));
    violations.extend(check_blob_extension_parity(notes));
    violations.extend(check_duplicate_filenames(notes));
    violations.extend(check_tombstone_exclusion(active_filenames, tombstoned));
    violations.extend(check_version_monotonic(version_before, version_after));
    violations
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_dir() -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("futo-notes-core-inv-test-{}-{n}", files::now_ms()));
        fs::create_dir_all(&dir).expect("create temp test dir");
        dir
    }

    fn cleanup(path: &Path) {
        let _ = fs::remove_dir_all(path);
    }

    use std::path::PathBuf;

    // ── content_hash_parity ─────────────────────────────────────────

    #[test]
    fn content_hash_parity_pass() {
        let dir = temp_dir();
        let content = "hello world";
        fs::write(dir.join("note.md"), content).unwrap();
        let notes = vec![NoteRecord {
            filename: "note.md".to_string(),
            content_hash: hash::hash_sha256(content),
            is_blob: false,
        }];
        let v = check_content_hash_parity(&notes, &dir);
        assert!(v.is_empty());
        cleanup(&dir);
    }

    #[test]
    fn content_hash_parity_mismatch() {
        let dir = temp_dir();
        fs::write(dir.join("note.md"), "actual content").unwrap();
        let notes = vec![NoteRecord {
            filename: "note.md".to_string(),
            content_hash: hash::hash_sha256("wrong content"),
            is_blob: false,
        }];
        let v = check_content_hash_parity(&notes, &dir);
        assert_eq!(v.len(), 1);
        assert!(matches!(
            &v[0],
            InvariantViolation::ContentHashMismatch { .. }
        ));
        cleanup(&dir);
    }

    #[test]
    fn content_hash_parity_missing_file() {
        let dir = temp_dir();
        let notes = vec![NoteRecord {
            filename: "ghost.md".to_string(),
            content_hash: "anything".to_string(),
            is_blob: false,
        }];
        let v = check_content_hash_parity(&notes, &dir);
        assert_eq!(v.len(), 1);
        assert!(matches!(&v[0], InvariantViolation::MissingFile { .. }));
        cleanup(&dir);
    }

    #[test]
    fn content_hash_parity_blob() {
        let dir = temp_dir();
        let data = b"\x89PNG\r\n\x1a\n"; // fake PNG header
        fs::write(dir.join("img.png"), data).unwrap();
        let notes = vec![NoteRecord {
            filename: "img.png".to_string(),
            content_hash: hash::hash_sha256_bytes(data),
            is_blob: true,
        }];
        let v = check_content_hash_parity(&notes, &dir);
        assert!(v.is_empty());
        cleanup(&dir);
    }

    // ── orphaned_files ──────────────────────────────────────────────

    #[test]
    fn orphaned_files_detected() {
        let dir = temp_dir();
        fs::write(dir.join("known.md"), "x").unwrap();
        fs::write(dir.join("orphan.md"), "y").unwrap();
        let notes = vec![NoteRecord {
            filename: "known.md".to_string(),
            content_hash: "x".to_string(),
            is_blob: false,
        }];
        let v = check_orphaned_files(&notes, &dir);
        assert_eq!(v.len(), 1);
        assert!(
            matches!(&v[0], InvariantViolation::OrphanedFile { filename } if filename == "orphan.md")
        );
        cleanup(&dir);
    }

    #[test]
    fn orphaned_files_skips_dotfiles() {
        let dir = temp_dir();
        fs::write(dir.join(".sync-state.json"), "{}").unwrap();
        fs::write(dir.join("note.md"), "x").unwrap();
        let notes = vec![NoteRecord {
            filename: "note.md".to_string(),
            content_hash: "x".to_string(),
            is_blob: false,
        }];
        let v = check_orphaned_files(&notes, &dir);
        assert!(v.is_empty());
        cleanup(&dir);
    }

    // ── blob_extension_parity ───────────────────────────────────────

    #[test]
    fn blob_extension_pass() {
        let notes = vec![
            NoteRecord {
                filename: "note.md".to_string(),
                content_hash: "x".to_string(),
                is_blob: false,
            },
            NoteRecord {
                filename: "photo.jpg".to_string(),
                content_hash: "y".to_string(),
                is_blob: true,
            },
        ];
        assert!(check_blob_extension_parity(&notes).is_empty());
    }

    #[test]
    fn blob_extension_mismatch() {
        let notes = vec![NoteRecord {
            filename: "note.md".to_string(),
            content_hash: "x".to_string(),
            is_blob: true, // .md shouldn't be a blob
        }];
        let v = check_blob_extension_parity(&notes);
        assert_eq!(v.len(), 1);
        assert!(matches!(
            &v[0],
            InvariantViolation::BlobExtensionMismatch { is_blob: true, .. }
        ));
    }

    // ── duplicate_filenames ─────────────────────────────────────────

    #[test]
    fn duplicate_filenames_detected() {
        let notes = vec![
            NoteRecord {
                filename: "dup.md".to_string(),
                content_hash: "a".to_string(),
                is_blob: false,
            },
            NoteRecord {
                filename: "dup.md".to_string(),
                content_hash: "b".to_string(),
                is_blob: false,
            },
        ];
        let v = check_duplicate_filenames(&notes);
        assert_eq!(v.len(), 1);
        assert!(matches!(
            &v[0],
            InvariantViolation::DuplicateFilename { count: 2, .. }
        ));
    }

    #[test]
    fn no_duplicate_filenames() {
        let notes = vec![
            NoteRecord {
                filename: "a.md".to_string(),
                content_hash: "x".to_string(),
                is_blob: false,
            },
            NoteRecord {
                filename: "b.md".to_string(),
                content_hash: "y".to_string(),
                is_blob: false,
            },
        ];
        assert!(check_duplicate_filenames(&notes).is_empty());
    }

    // ── tombstone_exclusion ─────────────────────────────────────────

    #[test]
    fn tombstone_overlap_detected() {
        let active: HashSet<String> = ["note.md".to_string()].into();
        let tombstoned: HashSet<String> = ["note.md".to_string()].into();
        let v = check_tombstone_exclusion(&active, &tombstoned);
        assert_eq!(v.len(), 1);
        assert!(matches!(&v[0], InvariantViolation::TombstoneOverlap { .. }));
    }

    #[test]
    fn tombstone_no_overlap() {
        let active: HashSet<String> = ["a.md".to_string()].into();
        let tombstoned: HashSet<String> = ["b.md".to_string()].into();
        assert!(check_tombstone_exclusion(&active, &tombstoned).is_empty());
    }

    // ── version_monotonic ───────────────────────────────────────────

    #[test]
    fn version_regression_detected() {
        let v = check_version_monotonic(10, 5);
        assert_eq!(v.len(), 1);
        assert!(matches!(
            &v[0],
            InvariantViolation::VersionRegression {
                before: 10,
                after: 5
            }
        ));
    }

    #[test]
    fn version_non_decreasing_ok() {
        assert!(check_version_monotonic(5, 5).is_empty());
        assert!(check_version_monotonic(5, 10).is_empty());
    }

    // ── run_all_invariants ──────────────────────────────────────────

    #[test]
    fn all_pass_scenario() {
        let dir = temp_dir();
        let content = "hello";
        fs::write(dir.join("note.md"), content).unwrap();

        let notes = vec![NoteRecord {
            filename: "note.md".to_string(),
            content_hash: hash::hash_sha256(content),
            is_blob: false,
        }];
        let active: HashSet<String> = ["note.md".to_string()].into();
        let tombstoned: HashSet<String> = HashSet::new();

        let v = run_all_invariants(&notes, &dir, &active, &tombstoned, 1, 2);
        assert!(v.is_empty(), "expected no violations, got: {v:?}");
        cleanup(&dir);
    }

    // ── Adversarial: NoteRecord with empty filename ─────────────────────

    #[test]
    fn content_hash_empty_filename() {
        let dir = temp_dir();
        let notes = vec![NoteRecord {
            filename: "".to_string(),
            content_hash: "abc".to_string(),
            is_blob: false,
        }];
        // Should report MissingFile (empty filename can't exist on disk)
        let v = check_content_hash_parity(&notes, &dir);
        assert_eq!(v.len(), 1);
        assert!(matches!(&v[0], InvariantViolation::MissingFile { .. }));
        cleanup(&dir);
    }

    #[test]
    fn content_hash_empty_hash() {
        let dir = temp_dir();
        fs::write(dir.join("note.md"), "content").unwrap();
        let notes = vec![NoteRecord {
            filename: "note.md".to_string(),
            content_hash: "".to_string(), // empty hash — will mismatch
            is_blob: false,
        }];
        let v = check_content_hash_parity(&notes, &dir);
        assert_eq!(v.len(), 1);
        assert!(matches!(
            &v[0],
            InvariantViolation::ContentHashMismatch { .. }
        ));
        cleanup(&dir);
    }

    // ── Adversarial: Case-insensitive filesystem collision ──────────────

    #[test]
    fn duplicate_filenames_case_differs() {
        // On case-insensitive FS (macOS, Windows), "Note.md" and "note.md" collide.
        // But the duplicate check is exact-match — these are NOT duplicates.
        let notes = vec![
            NoteRecord {
                filename: "Note.md".to_string(),
                content_hash: "a".to_string(),
                is_blob: false,
            },
            NoteRecord {
                filename: "note.md".to_string(),
                content_hash: "b".to_string(),
                is_blob: false,
            },
        ];
        let v = check_duplicate_filenames(&notes);
        // Exact match: no duplicates detected
        assert!(
            v.is_empty(),
            "case-different names should not be flagged as duplicates by exact check"
        );
    }

    // ── Adversarial: Large note list (1000+ records) ────────────────────

    #[test]
    fn duplicate_check_large_list_no_duplicates() {
        let notes: Vec<NoteRecord> = (0..1500)
            .map(|i| NoteRecord {
                filename: format!("note-{i}.md"),
                content_hash: format!("hash-{i}"),
                is_blob: false,
            })
            .collect();
        let v = check_duplicate_filenames(&notes);
        assert!(v.is_empty());
    }

    #[test]
    fn duplicate_check_large_list_with_duplicates() {
        let mut notes: Vec<NoteRecord> = (0..1000)
            .map(|i| NoteRecord {
                filename: format!("note-{i}.md"),
                content_hash: format!("hash-{i}"),
                is_blob: false,
            })
            .collect();
        // Add 5 duplicates of the same filename
        for _ in 0..5 {
            notes.push(NoteRecord {
                filename: "note-0.md".to_string(),
                content_hash: "different".to_string(),
                is_blob: false,
            });
        }
        let v = check_duplicate_filenames(&notes);
        assert_eq!(v.len(), 1);
        if let InvariantViolation::DuplicateFilename { count, .. } = &v[0] {
            assert_eq!(*count, 6); // original + 5 extras
        } else {
            panic!("expected DuplicateFilename");
        }
    }

    // ── Adversarial: Orphaned file checks ───────────────────────────────

    #[test]
    fn orphaned_files_ignores_dotfiles() {
        let dir = temp_dir();
        // Various dotfiles that should be skipped
        fs::write(dir.join(".preferences.json"), "{}").unwrap();
        fs::write(dir.join(".sync-state-v1.json"), "{}").unwrap();
        fs::write(dir.join(".DS_Store"), "").unwrap();
        fs::write(dir.join(".gitignore"), "").unwrap();
        let v = check_orphaned_files(&[], &dir);
        assert!(v.is_empty(), "dotfiles should not be flagged as orphans");
        cleanup(&dir);
    }

    #[test]
    fn orphaned_files_ignores_non_md_non_image() {
        let dir = temp_dir();
        fs::write(dir.join("readme.txt"), "x").unwrap();
        fs::write(dir.join("data.json"), "{}").unwrap();
        fs::write(dir.join("script.sh"), "#!/bin/bash").unwrap();
        let v = check_orphaned_files(&[], &dir);
        assert!(
            v.is_empty(),
            "non-.md non-image files should not be flagged"
        );
        cleanup(&dir);
    }

    #[test]
    fn orphaned_files_detects_orphan_images() {
        let dir = temp_dir();
        fs::write(dir.join("photo.jpg"), "fake jpeg").unwrap();
        fs::write(dir.join("diagram.png"), "fake png").unwrap();
        fs::write(dir.join("icon.svg"), "<svg/>").unwrap();
        let v = check_orphaned_files(&[], &dir);
        assert_eq!(v.len(), 3, "orphaned images should be detected");
        cleanup(&dir);
    }

    #[test]
    fn orphaned_files_nonexistent_dir() {
        let dir = Path::new("/tmp/futo-notes-nonexistent-dir-12345");
        let v = check_orphaned_files(&[], dir);
        assert!(
            v.is_empty(),
            "nonexistent dir should return empty, not error"
        );
    }

    // ── Adversarial: Content hash parity with empty file ────────────────

    #[test]
    fn content_hash_parity_empty_file() {
        let dir = temp_dir();
        fs::write(dir.join("empty.md"), "").unwrap();
        let notes = vec![NoteRecord {
            filename: "empty.md".to_string(),
            content_hash: hash::hash_sha256(""),
            is_blob: false,
        }];
        let v = check_content_hash_parity(&notes, &dir);
        assert!(v.is_empty(), "empty file should match empty string hash");
        cleanup(&dir);
    }

    #[test]
    fn content_hash_parity_empty_file_wrong_hash() {
        let dir = temp_dir();
        fs::write(dir.join("empty.md"), "").unwrap();
        let notes = vec![NoteRecord {
            filename: "empty.md".to_string(),
            content_hash: "not-the-empty-hash".to_string(),
            is_blob: false,
        }];
        let v = check_content_hash_parity(&notes, &dir);
        assert_eq!(v.len(), 1);
        assert!(matches!(
            &v[0],
            InvariantViolation::ContentHashMismatch { .. }
        ));
        cleanup(&dir);
    }

    // ── Adversarial: Tombstone boundary conditions ──────────────────────

    #[test]
    fn tombstone_empty_sets() {
        let active: HashSet<String> = HashSet::new();
        let tombstoned: HashSet<String> = HashSet::new();
        assert!(check_tombstone_exclusion(&active, &tombstoned).is_empty());
    }

    #[test]
    fn tombstone_large_sets_no_overlap() {
        let active: HashSet<String> = (0..500).map(|i| format!("active-{i}.md")).collect();
        let tombstoned: HashSet<String> = (0..500).map(|i| format!("dead-{i}.md")).collect();
        assert!(check_tombstone_exclusion(&active, &tombstoned).is_empty());
    }

    #[test]
    fn tombstone_large_sets_with_overlap() {
        let active: HashSet<String> = (0..500).map(|i| format!("note-{i}.md")).collect();
        let mut tombstoned: HashSet<String> = (500..1000).map(|i| format!("note-{i}.md")).collect();
        // Add 3 overlapping entries
        tombstoned.insert("note-0.md".to_string());
        tombstoned.insert("note-100.md".to_string());
        tombstoned.insert("note-499.md".to_string());
        let v = check_tombstone_exclusion(&active, &tombstoned);
        assert_eq!(v.len(), 3);
    }

    #[test]
    fn tombstone_single_item_overlap() {
        let active: HashSet<String> = ["only.md".to_string()].into();
        let tombstoned: HashSet<String> = ["only.md".to_string()].into();
        let v = check_tombstone_exclusion(&active, &tombstoned);
        assert_eq!(v.len(), 1);
    }

    // ── Adversarial: Version monotonic boundary ─────────────────────────

    #[test]
    fn version_zero_to_zero() {
        assert!(check_version_monotonic(0, 0).is_empty());
    }

    #[test]
    fn version_max_to_max() {
        assert!(check_version_monotonic(u64::MAX, u64::MAX).is_empty());
    }

    #[test]
    fn version_max_to_zero() {
        let v = check_version_monotonic(u64::MAX, 0);
        assert_eq!(v.len(), 1);
    }

    #[test]
    fn version_one_regression() {
        let v = check_version_monotonic(10, 9);
        assert_eq!(v.len(), 1);
        assert!(matches!(
            &v[0],
            InvariantViolation::VersionRegression {
                before: 10,
                after: 9
            }
        ));
    }

    // ── Adversarial: Blob extension edge cases ──────────────────────────

    #[test]
    fn blob_extension_all_image_types() {
        // Iterate the CANONICAL set (not a hand copy) so this test can never
        // drift from `crate::image::IMAGE_EXTENSIONS` and the drift-registry
        // scan sees only the one canonical literal.
        for ext in crate::image::IMAGE_EXTENSIONS {
            let notes = vec![NoteRecord {
                filename: format!("photo.{ext}"),
                content_hash: "x".to_string(),
                is_blob: true,
            }];
            let v = check_blob_extension_parity(&notes);
            assert!(v.is_empty(), "is_blob=true should be valid for .{ext}");
        }
    }

    #[test]
    fn blob_extension_case_insensitive_extensions() {
        // Image extension check lowercases the filename
        let notes = vec![NoteRecord {
            filename: "photo.JPG".to_string(),
            content_hash: "x".to_string(),
            is_blob: true,
        }];
        let v = check_blob_extension_parity(&notes);
        assert!(
            v.is_empty(),
            "JPG (uppercase) should be recognized as image"
        );
    }

    #[test]
    fn blob_extension_non_image_marked_blob() {
        let notes = vec![NoteRecord {
            filename: "document.pdf".to_string(),
            content_hash: "x".to_string(),
            is_blob: true,
        }];
        let v = check_blob_extension_parity(&notes);
        assert_eq!(v.len(), 1, "PDF with is_blob=true should be flagged");
    }

    #[test]
    fn blob_extension_image_marked_not_blob() {
        let notes = vec![NoteRecord {
            filename: "photo.png".to_string(),
            content_hash: "x".to_string(),
            is_blob: false,
        }];
        let v = check_blob_extension_parity(&notes);
        assert_eq!(v.len(), 1, "PNG with is_blob=false should be flagged");
    }

    // ── Adversarial: run_all_invariants combined ────────────────────────

    #[test]
    fn all_invariants_multiple_violations() {
        let dir = temp_dir();
        // Set up a scenario with many violations at once
        fs::write(dir.join("good.md"), "good content").unwrap();
        fs::write(dir.join("orphan.md"), "orphaned").unwrap();

        let notes = vec![
            NoteRecord {
                filename: "good.md".to_string(),
                content_hash: hash::hash_sha256("good content"),
                is_blob: false,
            },
            NoteRecord {
                filename: "ghost.md".to_string(), // missing from disk
                content_hash: "fake".to_string(),
                is_blob: false,
            },
            NoteRecord {
                filename: "photo.png".to_string(), // image marked not-blob
                content_hash: "x".to_string(),
                is_blob: false,
            },
            NoteRecord {
                filename: "dup.md".to_string(),
                content_hash: "a".to_string(),
                is_blob: false,
            },
            NoteRecord {
                filename: "dup.md".to_string(), // duplicate
                content_hash: "b".to_string(),
                is_blob: false,
            },
        ];

        let active: HashSet<String> = ["overlap.md".to_string()].into();
        let tombstoned: HashSet<String> = ["overlap.md".to_string()].into();

        let v = run_all_invariants(&notes, &dir, &active, &tombstoned, 10, 5);
        // Should have: MissingFile(ghost), MissingFile(photo.png), OrphanedFile(orphan),
        // BlobExtensionMismatch(photo.png), DuplicateFilename(dup.md),
        // TombstoneOverlap(overlap.md), VersionRegression(10→5)
        assert!(
            v.len() >= 6,
            "expected many violations, got {}: {v:?}",
            v.len()
        );
        cleanup(&dir);
    }
}
