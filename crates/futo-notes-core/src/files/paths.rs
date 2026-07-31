use std::path::{Path, PathBuf};

use super::filenames::{forbidden_path_character, sanitize_title};

pub const MAX_FOLDER_DEPTH: usize = 10;
pub const NAME_MAX: usize = 255;

/// A path segment that names a directory instead of a file: empty, `.`, or `..`.
/// Every path rule in this file screens for it, and the incoming-sync classifier
/// screens the segment it MINTS as well as the one it was given.
fn directory_reference(component: &str) -> bool {
    component.is_empty() || component == "." || component == ".."
}

fn valid_note_component(component: &str) -> bool {
    !directory_reference(component) && !component.chars().any(forbidden_path_character)
}

pub fn ensure_safe_note_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.starts_with('/') || id.ends_with('/') || id.contains('\\') {
        return Err("invalid note id".to_owned());
    }
    let components = id.split('/').collect::<Vec<_>>();
    if components.len().saturating_sub(1) > MAX_FOLDER_DEPTH {
        return Err("note id exceeds maximum folder depth".to_owned());
    }
    if components
        .iter()
        .any(|component| !valid_note_component(component))
    {
        return Err("invalid note id".to_owned());
    }
    Ok(())
}

pub fn safe_note_path(base: &Path, id: &str) -> Result<PathBuf, String> {
    ensure_safe_note_id(id)?;
    let mut components = id.split('/').collect::<Vec<_>>();
    let leaf = components.pop().expect("validated ID has a leaf");
    let mut path = base.to_owned();
    path.extend(components);
    path.push(format!("{leaf}.md"));
    Ok(path)
}

