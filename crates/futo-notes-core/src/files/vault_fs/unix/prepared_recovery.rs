use super::*;
use crate::files::vault_fs::{RecoveryActivation, RecoveryPreparationError};
use std::os::unix::fs::MetadataExt;

/// Pins the exact regular file and its parent. Only hard links are selected;
/// filesystems without them refuse preparation instead of copying the base.
pub struct PreparedRecoveryActivation {
    directory: OwnedFd,
    file: File,
    source: String,
    destination: String,
}

pub fn prepare_recovery_activation(
    root: &Path,
    source: &str,
    destination: &str,
) -> Result<PreparedRecoveryActivation, RecoveryPreparationError> {
    use RecoveryPreparationError::Failure;
    for relative in [source, destination] {
        let components = relative_components(relative).map_err(Failure)?;
        if components.len() != 2 || components[0] != ".futo-editor-recovery" {
            return Err(Failure(
                "prepared activation is restricted to editor recovery metadata".into(),
            ));
        }
    }
    if source == destination || Path::new(source).parent() != Path::new(destination).parent() {
        return Err(Failure(
            "prepared recovery requires distinct same-parent names".into(),
        ));
    }
    let parent = open_parent(root, source, false).map_err(|e| Failure(e.message()))?;
    let to = open_parent(root, destination, false).map_err(|e| Failure(e.message()))?;
    reject_symlink(&parent, "prepare recovery source", source).map_err(Failure)?;
    reject_symlink(&to, "prepare recovery destination", destination).map_err(Failure)?;
    match entry_type(&to.directory, &to.leaf) {
        Err(rustix::io::Errno::NOENT) => {}
        Ok(_) => return Err(Failure("editor recovery stream already exists".into())),
        Err(error) => return Err(Failure(error.to_string())),
    }
    let file = File::from(
        openat(
            &parent.directory,
            &parent.leaf,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
            Mode::empty(),
        )
        .map_err(|e| Failure(e.to_string()))?,
    );
    if !file
        .metadata()
        .map_err(|e| Failure(e.to_string()))?
        .is_file()
    {
        return Err(Failure(
            "prepared recovery source is not a regular file".into(),
        ));
    }
    let prepared = PreparedRecoveryActivation {
        directory: parent.directory,
        file,
        source: source.to_owned(),
        destination: destination.to_owned(),
    };
    // Probe only a fresh owned sibling. The canonical recovery name remains
    // absent until the caller has appended its first attempted edit.
    let probe = hidden_name("recovery-probe");
    let linked = rustix::fs::linkat(
        &prepared.directory,
        &parent.leaf,
        &prepared.directory,
        &probe,
        AtFlags::empty(),
    );
    match linked {
        Ok(()) => {}
        Err(error)
            if matches!(
                error,
                rustix::io::Errno::OPNOTSUPP | rustix::io::Errno::NOSYS | rustix::io::Errno::PERM
            ) =>
        {
            return Err(RecoveryPreparationError::Unsupported);
        }
        Err(error) => return Err(Failure(error.to_string())),
    }
    prepared.verify_leaf(&probe).map_err(Failure)?;
    unlinkat(&prepared.directory, &probe, AtFlags::empty()).map_err(|e| Failure(e.to_string()))?;
    sync_directory(
        &prepared.directory,
        "sync recovery activation probe",
        source,
    )
    .map_err(Failure)?;
    Ok(prepared)
}

impl PreparedRecoveryActivation {
    fn verify_leaf(&self, leaf: &OsStr) -> Result<(), String> {
        let found = File::from(
            openat(
                &self.directory,
                leaf,
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
                Mode::empty(),
            )
            .map_err(|e| e.to_string())?,
        );
        let expected = self.file.metadata().map_err(|e| e.to_string())?;
        let actual = found.metadata().map_err(|e| e.to_string())?;
        if !actual.is_file() || (actual.dev(), actual.ino()) != (expected.dev(), expected.ino()) {
            return Err("prepared recovery file identity changed".into());
        }
        Ok(())
    }

    pub fn verify(&self, root: &Path, relative: &str) -> Result<(), String> {
        if relative != self.source && relative != self.destination {
            return Err("path is not owned by prepared recovery".into());
        }
        let current = self.verify_parent(root, relative)?;
        self.verify_leaf(&current.leaf)
    }

    fn verify_parent(&self, root: &Path, relative: &str) -> Result<Parent, String> {
        let current = open_parent(root, relative, false).map_err(OpenParentError::message)?;
        let expected = File::from(self.directory.try_clone().map_err(|e| e.to_string())?)
            .metadata()
            .map_err(|e| e.to_string())?;
        let actual = File::from(current.directory.try_clone().map_err(|e| e.to_string())?)
            .metadata()
            .map_err(|e| e.to_string())?;
        if (expected.dev(), expected.ino()) != (actual.dev(), actual.ino()) {
            return Err("prepared recovery parent identity changed".into());
        }
        Ok(current)
    }

    pub fn activate(&mut self, root: &Path) -> Result<RecoveryActivation, String> {
        self.verify(root, &self.source)?;
        let source = Path::new(&self.source).file_name().unwrap();
        let destination = Path::new(&self.destination).file_name().unwrap();
        crate::files::vault_fs::before_install(&self.destination);
        match rustix::fs::linkat(
            &self.directory,
            source,
            &self.directory,
            destination,
            AtFlags::empty(),
        ) {
            Ok(()) => {}
            Err(rustix::io::Errno::EXIST) => return Ok(RecoveryActivation::Occupied),
            Err(error) => return Err(error.to_string()),
        }
        // Do not undo installation after a sync failure: the caller must know
        // that the canonical name now owns this exact inode.
        let durability = self.verify(root, &self.destination).and_then(|()| {
            sync_directory(
                &self.directory,
                "sync prepared recovery activation",
                &self.destination,
            )
        });
        Ok(RecoveryActivation::Installed { durability })
    }

    /// Remove only the verified canonical link of a rejected first append.
    pub fn deactivate(&mut self, root: &Path) -> Result<(), String> {
        self.remove_owned(root, &self.destination)
    }

    /// The inactive name is never recovery authority, even when both names link
    /// to a live stream. Retiring it must never remove the canonical name.
    pub fn discard(&mut self, root: &Path) -> Result<(), String> {
        self.remove_owned(root, &self.source)
    }

    fn remove_owned(&self, root: &Path, relative: &str) -> Result<(), String> {
        self.verify_parent(root, relative)?;
        let leaf = Path::new(relative).file_name().unwrap();
        match entry_type(&self.directory, leaf) {
            Err(rustix::io::Errno::NOENT) => {}
            _ => {
                self.verify(root, relative)?;
                unlinkat(&self.directory, leaf, AtFlags::empty()).map_err(|e| e.to_string())?;
            }
        }
        sync_directory(&self.directory, "sync owned recovery removal", relative)
    }
}
