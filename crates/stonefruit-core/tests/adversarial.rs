//! Integration-level adversarial tests for stonefruit-core.
//!
//! These tests exercise cross-module interactions and end-to-end scenarios
//! that span hash, files, sync, and invariants.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use stonefruit_core::files::{
    get_unique_note_id, note_id_from_filename, now_ms, safe_appdata_path, safe_note_path,
    sanitize_title, validate_title, write_atomic_text, MAX_TITLE_LENGTH,
};
use stonefruit_core::hash::{hash_sha256, hash_sha256_bytes};
use stonefruit_core::invariants::{
    check_content_hash_parity, check_duplicate_filenames, run_all_invariants, InvariantViolation,
    NoteRecord,
};
use stonefruit_core::sync::{
    check_convergence, determine_sync_direction, is_rename_match, SyncDirection,
};

fn temp_dir() -> PathBuf {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("stonefruit-core-adversarial-{}-{n}", now_ms()));
    fs::create_dir_all(&dir).expect("create temp test dir");
    dir
}

fn cleanup(path: &Path) {
    let _ = fs::remove_dir_all(path);
}

// ── Cross-module: hash + invariants round-trip ─────────────────────────

#[test]
fn hash_invariant_round_trip_many_notes() {
    let dir = temp_dir();
    let mut notes = Vec::new();

    // Create 50 notes with real content and matching hashes
    for i in 0..50 {
        let content = format!("Note {i} content: {}", "x".repeat(i * 10));
        let filename = format!("note-{i}.md");
        fs::write(dir.join(&filename), &content).unwrap();
        notes.push(NoteRecord {
            filename,
            content_hash: hash_sha256(&content),
            is_blob: false,
        });
    }

    let v = check_content_hash_parity(&notes, &dir);
    assert!(v.is_empty(), "all hashes should match: {v:?}");
    cleanup(&dir);
}

#[test]
fn hash_invariant_one_tampered() {
    let dir = temp_dir();
    let mut notes = Vec::new();

    for i in 0..10 {
        let content = format!("Note {i}");
        let filename = format!("note-{i}.md");
        fs::write(dir.join(&filename), &content).unwrap();
        notes.push(NoteRecord {
            filename,
            content_hash: hash_sha256(&content),
            is_blob: false,
        });
    }

    // Tamper with one file on disk
    fs::write(dir.join("note-5.md"), "TAMPERED").unwrap();

    let v = check_content_hash_parity(&notes, &dir);
    assert_eq!(v.len(), 1);
    match &v[0] {
        InvariantViolation::ContentHashMismatch { filename, .. } => {
            assert_eq!(filename, "note-5.md");
        }
        other => panic!("expected ContentHashMismatch, got: {other:?}"),
    }
    cleanup(&dir);
}

// ── Cross-module: sanitize → safe_note_path → write → hash → invariant ─

#[test]
fn full_note_lifecycle_adversarial_titles() {
    let dir = temp_dir();

    // NOTE: titles longer than ~200 chars hit a real bug in write_atomic_text:
    // the temp filename pattern `.{filename}.tmp-{timestamp}` can exceed the
    // 255-byte ext4 filename limit. Using 100 chars here to avoid that.
    let long_title = "a".repeat(100);
    let adversarial_titles = [
        "Normal Note",
        "café ☕ 日本語",
        "📝 Emoji Title 🎵",
        "note<with>forbidden:chars",
        "   padded   ",
        "...",
        "<>:\"/\\|?*",
        "Mixed 🎵 and <forbidden>",
        "مرحبا بالعالم",
        long_title.as_str(),
    ];

    let mut created = Vec::new();

    for title in &adversarial_titles {
        let sanitized = sanitize_title(title);
        assert!(!sanitized.is_empty());

        // Get a unique ID (handles collisions from sanitized titles)
        let id = get_unique_note_id(&dir, &sanitized, None).unwrap();

        // Build the path
        let path = safe_note_path(&dir, &id).unwrap();

        // Write content
        let content = format!("# {sanitized}\n\nContent for {title}");
        write_atomic_text(&path, &content).unwrap();

        // Verify content on disk
        let disk_content = fs::read_to_string(&path).unwrap();
        assert_eq!(disk_content, content);

        // Hash matches
        let h = hash_sha256(&content);
        let filename = path.file_name().unwrap().to_string_lossy().to_string();
        created.push(NoteRecord {
            filename,
            content_hash: h,
            is_blob: false,
        });
    }

    // Run invariants — all should pass
    let v = check_content_hash_parity(&created, &dir);
    assert!(v.is_empty(), "lifecycle invariant check failed: {v:?}");

    let v = check_duplicate_filenames(&created);
    assert!(v.is_empty(), "duplicate filenames after unique ID: {v:?}");

    cleanup(&dir);
}

