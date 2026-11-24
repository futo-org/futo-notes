//! `refuse_writes_in`: a test stand-in for a read-only folder that works for
//! every uid and platform. A mode 0555 folder refuses writes for a normal user,
//! but root ignores permission bits and Windows has no bit that does, so a test
//! built on one runs on neither (the Linux CI runs as root).
//!
//! The refusal is decided before an operation runs: an armed operation never
//! reaches the platform code and changes nothing on disk. Every operand is
//! validated first, so a bad path reports its own error, not a denial. What a
//! real read-only folder lets through stays allowed: folders that exist, and a
//! no-replace move onto a name already there (the OS answers "exists" before it
//! checks permission). Lookups use the plain filesystem, never the platform's
//! directory-syncing ones, and nothing touches the filesystem while no folder
//! is refused. A folder is matched the way the platform resolves it (the same
//! directory, so `LOCKED` is `locked` on a case-insensitive volume); the tree
//! rules for recursive removal and `clear` compare spelled paths.
//!
//! Without the `test-support` feature (no shipped build has it) every entry
//! point here is a pass-through.

#[cfg(any(test, feature = "test-support"))]
pub use armed::{allow_writes_in, refuse_writes_in};

#[cfg(any(test, feature = "test-support"))]
use armed::{creates_in_refused, deny, exists, is_refused, refused_tree, validate_all};
use std::path::Path;

/// Fails `operation` before it runs when [`refuse_writes_in`] locked the folder
/// that holds any of `names`. Always `Ok` outside tests.
#[cfg(any(test, feature = "test-support"))]
pub(super) fn writable(root: &Path, operation: &str, names: &[&str]) -> Result<(), String> {
    match names.iter().find(|name| is_refused(root, name)) {
        Some(name) => Err(deny(root, operation, name, names)),
        None => Ok(()),
    }
}

/// [`writable`] for an operation that also creates the missing folders above
/// `created` (`locked/new/note.md` creates `locked/new`).
#[cfg(any(test, feature = "test-support"))]
pub(super) fn writable_creating(
    root: &Path,
    operation: &str,
    names: &[&str],
    created: &str,
) -> Result<(), String> {
    writable(root, operation, names)?;
    if creates_in_refused(root, created) {
        return Err(deny(root, operation, created, names));
    }
    Ok(())
}

/// Fails [`super::create_dir_all`] of `relative` when any folder it would
/// create lies directly inside a refused one. Folders that exist are not created.
#[cfg(any(test, feature = "test-support"))]
pub(super) fn check_dir_creation(root: &Path, relative: &str) -> Result<(), String> {
    if (is_refused(root, relative) && !exists(root, relative)) || creates_in_refused(root, relative)
    {
        return Err(deny(root, "create directory", relative, &[relative]));
    }
    Ok(())
}

/// Fails a recursive removal under `relative` (`""` for the whole vault) when
/// it would delete entries inside a refused folder.
#[cfg(any(test, feature = "test-support"))]
pub(super) fn writable_tree(root: &Path, operation: &str, relative: &str) -> Result<(), String> {
    if refused_tree(&root.join(relative)) {
        let (name, operands) = if relative.is_empty() {
            (".", vec![])
        } else {
            (relative, vec![relative])
        };
        return Err(deny(root, operation, name, &operands));
    }
    Ok(())
}

/// [`writable`] for a caller outside this module that removes `relative` with
/// its own filesystem call instead of [`super::remove`]. Always `Ok` outside tests.
#[cfg(any(test, feature = "test-support"))]
pub fn check_removable(root: &Path, relative: &str) -> Result<(), String> {
    writable(root, "remove", &[relative])
}

/// The answer a no-replace move gets from a refused folder, without running:
/// `Some(false)` when `destination` already exists (the OS says "exists" before
/// it checks permission), an error when either folder refuses, `None` to run
/// the move. `creating`: the move creates the folders above `destination`.
#[cfg(any(test, feature = "test-support"))]
pub(super) fn refuse_move(
    root: &Path,
    source: &str,
    destination: &str,
    creating: bool,
) -> Result<Option<bool>, String> {
    let operands = [source, destination];
    let refused = operands.iter().any(|name| is_refused(root, name))
        || (creating && creates_in_refused(root, destination));
    if !refused {
        return Ok(None);
    }
    validate_all(root, &operands)?;
    if exists(root, destination) {
        return Ok(Some(false));
    }
    Err(deny(root, "move", destination, &operands))
}

