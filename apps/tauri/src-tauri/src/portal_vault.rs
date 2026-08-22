//! XDG document-portal vaults: the notes folder a user picks inside a Flatpak.
//!
//! A directory chosen through the FileChooser portal is handed to the app as a
//! document-portal FUSE path (`/run/user/<uid>/doc/<doc-id>/<name>`), not as its
//! real location. Three portal behaviours shape the rest of the desktop adapter;
//! each was measured against a live portal rather than inferred:
//!
//! * inotify on that mount reports only the changes made *through* the mount, so
//!   external editors are invisible to it — [`inotify_is_unreliable`] tells
//!   `filesystem_watcher` to poll instead.
//! * `org.freedesktop.portal.Trash` declines a doc-portal path (it accepts the
//!   same file fine under `$HOME`), so deletes on such a vault are permanent —
//!   see `system_trash`.
//! * **the chooser's path is already durable — never re-register it.**
//!   xdg-desktop-portal registers a picked directory `PERSISTENT | REUSE_EXISTING`
//!   with `read,write,grant-permissions` (`src/file-chooser.c` →
//!   `xdp_register_document`): the grant outlives the process and re-picking the
//!   same folder returns the *same* document id. An `AddFull` re-mint is refused
//!   outright — the portal rejects a descriptor into its own FUSE mount
//!   ("Invalid fd passed") — pinned by
//!   [`tests::re_registering_a_document_portal_path_is_refused`].

use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
const DOCUMENTS_NAME: &str = "org.freedesktop.portal.Documents";
#[cfg(target_os = "linux")]
const DOCUMENTS_PATH: &str = "/org/freedesktop/portal/documents";

/// Whether `path` lives on the document portal's FUSE mount.
pub(crate) fn is_portal_path(path: &Path) -> bool {
    #[cfg(target_os = "linux")]
    return is_below_mount(&documents_mount(unsafe { libc::getuid() }), path);

    #[cfg(not(target_os = "linux"))]
    {
        let _ = path;
        false
    }
}

/// A doc-portal path can fail to stat for two reasons: the grant is gone, or the
/// portal's FUSE mount is simply not up yet — the document portal is D-Bus
/// activated, so before it has answered any call the mount does not exist. Any
/// Documents call wakes it; after this, a failed stat means the grant is gone.
/// Best-effort by design: no bus or no portal means there is nothing to wake.
pub(crate) fn wake_documents_portal(path: &Path) {
    #[cfg(target_os = "linux")]
    {
        if !is_portal_path(path) {
            return;
        }
        let Ok(connection) = zbus::blocking::Connection::session() else {
            return;
        };
        let _ = connection.call_method(
            Some(DOCUMENTS_NAME),
            DOCUMENTS_PATH,
            Some(DOCUMENTS_NAME),
            "GetMountPoint",
            &(),
        );
    }
    #[cfg(not(target_os = "linux"))]
    let _ = path;
}

/// Whether a watcher on `root` must poll because inotify would silently miss
/// external edits.
///
/// Scoped to the document portal's mount, which is the case that was measured: a
/// write to the real file produces no inotify event at all there, only a write made
/// through the mount does. Other FUSE filesystems (sshfs, gocryptfs) may share that
/// blind spot, but polling costs ~0.1 ms per vault entry per interval, and imposing
/// it on filesystems nobody has measured would be a guess charged to the user.
pub(crate) fn inotify_is_unreliable(root: &Path) -> bool {
    is_portal_path(root)
}

/// The real location behind a doc-portal path, for display only. `None` when
/// `path` is not a portal path or the portal cannot answer.
pub(crate) fn host_path(path: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        let (document_id, below) = split_portal_path(path)?;
        let connection = zbus::blocking::Connection::session().ok()?;
        let reply = connection
            .call_method(
                Some(DOCUMENTS_NAME),
                DOCUMENTS_PATH,
                Some(DOCUMENTS_NAME),
                "Info",
                &(document_id.as_str(),),
            )
            .ok()?;
        let (raw, _apps): (Vec<u8>, std::collections::HashMap<String, Vec<String>>) =
            reply.body().deserialize().ok()?;
        let host = path_from_nul_terminated(&raw)?;
        // `Info` already answers with the document's own final component, so
        // joining an empty remainder would only add a trailing separator.
        Some(if below.as_os_str().is_empty() {
            host
        } else {
            host.join(below)
        })
    }

    #[cfg(not(target_os = "linux"))]
    {
        let _ = path;
        None
    }
}

