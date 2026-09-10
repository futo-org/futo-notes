#[cfg(any(test, feature = "test-support"))]
use std::cell::Cell;
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::OwnedFd;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use rustix::fs::{
    fsync, futimens, mkdirat, open, openat, renameat, statat, unlinkat, AtFlags, FileType, Mode,
    OFlags, Timespec, Timestamps, UTIME_OMIT,
};

use super::relative_components;

struct Parent {
    directory: OwnedFd,
    leaf: OsString,
}

enum OpenParentError {
    NotFound(String),
    Other(String),
}

impl OpenParentError {
    fn message(self) -> String {
        match self {
            Self::NotFound(message) | Self::Other(message) => message,
        }
    }
}

#[cfg(any(test, feature = "test-support"))]
thread_local! {
    static FAIL_DIRECTORY_SYNC_ON_CALL: Cell<Option<usize>> = const { Cell::new(None) };
}

#[cfg(test)]
thread_local! {
    static FORCE_COPY: Cell<bool> = const { Cell::new(false) };
    static FORCE_BACKUP: Cell<bool> = const { Cell::new(false) };
    static INTERRUPT_AFTER_PARK: Cell<bool> = const { Cell::new(false) };
}
#[cfg(test)]
pub(super) fn force_copy() {
    FORCE_COPY.with(|v| v.set(true));
}
#[cfg(test)]
pub(super) fn force_backup(interrupt: bool) {
    FORCE_BACKUP.with(|v| v.set(true));
    INTERRUPT_AFTER_PARK.with(|v| v.set(interrupt));
}

fn context(operation: &str, relative: &str, error: impl std::fmt::Display) -> String {
    format!("{operation} vault path {relative}: {error}")
}

fn sync_directory(directory: &OwnedFd, operation: &str, relative: &str) -> Result<(), String> {
    #[cfg(any(test, feature = "test-support"))]
    FAIL_DIRECTORY_SYNC_ON_CALL.with(|failure| {
        if let Some(call) = failure.get() {
            if call == 1 {
                failure.set(None);
                return Err(context(
                    operation,
                    relative,
                    std::io::Error::other("injected directory sync failure"),
                ));
            }
            failure.set(Some(call - 1));
        }
        Ok(())
    })?;

    fsync(directory).map_err(|error| context(operation, relative, error))
}

#[cfg(any(test, feature = "test-support"))]
pub(super) fn fail_directory_sync_on_call(call: usize) {
    assert!(call > 0);
    FAIL_DIRECTORY_SYNC_ON_CALL.with(|failure| failure.set(Some(call)));
}

fn open_root(root: &Path) -> Result<OwnedFd, OpenParentError> {
    match open(
        root,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(directory) => Ok(directory),
        Err(rustix::io::Errno::NOENT) => Err(OpenParentError::NotFound(format!(
            "open vault root {}: no such file or directory",
            root.display()
        ))),
        Err(error) => Err(OpenParentError::Other(format!(
            "open vault root {}: {error}",
            root.display()
        ))),
    }
}

fn open_directory(parent: &OwnedFd, name: &OsStr) -> rustix::io::Result<OwnedFd> {
    openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
}

fn open_parent(root: &Path, relative: &str, create: bool) -> Result<Parent, OpenParentError> {
    open_parent_with_policy(root, relative, create, true)
}