pub fn safe_appdata_path(base: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty() {
        return Err("path traversal blocked".to_owned());
    }
    let normalized = relative.replace('\\', "/");
    let looks_like_drive = normalized.as_bytes().get(1) == Some(&b':');
    if normalized.starts_with('/') || looks_like_drive {
        return Err("path traversal blocked".to_owned());
    }
    let components = normalized.split('/').collect::<Vec<_>>();
    if components.iter().copied().any(directory_reference) {
        return Err("path traversal blocked".to_owned());
    }
    let mut path = base.to_owned();
    path.extend(components);
    Ok(path)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IncomingSyncPath {
    Ignore,
    Accept,
    Sanitize(String),
    Reject(&'static str),
}

fn split_syncable_leaf(name: &str) -> (&str, &str) {
    if let Some(stem) = name.strip_suffix(".md") {
        return (stem, ".md");
    }
    name.rfind('.')
        .map(|dot| (&name[..dot], &name[dot..]))
        .unwrap_or((name, ""))
}

pub fn classify_incoming_sync_path(relative: &str) -> IncomingSyncPath {
    use IncomingSyncPath::{Accept, Ignore, Reject, Sanitize};

    if relative.is_empty() {
        return Reject("empty path");
    }
    if !crate::image::is_syncable_filename(relative) {
        return Ignore;
    }

    let normalized = relative.replace('\\', "/");
    if normalized.starts_with('/') || normalized.ends_with('/') {
        return Reject("leading or trailing slash");
    }
    let components = normalized.split('/').collect::<Vec<_>>();
    if components.len().saturating_sub(1) > MAX_FOLDER_DEPTH {
        return Reject("exceeds maximum folder depth");
    }

    let last = components.len() - 1;
    let mut changed = false;
    let mut healed = Vec::with_capacity(components.len());
    for (index, component) in components.into_iter().enumerate() {
        if directory_reference(component) {
            return Reject("traversal or empty component");
        }
        if component.len() > NAME_MAX {
            return Reject("component exceeds filesystem name limit");
        }
        let (stem, extension) = if index == last {
            split_syncable_leaf(component)
        } else {
            (component, "")
        };
        if stem.chars().any(forbidden_path_character) {
            return Reject("forbidden character");
        }
        let safe_stem = sanitize_title(stem);
        changed |= safe_stem != stem;
        let safe_component = format!("{safe_stem}{extension}");
        // `sanitize_title` strips outer dots and then trims the spaces they hid,
        // so a component like `". .. ."` heals to `".."`. Screening only the raw
        // component would let the healed name walk out of the vault.
        if directory_reference(&safe_component) {
            return Reject("healed component is a directory reference");
        }
        if safe_component.len() > NAME_MAX {
            return Reject("component exceeds filesystem name limit");
        }
        healed.push(safe_component);
    }

    if changed {
        Sanitize(healed.join("/"))
    } else {
        Accept
    }
}

pub fn note_id_from_filename(name: &str) -> Option<String> {
    let id = name.strip_suffix(".md")?;
    (!id.is_empty()).then(|| id.to_owned())
}

pub fn note_id_from_relative_path(relative: &str) -> Option<String> {
    let normalized = relative.replace('\\', "/");
    let id = normalized.strip_suffix(".md")?;
    ensure_safe_note_id(id).ok()?;
    Some(id.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_paths_preserve_layout_and_refuse_escape() {
        let base = Path::new("/vault");
        assert_eq!(
            safe_note_path(base, "Specs/v1.4 plan").unwrap(),
            PathBuf::from("/vault/Specs/v1.4 plan.md")
        );
        for unsafe_id in ["", "../note", "a//b", "a\\b", "/note", "a/./b"] {
            assert!(safe_note_path(base, unsafe_id).is_err(), "{unsafe_id}");
        }
        let too_deep = (0..MAX_FOLDER_DEPTH + 2)
            .map(|index| format!("d{index}"))
            .collect::<Vec<_>>()
            .join("/");
        assert!(ensure_safe_note_id(&too_deep).is_err());
    }

    #[test]
    fn appdata_paths_reject_unix_and_windows_traversal() {
        let base = Path::new("/appdata");
        assert_eq!(
            safe_appdata_path(base, "state/config.json").unwrap(),
            PathBuf::from("/appdata/state/config.json")
        );
        for unsafe_path in ["", "../x", "a/../../x", "a\\..\\x", "/x", "C:\\x"] {
            assert!(
                safe_appdata_path(base, unsafe_path).is_err(),
                "{unsafe_path}"
            );
        }
    }

    #[test]
    fn incoming_paths_have_one_accept_heal_ignore_reject_decision() {
        use IncomingSyncPath::*;
        assert_eq!(classify_incoming_sync_path("Folder/note.md"), Accept);
        assert_eq!(classify_incoming_sync_path("photo.PNG"), Accept);
        assert_eq!(classify_incoming_sync_path("scan.tiff"), Ignore);
        assert_eq!(
            classify_incoming_sync_path("CON.md"),
            Sanitize("CON_.md".to_owned())
        );
        assert_eq!(
            classify_incoming_sync_path("folder./note.md"),
            Sanitize("folder/note.md".to_owned())
        );
        assert!(matches!(
            classify_incoming_sync_path("../note.md"),
            Reject(_)
        ));
        assert!(matches!(
            classify_incoming_sync_path("a<bad>.md"),
            Reject(_)
        ));

        let healed = match classify_incoming_sync_path("CON.md") {
            Sanitize(path) => path,
            other => panic!("unexpected {other:?}"),
        };
        assert_eq!(classify_incoming_sync_path(&healed), Accept);
    }

    #[test]
    fn incoming_components_that_heal_into_a_traversal_are_rejected() {
        use IncomingSyncPath::*;
        // The raw component passes the `.`/`..` screen; `sanitize_title` then
        // rewrites it INTO one. Before the healed-component check these returned
        // Sanitize("../note.md"), Sanitize("./note.md"), Sanitize("../a/note.md").
        for attack in [". .. ./note.md", ". . ./note.md", ".. .. ../a/note.md"] {
            assert!(
                matches!(classify_incoming_sync_path(attack), Reject(_)),
                "{attack:?} was not rejected: {:?}",
                classify_incoming_sync_path(attack)
            );
        }
    }

    #[test]
    fn incoming_name_limit_is_bytes_not_ui_title_length() {
        use IncomingSyncPath::*;
        assert_eq!(
            classify_incoming_sync_path(&format!("{}.md", "a".repeat(220))),
            Accept
        );
        assert!(matches!(
            classify_incoming_sync_path(&format!("{}.md", "a".repeat(NAME_MAX))),
            Reject(_)
        ));
        assert!(matches!(
            classify_incoming_sync_path(&format!("{}.md", "界".repeat(90))),
            Reject(_)
        ));
    }

    #[test]
    fn note_id_parsing_is_strict_and_platform_neutral() {
        assert_eq!(note_id_from_filename("note.md"), Some("note".to_owned()));
        assert_eq!(note_id_from_filename("note.MD"), None);
        assert_eq!(note_id_from_filename(".md"), None);
        assert_eq!(
            note_id_from_relative_path("Folder\\note.md"),
            Some("Folder/note".to_owned())
        );
        assert_eq!(note_id_from_relative_path("../note.md"), None);
    }

    #[test]
    fn safe_note_path_traversal_blocked() {
        let base = Path::new("/tmp/futo-notes-test-notes");
        for attack in [
            "..",
            "../etc/passwd",
            "foo/..",
            "foo/../bar",
            "foo\\bar",
            "note\0evil",
            "note<script>",
            "note:colon",
            "/abs",
            "foo/",
        ] {
            assert!(safe_note_path(base, attack).is_err(), "{attack:?}");
        }
    }

    #[test]
    fn safe_note_path_valid_ids() {
        let base = Path::new("/tmp/notes");
        for id in [
            "simple",
            "with spaces",
            "café",
            "日本語",
            "emoji-📝",
            "v2.0-release",
            ".hidden-note",
        ] {
            let path = safe_note_path(base, id).unwrap();
            assert!(path.to_string_lossy().ends_with(".md"));
        }
    }

    #[test]
    fn appdata_traversal_comprehensive() {
        let base = Path::new("/tmp/appdata");
        for attack in [
            "..",
            "../../../etc/passwd",
            "/etc/passwd",
            "foo/../../etc/passwd",
        ] {
            assert!(safe_appdata_path(base, attack).is_err(), "{attack:?}");
        }
        for valid in [
            ".preferences.json",
            "subdir/config.json",
            "deep/nested/path/file.txt",
        ] {
            assert!(safe_appdata_path(base, valid).is_ok(), "{valid:?}");
        }
    }

    #[test]
    fn note_id_from_filename_adversarial() {
        assert_eq!(
            note_id_from_filename("test.md.md"),
            Some("test.md".to_owned())
        );
        assert_eq!(note_id_from_filename(".md.md"), Some(".md".to_owned()));
        assert_eq!(note_id_from_filename("md.md"), Some("md".to_owned()));
    }
}

// Property-based tests. The examples above pin the known attack strings; these
// pin the containment invariant for EVERY input, because a note path that
// resolves outside the vault reads or overwrites a file the app does not own.
#[cfg(test)]
mod property_tests {
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

        #[test]
        fn note_paths_are_deterministic(id in hostile_note_id()) {
            prop_assert_eq!(
                safe_note_path(vault_root(), &id),
                safe_note_path(vault_root(), &id),
            );
        }

        /// FAILS TODAY — kept as the honest statement of the invariant.
        /// Counterexample: `sanitize_title(". .. .")` is `".."`, which
        /// `ensure_safe_note_id` rejects; `sanitize_title(". . .")` is `"."`.
        ///
        /// So the title rule does NOT on its own guarantee a usable single path
        /// component; each caller of `sanitize_title` has to screen the result.
        /// Both callers now do: `safe_note_path` fails closed through
        /// `ensure_safe_note_id` (the note simply cannot be saved), and
        /// `classify_incoming_sync_path` rejects a healed component that is a
        /// directory reference. Closing this gap belongs in the title rule itself
        /// — see `filenames::property_tests` for the root cause and why fixing it
        /// there is a coordinated TS+Rust change.
        #[test]
        #[ignore = "known gap: sanitize_title can return \".\" or \"..\" for dot-and-space titles"]
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
            let relative = path
                .strip_prefix(vault_root())
                .expect("path is inside the vault")
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/");
            prop_assert_eq!(note_id_from_relative_path(&relative), Some(id));
        }

        #[test]
        fn incoming_classification_is_deterministic(relative in syncable_relative_path()) {
            prop_assert_eq!(
                classify_incoming_sync_path(&relative),
                classify_incoming_sync_path(&relative),
            );
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
        /// MINTED, so the healed name carries the same containment obligation as
        /// an accepted one. `sanitize_title` can turn a legal-looking component
        /// into `"."` or `".."` (`". .. ."` -> `".."`), so the classifier screens
        /// the healed component too — see
        /// `incoming_components_that_heal_into_a_traversal_are_rejected`.
        #[test]
        fn healed_incoming_paths_are_traversal_free(relative in syncable_relative_path()) {
            if let IncomingSyncPath::Sanitize(healed) = classify_incoming_sync_path(&relative) {
                assert_traversal_free_and_contained(&healed)?;
            }
        }

        /// FAILS TODAY — kept as the honest statement of the invariant.
        /// Counterexample: `classify_incoming_sync_path("a. ..md")` heals to
        /// `"a..md"`, which is itself `Sanitize("a.md")` rather than `Accept`.
        ///
        /// Root cause: `sanitize_title` is not idempotent. Its
        /// `trim().trim_matches('.').trim()` is a fixed three-pass strip, so each
        /// application peels exactly one trailing ". " group:
        /// `"a. . . . . ."` -> `"a. . . . ."` -> ... -> `"a"`. A name with N such
        /// groups therefore needs N heal rounds, and each round renames the file
        /// again — repeated cross-client renames of one note, the churn class this
        /// repo has been bitten by before. `packages/editor/src/filename.ts` has
        /// the same three-pass shape, so the TS and Rust rules agree (no drift);
        /// closing this is a coordinated rule change plus regenerated conformance
        /// fixtures (AGENTS.md M7), not a test fix.
        ///
        /// The existing `filenames.rs` `sanitize_is_idempotent` test passes only
        /// because none of its eight fixed inputs has a trailing ". " group.
        #[test]
        #[ignore = "known gap: sanitize_title is not idempotent, so healing can take several rounds"]
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
}
