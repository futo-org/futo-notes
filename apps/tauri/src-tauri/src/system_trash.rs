//! Recoverable deletion through the desktop operating system's trash.

use std::path::Path;

/// Whether deletions from `root` bypass the OS trash and are gone for good, so
/// the delete confirmations can stop implying they are recoverable.
///
/// A document-portal vault is the case that matters: `org.freedesktop.portal.Trash`
/// declines a doc-portal path outright (the host trash directory it would move the
/// file into is not reachable from the sandbox), while accepting the very same file
/// under `$HOME`. Verified against a live portal by
/// `portal_trash_declines_a_document_portal_path`.
pub(crate) fn deletes_are_permanent(root: &Path) -> bool {
    crate::portal_vault::is_portal_path(root)
}

/// Whether a deleted folder's remaining shell bypasses the trash. Directories can
/// never go through the Trash portal — it declines anything that is not a regular
/// file (pinned by `portal_trash_declines_a_directory`) — so this holds in every
/// Flatpak, even for the default vault whose notes trash fine. Notes are moved out
/// before the shell is removed, so what this dooms is the emptied tree plus any
/// stray non-note files inside it.
pub(crate) fn folder_deletes_are_permanent(root: &Path) -> bool {
    deletes_are_permanent(root) || crate::platform_integration::is_flatpak()
}

pub(crate) fn delete(path: &Path, label: &str) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }

    // No trash of any kind can take this one; skip straight to the fallback
    // instead of logging a decline for every delete.
    if deletes_are_permanent(path) {
        return hard_delete(path);
    }

    #[cfg(target_os = "linux")]
    if crate::platform_integration::is_flatpak() {
        if let Err(error) = portal_trash(path) {
            eprintln!("[{label}] portal trash failed: {error}; falling back to hard delete");
            hard_delete(path)?;
        }
        return Ok(());
    }

    #[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
    if let Err(error) = trash::delete(path) {
        eprintln!("[{label}] trash::delete failed: {error}; falling back to hard delete");
        hard_delete(path)?;
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    hard_delete(path)?;

    Ok(())
}

#[cfg(target_os = "linux")]
fn portal_trash(path: &Path) -> Result<(), String> {
    use std::os::fd::AsFd;

    let file = open_for_trash(path)?;
    let connection = zbus::blocking::Connection::session().map_err(|error| error.to_string())?;
    let reply = connection
        .call_method(
            Some("org.freedesktop.portal.Desktop"),
            "/org/freedesktop/portal/desktop",
            Some("org.freedesktop.portal.Trash"),
            "TrashFile",
            &zbus::zvariant::Fd::from(file.as_fd()),
        )
        .map_err(|error| error.to_string())?;
    let result: u32 = reply
        .body()
        .deserialize()
        .map_err(|error| error.to_string())?;
    if result == 1 {
        Ok(())
    } else {
        Err(format!("portal declined to trash {}", path.display()))
    }
}

#[cfg(target_os = "linux")]
fn open_for_trash(path: &Path) -> Result<std::fs::File, String> {
    use std::os::unix::fs::OpenOptionsExt;

    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
        .or_else(|_| {
            std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_PATH | libc::O_CLOEXEC | libc::O_NOFOLLOW)
                .open(path)
        })
        .map_err(crate::background_tasks::io_error)
}

fn hard_delete(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        std::fs::remove_dir_all(path).map_err(crate::background_tasks::io_error)
    } else {
        std::fs::remove_file(path).map_err(crate::background_tasks::io_error)
    }
}

#[cfg(test)]
mod tests {
    //! Tests for operating-system trash fallback behavior.
    use super::*;

    /// The portal call is only exercised where a desktop portal actually answers:
    /// headless CI has no session bus, and a skipped run says so out loud rather
    /// than passing quietly (AGENTS.md M11).
    #[cfg(target_os = "linux")]
    fn portal_available() -> bool {
        let Ok(connection) = zbus::blocking::Connection::session() else {
            eprintln!("SKIP portal trash test: no session bus");
            return false;
        };
        let reachable = connection
            .call_method(
                Some("org.freedesktop.DBus"),
                "/org/freedesktop/DBus",
                Some("org.freedesktop.DBus"),
                "NameHasOwner",
                &"org.freedesktop.portal.Desktop",
            )
            .ok()
            .and_then(|reply| reply.body().deserialize::<bool>().ok())
            .unwrap_or(false);
        if !reachable {
            eprintln!("SKIP portal trash test: org.freedesktop.portal.Desktop has no owner");
        }
        reachable
    }

