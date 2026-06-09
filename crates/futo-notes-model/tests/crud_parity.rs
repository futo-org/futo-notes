//! Behavioral-parity tests for the note CRUD that replaces the iOS
//! `NotesStore.swift` business logic (plan Phase 2). Each test pins one item
//! from the parity risk checklist so the Rust core matches the old Swift
//! output (or its documented, intentional improvement).

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use futo_notes_core::files::set_file_mtime_ms;
use futo_notes_model as model;

fn temp_root() -> PathBuf {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let dir = std::env::temp_dir().join(format!("futo-model-crud-{pid}-{n}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}

// ── note list sort: mtime descending ─────────────────────────────────────
#[test]
fn scan_sorts_by_mtime_descending() {
    let root = temp_root();
    model::write_note(&root, "old", "old body").unwrap();
    model::write_note(&root, "mid", "mid body").unwrap();
    model::write_note(&root, "new", "new body").unwrap();
    // Stamp explicit mtimes so the order is deterministic.
    set_file_mtime_ms(&root.join("old.md"), 1_000_000).unwrap();
    set_file_mtime_ms(&root.join("mid.md"), 2_000_000).unwrap();
    set_file_mtime_ms(&root.join("new.md"), 3_000_000).unwrap();

    let ids: Vec<String> = model::scan_notes(&root).into_iter().map(|n| n.id).collect();
    assert_eq!(ids, vec!["new", "mid", "old"]);
    fs::remove_dir_all(&root).ok();
}

// ── makePreview: CR/LF/TAB → space, trim, 100-char cap ───────────────────
#[test]
fn make_preview_collapses_whitespace_and_caps() {
    assert_eq!(model::make_preview("  hello\nworld\t!  "), "hello world !");
    assert_eq!(model::make_preview("a\r\nb"), "a b");
    // No multi-space collapse (matches Swift): two newlines → two spaces.
    assert_eq!(model::make_preview("a\n\nb"), "a  b");
    let long = "x".repeat(250);
    assert_eq!(model::make_preview(&long).chars().count(), 100);
}

// ── tag lowercasing + dedup (display form, no '#') ───────────────────────
#[test]
fn note_tags_lowercase_dedup_no_hash() {
    assert_eq!(model::note_tags("#Demo #demo #DEMO"), vec!["demo"]);
    assert_eq!(model::note_tags("text #Recipe and #cooking"), vec!["recipe", "cooking"]);
    // Tags inside a code fence are excluded (canonical rule, unlike old Swift).
    assert_eq!(model::note_tags("#real\n```\n#fake\n```"), vec!["real"]);
}

// ── folder-ancestor surfacing (registerAncestors) ───────────────────────
#[test]
fn scan_folders_surfaces_all_ancestors() {
    let root = temp_root();
    model::write_note(&root, "Specs/Drafts/note", "x").unwrap();
    let folders = model::scan_folders(&root);
    assert_eq!(folders, vec!["Specs", "Specs/Drafts"]);
    fs::remove_dir_all(&root).ok();
}

// ── empty-folder surfacing (scanDirs) ────────────────────────────────────
#[test]
fn scan_folders_surfaces_empty_dirs() {
    let root = temp_root();
    fs::create_dir_all(root.join("Empty/Nested")).unwrap();
    model::write_note(&root, "Other/note", "x").unwrap();
    let folders = model::scan_folders(&root);
    assert_eq!(folders, vec!["Empty", "Empty/Nested", "Other"]);
    fs::remove_dir_all(&root).ok();
}

// ── hidden dirs/files are skipped ────────────────────────────────────────
#[test]
fn scan_skips_hidden() {
    let root = temp_root();
    model::write_note(&root, "visible", "x").unwrap();
    fs::create_dir_all(root.join(".git")).unwrap();
    fs::write(root.join(".git/c.md"), "hidden").unwrap();
    fs::write(root.join(".e2ee-state.json"), "{}").unwrap();
    let ids: Vec<String> = model::scan_notes(&root).into_iter().map(|n| n.id).collect();
    assert_eq!(ids, vec!["visible"]);
    assert!(model::scan_folders(&root).is_empty());
    fs::remove_dir_all(&root).ok();
}

// ── path traversal rejection ─────────────────────────────────────────────
#[test]
fn crud_rejects_path_traversal() {
    let root = temp_root();
    assert!(model::write_note(&root, "../escape", "x").is_err());
    assert!(model::write_note(&root, "a/../../escape", "x").is_err());
    assert!(!model::note_exists(&root, "../escape"));
    assert_eq!(model::read_note(&root, "../escape"), "");
    // The escape file must not have been created anywhere.
    assert!(!root.parent().unwrap().join("escape.md").exists());
    fs::remove_dir_all(&root).ok();
}

// ── unique-id collision strategy: Foo → Foo-2 → Foo-3 ────────────────────
#[test]
fn create_note_resolves_collisions() {
    let root = temp_root();
    let a = model::create_note(&root, "", "Foo").unwrap();
    let b = model::create_note(&root, "", "Foo").unwrap();
    let c = model::create_note(&root, "", "Foo").unwrap();
    assert_eq!(a, "Foo");
    assert_eq!(b, "Foo-2");
    assert_eq!(c, "Foo-3");
    // In a folder, the suffix lands on the full id.
    let d = model::create_note(&root, "Specs", "Bar").unwrap();
    let e = model::create_note(&root, "Specs", "Bar").unwrap();
    assert_eq!(d, "Specs/Bar");
    assert_eq!(e, "Specs/Bar-2");
    fs::remove_dir_all(&root).ok();
}

// ── UTF-8 emoji round-trip through write/read/scan ───────────────────────
#[test]
fn emoji_round_trip() {
    let root = temp_root();
    let body = "emoji 🎉 note 👨‍👩‍👧 with #emojitag";
    let id = model::create_note(&root, "Notes 🇺🇸", "Title 🎉").unwrap();
    model::write_note(&root, &id, body).unwrap();
    assert_eq!(model::read_note(&root, &id), body);
    let note = model::scan_notes(&root).into_iter().find(|n| n.id == id).unwrap();
    assert_eq!(note.folder, "Notes 🇺🇸");
    assert_eq!(note.title, "Title 🎉");
    assert!(note.preview.contains("🎉"));
    assert_eq!(note.tags, vec!["emojitag"]);
    fs::remove_dir_all(&root).ok();
}

// ── rename / move ────────────────────────────────────────────────────────
#[test]
fn rename_and_move_behavior() {
    let root = temp_root();
    model::write_note(&root, "Note", "body").unwrap();
    // Rename to a new leaf.
    let renamed = model::rename_note(&root, "Note", "Renamed").unwrap();
    assert_eq!(renamed, "Renamed");
    assert!(!model::note_exists(&root, "Note"));
    assert_eq!(model::read_note(&root, "Renamed"), "body");

    // Move into a folder keeps the leaf.
    let moved = model::move_note(&root, "Renamed", "Archive").unwrap();
    assert_eq!(moved, "Archive/Renamed");
    assert_eq!(model::read_note(&root, "Archive/Renamed"), "body");

    // Moving to the same folder is a no-op.
    let same = model::move_note(&root, "Archive/Renamed", "Archive").unwrap();
    assert_eq!(same, "Archive/Renamed");

    // Rename onto an occupied name collides → suffix.
    model::write_note(&root, "Archive/Other", "x").unwrap();
    let collide = model::rename_note(&root, "Archive/Renamed", "Archive/Other").unwrap();
    assert_eq!(collide, "Archive/Other-2");
    fs::remove_dir_all(&root).ok();
}

// ── F3: case-only rename on a case-insensitive filesystem (APFS) ─────────
// Renaming `note` → `Note` must land at `Note.md`, NOT `Note-2.md`. The old
// code called `get_unique_note_id(base, "Note", None)`, whose `.exists()`
// probe sees the case-variant `note.md` as occupying `Note.md` on a
// case-insensitive FS and bumps to `Note-2`, losing the requested
// capitalization. The two-step temp-hop rename forces the kernel to update
// the stored case. (No-ops where bytes are identical still early-return.)
#[test]
fn case_only_rename_keeps_requested_case() {
    let root = temp_root();
    model::write_note(&root, "note", "body").unwrap();

    let renamed = model::rename_note(&root, "note", "Note").unwrap();
    assert_eq!(renamed, "Note", "case-only rename must keep requested case, not bump");

    // The note is reachable under the new id with its content intact.
    assert_eq!(model::read_note(&root, "Note"), "body");

    // Exactly one note file exists in the dir (no duplicate, no `-2`).
    let md_count = fs::read_dir(&root)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".md"))
        .count();
    assert_eq!(md_count, 1, "case-only rename must not create a second file");

    fs::remove_dir_all(&root).ok();
}

// ── F3: case-only rename inside a folder + move-to-case-variant ──────────
#[test]
fn case_only_rename_in_folder_and_move() {
    let root = temp_root();
    model::write_note(&root, "Specs/readme", "x").unwrap();
    let renamed = model::rename_note(&root, "Specs/readme", "Specs/README").unwrap();
    assert_eq!(renamed, "Specs/README");
    assert_eq!(model::read_note(&root, "Specs/README"), "x");
    fs::remove_dir_all(&root).ok();
}

// ── F3: byte-identical rename is still a fast no-op ──────────────────────
#[test]
fn identical_rename_is_noop() {
    let root = temp_root();
    model::write_note(&root, "Note", "body").unwrap();
    let same = model::rename_note(&root, "Note", "Note").unwrap();
    assert_eq!(same, "Note");
    assert_eq!(model::read_note(&root, "Note"), "body");
    fs::remove_dir_all(&root).ok();
}

// ── delete: idempotent, no prune (empty folder still surfaces) ───────────
#[test]
fn delete_is_idempotent_and_keeps_empty_folder() {
    let root = temp_root();
    model::write_note(&root, "Specs/only", "x").unwrap();
    model::delete_note(&root, "Specs/only").unwrap();
    model::delete_note(&root, "Specs/only").unwrap(); // idempotent
    assert!(!model::note_exists(&root, "Specs/only"));
    // The now-empty Specs folder still surfaces (matches Swift).
    assert_eq!(model::scan_folders(&root), vec!["Specs"]);
    fs::remove_dir_all(&root).ok();
}

// ── make_id / split_id / sanitize_folder_path ────────────────────────────
#[test]
fn id_helpers() {
    assert_eq!(model::make_id("", "Hello"), "Hello");
    assert_eq!(model::make_id("Specs", "Hello"), "Specs/Hello");
    assert_eq!(model::make_id("Specs//Drafts ", "a/b"), "Specs/Drafts/ab"); // '/' stripped from title
    assert_eq!(model::split_id("Specs/Drafts/Note"), ("Specs/Drafts".into(), "Note".into()));
    assert_eq!(model::split_id("Flat"), (String::new(), "Flat".into()));
    assert_eq!(model::sanitize_folder_path("a//b/ c "), "a/b/c");
}

// ── create_folder ────────────────────────────────────────────────────────
#[test]
fn create_folder_makes_dirs() {
    let root = temp_root();
    assert_eq!(model::create_folder(&root, "A/B/C").unwrap(), "A/B/C");
    assert!(root.join("A/B/C").is_dir());
    // Genuinely empty / slash-only paths are a no-op (matches Swift).
    assert_eq!(model::create_folder(&root, "").unwrap(), "");
    assert_eq!(model::create_folder(&root, "///").unwrap(), "");
    // A whitespace component sanitizes to the "Untitled" fallback, same as the
    // Swift sanitizeFolderPath → sanitizeTitle("  ") == "Untitled".
    assert_eq!(model::create_folder(&root, "  ").unwrap(), "Untitled");
    assert!(root.join("Untitled").is_dir());
    fs::remove_dir_all(&root).ok();
}

// ── wikilinks ────────────────────────────────────────────────────────────
#[test]
fn wikilink_extraction() {
    assert_eq!(
        model::extract_wikilinks("see [[Target]] and [[Other|alias]] and [[Target]]"),
        vec!["Target", "Other"]
    );
    assert_eq!(model::extract_wikilinks("no links here"), Vec::<String>::new());
    assert_eq!(model::extract_wikilinks("[[Folder/Note]]"), vec!["Folder/Note"]);
    // Unterminated / empty are skipped.
    assert_eq!(model::extract_wikilinks("[[unterminated"), Vec::<String>::new());
    assert_eq!(model::extract_wikilinks("[[]] [[ |x]]"), Vec::<String>::new());
}
