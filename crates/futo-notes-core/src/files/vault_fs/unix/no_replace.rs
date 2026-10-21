//! No-replace installs: `create_new`, `move_no_replace`, and case-only renames.

use std::ffi::OsStr;
use std::fs::File;
use std::os::fd::OwnedFd;
use std::path::Path;

use rustix::fs::{openat, renameat, unlinkat, AtFlags, Mode, OFlags};

use super::writes::sync_rename_directories;
#[cfg(test)]
use super::FORCE_COPY;
use super::{
    hidden_name, open_parent, open_parent_with_policy, reject_symlink, report_local_sync,
    sync_directory, write_temp_and_install,
};
use crate::files::vault_fs::OpenParentError;

pub(in crate::files::vault_fs) fn create_new(
    root: &Path,
    relative: &str,
    bytes: &[u8],
) -> Result<bool, String> {
    let parent =
        open_parent_with_policy(root, relative, true, false).map_err(OpenParentError::message)?;
    reject_symlink(&parent, "create", relative)?;
    let result = write_temp_and_install(&parent, relative, bytes, |temp| {
        install_no_replace(&parent.directory, temp, &parent.directory, &parent.leaf)
    });
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

pub(in crate::files::vault_fs) fn move_no_replace(
    root: &Path,
    source: &str,
    destination: &str,
) -> Result<bool, String> {
    move_no_replace_with_policy(root, source, destination, false)
}

pub(in crate::files::vault_fs) fn move_no_replace_strict(
    root: &Path,
    source: &str,
    destination: &str,
) -> Result<bool, String> {
    move_no_replace_with_policy(root, source, destination, true)
}

fn move_no_replace_with_policy(
    root: &Path,
    source: &str,
    destination: &str,
    strict: bool,
) -> Result<bool, String> {
    let from = open_parent(root, source, false).map_err(OpenParentError::message)?;
    let to = open_parent_with_policy(root, destination, true, strict)
        .map_err(OpenParentError::message)?;
    reject_symlink(&from, "move source", source)?;
    reject_symlink(&to, "move destination", destination)?;
    let result = install_no_replace(&from.directory, &from.leaf, &to.directory, &to.leaf)?;
    if result {
        let sync = sync_rename_directories(from.directory, to.directory, source, destination);
        if strict {
            sync?;
        } else {
            report_local_sync(sync);
        }
    }
    Ok(result)
}

pub(in crate::files::vault_fs) fn rename_case(
    root: &Path,
    source: &str,
    destination: &str,
) -> Result<(), String> {
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
