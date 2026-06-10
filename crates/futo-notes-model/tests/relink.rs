//! Vault-level tests for the wikilink relink pass (`relink_note_references`)
//! and the move-up folder delete (`delete_folder_move_up`) — the Rust ports
//! of the desktop `rewriteWikilinksForRename` / `confirmDeleteFolder` flows
//! that the native shells reach through `futo-notes-ffi`.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

use futo_notes_model as model;

fn temp_root() -> PathBuf {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    let dir = std::env::temp_dir().join(format!("futo-model-relink-{pid}-{n}"));
    fs::create_dir_all(&dir).unwrap();
    dir
}

// ── relink_note_references ───────────────────────────────────────────────

#[test]
fn relink_rewrites_pointing_notes_and_skips_the_rest() {
    let root = temp_root();
    // Simulate post-rename state: the note already lives at its new id.
    model::write_note(&root, "Lists/grocery list", "milk eggs").unwrap();
    model::write_note(&root, "pointer", "see [[grocery list]] today").unwrap();
    model::write_note(&root, "full-path pointer", "see [[grocery list]] and [[grocery list]]")
        .unwrap();
    model::write_note(&root, "bystander", "no links here").unwrap();

    let n = model::relink_note_references(&root, "grocery list", "Lists/grocery list").unwrap();
    assert_eq!(n, 2, "two notes contained pointing links");
    assert_eq!(
        model::read_note(&root, "pointer"),
        "see [[Lists/grocery list]] today"
    );
    assert_eq!(
        model::read_note(&root, "full-path pointer"),
        "see [[Lists/grocery list]] and [[Lists/grocery list]]"
    );
    assert_eq!(model::read_note(&root, "bystander"), "no links here");
    fs::remove_dir_all(&root).ok();
}

#[test]
fn relink_is_text_level_like_ts_so_code_fences_are_rewritten_too() {
    // The TS rewriteWikilinks makes no markdown-context exception; the
    // Rust port mirrors that exactly (mirror-TS, not "improve").
    let root = temp_root();
    model::write_note(&root, "target2", "x").unwrap();
    model::write_note(&root, "fenced", "```\n[[target]]\n```").unwrap();

    let n = model::relink_note_references(&root, "target", "target2").unwrap();
    assert_eq!(n, 1);
    assert_eq!(model::read_note(&root, "fenced"), "```\n[[target2]]\n```");
    fs::remove_dir_all(&root).ok();
}

#[test]
fn relink_leaves_ambiguous_and_alias_links_untouched() {
    let root = temp_root();
    model::write_note(&root, "Specs/x", "a").unwrap();
    model::write_note(&root, "Drafts/x", "b").unwrap();
    model::write_note(&root, "Specs/y2", "c").unwrap();
    // Ambiguous bare leaf + a pipe alias (part of the target per WIKILINK_RE).
    model::write_note(&root, "pointer", "[[x]] and [[Specs/y|spec]]").unwrap();

    assert_eq!(model::relink_note_references(&root, "Specs/x", "Specs/x2").unwrap(), 0);
    assert_eq!(model::relink_note_references(&root, "Specs/y", "Specs/y2").unwrap(), 0);
    assert_eq!(model::read_note(&root, "pointer"), "[[x]] and [[Specs/y|spec]]");
    fs::remove_dir_all(&root).ok();
}

#[test]
fn relink_same_id_is_a_noop() {
    let root = temp_root();
    model::write_note(&root, "a", "[[b]]").unwrap();
    assert_eq!(model::relink_note_references(&root, "b", "b").unwrap(), 0);
    assert_eq!(model::read_note(&root, "a"), "[[b]]");
    fs::remove_dir_all(&root).ok();
}

// ── delete_folder_move_up ────────────────────────────────────────────────

#[test]
fn delete_folder_moves_notes_up_preserving_substructure() {
    let root = temp_root();
    model::write_note(&root, "A/B/note", "x").unwrap();
    model::write_note(&root, "A/B/C/deep", "y").unwrap();
    model::write_note(&root, "A/sibling", "z").unwrap();

    let moved = model::delete_folder_move_up(&root, "A/B").unwrap();
    assert_eq!(moved, 2);
    // The deleted segment is removed; deeper structure survives.
    assert!(model::note_exists(&root, "A/note"));
    assert!(model::note_exists(&root, "A/C/deep"));
    assert!(model::note_exists(&root, "A/sibling"));
    assert!(!root.join("A/B").exists(), "folder tree is removed");
    fs::remove_dir_all(&root).ok();
}

#[test]
fn delete_root_level_folder_moves_notes_to_vault_root() {
    let root = temp_root();
    model::write_note(&root, "Inbox/todo", "x").unwrap();
    let moved = model::delete_folder_move_up(&root, "Inbox").unwrap();
    assert_eq!(moved, 1);
    assert!(model::note_exists(&root, "todo"));
    assert!(!root.join("Inbox").exists());
    fs::remove_dir_all(&root).ok();
}

#[test]
fn delete_folder_suffixes_on_collision() {
    let root = temp_root();
    model::write_note(&root, "A/note", "parent copy").unwrap();
    model::write_note(&root, "A/B/note", "moved copy").unwrap();

    let moved = model::delete_folder_move_up(&root, "A/B").unwrap();
    assert_eq!(moved, 1);
    // `A/note` was occupied → the mover gets the standard `-2` suffix.
    assert_eq!(model::read_note(&root, "A/note"), "parent copy");
    assert_eq!(model::read_note(&root, "A/note-2"), "moved copy");
    fs::remove_dir_all(&root).ok();
}

#[test]
fn delete_folder_relinks_wikilinks_to_moved_notes() {
    let root = temp_root();
    model::write_note(&root, "A/B/spec", "the spec").unwrap();
    model::write_note(&root, "pointer", "see [[A/B/spec]]").unwrap();

    assert_eq!(model::delete_folder_move_up(&root, "A/B").unwrap(), 1);
    assert_eq!(model::read_note(&root, "pointer"), "see [[A/spec]]");
    fs::remove_dir_all(&root).ok();
}

#[test]
fn delete_folder_rejects_root_and_traversal() {
    let root = temp_root();
    assert!(model::delete_folder_move_up(&root, "").is_err());
    assert!(model::delete_folder_move_up(&root, "/").is_err());
    assert!(model::delete_folder_move_up(&root, "../outside").is_err());
    assert!(model::delete_folder_move_up(&root, "A/../B").is_err());
    assert!(model::delete_folder_move_up(&root, "/abs").is_err());
    assert!(model::delete_folder_move_up(&root, "trail/").is_err());
    fs::remove_dir_all(&root).ok();
}

#[test]
fn delete_missing_folder_is_a_noop() {
    let root = temp_root();
    assert_eq!(model::delete_folder_move_up(&root, "Nope").unwrap(), 0);
    fs::remove_dir_all(&root).ok();
}