#[cfg(target_os = "linux")]
fn documents_mount(uid: u32) -> PathBuf {
    PathBuf::from(format!("/run/user/{uid}/doc"))
}

#[cfg(target_os = "linux")]
fn is_below_mount(mount: &Path, path: &Path) -> bool {
    path.starts_with(mount) && path != mount
}

/// Splits `<mount>/<doc-id>/<name>/<rest…>` into the document id and the part
/// below the document's own final component (empty for the vault root itself).
#[cfg(target_os = "linux")]
fn split_portal_path_below(mount: &Path, path: &Path) -> Option<(String, PathBuf)> {
    let mut components = path.strip_prefix(mount).ok()?.components();
    let document_id = components.next()?.as_os_str().to_str()?.to_owned();
    // The document's own name is already the last component of `Info`'s answer.
    components.next()?;
    Some((document_id, components.collect()))
}

#[cfg(target_os = "linux")]
fn split_portal_path(path: &Path) -> Option<(String, PathBuf)> {
    split_portal_path_below(&documents_mount(unsafe { libc::getuid() }), path)
}

#[cfg(target_os = "linux")]
fn path_from_nul_terminated(raw: &[u8]) -> Option<PathBuf> {
    use std::os::unix::ffi::OsStrExt;

    let bytes = raw.split(|byte| *byte == 0).next()?;
    if bytes.is_empty() {
        return None;
    }
    Some(PathBuf::from(std::ffi::OsStr::from_bytes(bytes)))
}

/// Replaces a doc-portal path with the real location it stands for, so Settings
/// can show `~/Notes` instead of `/run/user/1000/doc/A1b2C3/Notes`. Falls back to
/// the final component when the portal cannot answer, and returns any other path
/// unchanged.
pub(crate) fn display_path(root: &Path) -> String {
    if !is_portal_path(root) {
        return root.to_string_lossy().into_owned();
    }
    if let Some(host) = host_path(root) {
        return host.to_string_lossy().into_owned();
    }
    root.file_name().map_or_else(
        || root.to_string_lossy().into_owned(),
        |name| name.to_string_lossy().into_owned(),
    )
}

/// `Documents.AddFull` flags. Only tests name these — production registers nothing.
/// `CHOOSER` is what xdg-desktop-portal's file chooser asks for; `FRESH_MINT` drops
/// `reuse-existing`, the load-bearing difference
/// [`tests::re_registering_a_document_portal_path_is_refused`] pins.
#[cfg(all(test, target_os = "linux"))]
pub(crate) const ADD_FLAGS_CHOOSER: u32 = 1 | 2 | 8;
#[cfg(all(test, target_os = "linux"))]
pub(crate) const ADD_FLAGS_FRESH_MINT: u32 = 2 | 8;

