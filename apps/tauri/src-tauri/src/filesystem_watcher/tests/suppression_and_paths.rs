//! The one-shot suppression, the cross-language window, and path normalization.

use super::classify::relative_note_path;
use super::*;

/// Cross-language constants gate (architecture-hardening.md PKT-7 gate 3).
/// `tests/conformance/constants.json`'s `watcherSuppressionWindowMs` is
/// also asserted from `futo-notes-model`'s conformance test (image set,
/// title length — this crate isn't a dependency of that one) and from
/// `src/lib/constantsConformance.test.ts` (TS side). Runs under
/// `cargo test --workspace` (`just test-rust-full`), not the fast
/// model-only `just test-rust`, because compiling this crate needs
/// `dist/` to exist (tauri::generate_context!).
#[test]
fn suppression_window_matches_cross_language_constant() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tests/conformance/constants.json")
        .canonicalize()
        .expect("tests/conformance/constants.json must exist");
    let text =
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let json: serde_json::Value = serde_json::from_str(&text).expect("fixture is valid JSON");
    let expected = json["watcherSuppressionWindowMs"]
        .as_i64()
        .expect("watcherSuppressionWindowMs");
    assert_eq!(
        SUPPRESSION_WINDOW_MS, expected,
        "SUPPRESSION_WINDOW_MS drifted from tests/conformance/constants.json"
    );
}

#[test]
fn suppression_is_one_shot() {
    let suppression = WatcherSuppression::default();
    suppression.register("note.md");
    assert!(suppression.consume("note.md"));
    assert!(!suppression.consume("note.md"));
}

#[test]
fn expired_suppression_is_not_consumed() {
    let suppression = WatcherSuppression::default();
    suppression
        .entries
        .lock()
        .unwrap()
        .insert("note.md".to_owned(), 0);
    assert!(!suppression.consume("note.md"));
    assert!(!suppression.contains("note.md"));
}

#[test]
fn rename_consumes_both_paths_atomically() {
    let suppression = WatcherSuppression::default();
    suppression.register("old.md");
    suppression.register("new.md");
    assert!(suppression.consume_rename("old.md", "new.md"));
    assert!(!suppression.consume("old.md"));
    assert!(!suppression.consume("new.md"));
}

#[test]
fn partial_rename_registration_consumes_neither_path() {
    let suppression = WatcherSuppression::default();
    suppression.register("old.md");
    assert!(!suppression.consume_rename("old.md", "new.md"));
    assert!(suppression.contains("old.md"));
}

#[test]
fn only_note_names_are_reported_and_hidden_paths_are_rejected() {
    let base = Path::new("/vault");
    let name = |relative: &str| relative_note_path(base, &base.join(relative));
    assert_eq!(name("Folder/note.md"), Some("Folder/note.md".to_owned()));
    assert_eq!(name("legacy.txt"), Some("legacy.txt".to_owned()));
    assert_eq!(name(".git/note.md"), None);
    assert_eq!(name("image.png"), None);
    // On Unix `\` is part of the name, and no note id holds one: reporting
    // it would point the change at the real `Folder/note`.
    #[cfg(unix)]
    assert_eq!(name("Folder\\note.md"), None);
}

#[test]
fn path_resolution_accepts_raw_and_canonical_root_spellings() {
    let raw = PathBuf::from("/var/futo-notes");
    let canonical = PathBuf::from("/private/var/futo-notes");
    let bases = vec![canonical.clone(), raw.clone()];
    assert_eq!(
        relative_note_path_any(&bases, &raw.join("Folder/note.md")),
        Some("Folder/note.md".to_owned())
    );
    assert_eq!(
        relative_note_path_any(&bases, &canonical.join("Folder/note.md")),
        Some("Folder/note.md".to_owned())
    );
}
