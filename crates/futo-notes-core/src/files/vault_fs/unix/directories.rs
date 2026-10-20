//! Existence, mtimes, parent fsync, and directory create, remove, and clear.

use std::ffi::OsStr;
use std::os::fd::OwnedFd;
use std::path::Path;

use rustix::fs::{
    futimens, mkdirat, openat, statat, unlinkat, AtFlags, FileType, Mode, OFlags, Timespec,
    Timestamps, UTIME_OMIT,
};

use super::{
    open_directory, open_parent, open_root, reject_symlink, report_local_sync, sync_directory,
};
use crate::files::vault_fs::{
    context, in_root, note_create_failure, refused_create, OpenParentError,
};

pub(in crate::files::vault_fs) fn exists(root: &Path, relative: &str) -> Result<bool, String> {
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

pub(in crate::files::vault_fs) fn set_mtime_ms(
    root: &Path,
    relative: &str,
    modified_at_ms: i64,
) -> Result<(), String> {
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

pub(in crate::files::vault_fs) fn sync_parent(root: &Path, relative: &str) -> Result<(), String> {
    let parent = open_parent(root, relative, false).map_err(OpenParentError::message)?;
    sync_directory(
        &parent.directory,
        "sync directory before adopting existing content",
        relative,
    )
}

pub(in crate::files::vault_fs) fn create_dir(root: &Path, relative: &str) -> Result<(), String> {
    let parent = open_parent(root, relative, false).map_err(OpenParentError::message)?;
    refused_create(rustix::io::Errno::ACCESS)
        .and_then(|()| mkdirat(&parent.directory, &parent.leaf, Mode::from_raw_mode(0o755)))
        .map_err(|e| {
            note_create_failure(&e.into(), in_root(relative));
            context("create directory", relative, e)
        })?;
    report_local_sync(sync_directory(
        &parent.directory,
        "sync created directory",
        relative,
    ));
    Ok(())
}

pub(in crate::files::vault_fs) fn remove_dir(
    root: &Path,
    relative: &str,
    recursive: bool,
) -> Result<(), String> {
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

pub(in crate::files::vault_fs) fn clear(root: &Path) -> Result<(), String> {
    let directory = open_root(root).map_err(OpenParentError::message)?;
    empty_directory(&directory)?;
    report_local_sync(sync_directory(&directory, "sync cleared vault", "."));
    Ok(())
}