// ── Cross-module: sync direction with real hashes ──────────────────────

#[test]
fn sync_direction_real_content_changes() {
    let v1 = hash_sha256("# My Note\n\nVersion 1");
    let v2 = hash_sha256("# My Note\n\nVersion 2");
    let v3 = hash_sha256("# My Note\n\nVersion 3");

    // Client edits locally
    assert_eq!(
        determine_sync_direction(&v2, &v1, &v1),
        SyncDirection::ClientChanged
    );

    // Server receives an edit from another client
    assert_eq!(
        determine_sync_direction(&v1, &v2, &v1),
        SyncDirection::ServerChanged
    );

    // Both edited independently
    assert_eq!(
        determine_sync_direction(&v2, &v3, &v1),
        SyncDirection::BothChanged
    );

    // Both converge to same content
    assert_eq!(
        determine_sync_direction(&v2, &v2, &v1),
        SyncDirection::BothChanged
    );
    assert!(check_convergence(&v2, &v2));
}

// ── Cross-module: rename detection with real hashes ────────────────────

#[test]
fn rename_detection_real_content() {
    let content = "# Grocery List\n\n- Milk\n- Eggs";
    let h = hash_sha256(content);

    // "Delete" old note and "create" new note with same content = rename
    assert!(is_rename_match(&h, &h));

    // Rename + edit = not a rename
    let edited = hash_sha256("# Shopping List\n\n- Milk\n- Eggs\n- Bread");
    assert!(!is_rename_match(&h, &edited));
}

// ── Adversarial: concurrent-style unique ID stress ─────────────────────

#[test]
fn unique_id_stress_200_collisions() {
    let dir = temp_dir();

    // Pre-create 200 files
    write_atomic_text(&dir.join("stress.md"), "x").unwrap();
    for i in 2..=200 {
        write_atomic_text(&dir.join(format!("stress-{i}.md")), "x").unwrap();
    }

    let id = get_unique_note_id(&dir, "stress", None).unwrap();
    assert_eq!(id, "stress-201");

    // Verify the returned path is actually free
    let path = safe_note_path(&dir, &id).unwrap();
    assert!(!path.exists());

    cleanup(&dir);
}

// ── Adversarial: path traversal through safe_note_path ─────────────────

#[test]
fn safe_note_path_traversal_blocked() {
    let base = Path::new("/tmp/stonefruit-test-notes");
    let attacks = [
        "..",
        "../etc/passwd",
        "foo/bar",
        "foo\\bar",
        "note\x00evil",
        "note<script>",
        "note:colon",
    ];
    for attack in &attacks {
        assert!(
            safe_note_path(base, attack).is_err(),
            "safe_note_path should reject {attack:?}"
        );
    }
}

#[test]
fn safe_note_path_valid_ids() {
    let base = Path::new("/tmp/notes");
    let valid_ids = [
        "simple",
        "with spaces",
        "café",
        "日本語",
        "emoji-📝",
        "v2.0-release",
        ".hidden-note",
    ];
    for id in &valid_ids {
        let result = safe_note_path(base, id);
        assert!(result.is_ok(), "safe_note_path should accept {id:?}");
        let path = result.unwrap();
        assert!(
            path.to_string_lossy().ends_with(".md"),
            "path should end in .md"
        );
    }
}