/// TEST SCAFFOLDING — production registers nothing. Stands in for the file chooser
/// so tests can obtain a doc-portal path; returns the portal's error verbatim
/// because one test asserts a refusal. Shared with `system_trash`'s test.
#[cfg(all(test, target_os = "linux"))]
pub(crate) fn register_document_for_test(directory: &Path, flags: u32) -> Result<PathBuf, String> {
    use std::os::fd::AsFd;
    use std::os::unix::fs::OpenOptionsExt;

    let handle = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_PATH | libc::O_CLOEXEC | libc::O_DIRECTORY)
        .open(directory)
        .map_err(crate::background_tasks::io_error)?;
    let connection = zbus::blocking::Connection::session().map_err(|e| e.to_string())?;
    let reply = connection
        .call_method(
            Some(DOCUMENTS_NAME),
            DOCUMENTS_PATH,
            Some(DOCUMENTS_NAME),
            "AddFull",
            &(
                vec![zbus::zvariant::Fd::from(handle.as_fd())],
                flags,
                "com.futo.notes",
                vec!["read", "write", "grant-permissions"],
            ),
        )
        .map_err(|e| e.to_string())?;
    let (document_ids, _extra): (
        Vec<String>,
        std::collections::HashMap<String, zbus::zvariant::OwnedValue>,
    ) = reply.body().deserialize().map_err(|e| e.to_string())?;
    let document_id = document_ids
        .first()
        .ok_or_else(|| "document portal returned no document id".to_owned())?;
    let name = directory
        .file_name()
        .ok_or_else(|| format!("{} has no final component", directory.display()))?;
    Ok(documents_mount(unsafe { libc::getuid() })
        .join(document_id)
        .join(name))
}

/// Drops a grant registered by a test so the run leaves no residue in the user's
/// document store.
#[cfg(all(test, target_os = "linux"))]
pub(crate) fn revoke_grant_for_test(granted: &Path) {
    let Some((document_id, _)) = split_portal_path(granted) else {
        return;
    };
    if let Ok(connection) = zbus::blocking::Connection::session() {
        let _ = connection.call_method(
            Some(DOCUMENTS_NAME),
            DOCUMENTS_PATH,
            Some(DOCUMENTS_NAME),
            "Delete",
            &(document_id.as_str(),),
        );
    }
}

/// The live-portal tests need a session bus with a document portal on it.
/// Headless CI has neither, and a skipped run says so out loud instead of passing
/// quietly (AGENTS.md M11).
#[cfg(all(test, target_os = "linux"))]
pub(crate) fn documents_portal_available() -> bool {
    let Ok(connection) = zbus::blocking::Connection::session() else {
        eprintln!("SKIP document portal test: no session bus");
        return false;
    };
    let reachable = connection
        .call_method(
            Some("org.freedesktop.DBus"),
            "/org/freedesktop/DBus",
            Some("org.freedesktop.DBus"),
            "NameHasOwner",
            &DOCUMENTS_NAME,
        )
        .ok()
        .and_then(|reply| reply.body().deserialize::<bool>().ok())
        .unwrap_or(false);
    if !reachable {
        eprintln!("SKIP document portal test: {DOCUMENTS_NAME} has no owner");
    }
    reachable
}

