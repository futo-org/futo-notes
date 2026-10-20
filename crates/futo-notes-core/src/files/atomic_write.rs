use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;

#[cfg(test)]
use std::cell::Cell;
#[cfg(all(
    test,
    any(target_os = "linux", target_os = "android", target_vendor = "apple")
))]
use std::cell::RefCell;

use super::parked_backup::{hidden_path, install_temp};
use super::paths::NAME_MAX;
use super::timestamps::{file_mtime_ms, set_file_mtime_ms};

// These hooks drive the no-replace install ladder BELOW `hard_link` — the
// flagged rename and the flagless copy — which only Linux/Android/Apple have.
// Gated to the same platforms as the code they steer: `cargo test` on Windows
// could not compile this module at all until the gates matched (github#48
// added the Windows test run that surfaced it).
#[cfg(all(
    test,
    any(target_os = "linux", target_os = "android", target_vendor = "apple")
))]
thread_local! {
    static MOVE_NO_REPLACE_BEFORE_RENAME: RefCell<Option<Box<dyn FnOnce()>>> = RefCell::new(None);
    /// Simulates a filesystem that rejects `RENAME_NOREPLACE`, so the fallback
    /// below can be exercised on a host filesystem that supports the flag.
    static RENAME_FLAGS_REJECTED: Cell<bool> = const { Cell::new(false) };
}

#[cfg(test)]
thread_local! {
    static TAKE_NEXT_TEMP: Cell<bool> = const { Cell::new(false) };
}

/// Makes the next temp file vanish before it is installed, as a file-provider
/// agent can take it.
#[cfg(test)]
pub(crate) fn take_next_temp() {
    TAKE_NEXT_TEMP.with(|v| v.set(true));
}

/// Told about a failure to create the temp file; the vault uses it to learn that
/// the OS refuses writes there (`vault_fs::access_refused`). Its parent folders
/// were already made, and reported, by the vault.
type CreateFailure<'a> = &'a dyn Fn(&std::io::Error);

fn create_temp(
    parent: &Path,
    on_create_failure: CreateFailure,
) -> Result<(std::path::PathBuf, File), String> {
    for _ in 0..32 {
        let path = hidden_path(parent, "tmp");
        let refused =
            crate::files::vault_fs::refused_create(std::io::ErrorKind::PermissionDenied.into());
        match refused.and_then(|()| OpenOptions::new().write(true).create_new(true).open(&path)) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                on_create_failure(&error);
                return Err(format!("{error} (creating temp {})", path.display()));
            }
        }
    }
    Err("could not allocate an atomic-write temp file".to_owned())
}

/// Writes `bytes` to a fresh temp in `parent` and hands it to `install`. A
/// file-provider agent (iCloud Drive, Dropbox) can take a new temp before it is
/// installed (57a96b55), so a temp that vanished is written once more.
fn write_temp_and_install<T>(
    parent: &Path,
    bytes: &[u8],
    on_create_failure: CreateFailure,
    install: impl Fn(&Path) -> Result<T, String>,
) -> Result<T, String> {
    let mut retried = false;
    loop {
        let (temp, mut file) = create_temp(parent, on_create_failure)?;
        let written = file.write_all(bytes).and_then(|_| file.sync_all());
        drop(file);
        #[cfg(test)]
        if TAKE_NEXT_TEMP.with(|v| v.replace(false)) {
            let _ = fs::remove_file(&temp);
        }
        let result = written
            .map_err(|error| format!("{error} (writing temp {})", temp.display()))
            .and_then(|()| install(&temp));
        let taken = result.is_err()
            && fs::symlink_metadata(&temp)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound);
        // A created result consumed the temp; a collision or error may leave it.
        let _ = fs::remove_file(&temp);
        if !taken || retried {
            return result;
        }
        retried = true;
    }
}

pub fn write_atomic_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write_atomic_bytes_reporting(path, bytes, &|_| {})
}

