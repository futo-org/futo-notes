//! Desktop vault location resolution and persisted override policy.
//!
//! This is the only desktop module allowed to decide where the vault lives.
//! The debug/production split is a data-safety boundary, not a convenience.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::background_tasks::{blocking, io_error};

const OVERRIDE_FILE: &str = "notes-dir-override.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct VaultOverride {
    notes_dir: Option<String>,
}

pub(crate) fn environment_data_dir() -> Option<PathBuf> {
    std::env::var("FUTO_NOTES_DATA_DIR").ok().map(PathBuf::from)
}

fn override_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(data_dir) = environment_data_dir() {
        return Ok(data_dir.join(OVERRIDE_FILE));
    }
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join(OVERRIDE_FILE))
}

fn load_override(app: &AppHandle) -> Option<PathBuf> {
    read_override_file(&override_path(app).ok()?)
}

fn read_override_file(path: &std::path::Path) -> Option<PathBuf> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<VaultOverride>(&raw)
        .ok()?
        .notes_dir
        .map(PathBuf::from)
}

fn save_override(app: &AppHandle, directory: Option<&str>) -> Result<(), String> {
    write_override_file(&override_path(app)?, directory)
}

/// Stores the picked directory verbatim, document-portal paths included: the
/// chooser's grant is already persistent and reused on a re-pick, and the portal
/// refuses to re-register its own mount — see `portal_vault`'s module docs.
fn write_override_file(path: &std::path::Path, directory: Option<&str>) -> Result<(), String> {
    let value = VaultOverride {
        notes_dir: directory.map(str::to_owned),
    };
    let json = serde_json::to_string_pretty(&value).map_err(|error| error.to_string())?;
    futo_notes_core::files::write_atomic_text(path, &json)
}

pub(crate) fn default_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(data_dir) = environment_data_dir() {
        return Ok(data_dir.join("notes"));
    }

    let documents = app
        .path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|error| error.to_string())?;

    #[cfg(debug_assertions)]
    return Ok(documents.join("fake-notes"));

    #[cfg(not(debug_assertions))]
    Ok(documents.join("futo-notes"))
}

/// The stable opening of the message every command returns once the active
/// vault has gone missing. `vault_status` is the recovery path: the frontend
/// keeps Settings' Storage section usable so the user can re-pick a folder or
/// reset to the default, and the sentence has to send the user there — github#44
/// spent a whole issue on a server audit because nothing said which folder was
/// the problem. Same wording as the engine's `SyncErrorKind::VaultMissing`, so a
/// user who meets this from a note command and one who meets it from a sync
/// cycle read the same thing.
pub(crate) const VAULT_UNAVAILABLE: &str = "Can't find your vault folder at";

/// Creates the default root on demand — the only root created on demand (a custom
/// root is created once, when it is picked). The setup hook calls this before the
/// webview loads, which is what lets `vault_status` answer read-only.
pub(crate) fn root(app: &AppHandle) -> Result<PathBuf, String> {
    resolve_root(load_override(app), || {
        let root = default_root(app)?;
        fs::create_dir_all(&root).map_err(io_error)?;
        Ok(root)
    })
}

/// THE availability rule — every consumer (commands via [`root`], the frontend via
/// `vault_status`) asks this one function, with creation of the default root left
/// to the caller's closure so asking never has to write anything.
///
/// A custom root is never created on demand: for a vanished one — an unmounted
/// drive, a revoked document-portal grant — `create_dir_all` either fails on every
/// command from cold start or, worse, succeeds under a writable ancestor and writes
/// notes into a fresh empty directory standing where the vault was.
fn resolve_root(
    custom: Option<PathBuf>,
    default: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    match custom {
        Some(custom) => {
            if !custom.is_dir() {
                // A doc-portal path also fails to stat when the portal's FUSE
                // mount is simply not up yet (the daemon is D-Bus-activated) —
                // distinguish that from a revoked grant before declaring the
                // vault gone.
                crate::portal_vault::wake_documents_portal(&custom);
            }
            if custom.is_dir() {
                Ok(custom)
            } else {
                // The folder the user picked, not the document-portal path it
                // resolves to — the message is useless if it names a path they
                // have never seen.
                Err(format!(
                    "{VAULT_UNAVAILABLE} {}. Please reconfigure in settings.",
                    crate::portal_vault::display_path(&custom)
                ))
            }
        }
        None => default(),
    }
}

