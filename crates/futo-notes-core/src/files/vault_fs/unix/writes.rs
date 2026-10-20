//! Replacing operations: atomic writes, removes, and renames, local and strict.

use std::os::fd::OwnedFd;
use std::path::Path;

use rustix::fs::{renameat, statat, unlinkat, AtFlags};

use super::{
    install_temp, open_parent, open_parent_with_policy, reject_symlink, report_local_sync,
    sync_directory, write_temp_and_install,
};
use crate::files::vault_fs::{context, OpenParentError};

pub(in crate::files::vault_fs) fn create_dir_all(
    root: &Path,
    relative: &str,
) -> Result<(), String> {
    let parent = open_parent_with_policy(root, &format!("{relative}/.unused"), true, false)
        .map_err(OpenParentError::message)?;
    report_local_sync(sync_directory(
        &parent.directory,
        "sync created directory",
        relative,
    ));
    Ok(())
}

pub(in crate::files::vault_fs) fn write_atomic(
    root: &Path,
    relative: &str,
    bytes: &[u8],
) -> Result<(), String> {
    write_with_policy(root, relative, bytes, true)
}
pub(in crate::files::vault_fs) fn write_atomic_local(
    root: &Path,
    relative: &str,
    bytes: &[u8],
) -> Result<(), String> {
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
    write_temp_and_install(&parent, relative, bytes, |temp| {
        install_temp(&parent, temp, relative, strict)
    })?;
    let result = sync_directory(&parent.directory, "sync directory after write", relative);
    if strict {
        result
    } else {
        report_local_sync(result);
        Ok(())
    }
}

pub(in crate::files::vault_fs) fn remove(root: &Path, relative: &str) -> Result<bool, String> {
    remove_with_policy(root, relative, true)
}
pub(in crate::files::vault_fs) fn remove_local(
    root: &Path,
    relative: &str,
) -> Result<bool, String> {
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

pub(super) fn sync_rename_directories(
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

pub(in crate::files::vault_fs) fn rename(
    root: &Path,
    source: &str,
    destination: &str,
) -> Result<bool, String> {
    rename_with_policy(root, source, destination, true)
}
pub(in crate::files::vault_fs) fn rename_local(
    root: &Path,
    source: &str,
    destination: &str,
) -> Result<bool, String> {
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
