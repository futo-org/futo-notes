use std::path::Component;

use proptest::prelude::*;
use proptest::test_runner::TestCaseError;

use super::super::filenames::property_tests::{
    arbitrary_title, directory_reference_title, trailing_dot_space_title,
};
use super::*;

const VAULT_ROOT: &str = "/vault";

fn vault_root() -> &'static Path {
    Path::new(VAULT_ROOT)
}

/// Every component of `path` must be a plain name under `base` — no
/// `..`/`.`/root/prefix component can survive into a resolved vault path.
fn assert_contained(base: &Path, path: &Path) -> Result<(), TestCaseError> {
    prop_assert!(path.starts_with(base), "{path:?} escaped {base:?}");
    let relative = path
        .strip_prefix(base)
        .expect("prefix asserted on the line above");
    for component in relative.components() {
        prop_assert!(
            matches!(component, Component::Normal(_)),
            "{path:?} contains non-plain component {component:?}",
        );
    }
    Ok(())
}

/// A vault-relative name the sync writer would use: no component may be
/// empty, `.`, or `..`, and joining it to the vault must stay inside.
fn assert_traversal_free_and_contained(relative: &str) -> Result<(), TestCaseError> {
    for component in relative.replace('\\', "/").split('/') {
        prop_assert!(
            !component.is_empty() && component != "." && component != "..",
            "{relative:?} contains the traversal component {component:?}",
        );
    }
    assert_contained(vault_root(), &vault_root().join(relative))
}

/// Candidate note ids skewed toward traversal: separator soup, explicit
/// `..`/`.` segments, and the characters the filename rules forbid.
fn hostile_note_id() -> impl Strategy<Value = String> {
    prop_oneof![
        "[a-z0-9 ]{0,12}",
        "[a-z0-9./\\\\]{0,16}",
        "[a-z<>:\"|?*]{0,12}",
        prop::collection::vec(
            prop_oneof![
                Just("..".to_owned()),
                Just(".".to_owned()),
                Just(String::new()),
                "[a-z]{1,4}"
            ],
            0..6,
        )
        .prop_map(|segments| segments.join("/")),
    ]
}

/// Note ids `ensure_safe_note_id` is expected to accept, including the
/// non-ASCII titles the app supports.
fn accepted_note_id() -> impl Strategy<Value = String> {
    prop::collection::vec(
        prop_oneof!["[a-z0-9 ]{1,8}", "[a-zé日本語📝]{1,6}", "v[0-9]\\.[0-9]"],
        1..4,
    )
    .prop_map(|segments| segments.join("/"))
}

fn syncable_relative_path() -> impl Strategy<Value = String> {
    prop_oneof![
        "[a-z0-9]{1,8}(/[a-z0-9]{1,8}){0,3}\\.(md|png)",
        // A folder whose name sanitizes to "." or "..", and a leaf that needs
        // several sanitize passes — the two title shapes that break healing.
        directory_reference_title().prop_map(|folder| format!("{folder}/note.md")),
        trailing_dot_space_title().prop_map(|stem| format!("{stem}.md")),
        prop::collection::vec(
            prop_oneof![
                "[a-z0-9 .]{1,8}",
                Just("..".to_owned()),
                Just(".".to_owned()),
                Just(String::new()),
                "[A-Z]{3}",
            ],
            1..5,
        )
        .prop_map(|segments| segments.join("/") + ".md"),
        "[a-z0-9 ./\\\\]{1,16}\\.(md|png|tiff)",
        "[a-z]{1,6}",
    ]
}

proptest! {
    #[test]
    fn accepted_note_paths_stay_inside_the_vault(id in hostile_note_id()) {
        if let Ok(path) = safe_note_path(vault_root(), &id) {
            assert_contained(vault_root(), &path)?;
            prop_assert!(
                path.to_string_lossy().ends_with(".md"),
                "{path:?} is not a markdown path",
            );
        }
    }

    /// The sanitizer's output is a ready-to-use note id, including for
    /// adversarial dot-and-space inputs.
    #[test]
    fn sanitized_titles_are_always_confined_note_ids(title in arbitrary_title()) {
        let sanitized = sanitize_title(&title);
        prop_assert!(
            ensure_safe_note_id(&sanitized).is_ok(),
            "sanitize_title({:?}) produced the unsafe id {:?}",
            title,
            sanitized,
        );
        let path = safe_note_path(vault_root(), &sanitized)
            .map_err(|error| TestCaseError::fail(format!("{sanitized:?}: {error}")))?;
        assert_contained(vault_root(), &path)?;
    }

    #[test]
    fn accepted_appdata_paths_stay_inside_the_base(relative in hostile_note_id()) {
        if let Ok(path) = safe_appdata_path(vault_root(), &relative) {
            assert_contained(vault_root(), &path)?;
        }
    }

    /// A note id survives the round trip through its on-disk path, so a
    /// scanned vault maps back to the ids the app stored.
    #[test]
    fn note_ids_round_trip_through_their_vault_path(id in accepted_note_id()) {
        prop_assume!(ensure_safe_note_id(&id).is_ok());
        let path = safe_note_path(vault_root(), &id).expect("accepted id");
        let relative = crate::files::vault_fs::relative_name(vault_root(), &path)
            .expect("path is inside the vault");
        prop_assert_eq!(note_id_from_relative_path(&relative), Some(id));
    }

    /// An `Accept` decision means the writer uses the remote name verbatim, so
    /// that name must be traversal-free and confined to the vault.
    #[test]
    fn accepted_incoming_paths_are_traversal_free(relative in syncable_relative_path()) {
        if classify_incoming_sync_path(&relative) == IncomingSyncPath::Accept {
            assert_traversal_free_and_contained(&relative)?;
        }
    }

    /// A `Sanitize` decision means the writer uses the name this classifier
    /// minted, so the healed name carries the same containment obligation as
    /// an accepted one.
    #[test]
    fn healed_incoming_paths_are_traversal_free(relative in syncable_relative_path()) {
        if let IncomingSyncPath::Sanitize(healed) = classify_incoming_sync_path(&relative) {
            assert_traversal_free_and_contained(&healed)?;
        }
    }

    /// Healing must settle after one classification; otherwise the same
    /// incoming name is renamed again on each sync round.
    #[test]
    fn healing_an_incoming_path_settles_in_one_round(
        relative in syncable_relative_path(),
    ) {
        if let IncomingSyncPath::Sanitize(healed) = classify_incoming_sync_path(&relative) {
            prop_assert_eq!(
                classify_incoming_sync_path(&healed),
                IncomingSyncPath::Accept,
                "healing {:?} did not settle",
                healed,
            );
        }
    }
}