    /// `portal_trash` must move a real file out of the vault and into the trash.
    /// This is the one path unit-testable only against a live portal: the D-Bus
    /// method name, the file-descriptor argument, and the `u32` reply are all
    /// contract details a mock would simply restate.
    #[test]
    #[cfg(target_os = "linux")]
    fn portal_trash_removes_a_regular_file() {
        if !portal_available() {
            return;
        }
        // The portal trashes into the home trash, so the file has to live under $HOME.
        let root = dirs_home()
            .join(".cache")
            .join(format!("futo-portal-trash-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let note = root.join(format!(
            "portal probe {}.md",
            futo_notes_core::files::now_ms()
        ));
        std::fs::write(&note, "body").unwrap();

        portal_trash(&note).unwrap();
        assert!(
            !note.exists(),
            "portal reported success but the file is still there"
        );
        let trashed = empty_from_trash(&root);
        assert!(
            trashed,
            "nothing in the trash records the probe — was it really trashed?"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Drop the probe back out of the real trash, so running the suite does not slowly
    /// fill the developer's trash with test files. Matches on the probe's unique parent
    /// directory: the trashed *name* gains a `.N` uniquifier, and `Path=` is
    /// URL-encoded, so neither survives a plain filename comparison.
    #[cfg(target_os = "linux")]
    fn empty_from_trash(probe_dir: &Path) -> bool {
        let marker = probe_dir
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let trash = dirs_home().join(".local/share/Trash");
        let Ok(entries) = std::fs::read_dir(trash.join("info")) else {
            return false;
        };
        let mut found = false;
        for entry in entries.flatten() {
            let info = entry.path();
            let Ok(body) = std::fs::read_to_string(&info) else {
                continue;
            };
            if !body.contains(&marker) {
                continue;
            }
            found = true;
            let trashed = info
                .file_name()
                .unwrap()
                .to_string_lossy()
                .replace(".trashinfo", "");
            let _ = std::fs::remove_file(trash.join("files").join(trashed));
            let _ = std::fs::remove_file(&info);
        }
        found
    }

    /// A directory is NOT trashable through the portal: it hands the portal an
    /// `O_PATH` descriptor (a directory cannot be opened `O_RDWR`) and the portal
    /// declines. `delete` therefore hard-deletes folders inside a Flatpak, which is
    /// why `docs/spec/list.md` records folder delete as permanent there.
    #[test]
    #[cfg(target_os = "linux")]
    fn portal_trash_declines_a_directory() {
        if !portal_available() {
            return;
        }
        let root = dirs_home()
            .join(".cache")
            .join(format!("futo-portal-trash-dir-{}", std::process::id()));
        std::fs::create_dir_all(root.join("folder")).unwrap();

        let outcome = portal_trash(&root.join("folder"));
        assert!(
            outcome.is_err(),
            "portal accepted a directory — folder delete in Flatpak is recoverable after all, \
             so docs/spec/list.md needs updating"
        );
        assert!(
            root.join("folder").exists(),
            "a declined portal call must not delete anything"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The reason `deletes_are_permanent` exists: the portal takes a regular file
    /// under `$HOME` (see `portal_trash_removes_a_regular_file`) but declines the
    /// very same file on a document-portal path, because the host trash directory
    /// it would move it into is not reachable through that mount. So a vault the
    /// user picked inside the sandbox has no trash at all, and the delete
    /// confirmations must say so — `docs/spec/list.md` records that behavior.
    #[test]
    #[cfg(target_os = "linux")]
    fn portal_trash_declines_a_document_portal_path() {
        if !crate::portal_vault::documents_portal_available() {
            return;
        }
        let real = std::env::temp_dir().join(format!(
            "futo-portal-trash-doc-{}-{}",
            std::process::id(),
            futo_notes_core::files::now_ms()
        ));
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("note.md"), "body").unwrap();

        let granted = crate::portal_vault::register_document_for_test(
            &real,
            crate::portal_vault::ADD_FLAGS_CHOOSER,
        )
        .unwrap();
        let through_portal = granted.join("note.md");
        assert!(
            through_portal.exists(),
            "the grant should expose the file at {}",
            through_portal.display()
        );
        assert!(
            deletes_are_permanent(&through_portal),
            "a doc-portal path must be treated as untrashable"
        );
        assert!(
            portal_trash(&through_portal).is_err(),
            "the portal accepted a doc-portal path — deletes there are recoverable \
             after all, so docs/spec/list.md needs updating"
        );
        assert!(
            through_portal.exists(),
            "a declined portal call must not delete anything"
        );

        // `delete` must not leave the note behind just because no trash will take it.
        delete(&through_portal, "test").unwrap();
        assert!(!real.join("note.md").exists());

        crate::portal_vault::revoke_grant_for_test(&granted);
        std::fs::remove_dir_all(real).unwrap();
    }

    #[cfg(target_os = "linux")]
    fn dirs_home() -> std::path::PathBuf {
        std::path::PathBuf::from(std::env::var("HOME").expect("HOME must be set"))
    }

    #[test]
    fn hard_delete_handles_files_and_directories() {
        let root = std::env::temp_dir().join(format!(
            "futo-tauri-trash-{}-{}",
            std::process::id(),
            futo_notes_core::files::now_ms()
        ));
        std::fs::create_dir_all(root.join("folder")).unwrap();
        std::fs::write(root.join("note.md"), "body").unwrap();
        hard_delete(&root.join("note.md")).unwrap();
        hard_delete(&root.join("folder")).unwrap();
        assert!(!root.join("note.md").exists());
        assert!(!root.join("folder").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