pub(crate) fn write_atomic_bytes_reporting(
    path: &Path,
    bytes: &[u8],
    on_create_failure: CreateFailure,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "invalid file path".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "invalid file name".to_owned())?;
    if name.len() > NAME_MAX {
        return Err("file name exceeds filesystem name limit".to_owned());
    }

    write_temp_and_install(parent, bytes, on_create_failure, |temp| {
        install_temp(temp, path)
    })?;
    // Directory fsync makes the rename durable on platforms that support directory handles.
    let _ = File::open(parent).and_then(|directory| directory.sync_all());
    Ok(())
}

pub fn write_atomic_text(path: &Path, content: &str) -> Result<(), String> {
    write_atomic_bytes(path, content.as_bytes())
}

pub fn create_new_atomic(path: &Path, bytes: &[u8]) -> Result<bool, String> {
    create_new_atomic_reporting(path, bytes, &|_| {})
}

pub(crate) fn create_new_atomic_reporting(
    path: &Path,
    bytes: &[u8],
    on_create_failure: CreateFailure,
) -> Result<bool, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "invalid file path".to_owned())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "invalid file name".to_owned())?;
    if name.len() > NAME_MAX {
        return Err("file name exceeds filesystem name limit".to_owned());
    }

    write_temp_and_install(parent, bytes, on_create_failure, |temp| {
        move_no_replace(temp, path)
    })
}

/// Installs `source`'s content at `destination` without replacing an existing
/// file there, then removes `source`. No-replace always holds; atomicity holds
/// on every filesystem that offers a primitive for it (see below). Returns
/// `Ok(true)` when `destination` was created, `Ok(false)` when a file already
/// existed there (in which case neither path is modified). On error, best
/// effort leaves no duplicate: `destination` is never left as an extra copy of
/// a `source` that still exists.
///
/// Three installs are tried in order, each preserving no-replace but offering
/// less than the last:
///
/// 1. `hard_link` — the fast atomic install on filesystems that support it (the
///    destination cannot clobber an existing name, and the shared inode carries
///    mtime across). Android's external storage rejects `link` outright.
/// 2. An atomic no-replace rename, where the platform provides the syscall and
///    the filesystem implements its flags.
/// 3. An exclusive create plus copy, which keeps no-replace but not atomicity.
///    Android 9/10 shared storage needs it (github#13).
pub fn move_no_replace(source: &Path, destination: &Path) -> Result<bool, String> {
    #[cfg(all(
        test,
        any(target_os = "linux", target_os = "android", target_vendor = "apple")
    ))]
    if MOVE_NO_REPLACE_BEFORE_RENAME.with(|hook| hook.borrow().is_some()) {
        // Host filesystems support links; the hook simulates Android FUSE rejecting one.
        return move_no_replace_via_rename(source, destination);
    }

    match fs::hard_link(source, destination) {
        Ok(()) => drop_source_after_install(source, destination),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(_) => move_no_replace_after_link_error(source, destination),
    }
}

fn drop_source_after_install(source: &Path, destination: &Path) -> Result<bool, String> {
    match fs::remove_file(source) {
        Ok(()) => Ok(true),
        Err(error) => {
            // The destination exists but the source could not be dropped; undo the
            // install so the error path never strands a duplicate under both names.
            let _ = fs::remove_file(destination);
            Err(format!(
                "{error} (dropping {} after installing {})",
                source.display(),
                destination.display()
            ))
        }
    }
}

/// Last resort for a filesystem offering no atomic no-replace primitive at all:
/// create the destination exclusively, copy the bytes in, then drop the source.
/// `create_new` keeps the no-clobber guarantee — only atomicity is lost, so a
/// crash mid-copy can leave a short destination that the caller's own recovery
/// treats like any other interrupted write.
fn install_via_exclusive_copy(source: &Path, destination: &Path) -> Result<bool, String> {
    let bytes = fs::read(source)
        .map_err(|error| format!("{error} (reading {} for a copy install)", source.display()))?;
    // The link and rename legs carry the source's mtime across on their own. Read
    // it here so a recovered parked backup keeps its original modification time
    // instead of jumping to the top of a modified-ordered note list.
    let source_mtime = fs::metadata(source).map(|meta| file_mtime_ms(&meta)).ok();

    let mut file = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
        Err(error) => {
            return Err(format!(
                "{error} (creating {} for a copy install)",
                destination.display()
            ))
        }
    };

    let write_result = file.write_all(&bytes).and_then(|_| file.sync_all());
    drop(file);
    if let Err(error) = write_result {
        let _ = fs::remove_file(destination);
        return Err(format!("{error} (copying into {})", destination.display()));
    }
    if let Some(modified_at) = source_mtime {
        let _ = set_file_mtime_ms(destination, modified_at);
    }

    drop_source_after_install(source, destination)
}