/// Everything the frontend needs to describe the active vault, including when it
/// is unreachable. Deliberately infallible: the Storage settings section is the
/// only way out of an unavailable vault, so it must never depend on reading one.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    /// Where the vault is, in terms a user recognises — a document-portal vault
    /// resolves back to the folder they actually picked. The raw root is
    /// deliberately not reported: nothing in the UI has a use for a path the user
    /// would not recognise.
    display_path: String,
    is_custom: bool,
    available: bool,
    /// True when the OS trash cannot accept deletions from this vault, so the
    /// delete confirmations must stop implying they are recoverable.
    deletes_are_permanent: bool,
    /// True when a deleted folder's remaining shell (notes are always moved out
    /// first) bypasses the trash — the Trash portal declines directories, so this
    /// holds in every Flatpak even where notes trash fine.
    folder_deletes_are_permanent: bool,
}

fn status(app: &AppHandle) -> VaultStatus {
    status_of(load_override(app), default_root(app))
}

fn status_of(custom: Option<PathBuf>, default: Result<PathBuf, String>) -> VaultStatus {
    // Where the vault is supposed to be — named even when unreachable, so Settings
    // can say which folder went missing.
    let located = custom.clone().or_else(|| default.clone().ok());
    VaultStatus {
        display_path: located.as_deref().map_or_else(
            || "No notes folder is available".to_owned(),
            crate::portal_vault::display_path,
        ),
        is_custom: custom.is_some(),
        // The rule every command applies, read-only: the setup hook already tried
        // to create the default root, so one that is not a directory could not be
        // created (Windows Controlled Folder Access, crash 1739) or has since gone.
        available: resolve_root(custom, || default).is_ok_and(|root| root.is_dir()),
        deletes_are_permanent: located
            .as_deref()
            .is_some_and(crate::system_trash::deletes_are_permanent),
        folder_deletes_are_permanent: located
            .as_deref()
            .is_some_and(crate::system_trash::folder_deletes_are_permanent),
    }
}

#[tauri::command]
pub async fn notes_dir_override_load(app: AppHandle) -> Result<Option<String>, String> {
    blocking(move || Ok(load_override(&app).map(|path| path.to_string_lossy().into_owned()))).await
}

#[tauri::command]
pub async fn notes_dir_override_save(app: AppHandle, dir: Option<String>) -> Result<(), String> {
    blocking(move || save_override(&app, dir.as_deref())).await
}

#[tauri::command]
pub async fn resolve_default_notes_root(app: AppHandle) -> Result<String, String> {
    blocking(move || Ok(default_root(&app)?.to_string_lossy().into_owned())).await
}

#[tauri::command]
pub async fn vault_status(app: AppHandle) -> Result<VaultStatus, String> {
    blocking(move || Ok(status(&app))).await
}

/// Names a directory the way the user recognises it, so a confirmation dialog can
/// say `~/Notes` instead of `/run/user/1000/doc/A1b2C3/Notes`. Read-only: asking
/// what a folder is called must not grant anything, because the user has not
/// confirmed the change yet.
#[tauri::command]
pub async fn vault_display_path(dir: String) -> Result<String, String> {
    blocking(move || {
        Ok(crate::portal_vault::display_path(std::path::Path::new(
            &dir,
        )))
    })
    .await
}

#[cfg(test)]
mod tests {
    //! Tests for vault location resolution.
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn environment_data_dir_tracks_override() {
        let _guard = ENV_LOCK.lock().unwrap();
        let previous = std::env::var_os("FUTO_NOTES_DATA_DIR");
        std::env::remove_var("FUTO_NOTES_DATA_DIR");
        assert_eq!(environment_data_dir(), None);

        std::env::set_var("FUTO_NOTES_DATA_DIR", "/tmp/futo-vault-test");
        assert_eq!(
            environment_data_dir(),
            Some(PathBuf::from("/tmp/futo-vault-test"))
        );

        match previous {
            Some(value) => std::env::set_var("FUTO_NOTES_DATA_DIR", value),
            None => std::env::remove_var("FUTO_NOTES_DATA_DIR"),
        }
    }