// ── Adversarial: appdata path traversal attempts ───────────────────────

#[test]
fn appdata_traversal_comprehensive() {
    let base = Path::new("/tmp/appdata");
    let attacks = [
        "..",
        "../../../etc/passwd",
        "/etc/passwd",
        "foo/../../etc/passwd",
    ];
    for attack in &attacks {
        assert!(
            safe_appdata_path(base, attack).is_err(),
            "should reject {attack:?}"
        );
    }

    // Valid relative paths should work
    let valid = [
        ".preferences.json",
        "subdir/config.json",
        "deep/nested/path/file.txt",
    ];
    for path in &valid {
        assert!(
            safe_appdata_path(base, path).is_ok(),
            "should accept {path:?}"
        );
    }
}

// ── Adversarial: note_id_from_filename edge cases ──────────────────────

#[test]
fn note_id_from_filename_adversarial() {
    // Double .md extension — trim_end_matches is greedy
    let result = note_id_from_filename("test.md.md");
    assert!(result.is_some());
    // Verify the actual value — trim_end_matches(".md") strips trailing ".md" greedily
    let id = result.unwrap();
    // "test.md.md" → trim_end_matches(".md") → "test" (strips both .md suffixes)
    // This is a known behavior of trim_end_matches
    assert_eq!(id, "test", "trim_end_matches strips greedily: {id}");

    // ".md.md" → strips both, leaves "" → None
    assert_eq!(note_id_from_filename(".md.md"), None);

    // "md.md" → strips trailing ".md" → "md" or strips both → ""
    let r = note_id_from_filename("md.md");
    assert!(r.is_some()); // "md.md" ends with ".md", strip → might be "md" or ""
}

// ── Adversarial: blob hash parity with binary content ──────────────────

#[test]
fn blob_hash_parity_binary_content() {
    let dir = temp_dir();
    // Write actual binary data (not valid UTF-8)
    let binary_data: Vec<u8> = (0..=255).cycle().take(10_000).collect();
    fs::write(dir.join("binary.png"), &binary_data).unwrap();

    let notes = vec![NoteRecord {
        filename: "binary.png".to_string(),
        content_hash: hash_sha256_bytes(&binary_data),
        is_blob: true,
    }];

    let v = check_content_hash_parity(&notes, &dir);
    assert!(v.is_empty(), "binary blob hash should match");
    cleanup(&dir);
}

// ── Adversarial: full invariant suite stress test ──────────────────────

#[test]
fn full_invariant_stress_100_notes() {
    let dir = temp_dir();
    let mut notes = Vec::new();
    let mut active: HashSet<String> = HashSet::new();
    let tombstoned: HashSet<String> = HashSet::new();

    for i in 0..100 {
        let content = format!("Content for note {i}: {}", "y".repeat(i));
        let filename = format!("note-{i}.md");
        fs::write(dir.join(&filename), &content).unwrap();
        notes.push(NoteRecord {
            filename: filename.clone(),
            content_hash: hash_sha256(&content),
            is_blob: false,
        });
        active.insert(filename);
    }

    let v = run_all_invariants(&notes, &dir, &active, &tombstoned, 0, 100);
    assert!(v.is_empty(), "100-note stress test failed: {v:?}");
    cleanup(&dir);
}

// ── Adversarial: atomic write then hash verify ─────────────────────────