#[cfg(not(any(test, feature = "test-support")))]
#[inline(always)]
pub(super) fn writable(_root: &Path, _operation: &str, _names: &[&str]) -> Result<(), String> {
    Ok(())
}

#[cfg(not(any(test, feature = "test-support")))]
#[inline(always)]
pub(super) fn writable_creating(
    _root: &Path,
    _operation: &str,
    _names: &[&str],
    _created: &str,
) -> Result<(), String> {
    Ok(())
}

#[cfg(not(any(test, feature = "test-support")))]
#[inline(always)]
pub(super) fn check_dir_creation(_root: &Path, _relative: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(not(any(test, feature = "test-support")))]
#[inline(always)]
pub(super) fn writable_tree(_root: &Path, _operation: &str, _relative: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(not(any(test, feature = "test-support")))]
#[inline(always)]
pub fn check_removable(_root: &Path, _relative: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(not(any(test, feature = "test-support")))]
#[inline(always)]
pub(super) fn refuse_move(
    _root: &Path,
    _source: &str,
    _destination: &str,
    _creating: bool,
) -> Result<Option<bool>, String> {
    Ok(None)
}

#[cfg(any(test, feature = "test-support"))]
mod armed {
    use std::cell::RefCell;
    use std::path::{Path, PathBuf};

    use super::super::{context, validate_path};

    thread_local! {
        static REFUSED_FOLDERS: RefCell<Vec<PathBuf>> = const { RefCell::new(Vec::new()) };
    }

    /// Makes every create, write, remove and move directly inside `folder` (an
    /// absolute path) fail on this thread as the OS refusing it, until
    /// [`allow_writes_in`]. See the module docs for what stays allowed.
    pub fn refuse_writes_in(folder: &Path) {
        REFUSED_FOLDERS.with(|folders| folders.borrow_mut().push(folder.to_owned()));
    }

    /// Ends [`refuse_writes_in`] for `folder`.
    pub fn allow_writes_in(folder: &Path) {
        REFUSED_FOLDERS.with(|folders| folders.borrow_mut().retain(|locked| locked != folder));
    }

    /// Whether `locked` and `folder` are one directory as the platform resolves
    /// names: spelled alike, or the same file on disk.
    fn same_folder(locked: &Path, folder: &Path) -> bool {
        locked == folder
            || (folder.is_dir()
                && locked.is_dir()
                && ::same_file::is_same_file(locked, folder).unwrap_or(false))
    }

    /// Whether a refused folder directly holds `name`. `false` at once, with no
    /// filesystem access, while nothing is refused.
    pub fn is_refused(root: &Path, name: &str) -> bool {
        REFUSED_FOLDERS.with(|folders| {
            let folders = folders.borrow();
            !folders.is_empty()
                && root
                    .join(name)
                    .parent()
                    .is_some_and(|parent| folders.iter().any(|locked| same_folder(locked, parent)))
        })
    }

    /// Whether `name` is there, by a plain lookup: no directory fsync, so it
    /// cannot consume a queued sync fault. Run only on validated paths.
    pub fn exists(root: &Path, name: &str) -> bool {
        root.join(name).symlink_metadata().is_ok()
    }

    /// Whether creating `created` would first create a missing folder directly
    /// inside a refused one.
    pub fn creates_in_refused(root: &Path, created: &str) -> bool {
        Path::new(created)
            .ancestors()
            .skip(1)
            .filter_map(Path::to_str)
            .filter(|ancestor| !ancestor.is_empty())
            .any(|ancestor| is_refused(root, ancestor) && !exists(root, ancestor))
    }

    /// Whether removing everything under `directory` would delete an entry of a
    /// refused folder that is `directory` or inside it.
    pub fn refused_tree(directory: &Path) -> bool {
        REFUSED_FOLDERS.with(|folders| {
            folders.borrow().iter().any(|locked| {
                locked.starts_with(directory)
                    && std::fs::read_dir(locked).is_ok_and(|mut entries| entries.next().is_some())
            })
        })
    }

    pub fn validate_all(root: &Path, operands: &[&str]) -> Result<(), String> {
        operands
            .iter()
            .try_for_each(|operand| validate_path(root, operand))
    }

    /// Validates every operand, so a bad path reports its own error, then
    /// denies `operation` on `name` as a refusing folder does.
    pub fn deny(root: &Path, operation: &str, name: &str, operands: &[&str]) -> String {
        if let Err(invalid) = validate_all(root, operands) {
            return invalid;
        }
        context(
            operation,
            name,
            std::io::Error::from(std::io::ErrorKind::PermissionDenied),
        )
    }
}
