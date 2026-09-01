//! OS-open routing for Markdown files.
//!
//! A file already inside the active vault is opened in place. An external file
//! is only described to the frontend; copying it into the vault remains an
//! explicit, confirmed action through the shared store workflow.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use futo_notes_core::files::{note_id_from_relative_path, safe_note_path};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::background_tasks::blocking;

pub(crate) const OPEN_NOTE_REQUEST_EVENT: &str = "open-note-request";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum ExternalFileOpenRequest {
    InsideVault { id: String },
    OutsideVault { path: String, name: String },
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
        })
}

fn absolute_candidate(cwd: &Path, argument: OsString) -> PathBuf {
    let path = PathBuf::from(argument);
    if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    }
}

fn classify_one(vault_root: &Path, candidate: &Path) -> Option<ExternalFileOpenRequest> {
    if !is_markdown(candidate) {
        return None;
    }
    let source = candidate.canonicalize().ok()?;
    if !source.is_file() {
        return None;
    }
    let root = vault_root.canonicalize().ok()?;

    if let Ok(relative) = source.strip_prefix(&root) {
        let relative = relative.to_string_lossy().replace('\\', "/");
        if let Some(id) = note_id_from_relative_path(&relative) {
            let expected = safe_note_path(&root, &id).ok()?.canonicalize().ok()?;
            if expected == source {
                return Some(ExternalFileOpenRequest::InsideVault { id });
            }
        }
    }

    Some(ExternalFileOpenRequest::OutsideVault {
        path: source.to_str()?.to_owned(),
        name: source.file_name()?.to_str()?.to_owned(),
    })
}

fn classify_arguments(
    vault_root: &Path,
    cwd: &Path,
    arguments: impl IntoIterator<Item = OsString>,
) -> Vec<ExternalFileOpenRequest> {
    arguments
        .into_iter()
        .filter_map(|argument| classify_one(vault_root, &absolute_candidate(cwd, argument)))
        .collect()
}

#[tauri::command]
pub(crate) async fn external_file_open_requests(
    app: AppHandle,
) -> Result<Vec<ExternalFileOpenRequest>, String> {
    let root = crate::vault_location::root(&app)?;
    let cwd = std::env::current_dir().map_err(|error| error.to_string())?;
    let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
    blocking(move || Ok(classify_arguments(&root, &cwd, arguments))).await
}

pub(crate) fn emit_arguments(app: &AppHandle, arguments: Vec<String>, cwd: String) {
    let root = match crate::vault_location::root(app) {
        Ok(root) => root,
        Err(error) => {
            eprintln!("Could not route externally opened Markdown file: {error}");
            return;
        }
    };
    let requests = classify_arguments(
        &root,
        Path::new(&cwd),
        arguments.into_iter().map(OsString::from),
    );
    for request in requests {
        if let Err(error) = app.emit(OPEN_NOTE_REQUEST_EVENT, request) {
            eprintln!("Could not emit external Markdown open request: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(label: &str) -> Self {
            static NEXT: AtomicU32 = AtomicU32::new(0);
            let path = std::env::temp_dir().join(format!(
                "futo-external-open-{label}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn routes_vault_notes_by_safe_id_and_external_notes_by_path() {
        let vault = TempRoot::new("vault");
        let external = TempRoot::new("outside");
        std::fs::create_dir(vault.0.join("Plans")).unwrap();
        let inside = vault.0.join("Plans/launch notes.md");
        let outside = external.0.join("grocery list.markdown");
        std::fs::write(&inside, "inside").unwrap();
        std::fs::write(&outside, "outside").unwrap();

        let requests = classify_arguments(
            &vault.0,
            &external.0,
            [
                inside.into_os_string(),
                OsString::from("grocery list.markdown"),
            ],
        );

        assert_eq!(
            requests,
            [
                ExternalFileOpenRequest::InsideVault {
                    id: "Plans/launch notes".to_owned()
                },
                ExternalFileOpenRequest::OutsideVault {
                    path: outside
                        .canonicalize()
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    name: "grocery list.markdown".to_owned()
                }
            ]
        );
    }

    #[test]
    fn ignores_missing_directories_and_non_markdown_arguments() {
        let vault = TempRoot::new("vault");
        let external = TempRoot::new("outside");
        std::fs::create_dir(external.0.join("folder.md")).unwrap();
        std::fs::write(external.0.join("note.txt"), "text").unwrap();

        let requests = classify_arguments(
            &vault.0,
            &external.0,
            ["missing.md", "folder.md", "note.txt"].map(OsString::from),
        );

        assert!(requests.is_empty());
    }
}