fn open_parent_with_policy(
    root: &Path,
    relative: &str,
    create: bool,
    strict: bool,
) -> Result<Parent, OpenParentError> {
    let components = relative_components(relative).map_err(OpenParentError::Other)?;
    let (leaf, parents) = components
        .split_last()
        .expect("relative_components rejects empty paths");
    let mut directory = open_root(root)?;
    for component in parents {
        let next = match open_directory(&directory, component) {
            Ok(next) => next,
            Err(rustix::io::Errno::NOENT) if create => {
                match mkdirat(
                    &directory,
                    *component,
                    Mode::RUSR
                        | Mode::WUSR
                        | Mode::XUSR
                        | Mode::RGRP
                        | Mode::XGRP
                        | Mode::ROTH
                        | Mode::XOTH,
                ) {
                    Ok(()) | Err(rustix::io::Errno::EXIST) => {}
                    Err(error) => {
                        return Err(OpenParentError::Other(context(
                            "create parent for",
                            relative,
                            error,
                        )));
                    }
                }
                open_directory(&directory, component).map_err(|error| {
                    OpenParentError::Other(context("open created parent for", relative, error))
                })?
            }
            Err(rustix::io::Errno::NOENT) => {
                return Err(OpenParentError::NotFound(context(
                    "open parent for",
                    relative,
                    rustix::io::Errno::NOENT,
                )));
            }
            Err(error) => {
                return Err(OpenParentError::Other(context(
                    "open parent for",
                    relative,
                    error,
                )));
            }
        };
        if create {
            let result = sync_directory(
                &directory,
                "sync parent directory before mutation",
                relative,
            );
            if strict {
                result.map_err(OpenParentError::Other)?;
            } else {
                report_local_sync(result);
            }
        }
        directory = next;
    }
    Ok(Parent {
        directory,
        leaf: (*leaf).to_owned(),
    })
}