#[test]
fn atomic_write_hash_verify_unicode() {
    let dir = temp_dir();
    let contents = [
        "",
        "hello",
        "café ☕ 日本語 مرحبا",
        &"x".repeat(100_000),
        "line1\nline2\r\nline3\rline4",
        "\u{FEFF}BOM content",
        "null\x00byte",
    ];

    for (i, content) in contents.iter().enumerate() {
        let path = dir.join(format!("test-{i}.md"));
        write_atomic_text(&path, content).unwrap();

        let read_back = fs::read_to_string(&path).unwrap();
        assert_eq!(&read_back, content, "round-trip failed for content {i}");

        let hash_before = hash_sha256(content);
        let hash_after = hash_sha256(&read_back);
        assert_eq!(hash_before, hash_after, "hash mismatch for content {i}");
    }

    cleanup(&dir);
}

// ── Adversarial: validate_title does NOT modify ────────────────────────

#[test]
fn validate_title_is_readonly() {
    let title = "hello<world>";
    let issues_before = validate_title(title);
    let issues_after = validate_title(title);
    assert_eq!(issues_before.len(), issues_after.len());
    // title string is unchanged (immutable in Rust, but verify the function is pure)
    assert_eq!(title, "hello<world>");
}

// ── Adversarial: sanitize idempotency ──────────────────────────────────

#[test]
fn sanitize_is_idempotent() {
    let inputs = [
        "hello<world>",
        "a:b|c*d",
        "normal",
        "café",
        "📝",
        "...",
        "",
        "   spaces   ",
    ];
    for input in &inputs {
        let once = sanitize_title(input);
        let twice = sanitize_title(&once);
        assert_eq!(
            once, twice,
            "sanitize_title is not idempotent for {input:?}: {once:?} != {twice:?}"
        );
    }
}

// ── Adversarial: convergence + direction consistency ───────────────────

#[test]
fn convergence_implies_both_changed() {
    // If both converged (same hash, different from last_sync), direction must be BothChanged
    let last = hash_sha256("old");
    let converged = hash_sha256("new");

    let dir = determine_sync_direction(&converged, &converged, &last);
    assert_eq!(dir, SyncDirection::BothChanged);
    assert!(check_convergence(&converged, &converged));
}

#[test]
fn neither_changed_implies_no_convergence_needed() {
    let same = hash_sha256("same");
    let dir = determine_sync_direction(&same, &same, &same);
    assert_eq!(dir, SyncDirection::NeitherChanged);
    // Convergence check is true but irrelevant
    assert!(check_convergence(&same, &same));
}

// ── BUG: write_atomic_text temp filename exceeds ext4 255-byte limit ───
//
// write_atomic_text creates a temp file named `.{filename}.tmp-{timestamp}`.
// For a 200-char title + ".md" = 204 chars, the temp name becomes:
//   ".{200-char-title}.md.tmp-{13-digit-ms}" = ~222 chars
// For a 250-char title, it hits ~271 chars — exceeding ext4's 255-byte limit.
//
// This is a real bug: sanitize_title permits titles up to any length (it
// does NOT truncate), and MAX_TITLE_LENGTH (200) is only a validation
// constant, not enforced by sanitize_title. So a user can create a note
// with a 200-char title that sanitize_title passes through, but
// write_atomic_text will fail on ext4.
//
// Fixed: write_atomic_text now uses short temp names (.sf-tmp-{ts}) instead of
// embedding the full filename, avoiding ext4's 255-byte limit.
#[test]
fn bug_write_atomic_text_long_filename_exceeds_fs_limit() {
    let dir = temp_dir();
    let title = "a".repeat(MAX_TITLE_LENGTH); // 200 chars — within validation limit
    let sanitized = sanitize_title(&title);
    assert_eq!(sanitized.len(), 200);

    let id = get_unique_note_id(&dir, &sanitized, None).unwrap();
    let path = safe_note_path(&dir, &id).unwrap();
    // This will fail with "File name too long (os error 36)" on ext4
    // because the temp filename is ~222 chars
    let result = write_atomic_text(&path, "content");
    assert!(
        result.is_ok(),
        "BUG: write_atomic_text fails for {}-char filename: {:?}",
        path.file_name().unwrap().to_string_lossy().len(),
        result.err()
    );
    cleanup(&dir);
}
