//! `puppet_notes_dir_refusal`, the debug-only check behind `SetNotesDirectory`: an agent
//! may point the app only at a folder inside the data folder `just tauri-dev` gives this
//! checkout (`FUTO_NOTES_DATA_DIR`), judged by where the path resolves with symlinks
//! followed, so no spelling of a path reaches another vault (AGENTS.md M3). A person's own
//! pick through the OS folder picker never comes here.

use std::path::{Component, Path, PathBuf};

/// Why `SetNotesDirectory` may not use `dir`, or `None`.
#[tauri::command]
pub(crate) async fn puppet_notes_dir_refusal(dir: String) -> Result<Option<String>, String> {
    if cfg!(not(debug_assertions)) {
        return Err("puppet_notes_dir_refusal exists in debug builds only".into());
    }
    let data_dir = crate::vault_location::environment_data_dir();
    crate::background_tasks::blocking(move || Ok(refusal(data_dir.as_deref(), Path::new(&dir))))
        .await
}

fn refusal(data_dir: Option<&Path>, path: &Path) -> Option<String> {
    let Some(data_dir) = data_dir else {
        return Some(
            "SetNotesDirectory works only in an app started by `just tauri-dev`, whose data \
             folder holds the folders it may use"
                .into(),
        );
    };
    let data_dir = match data_dir.canonicalize() {
        Ok(data_dir) => data_dir,
        Err(error) => return Some(format!("{}: {error}", data_dir.display())),
    };
    if !path.is_absolute() {
        return Some("path must be absolute".into());
    }
    let resolved = match resolve(path) {
        Ok(resolved) => resolved,
        Err(refusal) => return Some(refusal),
    };
    let inside = match resolved.strip_prefix(&data_dir) {
        Ok(inside) if inside.components().next().is_some() => inside,
        _ => {
            return Some(format!(
                "path must be inside {}, this checkout's data folder; {} resolves to {}",
                data_dir.display(),
                path.display(),
                resolved.display()
            ))
        }
    };
    // A second guard, should the data folder itself be set somewhere odd. Windows drops a
    // name's trailing dots and spaces: `futo-notes.` opens `futo-notes`.
    let names_release_vault = inside.components().any(|component| {
        component
            .as_os_str()
            .to_string_lossy()
            .trim_end_matches(['.', ' '])
            .eq_ignore_ascii_case("futo-notes")
    });
    names_release_vault.then(|| "refusing a path that names the release vault".into())
}

/// `path` with the part that exists resolved (symlinks and `..` followed, as the OS
/// follows them) and the rest, which the pick creates, appended as written.
fn resolve(path: &Path) -> Result<PathBuf, String> {
    for existing in path.ancestors() {
        let Ok(base) = existing.canonicalize() else {
            continue;
        };
        let rest = path.strip_prefix(existing).unwrap_or(Path::new(""));
        if rest
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err("path must not climb out of a folder that does not exist yet".into());
        }
        return Ok(if rest.as_os_str().is_empty() {
            base
        } else {
            base.join(rest)
        });
    }
    Err(format!("{} resolves to no folder", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "futo-puppet-notes-dir-{label}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("data/notes")).unwrap();
        std::fs::create_dir_all(root.join("outside")).unwrap();
        root
    }

    #[test]
    fn a_folder_inside_the_data_folder_is_accepted_whether_or_not_it_exists() {
        let root = scratch("inside");
        let data = root.join("data");
        assert_eq!(refusal(Some(&data), &data.join("notes")), None);
        assert_eq!(refusal(Some(&data), &data.join("vault2/inner")), None);
        assert_eq!(refusal(Some(&data), &data.join("notes/../vault2")), None);
    }

    #[test]
    fn nothing_is_accepted_without_the_data_folder_tauri_dev_sets() {
        let root = scratch("unset");
        let refused = refusal(None, &root.join("data/vault2")).unwrap();
        assert!(refused.contains("just tauri-dev"), "{refused}");
    }

    #[test]
    fn a_path_resolving_outside_the_data_folder_is_refused() {
        let root = scratch("outside");
        let data = root.join("data");
        for path in [
            root.join("outside"),
            data.clone(),
            data.join(".."),
            data.join("../outside/vault"),
            data.join("missing/../../outside"),
            PathBuf::from("data/vault2"),
        ] {
            assert!(refusal(Some(&data), &path).is_some(), "{}", path.display());
        }
    }

    #[test]
    fn a_folder_named_for_the_release_vault_is_refused_in_any_spelling() {
        let root = scratch("release");
        let data = root.join("data");
        for name in [
            "futo-notes",
            "FUTO-Notes",
            "futo-notes.",
            "Futo-Notes ",
            "futo-notes/inner",
        ] {
            assert_eq!(
                refusal(Some(&data), &data.join(name)).as_deref(),
                Some("refusing a path that names the release vault"),
                "{name}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_is_judged_by_where_it_leads() {
        let root = scratch("symlink");
        let data = root.join("data");
        std::os::unix::fs::symlink(root.join("outside"), data.join("escape")).unwrap();
        assert!(refusal(Some(&data), &data.join("escape")).is_some());
        assert!(refusal(Some(&data), &data.join("escape/vault")).is_some());
        // The data folder reached through a link of its own is still the data folder.
        std::os::unix::fs::symlink(&data, root.join("data-link")).unwrap();
        assert_eq!(
            refusal(Some(&root.join("data-link")), &data.join("vault2")),
            None
        );
        assert_eq!(refusal(Some(&data), &root.join("data-link/vault2")), None);
    }
}