fn is_symlink(parent: &Parent) -> Result<bool, String> {
    match statat(&parent.directory, &parent.leaf, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(metadata) => Ok(FileType::from_raw_mode(metadata.st_mode) == FileType::Symlink),
        Err(rustix::io::Errno::NOENT) => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn reject_symlink(parent: &Parent, operation: &str, relative: &str) -> Result<(), String> {
    if is_symlink(parent).map_err(|error| context(operation, relative, error))? {
        return Err(format!(
            "{operation} vault path {relative}: symlink rejected"
        ));
    }
    Ok(())
}

fn hidden_name(kind: &str) -> OsString {
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    format!(
        ".sf-{kind}-{}-{}",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
    .into()
}

fn create_temp(parent: &Parent, relative: &str) -> Result<(OsString, File), String> {
    for _ in 0..32 {
        let name = hidden_name("tmp");
        match openat(
            &parent.directory,
            &name,
            OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::RUSR | Mode::WUSR | Mode::RGRP | Mode::WGRP | Mode::ROTH | Mode::WOTH,
        ) {
            Ok(file) => return Ok((name, File::from(file))),
            Err(rustix::io::Errno::EXIST) => continue,
            Err(error) => return Err(context("create temporary file for", relative, error)),
        }
    }
    Err(format!(
        "create temporary file for vault path {relative}: name allocation exhausted"
    ))
}

fn install_temp(parent: &Parent, temp: &OsStr, relative: &str, strict: bool) -> Result<(), String> {
    let install = || renameat(&parent.directory, temp, &parent.directory, &parent.leaf);
    #[cfg(test)]
    let install = || {
        if FORCE_BACKUP.with(|v| v.replace(false)) {
            Err(rustix::io::Errno::EXIST)
        } else {
            install()
        }
    };
    match install() {
        Ok(()) => Ok(()),
        Err(rustix::io::Errno::EXIST) => {
            let backup = hidden_name("bak");
            let mut sidecar = backup.clone();
            sidecar.push(".path");
            let sidecar_fd = openat(
                &parent.directory,
                &sidecar,
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::from_raw_mode(0o600),
            )
            .map_err(|e| e.to_string())?;
            let mut sidecar_file = File::from(sidecar_fd);
            use std::os::unix::ffi::OsStrExt;
            sidecar_file
                .write_all(parent.leaf.as_os_str().as_bytes())
                .and_then(|_| sidecar_file.sync_all())
                .map_err(|e| e.to_string())?;
            let result = sync_directory(&parent.directory, "sync backup sidecar", relative);
            if strict {
                result?;
            } else {
                report_local_sync(result);
            }
            renameat(&parent.directory, &parent.leaf, &parent.directory, &backup)
                .map_err(|error| context("park existing destination for", relative, error))?;
            #[cfg(test)]
            if INTERRUPT_AFTER_PARK.with(|v| v.replace(false)) {
                return Err("injected interruption after parking backup".into());
            }
            if let Err(error) = renameat(&parent.directory, temp, &parent.directory, &parent.leaf) {
                let _ = renameat(&parent.directory, &backup, &parent.directory, &parent.leaf);
                return Err(context("install temporary file for", relative, error));
            }
            unlinkat(&parent.directory, &backup, AtFlags::empty())
                .map_err(|error| context("remove parked backup after writing", relative, error))?;
            let _ = unlinkat(&parent.directory, &sidecar, AtFlags::empty());
            Ok(())
        }
        Err(error) => Err(context("install temporary file for", relative, error)),
    }
}

pub(super) fn read(root: &Path, relative: &str) -> Result<Vec<u8>, String> {
    let parent = open_parent(root, relative, false).map_err(OpenParentError::message)?;
    let file = openat(
        &parent.directory,
        &parent.leaf,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|error| context("read", relative, error))?;
    let mut bytes = Vec::new();
    File::from(file)
        .read_to_end(&mut bytes)
        .map_err(|error| context("read", relative, error))?;
    Ok(bytes)
}

pub(super) fn read_optional(root: &Path, relative: &str) -> Result<Option<Vec<u8>>, String> {
    let parent = match open_parent(root, relative, false) {
        Ok(parent) => parent,
        Err(OpenParentError::NotFound(_)) => return Ok(None),
        Err(error) => return Err(error.message()),
    };
    let file = match openat(
        &parent.directory,
        &parent.leaf,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    ) {
        Ok(file) => file,
        Err(rustix::io::Errno::NOENT) => return Ok(None),
        Err(error) => return Err(context("read", relative, error)),
    };
    let mut bytes = Vec::new();
    File::from(file)
        .read_to_end(&mut bytes)
        .map_err(|error| context("read", relative, error))?;
    Ok(Some(bytes))
}

// Local operations report the committed filesystem effect even when directory
// fsync is unsupported. File bytes are still fsynced before install. Sync's
// journal-facing operations retain strict directory durability and retry rules.
fn report_local_sync(result: Result<(), String>) {
    if let Err(error) = result {
        eprintln!("local vault directory durability: {error}");
    }
}

pub(super) fn create_new(root: &Path, relative: &str, bytes: &[u8]) -> Result<bool, String> {
    let parent =
        open_parent_with_policy(root, relative, true, false).map_err(OpenParentError::message)?;
    reject_symlink(&parent, "create", relative)?;
    let (temp, mut file) = create_temp(&parent, relative)?;
    let result = (|| {
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        install_no_replace(&parent.directory, &temp, &parent.directory, &parent.leaf)
    })();
    let _ = unlinkat(&parent.directory, &temp, AtFlags::empty());
    if matches!(result, Ok(true)) {
        report_local_sync(sync_directory(&parent.directory, "sync create", relative));
    }
    result
}

fn install_no_replace(
    source_dir: &OwnedFd,
    source: &OsStr,
    destination_dir: &OwnedFd,
    destination: &OsStr,
) -> Result<bool, String> {
    let link = || {
        rustix::fs::linkat(
            source_dir,
            source,
            destination_dir,
            destination,
            AtFlags::empty(),
        )
    };
    #[cfg(test)]
    let link = || {
        if FORCE_COPY.with(|v| v.get()) {
            Err(rustix::io::Errno::OPNOTSUPP)
        } else {
            link()
        }
    };
    match link() {
        Ok(()) => {}
        Err(rustix::io::Errno::EXIST) => return Ok(false),
        Err(_) => {
            #[cfg(any(target_os = "linux", target_os = "android", target_vendor = "apple"))]
            {
                let rename = || {
                    rustix::fs::renameat_with(
                        source_dir,
                        source,
                        destination_dir,
                        destination,
                        rustix::fs::RenameFlags::NOREPLACE,
                    )
                };
                #[cfg(test)]
                let rename = || {
                    if FORCE_COPY.with(|v| v.replace(false)) {
                        Err(rustix::io::Errno::OPNOTSUPP)
                    } else {
                        rename()
                    }
                };
                match rename() {
                    Ok(()) => return Ok(true),
                    Err(rustix::io::Errno::EXIST) => return Ok(false),
                    Err(e)
                        if e == rustix::io::Errno::INVAL
                            || e == rustix::io::Errno::NOSYS
                            || e == rustix::io::Errno::OPNOTSUPP
                            || e == rustix::io::Errno::NOTSUP => {}
                    Err(e) => return Err(e.to_string()),
                }
            }
            // Android sdcardfs has neither links nor flagged rename. Keep
            // its exclusive-copy fallback, with both files opened no-follow.
            let mut input = File::from(
                openat(
                    source_dir,
                    source,
                    OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .map_err(|e| e.to_string())?,
            );
            let output = match openat(
                destination_dir,
                destination,
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::from_raw_mode(0o666),
            ) {
                Ok(file) => file,
                Err(rustix::io::Errno::EXIST) => return Ok(false),
                Err(e) => return Err(e.to_string()),
            };
            let mut output = File::from(output);
            let result = std::io::copy(&mut input, &mut output).and_then(|_| output.sync_all());
            if let Err(e) = result {
                let _ = unlinkat(destination_dir, destination, AtFlags::empty());
                return Err(e.to_string());
            }
            if let Ok(meta) = input.metadata() {
                let modified = filetime::FileTime::from_last_modification_time(&meta);
                let _ = filetime::set_file_handle_times(&output, None, Some(modified));
            }
        }
    }
    if let Err(e) = unlinkat(source_dir, source, AtFlags::empty()) {
        let _ = unlinkat(destination_dir, destination, AtFlags::empty());
        return Err(e.to_string());
    }
    Ok(true)
}

pub(super) fn move_no_replace(
    root: &Path,
    source: &str,
    destination: &str,
) -> Result<bool, String> {
    let from = open_parent(root, source, false).map_err(OpenParentError::message)?;
    let to = open_parent_with_policy(root, destination, true, false)
        .map_err(OpenParentError::message)?;
    reject_symlink(&from, "move source", source)?;
    reject_symlink(&to, "move destination", destination)?;
    let result = install_no_replace(&from.directory, &from.leaf, &to.directory, &to.leaf)?;
    if result {
        report_local_sync(sync_rename_directories(
            from.directory,
            to.directory,
            source,
            destination,
        ));
    }
    Ok(result)
}

pub(super) fn rename_case(root: &Path, source: &str, destination: &str) -> Result<(), String> {
    let from = open_parent(root, source, false).map_err(OpenParentError::message)?;
    let to = open_parent_with_policy(root, destination, true, false)
        .map_err(OpenParentError::message)?;
    reject_symlink(&from, "rename source", source)?;
    reject_symlink(&to, "rename destination", destination)?;
    let temp = hidden_name("tmp");
    renameat(&from.directory, &from.leaf, &from.directory, &temp).map_err(|e| e.to_string())?;
    if let Err(e) = renameat(&from.directory, &temp, &to.directory, &to.leaf) {
        let _ = renameat(&from.directory, &temp, &from.directory, &from.leaf);
        return Err(e.to_string());
    }
    report_local_sync(sync_rename_directories(
        from.directory,
        to.directory,
        source,
        destination,
    ));
    Ok(())
}

pub(super) fn create_dir_all(root: &Path, relative: &str) -> Result<(), String> {
    let parent = open_parent_with_policy(root, &format!("{relative}/.unused"), true, false)
        .map_err(OpenParentError::message)?;
    report_local_sync(sync_directory(
        &parent.directory,
        "sync created directory",
        relative,
    ));
    Ok(())
}

pub(super) fn write_atomic(root: &Path, relative: &str, bytes: &[u8]) -> Result<(), String> {
    write_with_policy(root, relative, bytes, true)
}
pub(super) fn write_atomic_local(root: &Path, relative: &str, bytes: &[u8]) -> Result<(), String> {
    write_with_policy(root, relative, bytes, false)
}
fn write_with_policy(
    root: &Path,
    relative: &str,
    bytes: &[u8],
    strict: bool,
) -> Result<(), String> {
    let parent =
        open_parent_with_policy(root, relative, true, strict).map_err(OpenParentError::message)?;
    reject_symlink(&parent, "write", relative)?;
    let (temp, mut file) = create_temp(&parent, relative)?;
    let write_result = file
        .write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| context("write temporary file for", relative, error));
    drop(file);
    if let Err(error) = write_result {
        let _ = unlinkat(&parent.directory, &temp, AtFlags::empty());
        return Err(error);
    }
    let result = install_temp(&parent, &temp, relative, strict);
    let _ = unlinkat(&parent.directory, &temp, AtFlags::empty());
    result?;
    let result = sync_directory(&parent.directory, "sync directory after write", relative);
    if strict {
        result
    } else {
        report_local_sync(result);
        Ok(())
    }
}

pub(super) fn remove(root: &Path, relative: &str) -> Result<bool, String> {
    remove_with_policy(root, relative, true)
}
pub(super) fn remove_local(root: &Path, relative: &str) -> Result<bool, String> {
    remove_with_policy(root, relative, false)
}
fn remove_with_policy(root: &Path, relative: &str, strict: bool) -> Result<bool, String> {
    let parent = match open_parent(root, relative, false) {
        Ok(parent) => parent,
        Err(OpenParentError::NotFound(_)) => return Ok(false),
        Err(error) => return Err(error.message()),
    };
    reject_symlink(&parent, "remove", relative)?;
    match unlinkat(&parent.directory, &parent.leaf, AtFlags::empty()) {
        Ok(()) => {
            let result = sync_directory(&parent.directory, "sync directory after remove", relative);
            if strict {
                result?;
            } else {
                report_local_sync(result);
            }
            Ok(true)
        }
        Err(rustix::io::Errno::NOENT) => {
            let result = sync_directory(&parent.directory, "sync directory after remove", relative);
            if strict {
                result?;
            } else {
                report_local_sync(result);
            }
            Ok(false)
        }
        Err(error) => Err(context("remove", relative, error)),
    }
}

fn sync_rename_directories(
    source_directory: OwnedFd,
    destination_directory: OwnedFd,
    source: &str,
    destination: &str,
) -> Result<(), String> {
    let source_sync = sync_directory(
        &source_directory,
        "sync source directory after rename",
        source,
    );
    let destination_sync = sync_directory(
        &destination_directory,
        "sync destination directory after rename",
        destination,
    );
    source_sync?;
    destination_sync
}

pub(super) fn rename(root: &Path, source: &str, destination: &str) -> Result<bool, String> {
    rename_with_policy(root, source, destination, true)
}
pub(super) fn rename_local(root: &Path, source: &str, destination: &str) -> Result<bool, String> {
    rename_with_policy(root, source, destination, false)
}
fn rename_with_policy(
    root: &Path,
    source: &str,
    destination: &str,
    strict: bool,
) -> Result<bool, String> {
    let source_parent = match open_parent(root, source, false) {
        Ok(parent) => parent,
        Err(OpenParentError::NotFound(_)) => return Ok(false),
        Err(error) => return Err(error.message()),
    };
    reject_symlink(&source_parent, "rename source", source)?;
    let destination_parent = open_parent_with_policy(root, destination, true, strict)
        .map_err(OpenParentError::message)?;
    reject_symlink(&destination_parent, "rename destination", destination)?;
    match renameat(
        &source_parent.directory,
        &source_parent.leaf,
        &destination_parent.directory,
        &destination_parent.leaf,
    ) {
        Ok(()) => {}
        Err(rustix::io::Errno::NOENT) => {
            let destination_exists = match statat(
                &destination_parent.directory,
                &destination_parent.leaf,
                AtFlags::SYMLINK_NOFOLLOW,
            ) {
                Ok(_) => true,
                Err(rustix::io::Errno::NOENT) => false,
                Err(error) => {
                    return Err(context("inspect rename destination", destination, error));
                }
            };
            let result = sync_rename_directories(
                source_parent.directory,
                destination_parent.directory,
                source,
                destination,
            );
            if strict {
                result?;
            } else {
                report_local_sync(result);
            }
            return Ok(destination_exists);
        }
        Err(error) => {
            return Err(format!(
                "rename vault path {source} to {destination}: {error}"
            ));
        }
    }
    let result = sync_rename_directories(
        source_parent.directory,
        destination_parent.directory,
        source,
        destination,
    );
    if strict {
        result?;
    } else {
        report_local_sync(result);
    }
    Ok(true)
}

pub(super) fn exists(root: &Path, relative: &str) -> Result<bool, String> {
    let parent = match open_parent(root, relative, false) {
        Ok(parent) => parent,
        Err(OpenParentError::NotFound(_)) => return Ok(false),
        Err(error) => return Err(error.message()),
    };
    reject_symlink(&parent, "inspect", relative)?;
    match statat(&parent.directory, &parent.leaf, AtFlags::SYMLINK_NOFOLLOW) {
        Ok(_) => Ok(true),
        Err(rustix::io::Errno::NOENT) => {
            sync_directory(
                &parent.directory,
                "sync directory before trusting absent path",
                relative,
            )?;
            Ok(false)
        }
        Err(error) => Err(context("inspect", relative, error)),
    }
}

pub(super) fn set_mtime_ms(root: &Path, relative: &str, modified_at_ms: i64) -> Result<(), String> {
    let parent = open_parent(root, relative, false).map_err(OpenParentError::message)?;
    let file = openat(
        &parent.directory,
        &parent.leaf,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map_err(|error| context("open for timestamp update", relative, error))?;
    let milliseconds = modified_at_ms.max(0);
    futimens(
        &file,
        &Timestamps {
            last_access: Timespec {
                tv_sec: 0,
                tv_nsec: UTIME_OMIT,
            },
            last_modification: Timespec {
                tv_sec: milliseconds / 1000,
                tv_nsec: ((milliseconds % 1000) * 1_000_000) as _,
            },
        },
    )
    .map_err(|error| context("update timestamp for", relative, error))
}

pub(super) fn sync_parent(root: &Path, relative: &str) -> Result<(), String> {
    let parent = open_parent(root, relative, false).map_err(OpenParentError::message)?;
    sync_directory(
        &parent.directory,
        "sync directory before adopting existing content",
        relative,
    )
}

pub(super) fn create_dir(root: &Path, relative: &str) -> Result<(), String> {
    let parent = open_parent(root, relative, false).map_err(OpenParentError::message)?;
    mkdirat(&parent.directory, &parent.leaf, Mode::from_raw_mode(0o755))
        .map_err(|e| context("create directory", relative, e))?;
    report_local_sync(sync_directory(
        &parent.directory,
        "sync created directory",
        relative,
    ));
    Ok(())
}

pub(super) fn remove_dir(root: &Path, relative: &str, recursive: bool) -> Result<(), String> {
    let parent = open_parent(root, relative, false).map_err(OpenParentError::message)?;
    if recursive {
        let directory = open_directory(&parent.directory, &parent.leaf)
            .map_err(|e| context("open directory for removal", relative, e))?;
        empty_directory(&directory)?;
    }
    unlinkat(&parent.directory, &parent.leaf, AtFlags::REMOVEDIR)
        .map_err(|e| context("remove directory", relative, e))?;
    report_local_sync(sync_directory(
        &parent.directory,
        "sync removed directory",
        relative,
    ));
    Ok(())
}

fn empty_directory(directory: &OwnedFd) -> Result<(), String> {
    let entries = rustix::fs::Dir::read_from(directory).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        if name.to_bytes() == b"." || name.to_bytes() == b".." {
            continue;
        }
        // Re-open directories no-follow; a raced link is never traversed.
        let metadata =
            statat(directory, name, AtFlags::SYMLINK_NOFOLLOW).map_err(|e| e.to_string())?;
        if FileType::from_raw_mode(metadata.st_mode) == FileType::Directory {
            use std::os::unix::ffi::OsStrExt;
            let child = open_directory(directory, OsStr::from_bytes(name.to_bytes()))
                .map_err(|e| e.to_string())?;
            empty_directory(&child)?;
            unlinkat(directory, name, AtFlags::REMOVEDIR).map_err(|e| e.to_string())?;
        } else {
            unlinkat(directory, name, AtFlags::empty()).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub(super) fn clear(root: &Path) -> Result<(), String> {
    let directory = open_root(root).map_err(OpenParentError::message)?;
    empty_directory(&directory)?;
    report_local_sync(sync_directory(&directory, "sync cleared vault", "."));
    Ok(())
}