    fn scratch(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "futo-vault-{label}-{}-{}",
            std::process::id(),
            futo_notes_core::files::now_ms()
        ))
    }

    #[test]
    fn a_missing_custom_root_is_reported_unavailable_not_recreated() {
        let vanished = scratch("vanished");
        let error = resolve_root(Some(vanished.clone()), || unreachable!()).unwrap_err();
        assert!(
            error.starts_with(VAULT_UNAVAILABLE),
            "the frontend keys the recovery UI off this message, got {error}"
        );
        assert!(
            error.contains(&vanished.display().to_string()),
            "the message must name the folder that went missing, got {error}"
        );
        assert!(
            error.ends_with("Please reconfigure in settings."),
            "the message must say where the way out is, got {error}"
        );
        assert!(
            !vanished.exists(),
            "a vanished custom vault must never be replaced by an empty directory"
        );
    }

    #[test]
    fn an_existing_custom_root_is_used_as_is() {
        let existing = scratch("existing");
        fs::create_dir_all(&existing).unwrap();
        assert_eq!(
            resolve_root(Some(existing.clone()), || unreachable!()).unwrap(),
            existing
        );
        fs::remove_dir_all(existing).unwrap();
    }

    /// With no custom root the default closure answers — and `resolve_root` itself
    /// creates nothing, which is what lets `vault_status` ask the same question
    /// read-only while `root()` supplies a creating closure.
    #[test]
    fn resolve_root_defers_to_the_default_closure_without_creating_anything() {
        let fresh = scratch("default");
        assert_eq!(resolve_root(None, || Ok(fresh.clone())).unwrap(), fresh);
        assert!(
            !fresh.exists(),
            "resolve_root must not create the default root itself"
        );
        assert!(resolve_root(None, || Err("no documents dir".to_owned())).is_err());
    }

    /// Crash 1739: Windows Controlled Folder Access refuses to create
    /// `Documents\futo-notes`, so every command failed while `vault_status` still
    /// reported the default root available — no toast, no Storage warning, just an
    /// empty app. Setup's failed creation leaves no directory there — stood in for
    /// here by a file — and a default root that is not a directory is unavailable.
    #[test]
    fn a_default_root_that_cannot_be_created_is_reported_unavailable() {
        let parent = scratch("uncreatable-default");
        fs::create_dir_all(&parent).unwrap();
        // A file where the root should go makes creation fail on every OS.
        let blocked = parent.join("notes");
        fs::write(&blocked, "").unwrap();

        let status = status_of(None, Ok(blocked.clone()));
        assert!(
            !status.available,
            "an uncreatable default root must be unavailable"
        );
        assert!(!status.is_custom);
        assert_eq!(status.display_path, blocked.display().to_string());

        fs::remove_dir_all(parent).unwrap();
    }

    /// Asking must never write: startup creates the default root before the
    /// webview asks, so a missing one is unavailable, not recreated in place.
    #[test]
    fn a_missing_default_root_is_unavailable_and_not_created() {
        let missing = scratch("missing-default").join("notes");

        assert!(!status_of(None, Ok(missing.clone())).available);
        assert!(!missing.exists(), "vault_status must not create anything");
    }

    #[test]
    fn an_existing_default_root_is_available() {
        let existing = scratch("existing-default");
        fs::create_dir_all(&existing).unwrap();

        assert!(status_of(None, Ok(existing.clone())).available);

        fs::remove_dir_all(existing).unwrap();
    }

    /// A document-portal path must reach the override file byte-for-byte. An earlier
    /// version re-registered it with the portal first, to "make the grant
    /// persistent", and every sandboxed pick failed with `Invalid fd passed` — the
    /// chooser's grant is already persistent and the portal refuses to re-register
    /// its own mount. This round-trips through the real read/write pair, so any
    /// transformation reintroduced on either side fails here rather than only in a
    /// sandbox.
    #[test]
    fn a_document_portal_path_round_trips_through_the_override_file_unchanged() {
        let directory = scratch("override-roundtrip");
        fs::create_dir_all(&directory).unwrap();
        let file = directory.join(OVERRIDE_FILE);
        let picked = "/run/user/1000/doc/A1b2C3/My Notes";

        write_override_file(&file, Some(picked)).unwrap();
        assert_eq!(read_override_file(&file), Some(PathBuf::from(picked)));
        // Clearing the override stores no directory at all.
        write_override_file(&file, None).unwrap();
        assert_eq!(read_override_file(&file), None);

        fs::remove_dir_all(directory).unwrap();
    }
}