#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
fn move_no_replace_after_link_error(source: &Path, destination: &Path) -> Result<bool, String> {
    move_no_replace_via_rename(source, destination)
}

/// Without a flagged-rename syscall the exclusive copy is the only no-replace
/// install left — reached on a filesystem that rejects links, such as a vault on
/// FAT/exFAT removable media.
#[cfg(not(any(target_os = "linux", target_os = "android", target_vendor = "apple")))]
fn move_no_replace_after_link_error(source: &Path, destination: &Path) -> Result<bool, String> {
    install_via_exclusive_copy(source, destination)
}

#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
fn rename_no_replace(source: &Path, destination: &Path) -> Result<(), rustix::io::Errno> {
    #[cfg(test)]
    if RENAME_FLAGS_REJECTED.with(Cell::get) {
        return Err(rustix::io::Errno::INVAL);
    }

    rustix::fs::renameat_with(
        rustix::fs::CWD,
        source,
        rustix::fs::CWD,
        destination,
        rustix::fs::RenameFlags::NOREPLACE,
    )
}

#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
fn move_no_replace_via_rename(source: &Path, destination: &Path) -> Result<bool, String> {
    #[cfg(test)]
    MOVE_NO_REPLACE_BEFORE_RENAME.with(|hook| {
        if let Some(before_rename) = hook.borrow_mut().take() {
            before_rename();
        }
    });

    match rename_no_replace(source, destination) {
        Ok(()) => Ok(true),
        Err(rustix::io::Errno::EXIST) => Ok(false),
        Err(error) if is_rename_flag_unsupported(error) => {
            install_via_exclusive_copy(source, destination)
        }
        Err(error) => Err(format!(
            "{error} (no-replace renaming {} -> {})",
            source.display(),
            destination.display()
        )),
    }
}

/// `RENAME_NOREPLACE` needs the filesystem to implement flagged renames, and the
/// refusal arrives as an error rather than a fallback. Android 9/10 mount shared
/// storage as sdcardfs, which implements neither that nor `link`, so the flagged
/// rename returns EINVAL — reported as a failed write, which broke every note
/// creation on those releases (github#13). A kernel predating `renameat2`
/// answers ENOSYS instead. None of these mean the destination is taken.
#[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
fn is_rename_flag_unsupported(error: rustix::io::Errno) -> bool {
    // Compared rather than matched: EOPNOTSUPP and ENOTSUP share a value on
    // Linux but differ on Apple platforms.
    error == rustix::io::Errno::INVAL
        || error == rustix::io::Errno::NOSYS
        || error == rustix::io::Errno::OPNOTSUPP
        || error == rustix::io::Errno::NOTSUP
}

pub fn rename_through_temp(source: &Path, destination: &Path) -> Result<(), String> {
    let parent = source
        .parent()
        .ok_or_else(|| "invalid source path".to_owned())?;
    if let Some(destination_parent) = destination.parent() {
        fs::create_dir_all(destination_parent).map_err(|error| error.to_string())?;
    }
    let temp = hidden_path(parent, "tmp");
    fs::rename(source, &temp).map_err(|error| {
        format!(
            "{error} (renaming {} -> temp {})",
            source.display(),
            temp.display()
        )
    })?;
    if let Err(error) = fs::rename(&temp, destination) {
        let _ = fs::rename(&temp, source);
        return Err(format!(
            "{error} (renaming temp {} -> {})",
            temp.display(),
            destination.display()
        ));
    }
    Ok(())
}

// CI runs in a container whose /tmp is a real filesystem, so fsync costs real time there;
// a fsync-sensitive test that passes locally on ~free tmpfs can fail only on CI
// (pc_4f9a9539ecfe). Reproduce that I/O profile locally with
// `TMPDIR="$PWD/.futo/tmp" cargo test --workspace` (real disk instead of tmpfs).
#[cfg(test)]
mod tests;