#[cfg(test)]
mod tests {
    //! Tests for document-portal path handling and grant registration.
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn portal_paths_are_recognised_below_the_mount_only() {
        let mount = documents_mount(1000);
        assert_eq!(mount, PathBuf::from("/run/user/1000/doc"));
        assert!(is_below_mount(
            &mount,
            Path::new("/run/user/1000/doc/A1b2/Notes")
        ));
        // The mount itself is not a vault, and another user's mount is not ours.
        assert!(!is_below_mount(&mount, &mount));
        assert!(!is_below_mount(
            &mount,
            Path::new("/run/user/1001/doc/A1b2/Notes")
        ));
        assert!(!is_below_mount(
            &mount,
            Path::new("/home/u/Documents/futo-notes")
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn portal_paths_split_into_document_id_and_the_part_below_it() {
        let mount = documents_mount(1000);
        assert_eq!(
            split_portal_path_below(&mount, Path::new("/run/user/1000/doc/A1b2/Notes")),
            Some(("A1b2".to_owned(), PathBuf::new()))
        );
        assert_eq!(
            split_portal_path_below(&mount, Path::new("/run/user/1000/doc/A1b2/Notes/sub/deep")),
            Some(("A1b2".to_owned(), PathBuf::from("sub/deep")))
        );
        // A doc id with nothing under it is not a usable vault path.
        assert_eq!(
            split_portal_path_below(&mount, Path::new("/run/user/1000/doc/A1b2")),
            None
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn portal_replies_are_nul_terminated_byte_arrays() {
        assert_eq!(
            path_from_nul_terminated(b"/home/u/Notes\0"),
            Some(PathBuf::from("/home/u/Notes"))
        );
        assert_eq!(path_from_nul_terminated(b"\0"), None);
        assert_eq!(path_from_nul_terminated(b""), None);
    }

    /// An ordinary vault keeps inotify. Deliberately asserted on a temp dir rather
    /// than a hand-written path: this must stay true for whatever filesystem the
    /// runner's `TMPDIR` is on, FUSE overlay included, because polling is scoped to
    /// the portal mount alone.
    #[test]
    fn an_ordinary_directory_does_not_need_polling() {
        let root = std::env::temp_dir();
        assert!(!inotify_is_unreliable(&root));
        assert!(!is_portal_path(&root));
    }

    /// An ordinary directory is its own display name — no portal round trip.
    #[test]
    fn an_ordinary_directory_displays_as_itself() {
        let root = std::env::temp_dir();
        assert_eq!(display_path(&root), root.to_string_lossy());
    }

    /// The whole feature rests on this: a directory exported into the document
    /// portal is a FUSE mount whose inotify only sees writes made through the
    /// mount itself, so a vault living there needs the poll watcher. Exercised
    /// against the live portal because the blind spot is a property of the FUSE
    /// passthrough, which a mock would merely restate.
    #[test]
    #[cfg(target_os = "linux")]
    fn poll_is_required_for_a_document_portal_vault() {
        if !documents_portal_available() {
            return;
        }
        let real = std::env::temp_dir().join(format!(
            "futo-portal-vault-{}-{}",
            std::process::id(),
            futo_notes_core::files::now_ms()
        ));
        std::fs::create_dir_all(&real).unwrap();

        let granted = register_document_for_test(&real, ADD_FLAGS_CHOOSER).unwrap();
        assert!(
            is_portal_path(&granted),
            "expected a doc-portal path, got {}",
            granted.display()
        );
        assert!(
            inotify_is_unreliable(&granted),
            "a doc-portal vault must be watched by polling"
        );
        assert!(!inotify_is_unreliable(&real), "the real path is not FUSE");
        // `Info` resolves the grant back to the directory the user actually picked.
        assert_eq!(host_path(&granted).as_deref(), Some(real.as_path()));
        assert_eq!(display_path(&granted), real.to_string_lossy());

        revoke_grant_for_test(&granted);
        std::fs::remove_dir_all(real).unwrap();
    }

    /// The refusal is only assertable against a portal path — the same call on a
    /// real path succeeds, and a real path is the shape production never holds.
    /// With `reuse-existing` (the chooser's flags) the portal instead returns the
    /// *existing* id: the same-folder-same-id property the stored vault path and
    /// keyring account depend on, asserted here too.
    #[test]
    #[cfg(target_os = "linux")]
    fn re_registering_a_document_portal_path_is_refused() {
        if !documents_portal_available() {
            return;
        }
        let real = std::env::temp_dir().join(format!(
            "futo-portal-regrant-{}-{}",
            std::process::id(),
            futo_notes_core::files::now_ms()
        ));
        std::fs::create_dir_all(&real).unwrap();

        let granted = register_document_for_test(&real, ADD_FLAGS_CHOOSER)
            .expect("a real path registers fine");

        let error = register_document_for_test(&granted, ADD_FLAGS_FRESH_MINT).expect_err(
            "the portal minted a new document from its own mount — the \
                         Invalid-fd failure this module is shaped around may be gone",
        );
        assert!(
            error.contains("Invalid fd passed"),
            "expected the portal's fd refusal, got {error}"
        );
        assert!(
            granted.is_dir(),
            "a refused call must leave the picked vault reachable"
        );

        // Re-picking the same folder yields the same document id, so the stored vault
        // path is stable and nothing accumulates.
        assert_eq!(
            register_document_for_test(&real, ADD_FLAGS_CHOOSER).unwrap(),
            granted
        );

        revoke_grant_for_test(&granted);
        std::fs::remove_dir_all(real).unwrap();
    }
}
