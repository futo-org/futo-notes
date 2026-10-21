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

/// Why a path was ignored. `Ignore` means "left strictly alone": never written,
/// never reported to the user, never counted as a failure. The reason exists
/// because the two cases want different treatment downstream — a non-note file
/// is noise, while a name this platform cannot hold is the answer to "why is
/// that note not on my phone" and is worth a journal line.
pub const IGNORE_NOT_A_NOTE: &str = "not a syncable file";
pub const IGNORE_UNPORTABLE_NAME: &str = "name no portable filesystem can hold";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IncomingSyncPath {
    Ignore(&'static str),
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
        return Ignore(IGNORE_NOT_A_NOTE);
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
        // A Windows-illegal character is not dangerous — it cannot escape the
        // vault, and macOS/Linux hold it happily. It is simply a name no
        // portable filesystem can carry, so the file is left alone rather than
        // failed: not written here, not surfaced, not retried. Contrast the
        // screens above and below, which reject names that are genuinely unsafe
        // (traversal) or physically impossible (past NAME_MAX).
        if stem.chars().any(forbidden_path_character) {
            return Ignore(IGNORE_UNPORTABLE_NAME);
        }
        let safe_stem = sanitize_title(stem);
        changed |= safe_stem != stem;
        let safe_component = format!("{safe_stem}{extension}");
        // Defense in depth, deliberately retained. `sanitize_title` now strips
        // outer dots and whitespace to a fixed point, so a component like
        // `". .. ."` sanitizes to the `Untitled` fallback and the rule can no
        // longer mint `.` or `..` — this screen does not fire for dot-space
        // input any more. It stays because containment must not depend on that
        // rule staying that way: a future title-rule change that reintroduced a
        // directory reference would otherwise silently reopen a traversal here,
        // where the healed name is written verbatim.
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

/// The note id of a vault name (`vault_fs::relative_name`): the name without
/// `.md`, when that is a safe id. A `\` is never a separator here, so a Unix
/// file named `a\b.md` is not a note rather than an alias of `a/b.md`.
pub fn note_id_from_relative_path(relative: &str) -> Option<String> {
    let id = relative.strip_suffix(".md")?;
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
        assert_eq!(
            classify_incoming_sync_path("scan.tiff"),
            Ignore(IGNORE_NOT_A_NOTE)
        );
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
        // Windows-illegal characters are IGNORED, not rejected: the name is
        // unportable, not unsafe, so the file is left alone in silence rather
        // than raising a permanent failure the user can never clear.
        for unportable in [
            "a<bad>.md",
            "Recipe: braised short ribs.md",
            "What now?.md",
            "a|b.md",
            "star*.md",
            "Folder: notes/inner.md",
        ] {
            assert_eq!(
                classify_incoming_sync_path(unportable),
                Ignore(IGNORE_UNPORTABLE_NAME),
                "{unportable}",
            );
        }

        let healed = match classify_incoming_sync_path("CON.md") {
            Sanitize(path) => path,
            other => panic!("unexpected {other:?}"),
        };
        assert_eq!(classify_incoming_sync_path(&healed), Accept);
    }

    #[test]
    fn incoming_dot_space_components_heal_to_the_safe_fallback() {
        use IncomingSyncPath::*;
        for (incoming, healed) in [
            (". .. ./note.md", "Untitled/note.md"),
            (". . ./note.md", "Untitled/note.md"),
            (".. .. ../a/note.md", "Untitled/a/note.md"),
        ] {
            assert_eq!(
                classify_incoming_sync_path(incoming),
                Sanitize(healed.to_owned())
            );
            assert_eq!(classify_incoming_sync_path(healed), Accept);
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
            note_id_from_relative_path("Folder/note.md"),
            Some("Folder/note".to_owned())
        );
        assert_eq!(note_id_from_relative_path("Folder\\note.md"), None);
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
mod property_tests;
