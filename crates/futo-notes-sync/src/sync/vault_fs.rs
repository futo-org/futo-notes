use std::path::{Component, Path};

fn relative_components(relative: &str) -> Result<Vec<&std::ffi::OsStr>, String> {
    let components = Path::new(relative)
        .components()
        .map(|component| match component {
            Component::Normal(component) => Ok(component),
            _ => Err(format!("unsafe vault-relative path: {relative}")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    if components.is_empty() {
        return Err("empty vault-relative path".to_owned());
    }
    Ok(components)
}

#[cfg(unix)]
mod platform {
    use std::ffi::{OsStr, OsString};
    use std::fs::File;
    use std::io::{Read, Write};
    use std::os::fd::OwnedFd;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};

    use rustix::fs::{
        futimens, mkdirat, open, openat, renameat, statat, unlinkat, AtFlags, FileType, Mode,
        OFlags, Timespec, Timestamps, UTIME_OMIT,
    };

    use super::relative_components;

    struct Parent {
        directory: OwnedFd,
        leaf: OsString,
    }

    fn context(operation: &str, relative: &str, error: impl std::fmt::Display) -> String {
        format!("{operation} vault path {relative}: {error}")
    }

    fn open_root(root: &Path) -> Result<OwnedFd, String> {
        open(
            root,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|error| format!("open vault root {}: {error}", root.display()))
    }

    fn open_directory(parent: &OwnedFd, name: &OsStr) -> rustix::io::Result<OwnedFd> {
        openat(
            parent,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
    }

    fn open_parent(root: &Path, relative: &str, create: bool) -> Result<Parent, String> {
        let components = relative_components(relative)?;
        let (leaf, parents) = components
            .split_last()
            .expect("relative_components rejects empty paths");
        let mut directory = open_root(root)?;
        for component in parents {
            directory = match open_directory(&directory, component) {
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
                            return Err(context("create parent for", relative, error));
                        }
                    }
                    open_directory(&directory, component)
                        .map_err(|error| context("open created parent for", relative, error))?
                }
                Err(error) => return Err(context("open parent for", relative, error)),
            };
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

    fn install_temp(parent: &Parent, temp: &OsStr, relative: &str) -> Result<(), String> {
        match renameat(&parent.directory, temp, &parent.directory, &parent.leaf) {
            Ok(()) => Ok(()),
            Err(rustix::io::Errno::EXIST) => {
                let backup = hidden_name("bak");
                renameat(&parent.directory, &parent.leaf, &parent.directory, &backup)
                    .map_err(|error| context("park existing destination for", relative, error))?;
                if let Err(error) =
                    renameat(&parent.directory, temp, &parent.directory, &parent.leaf)
                {
                    let _ = renameat(&parent.directory, &backup, &parent.directory, &parent.leaf);
                    return Err(context("install temporary file for", relative, error));
                }
                let _ = unlinkat(&parent.directory, &backup, AtFlags::empty());
                Ok(())
            }
            Err(error) => Err(context("install temporary file for", relative, error)),
        }
    }

    pub(super) fn read(root: &Path, relative: &str) -> Result<Vec<u8>, String> {
        let parent = open_parent(root, relative, false)?;
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

    pub(super) fn write_atomic(root: &Path, relative: &str, bytes: &[u8]) -> Result<(), String> {
        let parent = open_parent(root, relative, true)?;
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
        let result = install_temp(&parent, &temp, relative);
        let _ = unlinkat(&parent.directory, &temp, AtFlags::empty());
        if result.is_ok() {
            let _ = File::from(parent.directory).sync_all();
        }
        result
    }

    pub(super) fn remove(root: &Path, relative: &str) -> Result<bool, String> {
        let parent = match open_parent(root, relative, false) {
            Ok(parent) => parent,
            Err(error) if error.contains("No such file or directory") => return Ok(false),
            Err(error) => return Err(error),
        };
        reject_symlink(&parent, "remove", relative)?;
        match unlinkat(&parent.directory, &parent.leaf, AtFlags::empty()) {
            Ok(()) => {
                let _ = File::from(parent.directory).sync_all();
                Ok(true)
            }
            Err(rustix::io::Errno::NOENT) => Ok(false),
            Err(error) => Err(context("remove", relative, error)),
        }
    }

    pub(super) fn rename(root: &Path, source: &str, destination: &str) -> Result<bool, String> {
        let source_parent = match open_parent(root, source, false) {
            Ok(parent) => parent,
            Err(error) if error.contains("No such file or directory") => return Ok(false),
            Err(error) => return Err(error),
        };
        reject_symlink(&source_parent, "rename source", source)?;
        let destination_parent = open_parent(root, destination, true)?;
        reject_symlink(&destination_parent, "rename destination", destination)?;
        match renameat(
            &source_parent.directory,
            &source_parent.leaf,
            &destination_parent.directory,
            &destination_parent.leaf,
        ) {
            Ok(()) => {}
            Err(rustix::io::Errno::NOENT) => return Ok(false),
            Err(error) => {
                return Err(format!(
                    "rename vault path {source} to {destination}: {error}"
                ));
            }
        }
        let _ = File::from(source_parent.directory).sync_all();
        let _ = File::from(destination_parent.directory).sync_all();
        Ok(true)
    }

    pub(super) fn exists(root: &Path, relative: &str) -> Result<bool, String> {
        let parent = match open_parent(root, relative, false) {
            Ok(parent) => parent,
            Err(error) if error.contains("No such file or directory") => return Ok(false),
            Err(error) => return Err(error),
        };
        reject_symlink(&parent, "inspect", relative)?;
        match statat(&parent.directory, &parent.leaf, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(_) => Ok(true),
            Err(rustix::io::Errno::NOENT) => Ok(false),
            Err(error) => Err(context("inspect", relative, error)),
        }
    }

    pub(super) fn set_mtime_ms(
        root: &Path,
        relative: &str,
        modified_at_ms: i64,
    ) -> Result<(), String> {
        let parent = open_parent(root, relative, false)?;
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
}

#[cfg(not(unix))]
mod platform {
    use std::path::{Path, PathBuf};

    use super::relative_components;

    fn checked_path(root: &Path, relative: &str, create: bool) -> Result<PathBuf, String> {
        let components = relative_components(relative)?;
        if std::fs::symlink_metadata(root)
            .map_err(|error| error.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("vault root symlink rejected".to_owned());
        }
        let mut path = root.to_owned();
        for component in &components[..components.len() - 1] {
            path.push(component);
            match std::fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err(format!("vault parent symlink rejected: {}", path.display()));
                }
                Ok(metadata) if !metadata.is_dir() => {
                    return Err(format!(
                        "vault parent is not a directory: {}",
                        path.display()
                    ));
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound && create => {
                    std::fs::create_dir(&path).map_err(|error| error.to_string())?;
                }
                Err(error) => return Err(error.to_string()),
            }
        }
        path.push(components.last().expect("validated non-empty path"));
        if std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(format!("vault file symlink rejected: {}", path.display()));
        }
        Ok(path)
    }

    pub(super) fn read(root: &Path, relative: &str) -> Result<Vec<u8>, String> {
        std::fs::read(checked_path(root, relative, false)?).map_err(|error| error.to_string())
    }

    pub(super) fn write_atomic(root: &Path, relative: &str, bytes: &[u8]) -> Result<(), String> {
        futo_notes_core::files::write_atomic_bytes(&checked_path(root, relative, true)?, bytes)
    }

    pub(super) fn remove(root: &Path, relative: &str) -> Result<bool, String> {
        match std::fs::remove_file(checked_path(root, relative, false)?) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.to_string()),
        }
    }

    pub(super) fn rename(root: &Path, source: &str, destination: &str) -> Result<bool, String> {
        let source = checked_path(root, source, false)?;
        let destination = checked_path(root, destination, true)?;
        match std::fs::rename(source, destination) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.to_string()),
        }
    }

    pub(super) fn exists(root: &Path, relative: &str) -> Result<bool, String> {
        match std::fs::symlink_metadata(checked_path(root, relative, false)?) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.to_string()),
        }
    }

    pub(super) fn set_mtime_ms(
        root: &Path,
        relative: &str,
        modified_at_ms: i64,
    ) -> Result<(), String> {
        futo_notes_core::files::set_file_mtime_ms(
            &checked_path(root, relative, false)?,
            modified_at_ms,
        )
    }
}

pub(super) fn read(root: &Path, relative: &str) -> Result<Vec<u8>, String> {
    platform::read(root, relative)
}

pub(super) fn write_atomic(root: &Path, relative: &str, bytes: &[u8]) -> Result<(), String> {
    platform::write_atomic(root, relative, bytes)
}

pub(super) fn remove(root: &Path, relative: &str) -> Result<bool, String> {
    platform::remove(root, relative)
}

pub(super) fn rename(root: &Path, source: &str, destination: &str) -> Result<bool, String> {
    platform::rename(root, source, destination)
}

pub(super) fn exists(root: &Path, relative: &str) -> Result<bool, String> {
    platform::exists(root, relative)
}

pub(super) fn set_mtime_ms(root: &Path, relative: &str, modified_at_ms: i64) -> Result<(), String> {
    platform::set_mtime_ms(root, relative, modified_at_ms)
}
