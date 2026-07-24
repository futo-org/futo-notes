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
    #[cfg(test)]
    use std::cell::Cell;
    use std::ffi::{OsStr, OsString};
    use std::fs::File;
    use std::io::{Read, Write};
    use std::os::fd::OwnedFd;
    use std::path::Path;
    use std::sync::atomic::{AtomicU64, Ordering};

    use rustix::fs::{
        fsync, futimens, mkdirat, open, openat, renameat, statat, unlinkat, AtFlags, FileType,
        Mode, OFlags, Timespec, Timestamps, UTIME_OMIT,
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

    #[cfg(test)]
    thread_local! {
        static FAIL_DIRECTORY_SYNC_ON_CALL: Cell<Option<usize>> = const { Cell::new(None) };
    }

    fn context(operation: &str, relative: &str, error: impl std::fmt::Display) -> String {
        format!("{operation} vault path {relative}: {error}")
    }

    fn sync_directory(directory: &OwnedFd, operation: &str, relative: &str) -> Result<(), String> {
        #[cfg(test)]
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

    #[cfg(test)]
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
                sync_directory(
                    &directory,
                    "sync parent directory before mutation",
                    relative,
                )
                .map_err(OpenParentError::Other)?;
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
                unlinkat(&parent.directory, &backup, AtFlags::empty()).map_err(|error| {
                    context("remove parked backup after writing", relative, error)
                })?;
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

    pub(super) fn write_atomic(root: &Path, relative: &str, bytes: &[u8]) -> Result<(), String> {
        let parent = open_parent(root, relative, true).map_err(OpenParentError::message)?;
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
        result?;
        sync_directory(&parent.directory, "sync directory after write", relative)
    }

    pub(super) fn remove(root: &Path, relative: &str) -> Result<bool, String> {
        let parent = match open_parent(root, relative, false) {
            Ok(parent) => parent,
            Err(OpenParentError::NotFound(_)) => return Ok(false),
            Err(error) => return Err(error.message()),
        };
        reject_symlink(&parent, "remove", relative)?;
        match unlinkat(&parent.directory, &parent.leaf, AtFlags::empty()) {
            Ok(()) => {
                sync_directory(&parent.directory, "sync directory after remove", relative)?;
                Ok(true)
            }
            Err(rustix::io::Errno::NOENT) => {
                sync_directory(&parent.directory, "sync directory after remove", relative)?;
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
        let source_parent = match open_parent(root, source, false) {
            Ok(parent) => parent,
            Err(OpenParentError::NotFound(_)) => return Ok(false),
            Err(error) => return Err(error.message()),
        };
        reject_symlink(&source_parent, "rename source", source)?;
        let destination_parent =
            open_parent(root, destination, true).map_err(OpenParentError::message)?;
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
                sync_rename_directories(
                    source_parent.directory,
                    destination_parent.directory,
                    source,
                    destination,
                )?;
                return Ok(destination_exists);
            }
            Err(error) => {
                return Err(format!(
                    "rename vault path {source} to {destination}: {error}"
                ));
            }
        }
        sync_rename_directories(
            source_parent.directory,
            destination_parent.directory,
            source,
            destination,
        )?;
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

    pub(super) fn set_mtime_ms(
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

    pub(super) fn sync_parent(root: &Path, relative: &str) -> Result<(), String> {
        let parent = open_parent(root, relative, false).map_err(OpenParentError::message)?;
        sync_directory(
            &parent.directory,
            "sync directory before adopting existing content",
            relative,
        )
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

    pub(super) fn sync_parent(_root: &Path, _relative: &str) -> Result<(), String> {
        Ok(())
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

pub(super) fn sync_parent(root: &Path, relative: &str) -> Result<(), String> {
    platform::sync_parent(root, relative)
}

#[cfg(all(test, unix))]
pub(super) fn fail_directory_sync_on_call(call: usize) {
    platform::fail_directory_sync_on_call(call);
}

#[cfg(all(test, unix))]
mod tests {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::*;

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "futo-sync-vault-fs-test-{}-{}-{n}",
                std::process::id(),
                futo_notes_core::files::now_ms()
            ));
            std::fs::create_dir_all(&root).unwrap();
            Self(root)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn write_reports_directory_sync_failure() {
        let root = TempRoot::new();
        platform::fail_directory_sync_on_call(1);

        let error = write_atomic(root.path(), "note.md", b"body").unwrap_err();

        assert!(error.contains("sync directory after write"));
    }

    #[test]
    fn write_syncs_each_parent_entry_before_using_it() {
        let root = TempRoot::new();
        platform::fail_directory_sync_on_call(1);

        let first_error = write_atomic(root.path(), "folder/note.md", b"body").unwrap_err();

        assert!(first_error.contains("sync parent directory before mutation"));
        assert!(root.path().join("folder").is_dir());
        assert!(!root.path().join("folder/note.md").exists());

        platform::fail_directory_sync_on_call(1);
        let retry_error = write_atomic(root.path(), "folder/note.md", b"body").unwrap_err();

        assert!(retry_error.contains("sync parent directory before mutation"));
        assert!(!root.path().join("folder/note.md").exists());

        platform::fail_directory_sync_on_call(2);
        let nested_error = write_atomic(root.path(), "folder/nested/note.md", b"body").unwrap_err();

        assert!(nested_error.contains("sync parent directory before mutation"));
        assert!(root.path().join("folder/nested").is_dir());
        assert!(!root.path().join("folder/nested/note.md").exists());
    }

    #[test]
    fn remove_reports_directory_sync_failure() {
        let root = TempRoot::new();
        std::fs::write(root.path().join("note.md"), "body").unwrap();
        platform::fail_directory_sync_on_call(1);

        let error = remove(root.path(), "note.md").unwrap_err();

        assert!(error.contains("sync directory after remove"));
    }

    #[test]
    fn remove_retry_resyncs_when_the_leaf_is_already_absent() {
        let root = TempRoot::new();
        std::fs::write(root.path().join("note.md"), "body").unwrap();
        platform::fail_directory_sync_on_call(1);
        remove(root.path(), "note.md").unwrap_err();
        platform::fail_directory_sync_on_call(1);

        let error = remove(root.path(), "note.md").unwrap_err();

        assert!(error.contains("sync directory after remove"));
    }

    #[test]
    fn absent_inspection_resyncs_before_callers_trust_the_missing_leaf() {
        let root = TempRoot::new();
        std::fs::write(root.path().join("note.md"), "body").unwrap();
        platform::fail_directory_sync_on_call(1);
        remove(root.path(), "note.md").unwrap_err();
        platform::fail_directory_sync_on_call(1);

        let error = exists(root.path(), "note.md").unwrap_err();

        assert!(error.contains("sync directory before trusting absent path"));
    }

    #[test]
    fn path_text_cannot_turn_a_non_missing_parent_error_into_not_found() {
        let root = TempRoot::new();
        std::fs::write(
            root.path().join("No such file or directory"),
            "not a directory",
        )
        .unwrap();
        let relative = "No such file or directory/note.md";

        assert!(remove(root.path(), relative).is_err());
        assert!(exists(root.path(), relative).is_err());
        assert!(rename(root.path(), relative, "destination.md").is_err());
    }

    #[test]
    fn rename_reports_destination_directory_sync_failure() {
        let root = TempRoot::new();
        std::fs::create_dir(root.path().join("source")).unwrap();
        std::fs::create_dir(root.path().join("destination")).unwrap();
        std::fs::write(root.path().join("source/note.md"), "body").unwrap();
        platform::fail_directory_sync_on_call(3);

        let error = rename(root.path(), "source/note.md", "destination/note.md").unwrap_err();

        assert!(error.contains("sync destination directory after rename"));
    }

    #[test]
    fn rename_retry_resyncs_when_only_the_destination_remains() {
        let root = TempRoot::new();
        std::fs::write(root.path().join("source.md"), "body").unwrap();
        platform::fail_directory_sync_on_call(1);
        rename(root.path(), "source.md", "destination.md").unwrap_err();
        platform::fail_directory_sync_on_call(1);

        let error = rename(root.path(), "source.md", "destination.md").unwrap_err();

        assert!(error.contains("sync source directory after rename"));
    }
}
